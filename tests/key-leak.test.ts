import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Io } from "../src/cli";
import { cli, localDial, spawnCli } from "./helpers";
import { pair, PUBLIC } from "./proxy-harness";
import { setup, stateIs, type TestServer } from "./ssh-server";

const servers: TestServer[] = [];
const procs: ReturnType<typeof spawnCli>[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const ssh of servers.splice(0)) await ssh.close();
});

// Lines of the key file that show up anywhere in `captured`.
function leaked(keyPath: string, captured: string[]): string[] {
  const lines = readFileSync(keyPath, "utf8").split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  expect(lines.length).toBeGreaterThanOrEqual(3);
  return lines.filter((line) => captured.some((text) => text.includes(line)));
}

async function target(server: Parameters<typeof setup>[0] = {}) {
  let remotePort = 0;
  const env = await setup({ forward: (port) => port === remotePort, ...server });
  remotePort = env.remotePort;
  servers.push(env.ssh);
  return { env };
}

// Runs `run --json` until it reaches `state`, stops it, and returns everything it produced.
async function runUntil(env: Awaited<ReturnType<typeof setup>>, state: string | null) {
  const run = spawnCli(["run", "--json", "--config", env.path]);
  procs.push(run);
  const captured: string[] = [];
  if (state) {
    await stateIs(env.statePath, state);
    captured.push(readFileSync(env.statePath, "utf8"));
    run.kill("SIGTERM");
  }
  const result = await run.exit();
  captured.push(result.stdout, result.stderr);
  if (existsSync(env.statePath)) captured.push(readFileSync(env.statePath, "utf8"));
  return { code: result.code, captured, result };
}

// Runs `doctor --json` in-process and also captures anything written straight to the process streams.
async function doctorCaptured(env: Awaited<ReturnType<typeof setup>>) {
  const direct: string[] = [];
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = ((chunk: any) => (direct.push(String(chunk)), true)) as typeof process.stdout.write;
  process.stderr.write = ((chunk: any) => (direct.push(String(chunk)), true)) as typeof process.stderr.write;
  const io: Partial<Io> = {
    resolve: async () => [PUBLIC],
    dial: (address, port) => (port === 443 ? Promise.resolve(pair()[0]) : localDial(address, port)),
  };
  try {
    const result = await cli(["doctor", "--json", "--config", env.path], io);
    return { code: result.code, hops: result.json().hops as any[], captured: [result.stdout, result.stderr, ...direct] };
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
}

test("[C34] no line of the private key appears in stdout, stderr or state.json on five paths", async () => {
  // 1. a connected run
  const connected = await target();
  const one = await runUntil(connected.env, "connected");
  expect(one.code).toBe(0);
  expect(one.result.stderr).toContain("connected");
  expect(leaked(connected.env.keyPath, one.captured)).toEqual([]);

  // 2. a run whose key the server refuses
  const refused = await target({ authorize: false });
  const two = await runUntil(refused.env, "disconnected");
  expect(two.captured[0]).toContain("auth_failed");
  expect(refused.env.ssh.auth).toContain("publickey");
  expect(leaked(refused.env.keyPath, two.captured)).toEqual([]);

  // 3. a run with a malformed key
  const malformed = await target();
  const body = randomBytes(210).toString("base64").match(/.{1,70}/g)!.join("\n");
  writeFileSync(malformed.env.keyPath, `-----BEGIN OPENSSH PRIVATE KEY-----\n${body}\n-----END OPENSSH PRIVATE KEY-----\n`);
  const three = await runUntil(malformed.env, null);
  expect(three.code).toBe(2);
  expect(JSON.parse(three.result.stdout).error.code).toBe("key_invalid");
  expect(leaked(malformed.env.keyPath, three.captured)).toEqual([]);

  // 4. doctor with every hop passing
  const healthy = await target();
  const four = await doctorCaptured(healthy.env);
  expect(four.code).toBe(0);
  expect(four.hops.every((h) => h.ok)).toBe(true);
  expect(leaked(healthy.env.keyPath, four.captured)).toEqual([]);

  // 5. doctor with ssh_auth failing
  const locked = await target({ authorize: false });
  const five = await doctorCaptured(locked.env);
  expect(five.code).toBe(10);
  expect(five.hops.find((h) => h.hop === "ssh_auth")).toMatchObject({ ok: false, skipped: false });
  expect(leaked(locked.env.keyPath, five.captured)).toEqual([]);
}, 60_000);
