import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { evaluateStatus } from "../src/status";
import type { State } from "../src/state";
import { cli, spawnCli, writeConfig } from "./helpers";

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

function stateFile(patch: Partial<State> = {}): State {
  const now = new Date().toISOString();
  return {
    version: 1,
    pid: process.pid,
    state: "connected",
    reason: null,
    since: "2026-11-21T10:00:00.000Z",
    retryAt: null,
    server: { host: "vps.example.com", port: 22 },
    remotePort: 8888,
    updatedAt: now,
    ...patch,
  };
}

// Runs `status --json` over a config whose state.json holds `state` (or no file when null).
async function status(state: State | null) {
  const files = writeConfig((c) => {
    c.server.host = "vps.example.com";
    c.domains = ["instagram.com", "facebook.com", "linkedin.com"];
  });
  if (state) writeFileSync(files.statePath, JSON.stringify(state));
  const result = await cli(["status", "--json", "--config", files.path]);
  return { code: result.code, body: result.json() };
}

test("[C38] a live connected run exits 0 with state, since, server host, remote port and domain count", async () => {
  const { code, body } = await status(stateFile());
  expect(code).toBe(0);
  expect(body).toMatchObject({
    ok: true,
    command: "status",
    state: "connected",
    since: "2026-11-21T10:00:00.000Z",
    pid: process.pid,
    server: { host: "vps.example.com" },
    remotePort: 8888,
    domains: 3,
  });
});

test("[C39] an absent file, a dead pid and a stopped state each report stopped and exit 10", async () => {
  const cases = [null, stateFile({ pid: await deadPid() }), stateFile({ state: "stopped" })];
  for (const state of cases) {
    const { code, body } = await status(state);
    expect(code).toBe(10);
    expect(body).toMatchObject({ ok: false, command: "status", state: "stopped", pid: null });
  }
});

test("[C40] connecting, disconnected and reconnecting each exit 10 with reason and retryAt", async () => {
  const retryAt = "2026-11-21T10:00:04.000Z";
  const cases: Partial<State>[] = [
    { state: "connecting" },
    { state: "disconnected", reason: "connection_lost", retryAt },
    { state: "reconnecting" },
  ];
  for (const patch of cases) {
    const { code, body } = await status(stateFile(patch));
    expect(code).toBe(10);
    expect(body.ok).toBe(false);
    expect(body.state).toBe(patch.state!);
    expect(body).toHaveProperty("reason", patch.reason ?? null);
    expect(body).toHaveProperty("retryAt", patch.retryAt ?? null);
  }
});

test("[C41] blocked/port_blocked with a live pid exits 11", async () => {
  const { code, body } = await status(stateFile({ state: "blocked", reason: "port_blocked", retryAt: "2026-11-21T10:00:30.000Z" }));
  expect(code).toBe(11);
  expect(body).toMatchObject({ ok: false, state: "blocked", reason: "port_blocked", retryAt: "2026-11-21T10:00:30.000Z" });
});

test("[C42] blocked/host_key_mismatch exits 13 with a live pid and with a dead pid", async () => {
  const mismatch = { state: "blocked", reason: "host_key_mismatch" } as const;
  const old = new Date(Date.now() - 3_600_000).toISOString();
  const cases = [stateFile(mismatch), stateFile({ ...mismatch, pid: await deadPid() }), stateFile({ ...mismatch, updatedAt: old })];
  for (const state of cases) {
    const { code, body } = await status(state);
    expect(code).toBe(13);
    expect(body).toMatchObject({ ok: false, state: "blocked", reason: "host_key_mismatch" });
  }
});

test("[C43] status --json, doctor --json and a failing run --json each print exactly one JSON object and a newline", async () => {
  const { path } = writeConfig((c) => (c.domains = ["not a domain"]));
  for (const verb of ["status", "doctor", "run"]) {
    const result = await spawnCli([verb, "--json", "--config", path]).exit();
    expect([verb, result.code]).toEqual([verb, 2]);
    expect(result.stdout.endsWith("}\n")).toBe(true);
    expect(result.stdout.indexOf("\n")).toBe(result.stdout.length - 1);
    const body = JSON.parse(result.stdout);
    expect(body).toMatchObject({ ok: false, command: verb });
    expect(JSON.stringify(body) + "\n").toBe(result.stdout);
  }
}, 30_000);

test("[C44] a live pid whose updatedAt is older than 90 s reports stopped/stale and exits 10", async () => {
  const stale = await status(stateFile({ updatedAt: new Date(Date.now() - 91_000).toISOString() }));
  expect(stale.code).toBe(10);
  expect(stale.body).toMatchObject({ ok: false, state: "stopped", reason: "stale" });

  const fresh = await status(stateFile({ updatedAt: new Date(Date.now() - 60_000).toISOString() }));
  expect(fresh.code).toBe(0);
  expect(fresh.body.state).toBe("connected");

  // The threshold itself, with the clock pinned: 90 s is still live, one millisecond more is stale.
  const at = Date.parse("2026-11-21T12:00:00.000Z");
  const alive = () => true;
  const exactly = stateFile({ updatedAt: new Date(at - 90_000).toISOString() });
  const over = stateFile({ updatedAt: new Date(at - 90_001).toISOString() });
  expect(evaluateStatus(exactly, alive, at)).toMatchObject({ state: "connected", exit: 0 });
  expect(evaluateStatus(over, alive, at)).toMatchObject({ state: "stopped", reason: "stale", exit: 10 });
});

test("[C121] status applies host key mismatch, then dead pid or stopped, then stale, then the live state", async () => {
  const at = Date.parse("2026-11-21T12:00:00.000Z");
  const dead = await deadPid();
  const alive = (pid: number) => pid !== dead;
  const fresh = new Date(at - 1_000).toISOString();
  const stale = new Date(at - 91_000).toISOString();
  const blocked = { state: "blocked", reason: "port_blocked", retryAt: "2026-11-21T12:00:30.000Z" } as const;
  const lost = { state: "disconnected", reason: "connection_lost", retryAt: "2026-11-21T12:00:04.000Z" } as const;
  const mismatch = { state: "blocked", reason: "host_key_mismatch" } as const;
  const rows: [string, Partial<State>, { state: string; reason: string | null; exit: number }][] = [
    ["dead pid, port_blocked", { ...blocked, pid: dead, updatedAt: fresh }, { state: "stopped", reason: null, exit: 10 }],
    ["stale live pid, port_blocked", { ...blocked, updatedAt: stale }, { state: "stopped", reason: "stale", exit: 10 }],
    ["fresh live pid, port_blocked", { ...blocked, updatedAt: fresh }, { state: "blocked", reason: "port_blocked", exit: 11 }],
    ["dead pid, disconnected", { ...lost, pid: dead, updatedAt: fresh }, { state: "stopped", reason: null, exit: 10 }],
    ["stale live pid, disconnected", { ...lost, updatedAt: stale }, { state: "stopped", reason: "stale", exit: 10 }],
    ["dead pid and stale, host key mismatch", { ...mismatch, pid: dead, updatedAt: stale }, { state: "blocked", reason: "host_key_mismatch", exit: 13 }],
  ];
  for (const [name, patch, want] of rows) {
    const view = evaluateStatus(stateFile(patch), alive, at);
    expect([name, { state: view.state, reason: view.reason, exit: view.exit }]).toEqual([name, want]);
    if (want.exit === 10) expect([name, view.retryAt]).toEqual([name, null]);
  }

  // The same divergent rows through the CLI.
  const dp = await status(stateFile({ ...blocked, pid: dead }));
  expect([dp.code, dp.body.state]).toEqual([10, "stopped"]);
  const sp = await status(stateFile({ ...blocked, updatedAt: new Date(Date.now() - 91_000).toISOString() }));
  expect([sp.code, sp.body.state, sp.body.reason]).toEqual([10, "stopped", "stale"]);
});
