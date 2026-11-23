import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import net from "node:net";
import { createRequire } from "node:module";
import { Duplex } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { loadConfig } from "../src/config";
import { normalizeManagedDomain, parseManagedDomainSnapshot } from "../src/managed-domains";
import { createManagedProxy } from "../src/proxy";
import { startTunnel, type Tunnel } from "../src/tunnel";
import { until } from "./helpers";
import { harness, OK, pair, PUBLIC } from "./proxy-harness";
import { setup } from "./ssh-server";
import "./managed-domain-publisher-cases";
import "./managed-domain-observer-cases";

const OK_HEAD = `${OK}\r\n\r\n`;
const FORBIDDEN = "HTTP/1.1 403 Forbidden";

function snapshot(revision: number, domains: readonly string[]) {
  const result = parseManagedDomainSnapshot(revision, domains);
  if (!result.ok) throw new Error(result.code);
  return result.snapshot;
}

function request(client: Duplex, target: string, payload = "") {
  let received = "";
  let closed = false;
  client.on("error", () => {});
  client.on("data", (chunk: Buffer) => (received += chunk.toString("latin1")));
  client.once("close", () => (closed = true));
  client.write(`CONNECT ${target} HTTP/1.1\r\n\r\n${payload}`);
  return {
    client,
    closed: () => closed,
    text: () => received,
    status: async () => {
      await until(() => received.includes("\r\n\r\n") || closed, 3000, `response for ${target}`);
      return received.split("\r\n", 1)[0];
    },
  };
}

function local(proxy: { handle: (stream: Duplex) => void }, target: string) {
  const [client, channel] = pair();
  proxy.handle(channel);
  return request(client, target);
}

test("[domains C1] canonical public names, explicit PSL rules, and reserved proof names", () => {
  const max = `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.org`;
  for (const [host, want] of [
    ["WWW.Wikipedia.ORG.", "www.wikipedia.org"], ["tenant.github.io", "tenant.github.io"],
    ["www.ck", "www.ck"], ["shop.co.uk", "shop.co.uk"], [`${max}.`, max],
  ]) {
    expect([host, normalizeManagedDomain(host)]).toEqual([host, want]);
  }
  for (const host of [
    "com", "co.uk", "github.io", "cloudfront.net", "a.ck", "s3.amazonaws.com", "hostname.unlisted-suffix",
    "home.arpa", "printer.home.arpa", "NONCE.r1.PAC.INVALID.", "https://wikipedia.org", "wikipedia.org:443",
    "wikipedia.org/path", "wikipedia.org\n", "wikipedia.org..", "*.wikipedia.org", "a.-wiki.org",
    "a-.org", "K.org", "127.0.0.1", "0x7f000001", "[::1]", `${"a".repeat(64)}.org`, `a${max}`,
    max.replace(/\.org$/, "d.org"),
  ]) {
    expect([host, normalizeManagedDomain(host)]).toEqual([host, null]);
  }

  const entries = ["WWW.Wikipedia.ORG.", "mozilla.org"];
  const parsed = snapshot(1, entries);
  entries[0] = "unrelated.org";
  expect(parsed.domains).toEqual(["mozilla.org", "www.wikipedia.org"]);
  expect(parseManagedDomainSnapshot(1, ["Wikipedia.ORG.", "wikipedia.org"])).toEqual({ ok: false, code: "duplicate_domain" });
  const limit = Array.from({ length: 128 }, (_, i) => `site${i}.wikipedia.org`);
  expect(snapshot(1, limit).domains).toHaveLength(128);
  expect(parseManagedDomainSnapshot(1, [...limit, "mozilla.org"])).toEqual({ ok: false, code: "too_many_domains" });
  expect(parseManagedDomainSnapshot(Number.MAX_SAFE_INTEGER + 1, [])).toEqual({ ok: false, code: "invalid_revision" });
});

test("[domains C1] unmanaged matching stays unchanged; managed parents do not cross a private PSL cut", async () => {
  const legacy = harness({ domains: ["github.io"] });
  const legacyClient = legacy.connect("tenant.github.io:443");
  expect(await legacyClient.head()).toBe(OK_HEAD);
  legacyClient.client.destroy();

  const lookedUp: string[] = [];
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: async (host) => { lookedUp.push(host); return [PUBLIC]; },
    dial: async () => pair()[0],
  }, snapshot(0, ["amazonaws.com", "chosen.s3.amazonaws.com"]));
  for (const host of ["s3.amazonaws.com", "other.s3.amazonaws.com", "notamazonaws.com", "nonce.r1.pac.invalid"]) {
    expect(await local(proxy, `${host}:443`).status()).toBe(FORBIDDEN);
  }
  expect(lookedUp).toEqual([]);
  for (const host of ["www.amazonaws.com", "img.chosen.s3.amazonaws.com"]) {
    const client = local(proxy, `${host}:443`);
    expect(await client.status()).toBe(OK);
    client.client.destroy();
  }
});

test("[domains C4] local guard keeps CONNECT 443 and dials only the checked public IP after activation", async () => {
  const lookedUp: string[] = [];
  const dials: [string, number][] = [];
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: async (host) => {
      lookedUp.push(host);
      return host === "internal.wikipedia.org" ? ["127.0.0.1", "192.168.1.2", "fe80::1"] : ["10.0.0.1", PUBLIC];
    },
    dial: async (address, port) => { dials.push([address, port]); return pair()[0]; },
  }, snapshot(0, []));
  expect(await local(proxy, "www.wikipedia.org:443").status()).toBe(FORBIDDEN);
  expect(lookedUp).toEqual([]);
  const next = snapshot(1, ["wikipedia.org"]);
  expect(await proxy.activate(0, next)).toEqual({ ok: true, snapshot: next });
  expect(await local(proxy, "www.wikipedia.org:8443").status()).toBe(FORBIDDEN);
  expect(lookedUp).toEqual([]);
  expect(await local(proxy, "internal.wikipedia.org:443").status()).toBe(FORBIDDEN);
  expect(dials).toEqual([]);
  const client = local(proxy, "WWW.Wikipedia.ORG.:443");
  expect(await client.status()).toBe(OK);
  expect(lookedUp).toEqual(["internal.wikipedia.org", "www.wikipedia.org"]);
  expect(dials).toEqual([[PUBLIC, 443]]);
  client.client.destroy();
});

test("[domains C6] same SSH forward revokes DNS, late dials and live bytes before acknowledgement", async () => {
  const env = await setup({ open: true });
  const resolving = Promise.withResolvers<string[]>();
  const dialing = Promise.withResolvers<Duplex>();
  const lateDnsAddress = "1.1.1.1";
  const pendingAddress = "8.8.8.8";
  const removedAddress = "9.9.9.9";
  const coveredAddress = "8.8.4.4";
  let dnsSignal: AbortSignal | undefined;
  let dialSignal: AbortSignal | undefined;
  const dialed: string[] = [];
  const relays = new Map<string, { near: Duplex; far: Duplex; received: string }>();
  const clients: Duplex[] = [];
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: async (host, signal) => {
      if (host === "resolve.wikipedia.org") { dnsSignal = signal; return resolving.promise; }
      if (host === "dial.wikipedia.org") return [pendingAddress];
      if (host === "www.wikipedia.org") return [removedAddress];
      return [host === "addons.mozilla.org" ? coveredAddress : PUBLIC];
    },
    dial: async (address, _port, signal) => {
      dialed.push(address);
      if (address === pendingAddress) { dialSignal = signal; return dialing.promise; }
      const [near, far] = pair();
      const relay = { near, far, received: "" };
      far.on("data", (chunk: Buffer) => (relay.received += chunk.toString("latin1")));
      relays.set(address, relay);
      return near;
    },
  }, snapshot(0, ["wikipedia.org", "mozilla.org", "addons.mozilla.org"]));
  let connected = false;
  let tunnel: Tunnel | undefined;
  const open = (host: string, payload?: string) => {
    const socket = net.connect(env.remotePort, "127.0.0.1");
    clients.push(socket);
    return request(socket, `${host}:443`, payload);
  };
  const [late, latePeer] = pair();
  try {
    const loaded = loadConfig(env.path, readFileSync, () => env.dir);
    if (!loaded.ok) throw new Error(loaded.message);
    tunnel = startTunnel({
      config: loaded.config,
      key: readFileSync(env.keyPath),
      statePath: env.statePath,
      handle: proxy.handle,
      onState: ({ state }) => (connected = state === "connected"),
    });
    await until(() => connected, 3000, "the initial SSH forward");

    const removed = open("www.wikipedia.org", "before");
    const unchanged = open("www.mozilla.org");
    const covered = open("addons.mozilla.org");
    for (const client of [removed, unchanged, covered]) expect(await client.status()).toBe(OK);
    const removedRelay = relays.get(removedAddress)!;
    await until(() => removedRelay.received === "before");
    const resolvingClient = open("resolve.wikipedia.org", "must not dial");
    const dialingClient = open("dial.wikipedia.org", "must not relay");
    await until(() => !!dnsSignal && !!dialSignal);

    const next = snapshot(1, ["mozilla.org", "wikimedia.org"]);
    let ackAtClose: boolean | undefined;
    const applying = proxy.activate(0, next).then((result) => {
      ackAtClose = late.destroyed && removedRelay.near.destroyed;
      return result;
    });
    expect(dnsSignal?.aborted).toBe(true);
    expect(dialSignal?.aborted).toBe(true);
    expect(removedRelay.near.destroyed).toBe(true);
    removed.client.write("after");
    removedRelay.far.write("after");
    expect(await open("www.wikipedia.org").status()).toBe(FORBIDDEN);
    expect(await proxy.activate(1, snapshot(2, ["wikipedia.org"]))).toEqual({ ok: false, code: "conflict" });
    await until(() => removed.closed() && resolvingClient.closed() && dialingClient.closed(), 3000, "revoked channels to close");
    expect(ackAtClose).toBeUndefined();

    dialing.resolve(late);
    await until(() => late.destroyed);
    expect(ackAtClose).toBeUndefined();
    resolving.resolve([lateDnsAddress]);
    expect(await applying).toEqual({ ok: true, snapshot: next });
    expect(ackAtClose).toBe(true);
    expect(dialed).not.toContain(lateDnsAddress);
    expect(dialingClient.text()).toBe("");
    expect(resolvingClient.text()).toBe("");
    expect(removedRelay.received).toBe("before");
    expect(removed.text()).toBe(OK_HEAD);
    expect(await proxy.activate(0, snapshot(2, ["wikipedia.org"]))).toEqual({ ok: false, code: "conflict" });
    expect(await proxy.activate(1, snapshot(1, ["wikipedia.org"]))).toEqual({ ok: false, code: "invalid_revision" });

    for (const [client, address] of [[unchanged, PUBLIC], [covered, coveredAddress]] as const) {
      const relay = relays.get(address)!;
      client.client.write("kept request");
      relay.far.write("kept response");
      await until(() => relay.received === "kept request" && client.text() === `${OK_HEAD}kept response`);
      expect(client.closed()).toBe(false);
    }
    expect(await open("www.wikimedia.org").status()).toBe(OK);
    expect(await open("dial.wikipedia.org").status()).toBe(FORBIDDEN);
    const empty = snapshot(2, []);
    expect(await proxy.activate(1, empty)).toEqual({ ok: true, snapshot: empty });
    expect(await open("www.wikimedia.org").status()).toBe(FORBIDDEN);
    await until(() => unchanged.closed() && covered.closed());
    expect(env.ssh.clients).toHaveLength(1);
    expect(env.ssh.requests).toEqual([{ name: "tcpip-forward", bindAddr: "127.0.0.1", bindPort: env.remotePort }]);
  } finally {
    resolving.resolve([]);
    dialing.resolve(late);
    late.destroy();
    latePeer.destroy();
    for (const client of clients) client.destroy();
    for (const { near, far } of relays.values()) { near.destroy(); far.destroy(); }
    await tunnel?.stop();
    await env.ssh.close();
  }
}, 10000);

test("[domains C6] a timed-out managed dial remains a revocation obligation until settled", async () => {
  const dialing = Promise.withResolvers<Duplex>();
  const [late, peer] = pair();
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: async () => [PUBLIC],
    dial: () => dialing.promise,
    connectTimeoutMs: 40,
  }, snapshot(0, ["wikipedia.org"]));
  try {
    expect(await local(proxy, "wikipedia.org:443").status()).toBe("HTTP/1.1 504 Gateway Timeout");
    const empty = snapshot(1, []);
    let acknowledged = false;
    const applying = proxy.activate(0, empty).then((result) => { acknowledged = true; return result; });
    expect(await local(proxy, "wikipedia.org:443").status()).toBe(FORBIDDEN);
    expect(acknowledged).toBe(false);
    dialing.resolve(late);
    expect(await applying).toEqual({ ok: true, snapshot: empty });
    expect(late.destroyed).toBe(true);
  } finally {
    dialing.resolve(late);
    late.destroy();
    peer.destroy();
  }
});

// Use the pinned ssh2 Channel with an in-memory protocol sink, not an SSH connection.
type ChannelState = { id: number; state: string; window: number; packetSize: number };
interface OfflineChannel extends Duplex {
  incoming: ChannelState;
  outgoing: ChannelState;
  _waitWindow: boolean;
  _chunk?: Buffer;
  _chunkcb?: () => void;
}

function offlineChannel() {
  const require = createRequire(import.meta.url);
  const { Channel } = require("ssh2/lib/Channel.js") as { Channel: new (client: object, info: object) => OfflineChannel };
  const { onCHANNEL_CLOSE } = require("ssh2/lib/utils.js") as {
    onCHANNEL_CLOSE: (client: object, id: number, channel: OfflineChannel) => void;
  };
  let sent = "";
  let closes = 0;
  const client = {
    _chanMgr: { remove() {} },
    _protocol: {
      channelData(_id: number, bytes: Buffer) { sent += bytes.toString(); },
      channelClose() { closes++; },
      channelEOF() {},
      channelWindowAdjust() {},
    },
  };
  const channel = new Channel(client, {
    type: "forwarded-tcpip",
    incoming: { id: 1, state: "open", window: 65536, packetSize: 32768 },
    outgoing: { id: 2, state: "open", window: 65536, packetSize: 32768 },
  });
  return {
    channel,
    sent: () => sent,
    closes: () => closes,
    request: (payload = "") => channel.push(Buffer.from(`CONNECT wikipedia.org:443 HTTP/1.1\r\n\r\n${payload}`)),
    peerCloses: () => onCHANNEL_CLOSE(client, channel.incoming.id, channel),
    replenishWindow() {
      channel.outgoing.window += 65536;
      if (channel._waitWindow && channel._chunk && channel._chunkcb) {
        channel._waitWindow = false;
        channel._write(channel._chunk, "utf8", channel._chunkcb);
      }
    },
  };
}

function heldLocalSocket() {
  const closing = Promise.withResolvers<void>();
  const teardown = Promise.withResolvers<void>();
  let input = "";
  let closed = false;
  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, done) {
      input += chunk.toString();
      done();
    },
    destroy(err, done) {
      closing.resolve();
      void teardown.promise.then(() => done(err));
    },
  });
  socket.once("close", () => (closed = true));
  return { socket, closing: closing.promise, finish: teardown.resolve, input: () => input, closed: () => closed };
}

test("[domains C6] local lifecycle ACK waits for established socket teardown but not SSH peer CLOSE", async () => {
  const ssh = offlineChannel();
  const remote = heldLocalSocket();
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: async () => [PUBLIC],
    dial: async () => remote.socket,
    relayCap: 1,
  }, snapshot(0, ["wikipedia.org"]));
  const empty = snapshot(1, []);
  proxy.handle(ssh.channel);
  ssh.request("before");
  try {
    await until(() => ssh.sent() === OK_HEAD && remote.input() === "before");
    ssh.channel.outgoing.window = 0;
    remote.socket.push(Buffer.from("blocked"));
    await until(() => ssh.channel._waitWindow);

    let closedAtAck: boolean | undefined;
    const applying = proxy.activate(0, empty).then((ack) => { closedAtAck = remote.closed(); return ack; });
    await remote.closing;
    await nextTurn();
    expect(closedAtAck).toBeUndefined();
    expect(ssh.closes()).toBe(1);
    expect(ssh.channel.outgoing.state).toBe("closing");
    expect(await local(proxy, "wikipedia.org:443").status()).toBe("HTTP/1.1 503 Service Unavailable");
    ssh.channel.push(Buffer.from("after"));
    ssh.replenishWindow();

    remote.finish();
    expect(await applying).toEqual({ ok: true, snapshot: empty });
    expect(closedAtAck).toBe(true);
    expect(ssh.channel.incoming.state).toBe("open");
    expect(ssh.sent()).toBe(OK_HEAD);
    expect(remote.input()).toBe("before");
    expect(await local(proxy, "wikipedia.org:443").status()).toBe(FORBIDDEN);
  } finally {
    remote.finish();
    remote.socket.destroy();
    ssh.peerCloses();
  }
});

test("[domains C6] local lifecycle ACK waits for teardown of a dial that completes after revocation", async () => {
  const ssh = offlineChannel();
  const remote = heldLocalSocket();
  const dialing = Promise.withResolvers<Duplex>();
  const started = Promise.withResolvers<AbortSignal | undefined>();
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: async () => [PUBLIC],
    dial: (_address, _port, signal) => { started.resolve(signal); return dialing.promise; },
  }, snapshot(0, ["wikipedia.org"]));
  proxy.handle(ssh.channel);
  ssh.request("must not forward");
  try {
    const signal = await started.promise;
    const empty = snapshot(1, []);
    let closedAtAck: boolean | undefined;
    const applying = proxy.activate(0, empty).then((ack) => { closedAtAck = remote.closed(); return ack; });
    expect(signal?.aborted).toBe(true);
    dialing.resolve(remote.socket);
    await remote.closing;
    await nextTurn();
    expect(closedAtAck).toBeUndefined();
    remote.finish();
    expect(await applying).toEqual({ ok: true, snapshot: empty });
    expect(closedAtAck).toBe(true);
    expect(ssh.sent()).toBe("");
    expect(remote.input()).toBe("");
  } finally {
    dialing.resolve(remote.socket);
    remote.finish();
    remote.socket.destroy();
    ssh.peerCloses();
  }
});

test("[domains C6] local lifecycle uses one admission budget for a slow head and detached DNS", async () => {
  const resolving = Promise.withResolvers<string[]>();
  let lookups = 0;
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: () => ++lookups === 1 ? resolving.promise : Promise.resolve([PUBLIC]),
    dial: async () => pair()[0],
    relayCap: 2,
    connectTimeoutMs: 40,
  }, snapshot(0, ["wikipedia.org"]));
  const slow = offlineChannel();
  proxy.handle(slow.channel);
  slow.channel.push(Buffer.from("CONNE"));
  try {
    expect(await local(proxy, "wikipedia.org:443").status()).toBe("HTTP/1.1 504 Gateway Timeout");
    expect(await local(proxy, "wikipedia.org:443").status()).toBe("HTTP/1.1 503 Service Unavailable");
    expect(lookups).toBe(1);
    resolving.resolve([PUBLIC]);
    await nextTurn();
    const admitted = local(proxy, "wikipedia.org:443");
    try {
      expect(await admitted.status()).toBe(OK);
      expect(lookups).toBe(2);
    } finally { admitted.client.destroy(); }
  } finally {
    resolving.resolve([]);
    slow.peerCloses();
  }
});

test("[domains C6] local lifecycle releases a blocked relay once when both sides close", async () => {
  const ssh = offlineChannel();
  const [upstream, origin] = pair();
  let dials = 0;
  const proxy = createManagedProxy({
    interfaces: () => ({}),
    resolve: async () => [PUBLIC],
    dial: async () => ++dials === 1 ? upstream : pair()[0],
    relayCap: 1,
    idleTimeoutMs: 60000,
  }, snapshot(0, ["wikipedia.org"]));
  proxy.handle(ssh.channel);
  ssh.request();
  try {
    await until(() => ssh.sent() === OK_HEAD);
    ssh.channel.outgoing.window = 0;
    origin.write("blocked");
    await until(() => ssh.channel._waitWindow);
    upstream.destroy();
    await until(() => ssh.channel.writableEnded);
    expect(ssh.channel.writableFinished).toBe(false);
    ssh.peerCloses();
    await nextTurn();

    const admitted = local(proxy, "wikipedia.org:443");
    try {
      expect(await admitted.status()).toBe(OK);
      expect(await local(proxy, "wikipedia.org:443").status()).toBe("HTTP/1.1 503 Service Unavailable");
      expect(dials).toBe(2);
    } finally { admitted.client.destroy(); }
  } finally {
    upstream.destroy();
    origin.destroy();
    ssh.peerCloses();
  }
});
