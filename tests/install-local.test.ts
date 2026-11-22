import { expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// tray-app plan criteria 80, 81: app/scripts/install-local.sh against a temp HOME and a fake bundle.
const script = join(import.meta.dir, "..", "app", "scripts", "install-local.sh");

function files(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out[relative(dir, p)] = readFileSync(p, "hex");
    }
  };
  walk(dir);
  return out;
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "install-local-"));
  const bundle = join(root, "build", "social-tunnel.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist>new</plist>");
  for (const name of ["social-tunnel-app", "social-tunnel"]) {
    const path = join(bundle, "Contents", "MacOS", name);
    writeFileSync(path, `new ${name}`);
    chmodSync(path, 0o755);
  }
  const home = join(root, "home");
  const dest = join(home, "Applications", "social-tunnel.app");
  mkdirSync(join(dest, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dest, "Contents", "Info.plist"), "<plist>old</plist>");
  writeFileSync(join(dest, "Contents", "old-only.txt"), "stale");
  return { root, bundle, home, dest };
}

const install = (home: string, bundle: string) =>
  Bun.spawnSync(["/bin/sh", script], { env: { PATH: "/usr/bin:/bin", HOME: home, SOCIAL_TUNNEL_BUNDLE: bundle } });

test("[tray-app C80] install-local.sh replaces an older copy in ~/Applications with the built bundle, file for file", () => {
  const { root, bundle, home, dest } = fixture();
  try {
    const result = install(home, bundle);
    expect(result.exitCode).toBe(0);
    expect(files(dest)).toEqual(files(bundle));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("[tray-app C81] install-local.sh exits 1 with Quit social-tunnel first. while the installed copy runs, and copies nothing", async () => {
  const { root, bundle, home, dest } = fixture();
  const exe = join(dest, "Contents", "MacOS", "social-tunnel-app");
  copyFileSync("/bin/sleep", exe);
  chmodSync(exe, 0o755);
  const before = files(dest);
  const proc = Bun.spawn([exe, "30"]);
  try {
    const result = install(home, bundle);
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("Quit social-tunnel first.\n");
    expect(files(dest)).toEqual(before);
  } finally {
    proc.kill("SIGKILL");
    await proc.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
