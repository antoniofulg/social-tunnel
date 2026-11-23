import { getPublicSuffix, parse } from "tldts";
import { matchesDomain, normalizeHost } from "./host";

const PSL = { extractHostname: false, allowPrivateDomains: true, detectSpecialUse: true };
const MAX_DOMAINS = 128;
const validated = Symbol("managed domain snapshot");

export function normalizeManagedDomain(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 254 || /[^A-Za-z0-9.-]/.test(raw)) return null;
  const host = normalizeHost(raw);
  if (!host || /^-|-\.|\.-|-$/.test(host)) return null;

  // Include private PSL rules; the PSL's implicit wildcard is not proof of a public suffix.
  // IANA special-use names include the reserved .invalid route witnesses.
  const { domain, isIcann, isPrivate, isSpecialUse } = parse(host, PSL);
  return domain && (isIcann || isPrivate) && !isSpecialUse ? host : null;
}

export interface ManagedDomainSnapshot {
  readonly [validated]: true;
  readonly revision: number;
  readonly domains: readonly string[];
  readonly allows: (host: string) => boolean;
}

type SnapshotResult =
  | { ok: true; snapshot: ManagedDomainSnapshot }
  | { ok: false; code: "invalid_revision" | "invalid_domain" | "duplicate_domain" | "too_many_domains" };

// Validation and immutability only: the in-process caller must verify the baseline or intent.
export function parseManagedDomainSnapshot(revision: unknown, entries: unknown): SnapshotResult {
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
    return { ok: false, code: "invalid_revision" };
  }
  if (!Array.isArray(entries)) return { ok: false, code: "invalid_domain" };
  if (entries.length > MAX_DOMAINS) return { ok: false, code: "too_many_domains" };
  const unique = new Set<string>();
  for (const entry of entries) {
    const host = normalizeManagedDomain(entry);
    if (host === null) return { ok: false, code: "invalid_domain" };
    if (unique.has(host)) return { ok: false, code: "duplicate_domain" };
    unique.add(host);
  }
  const domains = Object.freeze([...unique].sort());
  const allows = (host: string): boolean => {
    if (domains.length === 0) return false;
    const suffix = getPublicSuffix(host, PSL);
    // A parent cannot grant an entire private suffix delegated underneath it.
    return suffix !== null && domains.some((domain) => domain.length > suffix.length && matchesDomain(host, domain));
  };
  return { ok: true, snapshot: Object.freeze({ [validated]: true as const, revision, domains, allows }) };
}
