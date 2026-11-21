import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

export type TunnelState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "blocked"
  | "stopped";

// Plan door 7.
export interface State {
  version: 1;
  pid: number;
  state: TunnelState;
  reason: string | null;
  since: string;
  retryAt: string | null;
  server: { host: string; port: number };
  remotePort: number;
  updatedAt: string;
}

const STATES = ["connecting", "connected", "disconnected", "reconnecting", "blocked", "stopped"];

export function statePath(configPath: string): string {
  return join(dirname(configPath), "state.json");
}

// A missing, unparsable or wrongly shaped file reads as "no state": status then says stopped.
export function readState(path: string): State | null {
  let s: any;
  try {
    s = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const str = (v: unknown) => typeof v === "string";
  const ok =
    s !== null &&
    typeof s === "object" &&
    s.version === 1 &&
    Number.isInteger(s.pid) &&
    s.pid > 0 &&
    STATES.includes(s.state) &&
    (s.reason === null || str(s.reason)) &&
    str(s.since) &&
    (s.retryAt === null || str(s.retryAt)) &&
    typeof s.server === "object" &&
    s.server !== null &&
    str(s.server.host) &&
    Number.isInteger(s.server.port) &&
    Number.isInteger(s.remotePort) &&
    !Number.isNaN(Date.parse(s.updatedAt));
  return ok ? (s as State) : null;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
