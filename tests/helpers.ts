import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { utils } from "ssh2";
import { main, type Io } from "../src/cli";

export const HOST_KEY = "SHA256:" + "A".repeat(43);

const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

export function tmp(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "social-tunnel-")));
  dirs.push(dir);
  return dir;
}

// Keys are generated per run and live only in a temp dir.
export function writeKey(dir: string, mode = 0o600, name = "tunnel_key"): { path: string; publicKey: string } {
  const pair = utils.generateKeyPairSync("ed25519");
  const path = join(dir, name);
  writeFileSync(path, pair.private);
  chmodSync(path, mode);
  return { path, publicKey: pair.public };
}

export function baseConfig(keyPath: string): Record<string, any> {
  return {
    version: 1,
    server: { host: "127.0.0.1", port: 22, user: "tunnel", hostKey: HOST_KEY },
    remotePort: 8888,
    keyPath,
    domains: ["instagram.com"],
  };
}

// Writes a config (valid unless `edit` breaks it) and its key into a fresh dir.
export function writeConfig(edit: (config: Record<string, any>) => void = () => {}, keyMode = 0o600) {
  const dir = tmp();
  const key = writeKey(dir, keyMode);
  const config = baseConfig(key.path);
  edit(config);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(config));
  return { dir, path, keyPath: key.path, publicKey: key.publicKey, statePath: join(dir, "state.json") };
}

export function testIo(overrides: Partial<Io> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    env: {},
    platform: process.platform,
    homedir: () => "/nonexistent-home",
    stdout: (text) => void out.push(text),
    stderr: (text) => void err.push(text),
    readFile: (path) => readFileSync(path),
    stat: (path) => statSync(path),
    ...overrides,
  };
  return { io, out, err };
}

// Runs the CLI in-process through its real entry function.
export async function cli(argv: string[], overrides: Partial<Io> = {}) {
  const { io, out, err } = testIo(overrides);
  const code = await main(argv, io);
  const stdout = out.join("");
  return { code, stdout, stderr: err.join(""), json: () => JSON.parse(stdout) };
}
