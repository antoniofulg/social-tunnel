import { randomBytes } from "node:crypto";
import type { ManagedEnrollment } from "./domain-enrollment";
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
  if (code === "fenced" || code === "recovery_required") return fail("recovery_required");
  if (code === "invalid_request" || code === "receipt_mismatch") return fail("unavailable");
  if (code === "unauthorized" || code === "limit") return fail("unavailable");
  return fail(code);
}

export async function domainAction(
  action: DomainAction, enrollment: ManagedEnrollment | null | undefined,
  client: DomainClient | null, local: () => DomainRevision | null,
): Promise<Outcome> {
  if (!enrollment || !client) return ok(SETUP_REQUIRED);
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
  const started = performance.now();
  const read = await client.inspect();
  if (!read.ok) {
    if (action.kind === "list" && read.code !== "unsupported") {
      return ok(read.code === "fenced" || read.code === "recovery_required" ? { ...UNKNOWN_DOMAINS, state: "recovery_required" } : UNKNOWN_DOMAINS);
    }
    return wireFailure(read.code);
  }
  const authority = parseAuthorityView(read.value, enrollment);
  if (!authority) return action.kind === "list" ? ok(UNKNOWN_DOMAINS) : fail("not_ready");
  const active = matchingActive(authority, local(), performance.now() - started);
  const pending = pendingDomains(authority.pending);
  const state = authority.state === "ready" && !active ? "activation_unknown" : authority.state;
  const view = { state, active, pending } as const;
  if (action.kind === "list") return ok(view);
  if (action.kind === "retry") {
    const history = authority.history.find((item) => item.operationId === action.id);
    if (history?.disposition === "cancelled") return fail("operation_cancelled");
    if (state === "recovery_required" || history?.disposition === "recovery_required") return fail("recovery_required");
    if (pending?.operationId === action.id) return ok(view);
    if (!history) return fail("unknown_operation");
    if (history.disposition === "applied" && active?.revision === history.revision) return ok({ ...view, state: "applied" });
    return ok(view);
  }
  if (state === "recovery_required") return fail("recovery_required");
  if (!active) return fail("not_ready");
  if (pending || active.revision !== expected) return fail("conflict");
  const operationId = `${enrollment.epoch}.${expected}.${randomBytes(16).toString("hex")}`;
  const claim = await client.propose(action.kind, { version: 1, operationId, expectedRevision: expected, host: host! });
  if (!claim.ok && claim.code !== "unavailable" && claim.code !== "unsupported") return wireFailure(claim.code);
  const response = claim.ok && wireObject(claim.value);
  const accepted = response && response.operationId === operationId && domainUInt(response.revision) && response.revision > expected &&
    pendingDomains({ ...response, operation: action.kind, host });
  if (accepted) return ok({ state: "pending", active, pending: accepted });
  return ok({ state: "activation_unknown", active: null, pending: {
    operationId, operation: action.kind, host, phase: "unconfirmed", pendingMayGoDirect: action.kind === "add",
  } });
}