const LABELS = /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/;

// Lower-cases, drops one trailing dot, and returns the host only when it is plain DNS labels.
export function normalizeHost(raw: string): string | null {
  let host = raw.toLowerCase();
  if (host.endsWith(".")) host = host.slice(0, -1);
  return host.length <= 253 && LABELS.test(host) ? host : null;
}

// Label-boundary match: `evilinstagram.com` must not match `instagram.com`.
export function matchesDomain(host: string, domain: string): boolean {
  return host.endsWith(domain) && (host.length === domain.length || host[host.length - domain.length - 1] === ".");
}

export function isAllowed(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => matchesDomain(host, domain));
}
