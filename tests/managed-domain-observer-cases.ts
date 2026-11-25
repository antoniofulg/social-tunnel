import { expect, test } from "bun:test";
import { once } from "node:events";
import { request } from "node:http";
import { createConnection, createServer } from "node:net";
import { PassThrough } from "node:stream";
import { DIRECT_WITNESS_MAPPING, listenDirectWitness, type DirectWitness } from "../server/domain-direct-witness";
import { createDomainCohort, createDomainObserver, type EnrolledChrome } from "../server/domain-observer";
import { createForwardAttestation } from "../server/forward-attestation";
import { createDomainRecovery } from "../server/domain-recovery";
import { renderDomainPolicy } from "../src/domain-policy";
import { parseManagedDomainSnapshot } from "../src/managed-domains";
import { createManagedProxy, withTimeout } from "../src/proxy";

const policy = { epoch: 1, revision: 12, routes: ["wikipedia.org"] };
const bytes = renderDomainPolicy(8888, policy);
const settings = { uid: 41116, gid: 41116, mapping: DIRECT_WITNESS_MAPPING } as const;
const loopback = "127.0.0.1";
const host = `${"a".repeat(32)}.e0.r12.pac.invalid`;
const path = `/${"b".repeat(32)}`;
const wrongPath = `/${"c".repeat(32)}`;

function visit(url: URL, overrides: { host?: string; path?: string; port?: number } = {}) {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const req = request({ hostname: loopback, port: overrides.port ?? url.port, path: overrides.path ?? url.pathname,
    headers: { Host: overrides.host ?? url.host }, agent: false }, (res) => {
    let body = "";
    res.on("data", (data) => { body += data; });
    res.on("end", () => resolve(res.statusCode === 200 ? body : null));
    res.on("error", () => resolve(null));
  });
  req.on("error", () => resolve(null));
  req.setTimeout(1000, () => req.destroy());
  req.end();
  return promise;
}

test("[domains C8] the direct sink grants one exact local origin GET and rejects wrong host, nonce and replay", async () => {
  const sink = await listenDirectWitness(host, path);
  const url = new URL(`http://${host}:${sink.port}${path}`);
  try {
    expect(await visit(url, { host: `wrong.pac.invalid:${sink.port}` })).toBeNull();
    expect(await visit(url, { path: wrongPath })).toBeNull();
    const receipt = await visit(url);
    expect(receipt).toMatch(/^[0-9a-f]{32}$/);
    expect(await sink.seen).toBe(receipt);
    expect(await visit(url)).toBeNull();
  } finally { sink.close(); }
  const expired = await listenDirectWitness(host, path, 10);
  expect(await expired.seen).toBeNull();
  expect(await visit(url, { port: expired.port })).toBeNull();
});

type Fault = "late_policy" | "expired" | "wrong_context" | "late_context" | "old_receipt" | "wrong_sink" | "late_connect" | "not_enrolled";

function cdpFixture(fault?: Fault, oldReceipt?: string, name = "fixture") {
  const input = new PassThrough();
  const output = new PassThrough();
  const expected = JSON.parse(bytes).ProxySettings;
  const { promise: navigated, resolve: negativeNavigation } = Promise.withResolvers<{ url: URL; sink: DirectWitness }>();
  let sink: DirectWitness;
  let body: string | null = null;
  let now = 0;
  let generation = 1;
  let targets = 0;
  let reads = 0;
  let visits = 0;
  input.on("data", (data: Buffer) => void (async () => {
    const { id, method, params, sessionId } = JSON.parse(data.toString().slice(0, -1));
    let result: object;
    let negative: URL | undefined;
    if (method === "Target.createTarget") result = { targetId: `target-${++targets}` };
    else if (method === "Target.getTargetInfo") {
      const wrong = params.targetId === "target-2" && (fault === "wrong_context" || (fault === "late_context" && visits === 2));
      result = { targetInfo: { targetId: params.targetId, type: "page", browserContextId: wrong ? "sibling" : "enrolled" } };
    } else if (method === "Target.attachToTarget") result = { sessionId: `session-${params.targetId}` };
    else if (method === "Target.closeTarget") result = { success: true };
    else if (method === "Page.navigate") {
      if (params.url.startsWith("chrome:")) result = {};
      else if (++visits === 1) result = { errorText: "net::ERR_TUNNEL_CONNECTION_FAILED" };
      else {
        negative = new URL(params.url);
        if (fault === "wrong_sink") {
          const other = await listenDirectWitness(negative.hostname, negative.pathname);
          try { body = await visit(negative, { port: other.port, host: `${negative.hostname}:${other.port}` }); }
          finally { other.close(); sink.close(); }
        } else if (fault !== "late_connect") {
          body = await visit(negative);
          if (fault === "old_receipt") body = oldReceipt ?? null;
        }
        if (fault === "expired") now = 31000;
        result = {}; // Even simulated navigation success earns nothing without exact sink evidence.
      }
    } else if (method === "Runtime.evaluate") {
      if (params.awaitPromise) result = { result: { value: body } };
      else if (!params.expression.includes("const matches = rows")) result = { result: { value: true } };
      else {
        reads++;
        const value = fault === "late_policy" && visits === 2 ? { ...expected, ProxyPacMandatory: false } : expected;
        result = { result: { value: { valid: true, disabled: false, value } } };
      }
    } else throw new Error("unexpected proof command");
    output.write(JSON.stringify({ id, sessionId, result }) + "\0");
    if (negative) negativeNavigation({ url: negative, sink });
  })().catch(() => output.end()));
  const chrome: EnrolledChrome = { generation: name, input, output, ownership: () => generation,
    directWitness: fault === "not_enrolled" ? undefined : settings,
  };
  const directOrigin: Parameters<typeof createDomainObserver>[2] = async (_enrollment, host, challenge) =>
    sink = await listenDirectWitness(host, challenge);
  const observer = createDomainObserver(chrome, () => now, directOrigin);
  const watch = () => ({ positiveSeen: async () => true, valid: () => true, close() {} });
  return {
    observer, watch, reads: () => reads, visits: () => visits, navigated, receipt: () => body,
    chrome,
    nextOwnership() { generation++; }, close() { sink?.close(); input.end(); output.end(); },
  };
}

test("[domains C11] a silent CDP pipe is fenced and requests recovery only with a responding home proxy", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const offline = { responsive: false, routed: false, browser: false };
  const online = { ...offline, responsive: true };
  const decision = createDomainRecovery(() => {});
  const restarts: (string | undefined)[] = [];
  const observer = createDomainObserver({
    generation: "silent", input, output, ownership: () => 1, directWitness: settings,
    onObserverFailure(reason) {
      restarts.push(decision(offline, 1, reason), decision(null, 1, reason), decision(online, 1, reason));
    },
  });
  try {
    expect(await observer.prove(policy, bytes, () => { throw new Error("silent Chrome must not certify a route"); },
      () => { throw new Error("silent Chrome must not reach the witness"); })).toBeNull();
    expect(observer.alive()).toBe(false);
    expect(restarts).toEqual([undefined, undefined, "cdp_timeout"]);
  } finally { input.destroy(); output.destroy(); }
}, 8000);

test("[domains C11] only sustained proof loss on the same responding forward requests a restart", () => {
  let now = 0;
  const warnings: string[] = [];
  const decision = createDomainRecovery((reason) => warnings.push(reason), () => now);
  const online = { responsive: true, routed: false, browser: false };
  expect(decision(online, 1)).toBeUndefined();
  now = 60_000;
  expect(decision(online, 2)).toBeUndefined();
  now += 59_999;
  expect(decision({ ...online, routed: true }, 2)).toBeUndefined();
  now += 1;
  expect(decision(online, 2)).toBe("forward_receipt_unproven");
  expect(decision(null, 2)).toBeUndefined();
  expect(decision(online, 2)).toBeUndefined();
  const offline = { ...online, responsive: false };
  expect(decision(offline, 2)).toBeUndefined();
  now += 60_000;
  expect(decision(offline, 2)).toBeUndefined();
  expect(decision(offline, 2)).toBeUndefined();
  expect(warnings).toEqual(["forward_unreachable"]);
  const browserStale = { ...online, routed: true };
  expect(decision(browserStale, 2)).toBeUndefined();
  now += 60_000;
  expect(decision(browserStale, 2)).toBe("browser_proof_stale");
  expect(decision({ ...browserStale, browser: true }, 2)).toBeUndefined();
  expect(decision(browserStale, 2)).toBeUndefined();
});

test("[domains C11] a responding transport in recovery mode does not grant proof even with an authenticated receipt", async () => {
  const identity = { enrollment: "proof", epoch: 1, generation: "proxy" };
  const revision = { revision: 2, domainsDigest: "a".repeat(64) };
  let owner = 1;
  const server = createServer((socket) => socket.once("data", (data) => {
    const host = data.toString().split(" ")[1]!.split(":")[0]!;
    attestation.attest(identity, { ...identity, ...revision, host });
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }));
  await once(server.listen(0, loopback), "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const attestation = createForwardAttestation(identity.enrollment, address.port, () => owner);
  try {
    expect(await attestation.refresh(identity, false)).toBe(false);
    expect(attestation.responsive(identity)).toBe(true);
    expect(attestation.current(identity)).toBeNull();
    expect(attestation.freshFor(identity)).toBe(0);
    expect(await attestation.refresh(identity)).toBe(true);
    expect(attestation.current(identity)).toEqual({ generation: identity.generation, ...revision });
    owner++;
    expect(attestation.responsive(identity)).toBe(false);
  } finally { await once(server.close(), "close"); }
});

test("[domains C11] affirmative visits need current policy, exact browser context, fresh sink receipt and provisioned source", async () => {
  let priorReceipt: string | null = null;
  for (const fault of [undefined, "late_policy", "expired", "wrong_context", "late_context", "old_receipt", "wrong_sink", "not_enrolled"] as const) {
    const f = cdpFixture(fault, priorReceipt ?? undefined);
    let accepted = 0;
    try {
      const proof = await f.observer.prove(policy, bytes, () => { accepted++; return true; }, f.watch);
      expect(accepted).toBe(fault ? 0 : 1);
      if (fault) {
        expect(proof).toBeNull();
        if (fault === "not_enrolled") expect(f.visits()).toBe(0);
        if (fault === "late_policy" || fault === "expired") expect(f.reads()).toBe(2);
      } else {
        priorReceipt = f.receipt();
        expect(priorReceipt).toMatch(/^[0-9a-f]{32}$/);
        expect(f.visits()).toBe(2);
        expect(f.reads()).toBe(2);
        expect(f.observer.valid(proof!)).toBe(true);
        f.nextOwnership();
        expect(f.observer.valid(proof!)).toBe(false);
      }
    } finally { f.close(); }
  }
});

test("[domains C11] a cohort needs current evidence from every distinct protected Chrome", async () => {
  const a = cdpFixture(undefined, undefined, "first");
  const b = cdpFixture(undefined, undefined, "second");
  const directSinks: DirectWitness[] = [];
  let roster: readonly EnrolledChrome[] = [];
  let version = 0;
  const cohort = createDomainCohort(() => ({ version, browsers: roster }), () => 0, async (_enrollment, host, challenge) => {
    const sink = await listenDirectWitness(host, challenge);
    directSinks.push(sink);
    return sink;
  });
  const accepted = () => { throw new Error("incomplete cohort must not reach finalization"); };
  try {
    expect(await cohort.prove(policy, bytes, accepted, a.watch)).toBeNull();
    version++;
    roster = [a.chrome, { ...a.chrome, generation: "alias" }];
    expect(await cohort.prove(policy, bytes, accepted, a.watch)).toBeNull();
    version++;
    roster = [a.chrome, b.chrome];
    const nonces = new Set<string>();
    const proof = await cohort.prove(policy, bytes, () => true, nonce => {
      nonces.add(nonce);
      return a.watch();
    });
    expect(proof).not.toBeNull();
    if (!proof) return;
    expect(nonces.size).toBe(2);
    expect([a.visits(), b.visits()]).toEqual([2, 2]);
    expect(cohort.valid(proof)).toBe(true);
    roster = [a.chrome];
    version++;
    expect(cohort.valid(proof)).toBe(false);
    roster = [a.chrome, b.chrome];
    version++;
    expect(cohort.valid(proof)).toBe(false);
    version -= 2;
    expect(cohort.valid(proof)).toBe(false);
  } finally {
    for (const sink of directSinks) sink.close();
    a.close();
    b.close();
  }
});

test("[domains C11] one stale Chrome prevents committing the whole cohort", async () => {
  const a = cdpFixture(undefined, undefined, "first");
  const b = cdpFixture("late_policy", undefined, "second");
  const directSinks: DirectWitness[] = [];
  const cohort = createDomainCohort(() => ({ version: 0, browsers: [a.chrome, b.chrome] }), () => 0, async (_enrollment, host, challenge) => {
    const sink = await listenDirectWitness(host, challenge);
    directSinks.push(sink);
    return sink;
  });
  try {
    let accepted = false;
    expect(await cohort.prove(policy, bytes, () => { accepted = true; return true; }, a.watch)).toBeNull();
    expect(accepted).toBe(false);
    expect([a.visits(), b.visits()]).toEqual([2, 2]);
  } finally {
    for (const sink of directSinks) sink.close();
    a.close();
    b.close();
  }
});

test("[domains C11] transient roster loss while probing fences that version", async () => {
  const a = cdpFixture(undefined, undefined, "first");
  const b = cdpFixture(undefined, undefined, "second");
  const list = { version: 1, browsers: [a.chrome, b.chrome] };
  let available = true;
  let challenges = 0;
  let readsBeforeSecondChallenge = 0;
  const cohort = createDomainCohort(() => available ? list : null, () => 0,
    (_enrollment, host, challenge) => listenDirectWitness(host, challenge));
  try {
    let accepted = false;
    const proof = await cohort.prove(policy, bytes, () => { accepted = true; return true; }, () => {
      if (++challenges === 1) {
        available = false;
        cohort.alive();
        available = true;
      } else readsBeforeSecondChallenge = a.reads();
      return a.watch();
    });
    expect(proof).toBeNull();
    expect(accepted).toBe(false);
    expect(cohort.alive()).toBe(false);
    expect(challenges).toBe(2);
    expect(readsBeforeSecondChallenge).toBe(2);
  } finally { a.close(); b.close(); }
});

test("[domains C8] a wrong CONNECT entering home after the browser reports navigation cannot certify a direct route", async () => {
  const identity = { enrollment: "fixture", epoch: 1, generation: "proxy" };
  const revision = { generation: identity.generation, revision: 12, domainsDigest: "a".repeat(64) };
  const snapshot = parseManagedDomainSnapshot(12, policy.routes);
  if (!snapshot.ok) throw new Error("invalid fixture snapshot");
  let lateReceipt: boolean | undefined;
  let resolveCount = 0;
  const proxy = createManagedProxy({
    resolve: async () => { resolveCount++; return []; },
    dial: async () => { throw new Error("unexpected upstream"); },
    log: ({ status, host }) => { if (status === 403 && host) lateReceipt = attestation.attest(identity, { ...identity, ...revision, host }); },
  }, snapshot.snapshot);
  const server = createServer(proxy.handle);
  await new Promise<void>((resolve) => server.listen(0, loopback, resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const attestation = createForwardAttestation(identity.enrollment, address.port, () => 1);
  const f = cdpFixture("late_connect");
  let finalized = false;
  try {
    const proof = f.observer.prove(policy, bytes, () => (finalized = true), (positive) => {
      const watch = attestation.watch(positive, identity, revision);
      expect(attestation.attest(identity, { ...identity, ...revision, host: positive })).toBe(true);
      return watch;
    });
    const { url, sink } = await withTimeout(f.navigated, 1500);
    // Only now does the late forwarded request enter the actual home proxy, not the outbox.
    const socket = createConnection({ host: loopback, port: address.port });
    socket.setTimeout(1000, () => socket.destroy());
    let reply = "";
    try {
      socket.write(`CONNECT ${url.hostname}:${url.port} HTTP/1.1\r\n\r\n`);
      for await (const data of socket) reply += data.toString("latin1");
    } finally { socket.destroy(); }
    expect(reply).toStartWith("HTTP/1.1 403 Forbidden");
    expect(lateReceipt).toBe(false);
    expect(resolveCount).toBe(0);
    expect(finalized).toBe(false);
    sink.close();
    expect(await proof).toBeNull();
    expect(finalized).toBe(false);
  } finally {
    f.close();
    attestation.fence();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
