import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createServer } from "node:net";
import { createDomainObserver, type EnrolledChrome } from "../server/domain-observer";
import { createForwardAttestation } from "../server/forward-attestation";
import { createProofOutbox } from "../src/domain-proof-outbox";
import type { DomainAttestation } from "../src/domain-wire";
import { renderDomainPolicy } from "../src/domain-policy";

const policy = { epoch: 1, revision: 12, routes: ["wikipedia.org"] };
const bytes = renderDomainPolicy(8888, policy);

function cdpFixture(fault: "late_policy" | "expired" | null, watch?: EnrolledChrome["watchCanaries"]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const expected = JSON.parse(bytes).ProxySettings;
  let now = 0;
  let generation = 1;
  let reads = 0;
  let visits = 0;
  input.on("data", (data: Buffer) => {
    const { id, method, params } = JSON.parse(data.toString().slice(0, -1));
    let result: object;
    if (method === "Target.createTarget") result = { targetId: `t${id}` };
    else if (method === "Target.getTargetInfo") result = { targetInfo: { type: "page", browserContextId: "enrolled" } };
    else if (method === "Target.attachToTarget") result = { sessionId: `s${id}` };
    else if (method === "Target.closeTarget") result = { success: true };
    else if (method === "Page.navigate") {
      if (params.url.startsWith("chrome:")) result = {};
      else {
        visits++;
        if (fault === "expired" && visits === 2) now = 31000;
        result = { errorText: visits === 1 ? "net::ERR_TUNNEL_CONNECTION_FAILED" : "net::ERR_NAME_NOT_RESOLVED" };
      }
    } else if (method === "Runtime.evaluate") {
      if (!params.expression.includes("const matches = rows")) result = { result: { value: true } };
      else {
        reads++;
        const value = fault === "late_policy" && visits === 2 ? { ...expected, ProxyPacMandatory: false } : expected;
        result = { result: { value: { valid: true, disabled: false, value } } };
      }
    } else throw new Error("unexpected proof command");
    output.write(JSON.stringify({ id, result }) + "\0");
  });
  const observer = createDomainObserver({ generation: "fixture", input, output, ownership: () => generation,
    watchCanaries: watch ?? (() => ({ positiveSeen: () => true, negativeClear: () => true, valid: () => true, close() {} })),
  }, () => now);
  return {
    observer, reads: () => reads, visits: () => visits,
    nextOwnership() { generation++; }, close() { input.end(); output.end(); },
  };
}

test("[domains C11] paired browser visits do not commit after effective policy drift or proof expiry", async () => {
  for (const fault of ["late_policy", "expired", null] as const) {
    const f = cdpFixture(fault);
    let accepted = 0;
    try {
      const proof = await f.observer.prove(policy, bytes, () => { accepted++; return true; });
      expect(f.visits()).toBe(2);
      expect(f.reads()).toBe(2);
      expect(accepted).toBe(fault ? 0 : 1);
      if (fault) expect(proof).toBeNull();
      else {
        expect(f.observer.valid(proof!)).toBe(true);
        f.nextOwnership();
        expect(f.observer.valid(proof!)).toBe(false);
      }
    } finally { f.close(); }
  }
});

test("[domains C8] delayed wrong-canary evidence drains ahead of the marker and prevents finalization", async () => {
  const scope = { epoch: 1, generation: "managed" };
  const identity = { enrollment: "fixture", ...scope };
  const proxy = { generation: scope.generation, revision: 12, domainsDigest: "a".repeat(64) };
  const release = Promise.withResolvers<void>();
  const markerReached = Promise.withResolvers<void>();
  let negative = "";
  let markerSent = false;
  const server = createServer((socket) => {
    socket.once("data", (chunk) => {
      const host = chunk.toString("ascii").match(/^CONNECT ([a-f0-9]{32}\.barrier\.pac\.invalid):443 HTTP\/1\.1\r\n\r\n$/)?.[1];
      if (!host) return socket.destroy();
      outbox.observe({ ...identity, ...proxy, host });
      markerReached.resolve();
      socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture did not bind");
  const forward = createForwardAttestation(identity.enrollment, address.port, () => 1);
  const outbox = createProofOutbox(async (proof: DomainAttestation) => {
    if (proof.host === negative) await release.promise;
    if (proof.host.includes(".barrier.")) markerSent = true;
    return forward.attest(identity, proof) ? { ok: true, value: null } : { ok: false, code: "receipt_mismatch" };
  });
  const f = cdpFixture(null, (positive, wrong) => {
    const watched = forward.watch(positive, wrong, scope, proxy);
    negative = wrong;
    outbox.observe({ ...identity, ...proxy, host: positive });
    return {
      ...watched,
      negativeClear() {
        outbox.observe({ ...identity, ...proxy, host: wrong });
        return watched.negativeClear();
      },
    };
  });
  let finalized = false;
  try {
    const proving = f.observer.prove(policy, bytes, () => (finalized = true));
    await markerReached.promise;
    expect(markerSent).toBe(false);
    expect(finalized).toBe(false);
    release.resolve();
    expect(await proving).toBeNull();
    expect(markerSent).toBe(true);
    expect(finalized).toBe(false);
  } finally {
    release.resolve();
    forward.fence();
    f.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("[domains C11] a lost witness acknowledgement cannot be crossed by an otherwise valid marker", async () => {
  let now = 0;
  const pending = Promise.withResolvers<{ ok: false; code: "unavailable" }>();
  const names: string[] = [];
  const outbox = createProofOutbox((proof) => {
    names.push(proof.host);
    return proof.host.includes(".barrier.") ? Promise.resolve({ ok: true, value: null }) : pending.promise;
  }, () => now);
  const proof = { epoch: 1, enrollment: "fixture", generation: "proxy", revision: 12, domainsDigest: "a".repeat(64) };
  const wrong = `${"1".repeat(32)}.e0.r12.pac.invalid`;
  const marker = `${"2".repeat(32)}.barrier.pac.invalid`;
  outbox.observe({ ...proof, host: wrong });
  outbox.observe({ ...proof, host: wrong });
  outbox.observe({ ...proof, host: marker });
  pending.resolve({ ok: false, code: "unavailable" });
  await outbox.settled();
  expect(names).toEqual([wrong]);
  now = 10001;
  outbox.observe({ ...proof, host: `${"3".repeat(32)}.barrier.pac.invalid` });
  await outbox.settled();
  expect(names).toEqual([wrong, `${"3".repeat(32)}.barrier.pac.invalid`]);
});
