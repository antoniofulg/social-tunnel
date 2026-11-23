import { expect, test } from "bun:test";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
  const bundle = join(root, "build", "Social Tunnel.app");
  mkdirSync(join(bundle, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(bundle, "Contents", "Info.plist"), "<plist>new</plist>");
  for (const name of ["social-tunnel-app", "social-tunnel"]) {
    const path = join(bundle, "Contents", "MacOS", name);
    writeFileSync(path, `new ${name}`);
    chmodSync(path, 0o755);
  }
  const home = join(root, "home");
  const dest = join(home, "Applications", "Social Tunnel.app");
  mkdirSync(join(dest, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(dest, "Contents", "Info.plist"), "<plist>old</plist>");
  writeFileSync(join(dest, "Contents", "old-only.txt"), "stale");
  return { root, bundle, home, dest };
}

const install = (home: string, bundle: string) =>
  Bun.spawnSync(["/bin/sh", script], { env: { PATH: "/usr/bin:/bin", HOME: home, SOCIAL_TUNNEL_BUNDLE: bundle } });

async function waitReady(stdout: ReadableStream<Uint8Array>) {
  const reader = stdout.getReader();
  try {
    const { value } = await reader.read();
    expect(new TextDecoder().decode(value)).toBe("ready\n");
  } finally {
    reader.releaseLock();
  }
}

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

test("[tray-app C81] refuses the live executable by identity through absolute, relative and alias paths", async () => {
  const { root, bundle, home, dest } = fixture();
  try {
    const exe = join(dest, "Contents", "MacOS", "social-tunnel-app");
    // Use a native executable with a readiness handshake instead of racing a process that may exit.
    const build = Bun.spawnSync(["/usr/bin/clang", "-x", "c", "-o", exe, "-"], {
      stdin: Buffer.from('#include <stdio.h>\nint main(void) { puts("ready"); fflush(stdout); getchar(); }\n'),
    });
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    linkSync(exe, join(root, "hard-alias"));
    symlinkSync(exe, join(root, "symlink-alias"));
    const before = files(dest);
    for (const command of [exe, `./${relative(root, exe)}`, "./hard-alias", "./symlink-alias"]) {
      const proc = Bun.spawn([command], { cwd: root, stdin: "pipe", stdout: "pipe" });
      try {
        await waitReady(proc.stdout);
        const result = install(home, bundle);
        expect(result.exitCode).toBe(1);
        expect(result.stdout.toString()).toBe("Quit Social Tunnel first.\n");
        expect(files(dest)).toEqual(before);
      } finally {
        proc.stdin.end();
        await proc.exited;
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);

test("[tray-app C80] a concurrent installer cannot stage or replace until the destination lock is free", async () => {
  const { root, bundle, home, dest } = fixture();
  const apps = join(home, "Applications");
  const holder = Bun.spawn([
    "/bin/sh", "-ec",
    'exec 9<"$1"; /usr/bin/lockf -s -t 0 9; printf "ready\\n"; IFS= read -r line',
    "holder", apps,
  ], { stdin: "pipe", stdout: "pipe" });
  try {
    const before = files(dest);
    await waitReady(holder.stdout);
    const blocked = install(home, bundle);
    expect(blocked.exitCode).toBe(1);
    expect(blocked.stderr.toString()).toContain("Another install is in progress");
    expect(readdirSync(apps)).toEqual(["Social Tunnel.app"]);
    expect(files(dest)).toEqual(before);
    holder.stdin.write("release\n");
    expect(await holder.exited).toBe(0);
    const result = install(home, bundle);
    expect(result.exitCode).toBe(0);
    expect(files(dest)).toEqual(files(bundle));
  } finally {
    holder.stdin.end();
    await holder.exited;
    rmSync(root, { recursive: true, force: true });
  }
});
