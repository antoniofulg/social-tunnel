// Vitest only. The webview's two Tauri modules are replaced for every test file; `test-support.ts`
// drives them.
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined") window.location.hash = "";
});
