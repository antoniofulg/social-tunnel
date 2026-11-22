// @vitest-environment node
// The built frontend names no remote resource (check C74). Run after `vite build`.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const dist = join(import.meta.dirname, "..", "..", "dist");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

describe("built frontend", () => {
  it("[tray-app C74] has no src, href or CSS url() that starts with http:// or https://", () => {
    expect(existsSync(join(dist, "index.html")), "run vite build first").toBe(true);
    const found: string[] = [];
    for (const path of files(dist)) {
      const text = readFileSync(path, "utf8");
      if (path.endsWith(".html")) {
        for (const m of text.matchAll(/\b(?:src|href)\s*=\s*["']?\s*(https?:\/\/[^"'\s>]+)/gi)) found.push(`${path}: ${m[1]}`);
      }
      if (path.endsWith(".css") || path.endsWith(".html")) {
        for (const m of text.matchAll(/url\(\s*["']?\s*(https?:\/\/[^)"'\s]+)/gi)) found.push(`${path}: ${m[1]}`);
      }
      if (path.endsWith(".js")) {
        // A script may build a URL at runtime, but a literal remote resource in markup it injects is the same hole.
        for (const m of text.matchAll(/\b(?:src|href)\s*[:=]\s*["'`](https?:\/\/[^"'`]+)/gi)) found.push(`${path}: ${m[1]}`);
      }
    }
    expect(found).toEqual([]);
  });
});
