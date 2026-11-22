import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { cli, HOST_KEY, writeConfig } from "./helpers";

// The fields the tray app reads from `status --json` (tray-app plan door 1).
test("[tray-app C1] status --json adds server.user, server.hostKey, keyPath and allowlist and keeps every existing field", async () => {
  const files = writeConfig((c) => {
    c.server.host = "vps.example.com";
    c.server.port = 2222;
    c.server.user = "tunnel";
    c.domains = ["Instagram.com.", "facebook.com", "threads.net"];
  });
  const state = {
    version: 1,
    pid: process.pid,
    state: "connected",
    reason: null,
    since: "2026-11-21T10:00:00.000Z",
    retryAt: null,
    server: { host: "vps.example.com", port: 2222 },
    remotePort: 8888,
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(files.statePath, JSON.stringify(state));
  const result = await cli(["status", "--json", "--config", files.path]);
  expect(result.code).toBe(0);
  expect(result.json()).toEqual({
    ok: true,
    command: "status",
    configPath: files.path,
    state: "connected",
    reason: null,
    since: "2026-11-21T10:00:00.000Z",
    retryAt: null,
    pid: process.pid,
    server: { host: "vps.example.com", port: 2222, user: "tunnel", hostKey: HOST_KEY },
    remotePort: 8888,
    domains: 3,
    keyPath: files.keyPath,
    allowlist: ["instagram.com", "facebook.com", "threads.net"],
  });
  expect(files.keyPath.startsWith("/")).toBe(true);

  // A stopped tunnel (exit 10) carries the same additions.
  const stopped = writeConfig();
  const down = await cli(["status", "--json", "--config", stopped.path]);
  expect(down.code).toBe(10);
  expect(down.json()).toMatchObject({ domains: 1, keyPath: stopped.keyPath, allowlist: ["instagram.com"] });
});

test("[tray-app C2] a missing or non-JSON config exits 2 with config_invalid and the absolute configPath it resolved", async () => {
  const { path: valid } = writeConfig();
  const dir = valid.slice(0, valid.lastIndexOf("/"));
  const missing = `${dir}/missing.json`;
  const notJson = `${dir}/not-json.json`;
  writeFileSync(notJson, "{ nope");
  for (const verb of ["status", "run"]) {
    for (const path of [missing, notJson]) {
      const result = await cli([verb, "--json", "--config", path]);
      expect(result.code).toBe(2);
      const body = result.json();
      expect([verb, path, body.ok, body.command, body.error.code, body.configPath]).toEqual([verb, path, false, verb, "config_invalid", path]);
    }
  }
  // Through $SOCIAL_TUNNEL_CONFIG too: the path is the resolved one, absolute.
  const viaEnv = await cli(["status", "--json"], { env: { SOCIAL_TUNNEL_CONFIG: missing } });
  expect(viaEnv.json().configPath).toBe(missing);
});
