import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { hashBytes, protectedDirectory, renderDomainPolicy, syncDirectory, type DomainPolicySink, type PolicyRevision } from "./domain-policy";
import { isAllowed } from "./host";
import { normalizeManagedDomain, parseManagedDomainSnapshot, type ManagedDomainSnapshot } from "./managed-domains";

const MAX_REQUEST = 4096;
const MAX_HISTORY = 32;
const MAX_STATE = 256 * 1024;
const JOURNAL = "domains.sqlite";
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

type Edit = "add" | "remove";
export type PublisherPrincipal =
  | { role: "editor"; enrollment: string; epoch: number }
  | { role: "proxy"; enrollment: string; epoch: number; generation: string }
  | { role: "local_admin"; enrollment: string };

export interface PublisherOptions<Session> {
  journalDir: string;
  enrollment: string;
  proxyPort: number;
  policy: DomainPolicySink;
  // Trusted transport context, not JSON supplied by a request. An epoch belongs to the session
  // at authentication, never to the last epoch read from the journal.
  identify: (session: Session) => PublisherPrincipal | null;
}

export interface VerifiedPublisherBaseline {
  epoch: number;
  revision: number;
  domains: readonly string[];
  proxyGeneration: string;
}

interface Proposal {
  operationId: string;
  expectedRevision: number;
  host: string;
}

type Intent = { kind: Edit; proposal: Proposal } | { kind: "recovery"; releaseDirect: readonly string[] };
type Target = { policy: PolicyRevision; domains: readonly string[]; domainsDigest: string };
type Phase = "claimed" | "activating" | "publishing" | "published";

export interface PublisherOperation {
  operationId: string;
  expectedRevision: number;
  proxyGeneration: string;
  intent: Intent;
  target: Target;
  phase: Phase;
}

export interface ProxyPublicationReceipt {
  enrollment: string;
  epoch: number;
  operationId: string;
  revision: number;
  domainsDigest: string;
  proxyGeneration: string;
}

type Archived = { operationId: string; revision: number; disposition: "cancelled" | "recovery_required" };
type Recovery = { operationId: string; ceiling: readonly string[]; retainRoutes: readonly string[] };

type JournalState = {
  version: 1;
  enrollment: string;
  proxyPort: number;
  epoch: number;
  proxyGeneration: string;
  editingEnabled: boolean;
  allocatedRevision: number;
  lastProven: Target;
  recordedPolicy: PolicyRevision;
  possiblyWritten: PolicyRevision | null;
  pending: PublisherOperation | null;
  recovery: Recovery | null;
  history: Archived[];
};

export type PublisherView = Pick<JournalState, "epoch" | "lastProven" | "recordedPolicy" | "pending" | "recovery" | "history">;

type Failure = "unauthorized" | "fenced" | "invalid_request" | "invalid_domain" | "duplicate_domain" | "domain_not_found"
  | "limit" | "conflict" | "recovery_required" | "not_ready" | "unknown_operation" | "receipt_mismatch" | "unavailable";
type Failed = { ok: false; code: Failure };
export type PublisherResult<T> = { ok: true; value: T } | Failed;
const fail = (code: Failure): Failed => ({ ok: false, code });
const ok = <T>(value: T): PublisherResult<T> => ({ ok: true, value });
const uint = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const tag = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 64 && !/[^A-Za-z0-9_-]/.test(value);

function exact(value: unknown, fieldCount: number): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === fieldCount;
}

function operationId(value: unknown, epoch: number, expected: number): value is string {
  const prefix = `${epoch}.${expected}.`;
  return typeof value === "string" && value.length === prefix.length + 32 && value.startsWith(prefix) && !/[^0-9a-f]/.test(value.slice(prefix.length));
}

function decodeProposal(bytes: Uint8Array, epoch: number): PublisherResult<Proposal> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_REQUEST) return fail("limit");
  try {
    const text = utf8.decode(bytes);
    const data: unknown = JSON.parse(text);
    if (!exact(data, 4) || data.version !== 1 || !uint(data.expectedRevision) ||
        !operationId(data.operationId, epoch, data.expectedRevision)) return fail("invalid_request");
    // It is a flat object with four scalar fields. Do not silently accept last-key-wins JSON.
    if ([...text.matchAll(/[{,]\s*"(?:[^"\\]|\\.)*"\s*:/g)].length !== 4) return fail("invalid_request");
    const host = normalizeManagedDomain(data.host);
    if (host === null) return fail("invalid_domain");
    return ok({ operationId: data.operationId, expectedRevision: data.expectedRevision, host });
  } catch { return fail("invalid_request"); }
}

function snapshot(revision: number, entries: unknown): ManagedDomainSnapshot | null {
  const result = parseManagedDomainSnapshot(revision, entries);
  return result.ok ? result.snapshot : null;
}

function target(epoch: number, domains: ManagedDomainSnapshot, routes = domains.domains): Target {
  return { domains: domains.domains, domainsDigest: hashBytes(JSON.stringify(domains.domains)), policy: { epoch, revision: domains.revision, routes } };
}

function journal<Session>(options: PublisherOptions<Session>, initial?: JournalState) {
  const { journalDir, enrollment, proxyPort } = options;
  if (!tag(enrollment) || !Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) throw new Error("invalid publisher enrollment");
  const dir = protectedDirectory(journalDir, true);
  const path = join(journalDir, JOURNAL);
  if (initial) closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
  const file = lstatSync(path);
  const safeFile = (info: typeof file) => info.isFile() && info.uid === dir.uid && info.nlink === 1 && !(info.mode & 0o077);
  const check = () => {
    const current = protectedDirectory(journalDir, true);
    const db = lstatSync(path);
    const rollback = lstatSync(path + "-journal", { throwIfNoEntry: false });
    if (current.dev !== dir.dev || current.ino !== dir.ino || db.dev !== file.dev || db.ino !== file.ino ||
        !safeFile(db) || (rollback && !safeFile(rollback)) || lstatSync(path + "-wal", { throwIfNoEntry: false }) ||
        lstatSync(path + "-shm", { throwIfNoEntry: false })) throw new Error("unsafe managed journal");
  };
  check();
  const db = new Database(path, { create: false, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 500");
    // In DELETE mode, EXTRA also syncs the directory after unlinking the rollback journal.
    db.run("PRAGMA synchronous = EXTRA");
    db.run("PRAGMA trusted_schema = OFF");
    if (db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "delete") {
      throw new Error("unsupported managed journal mode");
    }
    if (db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous !== 3) {
      throw new Error("managed journal requires EXTRA synchronization");
    }
    const put = (state: JournalState) => {
      const body = JSON.stringify(state);
      if (Buffer.byteLength(body) > MAX_STATE) throw new Error("managed journal limit");
      db.query("INSERT INTO control VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body, digest = excluded.digest")
        .run(body, hashBytes(body));
    };
    if (initial) {
      db.transaction(() => {
        db.run("CREATE TABLE control (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL, digest TEXT NOT NULL) STRICT");
        put(initial);
      }).immediate();
      syncDirectory(journalDir);
    }
    const row = db.query<{ body: string; digest: string }, [number]>(
      "SELECT body, digest FROM control WHERE id = 1 AND length(CAST(body AS BLOB)) <= ?",
    );
    const load = (): JournalState => {
      const saved = row.get(MAX_STATE);
      if (!saved || typeof saved.body !== "string" || hashBytes(saved.body) !== saved.digest) throw new Error("invalid managed journal");
      const state: JournalState = JSON.parse(saved.body);
      if (state.version !== 1 || state.enrollment !== enrollment || state.proxyPort !== proxyPort) throw new Error("wrong journal binding");
      return state;
    };
    load();
    return {
      transact<T>(work: (state: JournalState, save: () => void) => PublisherResult<T>): PublisherResult<T> {
        try {
          check();
          return db.transaction(() => {
            const state = load();
            return work(state, () => put(state));
          }).immediate();
        } catch { return fail("unavailable"); }
      },
      close: () => db.close(),
    };
  } catch (error) {
    db.close();
    throw error;
  }
}

// Trusted bootstrap only. The caller supplies an independently verified baseline. Provision never
// overwrites a journal, and a runtime open never recreates one that was lost or corrupt.
export function provisionDomainPublisher<Session>(options: PublisherOptions<Session>, baseline: VerifiedPublisherBaseline): void {
  const domains = snapshot(baseline.revision, baseline.domains);
  if (!domains || !uint(baseline.epoch) || !tag(baseline.proxyGeneration)) throw new Error("invalid publisher baseline");
  const lastProven = target(baseline.epoch, domains);
  if (options.policy.read() !== renderDomainPolicy(options.proxyPort, lastProven.policy)) throw new Error("publisher baseline policy differs");
  journal(options, {
    version: 1, enrollment: options.enrollment, proxyPort: options.proxyPort, epoch: baseline.epoch,
    proxyGeneration: baseline.proxyGeneration, editingEnabled: true, allocatedRevision: domains.revision,
    lastProven, recordedPolicy: lastProven.policy, possiblyWritten: null, pending: null, recovery: null, history: [],
  }).close();
}

export function openDomainPublisher<Session>(options: PublisherOptions<Session>) {
  const { policy, proxyPort, identify } = options;
  const store = journal(options);
  let windowStart = performance.now();
  let proposals = 0;
  const rendered = (revision: PolicyRevision) => renderDomainPolicy(proxyPort, revision);
  const authorize = (state: JournalState, session: Session, role?: PublisherPrincipal["role"]): Failed | null => {
    const identity = identify(session);
    if (!identity || identity.enrollment !== state.enrollment || (role && identity.role !== role)) return fail("unauthorized");
    if (identity.role !== "local_admin" && identity.epoch !== state.epoch) return fail("fenced");
    if (identity.role === "proxy" && identity.generation !== state.proxyGeneration) return fail("fenced");
    return null;
  };

  function inspect(session: Session): PublisherResult<PublisherView> {
    return store.transact((state) => authorize(state, session) ?? ok({
      epoch: state.epoch, lastProven: state.lastProven, recordedPolicy: state.recordedPolicy,
      pending: state.pending, recovery: state.recovery, history: state.history,
    }));
  }

  function propose(session: Session, kind: Edit, bytes: Uint8Array): PublisherResult<PublisherOperation> {
    return store.transact((state, save) => {
      const denied = authorize(state, session, "editor");
      if (denied) return denied;
      const now = performance.now();
      if (now - windowStart >= 60000) { windowStart = now; proposals = 0; }
      if (proposals >= 64) return fail("limit");
      proposals++;
      if (state.recovery) return fail("recovery_required");
      if (!state.editingEnabled) return fail("not_ready");
      if (kind !== "add" && kind !== "remove") return fail("invalid_request");
      const result = decodeProposal(bytes, state.epoch);
      if (!result.ok) return result;
      const proposal = result.value;
      const pending = state.pending;
      if (pending) {
        return pending.operationId === proposal.operationId && pending.intent.kind === kind && pending.intent.proposal.host === proposal.host
          ? ok(pending) : fail("conflict");
      }
      if (proposal.expectedRevision !== state.lastProven.policy.revision || state.allocatedRevision === Number.MAX_SAFE_INTEGER) return fail("conflict");
      const before = state.lastProven.domains;
      const present = before.includes(proposal.host);
      if (kind === "add" && present) return fail("duplicate_domain");
      if (kind === "remove" && !present) return fail("domain_not_found");
      const revision = state.allocatedRevision + 1;
      const domains = snapshot(revision, kind === "add" ? [...before, proposal.host] : before.filter((d) => d !== proposal.host));
      if (!domains) return fail("limit");
      // Retain deny-only selectors left by administrator recovery across ordinary edits.
      const retained = state.lastProven.policy.routes.filter((d) => !before.includes(d));
      const routes = snapshot(revision, [...new Set([...domains.domains, ...retained])]);
      if (!routes) return fail("limit");
      if (policy.read() !== rendered(state.recordedPolicy)) return fail("not_ready");
      const operation: PublisherOperation = {
        operationId: proposal.operationId, expectedRevision: proposal.expectedRevision, proxyGeneration: state.proxyGeneration,
        intent: { kind, proposal }, target: target(state.epoch, domains, routes.domains), phase: "claimed",
      };
      state.allocatedRevision = revision;
      state.pending = operation;
      save();
      return ok(operation);
    });
  }

  // Only a fresh claimed -> activating CAS grants permission to start the home mutation. A lost
  // response is uncertain: inspect the same immutable intent; don't send home a new instruction.
  function beginActivation(session: Session, id: string): PublisherResult<PublisherOperation> {
    return store.transact((state, save) => {
      const denied = authorize(state, session, "proxy");
      if (denied) return denied;
      const operation = state.pending;
      if (!operation || operation.operationId !== id) return fail("unknown_operation");
      if (operation.phase !== "claimed" || operation.target.policy.epoch !== state.epoch) return fail("conflict");
      if (policy.read() !== rendered(state.recordedPolicy)) return fail("not_ready");
      operation.phase = "activating";
      save();
      return ok(operation);
    });
  }

  function verifyReceipt(state: JournalState, session: Session, receipt: unknown): PublisherResult<PublisherOperation> {
    const denied = authorize(state, session, "proxy");
    if (denied) return denied;
    const operation = state.pending;
    if (!operation || operation.phase === "claimed" || !exact(receipt, 6) ||
        receipt.enrollment !== state.enrollment || receipt.epoch !== state.epoch || receipt.epoch !== operation.target.policy.epoch ||
        receipt.proxyGeneration !== state.proxyGeneration || receipt.proxyGeneration !== operation.proxyGeneration ||
        receipt.operationId !== operation.operationId || receipt.revision !== operation.target.policy.revision ||
        receipt.domainsDigest !== operation.target.domainsDigest) return fail("receipt_mismatch");
    return ok(operation);
  }

  // The durable publishing phase precedes filesystem effects. The second transaction re-authenticates
  // and holds the same CAS lock across compare/rename/readback, excluding an intervening disable.
  function publish(session: Session, receipt: unknown): PublisherResult<PublisherOperation> {
    const armed = store.transact((state, save) => {
      const checked = verifyReceipt(state, session, receipt);
      if (!checked.ok) return checked;
      const operation = checked.value;
      if (operation.phase === "activating") {
        if (policy.read() !== rendered(state.recordedPolicy)) return fail("not_ready");
        operation.phase = "publishing";
        save();
      }
      return ok(operation);
    });
    if (!armed.ok) return armed;
    return store.transact((state, save) => {
      const checked = verifyReceipt(state, session, receipt);
      if (!checked.ok) return checked;
      const operation = checked.value;
      const next = rendered(operation.target.policy);
      const found = policy.read();
      if (operation.phase === "published") return found === next ? ok(operation) : fail("unavailable");
      if (operation.phase !== "publishing" || (found !== rendered(state.recordedPolicy) && found !== next)) return fail("unavailable");
      policy.replace(found, next);
      if (policy.read() !== next) return fail("unavailable");
      state.recordedPolicy = operation.target.policy;
      state.possiblyWritten = null;
      operation.phase = "published";
      save();
      return ok(operation);
    });
  }

  function disable(session: Session, expectedEpoch: number): PublisherResult<number> {
    return store.transact((state, save) => {
      const denied = authorize(state, session, "local_admin");
      if (denied) return denied;
      if (state.epoch !== expectedEpoch || state.epoch === Number.MAX_SAFE_INTEGER) return fail("conflict");
      const operation = state.pending;
      if (operation) {
        const noEffect = operation.phase === "claimed";
        if (!noEffect) {
          const held = state.recovery?.retainRoutes ?? state.lastProven.policy.routes;
          const mayHavePublished = operation.phase === "publishing" || operation.phase === "published";
          const retainRoutes = mayHavePublished ? [...new Set([...held, ...operation.target.policy.routes])].sort() : held;
          // An unacknowledged removal might already have revoked access; an add might never have applied.
          state.recovery = {
            operationId: state.recovery?.operationId ?? operation.operationId,
            ceiling: operation.intent.kind === "add" ? state.lastProven.domains : operation.target.domains,
            retainRoutes,
          };
          if (operation.phase === "publishing") state.possiblyWritten = operation.target.policy;
        }
        state.history.push({ operationId: operation.operationId, revision: operation.target.policy.revision, disposition: noEffect ? "cancelled" : "recovery_required" });
        if (state.history.length > MAX_HISTORY) state.history.shift();
        state.pending = null;
      }
      state.epoch++;
      state.editingEnabled = false;
      save();
      return ok(state.epoch);
    });
  }

  // Local administrator only. Select a home subset and explicitly release PAC selectors; omitting
  // a host from the home list never drops its uncertain route to DIRECT.
  function authorizeRecovery(
    session: Session,
    request: { epoch: number; operationId: string; proxyGeneration: string; domains: readonly string[]; releaseDirect: readonly string[] },
  ): PublisherResult<PublisherOperation> {
    return store.transact((state, save) => {
      const denied = authorize(state, session, "local_admin");
      if (denied) return denied;
      if (request.epoch !== state.epoch || state.pending || state.allocatedRevision === Number.MAX_SAFE_INTEGER) return fail("conflict");
      const recovery = state.recovery;
      if (!recovery) return fail("not_ready");
      const expected = state.lastProven.policy.revision;
      if (!operationId(request.operationId, state.epoch, expected) || !tag(request.proxyGeneration)) return fail("invalid_request");
      const revision = state.allocatedRevision + 1;
      const domains = snapshot(revision, request.domains);
      const release = snapshot(revision, request.releaseDirect);
      const ceiling = snapshot(revision, recovery.ceiling);
      if (!domains || !release || !ceiling || !domains.domains.every(ceiling.allows) ||
          !release.domains.every((d) => recovery.retainRoutes.includes(d))) return fail("invalid_domain");
      const routes = snapshot(revision, recovery.retainRoutes.filter((d) => !release.domains.includes(d)));
      if (!routes || !domains.domains.every((d) => isAllowed(d, routes.domains))) return fail("invalid_domain");
      const found = policy.read();
      if (found !== rendered(state.recordedPolicy)) {
        if (!state.possiblyWritten || found !== rendered(state.possiblyWritten)) return fail("not_ready");
        policy.replace(found, found);
        state.recordedPolicy = state.possiblyWritten;
      }
      state.possiblyWritten = null;
      const operation: PublisherOperation = {
        operationId: request.operationId, expectedRevision: expected, proxyGeneration: request.proxyGeneration,
        intent: { kind: "recovery", releaseDirect: release.domains }, target: target(state.epoch, domains, routes.domains), phase: "claimed",
      };
      state.pending = operation;
      state.allocatedRevision = revision;
      state.proxyGeneration = request.proxyGeneration;
      save();
      return ok(operation);
    });
  }

  return { inspect, propose, beginActivation, publish, disable, authorizeRecovery, close: store.close };
}
