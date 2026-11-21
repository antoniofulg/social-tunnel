import { DEFAULTS, EXIT } from "./defaults";
import type { State } from "./state";

export interface StatusView {
  state: string;
  reason: string | null;
  since: string | null;
  retryAt: string | null;
  pid: number | null;
  exit: number;
}

const STOPPED: StatusView = {
  state: "stopped",
  reason: null,
  since: null,
  retryAt: null,
  pid: null,
  exit: EXIT.down,
};

// Maps state.json to what `status` reports. A host key mismatch outlives its process: the run
// exits on it, and the user must still be told why.
export function evaluateStatus(
  s: State | null,
  alive: (pid: number) => boolean,
  now: number,
  staleMs: number = DEFAULTS.staleMs,
): StatusView {
  if (!s) return STOPPED;
  const live = alive(s.pid);
  const view = { state: s.state, reason: s.reason, since: s.since, retryAt: s.retryAt, pid: live ? s.pid : null };
  if (s.state === "blocked" && s.reason === "host_key_mismatch") {
    return { ...view, exit: EXIT.hostKeyMismatch };
  }
  if (s.state === "stopped" || !live) return { ...STOPPED, since: s.state === "stopped" ? s.since : null };
  if (now - Date.parse(s.updatedAt) > staleMs) return { ...STOPPED, reason: "stale", pid: s.pid };
  if (s.state === "connected") return { ...view, exit: EXIT.ok };
  if (s.state === "blocked") return { ...view, exit: EXIT.portBlocked };
  return { ...view, exit: EXIT.down };
}
