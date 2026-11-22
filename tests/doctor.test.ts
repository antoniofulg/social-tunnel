import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Io } from "../src/cli";
import { cli, localDial, tmp, writeConfig } from "./helpers";
import { pair, PUBLIC } from "./proxy-harness";
import { freePort, setup, type ServerOptions, type TestServer } from "./ssh-server";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const ssh of servers.splice(0)) await ssh.close();
});

const ORDER = ["config", "key", "server_reachable", "ssh_auth", "forward", "lockdown", "egress"];

type Server = Omit<ServerOptions, "publicKey">;

// A server that grants only the tunnel's own forward: what a locked-down tunnel user looks like.
async function locked(server: Server = {}, edit?: (config: Record<string, any>) => void) {
  let remotePort = 0;
  const env = await setup({ forward: (port) => port === remotePort, ...server }, edit);
  remotePort = env.remotePort;
  servers.push(env.ssh);
  return env;
}

// Network seams for doctor: SSH goes to the in-process server, egress to counting fakes.
function seams(egress: "ok" | "refused" | "hangs" = "ok") {
  const lookups: string[] = [];
  const dials: [string, number][] = [];
  const io: Partial<Io> = {
    resolve: async (host) => {
      lookups.push(host);
      return [PUBLIC];
    },
    dial: (address, port) => {
      if (port !== 443) return localDial(address, port);
      dials.push([address, port]);
      if (egress === "hangs") return new Promise(() => {});
      if (egress === "refused") return Promise.reject(new Error("ECONNREFUSED"));
      return Promise.resolve(pair()[0]);
    },
  };
  return { io, lookups, dials };
}

async function doctor(configPath: string, io: Partial<Io>, argv: string[] = []) {
  const result = await cli(["doctor", "--json", "--config", configPath, ...argv], io);
  const body = result.json();
  const hop = (name: string) => body.hops.find((h: any) => h.hop === name);
  return { code: result.code, body, hops: body.hops as any[], hop, stdout: result.stdout, stderr: result.stderr };
}

// One scenario per hop that can fail, plus the all-pass case, with the exit code the plan assigns.
const scenarios: { failing: string | null; exit: number; run: () => ReturnType<typeof doctor> }[] = [
  { failing: "config", exit: 2, run: async () => doctor(writeConfig((c) => (c.version = 2)).path, seams().io) },
  { failing: "key", exit: 2, run: async () => doctor(writeConfig(() => {}, 0o644).path, seams().io) },
  {
    failing: "server_reachable",
    exit: 10,
    run: async () => {
      const port = await freePort();
      return doctor(writeConfig((c) => (c.server.port = port)).path, seams().io);
    },
  },
  { failing: "ssh_auth", exit: 10, run: async () => doctor((await locked({ authorize: false })).path, seams().io) },
  { failing: "forward", exit: 11, run: async () => doctor((await locked({ forward: () => false })).path, seams().io) },
  { failing: "lockdown", exit: 14, run: async () => doctor((await locked({ shell: true })).path, seams().io) },
  { failing: "egress", exit: 10, run: async () => doctor((await locked()).path, seams("refused").io) },
  { failing: "domain", exit: 12, run: async () => doctor((await locked()).path, seams().io, ["--domain", "example.org"]) },
  { failing: null, exit: 0, run: async () => doctor((await locked()).path, seams().io) },
];

test("[C45] hops run in order and everything after a server_reachable failure is skipped", async () => {
  const passing = await doctor((await locked()).path, seams().io);
  expect(passing.hops.map((h) => h.hop)).toEqual(ORDER);

  const port = await freePort();
  const { code, hops } = await doctor(writeConfig((c) => (c.server.port = port)).path, seams().io);
  expect(code).toBe(10);
  expect(hops.map((h) => h.hop)).toEqual(ORDER);
  expect(hops.slice(0, 2).map((h) => [h.ok, h.skipped])).toEqual([[true, false], [true, false]]);
  expect(hops[2]).toMatchObject({ hop: "server_reachable", ok: false, skipped: false });
  for (const later of hops.slice(3)) {
    expect(later).toMatchObject({ ok: false, skipped: true, fix: "" });
  }
});

test("[C46] every failed hop has skipped false and a non-empty fix", async () => {
  for (const scenario of scenarios.filter((s) => s.failing)) {
    const { hops } = await scenario.run();
    const failed = hops.filter((h) => !h.ok && !h.skipped);
    expect(failed.map((h) => h.hop)).toEqual([scenario.failing]);
    expect(failed[0].skipped).toBe(false);
    expect(typeof failed[0].fix).toBe("string");
    expect(failed[0].fix.trim().length).toBeGreaterThan(0);
    for (const h of hops) expect(Object.keys(h)).toEqual(["hop", "ok", "skipped", "detail", "fix"]);
  }
});

test("[C62] doctor reports a bad config or key as a failed hop, never an error envelope, and exits 2", async () => {
  const badConfig = await doctor(writeConfig((c) => (c.domains = [])).path, seams().io);
  expect(badConfig.code).toBe(2);
  expect(badConfig.body.error).toBeUndefined();
  expect(badConfig.body).toMatchObject({ ok: false, command: "doctor" });
  expect(badConfig.hop("config")).toMatchObject({ ok: false, skipped: false });
  expect(badConfig.hop("key")).toMatchObject({ ok: false, skipped: true });

  const looseKey = await doctor(writeConfig(() => {}, 0o644).path, seams().io);
  expect(looseKey.code).toBe(2);
  expect(looseKey.body.error).toBeUndefined();
  expect(looseKey.hop("config")).toMatchObject({ ok: true });
  expect(looseKey.hop("key")).toMatchObject({ ok: false, skipped: false });
  expect(looseKey.hop("key").fix).toContain("chmod 600");
});

function liveState(env: Awaited<ReturnType<typeof locked>>) {
  const now = new Date().toISOString();
  return {
    version: 1,
    pid: process.pid,
    state: "connected",
    reason: null,
    since: now,
    retryAt: null,
    server: { host: "127.0.0.1", port: env.ssh.port },
    remotePort: env.remotePort,
    updatedAt: now,
  };
}

test("[C47] with a live connected run the forward hop passes without requesting the forward", async () => {
  const env = await locked();
  writeFileSync(env.statePath, JSON.stringify(liveState(env)));
  const { code, hop } = await doctor(env.path, seams().io);
  expect(code).toBe(0);
  expect(hop("forward")).toMatchObject({ ok: true, skipped: false });
  expect(env.ssh.requests.filter((r) => r.bindPort === env.remotePort)).toEqual([]);
});

test("[C48] with no live run the forward hop requests the forward and then cancels it", async () => {
  const env = await locked();
  const { code, hop } = await doctor(env.path, seams().io);
  expect(code).toBe(0);
  expect(hop("forward")).toMatchObject({ ok: true, skipped: false });
  expect(env.ssh.requests.slice(0, 2)).toEqual([
    { name: "tcpip-forward", bindAddr: "127.0.0.1", bindPort: env.remotePort },
    { name: "cancel-tcpip-forward", bindAddr: "127.0.0.1", bindPort: env.remotePort },
  ]);
});

test("[C49] the egress hop resolves the first domain and connects on 443, and an unreachable host fails within the timeout", async () => {
  const domains = (c: Record<string, any>) => (c.domains = ["linkedin.com", "instagram.com"]);
  const reachable = seams();
  const ok = await doctor((await locked({}, domains)).path, reachable.io);
  expect(ok.code).toBe(0);
  expect(ok.hop("egress")).toMatchObject({ ok: true });
  expect(reachable.lookups).toEqual(["linkedin.com"]);
  expect(reachable.dials).toEqual([[PUBLIC, 443]]);

  const unreachable = seams("hangs");
  const started = Date.now();
  const failed = await doctor((await locked({}, domains)).path, { ...unreachable.io, connectTimeoutMs: 300 });
  expect(failed.code).toBe(10);
  expect(failed.hop("egress")).toMatchObject({ ok: false, skipped: false });
  expect(unreachable.dials).toEqual([[PUBLIC, 443]]);
  expect(Date.now() - started).toBeGreaterThanOrEqual(300);
  expect(Date.now() - started).toBeLessThan(4000);
});

test("[C50] --domain adds a domain hop after config; an unlisted host fails it, skips the rest and exits 12", async () => {
  for (const host of ["www.instagram.com", "WWW.Instagram.COM."]) {
    const listed = await doctor((await locked()).path, seams().io, ["--domain", host]);
    expect(listed.code).toBe(0);
    expect(listed.hops.map((h) => h.hop)).toEqual(["config", "domain", ...ORDER.slice(1)]);
    expect(listed.hop("domain")).toMatchObject({ ok: true, skipped: false });
  }

  const env = await locked();
  const unlisted = await doctor(env.path, seams().io, ["--domain", "example.org"]);
  expect(unlisted.code).toBe(12);
  expect(unlisted.hops.map((h) => h.hop)).toEqual(["config", "domain", ...ORDER.slice(1)]);
  expect(unlisted.hop("domain")).toMatchObject({ ok: false, skipped: false });
  for (const later of unlisted.hops.slice(2)) expect(later).toMatchObject({ ok: false, skipped: true, fix: "" });
  expect(env.ssh.clients.length).toBe(0);
});

test("[C51] a wrong host key fails ssh_auth with exit 13 through the connect function run uses", async () => {
  const env = await locked({}, (c) => (c.server.hostKey = "SHA256:" + "B".repeat(43)));
  const { code, hop, hops } = await doctor(env.path, seams().io);
  expect(code).toBe(13);
  expect(hop("server_reachable")).toMatchObject({ ok: true });
  expect(hop("ssh_auth")).toMatchObject({ ok: false, skipped: false });
  expect(hops.slice(4).every((h) => h.skipped)).toBe(true);
  // The pin held before authentication, exactly as for `run` (C26).
  expect(env.ssh.clients.length).toBe(1);
  expect(env.ssh.auth).toEqual([]);

  // One connect path: the only SSH client in src/ is built in tunnel.ts, and doctor calls it.
  const src = join(import.meta.dir, "..", "src");
  const builders = (readdirSync(src) as string[]).filter((f) => /new\s+Client\b/.test(readFileSync(join(src, f), "utf8")));
  expect(builders).toEqual(["tunnel.ts"]);
  expect(readFileSync(join(src, "tunnel.ts"), "utf8").match(/new\s+Client\b/g)!.length).toBe(1);
  expect(readFileSync(join(src, "doctor.ts"), "utf8")).toContain("connectSsh(");
});

test("[C52] doctor exits with the failing hop's code, and 0 when every hop passes", async () => {
  const seen: [string | null, number][] = [];
  for (const scenario of scenarios) {
    const { code, hops, body } = await scenario.run();
    const failed = hops.filter((h) => !h.ok && !h.skipped).map((h) => h.hop);
    expect(failed).toEqual(scenario.failing ? [scenario.failing] : []);
    expect(body.ok).toBe(scenario.failing === null);
    seen.push([scenario.failing, code]);
  }
  expect(seen).toEqual([
    ["config", 2],
    ["key", 2],
    ["server_reachable", 10],
    ["ssh_auth", 10],
    ["forward", 11],
    ["lockdown", 14],
    ["egress", 10],
    ["domain", 12],
    [null, 0],
  ]);
});

test("[C53] the lockdown hop fails naming exactly what the server allowed, and passes when it allows nothing", async () => {
  const names = ["shell", "exec", "sftp", "local forward", "remote forward"];
  const table: [Server | "other-port", string | null][] = [
    [{ shell: true }, "shell"],
    [{ sftp: true }, "sftp"],
    [{ localForward: true }, "local forward"],
    ["other-port", "remote forward"],
    [{}, null],
  ];
  for (const [server, allowed] of table) {
    let env: Awaited<ReturnType<typeof locked>>;
    if (server === "other-port") {
      let remotePort = 0;
      env = await setup({ forward: (port) => port === remotePort || port === remotePort + 1 });
      remotePort = env.remotePort;
      servers.push(env.ssh);
    } else env = await locked(server);

    const { code, hop } = await doctor(env.path, seams().io);
    const lockdown = hop("lockdown");
    if (allowed === null) {
      expect(code).toBe(0);
      expect(lockdown).toMatchObject({ ok: true, skipped: false });
    } else {
      expect([allowed, code]).toEqual([allowed, 14]);
      expect(lockdown).toMatchObject({ ok: false, skipped: false });
      const named = lockdown.detail.slice(lockdown.detail.indexOf(":") + 1);
      expect(names.filter((n) => named.includes(n))).toEqual([allowed]);
    }
    // The forward on another port was really requested from the server.
    expect(env.ssh.requests.some((r) => r.name === "tcpip-forward" && r.bindPort === env.remotePort + 1)).toBe(true);
  }
});

test("[C54] keyPath ~/.ssh/id_ed25519 passes the key hop with advice to use a dedicated key", async () => {
  const home = tmp();
  mkdirSync(join(home, ".ssh"), { mode: 0o700 });
  const env = await locked({}, (c) => (c.keyPath = "~/.ssh/id_ed25519"));
  copyFileSync(env.keyPath, join(home, ".ssh", "id_ed25519"));
  chmodSync(join(home, ".ssh", "id_ed25519"), 0o600);

  const personal = await doctor(env.path, { ...seams().io, homedir: () => home });
  expect(personal.code).toBe(0);
  expect(personal.hop("key")).toMatchObject({ ok: true, skipped: false });
  expect(personal.hop("key").detail).toContain(join(home, ".ssh", "id_ed25519"));
  expect(personal.hop("key").detail).toMatch(/dedicated key/);

  const dedicated = await doctor((await locked()).path, { ...seams().io, homedir: () => home });
  expect(dedicated.hop("key")).toMatchObject({ ok: true });
  expect(dedicated.hop("key").detail).not.toMatch(/dedicated key/);
});

test("[C123] a personal ~/.ssh/id_* key that is group-readable or not a key fails the key hop with exit 2, no advice", async () => {
  for (const [mode, content] of [[0o644, null], [0o600, "not a key\n"]] as const) {
    const home = tmp();
    mkdirSync(join(home, ".ssh"), { mode: 0o700 });
    const env = await locked({}, (c) => (c.keyPath = "~/.ssh/id_ed25519"));
    const key = join(home, ".ssh", "id_ed25519");
    if (content === null) copyFileSync(env.keyPath, key);
    else writeFileSync(key, content);
    chmodSync(key, mode);

    const result = await doctor(env.path, { ...seams().io, homedir: () => home });
    expect([mode, result.code]).toEqual([mode, 2]);
    expect(result.hop("key")).toMatchObject({ ok: false, skipped: false });
    expect(result.hop("key").detail).not.toMatch(/dedicated key/);
    expect(result.hop("server_reachable")).toMatchObject({ skipped: true });
  }
});

test("[C64] the lockdown hop fails for a shell without a PTY and for exec, and passes a forced command", async () => {
  const names = ["shell", "exec", "sftp", "local forward", "remote forward"];
  const table: [Server, string | null][] = [
    // Terminals refused, yet a shell runs commands: what `restrict` without `command=` gives.
    [{ shell: true, pty: false }, "shell"],
    [{ exec: true }, "exec"],
    // The requests are granted but only the server's own command runs: nothing was allowed.
    [{ forced: true }, null],
  ];
  for (const [server, allowed] of table) {
    const env = await locked(server);
    const { code, hop } = await doctor(env.path, seams().io);
    const lockdown = hop("lockdown");
    if (allowed === null) {
      expect(code).toBe(0);
      expect(lockdown).toMatchObject({ ok: true, skipped: false });
    } else {
      expect([allowed, code]).toEqual([allowed, 14]);
      expect(lockdown).toMatchObject({ ok: false, skipped: false });
      expect(lockdown.fix.length).toBeGreaterThan(0);
      const named = lockdown.detail.slice(lockdown.detail.indexOf(":") + 1);
      expect(names.filter((n) => named.includes(n))).toEqual([allowed]);
    }
  }
});

test("[C73] status and doctor do not credit a live run that serves another server or port", async () => {
  const env = await locked();
  const mine = liveState(env);

  writeFileSync(env.statePath, JSON.stringify(mine));
  const matching = await cli(["status", "--json", "--config", env.path]);
  expect(matching.code).toBe(0);

  // The config now names another port, or another server, than the run that wrote state.json.
  for (const other of [{ ...mine, remotePort: env.remotePort + 7 }, { ...mine, server: { host: "10.9.8.7", port: env.ssh.port } }, { ...mine, server: { host: "127.0.0.1", port: env.ssh.port + 1 } }]) {
    writeFileSync(env.statePath, JSON.stringify(other));
    const status = await cli(["status", "--json", "--config", env.path]);
    expect(status.code).toBe(10);
    expect(status.json()).toMatchObject({ ok: false, state: "stopped", reason: "config_changed", pid: process.pid, remotePort: env.remotePort });
  }

  // doctor does not take that run's word for this config's forward: it asks the server itself.
  const { code, hop } = await doctor(env.path, seams().io);
  expect(code).toBe(0);
  expect(hop("forward").detail).not.toContain("running tunnel");
  expect(env.ssh.requests.slice(0, 2).map((r) => [r.name, r.bindPort])).toEqual([
    ["tcpip-forward", env.remotePort],
    ["cancel-tcpip-forward", env.remotePort],
  ]);
});

test("[C74] doctor's fixes are safe to run: the chmod path is quoted and each fix says what to do", async () => {
  // A key path with a space, a quote and a command separator, as a default macOS config dir or a hostile config could give.
  const files = writeConfig(() => {}, 0o644);
  const awkward = join(files.dir, "Application Support");
  mkdirSync(awkward);
  const keyPath = join(awkward, "k'; touch pwned #");
  renameSync(files.keyPath, keyPath);
  const config = JSON.parse(readFileSync(files.path, "utf8"));
  config.keyPath = keyPath;
  writeFileSync(files.path, JSON.stringify(config));

  const loose = await doctor(files.path, seams().io);
  expect(loose.code).toBe(2);
  const fix: string = loose.hop("key").fix;
  expect(fix.startsWith("Run: chmod 600 '")).toBe(true);

  // Run it exactly as printed, in an empty directory: the key becomes private and nothing else happens.
  const cwd = tmp();
  const ran = Bun.spawnSync(["sh", "-c", fix.slice("Run: ".length)], { cwd });
  expect(ran.exitCode).toBe(0);
  expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  expect(readdirSync(cwd)).toEqual([]);
  expect(existsSync(join(files.dir, "pwned"))).toBe(false);

  const missing = join(tmp(), "config.json");
  const absent = await doctor(missing, seams().io);
  expect(absent.hop("config").fix).toBe(`Create ${missing} as a JSON object with version, server, remotePort, keyPath and domains.`);

  // The lockdown fix names a restriction for every kind of access the hop probes.
  const env = await locked({ localForward: true });
  const open = await doctor(env.path, seams().io);
  expect(open.code).toBe(14);
  const lockdownFix: string = open.hop("lockdown").fix;
  for (const part of ["restrict", `permitlisten="127.0.0.1:${env.remotePort}"`, 'command="/usr/sbin/nologin"', "PermitOpen none", "PermitTTY no", "ForceCommand", "Match User tunnel"]) {
    expect(lockdownFix).toContain(part);
  }
});

test("[C75] a fish or tcsh login shell that runs commands fails the lockdown hop", async () => {
  const names = ["shell", "exec", "sftp", "local forward", "remote forward"];
  const table: [Server, string][] = [
    [{ shell: true, shellFlavor: "fish" }, "shell"],
    [{ exec: true, shellFlavor: "fish" }, "exec"],
    [{ shell: true, shellFlavor: "tcsh" }, "shell"],
    [{ exec: true, shellFlavor: "tcsh" }, "exec"],
  ];
  for (const [server, allowed] of table) {
    const { code, hop } = await doctor((await locked(server)).path, seams().io);
    expect([server.shellFlavor, allowed, code]).toEqual([server.shellFlavor, allowed, 14]);
    const detail: string = hop("lockdown").detail;
    expect(names.filter((n) => detail.slice(detail.indexOf(":") + 1).includes(n))).toEqual([allowed]);
  }
});

test("[C76] a permitted local forward that cannot connect, and a forward two ports up, both fail the lockdown hop", async () => {
  // The server permits local forwards; the probe's target simply does not answer.
  const permitted = await locked({ localForward: "connect-failed" });
  const first = await doctor(permitted.path, seams().io);
  expect(first.code).toBe(14);
  expect(first.hop("lockdown").detail).toContain("local forward");
  // The probe aims at the server's own SSH port, not a fixed 22.
  expect(permitted.ssh.localForwards).toEqual([{ destIP: "127.0.0.1", destPort: permitted.ssh.port }]);

  // A forbidden local forward still passes.
  const forbidden = await locked();
  expect((await doctor(forbidden.path, seams().io)).code).toBe(0);
  expect(forbidden.ssh.localForwards.length).toBe(1);

  // remotePort + 1 is refused (say, taken) but remotePort + 2 is granted: other ports are open.
  let remotePort = 0;
  const env = await setup({ forward: (port) => port === remotePort || port === remotePort + 2 });
  remotePort = env.remotePort;
  servers.push(env.ssh);
  const second = await doctor(env.path, seams().io);
  expect(second.code).toBe(14);
  expect(second.hop("lockdown").detail).toContain("remote forward");
  expect(second.hop("lockdown").detail).not.toContain("local forward");
});

test("[C84] the lockdown fix also closes Unix-socket forwarding", async () => {
  const { code, hop } = await doctor((await locked({ shell: true })).path, seams().io);
  expect(code).toBe(14);
  expect(hop("lockdown").fix).toContain("AllowStreamLocalForwarding no");
});

test("[C87] an SSH connection that closes during the lockdown hop fails the hop with exit 10, never a pass", async () => {
  const drop = (ssh: TestServer) => ssh.clients.forEach((c) => (c as unknown as { _sock: { destroy(): void } })._sock.destroy());
  // Both servers grant a forward on any port, so an undisturbed doctor run fails lockdown with exit 14.
  const table: [string, (env: () => Awaited<ReturnType<typeof setup>>) => Server][] = [
    ["at the first session request", (env) => ({ onSession: () => drop(env().ssh) })],
    ["while the forward on another port waits", (env) => ({ forward: (port) => port === env().remotePort || (drop(env().ssh), false) })],
  ];
  for (const [when, server] of table) {
    let env!: Awaited<ReturnType<typeof setup>>;
    env = await setup(server(() => env));
    servers.push(env.ssh);
    const { code, hop } = await doctor(env.path, seams().io);
    expect([when, code]).toEqual([when, 10]);
    expect(hop("forward")).toMatchObject({ ok: true });
    expect(hop("lockdown")).toMatchObject({ ok: false, skipped: false });
    expect(hop("lockdown").detail).toMatch(/connection closed/);
    expect(hop("lockdown").detail).not.toMatch(/refused/);
    expect(hop("lockdown").fix).toMatch(/doctor again/);
    expect(hop("egress")).toMatchObject({ ok: false, skipped: true });
  }
});

test("[C88] at the top of the port range the lockdown hop asks for real other ports below the tunnel port", async () => {
  for (const remotePort of [65535, 65534]) {
    // The server grants a remote forward on every port that exists.
    const env = await setup({ forward: (port) => port >= 1 && port <= 65535 }, (c) => (c.remotePort = remotePort));
    servers.push(env.ssh);
    const { code, hop } = await doctor(env.path, seams().io);
    expect([remotePort, code]).toEqual([remotePort, 14]);
    expect(hop("lockdown").detail).toContain("remote forward");
    const asked = env.ssh.requests.filter((r) => r.name === "tcpip-forward").map((r) => r.bindPort!);
    expect(asked.filter((port) => port !== remotePort)).toEqual([remotePort - 1]);
  }

  // Refused on the first neighbour, granted on the second: still reported.
  const env = await setup({ forward: (port) => port === 65535 || port === 65533 }, (c) => (c.remotePort = 65535));
  servers.push(env.ssh);
  expect((await doctor(env.path, seams().io)).code).toBe(14);
  expect(env.ssh.requests.filter((r) => r.name === "tcpip-forward").map((r) => r.bindPort)).toEqual([65535, 65534, 65533]);
});

test("[C96] a server that stops answering during the lockdown hop fails the hop with exit 10, and a forced command that hangs still passes", async () => {
  // The server would run a shell and grant any forward: answered, these probes give exit 14.
  let env!: Awaited<ReturnType<typeof setup>>;
  env = await setup({ shell: true, exec: true, sftp: true, localForward: true, onSession: () => env.ssh.stopReading() });
  servers.push(env.ssh);
  const { code, hop } = await doctor(env.path, { ...seams().io, connectTimeoutMs: 300 });
  expect(code).toBe(10);
  expect(hop("forward")).toMatchObject({ ok: true });
  expect(hop("lockdown")).toMatchObject({ ok: false, skipped: false });
  expect(hop("lockdown").detail).toMatch(/did not answer/);
  expect(hop("lockdown").detail).not.toMatch(/refused|closed/);
  expect(hop("lockdown").fix).toMatch(/doctor again/);
  expect(hop("egress")).toMatchObject({ ok: false, skipped: true });

  // The server answers every request; its forced command just never prints or exits. Nothing was allowed.
  const hanging = await doctor((await locked({ forced: "hangs" })).path, { ...seams().io, connectTimeoutMs: 300 });
  expect(hanging.code).toBe(0);
  expect(hanging.hop("lockdown")).toMatchObject({ ok: true, skipped: false });
});

test("[C105] a locked-down server whose forced command hangs also for the sftp subsystem passes every lockdown probe with exit 0", async () => {
  // Like sshd with command="sleep infinity": shell, exec and sftp are granted, and nothing ever answers.
  const env = await locked({ forced: "hangs" });
  const { code, hop } = await doctor(env.path, { ...seams().io, connectTimeoutMs: 300 });
  expect(code).toBe(0);
  expect(hop("lockdown")).toMatchObject({ ok: true, skipped: false });
  // The probes after sftp still ran: the local forward and the forward on another port.
  expect(env.ssh.localForwards).toEqual([{ destIP: "127.0.0.1", destPort: env.ssh.port }]);
  expect(env.ssh.requests.filter((r) => r.name === "tcpip-forward").map((r) => r.bindPort)).toContain(env.remotePort + 1);
  expect(hop("egress")).toMatchObject({ ok: true });
});

test("[C109] the lockdown fix pins the listen port and gateway ports like the README's sshd block", async () => {
  const env = await locked({ shell: true });
  const { code, hop } = await doctor(env.path, seams().io);
  expect(code).toBe(14);
  expect(hop("lockdown").fix).toContain(`PermitListen 127.0.0.1:${env.remotePort}`);
  expect(hop("lockdown").fix).toContain("GatewayPorts no");
});

test("[C110] a server_reachable or egress dial still pending at the timeout is told to stop", async () => {
  const env = await locked();
  for (const [hop, port] of [["server_reachable", env.config.server.port], ["egress", 443]] as const) {
    const signals: (AbortSignal | undefined)[] = [];
    const io: Partial<Io> = {
      ...seams().io,
      dial: (address, p, signal) => {
        if (p !== port) return localDial(address, p);
        signals.push(signal);
        return new Promise(() => {});
      },
      // The SSH and lockdown hops share this timeout; 300 ms failed them under load (15.4).
      connectTimeoutMs: 2000,
    };
    const result = await doctor(env.path, io);
    expect([hop, result.code]).toEqual([hop, 10]);
    expect(result.hop(hop)).toMatchObject({ ok: false, skipped: false });
    expect(signals.map((s) => s?.aborted)).toEqual([true]);
  }
});

test("[C97] a forward request the connection never answers fails the forward hop with exit 10, not as a refusal", async () => {
  const drop = (ssh: TestServer) => ssh.clients.forEach((c) => (c as unknown as { _sock: { destroy(): void } })._sock.destroy());
  const table: [RegExp, (env: () => Awaited<ReturnType<typeof setup>>) => Server][] = [
    [/connection closed/, (env) => ({ forward: () => (drop(env().ssh), false) })],
    [/did not answer/, () => ({ forward: () => "silent" })],
  ];
  for (const [detail, server] of table) {
    let env!: Awaited<ReturnType<typeof setup>>;
    env = await setup(server(() => env));
    servers.push(env.ssh);
    const { code, hop } = await doctor(env.path, { ...seams().io, connectTimeoutMs: 300 });
    expect([detail, code]).toEqual([detail, 10]);
    expect(hop("ssh_auth")).toMatchObject({ ok: true });
    expect(hop("forward")).toMatchObject({ ok: false, skipped: false });
    expect(hop("forward").detail).toMatch(detail);
    expect(hop("forward").detail).not.toMatch(/refused/);
    expect(hop("forward").fix).toMatch(/doctor again/);
    expect(hop("forward").fix).not.toMatch(/permitlisten/);
    expect(hop("lockdown")).toMatchObject({ ok: false, skipped: true });
  }
  // A server that answers "no" is still a refusal with exit 11 (C52).
});
