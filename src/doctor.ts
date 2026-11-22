import path from "node:path";
import type { Client, ClientChannel } from "ssh2";
import { isRefusedAddress } from "./address-guard";
import { loadConfig, loadKey, type Config, type KeyFs } from "./config";
import { DEFAULTS, EXIT } from "./defaults";
import { isAllowed, normalizeHost } from "./host";
import { withTimeout, type Dialer, type Resolver } from "./proxy";
import { pidAlive, readState, statePath } from "./state";
import { evaluateStatus } from "./status";
import { ConnectError, connectSsh } from "./tunnel";

export interface Hop {
  hop: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
  fix: string;
}

export interface DoctorDeps extends KeyFs {
  platform: string;
  homedir: () => string;
  resolve: Resolver;
  dial: Dialer;
  connectTimeoutMs?: number;
}

// RFC 4254 channel open failure reason 2.
const CONNECT_FAILED = 2;
// SFTP packet types (draft-ietf-secsh-filexfer-02).
const SFTP_INIT = 1;
const SFTP_VERSION = 2;

// Quotes a path for a POSIX shell, so a suggested command works with spaces and runs nothing else.
function shellQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

type Outcome = { ok: true; detail: string } | { ok: false; detail: string; fix: string; exit: number };
type Step = { hop: string; run: () => Outcome | Promise<Outcome> };

const pass = (detail: string): Outcome => ({ ok: true, detail });
const fail = (detail: string, fix: string, exit: number): Outcome => ({ ok: false, detail, fix, exit });

// Runs the hops in order and stops at the first failure; the rest are reported as skipped.
export async function runDoctor(
  configPath: string,
  domain: string | undefined,
  deps: DoctorDeps,
): Promise<{ hops: Hop[]; exit: number }> {
  const timeoutMs = deps.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  let config!: Config;
  let key!: Buffer;
  let client: Client | undefined;
  // `lost` is set once the SSH connection is gone, `silent` once a request got no answer in time:
  // from then on a `false` from `allowed` is not a refusal.
  let lost = false;
  let silent = false;
  const unfinished = (what: string): Outcome =>
    fail(
      lost ? `the SSH connection closed during ${what}` : `the server did not answer ${what} in time`,
      "Run doctor again. If it happens every time, check the connection to the server and read its sshd log: it may be dropping the tunnel user on a refused request.",
      EXIT.down,
    );

  // Resolves true when the server granted the request. `ask` calls `heard` when the server has
  // answered the request itself and only the outcome is still awaited; `answer` implies it.
  const allowed = (ask: (answer: (granted: boolean) => void, heard: () => void) => void) => {
    let answered = false;
    return withTimeout(
      new Promise<boolean>((resolve) => {
        try {
          ask(
            (granted) => {
              answered = true;
              resolve(granted);
            },
            () => (answered = true),
          );
        } catch {
          lost = true; // ssh2 throws when the connection is already gone
          resolve(false);
        }
      }),
      timeoutMs,
    ).catch(() => {
      if (!answered) silent = true;
      return false;
    });
  };

  const steps: Step[] = [
    {
      hop: "config",
      run: () => {
        const loaded = loadConfig(configPath, deps.readFile, deps.homedir);
        if (!loaded.ok) {
          const fix =
            loaded.field === "$"
              ? `Create ${configPath} as a JSON object with version, server, remotePort, keyPath and domains.`
              : `Fix ${loaded.field} in ${configPath}.`;
          return fail(`${loaded.field}: ${loaded.message}`, fix, EXIT.usage);
        }
        config = loaded.config;
        return pass(`${configPath} is valid`);
      },
    },
    {
      hop: "key",
      run: () => {
        const loaded = loadKey(config.keyPath, deps, deps.platform);
        if (!loaded.ok) {
          const fix =
            loaded.code === "key_permissions"
              ? `Run: chmod 600 ${shellQuote(config.keyPath)}`
              : `Point keyPath at an unencrypted SSH private key that only you can read.`;
          return fail(loaded.message, fix, EXIT.usage);
        }
        key = loaded.key;
        const personal =
          path.dirname(config.keyPath) === path.join(deps.homedir(), ".ssh") &&
          path.basename(config.keyPath).startsWith("id_");
        return pass(
          `${config.keyPath} is private to you` +
            (personal ? "; it looks like your personal key - create a dedicated key for the tunnel" : ""),
        );
      },
    },
    {
      hop: "server_reachable",
      run: async () => {
        const { host, port } = config.server;
        const giveUp = new AbortController();
        try {
          (await withTimeout(deps.dial(host, port, giveUp.signal), timeoutMs, (late) => late.destroy())).destroy();
        } catch {
          giveUp.abort(); // a dial that timed out is still connecting: stop it
          return fail(
            `no TCP connection to ${host}:${port}`,
            "Check server.host and server.port, that the server is up, and that its firewall allows SSH.",
            EXIT.down,
          );
        }
        return pass(`${host}:${port} accepts TCP connections`);
      },
    },
    {
      hop: "ssh_auth",
      run: async () => {
        try {
          client = await connectSsh({ ...config.server, key }, { readyTimeoutMs: timeoutMs });
          client.once("close", () => (lost = true));
        } catch (err) {
          const kind = err instanceof ConnectError ? err.kind : "unreachable";
          if (kind === "host_key_mismatch") {
            return fail(
              "the server's host key does not match server.hostKey",
              "Do not connect until you know why. Compare the server's fingerprint over a channel you trust, then update server.hostKey only if the server was really re-keyed.",
              EXIT.hostKeyMismatch,
            );
          }
          if (kind === "auth_failed") {
            return fail(
              `the server refused the key for user ${config.server.user}`,
              "Add the tunnel public key to that user's authorized_keys on the server.",
              EXIT.down,
            );
          }
          return fail("the SSH handshake did not complete", "Check that server.port is the SSH port.", EXIT.down);
        }
        return pass(`host key matches the pin and ${config.server.user} authenticated`);
      },
    },
    {
      hop: "forward",
      run: async () => {
        const port = config.remotePort;
        const live = evaluateStatus(readState(statePath(configPath)), pidAlive, Date.now(), DEFAULTS.staleMs, config);
        if (live.exit === EXIT.ok) return pass(`held by the running tunnel (pid ${live.pid})`);
        const c = client!;
        if (!(await allowed((answer) => c.forwardIn("127.0.0.1", port, (err) => answer(!err))))) {
          // A request the connection never answered was not refused: the broken hop is the connection.
          if (lost || silent) return unfinished("the forward request");
          return fail(
            `the server refused a remote forward on 127.0.0.1:${port}`,
            `Free port ${port} on the server and allow it for the tunnel key: permitlisten="127.0.0.1:${port}".`,
            EXIT.portBlocked,
          );
        }
        await allowed((answer) => c.unforwardIn("127.0.0.1", port, () => answer(true)));
        return pass(`the server grants a remote forward on 127.0.0.1:${port}`);
      },
    },
    {
      hop: "lockdown",
      run: async () => {
        const c = client!;
        // Everything the tunnel user must not be able to do. Each probe is undone if it works.
        // A granted session proves nothing: with a forced command the server accepts the request and
        // runs its own command. The probe counts only when a shell evaluated it: joining the quoted
        // pieces works in sh, bash, zsh, fish and tcsh, and the joined text is not in the command.
        const command = "echo social-tunnel'-'ok";
        // The server has answered by the time ssh2 calls back, so a command that then prints nothing
        // in time (a forced command that keeps running) is a refusal, not silence.
        const ran = (channel: ClientChannel | undefined, answer: (granted: boolean) => void, heard: () => void) => {
          heard();
          if (!channel) return answer(false);
          let output = "";
          channel.on("data", (chunk: Buffer) => {
            output += chunk.toString("latin1");
            if (output.includes("social-tunnel-ok")) {
              channel.close();
              answer(true);
            }
          });
          channel.on("close", () => answer(false));
        };
        const probes: [string, (answer: (granted: boolean) => void, heard: () => void) => void][] = [
          [
            "shell",
            // No PTY: a server that refuses terminals may still hand out a shell.
            (answer, heard) =>
              c.shell(false, (err, channel) => {
                ran(channel, answer, heard);
                if (!err) channel.write(`${command}\nexit\n`);
              }),
          ],
          ["exec", (answer, heard) => c.exec(command, (_err, channel) => ran(channel, answer, heard))],
          [
            "sftp",
            // A granted subsystem may run a forced command instead of sftp-server, so it counts only
            // when the channel answers SSH_FXP_INIT (version 3) with SSH_FXP_VERSION. Silence after
            // the grant is a refusal, like a forced command on the shell and exec probes.
            (answer, heard) =>
              c.subsys("sftp", (err, channel) => {
                heard();
                if (err) return answer(false);
                let reply = Buffer.alloc(0);
                channel.on("data", (chunk: Buffer) => {
                  reply = Buffer.concat([reply, chunk]);
                  if (reply.length < 5) return;
                  channel.close();
                  answer(reply[4] === SFTP_VERSION);
                });
                channel.on("close", () => answer(false));
                channel.write(Buffer.from([0, 0, 0, 5, SFTP_INIT, 0, 0, 0, 3]));
              }),
          ],
          [
            "local forward",
            // Aimed at the server's own SSH port, which is known to accept connections. A server
            // that permits the forward but cannot connect answers "connect failed": still allowed.
            (answer) =>
              c.forwardOut("127.0.0.1", 0, "127.0.0.1", config.server.port, (err, channel) => {
                channel?.close();
                answer(!err || (err as { reason?: unknown }).reason === CONNECT_FAILED);
              }),
          ],
          [
            "remote forward on another port",
            // Two ports: a refusal on one may only mean that port is taken on the server. They are
            // the two above the tunnel port, or the two below it where those above do not exist.
            (answer) => {
              const step = config.remotePort + 2 > 65535 ? -1 : 1;
              const tryPort = (other: number, last: boolean) =>
                c.forwardIn("127.0.0.1", other, (err) => {
                  // This runs inside ssh2, outside the try in `allowed`: a throw here means the
                  // connection is gone.
                  try {
                    if (!err) c.unforwardIn("127.0.0.1", other, () => {});
                    if (!err || last) return answer(!err);
                    tryPort(other + step, true);
                  } catch {
                    lost = true;
                    answer(false);
                  }
                });
              tryPort(config.remotePort + step, false);
            },
          ],
        ];
        const granted: string[] = [];
        for (const [name, probe] of probes) {
          if (await allowed(probe)) granted.push(name);
          if (lost || silent) break; // this connection answers nothing more
        }
        if (granted.length > 0) {
          return fail(
            `the server allowed the tunnel user: ${granted.join(", ")}`,
            `On the server, start the tunnel key's authorized_keys line with restrict,port-forwarding,permitlisten="127.0.0.1:${config.remotePort}",command="/usr/sbin/nologin" and add to sshd_config: Match User ${config.server.user} / AllowTcpForwarding remote / PermitListen 127.0.0.1:${config.remotePort} / PermitOpen none / AllowStreamLocalForwarding no / GatewayPorts no / PermitTTY no / ForceCommand /usr/sbin/nologin. permitlisten limits only remote forwards; PermitOpen none is what closes local ones.`,
            EXIT.lockdown,
          );
        }
        // Probes that were never answered prove nothing, so a lost or silent connection is never a pass.
        if (lost || silent) return unfinished("the lockdown checks, so they did not finish");
        return pass("the server ran no shell or exec command and refused sftp, a local forward and a forward on another port");
      },
    },
    {
      hop: "egress",
      run: async () => {
        const host = config.domains[0]!;
        const failed = fail(
          `no connection from this computer to ${host}:443`,
          "Check this computer's internet connection and DNS.",
          EXIT.down,
        );
        const giveUp = new AbortController();
        try {
          const addresses = await withTimeout(deps.resolve(host), timeoutMs);
          const address = addresses.find((a) => !isRefusedAddress(a));
          if (address === undefined) return failed;
          (await withTimeout(deps.dial(address, 443, giveUp.signal), timeoutMs, (late) => late.destroy())).destroy();
        } catch {
          giveUp.abort();
          return failed;
        }
        return pass(`${host}:443 is reachable from this computer`);
      },
    },
  ];
  if (domain !== undefined) {
    steps.splice(1, 0, {
      hop: "domain",
      run: () => {
        const host = normalizeHost(domain);
        if (host && isAllowed(host, config.domains)) return pass(`${host} is on the allowlist`);
        return fail(
          "the host given to --domain is not on the allowlist",
          `Add its domain to "domains" in ${configPath}.`,
          EXIT.domainRefused,
        );
      },
    });
  }

  const hops: Hop[] = [];
  let exit: number = EXIT.ok;
  try {
    for (const step of steps) {
      if (exit !== EXIT.ok) {
        hops.push({ hop: step.hop, ok: false, skipped: true, detail: "skipped", fix: "" });
        continue;
      }
      const outcome = await step.run();
      if (outcome.ok) {
        hops.push({ hop: step.hop, ok: true, skipped: false, detail: outcome.detail, fix: "" });
      } else {
        hops.push({ hop: step.hop, ok: false, skipped: false, detail: outcome.detail, fix: outcome.fix });
        exit = outcome.exit;
      }
    }
  } finally {
    client?.end();
  }
  return { hops, exit };
}
