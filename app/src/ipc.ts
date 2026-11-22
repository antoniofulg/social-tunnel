// The only place the webview talks to Rust: the four commands and two events (capability `default`).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Snapshot, View } from "./types";

export const VIEWS: readonly View[] = ["status", "server", "domains", "general", "setup"];

export const isView = (value: unknown): value is View => VIEWS.includes(value as View);

export const getSnapshot = () => invoke<Snapshot | null>("get_snapshot");
export const runCheck = () => invoke<unknown>("run_check");
export const copyFix = (hop: string) => invoke<void>("copy_fix", { hop });
export const setOpenAtLogin = (enabled: boolean) => invoke<boolean>("set_open_at_login", { enabled });

export const onSnapshot = (handler: (snapshot: Snapshot) => void) =>
  listen<Snapshot>("snapshot", (event) => handler(event.payload));

/** Rust asks an open window to show another view (`Review Server Key…`, `Set Up…`). */
export const onView = (handler: (view: View) => void) =>
  listen<string>("settings-view", (event) => {
    if (isView(event.payload)) handler(event.payload);
  });
