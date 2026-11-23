import { randomBytes } from "node:crypto";
import type { ManagedEnrollment } from "./domain-enrollment";
import { domainSubmission, type Submission } from "./domain-submission";
import { normalizeManagedDomain } from "./managed-domains";
import { matchingActive, parseAuthorityView, pendingDomains, SETUP_REQUIRED, UNKNOWN_DOMAINS,
  type DomainRevision, type DomainView } from "./domain-runtime";
import { domainUInt, operationIdFormat, wireObject, type DomainClient, type WireError } from "./domain-wire";

export type DomainAction = { kind: "list" } | { kind: "retry"; id: string } |
  { kind: "add" | "remove"; host: string; expected?: string };

type Code = "invalid_domain" | "duplicate_domain" | "domain_not_found" | "invalid_revision" | "unknown_operation" |
  "operation_cancelled" | "internal" | "not_ready" | "conflict" | "unavailable" | "recovery_required";
type Outcome = { ok: true; view: DomainView } | { ok: false; error: { code: Code; message: string }; exit: number };
const messages: Record<Code, string> = {
  invalid_domain: "Use a public DNS hostname without a scheme, port, path, or wildcard.",
  duplicate_domain: "That hostname is already selected.",
  domain_not_found: "That hostname is not a selected entry.",
  invalid_revision: "An unsigned expected revision is required.",
  unknown_operation: "The authority has no record of that operation.",
  operation_cancelled: "The authority cancelled that operation.",
  internal: "Managed domains could not be read.",
  not_ready: "The managed tunnel and browser have not verified the same revision.",
  conflict: "The managed revision changed or another operation is pending.",
  unavailable: "The managed authority is unavailable.",
  recovery_required: "The server administrator must reconcile this enrollment.",
};
const exitCodes: Record<Code, number> = {
  invalid_domain: 2, duplicate_domain: 2, domain_not_found: 2, invalid_revision: 2, unknown_operation: 2, operation_cancelled: 2,
  internal: 1, not_ready: 10, conflict: 10, unavailable: 10, recovery_required: 10,
};
const fail = (code: Code): Outcome => ({ ok: false, error: { code, message: messages[code] }, exit: exitCodes[code] });
const ok = (view: DomainView): Outcome => ({ ok: true, view });

function wireFailure(code: WireError): Outcome {
  if (code === "unsupported") return ok(SETUP_REQUIRED);
  if (code === "superseded") return fail("unknown_operation");
  if (code === "fenced" || code === "recovery_required") return fail("recovery_required");
  if (code === "invalid_request" || code === "receipt_mismatch") return fail("unavailable");
  if (code === "unauthorized" || code === "limit") return fail("unavailable");
  return fail(code);
}

function unconfirmed(saved: Submission | null, recovery = false): DomainView {
  return {
    ...UNKNOWN_DOMAINS,
    state: recovery ? "recovery_required" : "activation_unknown",
    pending: saved && {
      operationId: saved.proposal.operationId, operation: saved.kind, host: saved.proposal.host,
      phase: "unconfirmed", pendingMayGoDirect: saved.kind === "add",
    },
  };
}

export async function domainAction(
  action: DomainAction, enrollment: ManagedEnrollment | null | undefined,
  client: DomainClient | null, local: () => DomainRevision | null,
  currentSelection?: () => boolean,
): Promise<Outcome> {
  const changed = () => currentSelection?.() === false;
  const conflict = () => fail("conflict");
  if (changed()) return conflict();
  if (!enrollment) return ok(SETUP_REQUIRED);
  let saved: Submission | null;
  try { saved = domainSubmission(enrollment).saved; }
  catch { return action.kind === "list" ? ok(UNKNOWN_DOMAINS) : fail("unavailable"); }
  if (!client) return action.kind === "list" ? ok(unconfirmed(saved)) : fail("unavailable");
  let host: string | null = null;
  let expected = -1;
  if (action.kind === "add" || action.kind === "remove") {
    host = normalizeManagedDomain(action.host);
    if (!host) return fail("invalid_domain");
    if (!action.expected || !/^(?:0|[1-9]\d{0,15})$/.test(action.expected) || !domainUInt(Number(action.expected))) {
      return fail("invalid_revision");
    }
    expected = Number(action.expected);
  } else if (action.kind === "retry" && !operationIdFormat(action.id)) return fail("unknown_operation");
  const reconcile = action.kind === "retry" && saved?.proposal.operationId === action.id ? saved : null;
  if (host && saved) return fail("conflict");
  const started = performance.now();
  if (changed()) return conflict();
  const read = await (reconcile ? client.reconcile(reconcile.proposal.operationId) : client.inspect());
  if (changed()) return conflict();
  function clear(submission: Submission) {
    if (changed()) return false;
    try { domainSubmission(enrollment!, { clear: submission }); } catch { return false; }
    return true;
  }
  if (!read.ok) {
    const recovery = read.code === "fenced" || read.code === "recovery_required";
    if (reconcile && (read.code === "operation_cancelled" || read.code === "superseded")) {
      return clear(reconcile) ? wireFailure(read.code) : fail("unavailable");
    }
    if (action.kind === "list") {
      return ok(read.code === "unsupported" && !saved ? SETUP_REQUIRED : unconfirmed(saved, recovery));
    }
    if (reconcile && !recovery) return ok(unconfirmed(reconcile));
    return wireFailure(read.code);
  }
  const authority = parseAuthorityView(read.value, enrollment);
  if (!authority) return action.kind === "list" || reconcile ? ok(unconfirmed(saved)) : fail("not_ready");
  const pending = pendingDomains(authority.pending);
  const state = authority.state;
  const active = state === "ready" || state === "pending" ? matchingActive(authority, local(), performance.now() - started) : null;
  const view = { state: state === "ready" && !active ? "activation_unknown" as const : state, active, pending };
  if (action.kind === "list") {
    return ok(saved && pending?.operationId !== saved.proposal.operationId ? unconfirmed(saved, state === "recovery_required") : view);
  }
  if (action.kind === "retry") {
    const history = authority.history.find((item) => item.operationId === action.id);
    if (state === "recovery_required" || history?.disposition === "recovery_required") return fail("recovery_required");
    if (pending?.operationId === action.id) return ok(view);
    if (history?.disposition === "cancelled") {
      return !reconcile || clear(reconcile) ? fail("operation_cancelled") : fail("unavailable");
    }
    if (history?.disposition === "applied" && active?.revision === history.revision) {
      return !reconcile || clear(reconcile) ? ok({ ...view, state: "applied", pending: null }) : fail("unavailable");
    }
    if (reconcile) {
      if (history && active && active.revision > history.revision && clear(reconcile)) return ok(view);
      return ok(unconfirmed(reconcile));
    }
    return history ? ok(view) : fail("unknown_operation");
  }
  if (state === "recovery_required") return fail("recovery_required");
  if (!active) return fail("not_ready");
  if (pending || active.revision !== expected) return fail("conflict");
  const operationId = `${enrollment.epoch}.${expected}.${randomBytes(16).toString("hex")}`;
  const submission: Submission = { kind: action.kind, proposal: { version: 1, operationId, expectedRevision: expected, host: host! } };
  if (changed()) return conflict();
  try { if (!domainSubmission(enrollment, { claim: submission }).claimed) return fail("conflict"); }
  catch { return fail("unavailable"); }
  if (changed()) return conflict();
  const claim = await client.propose(action.kind, submission.proposal);
  if (changed()) return conflict();
  if (!claim.ok && (claim.code === "fenced" || claim.code === "recovery_required")) return ok(unconfirmed(submission, true));
  if (!claim.ok && claim.code !== "unavailable" && claim.code !== "unsupported") {
    return clear(submission) ? wireFailure(claim.code) : ok(unconfirmed(submission));
  }
  const response = claim.ok && wireObject(claim.value);
  const accepted = response && response.operationId === operationId && domainUInt(response.revision) && response.revision > expected &&
    pendingDomains({ ...response, operation: action.kind, host });
  // The preflight lease is not proof after another SSH call, even if it has not timed out.
  return ok(accepted ? { state: "pending", active: null, pending: accepted } : unconfirmed(submission));
}