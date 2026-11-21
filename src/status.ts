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

// A run counts as live while its process exists and it keeps refreshing the file. `run`, `status`
// and `doctor` all use this one rule.
export function isLiveRun(s: State, alive: (pid: number) => boolean, now: number, staleMs: number = DEFAULTS.staleMs): boolean {
  return s.state !== "stopped" && alive(s.pid) && now - Date.parse(s.updatedAt) <= staleMs;
}

export interface Target {
  server: { host: string; port: number };
  remotePort: number;
}

// Maps state.json to what `status` reports. A host key mismatch outlives its process: the run
// exits on it, and the user must still be told why.
export function evaluateStatus(
  s: State | null,
  alive: (pid: number) => boolean,
  now: number,
  staleMs: number = DEFAULTS.staleMs,
  target?: Target,
): StatusView {
  if (!s) return STOPPED;
  // state.json sits beside the config, so it can describe a tunnel to another server or port:
  // the config was edited while `run` is up, or two configs share the directory. That tunnel is
  // not this config's tunnel.
  if (
    target &&
    (s.server.host !== target.server.host || s.server.port !== target.server.port || s.remotePort !== target.remotePort)
  ) {
    return isLiveRun(s, alive, now, staleMs) ? { ...STOPPED, reason: "config_changed", pid: s.pid } : STOPPED;
  }
  const live = alive(s.pid);
  const view = { state: s.state, reason: s.reason, since: s.since, retryAt: s.retryAt, pid: live ? s.pid : null };
  if (s.state === "blocked" && s.reason === "host_key_mismatch") {
    return { ...view, exit: EXIT.hostKeyMismatch };
  }
  if (s.state === "stopped" || !live) return { ...STOPPED, since: s.state === "stopped" ? s.since : null };
  if (!isLiveRun(s, alive, now, staleMs)) return { ...STOPPED, reason: "stale", pid: s.pid };
  if (s.state === "connected") return { ...view, exit: EXIT.ok };
  if (s.state === "blocked") return { ...view, exit: EXIT.portBlocked };
  return { ...view, exit: EXIT.down };
}
