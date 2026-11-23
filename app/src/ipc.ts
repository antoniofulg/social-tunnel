// The only place Settings invokes the Rust commands and subscribes to app events.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { DomainEdit, DomainView, Snapshot, View } from "./types";

export const VIEWS: readonly View[] = ["status", "server", "domains", "general", "setup"];

export const isView = (value: unknown): value is View => VIEWS.includes(value as View);

export const getSnapshot = () => invoke<Snapshot | null>("get_snapshot");
export const runCheck = () => invoke<unknown>("run_check");
export const copyFix = (hop: string) => invoke<void>("copy_fix", { hop });
export const setOpenAtLogin = (enabled: boolean) => invoke<boolean>("set_open_at_login", { enabled });
export const getDomains = (scope: number) => invoke<DomainView>("get_domains", { scope });
export const editDomain = (scope: number, { operation, host, expectedRevision }: DomainEdit) =>
  invoke<DomainView>("edit_domain", { scope, operation, host, expectedRevision });
export const retryDomainEdit = (scope: number, operationId: string) =>
  invoke<DomainView>("retry_domain_edit", { scope, operationId });

export const onSnapshot = (handler: (snapshot: Snapshot) => void) =>
  listen<Snapshot>("snapshot", (event) => handler(event.payload));

/** Rust asks an open window to show another view (`Review Server Key…`, `Set Up…`). */
export const onView = (handler: (view: View) => void) =>
  listen<string>("settings-view", (event) => {
    if (isView(event.payload)) handler(event.payload);
  });
