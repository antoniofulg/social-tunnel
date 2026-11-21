import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { cli, spawnCli } from "./helpers";
import { readJson, setup, stateIs, type TestServer } from "./ssh-server";

const servers: TestServer[] = [];
const procs: ReturnType<typeof spawnCli>[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const ssh of servers.splice(0)) await ssh.close();
});

async function running(argv: string[] = [], server: Parameters<typeof setup>[0] = {}) {
  const env = await setup(server);
  servers.push(env.ssh);
  const run = spawnCli(["run", "--config", env.path, ...argv]);
  procs.push(run);
  return { env, run };
}

test("[C26] run against a server with another host key sends no auth request, records the mismatch and exits 13", async () => {
  const env = await setup({}, (config) => (config.server.hostKey = "SHA256:" + "A".repeat(43)));
  servers.push(env.ssh);
  const run = spawnCli(["run", "--json", "--config", env.path]);
  procs.push(run);

  const result = await run.exit();
  expect(result.code).toBe(13);
  expect(env.ssh.clients.length).toBe(1);
  expect(env.ssh.auth).toEqual([]);
  expect(readJson(env.statePath)).toMatchObject({ state: "blocked", reason: "host_key_mismatch", retryAt: null });
  expect(JSON.parse(result.stdout)).toEqual({ ok: false, command: "run", state: "blocked", reason: "host_key_mismatch" });
}, 30_000);

test("[C32] run stopped by SIGTERM or SIGINT cancels the forward, writes stopped and exits 0", async () => {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const { env, run } = await running();
    await stateIs(env.statePath, "connected");

    run.kill(signal);
    const result = await run.exit();
    expect([signal, result.code]).toEqual([signal, 0]);
    expect(readJson(env.statePath)).toMatchObject({ state: "stopped", reason: null, pid: run.pid });
    expect(env.ssh.requests).toEqual([
      { name: "tcpip-forward", bindAddr: "127.0.0.1", bindPort: env.remotePort },
      { name: "cancel-tcpip-forward", bindAddr: "127.0.0.1", bindPort: env.remotePort },
    ]);
  }
}, 30_000);

test("[C33] a second run while state.json names a live other pid exits 2 with already_running", async () => {
  const env = await setup();
  servers.push(env.ssh);
  const state = {
    version: 1,
    pid: process.ppid,
    state: "connected",
    reason: null,
    since: new Date().toISOString(),
    retryAt: null,
    server: { host: "127.0.0.1", port: env.ssh.port },
    remotePort: env.remotePort,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(env.statePath, JSON.stringify(state));

  const result = await cli(["run", "--json", "--config", env.path]);
  expect(result.code).toBe(2);
  expect(result.json()).toMatchObject({ ok: false, command: "run", error: { code: "already_running" } });
  expect(env.ssh.clients.length).toBe(0);
  expect(readJson(env.statePath)).toEqual(state);
}, 30_000);

test("[C58] a connected run holds no listening TCP socket", async () => {
  const { env, run } = await running();
  await stateIs(env.statePath, "connected");

  // Throws if lsof is missing, which fails the test.
  const all = Bun.spawnSync(["lsof", "-a", "-p", String(run.pid), "-iTCP"]);
  const listening = Bun.spawnSync(["lsof", "-a", "-p", String(run.pid), "-iTCP", "-sTCP:LISTEN"]);
  // lsof sees this process's TCP sockets (the SSH connection), so an empty LISTEN list is a real answer.
  expect(all.stdout.toString()).toContain(`:${env.ssh.port}`);
  expect(listening.stdout.toString().trim()).toBe("");
  expect([0, 1]).toContain(listening.exitCode);
}, 30_000);

test("[C61] run --json stopped by SIGTERM prints one object on stdout and logs only on stderr", async () => {
  const { env, run } = await running(["--json"]);
  await stateIs(env.statePath, "connected");
  run.kill("SIGTERM");
  const result = await run.exit();

  expect(result.code).toBe(0);
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trimEnd().split("\n").length).toBe(1);
  const body = JSON.parse(result.stdout);
  expect(body).toEqual({ ok: true, command: "run", state: "stopped", reason: null });
  expect(Object.keys(body)).toEqual(["ok", "command", "state", "reason"]);

  const logs = result.stderr.trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(logs.length).toBeGreaterThanOrEqual(3);
  expect(logs.filter((l) => l.message === "tunnel state").map((l) => l.state)).toEqual(["connecting", "connected", "stopped"]);
}, 30_000);

test("[C66] run starts when state.json names a live pid but stopped being refreshed over 90 s ago", async () => {
  // A crashed run left its state behind and the pid now belongs to another process.
  const env = await setup({}, (config) => (config.server.hostKey = "SHA256:" + "A".repeat(43)));
  servers.push(env.ssh);
  const leftover = (ageMs: number) => ({
    version: 1,
    pid: process.ppid,
    state: "connected",
    reason: null,
    since: new Date(Date.now() - 3_600_000).toISOString(),
    retryAt: null,
    server: { host: "127.0.0.1", port: env.ssh.port },
    remotePort: env.remotePort,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  });

  writeFileSync(env.statePath, JSON.stringify(leftover(91_000)));
  const started = await cli(["run", "--json", "--config", env.path]);
  // It got past the guard and reached the server, where the wrong host key pin ends it.
  expect(started.code).toBe(13);
  expect(started.json()).toEqual({ ok: false, command: "run", state: "blocked", reason: "host_key_mismatch" });
  expect(env.ssh.clients.length).toBe(1);
  expect(readJson(env.statePath).pid).toBe(process.pid);

  writeFileSync(env.statePath, JSON.stringify(leftover(60_000)));
  const refused = await cli(["run", "--json", "--config", env.path]);
  expect(refused.code).toBe(2);
  expect(refused.json().error.code).toBe("already_running");
  expect(env.ssh.clients.length).toBe(1);
}, 30_000);
