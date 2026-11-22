import { linkSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
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

// Readers never see a half-written file: the new content lands under a temp name, then replaces
// the old file in one rename.
export function writeState(path: string, state: State): void {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state) + "\n", { mode: 0o600 });
  renameSync(temp, path);
}

export function lockPath(configPath: string): string {
  return join(dirname(configPath), "run.lock");
}

// Claims the config directory for this process before it connects, so two runs started at once
// cannot both pass the state.json check. The pid file is complete before link() publishes it, and
// link() fails if the lock exists. A leftover lock is replaced only by the one process that wins
// `<lock>.takeover` the same way, and only if the lock is still the file it judged dead; `live` says
// whether a pid still runs this tool. Returns the holder's pid when someone else owns it, null once
// claimed.
export function claimRun(path: string, live: (pid: number, ageMs: number) => boolean): number | null {
  const temp = `${path}.${process.pid}.tmp`;
  const takeover = `${path}.takeover`;
  writeFileSync(temp, `${process.pid}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (tryLink(temp, path)) return null;
      const held = readLock(path);
      if (held === null) continue;
      if (live(held.pid, held.ageMs)) return held.pid;
      if (!tryLink(temp, takeover)) {
        // Another run is replacing the lock. A takeover file outlives its owner only after a crash
        // between two system calls; past 10 s it is cleared and the lock judged again.
        const other = readLock(takeover);
        if (other && other.ageMs <= 10_000) return other.pid;
        rmSync(takeover, { force: true });
        continue;
      }
      try {
        const again = readLock(path);
        if (again && again.ino === held.ino && !live(again.pid, again.ageMs)) rmSync(path, { force: true });
        if (tryLink(temp, path)) return null;
      } finally {
        rmSync(takeover, { force: true });
      }
    }
    const held = readLock(path);
    return held ? held.pid : -1;
  } finally {
    rmSync(temp, { force: true });
  }
}

function tryLink(from: string, to: string): boolean {
  try {
    linkSync(from, to);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

// Marks the lock as still held, while it names this process; a failed refresh is left for the next
// heartbeat.
export function refreshRun(path: string): void {
  try {
    if (readLock(path)?.pid !== process.pid) return;
    const now = new Date();
    utimesSync(path, now, now);
  } catch {}
}

// Removes the lock only while it still names this process.
export function releaseRun(path: string): void {
  if (readLock(path)?.pid === process.pid) rmSync(path, { force: true });
}

function readLock(path: string): { pid: number; ageMs: number; ino: number } | null {
  try {
    const text = readFileSync(path, "utf8").trim();
    const pid = /^[1-9][0-9]*$/.test(text) ? Number(text) : 0;
    const stat = statSync(path);
    return { pid, ageMs: Date.now() - stat.mtimeMs, ino: stat.ino };
  } catch {
    return null;
  }
}
