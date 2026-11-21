import { afterEach, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { cli, spawnCli, writeConfig } from "./helpers";
import { setup, type TestServer } from "./ssh-server";

const servers: TestServer[] = [];
afterEach(async () => {
  for (const ssh of servers.splice(0)) await ssh.close();
});

test("[C55] unknown verbs and flags print usage on stderr and exit 2; --help and --version exit 0", async () => {
  for (const argv of [["frobnicate"], ["status", "--bogus"]]) {
    const result = await spawnCli(argv).exit();
    expect([argv, result.code]).toEqual([argv, 2]);
    expect(result.stderr).toContain("usage: social-tunnel");
    expect(result.stdout).toBe("");
  }

  const help = await spawnCli(["--help"]).exit();
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("usage: social-tunnel");

  const version = await spawnCli(["--version"]).exit();
  expect(version.code).toBe(0);
  expect(version.stdout).toBe(`${pkg.version}\n`);
}, 30_000);

test("[C56] no verb waits on stdin, and an unexpected exception exits 1 with error.code internal", async () => {
  // spawnCli holds stdin open and never writes to it; a command that read it would be killed at 5 s.
  const invalid = writeConfig((c) => (c.version = 2)).path;
  for (const verb of ["status", "run"]) {
    const started = Date.now();
    const result = await spawnCli([verb, "--json", "--config", invalid]).exit(5000);
    expect([verb, result.code]).toEqual([verb, 2]);
    expect(Date.now() - started).toBeLessThan(5000);
  }

  // A valid config against the in-process server; the server allows a shell, so doctor stops at
  // the lockdown hop and never needs the internet.
  const env = await setup({ shell: true });
  servers.push(env.ssh);
  const started = Date.now();
  const doctor = await spawnCli(["doctor", "--json", "--config", env.path]).exit(5000);
  expect(doctor.code).toBe(14);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(JSON.parse(doctor.stdout).hops.find((h: any) => h.hop === "ssh_auth").ok).toBe(true);

  const crashed = await cli(["status", "--json"], {
    homedir: () => {
      throw new Error("no home directory");
    },
  });
  expect(crashed.code).toBe(1);
  expect(crashed.json()).toMatchObject({ ok: false, command: "status", error: { code: "internal" } });
}, 30_000);
