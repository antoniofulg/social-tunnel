import { afterEach, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
  const names = ["shell", "sftp", "local forward", "remote forward"];
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
    // Every probe was really attempted against the server.
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
