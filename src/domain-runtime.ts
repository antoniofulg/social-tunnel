import { hashBytes } from "./domain-policy";
import { readDomainLocal, writeDomainLocal, type ManagedEnrollment } from "./domain-enrollment";
import { domainDigest, domainUInt, operationIdFormat, proofHost, wireObject, type DomainClient } from "./domain-wire";
import { normalizeManagedDomain, parseManagedDomainSnapshot, type ManagedDomainSnapshot } from "./managed-domains";
import { createManagedProxy, type Dialer } from "./proxy";
import type { ProxyPublicationReceipt } from "./domain-publisher";
import type { TunnelState } from "./state";

export interface DomainRevision { revision: number; domains: readonly string[] }
export type DomainPhase = "claimed" | "activating" | "publishing" | "published";
export interface DomainPending {
  operationId: string;
  operation: "add" | "remove" | "recovery";
  host: string | null;
  phase: DomainPhase | "unconfirmed";
  pendingMayGoDirect: boolean;
}
export interface DomainView {
  state: "setup_required" | "ready" | "pending" | "activation_unknown" | "recovery_required" | "applied";
  active: DomainRevision | null;
  pending: DomainPending | null;
}
interface ArchivedOperation { operationId: string; revision: number; disposition: "cancelled" | "recovery_required" | "applied" | "reconciled" }
interface AuthorityView {
  state: "ready" | "pending" | "activation_unknown" | "recovery_required";
  active: ManagedDomainSnapshot | null;
  activeForMs: number;
  pending: unknown;
  history: ArchivedOperation[];
}
export const SETUP_REQUIRED: DomainView = Object.freeze({ state: "setup_required", active: null, pending: null });
export const UNKNOWN_DOMAINS: DomainView = Object.freeze({ state: "activation_unknown", active: null, pending: null });
const DOMAIN_STATE_MS = 6500;
const POLL_MS = 3500;

export function parseDomainRevision(value: unknown): ManagedDomainSnapshot | null {
  const o = wireObject(value);
  const domains = o?.domains;
  if (!o || !Array.isArray(domains)) return null;
  const parsed = parseManagedDomainSnapshot(o.revision, domains);
  return parsed.ok && parsed.snapshot.domains.every((host, i) => host === domains[i]) ? parsed.snapshot : null;
}

function phase(value: unknown): value is DomainPhase {
  return value === "claimed" || value === "activating" || value === "publishing" || value === "published";
}

export function pendingDomains(value: unknown): DomainPending | null {
  const o = wireObject(value);
  if (!o || !operationIdFormat(o.operationId) || !phase(o.phase)) return null;
  const intent = wireObject(o.intent);
  const kind = intent?.kind ?? o.operation;
  if (kind !== "add" && kind !== "remove" && kind !== "recovery") return null;
  const host = kind === "recovery" ? null : normalizeManagedDomain(wireObject(intent?.proposal)?.host ?? o.host);
  if (kind !== "recovery" && host === null) return null;
  return { operationId: o.operationId, operation: kind, host, phase: o.phase, pendingMayGoDirect: kind === "add" };
}

export function parseAuthorityView(value: unknown, enrollment: ManagedEnrollment): AuthorityView | null {
  const o = wireObject(value);
  if (!o || o.epoch !== enrollment.epoch || o.proxyGeneration !== enrollment.proxyGeneration ||
      !domainUInt(o.lastRevision) || !Array.isArray(o.history) || o.history.length > 32 ||
      (o.state !== "ready" && o.state !== "pending" && o.state !== "activation_unknown" && o.state !== "recovery_required")) return null;
  const active = o.active === null ? null : parseDomainRevision(o.active);
  if (!domainUInt(o.activeForMs) || o.activeForMs > 10000 || (active !== null) !== (o.activeForMs > 0)) return null;
  if ((o.active !== null && (!active || active.revision !== o.lastRevision)) || (o.pending !== null && !pendingDomains(o.pending))) return null;
  const history: ArchivedOperation[] = [];
  for (const raw of o.history) {
    const h = wireObject(raw);
    if (!h || !operationIdFormat(h.operationId) || !domainUInt(h.revision) ||
        (h.disposition !== "cancelled" && h.disposition !== "recovery_required" && h.disposition !== "applied" && h.disposition !== "reconciled")) return null;
    history.push({ operationId: h.operationId, revision: h.revision, disposition: h.disposition });
  }
  return { state: o.state, active, activeForMs: o.activeForMs, pending: o.pending, history };
}

const digest = (snapshot: DomainRevision) => hashBytes(JSON.stringify(snapshot.domains));
const revision = (snapshot: DomainRevision): DomainRevision => ({ revision: snapshot.revision, domains: snapshot.domains });

export function readActiveHome(enrollment: ManagedEnrollment, pid: number | null, now = Date.now()): DomainRevision | null {
  if (pid === null) return null;
  try {
    const o = wireObject(readDomainLocal(enrollment, "state"));
    if (!o || o.version !== 1 || o.binding !== enrollment.binding || o.enrollment !== enrollment.enrollment ||
        o.epoch !== enrollment.epoch || o.generation !== enrollment.proxyGeneration || o.pid !== pid ||
        !domainUInt(o.at) || !domainUInt(o.expiresAt) || o.at > now || o.expiresAt <= now ||
        o.expiresAt - o.at > DOMAIN_STATE_MS) return null;
    const active = parseDomainRevision(o.active);
    return active ? revision(active) : null;
  } catch { return null; }
}

export function matchingActive(value: AuthorityView, local: DomainRevision | null, elapsed = 0): DomainRevision | null {
  const active = value.active;
  return active && local && elapsed < value.activeForMs && active.revision === local.revision &&
    digest(active) === digest(local) ? revision(active) : null;
}

interface Grant {
  id: string;
  next: ManagedDomainSnapshot;
  descriptor: DomainPending;
  digest: string;
}

function grant(value: unknown, current: ManagedDomainSnapshot, enrollment: ManagedEnrollment): Grant | null {
  const operation = wireObject(value);
  const wanted = pendingDomains(value);
  const target = wireObject(operation?.target);
  const policy = wireObject(target?.policy);
  const intent = wireObject(operation?.intent);
  const next = target && policy && parseDomainRevision({ revision: policy.revision, domains: target.domains });
  if (!operation || !wanted || !target || !policy || !intent || !next || operation.proxyGeneration !== enrollment.proxyGeneration ||
      policy.epoch !== enrollment.epoch || !domainUInt(operation.expectedRevision) || !domainDigest(target.domainsDigest) ||
      !wanted.operationId.startsWith(`${enrollment.epoch}.${operation.expectedRevision}.`) ||
      next.revision <= current.revision || digest(next) !== target.domainsDigest) return null;
  if (wanted.operation === "recovery") {
    const from = wireObject(operation.homePreimage);
    if (!from || from.revision !== current.revision || from.domainsDigest !== digest(current) ||
        from.generation !== enrollment.proxyGeneration || !next.domains.every(current.allows)) return null;
  } else {
    const proposal = wireObject(intent.proposal);
    if (!proposal || !wanted.host || proposal.operationId !== wanted.operationId || proposal.expectedRevision !== current.revision ||
        operation.expectedRevision !== current.revision) return null;
    const before = current.domains;
    const present = before.includes(wanted.host);
    if ((wanted.operation === "add" && present) || (wanted.operation === "remove" && !present)) return null;
    const projection = wanted.operation === "add" ? [...before, wanted.host].sort() : before.filter((d) => d !== wanted.host);
    if (next.domains.length !== projection.length || !next.domains.every((d, i) => d === projection[i])) return null;
  }
  return { id: wanted.operationId, next, descriptor: wanted, digest: target.domainsDigest };
}

function openRuntime(enrollment: ManagedEnrollment): { active: ManagedDomainSnapshot; interrupted: boolean } {
  const raw = readDomainLocal(enrollment, "journal");
  if (raw === undefined) return { active: enrollment.baseline, interrupted: false };
  const s = wireObject(raw);
  if (!s || s.version !== 1 || s.binding !== enrollment.binding || s.enrollment !== enrollment.enrollment || !domainUInt(s.epoch) ||
      s.epoch > enrollment.epoch) throw new Error("invalid managed runtime journal");
  const active = parseDomainRevision(s.active);
  if (!active || active.revision < enrollment.baseline.revision) throw new Error("invalid managed runtime revision");
  if (s.applying === null) return { active, interrupted: false };
  const desired = parseDomainRevision(s.applying);
  if (!desired || desired.revision <= active.revision) throw new Error("invalid managed runtime intent");
  // An interrupted apply cannot reopen a possible removal or grant an uncertain addition.
  const conservative = parseManagedDomainSnapshot(active.revision, active.domains.filter(desired.allows));
  if (!conservative.ok) throw new Error("invalid managed recovery projection");
  return { active: conservative.snapshot, interrupted: true };
}

interface ManagedRunOptions {
  client: DomainClient;
  enrollment: ManagedEnrollment;
  resolve(host: string, signal: AbortSignal): Promise<string[]>;
  dial: Dialer;
  pollMs?: number;
}

export function createManagedRun(options: ManagedRunOptions) {
  const { client, enrollment } = options;
  const boot = openRuntime(enrollment);
  let active = boot.active;
  let interrupted = boot.interrupted;
  let allow = false;
  let connected = false;
  let incarnation = 0;
  let stopping = false;
  let settling = false;
  let busy: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let acknowledged: { receipt: ProxyPublicationReceipt; incarnation: number } | undefined;
  let attestBusy: Promise<unknown> | undefined;
  const canaries = new Set<string>();
  const bound = { version: 1, binding: enrollment.binding, enrollment: enrollment.enrollment, epoch: enrollment.epoch } as const;
  const sameConnection = (id: number) => connected && !stopping && incarnation === id;
  function recordLive(snapshot: DomainRevision | null, remainingMs = 0) {
    const at = Date.now();
    writeDomainLocal(enrollment, "state", {
      ...bound, generation: enrollment.proxyGeneration, pid: process.pid, at,
      expiresAt: at + Math.max(0, Math.floor(Math.min(DOMAIN_STATE_MS, remainingMs))), active: snapshot,
    });
  }
  const recordJournal = (snapshot: DomainRevision, applying: DomainRevision | null) => writeDomainLocal(enrollment, "journal", {
    ...bound, active: revision(snapshot), applying: applying && revision(applying),
  });

  function flushCanaries() {
    if (attestBusy || !connected || stopping || settling || !canaries.size) return;
    const host = canaries.values().next().value!;
    canaries.delete(host);
    attestBusy = client.attest({ enrollment: enrollment.enrollment, epoch: enrollment.epoch, generation: enrollment.proxyGeneration,
      revision: active.revision, domainsDigest: digest(active), host,
    }).catch(() => {}).finally(() => { attestBusy = undefined; flushCanaries(); });
  }
  const proxy = createManagedProxy({
    resolve: options.resolve, dial: options.dial, trafficReady: () => allow && !stopping,
    log: ({ status, host }) => {
      if (status !== 403 || !proofHost(host) || !connected || stopping || settling || canaries.size >= 3) return;
      canaries.add(host);
      flushCanaries();
    },
  }, active);

  async function poll(id: number) {
    const started = performance.now();
    const raw = await client.inspect();
    if (!sameConnection(id)) return;
    const view = raw.ok ? parseAuthorityView(raw.value, enrollment) : null;
    const pending = pendingDomains(view?.pending);
    const elapsed = performance.now() - started;
    const live = !interrupted && view && (!pending || pending.phase === "claimed") ? matchingActive(view, active, elapsed) : null;
    recordLive(live, live && view ? view.activeForMs - elapsed : 0);
    if (live) allow = true;
    if (!view) return;
    if (!pending) { acknowledged = undefined; return; }
    if (pending.phase === "activating" || pending.phase === "publishing") {
      const receipt = acknowledged?.incarnation === id ? acknowledged.receipt : undefined;
      if (receipt?.operationId === pending.operationId) await client.receipt(receipt);
      return;
    }
    if (pending.phase !== "claimed" || (pending.operation !== "recovery" && !live)) return;
    const intent = grant(view.pending, active, enrollment);
    if (!intent) return;
    const issued = await client.begin(intent.id);
    if (!sameConnection(id) || !issued.ok) return;
    const granted = grant(issued.value, active, enrollment);
    if (!granted || granted.id !== intent.id || granted.descriptor.phase !== "activating" ||
        granted.digest !== intent.digest || granted.next.revision !== intent.next.revision ||
        granted.descriptor.host !== intent.descriptor.host || granted.descriptor.operation !== intent.descriptor.operation) return;
    settling = true;
    try {
      recordLive(null);
      recordJournal(active, granted.next);
      const ack = await proxy.activate(active.revision, granted.next);
      if (!ack.ok) { interrupted = true; allow = false; return; }
      active = ack.snapshot;
      recordJournal(active, null);
      interrupted = false;
      settling = false;
      if (sameConnection(id)) {
        acknowledged = { incarnation: id, receipt: { enrollment: enrollment.enrollment, epoch: enrollment.epoch,
          operationId: granted.id, revision: active.revision, domainsDigest: granted.digest, proxyGeneration: enrollment.proxyGeneration } };
        await client.receipt(acknowledged.receipt);
      }
    } catch { interrupted = true; allow = false; }
    finally { settling = false; flushCanaries(); }
  }

  function kick() {
    if (busy || !connected || stopping) return;
    busy = poll(incarnation).catch(() => { try { recordLive(null); } catch {} }).finally(() => {
      busy = undefined;
      if (connected && !stopping) timer = setTimeout(kick, options.pollMs ?? POLL_MS);
    });
  }

  return {
    handle: proxy.handle,
    onState(state: TunnelState) {
      if (state === "connected" && !stopping) {
        connected = true;
        incarnation++;
        kick();
      } else {
        connected = false;
        allow = false;
        clearTimeout(timer);
        acknowledged = undefined;
        canaries.clear();
        try { recordLive(null); } catch {}
      }
    },
    async stop() {
      stopping = true;
      connected = false;
      clearTimeout(timer);
      canaries.clear();
      await Promise.all([busy, attestBusy]);
      try { recordLive(null); } catch {}
    },
  };
}
