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
  | { role: "observer"; enrollment: string; epoch: number; generation: string }
  | { role: "local_admin"; enrollment: string };

export interface IdleReservationScope {
  enrollment: string;
  epoch: number;
  operationId: string;
  revision: number;
  domainsDigest: string;
  policyPreimageDigest: string;
}

type IdleReservationOrigin = Readonly<{ id: string; scope: Readonly<IdleReservationScope> }>;
type IdleWindowBinding = Readonly<{ id: string; operationDigest: string }>;

export function idleWindowDigest(scope: Readonly<IdleReservationScope>): string {
  const { enrollment, epoch, operationId, revision, domainsDigest, policyPreimageDigest } = scope;
  return hashBytes(JSON.stringify(["domains-idle-window-v1", enrollment, epoch, operationId, revision, domainsDigest, policyPreimageDigest]));
}

export interface PublisherOptions<Session> {
  journalDir: string;
  enrollment: string;
  proxyPort: number;
  policy: DomainPolicySink;
  // Trusted transport context, not JSON supplied by a request. An epoch belongs to the session
  // at authentication, never to the last epoch read from the journal.
  identify: (session: Session) => PublisherPrincipal | null;
  // Protected local runner only. It must hold admissions until the grant can
  // no longer take effect, including across disconnect, abort and restart.
  // A recovery must prove its new scope while retaining the exact predecessor's hold.
  currentIdleReservation?: (scope: Readonly<IdleReservationScope>, recoveryOf?: IdleReservationOrigin) => string | null;
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

export interface ProxyPreimage { generation: string; revision: number; domainsDigest: string }

export interface PublisherOperation {
  operationId: string;
  expectedRevision: number;
  proxyGeneration: string;
  intent: Intent;
  target: Target;
  phase: Phase;
  homePreimage?: ProxyPreimage;
}

export interface ProxyPublicationReceipt {
  enrollment: string;
  epoch: number;
  operationId: string;
  revision: number;
  domainsDigest: string;
  proxyGeneration: string;
}

export interface BrowserFinalization {
  enrollment: string;
  epoch: number;
  operationId: string;
  revision: number;
  domainsDigest: string;
  proxyGeneration: string;
  browserGeneration: string;
  policyDigest: string;
  positive: string;
  negative: string;
}

type Archived = { operationId: string; revision: number; disposition: "cancelled" | "recovery_required" | "applied" | "reconciled" };
type Recovery = { operationId: string; ceiling: readonly string[]; retainRoutes: readonly string[] };

type JournalState = {
  version: 1 | 4;
  enrollment: string;
  proxyPort: number;
  epoch: number;
  proxyGeneration: string;
  editingEnabled: boolean;
  allocatedRevision: number;
  lastProven: Target;
  recordedPolicy: PolicyRevision;
  possiblyWritten: PolicyRevision | null;
  syncInterruptedRecovery?: true;
  idleReservation?: { id: string; policyPreimageDigest: string };
  idleRecoveryOrigin?: IdleReservationOrigin;
  completedIdleWindow?: IdleWindowBinding & { policyDigest: string };
  pending: PublisherOperation | null;
  recovery: Recovery | null;
  history: Archived[];
  lastBrowserProof?: BrowserFinalization;
  cancelledUnadmitted?: string[];
};

export type PublisherView = Pick<JournalState, "epoch" | "proxyGeneration" | "editingEnabled" | "lastProven" | "lastBrowserProof" | "recordedPolicy" | "pending" | "recovery" | "history">;

type Failure = "unauthorized" | "fenced" | "invalid_request" | "invalid_domain" | "duplicate_domain" | "domain_not_found"
  | "limit" | "conflict" | "recovery_required" | "not_ready" | "unknown_operation" | "receipt_mismatch" | "unavailable"
  | "operation_cancelled" | "superseded";
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
  const version = options.currentIdleReservation === undefined ? 1 : 4;
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
      if (state.version !== version || state.enrollment !== enrollment || state.proxyPort !== proxyPort) {
        throw new Error("wrong journal binding");
      }
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
    version: options.currentIdleReservation === undefined ? 1 : 4,
    enrollment: options.enrollment, proxyPort: options.proxyPort, epoch: baseline.epoch,
    proxyGeneration: baseline.proxyGeneration, editingEnabled: true, allocatedRevision: domains.revision,
    lastProven, recordedPolicy: lastProven.policy, possiblyWritten: null, pending: null, recovery: null, history: [],
  }).close();
}

export function openDomainPublisher<Session>(options: PublisherOptions<Session>) {
  const { policy, proxyPort, identify, currentIdleReservation } = options;
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

  function reservationScope(state: JournalState, operation: PublisherOperation, policyPreimageDigest: string): IdleReservationScope {
    return {
      enrollment: state.enrollment, epoch: operation.target.policy.epoch, operationId: operation.operationId,
      revision: operation.target.policy.revision, domainsDigest: operation.target.domainsDigest, policyPreimageDigest,
    };
  }

  function reservationId(state: JournalState, operation: PublisherOperation, policyPreimageDigest: string) {
    const origin = state.idleRecoveryOrigin;
    if (state.recovery && !origin) return null;
    const scope = reservationScope(state, operation, policyPreimageDigest);
    if (!origin) return currentIdleReservation?.(scope);
    const { id } = origin;
    return currentIdleReservation?.(scope, { id, scope: { ...origin.scope } }) === id ? id : null;
  }

  function holdsReservation(state: JournalState, operation: PublisherOperation) {
    if (state.version === 1) return true;
    const bound = state.idleReservation;
    return !!bound && reservationId(state, operation, bound.policyPreimageDigest) === bound.id;
  }

  function activationPreimage(state: JournalState, operation: PublisherOperation) {
    const sync = operation.intent.kind === "recovery" && state.syncInterruptedRecovery === true;
    const selected = sync ? state.possiblyWritten : state.recordedPolicy;
    if (!selected) return null;
    const bytes = rendered(selected);
    return policy.read() === bytes ? { bytes, selected, sync } : null;
  }

  function inspectIdleCandidate(session: Session) {
    return store.transact((state) => {
      const denied = authorize(state, session, "local_admin");
      if (denied) return denied;
      const operation = state.pending;
      if (state.version === 1 || operation?.phase !== "claimed" || operation.target.policy.epoch !== state.epoch ||
          (state.recovery && !state.idleRecoveryOrigin)) return fail("not_ready");
      const preimage = activationPreimage(state, operation);
      if (!preimage) return fail("not_ready");
      const scope = reservationScope(state, operation, hashBytes(preimage.bytes));
      const origin = state.idleRecoveryOrigin;
      return ok({ scope, recoveryOf: origin ?? null, operationDigest: idleWindowDigest(origin?.scope ?? scope) });
    });
  }

  function policyImage(state: JournalState, bytes: string) {
    if (bytes === rendered(state.recordedPolicy)) return "recorded";
    if (state.pending?.phase === "publishing" && bytes === rendered(state.pending.target.policy)) return "publishing";
    if (!state.editingEnabled && state.recovery && state.possiblyWritten && bytes === rendered(state.possiblyWritten)) return "interrupted";
    return null;
  }

  function inspectPolicy(session: Session) {
    return store.transact((state) => {
      const denied = authorize(state, session, "local_admin");
      if (denied) return denied;
      const image = policyImage(state, policy.read());
      return image ? ok(image) : fail("not_ready");
    });
  }

  function inspectCompletedIdleWindow(session: Session, binding: unknown): PublisherResult<null> {
    return store.transact((state) => {
      const denied = authorize(state, session, "local_admin");
      if (denied) return denied;
      if (!exact(binding, 2)) return fail("invalid_request");
      const { id, operationDigest } = binding;
      if (!tag(id) || typeof operationDigest !== "string" || operationDigest.length !== 64 ||
          /[^0-9a-f]/.test(operationDigest)) return fail("invalid_request");
      const completed = state.completedIdleWindow;
      if (state.version === 1 || state.recovery || (state.pending && state.pending.phase !== "claimed") ||
          completed?.id !== id || completed.operationDigest !== operationDigest) return fail("not_ready");
      const bytes = policy.read();
      return completed.policyDigest === hashBytes(bytes) && policyImage(state, bytes) === "recorded"
        ? ok(null) : fail("not_ready");
    });
  }

  function inspect(session: Session): PublisherResult<PublisherView> {
    return store.transact((state) => authorize(state, session) ?? ok({
      epoch: state.epoch, lastProven: state.lastProven, recordedPolicy: state.recordedPolicy,
      proxyGeneration: state.proxyGeneration, editingEnabled: state.editingEnabled,
      lastBrowserProof: state.lastBrowserProof,
      pending: state.pending, recovery: state.recovery, history: state.history,
    }));
  }

  function reconcile(session: Session, id: unknown): PublisherResult<null> {
    return store.transact((state, save) => {
      const denied = authorize(state, session, "editor");
      if (denied) return denied;
      if (typeof id !== "string" || id.length > 66) return fail("invalid_request");
      const expected = Number(id.split(".", 3)[1]);
      if (!uint(expected) || !operationId(id, state.epoch, expected)) return fail("invalid_request");
      const history = state.history.find((item) => item.operationId === id);
      if (history?.disposition === "cancelled") return fail("operation_cancelled");
      if (state.pending?.operationId === id || history) return ok(null);
      const revision = state.lastProven.policy.revision;
      if (expected < revision) return fail("superseded");
      if (expected !== revision) return fail("invalid_request");
      if (state.recovery || !state.editingEnabled) return fail("recovery_required");
      const cancelled = state.cancelledUnadmitted ??= [];
      if (cancelled.includes(id)) return fail("operation_cancelled");
      // Never evict a tombstone while its revision can still admit proposals.
      if (cancelled.length >= 128) return fail("limit");
      cancelled.push(id);
      save();
      return fail("operation_cancelled");
    });
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
      if (state.cancelledUnadmitted?.includes(proposal.operationId)) return fail("operation_cancelled");
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
      const preimage = activationPreimage(state, operation);
      if (!preimage) return fail("not_ready");
      const { bytes: expected, selected, sync } = preimage;
      if (state.version !== 1) {
        const policyPreimageDigest = hashBytes(expected);
        const reservation = reservationId(state, operation, policyPreimageDigest);
        if (!tag(reservation) || reservation === state.completedIdleWindow?.id) return fail("not_ready");
        state.idleReservation = { id: reservation, policyPreimageDigest };
      }
      if (sync) {
        // The claim is read-only with respect to PAC. Make the recognized
        // interrupted image durable before changing the journal or granting home.
        policy.replace(expected, expected);
        if (!holdsReservation(state, operation)) return fail("not_ready");
        state.recordedPolicy = selected;
        delete state.syncInterruptedRecovery;
      }
      if (operation.intent.kind === "recovery") state.possiblyWritten = null;
      operation.phase = "activating";
      delete state.completedIdleWindow;
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
      if (!holdsReservation(state, operation)) return fail("not_ready");
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
      if (!holdsReservation(state, operation)) return fail("not_ready");
      policy.replace(found, next);
      if (policy.read() !== next) return fail("unavailable");
      state.recordedPolicy = operation.target.policy;
      state.possiblyWritten = null;
      operation.phase = "published";
      save();
      return ok(operation);
    });
  }

  // Called only by the protected in-process observer after a fresh paired browser probe.
  // Recheck the whole publication tuple and bytes under the same lock as disable.
  function finalize(session: Session, proof: BrowserFinalization): PublisherResult<PublisherView["lastProven"]> {
    return store.transact((state, save) => {
      const denied = authorize(state, session, "observer");
      if (denied) return denied;
      const observer = identify(session);
      const pending = state.pending;
      if (!pending || pending.phase !== "published" || !proof || observer?.role !== "observer" ||
          proof.enrollment !== state.enrollment || proof.epoch !== state.epoch ||
          proof.epoch !== pending.target.policy.epoch || proof.operationId !== pending.operationId ||
          proof.revision !== pending.target.policy.revision || proof.domainsDigest !== pending.target.domainsDigest ||
          proof.proxyGeneration !== state.proxyGeneration || proof.proxyGeneration !== pending.proxyGeneration ||
          proof.browserGeneration !== observer.generation) return fail("receipt_mismatch");
      const wrongEpoch = proof.epoch === 0 ? 1 : proof.epoch - 1;
      const currentName = new RegExp(`^[a-f0-9]{32}\\.e${proof.epoch}\\.r${proof.revision}\\.pac\\.invalid$`);
      const wrongName = new RegExp(`^[a-f0-9]{32}\\.e${wrongEpoch}\\.r${proof.revision}\\.pac\\.invalid$`);
      if (!currentName.test(proof.positive) || !wrongName.test(proof.negative) ||
          proof.positive.slice(0, 32) === proof.negative.slice(0, 32)) return fail("receipt_mismatch");
      const expected = rendered(pending.target.policy);
      if (hashBytes(expected) !== proof.policyDigest || policy.read() !== expected) return fail("not_ready");
      if (!holdsReservation(state, pending)) return fail("not_ready");
      if (state.version !== 1) {
        const held = state.idleReservation;
        if (!held) return fail("not_ready");
        const origin = state.idleRecoveryOrigin;
        state.completedIdleWindow = {
          id: held.id,
          operationDigest: idleWindowDigest(origin?.scope ?? reservationScope(state, pending, held.policyPreimageDigest)),
          policyDigest: proof.policyDigest,
        };
      }
      if (pending.intent.kind === "recovery") {
        const recovery = state.recovery;
        if (recovery) {
          const archived = state.history.find((item) => item.operationId === recovery.operationId);
          if (archived) archived.disposition = "reconciled";
          else state.history.push({ operationId: recovery.operationId, revision: pending.target.policy.revision, disposition: "reconciled" });
          state.recovery = null;
          delete state.idleRecoveryOrigin;
        }
        state.editingEnabled = true;
      }
      state.history.push({ operationId: pending.operationId, revision: pending.target.policy.revision, disposition: "applied" });
      if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
      state.lastProven = pending.target;
      delete state.cancelledUnadmitted;
      state.lastBrowserProof = proof;
      state.pending = null;
      delete state.idleReservation;
      save();
      return ok(state.lastProven);
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
          const bound = state.idleReservation;
          if (!state.recovery && bound) {
            state.idleRecoveryOrigin = { id: bound.id, scope: reservationScope(state, operation, bound.policyPreimageDigest) };
          }
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
      delete state.idleReservation;
      delete state.syncInterruptedRecovery;
      delete state.cancelledUnadmitted;
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
    homePreimage?: ProxyPreimage,
  ): PublisherResult<PublisherOperation> {
    return store.transact((state, save) => {
      const denied = authorize(state, session, "local_admin");
      if (denied) return denied;
      if (request.epoch !== state.epoch || state.pending || state.allocatedRevision === Number.MAX_SAFE_INTEGER) return fail("conflict");
      if (state.editingEnabled) return fail("not_ready");
      if (homePreimage && (!tag(homePreimage.generation) || !uint(homePreimage.revision) ||
          homePreimage.revision > state.allocatedRevision || !/^[0-9a-f]{64}$/.test(homePreimage.domainsDigest))) return fail("not_ready");
      const ceilingDomains = state.recovery?.ceiling ?? state.lastProven.domains;
      const retainRoutes = state.recovery?.retainRoutes ?? state.lastProven.policy.routes;
      const expected = state.lastProven.policy.revision;
      if (!operationId(request.operationId, state.epoch, expected) || !tag(request.proxyGeneration)) return fail("invalid_request");
      const revision = state.allocatedRevision + 1;
      const domains = snapshot(revision, request.domains);
      const release = snapshot(revision, request.releaseDirect);
      const ceiling = snapshot(revision, ceilingDomains);
      if (!domains || !release || !ceiling || !domains.domains.every(ceiling.allows) ||
          !release.domains.every((d) => retainRoutes.includes(d))) return fail("invalid_domain");
      const routes = snapshot(revision, retainRoutes.filter((d) => !release.domains.includes(d)));
      if (!routes || !domains.domains.every((d) => isAllowed(d, routes.domains))) return fail("invalid_domain");
      const image = policyImage(state, policy.read());
      if (image !== "recorded" && image !== "interrupted") return fail("not_ready");
      if (image === "interrupted") state.syncInterruptedRecovery = true;
      const operation: PublisherOperation = {
        operationId: request.operationId, expectedRevision: expected, proxyGeneration: request.proxyGeneration,
        intent: { kind: "recovery", releaseDirect: release.domains }, target: target(state.epoch, domains, routes.domains), phase: "claimed",
        homePreimage,
      };
      state.pending = operation;
      state.allocatedRevision = revision;
      state.proxyGeneration = request.proxyGeneration;
      save();
      return ok(operation);
    });
  }

  return { inspect, inspectPolicy, inspectIdleCandidate, inspectCompletedIdleWindow, propose, reconcile, beginActivation,
    publish, finalize, disable, authorizeRecovery, close: store.close };
}
