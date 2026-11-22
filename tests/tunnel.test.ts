import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import type { Duplex } from "node:stream";
import { loadConfig } from "../src/config";
import { createLogger, sanitize } from "../src/log";
import type { State } from "../src/state";
import { isExpectedForward, retryDelay, startTunnel, type Tunnel, type TunnelOptions } from "../src/tunnel";
import { cli, sleep, until } from "./helpers";
import { Client, type ServerChannel } from "ssh2";
import { harness, OK, pair, PUBLIC } from "./proxy-harness";
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

test("[C70] a multi-megabyte response arrives byte-exact through the tunnel when upstream closes after sending", async () => {
  const size = 8 * 1024 * 1024;
  const body = Buffer.alloc(size);
  for (let i = 0; i < size; i += 4) body.writeUInt32LE(i, i);
  const expected = createHash("sha256").update(body).digest("hex");

  // The origin sends everything and closes at once, faster than the SSH channel can carry it.
  const origin = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.end(body);
  });
  await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
  const originPort = (origin.address() as net.AddressInfo).port;

  const env = await setup({ open: true });
  const proxy = harness({
    dial: () =>
      new Promise((resolve, reject) => {
        const socket = net.connect(originPort, "127.0.0.1");
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      }),
  });
  const t = await tunnelTo(env, { handle: proxy.handle });
  await until(() => t.names().includes("connected"));

  try {
    for (let run = 0; run < 6; run++) {
      const received: Buffer[] = [];
      let closed = false;
      const socket = net.connect(env.remotePort, "127.0.0.1");
      socket.on("data", (chunk) => received.push(chunk));
      socket.on("close", () => (closed = true));
      socket.write("CONNECT instagram.com:443 HTTP/1.1\r\n\r\n");
      await until(() => closed, 20000, "the relay to close");

      const all = Buffer.concat(received);
      const head = `${OK}\r\n\r\n`;
      expect(all.subarray(0, head.length).toString()).toBe(head);
      expect([run, all.length - head.length]).toEqual([run, size]);
      expect(createHash("sha256").update(all.subarray(head.length)).digest("hex")).toBe(expected);
    }
  } finally {
    origin.close();
  }
}, 120_000);

test("[C71] a refused key gives disconnected/auth_failed with retryAt, and status exits 10 with that reason", async () => {
  const env = await setup({ authorize: false });
  const t = await tunnelTo(env, { schedule: () => () => {} });
  await until(() => t.names().length === 2);

  expect(t.names()).toEqual(["connecting", "disconnected/auth_failed"]);
  expect(env.ssh.auth).toContain("publickey");
  const state = readJson(env.statePath);
  expect(Date.parse(state.retryAt) - Date.parse(state.since)).toBe(10);

  const status = await cli(["status", "--json", "--config", env.path]);
  expect(status.code).toBe(10);
  expect(status.json()).toMatchObject({ ok: false, state: "disconnected", reason: "auth_failed", retryAt: state.retryAt });
});

test("[C78] sanitize strips control, bidi and zero-width characters", () => {
  const hidden = [0x1b, 0x07, 0x7f, 0x9b, 0x200b, 0x200e, 0x200f, 0x202a, 0x202e, 0x2028, 0x2029, 0x2066, 0x2069, 0xfeff];
  for (const code of hidden) {
    const mark = String.fromCharCode(code);
    expect([code, sanitize(`pay${mark}load`)]).toEqual([code, "payload"]);
  }
  expect(sanitize("plain text, ünïcödé and 日本語 stay")).toBe("plain text, ünïcödé and 日本語 stay");
});

test("[C83] sanitize also strips the soft hyphen, Arabic letter mark, word joiner, invisible operators and tag characters", () => {
  const hidden = [0xad, 0x61c, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xe0000, 0xe0001, 0xe0041, 0xe007f];
  for (const code of hidden) {
    const mark = String.fromCodePoint(code);
    expect([code, sanitize(`pay${mark}load`)]).toEqual([code, "payload"]);
  }
  // Neighbours and ordinary astral characters stay.
  const kept = [0xac, 0xae, 0x61b, 0x61d, 0x205f, 0xe0080, 0x1f600];
  for (const code of kept) {
    const text = `pay${String.fromCodePoint(code)}load`;
    expect([code, sanitize(text)]).toEqual([code, text]);
  }
});

const CONNECT = "CONNECT instagram.com:443 HTTP/1.1\r\n\r\n";

// Opens a forwarded channel from the server side, the way sshd does for a connection to the remote port.
function forwarded(env: Awaited<ReturnType<typeof setup>>): Promise<ServerChannel> {
  return new Promise((resolve, reject) => {
    env.ssh.clients.at(-1)!.forwardOut("127.0.0.1", env.remotePort, "127.0.0.1", 50000, (err, channel) => {
      if (err) return reject(err);
      channel.on("error", () => {});
      resolve(channel);
    });
  });
}

test("[C85] on the tunnel's SSH channel, a channel closed or a connection lost during the DNS lookup causes no outbound connection", async () => {
  for (const loss of ["channel closed", "connection lost", null]) {
    const env = await setup();
    let answer!: (addresses: string[]) => void;
    const lookups: string[] = [];
    const proxy = harness({
      resolve: (host) => {
        lookups.push(host);
        return new Promise((resolve) => (answer = resolve));
      },
    });
    const t = await tunnelTo(env, { handle: proxy.handle });
    await until(() => t.names().includes("connected"));
    const channel = await forwarded(env);
    channel.write(CONNECT);
    await until(() => lookups.length === 1);

    if (loss === "channel closed") channel.close();
    if (loss === "connection lost") env.ssh.clients.forEach((c) => (c as unknown as { _sock: net.Socket })._sock.destroy());
    await sleep(100);
    answer([PUBLIC]);
    await sleep(100);

    // With the channel left open the same answer is dialled and logged, so the loss is what stopped it.
    const expected = loss === null ? { dials: 1, logs: [{ status: 200, host: "instagram.com" }] } : { dials: 0, logs: [] };
    expect({ loss, dials: proxy.dials.length, logs: proxy.logs }).toEqual({ loss, ...expected });
  }
});

test("[C86] a refusal the SSH peer never takes is closed once the head timeout has passed", async () => {
  const headTimeoutMs = 300;
  const env = await setup();
  const proxy = harness({ relayCap: 1, headTimeoutMs });
  const open = new Set<Duplex>();
  const t = await tunnelTo(env, {
    handle: (stream) => {
      open.add(stream);
      stream.once("close", () => open.delete(stream));
      proxy.handle(stream);
    },
  });
  await until(() => t.names().includes("connected"));

  // A peer that opens every channel with a send window of zero: nothing the home side writes can leave.
  const proto = (env.ssh.clients.at(-1) as unknown as { _protocol: { forwardedTcpip: (...args: any[]) => void } })._protocol;
  const announce = proto.forwardedTcpip.bind(proto);
  proto.forwardedTcpip = (id, _window, ...rest) => announce(id, 0, ...rest);
  const delivered: Buffer[] = [];
  const stalled = async (bytes: string) => {
    const channel = await forwarded(env);
    channel.on("data", (chunk: Buffer) => delivered.push(chunk));
    if (bytes) channel.write(bytes);
  };

  // The first channel takes the only slot and sends no head (408); the second is over the cap (503).
  const began = Date.now();
  await stalled("");
  await stalled("");
  await until(() => proxy.logs.length === 1);
  await sleep(headTimeoutMs / 3);
  expect(open.size).toBe(2);
  await until(() => open.size === 0, headTimeoutMs * 10, "both refused channels to close");
  expect(Date.now() - began).toBeLessThan(headTimeoutMs * 4);

  // The slot is free again; a refusal decided from the head (403) is bounded the same way.
  await stalled("CONNECT example.com:443 HTTP/1.1\r\n\r\n");
  await until(() => proxy.logs.length === 3);
  expect(open.size).toBe(1);
  await until(() => open.size === 0, headTimeoutMs * 10, "the refused channel to close");

  expect(proxy.logs.map((entry) => entry.status)).toEqual([503, 408, 403]);
  expect(Buffer.concat(delivered).length).toBe(0);
  expect(proxy.dials).toEqual([]);
});

test("[C90] on the tunnel's SSH channel, a relay ended by an upstream reset, an upstream close or the idle timeout frees its slot", async () => {
  const relayCap = 2;
  for (const ending of ["upstream reset", "upstream close", "idle timeout"]) {
    const origin = net.createServer((socket) => {
      socket.on("error", () => {});
      if (ending === "upstream reset") socket.write("bye", () => socket.resetAndDestroy());
      if (ending === "upstream close") socket.end("bye");
    });
    await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
    const originPort = (origin.address() as net.AddressInfo).port;
    const upstreams: net.Socket[] = [];

    const env = await setup({ open: true });
    const proxy = harness({
      relayCap,
      idleTimeoutMs: ending === "idle timeout" ? 150 : 60_000,
      dial: () =>
        new Promise((resolve, reject) => {
          const socket = net.connect(originPort, "127.0.0.1");
          upstreams.push(socket);
          socket.once("error", reject);
          socket.once("connect", () => resolve(socket));
        }),
    });
    const open = new Set<Duplex>();
    const t = await tunnelTo(env, {
      handle: (stream) => {
        open.add(stream);
        stream.once("close", () => open.delete(stream));
        proxy.handle(stream);
      },
    });
    await until(() => t.names().includes("connected"));

    try {
      // Twice the cap, one after the other: every relay has ended before the next one opens.
      for (let run = 0; run < relayCap * 2; run++) {
        let received = "";
        let closed = false;
        const socket = net.connect(env.remotePort, "127.0.0.1");
        socket.on("error", () => {});
        socket.on("data", (chunk) => (received += chunk.toString("latin1")));
        socket.on("close", () => (closed = true));
        socket.write(CONNECT);
        await until(() => closed, 10000, `relay ${run} to close after ${ending}`);
        expect([ending, run, received.split("\r\n")[0]]).toEqual([ending, run, OK]);
      }
      expect(proxy.logs.map((entry) => entry.status)).toEqual(Array(relayCap * 2).fill(200));
      // No channel is left waiting for a reader: each one reported its close.
      await until(() => open.size === 0, 5000, `every channel to close after ${ending}`);
    } finally {
      origin.close();
      upstreams.forEach((socket) => socket.destroy());
    }
  }
}, 60_000);

test("[C94] stop() after a host key mismatch leaves blocked/host_key_mismatch in state.json and status at exit 13", async () => {
  const env = await setup({}, (c) => (c.server.hostKey = "SHA256:" + "B".repeat(43)));
  const t = await tunnelTo(env);
  expect(await t.tunnel.done).toEqual({ state: "blocked", reason: "host_key_mismatch" });

  // What a SIGTERM delivered while `run` is on its way out does.
  await t.tunnel.stop();
  expect(t.names()).toEqual(["connecting", "blocked/host_key_mismatch"]);
  expect(readJson(env.statePath)).toMatchObject({ state: "blocked", reason: "host_key_mismatch" });
  const status = await cli(["status", "--json", "--config", env.path]);
  expect(status.code).toBe(13);
  expect(status.json()).toMatchObject({ state: "blocked", reason: "host_key_mismatch" });
});

test("[C95] since stays at the first refusal while a blocked port is retried, and retryAt moves on", async () => {
  const blockedRetryMs = 60;
  const env = await setup({ forward: () => false });
  const t = await tunnelTo(env, { blockedRetryMs });
  const blocked = () => t.states.filter((s) => s.state === "blocked");
  await until(() => blocked().length >= 3);

  const [first, second, third] = blocked();
  expect(Date.parse(first!.retryAt!) - Date.parse(first!.since)).toBe(blockedRetryMs);
  expect([second!.since, third!.since]).toEqual([first!.since, first!.since]);
  expect(Date.parse(second!.retryAt!)).toBeGreaterThan(Date.parse(first!.retryAt!));
  expect(Date.parse(third!.retryAt!)).toBeGreaterThan(Date.parse(second!.retryAt!));
  expect(Date.parse(third!.updatedAt)).toBeGreaterThan(Date.parse(first!.since));

  const status = await cli(["status", "--json", "--config", env.path]);
  expect(status.code).toBe(11);
  expect(status.json().since).toBe(first!.since);
});

test("[C98] on the tunnel's SSH channel, a connection that completes after the channel was lost is closed, logs no 200 and leaves the slot free", async () => {
  for (const loss of ["channel closed", "connection lost"]) {
    const env = await setup();
    let connected!: (remote: Duplex) => void;
    let dials = 0;
    const proxy = harness({
      relayCap: 1,
      dial: () => {
        dials++;
        return new Promise((resolve) => (connected = resolve));
      },
    });
    const t = await tunnelTo(env, { handle: proxy.handle });
    await until(() => t.names().includes("connected"));
    const channel = await forwarded(env);
    channel.write(CONNECT);
    await until(() => dials === 1);

    if (loss === "channel closed") channel.close();
    else env.ssh.clients.forEach((c) => (c as unknown as { _sock: net.Socket })._sock.destroy());
    await sleep(100);
    const [late] = pair();
    connected(late);
    await until(() => late.destroyed, 2000, `the late connection to be closed after ${loss}`);
    expect([loss, proxy.logs]).toEqual([loss, []]);

    // The only slot is free: the next channel (on the new connection, after a loss) is relayed.
    await until(() => t.names().at(-1) === "connected");
    const next = await forwarded(env);
    let received = "";
    next.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
    next.write(CONNECT);
    await until(() => dials === 2, 5000, `the next dial after ${loss}`);
    connected(pair()[0]);
    await until(() => received.includes("\r\n\r\n"));
    expect([loss, received]).toEqual([loss, `${OK}\r\n\r\n`]);
    expect(proxy.logs).toEqual([{ status: 200, host: "instagram.com" }]);
  }
});

test("[C101] a mismatched forwarded connection that ssh2 itself lets through is rejected by the tunnel's own filter", async () => {
  // ssh2 drops forwards it did not register, so the tunnel's filter is never reached through it.
  // Here ssh2 is made to register two forwards the tunnel never asked for, as a regression in that
  // check would: the server's announcements for them now reach the tunnel's handler.
  const forwardIn = Client.prototype.forwardIn;
  Client.prototype.forwardIn = function (this: Client, address: string, port: number, done) {
    return forwardIn.call(this, address, port, (err: Error | undefined, real: number) => {
      const registered = (this as unknown as { _forwarding: Record<string, number> })._forwarding;
      registered[`127.0.0.1:${port + 1}`] = port + 1;
      registered[`0.0.0.0:${port}`] = port;
      done?.(err, real);
    });
  } as typeof forwardIn;
  try {
    const env = await setup();
    const messages: string[] = [];
    const t = await tunnelTo(env, { log: (message) => void messages.push(message) });
    await until(() => t.names().includes("connected"));
    const rejections = () => messages.filter((m) => m === "rejected a forwarded connection for an unexpected address").length;

    expect(await env.ssh.announce("127.0.0.1", env.remotePort + 1)).toBe(false);
    expect(rejections()).toBe(1);
    expect(await env.ssh.announce("0.0.0.0", env.remotePort)).toBe(false);
    expect(rejections()).toBe(2);
    expect(t.handled.length).toBe(0);

    expect(await env.ssh.announce("127.0.0.1", env.remotePort)).toBe(true);
    await until(() => t.handled.length === 1);
    expect(rejections()).toBe(2);
  } finally {
    Client.prototype.forwardIn = forwardIn;
  }
});

test("[C102] a blocked port is retried against the server while state.json stays blocked/port_blocked", async () => {
  const env = await setup({ forward: () => false });
  const t = await tunnelTo(env, { blockedRetryMs: 60 });
  await until(() => env.ssh.requests.filter((r) => r.name === "tcpip-forward").length >= 3);
  await until(() => t.names().length >= 4);

  // Each retry opened a new SSH connection and asked again, and no write left the blocked state.
  expect(env.ssh.clients.length).toBeGreaterThanOrEqual(3);
  expect(t.names()[0]).toBe("connecting");
  expect([...new Set(t.names().slice(1))]).toEqual(["blocked/port_blocked"]);
});

test("[C103] stop() cancels the pending retry, and a retry that fires anyway opens no connection", async () => {
  const env = await setup({ forward: () => false });
  const pending: (() => void)[] = [];
  let cancelled = 0;
  const t = await tunnelTo(env, { schedule: (fn) => (pending.push(fn), () => cancelled++) });
  await until(() => t.names().includes("blocked/port_blocked"));
  expect([pending.length, cancelled]).toEqual([1, 0]);

  await t.tunnel.stop();
  expect(cancelled).toBe(1);
  expect(t.names()).toEqual(["connecting", "blocked/port_blocked", "stopped"]);

  pending[0]!();
  await sleep(150);
  expect(env.ssh.clients.length).toBe(1);
  expect(t.names().at(-1)).toBe("stopped");
});

test("[C106] a connection that authenticates but has its forward refused resets the backoff to 1 s", async () => {
  // Down for three attempts (1, 2, 4 s), then back with the port refused, then down again.
  const env = await setup({ forward: () => false });
  await env.ssh.close();

  const delays: number[] = [];
  let ssh: TestServer | undefined;
  const t = await tunnelTo(env, {
    backoffMs: undefined,
    schedule: (fn, ms) => {
      delays.push(ms);
      const go = async () => {
        if (delays.length === 3) {
          ssh = await startServer({ ...env.ssh.options, port: env.ssh.port, host: env.ssh.host });
          servers.push(ssh);
        }
        if (delays.length === 4) await ssh!.close();
        if (delays.length <= 4) fn();
      };
      void go();
      return () => {};
    },
  });
  await until(() => delays.length === 5);
  expect(t.names().filter((n) => n.startsWith("blocked"))).toEqual(["blocked/port_blocked"]);
  expect(delays).toEqual([1000, 2000, 4000, 30000, 1000]);
});

test("[C107] stop() while the SSH connection is still being made ends that connection without a forward request", async () => {
  const env = await setup();
  const t = await tunnelTo(env);
  await t.tunnel.stop();
  expect(t.names()).toEqual(["connecting", "stopped"]);

  // The connection that was under way finishes authenticating after the stop.
  await until(() => env.ssh.auth.includes("publickey"));
  await sleep(200);
  expect(env.ssh.requests).toEqual([]);
  expect(t.names()).toEqual(["connecting", "stopped"]);
  expect(readJson(env.statePath).state).toBe("stopped");
});

test("[C108] a connection that closes before the forward is answered is one connection loss with one retry", async () => {
  const env = await setup({ forward: () => "silent" });
  const delays: number[] = [];
  const t = await tunnelTo(env, { schedule: (_fn, ms) => (delays.push(ms), () => {}) });
  await until(() => env.ssh.requests.some((r) => r.name === "tcpip-forward"));
  env.ssh.dropAll();
  await until(() => t.names().includes("disconnected/connection_lost"));
  await sleep(200);

  expect(t.names()).toEqual(["connecting", "disconnected/connection_lost"]);
  expect(delays).toEqual([10]);
  expect(readJson(env.statePath)).toMatchObject({ state: "disconnected", reason: "connection_lost" });
});
