import { isIP } from "node:net";
import path from "node:path";
import { utils } from "ssh2";
import { DEFAULTS } from "./defaults";
import { normalizeHost } from "./host";

// Plan door 3, schema v1. Holds no secret: the key stays in its own file.
export interface Config {
  version: 1;
  server: { host: string; port: number; user: string; hostKey: string };
  remotePort: number;
  keyPath: string;
  domains: string[];
}

export type ConfigResult =
  | { ok: true; config: Config }
  | { ok: false; field: string; message: string };

type Env = Record<string, string | undefined>;

export function resolveConfigPath(
  flag: string | undefined,
  env: Env,
  platform: string,
  homedir: () => string,
): string {
  const explicit = flag ?? env.SOCIAL_TUNNEL_CONFIG;
  if (explicit) return path.resolve(explicit);
  if (platform === "win32") {
    const base = env.APPDATA || path.win32.join(homedir(), "AppData", "Roaming");
    return path.win32.join(base, "social-tunnel", "config.json");
  }
  const base =
    platform === "darwin"
      ? path.join(homedir(), "Library", "Application Support")
      : env.XDG_CONFIG_HOME || path.join(homedir(), ".config");
  return path.join(base, "social-tunnel", "config.json");
}

const bad = (field: string, message: string): ConfigResult => ({ ok: false, field, message });
const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPort = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;

const TOP_KEYS = ["version", "server", "remotePort", "keyPath", "domains"];
const SERVER_KEYS = ["host", "port", "user", "hostKey"];

// An allowlist entry is a bare hostname of two or more labels. Anything a URL, a wildcard or an
// address would add is refused, so the list can only ever name DNS names.
export function normalizeDomain(entry: unknown): string | null {
  if (typeof entry !== "string") return null;
  const host = normalizeHost(entry);
  if (!host || !host.includes(".") || isIP(host) || /^\d+$/.test(host.split(".").pop()!)) return null;
  return host;
}

export function parseConfig(raw: unknown, configDir: string, homedir: () => string): ConfigResult {
  if (!isObject(raw)) return bad("$", "config must be a JSON object");
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.includes(key)) return bad(key, `unknown key "${key}"`);
  }
  if (raw.version !== 1) return bad("version", "version must be 1");

  const server = raw.server;
  if (!isObject(server)) return bad("server", "server must be an object");
  for (const key of Object.keys(server)) {
    if (!SERVER_KEYS.includes(key)) return bad(`server.${key}`, `unknown key "server.${key}"`);
  }
  const { host, port, user, hostKey } = server;
  if (typeof host !== "string" || !/^[A-Za-z0-9.:-]{1,253}$/.test(host)) {
    return bad("server.host", "server.host must be a hostname or IP address");
  }
  if (!isPort(port)) return bad("server.port", "server.port must be an integer from 1 to 65535");
  if (typeof user !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(user)) {
    return bad("server.user", "server.user must be a user name");
  }
  // Door 8: no pin, no connection. Only the unpadded OpenSSH SHA256 form is accepted.
  if (typeof hostKey !== "string" || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(hostKey)) {
    return bad("server.hostKey", "server.hostKey must be SHA256: followed by 43 unpadded base64 characters");
  }

  const remotePort = raw.remotePort === undefined ? DEFAULTS.remotePort : raw.remotePort;
  if (!isPort(remotePort)) return bad("remotePort", "remotePort must be an integer from 1 to 65535");

  if (typeof raw.keyPath !== "string" || raw.keyPath === "") {
    return bad("keyPath", "keyPath must be a path to the SSH private key");
  }
  const expanded =
    raw.keyPath === "~" || raw.keyPath.startsWith("~/")
      ? path.join(homedir(), raw.keyPath.slice(1))
      : raw.keyPath;
  const keyPath = path.resolve(configDir, expanded);

  if (!Array.isArray(raw.domains) || raw.domains.length === 0) {
    return bad("domains", "domains must be a non-empty array of hostnames");
  }
  const domains: string[] = [];
  for (const [i, entry] of raw.domains.entries()) {
    const domain = normalizeDomain(entry);
    if (!domain) {
      return bad(`domains[${i}]`, `domain ${JSON.stringify(entry)} must be a bare hostname such as "instagram.com"`);
    }
    domains.push(domain);
  }

  return {
    ok: true,
    config: { version: 1, server: { host, port, user, hostKey }, remotePort, keyPath, domains },
  };
}

export function loadConfig(
  configPath: string,
  readFile: (p: string) => Buffer,
  homedir: () => string,
): ConfigResult {
  let text: string;
  try {
    text = readFile(configPath).toString("utf8");
  } catch {
    return bad("$", `cannot read config file ${configPath}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("$", `config file ${configPath} is not valid JSON`);
  }
  return parseConfig(raw, path.dirname(configPath), homedir);
}

export type KeyResult =
  | { ok: true; key: Buffer }
  | { ok: false; code: "key_permissions" | "key_unreadable" | "key_invalid"; message: string };

export interface KeyFs {
  stat: (p: string) => { mode: number };
  readFile: (p: string) => Buffer;
}

// The mode is checked before the first read: a key other users can read is never loaded.
// Messages are fixed text, so nothing from the key file can reach output.
export function loadKey(keyPath: string, fs: KeyFs, platform: string): KeyResult {
  let mode: number;
  try {
    mode = fs.stat(keyPath).mode;
  } catch {
    return { ok: false, code: "key_unreadable", message: `cannot read key file ${keyPath}` };
  }
  if (platform !== "win32" && (mode & 0o077) !== 0) {
    return {
      ok: false,
      code: "key_permissions",
      message: `key file ${keyPath} is accessible by group or others`,
    };
  }
  let key: Buffer;
  try {
    key = fs.readFile(keyPath);
  } catch {
    return { ok: false, code: "key_unreadable", message: `cannot read key file ${keyPath}` };
  }
  // ssh2 also parses public keys; only a private key can authenticate.
  const parsed = utils.parseKey(key);
  const first = Array.isArray(parsed) ? parsed[0] : parsed;
  if (first === undefined || first instanceof Error || !first.isPrivateKey()) {
    return {
      ok: false,
      code: "key_invalid",
      message: `key file ${keyPath} is not an unencrypted SSH private key`,
    };
  }
  return { ok: true, key };
}
