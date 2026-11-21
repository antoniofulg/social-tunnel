import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("[C20] no file under src/ opens a listening socket", () => {
  const src = join(import.meta.dir, "..", "src");
  const files = (readdirSync(src, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  expect(files).toContain("proxy.ts");
  expect(files).toContain("cli.ts");

  const forbidden = [/\blisten\s*\(/, /\bcreateServer\s*\(/, /\bBun\s*\.\s*listen\b/, /\bBun\s*\.\s*serve\b/, /\bnew\s+(net\s*\.\s*)?Server\b/];
  const hits: string[] = [];
  for (const file of files) {
    const text = readFileSync(join(src, file), "utf8");
    for (const pattern of forbidden) if (pattern.test(text)) hits.push(`${file}: ${pattern}`);
  }
  expect(hits).toEqual([]);
});
