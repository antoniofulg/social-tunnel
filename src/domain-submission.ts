import { Database } from "bun:sqlite";
import { closeSync, constants, lstatSync, openSync } from "node:fs";
import { dirname } from "node:path";
import type { SelectedEnrollment } from "./domain-enrollment";
import { protectedDirectory, syncDirectory } from "./domain-policy";
import { domainUInt, operationIdFormat, wireObject, type ProposalBody } from "./domain-wire";
import { normalizeManagedDomain } from "./managed-domains";

export interface Submission { kind: "add" | "remove"; proposal: ProposalBody }
const LIMIT = 2048;

type Change = { claim: Submission } | { clear: Submission };

export function domainSubmission(enrollment: SelectedEnrollment, change?: Change): { saved: Submission | null; claimed: boolean } {
  const { submissionPath: path, submissionScope: scope, binding, epoch, proxyGeneration } = enrollment;
  const directory = dirname(path);
  const dir = protectedDirectory(directory);
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    if (!change || !("claim" in change)) return { saved: null, claimed: false };
    try {
      closeSync(openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // Every opener must make the directory entry durable before allowing a send.
  }
  for (const file of [path, path + "-journal"]) {
    const info = lstatSync(file, { throwIfNoEntry: false });
    if (!info && file !== path) continue;
    if (!info?.isFile() || info.uid !== dir.uid || info.nlink !== 1 || (info.mode & 0o077)) {
      throw new Error("unsafe domain submission journal");
    }
  }
  if (lstatSync(path + "-wal", { throwIfNoEntry: false }) || lstatSync(path + "-shm", { throwIfNoEntry: false })) {
    throw new Error("unsafe domain submission journal mode");
  }
  const db = new Database(path, { create: false, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 200");
    db.run("PRAGMA trusted_schema = OFF");
    db.run("PRAGMA synchronous = EXTRA");
    if (db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode !== "delete" ||
        db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous !== 3) {
      throw new Error("domain submission journal is not durable");
    }
    const result = db.transaction(() => {
      db.run("CREATE TABLE IF NOT EXISTS submission (slot INTEGER PRIMARY KEY CHECK (slot = 1), body TEXT NOT NULL CHECK (length(body) <= 2048)) STRICT");
      const row = db.query<{ body: string | null }, [number]>("SELECT CASE WHEN length(CAST(body AS BLOB)) <= ? THEN body END AS body FROM submission WHERE slot = 1").get(LIMIT);
      let saved: Submission | null = null;
      const stored = { version: 1, scope, binding, enrollment: enrollment.enrollment, epoch, proxyGeneration };
      if (row) {
        const entry = row.body === null ? null : wireObject(JSON.parse(row.body));
        const p = wireObject(entry?.proposal);
        if (!entry || entry.version !== stored.version || entry.scope !== scope || entry.binding !== binding || entry.enrollment !== stored.enrollment ||
            entry.epoch !== epoch || entry.proxyGeneration !== proxyGeneration || (entry.kind !== "add" && entry.kind !== "remove") ||
            !p || p.version !== 1 || !operationIdFormat(p.operationId) || !domainUInt(p.expectedRevision) ||
            !p.operationId.startsWith(`${entry.epoch}.${p.expectedRevision}.`) || typeof p.host !== "string" || normalizeManagedDomain(p.host) !== p.host) {
          throw new Error("invalid managed submission journal");
        }
        saved = { kind: entry.kind, proposal: { version: 1, operationId: p.operationId, expectedRevision: p.expectedRevision, host: p.host } };
      }
      if (change && "clear" in change && saved?.proposal.operationId === change.clear.proposal.operationId) {
        db.run("DELETE FROM submission WHERE slot = 1");
        return { saved: null, claimed: false };
      }
      if (change && "claim" in change && !saved) {
        db.run("INSERT INTO submission VALUES (1, ?)", [JSON.stringify({ ...stored, ...change.claim })]);
        return { saved: change.claim, claimed: true };
      }
      return { saved, claimed: false };
    }).immediate();
    if (result.claimed) syncDirectory(directory);
    return result;
  } finally { db.close(); }
}
