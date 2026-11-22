// Runs against the binary `bun run build:sidecar` wrote; run that first (checks.md `Run sidecar`).
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setup, stateIs, type TestServer } from "../../tests/ssh-server";

const repo = join(import.meta.dir, "..", "..");
const triple = /^host: (\S+)$/m.exec(Bun.spawnSync(["rustc", "-vV"]).stdout.toString())![1];
const sidecar = join(repo, "app", "src-tauri", "binaries", `social-tunnel-${triple}`);
const env = { PATH: "/usr/bin:/bin", HOME: "/nonexistent-home" };

const servers: TestServer[] = [];
const procs: Bun.Subprocess[] = [];
afterEach(async () => {
  for (const p of procs.splice(0)) p.kill("SIGKILL");
  for (const s of servers.splice(0)) await s.close();
});

test("[tray-app C3] build:sidecar writes social-tunnel-<host triple> and it prints the package.json version", async () => {
  const version = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version;
  const proc = Bun.spawn([sidecar, "--version"], { stdin: "ignore", stdout: "pipe", env });
  expect(await proc.exited).toBe(0);
  expect(await new Response(proc.stdout).text()).toBe(`${version}\n`);
  // A cold start of the 90 MB binary under `taskpolicy -b` takes seconds on a loaded machine.
}, 30_000);

test("[tray-app C4] the compiled sidecar's run --json makes its own status --json report connected within 10 s", async () => {
  const files = await setup();
  servers.push(files.ssh);
  const run = Bun.spawn([sidecar, "run", "--json", "--config", files.path], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env });
  procs.push(run);
  const started = Date.now();
  await stateIs(files.statePath, "connected", 10_000);

  const status = Bun.spawn([sidecar, "status", "--json", "--config", files.path], { stdin: "ignore", stdout: "pipe", env });
  const code = await status.exited;
  const body = JSON.parse(await new Response(status.stdout).text());
  expect(Date.now() - started).toBeLessThan(10_000);
  expect(code).toBe(0);
  expect(body).toMatchObject({ ok: true, command: "status", state: "connected", pid: run.pid });
}, 30_000);
