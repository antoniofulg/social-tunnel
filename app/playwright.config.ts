import { defineConfig, devices } from "@playwright/test";

// The CSP smoke runs in WebKit, the engine of the Tauri webview on macOS (plan Landing 11).
export default defineConfig({
  testDir: "e2e",
  workers: 1,
  fullyParallel: false,
  reporter: "list",
  outputDir: "test-results",
  projects: [
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 640, height: 520 }, deviceScaleFactor: 2 },
    },
  ],
});
