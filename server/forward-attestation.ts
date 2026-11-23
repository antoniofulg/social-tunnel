import { randomBytes } from "node:crypto";
import { createConnection } from "node:net";
import { domainDigest, domainTag, domainUInt, proofHost, wireObject } from "../src/domain-wire";
import type { ProxyPreimage } from "../src/domain-publisher";

const NONCE_MS = 3800;
const LIVE_MS = 10000;
export interface ForwardScope { epoch: number; generation: string }
interface Probe {
  epoch: number;
  generation: string;
  owner: number;
  expires: number;
  expected?: ProxyPreimage;
  resolve: (value: ProxyPreimage | null) => void;
}

// Owned supervisor only. The port is the enrolled loopback forward, never a request argument.
// Challenges are not returned on SSH commands; only the actual forwarded CONNECT reveals them.
export function createForwardAttestation(enrollment: string, port: number, ownership: () => number | null, now = () => performance.now()) {
  if (!domainTag(enrollment) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid attestation enrollment");
  const probes = new Map<string, Probe>();
  let live: { owner: number; scope: ForwardScope; snapshot: ProxyPreimage; expires: number } | undefined;
  let refreshing = false;
  let fenceGeneration = 0;

  function current(scope: ForwardScope): ProxyPreimage | null {
    if (!live || live.owner !== ownership() || now() >= live.expires) { live = undefined; return null; }
    return live.scope.epoch === scope.epoch && live.scope.generation === scope.generation ? live.snapshot : null;
  }

  function freshFor(scope: ForwardScope): number {
    return current(scope) && live ? Math.max(0, Math.floor(live.expires - now())) : 0;
  }

  function arm(host: string, scope: ForwardScope, expected?: ProxyPreimage) {
    const owner = ownership();
    if (owner === null || probes.size >= 3 || probes.has(host)) throw new Error("forward attestation unavailable");
    const { promise, resolve } = Promise.withResolvers<ProxyPreimage | null>();
    const probe = { ...scope, owner, expected, expires: now() + NONCE_MS, resolve };
    const close = () => {
      clearTimeout(timer);
      if (probes.get(host) === probe) probes.delete(host);
      resolve(null);
    };
    const timer = setTimeout(close, NONCE_MS);
    probes.set(host, probe);
    return { promise, close, owner, expires: probe.expires };
  }

  function attest(identity: { enrollment: string; epoch: number; generation: string }, value: unknown): boolean {
    const claim = wireObject(value);
    if (identity.enrollment !== enrollment || !claim || Object.keys(claim).length !== 6 || claim.enrollment !== enrollment ||
        !proofHost(claim.host) || claim.epoch !== identity.epoch || claim.generation !== identity.generation ||
        !domainUInt(claim.revision) || !domainDigest(claim.domainsDigest)) return false;
    const probe = probes.get(claim.host);
    if (!probe || probe.epoch !== identity.epoch || probe.generation !== identity.generation ||
        probe.owner !== ownership() || now() >= probe.expires ||
        (probe.expected && (claim.revision !== probe.expected.revision || claim.domainsDigest !== probe.expected.domainsDigest))) return false;
    probes.delete(claim.host);
    probe.resolve({ generation: identity.generation, revision: claim.revision, domainsDigest: claim.domainsDigest });
    return true;
  }

  function connectCanary(host: string): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const socket = createConnection({ host: "127.0.0.1", port });
    const timer = setTimeout(() => socket.destroy(), NONCE_MS);
    let head = "";
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(timer); resolve(false); });
    socket.once("connect", () => socket.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`));
    socket.on("data", (chunk: Buffer) => {
      if (head.length + chunk.length > 1024) return socket.destroy();
      head += chunk.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      resolve(head.startsWith("HTTP/1.1 403 Forbidden\r\n"));
      socket.destroy();
    });
    return promise;
  }

  async function refresh(scope: ForwardScope): Promise<boolean> {
    if (refreshing || ownership() === null) return false;
    refreshing = true;
    const started = fenceGeneration;
    const host = `${randomBytes(16).toString("hex")}.live.pac.invalid`;
    let probe: ReturnType<typeof arm> | undefined;
    try {
      probe = arm(host, scope);
      const [refused, snapshot] = await Promise.all([connectCanary(host), probe.promise]);
      if (!refused || !snapshot || started !== fenceGeneration || ownership() !== probe.owner || now() >= probe.expires) {
        live = undefined;
        return false;
      }
      live = { owner: probe.owner, scope, snapshot, expires: now() + LIVE_MS };
      return true;
    } catch { live = undefined; return false; }
    finally { probe?.close(); refreshing = false; }
  }

  function watch(positive: string, scope: ForwardScope, expected: ProxyPreimage) {
    const probe = arm(positive, scope, expected);
    const started = fenceGeneration;
    let seen = false;
    return {
      positiveSeen: async () => seen = (await probe.promise) !== null,
      valid: () => seen && started === fenceGeneration && ownership() === probe.owner && now() < probe.expires,
      close: probe.close,
    };
  }

  function fence() {
    fenceGeneration++;
    live = undefined;
    for (const probe of probes.values()) probe.resolve(null);
    probes.clear();
  }
  return { attest, current, freshFor, refresh, watch, fence };
}
