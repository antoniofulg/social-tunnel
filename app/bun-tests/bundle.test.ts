// Runs against the bundle `tauri build --bundles app` wrote; run that first (checks.md `Run bundle`).
import { expect, test } from "bun:test";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const app = join(import.meta.dir, "..", "src-tauri", "target", "release", "bundle", "macos", "social-tunnel.app");
const plist = join(app, "Contents", "Info.plist");
const read = (key: string) => Bun.spawnSync(["plutil", "-extract", key, "raw", "-o", "-", plist]).stdout.toString().trim();

test("[tray-app C75] the bundle holds executable Contents/MacOS/social-tunnel-app and the sidecar Contents/MacOS/social-tunnel", () => {
  for (const name of ["social-tunnel-app", "social-tunnel"]) {
    const path = join(app, "Contents", "MacOS", name);
    expect(statSync(path).isFile()).toBe(true);
    accessSync(path, constants.X_OK);
  }
  expect(read("CFBundleExecutable")).toBe("social-tunnel-app");
});

test("[tray-app C76] Info.plist sets CFBundleIdentifier tech.antoniofulg.social-tunnel.tray and LSUIElement true", () => {
  expect(read("CFBundleIdentifier")).toBe("tech.antoniofulg.social-tunnel.tray");
  expect(read("LSUIElement")).toBe("true");
});

test("[tray-app C77] Contents/Resources/icon.icns is non-empty and named by CFBundleIconFile", () => {
  const icon = read("CFBundleIconFile");
  expect(["icon.icns", "icon"]).toContain(icon);
  expect(statSync(join(app, "Contents", "Resources", "icon.icns")).size).toBeGreaterThan(0);
  expect(readFileSync(join(app, "Contents", "Resources", "icon.icns"))).toEqual(
    readFileSync(join(import.meta.dir, "../src-tauri/icons/icon.icns")),
  );
});
