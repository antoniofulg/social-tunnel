// Compiles the CLI into the Tauri sidecar: app/src-tauri/binaries/social-tunnel-<host triple>
// (plan door 3). Tauri copies it next to the app executable as `social-tunnel`.
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..");
const rustc = Bun.spawnSync(["rustc", "-vV"]);
const triple = /^host: (\S+)$/m.exec(rustc.stdout.toString())?.[1];
if (rustc.exitCode !== 0 || !triple) {
  console.error("build:sidecar: cannot read the host target triple from `rustc -vV`");
  process.exit(1);
}
const outDir = join(repo, "app", "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const outfile = join(outDir, `social-tunnel-${triple}`);
const build = Bun.spawnSync(["bun", "build", "--compile", join(repo, "src", "cli.ts"), "--outfile", outfile], {
  cwd: repo,
  stdout: "inherit",
  stderr: "inherit",
});
process.exit(build.exitCode ?? 1);
