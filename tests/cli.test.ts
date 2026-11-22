import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
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

test("[C77] status and doctor without --json print readable lines with control characters stripped", async () => {
  const files = writeConfig((c) => {
    c.server.host = "vps.example.com";
    c.domains = ["instagram.com", "facebook.com"];
  });
  const esc = String.fromCharCode(0x1b);
  writeFileSync(
    files.statePath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      state: "disconnected",
      reason: `connection_lost${esc}[2J`,
      since: "2026-11-21T10:00:00.000Z",
      retryAt: "2026-11-21T10:00:04.000Z",
      server: { host: "vps.example.com", port: 22 },
      remotePort: 8888,
      updatedAt: new Date().toISOString(),
    }),
  );
  const status = await cli(["status", "--config", files.path]);
  expect(status.code).toBe(10);
  expect(status.stderr).toBe("");
  expect(status.stdout).toBe(
    "state: disconnected (connection_lost[2J)\n" +
      "since: 2026-11-21T10:00:00.000Z\n" +
      "retry at: 2026-11-21T10:00:04.000Z\n" +
      "server: vps.example.com:22\n" +
      "remote port: 8888\n" +
      "domains: 2\n",
  );

  const loose = writeConfig(() => {}, 0o644);
  const doctor = await cli(["doctor", "--config", loose.path]);
  expect(doctor.code).toBe(2);
  const lines = doctor.stdout.trimEnd().split("\n");
  expect(lines[0]).toBe(`ok   config: ${loose.path} is valid`);
  expect(lines[1]).toBe(`FAIL key: key file ${loose.keyPath} is accessible by group or others`);
  expect(lines[2]).toBe(`     fix: Run: chmod 600 '${loose.keyPath}'`);
  expect(lines.slice(3)).toEqual(["server_reachable", "ssh_auth", "forward", "lockdown", "egress"].map((hop) => `skip ${hop}: skipped`));
});

test("[C104] --json output strips control, bidi and zero-width characters from file-supplied strings", async () => {
  const hidden = "\u009b\u202e\u200b";
  const raw = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e]/;

  // An unknown config key reaches error.field and error.message.
  const badKey = writeConfig((c) => (c[`pass${hidden}word`] = 1));
  const invalid = await cli(["status", "--json", "--config", badKey.path]);
  expect(invalid.code).toBe(2);
  expect(invalid.stdout.slice(0, -1)).not.toMatch(raw);
  expect(invalid.json().error).toEqual({ code: "config_invalid", field: "password", message: 'unknown key "password"' });

  // A state.json field reaches the status object.
  const files = writeConfig();
  const now = new Date().toISOString();
  writeFileSync(
    files.statePath,
    JSON.stringify({
      version: 1,
      pid: process.pid,
      state: "disconnected",
      reason: `connection_lost${hidden}`,
      since: `${now}${hidden}`,
      retryAt: null,
      server: { host: "127.0.0.1", port: 22 },
      remotePort: 8888,
      updatedAt: now,
    }),
  );
  const status = await cli(["status", "--json", "--config", files.path]);
  expect(status.code).toBe(10);
  expect(status.stdout.slice(0, -1)).not.toMatch(raw);
  expect(status.json()).toMatchObject({ state: "disconnected", reason: "connection_lost", since: now });

  // A rejected domain entry reaches the doctor hop's detail.
  const badDomain = writeConfig((c) => (c.domains = [`insta${hidden}gram`]));
  const doctor = await cli(["doctor", "--json", "--config", badDomain.path]);
  expect(doctor.code).toBe(2);
  expect(doctor.stdout.slice(0, -1)).not.toMatch(raw);
  expect(doctor.json().hops[0].detail).toContain("instagram");
});
