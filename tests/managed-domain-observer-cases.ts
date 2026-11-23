import { expect, test } from "bun:test";
import { request } from "node:http";
import { createConnection, createServer } from "node:net";
import { PassThrough } from "node:stream";
import { DIRECT_WITNESS_MAPPING, listenDirectWitness, type DirectWitness } from "../server/domain-direct-witness";
import { createDomainObserver } from "../server/domain-observer";
import { createForwardAttestation } from "../server/forward-attestation";
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

function cdpFixture(fault?: Fault, oldReceipt?: string) {
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
  const observer = createDomainObserver({ generation: "fixture", input, output, ownership: () => generation,
    directWitness: fault === "not_enrolled" ? undefined : settings,
  }, () => now, async (_enrollment, name, challenge) => sink = await listenDirectWitness(name, challenge));
  const watch = () => ({ positiveSeen: async () => true, valid: () => true, close() {} });
  return {
    observer, watch, reads: () => reads, visits: () => visits, navigated, receipt: () => body,
    nextOwnership() { generation++; }, close() { sink?.close(); input.end(); output.end(); },
  };
}

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
