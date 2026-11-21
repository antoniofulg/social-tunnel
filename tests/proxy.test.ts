import { expect, test } from "bun:test";
import { Duplex } from "node:stream";
import { DEFAULTS } from "../src/defaults";
import { sleep, until } from "./helpers";
import { harness, OK, PUBLIC } from "./proxy-harness";

test("[C8] CONNECT to an allowlisted host on 443 gets 200 and relays both ways", async () => {
  for (const target of ["instagram.com:443", "www.instagram.com:443", "WWW.Instagram.COM:443", "instagram.com.:443"]) {
    const h = harness();
    const channel = h.connect(target);
    expect(await channel.head()).toBe(`${OK}\r\n\r\n`);
    expect(h.dials.map((d) => [d.address, d.port])).toEqual([[PUBLIC, 443]]);

    channel.client.write("ping");
    await until(() => h.dials[0]!.received().toString() === "ping");
    h.dials[0]!.remote.write("pong");
    await until(() => channel.text() === `${OK}\r\n\r\npong`);
    expect(channel.ended()).toBe(false);
  }
});

test("[C9] CONNECT to a host off the allowlist gets 403 with no lookup and no connection", async () => {
  for (const target of ["evilinstagram.com:443", "instagram.com.evil.net:443", "example.org:443"]) {
    const h = harness();
    expect(await h.status(target)).toBe("HTTP/1.1 403 Forbidden");
    expect(h.lookups).toEqual([]);
    expect(h.dials).toEqual([]);
  }
});

test("[C10] CONNECT to a port other than 443 gets 403 with no lookup and no connection", async () => {
  for (const target of ["instagram.com:80", "instagram.com:8443"]) {
    const h = harness();
    expect(await h.status(target)).toBe("HTTP/1.1 403 Forbidden");
    expect(h.lookups).toEqual([]);
    expect(h.dials).toEqual([]);
  }
});

test("[C11] CONNECT to an IP literal gets 403 with no lookup and no connection", async () => {
  for (const target of ["157.240.1.1:443", "[2a03:2880::1]:443", "[::ffff:157.240.1.1]:443"]) {
    const h = harness();
    expect(await h.status(target)).toBe("HTTP/1.1 403 Forbidden");
    expect(h.lookups).toEqual([]);
    expect(h.dials).toEqual([]);
  }
});

test("[C14] an allowlisted host resolving only to private addresses gets 403 with no connection", async () => {
  const h = harness({}, { "instagram.com": ["192.168.1.1", "::1"] });
  expect(await h.status("instagram.com:443")).toBe("HTTP/1.1 403 Forbidden");
  expect(h.lookups).toEqual(["instagram.com"]);
  expect(h.dials).toEqual([]);
});

test("[C15] a host resolving to a private and a public address is dialled once, at the public address", async () => {
  const h = harness({}, { "instagram.com": ["10.0.0.1", PUBLIC] });
  expect(await h.connect("instagram.com:443").head()).toBe(`${OK}\r\n\r\n`);
  expect(h.lookups).toEqual(["instagram.com"]);
  expect(h.dials.map((d) => [d.address, d.port])).toEqual([[PUBLIC, 443]]);
});

test("[C16] a GET request gets 405 and the channel closes", async () => {
  const h = harness();
  const channel = h.open("GET http://instagram.com/ HTTP/1.1\r\nHost: instagram.com\r\n\r\n");
  expect((await channel.closed()).split("\r\n")[0]).toBe("HTTP/1.1 405 Method Not Allowed");
  expect(channel.ended()).toBe(true);
  expect(h.lookups).toEqual([]);
  expect(h.dials).toEqual([]);
});

test("[C17] a head over 8192 bytes gets 400 and an unfinished head gets 408", async () => {
  const line = "CONNECT instagram.com:443 HTTP/1.1\r\nX-Pad: ";
  const sized = (total: number) => line + "a".repeat(total - line.length - 4) + "\r\n\r\n";

  const fits = harness();
  expect(sized(8192).length).toBe(8192);
  expect(await fits.open(sized(8192)).head()).toBe(`${OK}\r\n\r\n`);

  const over = harness();
  expect((await over.open(sized(8193)).closed()).split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
  expect(over.lookups).toEqual([]);

  const endless = harness();
  const flood = endless.open(line + "a".repeat(9000));
  expect((await flood.closed()).split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");

  const slow = harness({ headTimeoutMs: 40 });
  const started = Date.now();
  const stalled = slow.open("CONNECT instagram.com:443 HTTP/1.1\r\n");
  expect((await stalled.closed()).split("\r\n")[0]).toBe("HTTP/1.1 408 Request Timeout");
  expect(Date.now() - started).toBeGreaterThanOrEqual(35);
  expect(slow.lookups).toEqual([]);
});

test("[C18] DNS and connect failures get 502, and timeouts get 504", async () => {
  const never = new Promise<never>(() => {});

  const empty = harness({}, { "instagram.com": [] });
  expect(await empty.status("instagram.com:443")).toBe("HTTP/1.1 502 Bad Gateway");
  expect(empty.dials).toEqual([]);

  const refused = harness({ dial: () => Promise.reject(new Error("ECONNREFUSED")) });
  expect(await refused.status("instagram.com:443")).toBe("HTTP/1.1 502 Bad Gateway");

  // What a real resolver does when a name does not exist: it rejects.
  const noSuchName = harness({ resolve: () => Promise.reject(new Error("getaddrinfo ENOTFOUND instagram.com")) });
  const answer = await noSuchName.connect("instagram.com:443").closed();
  expect(answer.split("\r\n")[0]).toBe("HTTP/1.1 502 Bad Gateway");
  expect(answer).not.toContain("ENOTFOUND");
  expect(noSuchName.dials).toEqual([]);

  const slowLookup = harness({ connectTimeoutMs: 40, resolve: () => never });
  expect(await slowLookup.status("instagram.com:443")).toBe("HTTP/1.1 504 Gateway Timeout");

  const slowDial = harness({ connectTimeoutMs: 40, dial: () => never });
  expect(await slowDial.status("instagram.com:443")).toBe("HTTP/1.1 504 Gateway Timeout");
});

test("[C19] with the default cap the 257th relay gets 503 until one closes", async () => {
  const h = harness();
  const channels = [];
  for (let i = 0; i < 256; i++) channels.push(h.connect("instagram.com:443"));
  for (const channel of channels) expect(await channel.head()).toBe(`${OK}\r\n\r\n`);

  expect(await h.status("instagram.com:443")).toBe("HTTP/1.1 503 Service Unavailable");
  expect(h.dials.length).toBe(256);

  channels[0]!.client.destroy();
  await until(() => h.dials[0]!.remote.destroyed);
  expect(await h.connect("instagram.com:443").head()).toBe(`${OK}\r\n\r\n`);
  expect(h.dials.length).toBe(257);
});

test("[C21] malformed hosts and ports get 400", async () => {
  const label63 = "a".repeat(63);
  const name253 = `${label63}.${label63}.${label63}.${"a".repeat(47)}.instagram.com`;
  expect(name253.length).toBe(253);
  const targets = [
    "insta_gram.com:443",
    "user@instagram.com:443",
    "insta%67ram.com:443",
    `${"a".repeat(64)}.instagram.com:443`,
    `a${name253}:443`,
    "instagram.com:+443",
    "instagram.com:0443",
    "instagram.com:443abc",
    "instagram.com:443 ",
  ];
  for (const target of targets) {
    const h = harness();
    expect([target, await h.status(target)]).toEqual([target, "HTTP/1.1 400 Bad Request"]);
    expect(h.lookups).toEqual([]);
    expect(h.dials).toEqual([]);
  }
  // The longest legal name is still accepted, so the bounds above are the bounds.
  expect(await harness().connect(`${name253}:443`).head()).toBe(`${OK}\r\n\r\n`);
});

test("[C22] bytes sent with the head reach upstream untouched and are never answered", async () => {
  const head = "CONNECT instagram.com:443 HTTP/1.1\r\nHost: instagram.com:443\r\n\r\n";
  const clientHello = Buffer.from([0x16, 0x03, 0x01, 0x00, 0x05, 0x01, 0x00, 0x00, 0x01, 0x00, 0x0d, 0x0a, 0x0d, 0x0a, 0xff]);
  const second = Buffer.from("CONNECT example.org:443 HTTP/1.1\r\nHost: example.org:443\r\n\r\n");

  for (const trailing of [clientHello, second]) {
    const h = harness();
    const channel = h.open(Buffer.concat([Buffer.from(head), trailing]));
    expect(await channel.head()).toBe(`${OK}\r\n\r\n`);
    await until(() => h.dials[0]!.received().length >= trailing.length);
    await sleep(20);
    expect(h.dials[0]!.received().equals(trailing)).toBe(true);
    expect(channel.text()).toBe(`${OK}\r\n\r\n`);
    expect(h.lookups).toEqual(["instagram.com"]);
    expect(h.dials.length).toBe(1);
  }
});

test("[C23] the 403 body is identical for every refusal reason and names no resolved address", async () => {
  const unlisted = await harness().connect("example.org:443").closed();
  const wrongPort = await harness().connect("instagram.com:80").closed();
  const privateOnly = await harness({}, { "instagram.com": ["192.168.1.1"] }).connect("instagram.com:443").closed();
  expect(unlisted.startsWith("HTTP/1.1 403 Forbidden\r\n")).toBe(true);
  expect(wrongPort).toBe(unlisted);
  expect(privateOnly).toBe(unlisted);

  const refused = harness({ dial: () => Promise.reject(new Error(`connect ECONNREFUSED ${PUBLIC}:443`)) });
  const timedOut = harness({ connectTimeoutMs: 40, dial: () => new Promise<never>(() => {}) });
  const responses = [
    privateOnly,
    await refused.connect("instagram.com:443").closed(),
    await timedOut.connect("instagram.com:443").closed(),
  ];
  for (const response of responses) {
    expect(response).not.toContain("192.168.1.1");
    expect(response).not.toContain(PUBLIC);
    expect(response).not.toContain("ECONNREFUSED");
  }
});

test("[C24] a relay idle past the idle timeout closes both sides", async () => {
  const h = harness({ idleTimeoutMs: 60 });
  const channel = h.connect("instagram.com:443");
  expect(await channel.head()).toBe(`${OK}\r\n\r\n`);
  const started = Date.now();
  expect(channel.ended()).toBe(false);
  await until(() => channel.ended() && h.dials[0]!.remote.destroyed, 2000, "both sides to close");
  expect(Date.now() - started).toBeGreaterThanOrEqual(50);

  // Traffic in either direction keeps a relay open well past the timeout; silence then closes it.
  const idleTimeoutMs = 300;
  const busy = harness({ idleTimeoutMs });
  const live = busy.connect("instagram.com:443");
  expect(await live.head()).toBe(`${OK}\r\n\r\n`);
  const begun = Date.now();
  for (let i = 0; Date.now() - begun < idleTimeoutMs * 3; i++) {
    if (i % 2 === 0) live.client.write("a");
    else busy.dials[0]!.remote.write("b");
    await sleep(40);
  }
  expect(live.ended()).toBe(false);
  expect(busy.dials[0]!.remote.destroyed).toBe(false);
  await until(() => live.ended() && busy.dials[0]!.remote.destroyed, 5000, "the quiet relay to close");
});

test("[C63] the shipped defaults match the plan", () => {
  expect(DEFAULTS.headTimeoutMs).toBe(10000);
  expect(DEFAULTS.connectTimeoutMs).toBe(10000);
  expect(DEFAULTS.idleTimeoutMs).toBe(300000);
  expect(DEFAULTS.relayCap).toBe(256);
  expect(DEFAULTS.keepaliveIntervalMs).toBe(15000);
  expect(DEFAULTS.keepaliveCountMax).toBe(3);
  expect(DEFAULTS.heartbeatMs).toBe(30000);
  expect(DEFAULTS.staleMs).toBe(90000);
});

test("[C65] the proxy refuses a host that resolves only into a local interface prefix", async () => {
  const answers = { "instagram.com": ["2a03:2880:1:2::99", "203.0.113.200"] };
  const interfaces = () => ({ en0: [{ cidr: "2a03:2880:1:2:aaaa:bbbb:cccc:dddd/64" }, { cidr: "203.0.113.7/24" }] });

  const home = harness({ interfaces }, answers);
  expect(await home.status("instagram.com:443")).toBe("HTTP/1.1 403 Forbidden");
  expect(home.lookups).toEqual(["instagram.com"]);
  expect(home.dials).toEqual([]);

  // The same public addresses are dialled from a machine that is not on those networks.
  const elsewhere = harness({ interfaces: () => ({}) }, answers);
  expect(await elsewhere.connect("instagram.com:443").head()).toBe(`${OK}\r\n\r\n`);
  expect(elsewhere.dials.map((d) => [d.address, d.port])).toEqual([["2a03:2880:1:2::99", 443]]);
});

test("[C69] channels still sending their head count against the relay cap", async () => {
  const h = harness();
  const waiting = [];
  for (let i = 0; i < 256; i++) waiting.push(h.open("CONNECT instagram.com:443 HTTP/1.1\r\n"));

  expect(await h.status("instagram.com:443")).toBe("HTTP/1.1 503 Service Unavailable");
  expect(h.lookups).toEqual([]);
  expect(waiting.every((channel) => !channel.ended())).toBe(true);

  waiting[0]!.client.destroy();
  await sleep(20);
  expect(await h.connect("instagram.com:443").head()).toBe(`${OK}\r\n\r\n`);
  expect(await h.status("instagram.com:443")).toBe("HTTP/1.1 503 Service Unavailable");
});

// An upstream whose writes complete one at a time, `delayMs` apart (never, when null). Everything
// it has taken is in `taken`; what the proxy handed over but it has not taken yet sits in its queue.
function slowUpstream(delayMs: number | null) {
  const taken: Buffer[] = [];
  const upstream = new Duplex({
    writableHighWaterMark: 16 * 1024 * 1024,
    read() {},
    write(chunk, _encoding, done) {
      taken.push(chunk);
      if (delayMs !== null) setTimeout(done, delayMs);
    },
  });
  return { upstream, size: () => taken.reduce((n, c) => n + c.length, 0) };
}

test("[C79] bytes already handed to a slow upstream are delivered after the client closes first", async () => {
  const slow = slowUpstream(2);
  const h = harness({ dial: async () => slow.upstream });
  const channel = h.connect("instagram.com:443");
  expect(await channel.head()).toBe(`${OK}\r\n\r\n`);

  const chunks = 200;
  for (let i = 0; i < chunks; i++) channel.client.write(Buffer.alloc(1024, i));
  // The proxy has passed everything on; the upstream has taken only the first few chunks.
  await until(() => slow.upstream.writableLength === chunks * 1024);
  expect(slow.size()).toBeLessThan(20 * 1024);

  channel.client.destroy();
  await until(() => slow.upstream.destroyed, 5000, "upstream to close");
  expect(slow.size()).toBe(chunks * 1024);
  expect(slow.upstream.writableFinished).toBe(true);
});

test("[C80] a flush that cannot finish is cut off by the idle timeout, even while upstream keeps sending", async () => {
  const idleTimeoutMs = 300;
  const stalled = slowUpstream(null);
  const h = harness({ idleTimeoutMs, dial: async () => stalled.upstream });
  const channel = h.connect("instagram.com:443");
  expect(await channel.head()).toBe(`${OK}\r\n\r\n`);
  channel.client.write(Buffer.alloc(64 * 1024));
  await until(() => stalled.upstream.writableLength === 64 * 1024);

  channel.client.destroy();
  const closedAt = Date.now();
  // Upstream keeps talking; with the client gone that must not keep the relay alive.
  const chatter = setInterval(() => stalled.upstream.push("x"), 20);
  try {
    await sleep(idleTimeoutMs / 3);
    expect(stalled.upstream.destroyed).toBe(false);
    await until(() => stalled.upstream.destroyed, idleTimeoutMs * 5, "the idle timeout to end the flush");
    expect(Date.now() - closedAt).toBeLessThan(idleTimeoutMs * 3);
  } finally {
    clearInterval(chatter);
  }
});

test("[C81] a channel that closes during the DNS lookup causes no outbound connection", async () => {
  let answer!: (addresses: string[]) => void;
  const lookups: string[] = [];
  const h = harness({
    resolve: (host) => {
      lookups.push(host);
      return new Promise((resolve) => (answer = resolve));
    },
  });
  const channel = h.connect("instagram.com:443");
  await until(() => lookups.length === 1);

  channel.client.destroy();
  await sleep(30);
  answer([PUBLIC]);
  await sleep(30);
  expect(h.dials).toEqual([]);

  // The same lookup answered while the channel is open does dial, so the close is what stopped it.
  const open = h.connect("instagram.com:443");
  await until(() => lookups.length === 2);
  answer([PUBLIC]);
  expect(await open.head()).toBe(`${OK}\r\n\r\n`);
  expect(h.dials.length).toBe(1);
});

test("[C82] traffic in one direction alone keeps a relay open past the idle timeout", async () => {
  const idleTimeoutMs = 300;
  for (const direction of ["client to upstream", "upstream to client"]) {
    const h = harness({ idleTimeoutMs });
    const channel = h.connect("instagram.com:443");
    expect(await channel.head()).toBe(`${OK}\r\n\r\n`);
    const remote = h.dials[0]!.remote;

    const begun = Date.now();
    while (Date.now() - begun < idleTimeoutMs * 3) {
      if (direction === "client to upstream") channel.client.write("a");
      else remote.write("b");
      await sleep(40);
    }
    expect([direction, channel.ended(), remote.destroyed]).toEqual([direction, false, false]);
    await until(() => channel.ended() && remote.destroyed, 5000, "the quiet relay to close");
  }
});
