import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { utils } from "ssh2";
import type { Config } from "./config";
import { hashBytes, protectedDirectory, syncDirectory } from "./domain-policy";
import { domainDigest, domainTag, domainUInt, wireObject, type DomainRole } from "./domain-wire";
import { parseManagedDomainSnapshot, type ManagedDomainSnapshot } from "./managed-domains";
import { fingerprint, type SshTarget } from "./tunnel";

interface RoleKey { user: string; fingerprint: string }
export interface ManagedEnrollment {
  readonly directory: string;
  readonly binding: string;
  readonly enrollment: string;
  readonly epoch: number;
  readonly proxyGeneration: string;
  readonly tunnelKey: string;
  readonly editor: RoleKey;
  readonly proxy: RoleKey;
  readonly baseline: ManagedDomainSnapshot;
}

const KEY_LIMIT = 16384;
const METADATA_LIMIT = 40 * 1024;
const fp = (value: unknown): value is string => typeof value === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value);
const FILES = { editor: "editor.key", proxy: "proxy.key", journal: "runtime.json", state: "live.json" } as const;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function enrollmentBinding(configPath: string, config: Config): string {
  const { host, port, user, hostKey } = config.server;
  return hashBytes(JSON.stringify([configPath, host, port, user, hostKey, config.remotePort, config.keyPath]));
}

function safeRead(file: string, limit: number): Buffer {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > limit) {
      throw new Error("unsafe managed file");
    }
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const n = readSync(fd, bytes, offset, bytes.length - offset, null);
      if (n === 0) break;
      offset += n;
    }
    if (offset !== stat.size) throw new Error("managed file changed");
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}

function roleKey(value: unknown): RoleKey | null {
  const o = wireObject(value);
  return o && Object.keys(o).length === 2 && typeof o.user === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(o.user) && fp(o.fingerprint)
    ? { user: o.user, fingerprint: o.fingerprint } : null;
}

export function readDomainEnrollment(configPath: string, config: Config): ManagedEnrollment | null | undefined {
  const metadata = `${configPath}.domains.json`;
  const directory = `${configPath}.domains`;
  try {
    if (!lstatSync(metadata, { throwIfNoEntry: false }) && !lstatSync(directory, { throwIfNoEntry: false })) return undefined;
    protectedDirectory(dirname(configPath));
    protectedDirectory(directory, true);
    const o = wireObject(JSON.parse(utf8.decode(safeRead(metadata, METADATA_LIMIT))));
    if (!o || Object.keys(o).length !== 9 || o.version !== 1 || !domainTag(o.enrollment) || !domainUInt(o.epoch) ||
        !domainTag(o.proxyGeneration) || !domainDigest(o.binding) || o.binding !== enrollmentBinding(configPath, config) || !fp(o.tunnelKey)) return null;
    const editor = roleKey(o.editor);
    const proxy = roleKey(o.proxy);
    const baseline = wireObject(o.baseline);
    const parsed = baseline && Object.keys(baseline).length === 2 && parseManagedDomainSnapshot(baseline.revision, baseline.domains);
    if (!editor || !proxy || !parsed || !parsed.ok || editor.user === proxy.user || editor.user === config.server.user ||
        proxy.user === config.server.user || editor.fingerprint === proxy.fingerprint || editor.fingerprint === o.tunnelKey ||
        proxy.fingerprint === o.tunnelKey) return null;
    return { directory, binding: o.binding, enrollment: o.enrollment, epoch: o.epoch, proxyGeneration: o.proxyGeneration,
      tunnelKey: o.tunnelKey, editor, proxy, baseline: parsed.snapshot };
  } catch { return null; }
}

export function managedKeyFingerprint(key: Buffer): string | null {
  try {
    const parsed = utils.parseKey(key);
    return parsed instanceof Error || Array.isArray(parsed) || !parsed.isPrivateKey() ? null : fingerprint(parsed.getPublicSSH());
  } catch { return null; }
}

export function readDomainRole(enrollment: ManagedEnrollment, config: Config, role: DomainRole): SshTarget | null {
  try {
    protectedDirectory(enrollment.directory, true);
    const key = safeRead(join(enrollment.directory, FILES[role]), KEY_LIMIT);
    const identity = enrollment[role];
    if (managedKeyFingerprint(key) !== identity.fingerprint) { key.fill(0); return null; }
    return { ...config.server, user: identity.user, key };
  } catch { return null; }
}

const STATE_LIMIT = 96 * 1024;
export function readDomainLocal(enrollment: ManagedEnrollment, kind: "journal" | "state"): unknown {
  const file = join(enrollment.directory, FILES[kind]);
  protectedDirectory(enrollment.directory, true);
  if (!lstatSync(file, { throwIfNoEntry: false })) return undefined;
  return JSON.parse(utf8.decode(safeRead(file, STATE_LIMIT)));
}

export function writeDomainLocal(enrollment: ManagedEnrollment, kind: "journal" | "state", value: unknown): void {
  const dir = enrollment.directory;
  protectedDirectory(dir, true);
  const bytes = JSON.stringify(value);
  if (Buffer.byteLength(bytes) > STATE_LIMIT) throw new Error("managed state exceeds limit");
  const temp = join(dir, `.snapshot-${randomBytes(16).toString("hex")}`);
  const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      if (kind === "journal") fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, join(dir, FILES[kind]));
    if (kind === "journal") syncDirectory(dir);
  } finally { rmSync(temp, { force: true }); }
}
