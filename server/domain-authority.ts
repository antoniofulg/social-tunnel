import { hashBytes, renderDomainPolicy } from "../src/domain-policy";
import {
  openDomainPublisher, provisionDomainPublisher, type PublisherOptions, type PublisherPrincipal,
  type PublisherView, type VerifiedPublisherBaseline,
  type ProxyPreimage,
} from "../src/domain-publisher";
import { createDomainIngress, type RemoteOperation, type RoleIngress } from "./domain-ingress";
import { createDomainObserver, type BrowserEvidence, type EnrolledChrome } from "./domain-observer";

type Options = Omit<PublisherOptions<object>, "identify">;
type Target = PublisherView["lastProven"];
export type LiveProxyRevision = ProxyPreimage;

export interface DomainEnrollment extends Options {
  chrome: EnrolledChrome;
  // Root-owned supervisor view of the current authenticated proxy generation and snapshot.
  // Not built from edit data or any caller's claimed browser evidence.
  liveProxy(): LiveProxyRevision | null;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const unavailable = Object.freeze({ ok: false as const, code: "not_ready" as const });
const invalid = Object.freeze({ ok: false as const, code: "invalid_request" as const });

export function openDomainAuthority(enrollment: DomainEnrollment, now = () => performance.now()) {
  const { chrome, liveProxy, policy, proxyPort } = enrollment;
  const observer = createDomainObserver(chrome, now);
  const admin = Object.freeze({});
  const identities = new WeakMap<object, PublisherPrincipal>();
  identities.set(admin, { role: "local_admin", enrollment: enrollment.enrollment });
  const options = { ...enrollment, identify: (session: object) => identities.get(session) ?? null };
  let proven: { epoch: number; revision: number; generation: string; bytes: string; evidence: BrowserEvidence } | undefined;
  let publisher: ReturnType<typeof openDomainPublisher<object>> | undefined;
  let closing = false;
  const view = () => publisher?.inspect(admin);
  const current = (expected: Target, proxyGeneration: string) => {
    const live = liveProxy();
    return live?.generation === proxyGeneration && live.revision === expected.policy.revision && live.domainsDigest === expected.domainsDigest;
  };
  const samePreimage = (expected: ProxyPreimage | undefined) => {
    const live = liveProxy();
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
    const active = ready(v) ? { revision: v.lastProven.policy.revision, domains: v.lastProven.domains } : null;
    const pending = v.pending;
    return {
      epoch: v.epoch, proxyGeneration: v.proxyGeneration, active,
      lastRevision: v.lastProven.policy.revision,
      state: v.recovery ? "recovery_required" : pending?.phase === "published" || !observer.alive() ? "activation_unknown"
        : pending ? "pending" : active ? "ready" : "activation_unknown",
      pending: pending && (role === "proxy" ? pending : {
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
      if (verb === "begin") {
        if (typeof input !== "string" || input.length > 68) return invalid;
        if (v.pending?.intent.kind === "recovery" ? !observer.alive() || !samePreimage(v.pending.homePreimage) : !ready(v)) return unavailable;
        return publisher.beginActivation(ticket, input);
      }
      if (!v.pending || !observer.alive() || !current(v.pending.target, v.proxyGeneration)) return unavailable;
      return publisher.publish(ticket, input);
    } catch { return invalid; }
  };
  const ingress = createDomainIngress(dispatch);

  function open() {
    if (closing || publisher) throw new Error("authority already in use");
    publisher = openDomainPublisher(options);
  }

  async function provision(baseline: VerifiedPublisherBaseline): Promise<boolean> {
    if (closing || publisher) return false;
    const expected = policy.read();
    const evidence = await observer.prove({ epoch: baseline.epoch, revision: baseline.revision, routes: baseline.domains }, expected, (proof) => {
      const live = liveProxy();
      if (closing || publisher || !observer.valid(proof) || live?.generation !== baseline.proxyGeneration ||
          live.revision !== baseline.revision || live.domainsDigest !== hashBytes(JSON.stringify([...baseline.domains].sort())) ||
          policy.read() !== expected) return false;
      provisionDomainPublisher(options, baseline);
      open();
      return true;
    });
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
    const proof = await observer.prove(target.policy, bytes, (evidence) => {
      const reread = view();
      if (closing || !publisher || !observer.valid(evidence) || !reread?.ok ||
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
    });
    if (!proof) proven = undefined;
    return !!proof;
  }

  return {
    open, provision, observe, inspectLocal: view,
    bind(role: RoleIngress) {
      const checked = view();
      const identity = role.identity;
      if (!checked?.ok || identity.enrollment !== enrollment.enrollment || identity.epoch !== checked.value.epoch ||
          (identity.role === "proxy" && identity.generation !== checked.value.proxyGeneration)) {
        throw new Error("role outside current domain enrollment");
      }
      return ingress.bind(role);
    },
    async disable(epoch: number) {
      const result = publisher?.disable(admin, epoch);
      if (result?.ok) {
        proven = undefined;
        await ingress.retireBefore(result.value);
      }
      return result;
    },
    authorizeRecovery(request: Parameters<NonNullable<typeof publisher>["authorizeRecovery"]>[1]) {
      const preimage = liveProxy();
      if (!preimage || !observer.alive()) return unavailable;
      return publisher?.authorizeRecovery(admin, request, preimage);
    },
    async close() {
      closing = true;
      await ingress.close();
      publisher?.close();
      publisher = undefined;
    },
  };
}
