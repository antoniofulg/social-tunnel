import { hashBytes, renderDomainPolicy } from "../src/domain-policy";
import {
  openDomainPublisher, provisionDomainPublisher, type PublisherOptions, type PublisherPrincipal,
  type PublisherOperation, type PublisherView, type VerifiedPublisherBaseline,
  type ProxyPreimage,
} from "../src/domain-publisher";
import { createDomainIngress, type RemoteOperation, type RoleIngress } from "./domain-ingress";
import { createDomainCohort, type BrowserCohortEvidence, type EnrolledBrowserRoster } from "./domain-observer";
import { createForwardAttestation, type ForwardScope } from "./forward-attestation";
import { domainTag } from "../src/domain-wire";

type Options = Omit<PublisherOptions<object>, "identify">;
type Target = PublisherView["lastProven"];
export type LiveProxyRevision = ProxyPreimage;

// Proxy activation uses the home snapshot, never the retained PAC selectors or
// the administrator's release list. Only one target list crosses the wire.
function proxyOperation(operation: PublisherOperation) {
  const { intent, target, ...scope } = operation;
  return {
    ...scope,
    intent: intent.kind === "recovery" ? { kind: intent.kind } : intent,
    target: { domains: target.domains, domainsDigest: target.domainsDigest,
      policy: { epoch: target.policy.epoch, revision: target.policy.revision } },
  };
}

export type DomainEnrollment = Options & {
  browserRoster: () => EnrolledBrowserRoster | null;
  forwardOwnership: () => number | null;
  forward: ForwardScope;
};

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const unavailable = Object.freeze({ ok: false as const, code: "not_ready" as const });
const invalid = Object.freeze({ ok: false as const, code: "invalid_request" as const });

export function openDomainAuthority(enrollment: DomainEnrollment, now = () => performance.now()) {
  const { browserRoster, forwardOwnership, policy, proxyPort } = enrollment;
  const forward = createForwardAttestation(enrollment.enrollment, proxyPort, forwardOwnership, now);
  const bootstrap = Object.freeze({ ...enrollment.forward });
  let recoveryScope: ForwardScope | undefined;
  const observer = createDomainCohort(browserRoster, now);
  const admin = Object.freeze({});
  const identities = new WeakMap<object, PublisherPrincipal>();
  identities.set(admin, { role: "local_admin", enrollment: enrollment.enrollment });
  const options = { ...enrollment, identify: (session: object) => identities.get(session) ?? null };
  let proven: { epoch: number; revision: number; generation: string; bytes: string; evidence: BrowserCohortEvidence } | undefined;
  let publisher: ReturnType<typeof openDomainPublisher<object>> | undefined;
  let closing = false;
  const view = () => publisher?.inspect(admin);
  const readLive = forward.current;
  const current = (expected: Target, proxyGeneration: string) => {
    const live = readLive({ epoch: expected.policy.epoch, generation: proxyGeneration });
    return live?.generation === proxyGeneration && live.revision === expected.policy.revision && live.domainsDigest === expected.domainsDigest;
  };
  const samePreimage = (expected: ProxyPreimage | undefined, epoch: number) => {
    const live = expected && readLive({ epoch, generation: expected.generation });
    return !!expected && live?.generation === expected.generation && live.revision === expected.revision &&
      live.domainsDigest === expected.domainsDigest;
  };
  function ready(v: PublisherView): boolean {
    const owned = observer.alive();
    if (!closing && owned && v.editingEnabled && !v.recovery && proven && observer.valid(proven.evidence) &&
        proven.epoch === v.epoch && proven.revision === v.lastProven.policy.revision && proven.generation === v.proxyGeneration &&
        current(v.lastProven, v.proxyGeneration) && policy.read() === proven.bytes) return true;
    proven = undefined;
    return false;
  }
  const wireInspect = (v: PublisherView, role: RoleIngress["identity"]["role"]) => {
    const scope = { epoch: v.epoch, generation: v.proxyGeneration };
    const lifetime = ready(v) && proven ? Math.floor(Math.min(proven.evidence.expiresAt - now(), forward.freshFor(scope))) : 0;
    const active = lifetime > 0 ? { revision: v.lastProven.policy.revision, domains: v.lastProven.domains } : null;
    const pending = v.pending;
    return {
      epoch: v.epoch, proxyGeneration: v.proxyGeneration, active,
      activeForMs: active ? lifetime : 0,
      lastRevision: v.lastProven.policy.revision,
      state: v.recovery ? "recovery_required" : pending?.phase === "published" || !observer.alive() ? "activation_unknown"
        : pending ? "pending" : active ? "ready" : "activation_unknown",
      pending: pending && (role === "proxy" ? proxyOperation(pending) : {
        operationId: pending.operationId, phase: pending.phase, operation: pending.intent.kind,
        host: pending.intent.kind === "recovery" ? null : pending.intent.proposal.host,
      }),
      history: v.history,
    };
  };
  const token = (identity: PublisherPrincipal) => {
    const ticket = Object.freeze({});
    identities.set(ticket, identity);
    return ticket;
  };
  const dispatch = (identity: RoleIngress["identity"], verb: RemoteOperation, body: Buffer): unknown => {
    if (verb === "attest") {
      const checked = view();
      const v = checked?.ok ? checked.value : undefined;
      const scope = recoveryScope ?? (v ? { epoch: v.epoch, generation: v.proxyGeneration } : bootstrap);
      if (closing || identity.role !== "proxy" || identity.epoch !== scope.epoch ||
          identity.generation !== scope.generation || !observer.alive()) return unavailable;
      try {
        return forward.attest(identity, JSON.parse(utf8.decode(body))) ? { ok: true, value: null } :
          { ok: false, code: "receipt_mismatch" };
      } catch { return invalid; }
    }
    const ticket = token(identity);
    const read = publisher?.inspect(ticket);
    if (!publisher || !read) return unavailable;
    if (!read.ok) return read;
    const v = read.value;
    if (verb === "inspect") return { ok: true, value: wireInspect(v, identity.role) };
    if (verb === "add" || verb === "remove") {
      if (!ready(v)) return v.recovery ? { ok: false, code: "recovery_required" } : unavailable;
      const result = publisher.propose(ticket, verb, body);
      return result.ok ? { ok: true, value: { operationId: result.value.operationId, revision: result.value.target.policy.revision, phase: result.value.phase } } : result;
    }
    try {
      const input: unknown = JSON.parse(utf8.decode(body));
      if (verb === "reconcile") {
        const result = publisher.reconcile(ticket, input);
        return result.ok ? { ok: true, value: wireInspect(v, identity.role) } : result;
      }
      if (verb === "begin") {
        if (typeof input !== "string" || input.length > 68) return invalid;
        if (v.pending?.intent.kind === "recovery" ? !observer.alive() || !samePreimage(v.pending.homePreimage, v.epoch) : !ready(v)) return unavailable;
        const result = publisher.beginActivation(ticket, input);
        return result.ok ? { ok: true, value: proxyOperation(result.value) } : result;
      }
      if (!v.pending || !observer.alive() || !current(v.pending.target, v.proxyGeneration)) return unavailable;
      const result = publisher.publish(ticket, input);
      return result.ok ? { ok: true, value: proxyOperation(result.value) } : result;
    } catch { return invalid; }
  };
  const ingress = createDomainIngress(dispatch);

  function open() {
    if (closing || publisher) throw new Error("authority already in use");
    publisher = openDomainPublisher(options);
  }

  function watch(scope: ForwardScope, expected: ProxyPreimage) {
    return (positive: string) => forward.watch(positive, scope, expected);
  }

  async function provision(baseline: VerifiedPublisherBaseline): Promise<boolean> {
    if (closing || publisher) return false;
    const scope = { epoch: baseline.epoch, generation: baseline.proxyGeneration };
    if (bootstrap.epoch !== scope.epoch || bootstrap.generation !== scope.generation) return false;
    const base = { generation: baseline.proxyGeneration, revision: baseline.revision, domainsDigest: hashBytes(JSON.stringify([...baseline.domains].sort())) };
    const target = { epoch: baseline.epoch, revision: baseline.revision, routes: [...baseline.domains].sort() };
    const expected = renderDomainPolicy(proxyPort, target);
    if (policy.read() !== expected || !readLive(scope)) return false;
    const forwardOwner = forwardOwnership();
    if (forwardOwner === null) return false;
    const evidence = await observer.prove(target, expected, (proof) => {
      const live = readLive(scope);
      if (closing || publisher || forwardOwnership() !== forwardOwner || !observer.valid(proof) || live?.generation !== base.generation ||
          live.revision !== base.revision || live.domainsDigest !== base.domainsDigest || policy.read() !== expected) return false;
      provisionDomainPublisher(options, baseline);
      open();
      return true;
    }, watch(scope, base));
    return !!evidence;
  }

  async function observe(): Promise<boolean> {
    const checked = view();
    if (!publisher || !checked?.ok || closing || !observer.alive()) return false;
    const v = checked.value;
    const operation = v.pending;
    if (operation && operation.phase !== "claimed" && operation.phase !== "published") return false;
    const pending = operation?.phase === "published" ? operation : null;
    const target = pending?.target ?? v.lastProven;
    if (!current(target, v.proxyGeneration)) return false;
    const bytes = renderDomainPolicy(proxyPort, target.policy);
    if (policy.read() !== bytes) return false;
    const forwardOwner = forwardOwnership();
    if (forwardOwner === null) return false;
    const proof = await observer.prove(target.policy, bytes, (evidence) => {
      const reread = view();
      if (closing || !publisher || forwardOwnership() !== forwardOwner || !observer.valid(evidence) || !reread?.ok ||
          reread.value.epoch !== v.epoch || reread.value.proxyGeneration !== v.proxyGeneration ||
          reread.value.pending?.operationId !== operation?.operationId || reread.value.pending?.phase !== operation?.phase ||
          !current(target, v.proxyGeneration) || policy.read() !== bytes) return false;
      if (pending) {
        const ticket = token({ role: "observer", enrollment: enrollment.enrollment, epoch: v.epoch, generation: evidence.generation });
        const final = publisher.finalize(ticket, {
          enrollment: enrollment.enrollment, epoch: v.epoch, operationId: pending.operationId, revision: target.policy.revision,
          domainsDigest: target.domainsDigest, proxyGeneration: v.proxyGeneration, browserGeneration: evidence.generation,
          policyDigest: evidence.policyDigest, positive: evidence.positive, negative: evidence.negative,
        });
        if (!final.ok) return false;
      } else if (v.recovery || !v.editingEnabled || v.epoch !== target.policy.epoch) return false;
      proven = { epoch: v.epoch, revision: target.policy.revision, generation: v.proxyGeneration, bytes, evidence };
      return true;
    }, watch({ epoch: v.epoch, generation: v.proxyGeneration }, {
      generation: v.proxyGeneration, revision: target.policy.revision, domainsDigest: target.domainsDigest,
    }));
    if (!proof) proven = undefined;
    return !!proof;
  }

  return {
    open, provision, observe, inspectLocal: view,
    inspectPolicyLocal: () => publisher?.inspectPolicy(admin),
    admittedCount: ingress.admittedCount,
    bind(role: RoleIngress) {
      const checked = view();
      const identity = role.identity;
      const v = checked?.ok ? checked.value : null;
      const scope = recoveryScope ?? (v ? { epoch: v.epoch, generation: v.proxyGeneration } : bootstrap);
      if (closing || !scope || (!v && identity.role !== "proxy") || identity.enrollment !== enrollment.enrollment ||
          identity.epoch !== scope.epoch || (identity.role === "proxy" && identity.generation !== scope.generation)) {
        throw new Error("role outside current domain enrollment");
      }
      return ingress.bind(role);
    },
    async refreshRuntime() {
      const checked = view();
      const v = checked?.ok ? checked.value : undefined;
      const scope = recoveryScope ?? (v ? { epoch: v.epoch, generation: v.proxyGeneration } : bootstrap);
      if (!scope || closing || !observer.alive() || !(await forward.refresh(scope))) return false;
      // Only the protected scheduler can renew the browser baseline. A durable
      // ordinary claim made under still-valid evidence can wait here unchanged;
      // the home runner and begin CAS still require a fresh matching baseline.
      const renewed = view();
      const claim = renewed?.ok ? renewed.value.pending : null;
      return renewed?.ok && claim?.phase === "claimed" && claim.intent.kind !== "recovery" && !ready(renewed.value)
        ? observe() : true;
    },
    prepareRecovery(scope: ForwardScope) {
      const checked = view();
      if (closing || !checked?.ok || checked.value.editingEnabled || checked.value.pending ||
          scope.epoch !== checked.value.epoch || !domainTag(scope.generation)) return false;
      if (recoveryScope) return recoveryScope.epoch === scope.epoch && recoveryScope.generation === scope.generation;
      recoveryScope = Object.freeze({ ...scope });
      return true;
    },
    async disable(epoch: number) {
      const result = publisher?.disable(admin, epoch);
      if (result?.ok) {
        proven = undefined;
        recoveryScope = undefined;
        forward.fence();
        await ingress.retireBefore(result.value);
      }
      return result;
    },
    authorizeRecovery(request: Parameters<NonNullable<typeof publisher>["authorizeRecovery"]>[1]) {
      const scope = { epoch: request.epoch, generation: request.proxyGeneration };
      if (recoveryScope?.epoch !== scope.epoch || recoveryScope.generation !== scope.generation) return unavailable;
      const preimage = readLive(scope);
      if (!preimage || !observer.alive()) return unavailable;
      const result = publisher?.authorizeRecovery(admin, request, preimage);
      if (result?.ok) recoveryScope = undefined;
      return result;
    },
    async close() {
      closing = true;
      forward.fence();
      await ingress.close();
      publisher?.close();
      publisher = undefined;
    },
  };
}
