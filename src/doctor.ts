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

  // Resolves true when the server granted the request. No answer in time counts as refused.
  const allowed = (ask: (answer: (granted: boolean) => void) => void) =>
    withTimeout(
      new Promise<boolean>((resolve) => {
        try {
          ask(resolve);
        } catch {
          resolve(false); // ssh2 throws when the connection is already gone
        }
      }),
      timeoutMs,
    ).catch(() => false);

  const steps: Step[] = [
    {
      hop: "config",
      run: () => {
        const loaded = loadConfig(configPath, deps.readFile, deps.homedir);
        if (!loaded.ok) {
          return fail(`${loaded.field}: ${loaded.message}`, `Fix ${loaded.field} in ${configPath}.`, EXIT.usage);
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
              ? `Run: chmod 600 ${config.keyPath}`
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
        try {
          (await withTimeout(deps.dial(host, port), timeoutMs, (late) => late.destroy())).destroy();
        } catch {
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
        const live = evaluateStatus(readState(statePath(configPath)), pidAlive, Date.now());
        if (live.exit === EXIT.ok) return pass(`held by the running tunnel (pid ${live.pid})`);
        const c = client!;
        if (!(await allowed((answer) => c.forwardIn("127.0.0.1", port, (err) => answer(!err))))) {
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
        const other = config.remotePort + 1;
        // Everything the tunnel user must not be able to do. Each probe is undone if it works.
        // A granted session proves nothing: with a forced command the server accepts the request and
        // runs its own command. The probe counts only when a shell evaluated it.
        const command = "echo social-tunnel-$((6*7))";
        const ran = (channel: ClientChannel | undefined, answer: (granted: boolean) => void) => {
          if (!channel) return answer(false);
          let output = "";
          channel.on("data", (chunk: Buffer) => {
            output += chunk.toString("latin1");
            if (output.includes("social-tunnel-42")) {
              channel.close();
              answer(true);
            }
          });
          channel.on("close", () => answer(false));
        };
        const probes: [string, (answer: (granted: boolean) => void) => void][] = [
          [
            "shell",
            // No PTY: a server that refuses terminals may still hand out a shell.
            (answer) =>
              c.shell(false, (err, channel) => {
                ran(channel, answer);
                if (!err) channel.write(`${command}\nexit\n`);
              }),
          ],
          ["exec", (answer) => c.exec(command, (_err, channel) => ran(channel, answer))],
          ["sftp", (answer) => c.sftp((err, sftp) => (sftp?.end(), answer(!err)))],
          [
            "local forward",
            (answer) => c.forwardOut("127.0.0.1", 0, "127.0.0.1", 22, (err, channel) => (channel?.close(), answer(!err))),
          ],
          [
            "remote forward on another port",
            (answer) =>
              c.forwardIn("127.0.0.1", other, (err) => {
                if (!err) c.unforwardIn("127.0.0.1", other, () => {});
                answer(!err);
              }),
          ],
        ];
        const granted: string[] = [];
        for (const [name, probe] of probes) if (await allowed(probe)) granted.push(name);
        if (granted.length > 0) {
          return fail(
            `the server allowed the tunnel user: ${granted.join(", ")}`,
            `Restrict the tunnel key in authorized_keys on the server: restrict,port-forwarding,permitlisten="127.0.0.1:${config.remotePort}",command="/bin/false".`,
            EXIT.lockdown,
          );
        }
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
        try {
          const addresses = await withTimeout(deps.resolve(host), timeoutMs);
          const address = addresses.find((a) => !isRefusedAddress(a));
          if (address === undefined) return failed;
          (await withTimeout(deps.dial(address, 443), timeoutMs, (late) => late.destroy())).destroy();
        } catch {
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
