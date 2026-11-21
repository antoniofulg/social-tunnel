import { afterEach, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/log";
import type { State } from "../src/state";
import { isExpectedForward, retryDelay, startTunnel, type Tunnel, type TunnelOptions } from "../src/tunnel";
import { sleep, until } from "./helpers";
import { harness, OK } from "./proxy-harness";
import { readJson, setup, startServer, type TestServer } from "./ssh-server";

const tunnels: Tunnel[] = [];
const servers: TestServer[] = [];
afterEach(async () => {
  for (const tunnel of tunnels.splice(0)) await tunnel.stop();
  for (const ssh of servers.splice(0)) await ssh.close();
});

// Starts the real tunnel against an in-process server; records every state as it is written to disk.
async function tunnelTo(env: Awaited<ReturnType<typeof setup>>, options: Partial<TunnelOptions> = {}) {
  const loaded = loadConfig(env.path, readFileSync, () => "/nonexistent-home");
  if (!loaded.ok) throw new Error(loaded.message);
  const states: State[] = [];
  const handled: Duplex[] = [];
  const tunnel = startTunnel({
    config: loaded.config,
    key: readFileSync(env.keyPath),
    statePath: env.statePath,
    handle: (stream) => void handled.push(stream),
    // The file is read back here, so `states` is what a reader of state.json saw.
    onState: () => states.push(readJson(env.statePath)),
    backoffMs: [10],
    ...options,
  });
  tunnels.push(tunnel);
  servers.push(env.ssh);
  const names = () => states.map((s) => (s.reason ? `${s.state}/${s.reason}` : s.state));
  return { tunnel, states, names, handled };
}

test("[C25] the tunnel authenticates with the key, requests the forward and state goes connecting -> connected", async () => {
  const env = await setup();
  const t = await tunnelTo(env);
  await until(() => t.names().includes("connected"));

  expect(t.names()).toEqual(["connecting", "connected"]);
  expect(env.ssh.auth).toContain("publickey");
  expect(env.ssh.requests).toEqual([{ name: "tcpip-forward", bindAddr: "127.0.0.1", bindPort: env.remotePort }]);
  expect(readJson(env.statePath)).toMatchObject({ state: "connected", reason: null, retryAt: null, pid: process.pid });
});

test("[C27] a refused forward gives blocked/port_blocked and the next attempt 30 s later", async () => {
  const env = await setup({ forward: () => false });
  const delays: number[] = [];
  const t = await tunnelTo(env, { schedule: (_fn, ms) => (delays.push(ms), () => {}) });
  await until(() => t.names().includes("blocked/port_blocked"));

  expect(t.names()).toEqual(["connecting", "blocked/port_blocked"]);
  expect(delays).toEqual([30000]);
  const state = readJson(env.statePath);
  expect(Date.parse(state.retryAt) - Date.parse(state.since)).toBe(30000);
});

test("[C28] closing the server connection gives disconnected/connection_lost, reconnecting, connected", async () => {
  const env = await setup();
  const t = await tunnelTo(env);
  await until(() => t.names().includes("connected"));

  env.ssh.dropAll();
  await until(() => t.names().length >= 5);
  expect(t.names()).toEqual(["connecting", "connected", "disconnected/connection_lost", "reconnecting", "connected"]);
  const lost = t.states[2]!;
  expect(Date.parse(lost.retryAt!) - Date.parse(lost.since)).toBe(10);
  expect(env.ssh.clients.length).toBe(2);
});

test("[C59] unanswered keepalives give disconnected/connection_lost after 3 missed intervals, not before", async () => {
  const interval = 150;
  const env = await setup();
  const t = await tunnelTo(env, { keepaliveIntervalMs: interval, keepaliveCountMax: 3, schedule: () => () => {} });
  await until(() => t.names().includes("connected"));

  // While the server answers, the tunnel outlives more than 3 intervals.
  await sleep(interval * 5);
  expect(t.names()).toEqual(["connecting", "connected"]);

  env.ssh.stopReading();
  const silentSince = Date.now();
  await sleep(interval * 3 - 40);
  expect(t.names()).toEqual(["connecting", "connected"]);

  await until(() => t.names().length === 3, interval * 20, "keepalive timeout");
  expect(t.names()[2]).toBe("disconnected/connection_lost");
  expect(Date.now() - silentSince).toBeGreaterThanOrEqual(interval * 3);
});

test("[C29] retry delays run 1, 2, 4, 8, 16, 30, 30 s and return to 1 s after a connection", async () => {
  expect([0, 1, 2, 3, 4, 5, 6, 7].map((n) => retryDelay(n))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);

  // The server is down for seven attempts, then comes back on the same port with the same host key.
  const env = await setup();
  await env.ssh.close();

  const delays: number[] = [];
  let ssh: TestServer | undefined;
  const t = await tunnelTo(env, {
    backoffMs: undefined,
    schedule: (fn, ms) => {
      delays.push(ms);
      const go = async () => {
        if (delays.length === 7) {
          ssh = await startServer({ ...env.ssh.options, port: env.ssh.port, host: env.ssh.host });
          servers.push(ssh);
        }
        fn();
      };
      void go();
      return () => {};
    },
  });
  await until(() => t.names().includes("connected"));
  expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);

  ssh!.dropAll();
  await until(() => delays.length === 8);
  expect(delays[7]).toBe(1000);
});

test("[C30] a connection to the forwarded port reaches the proxy and an allowlisted CONNECT gets 200", async () => {
  const env = await setup({ open: true });
  const proxy = harness();
  const t = await tunnelTo(env, { handle: proxy.handle });
  await until(() => t.names().includes("connected"));

  const socket = net.connect(env.remotePort, "127.0.0.1");
  let received = "";
  socket.on("data", (chunk) => (received += chunk.toString("latin1")));
  socket.write("CONNECT www.instagram.com:443 HTTP/1.1\r\nHost: www.instagram.com:443\r\n\r\nhello");
  await until(() => received.includes("\r\n\r\n"));
  expect(received).toBe(`${OK}\r\n\r\n`);
  expect(proxy.lookups).toEqual(["www.instagram.com"]);

  await until(() => proxy.dials[0]!.received().toString() === "hello");
  proxy.dials[0]!.remote.write("world");
  await until(() => received.endsWith("world"));
  socket.destroy();
});

test("[C31] state.json holds exactly the nine fields and is replaced through a temp file and rename", async () => {
  const env = await setup();
  const inodes: number[] = [];
  const leftovers: string[][] = [];
  const t = await tunnelTo(env, {
    heartbeatMs: 20,
    onState: () => {
      inodes.push(statSync(env.statePath).ino);
    },
  });
  await until(() => inodes.length === 2);

  const state = readJson(env.statePath);
  expect(Object.keys(state).sort()).toEqual(
    ["pid", "reason", "remotePort", "retryAt", "server", "since", "state", "updatedAt", "version"].sort(),
  );
  expect(state).toMatchObject({
    version: 1,
    pid: process.pid,
    state: "connected",
    reason: null,
    retryAt: null,
    server: { host: "127.0.0.1", port: env.ssh.port },
    remotePort: env.remotePort,
  });
  expect(new Date(state.since).toISOString()).toBe(state.since);
  expect(new Date(state.updatedAt).toISOString()).toBe(state.updatedAt);

  // Every write lands as a new file under the same name: the inode changes, and the content
  // parses at every moment a reader could look.
  for (let i = 0; i < 40; i++) {
    inodes.push(statSync(env.statePath).ino);
    expect(readJson(env.statePath).version).toBe(1);
    leftovers.push(readdirSync(env.dir).filter((f) => f.includes(".tmp")));
    await sleep(5);
  }
  expect(new Set(inodes).size).toBeGreaterThan(3);
  expect(leftovers.flat()).toEqual([]);
  await t.tunnel.stop();
  expect(readdirSync(env.dir).sort()).toEqual(["config.json", "state.json", "tunnel_key"]);
});

test("[C35] a forwarded connection for another port or bind address is rejected before the proxy", async () => {
  const env = await setup();
  const t = await tunnelTo(env);
  await until(() => t.names().includes("connected"));

  expect(await env.ssh.announce("127.0.0.1", env.remotePort + 1)).toBe(false);
  expect(await env.ssh.announce("0.0.0.0", env.remotePort)).toBe(false);
  expect(t.handled.length).toBe(0);

  // The expected forward still gets through, so the rejections above are the filter at work.
  expect(await env.ssh.announce("127.0.0.1", env.remotePort)).toBe(true);
  await until(() => t.handled.length === 1);
});

test("[C36] updatedAt is rewritten every heartbeat while connected and while retrying a blocked port", async () => {
  const heartbeatMs = 40;
  for (const [server, state] of [
    [{}, "connected"],
    [{ forward: () => false }, "blocked"],
  ] as const) {
    const env = await setup(server);
    const t = await tunnelTo(env, { heartbeatMs, blockedRetryMs: 60_000 });
    await until(() => t.states.at(-1)?.state === state);

    const seen = new Set<string>();
    const started = Date.now();
    while (Date.now() - started < heartbeatMs * 6) {
      const now = readJson(env.statePath);
      expect(now.state).toBe(state);
      seen.add(now.updatedAt);
      await sleep(5);
    }
    // Six intervals passed; allow slack for a loaded machine but require steady rewrites.
    expect(seen.size).toBeGreaterThanOrEqual(4);
    expect(Math.max(...[...seen].map((s) => Date.parse(s)))).toBeGreaterThan(Date.parse(t.states.at(-1)!.since));
  }
});

test("[C37] a log line for an invalid host shows no host, and control characters in server text are stripped", async () => {
  const lines: string[] = [];
  const log = createLogger((text) => void lines.push(text), false);

  const proxy = harness({ log: (entry) => log("proxy request", entry) });
  expect(await proxy.status("evil\x1b[31m_host.example:443")).toBe("HTTP/1.1 400 Bad Request");
  expect(await proxy.status("instagram.com:443abc")).toBe("HTTP/1.1 400 Bad Request");
  expect(lines.length).toBe(2);
  for (const line of lines) {
    expect(line).toContain("status=400");
    expect(line).not.toContain("host");
    expect(line).not.toContain("evil");
    expect(line).not.toContain("instagram");
  }
  // A host that passed the grammar is logged.
  expect(await proxy.status("example.org:443")).toBe("HTTP/1.1 403 Forbidden");
  expect(lines[2]).toContain("host=example.org");

  lines.length = 0;
  const env = await setup({ banner: "welcome\x1b[2J\x07 \x1b]0;owned\x07to the\r\nserver\u009b" });
  const t = await tunnelTo(env, { log });
  await until(() => t.names().includes("connected"));
  const banner = lines.find((line) => line.includes("server banner"));
  expect(banner).toBeDefined();
  expect(banner).toContain("welcome[2J ]0;ownedto theserver");
  for (const line of lines) expect(line.slice(0, -1)).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
});

test("[C67] the forward filter accepts only 127.0.0.1 on the configured remote port", () => {
  expect(isExpectedForward({ destIP: "127.0.0.1", destPort: 8888 }, 8888)).toBe(true);
  expect(isExpectedForward({ destIP: "127.0.0.1", destPort: 8889 }, 8888)).toBe(false);
  expect(isExpectedForward({ destIP: "0.0.0.0", destPort: 8888 }, 8888)).toBe(false);
  expect(isExpectedForward({ destIP: "localhost", destPort: 8888 }, 8888)).toBe(false);
  expect(isExpectedForward({ destIP: "::1", destPort: 8888 }, 8888)).toBe(false);
  expect(isExpectedForward({ destIP: "127.0.0.1", destPort: 0 }, 8888)).toBe(false);
});
