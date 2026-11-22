// Vitest only: a controllable stand-in for the webview's IPC (`invoke` and `listen`).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { act } from "@testing-library/react";
import { vi } from "vitest";
import type { Snapshot } from "./types";

type Handler = (event: { payload: unknown }) => void;

export interface Ipc {
  /** Every `invoke(command, args)` made, in order. */
  calls: (command: string) => unknown[];
  /** Delivers an event to its listeners. */
  emit: (event: string, payload: unknown) => void;
}

export function installIpc(opts: {
  snapshot?: Snapshot | null | "never";
  answers?: Record<string, (args: unknown) => unknown>;
} = {}): Ipc {
  const listeners = new Map<string, Set<Handler>>();
  const log: [string, unknown][] = [];

  vi.mocked(listen).mockImplementation((async (event: string, handler: Handler) => {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    return () => set.delete(handler);
  }) as never);

  vi.mocked(invoke).mockImplementation((async (command: string, args?: unknown) => {
    log.push([command, args]);
    const answer = opts.answers?.[command];
    if (answer) return answer(args);
    if (command === "get_snapshot") return opts.snapshot === "never" ? new Promise(() => undefined) : (opts.snapshot ?? null);
    return undefined;
  }) as never);

  return {
    calls: (command) => log.filter(([name]) => name === command).map(([, args]) => args),
    emit: (event, payload) =>
      act(() => {
        for (const handler of listeners.get(event) ?? []) handler({ payload });
      }),
  };
}
