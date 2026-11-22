// The shapes `get_snapshot` and the `snapshot` event carry (app/src-tauri/src/driver.rs, model.rs, status.rs).

export interface Hop {
  hop: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
  fix: string;
}

export interface Doctor {
  exit: number;
  hops: Hop[];
  startedAt: number;
}

export interface RunStatus {
  exit: number;
  state: string;
  reason: string | null;
  pid: number | null;
  retryAt: string | null;
  server: { host: string; port: number; user: string | null; hostKey: string | null };
  remotePort: number;
  domains: number;
  allowlist: string[];
  keyPath: string | null;
  configPath: string | null;
}

export type TrayState = "notSetUp" | "connected" | "reconnecting" | "disconnected" | "blocked";

export interface Snapshot {
  trayState: TrayState;
  title: string;
  rows: string[];
  statusUnreadable: boolean;
  status: RunStatus | null;
  configPath: string | null;
  doctor: Doctor | null;
  ownership: "owned" | "external" | null;
  openAtLogin: boolean;
  reduceTransparency: boolean;
  /** A doctor run is in flight (set by the supervisor; absent until it lands). */
  checking?: boolean;
}

export type View = "status" | "server" | "domains" | "general" | "setup";
export const TABS = ["status", "server", "domains", "general"] as const;
export type Tab = (typeof TABS)[number];
