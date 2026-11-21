// Shipped limits and timings (plan criterion 58). Tests inject smaller values; nothing else may.
export const DEFAULTS = {
  maxHeadBytes: 8192,
  headTimeoutMs: 10_000,
  connectTimeoutMs: 10_000, // DNS lookup and outbound connect, each
  idleTimeoutMs: 300_000,
  relayCap: 256,
  keepaliveIntervalMs: 15_000,
  keepaliveCountMax: 3,
  heartbeatMs: 30_000,
  staleMs: 90_000,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  blockedRetryMs: 30_000,
  remotePort: 8888,
} as const;

// Plan door 1.
export const EXIT = {
  ok: 0,
  internal: 1,
  usage: 2,
  down: 10,
  portBlocked: 11,
  domainRefused: 12,
  hostKeyMismatch: 13,
  lockdown: 14,
} as const;
