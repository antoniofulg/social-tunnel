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
