import { createHash } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync,
  realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

export interface PolicyRevision {
  epoch: number;
  revision: number;
  routes: readonly string[];
}

export function hashBytes(bytes: string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// PAC selection is intentionally broader than the PSL-aware home guard: a selected
// parent must never turn a delegated private subtree into unintended DIRECT.
export function renderDomainPolicy(port: number, policy: PolicyRevision): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("invalid enrolled port");
  const proxy = JSON.stringify(`PROXY 127.0.0.1:${port}`);
  const witness = JSON.stringify(`.e${policy.epoch}.r${policy.revision}.pac.invalid`);
  const pac = `function FindProxyForURL(url, host) {
  host = host.toLowerCase().replace(/\\.$/, "");
  var routes = ${JSON.stringify(policy.routes)};
  var witness = ${witness};
  if (/^[0-9a-f]{32}\\./.test(host) && host.slice(32) === witness) return ${proxy};
  for (var i = 0; i < routes.length; i++) {
    if (host === routes[i] || host.slice(-routes[i].length - 1) === "." + routes[i]) return ${proxy};
  }
  return "DIRECT";
}`;
  return JSON.stringify({ ProxySettings: {
    ProxyMode: "pac_script",
    ProxyPacUrl: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString("base64")}`,
    ProxyPacMandatory: true,
  } }) + "\n";
}

export function protectedDirectory(path: string, privateOnly = false) {
  const uid = process.geteuid?.();
  if (uid === undefined || !isAbsolute(path) || realpathSync(path) !== path) throw new Error("unsafe managed directory");
  const local = lstatSync(path);
  if (!local.isDirectory() || local.uid !== uid || (local.mode & (privateOnly ? 0o077 : 0o022))) {
    throw new Error("unsafe managed directory");
  }
  for (let parent = dirname(path); ; parent = dirname(parent)) {
    const info = lstatSync(parent);
    if (!info.isDirectory() || (info.uid !== 0 && info.uid !== uid) || ((info.mode & 0o022) && !(info.mode & 0o1000))) {
      throw new Error("unsafe managed directory parent");
    }
    if (dirname(parent) === parent) break;
  }
  return local;
}

export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

export interface DomainPolicySink {
  read(): string;
  replace(expected: string, next: string): void;
}

const MAX_POLICY_BYTES = 64 * 1024;
export const DOMAIN_POLICY_FILE = "social-tunnel.json";

// Both paths are provisioner-owned, never operation fields. Stage outside Chrome's directory.
export function fileDomainPolicySink(policyDir: string, stagingDir: string): DomainPolicySink {
  const policy = protectedDirectory(policyDir);
  const staging = protectedDirectory(stagingDir, true);
  if (policyDir === stagingDir || policy.dev !== staging.dev || stagingDir.startsWith(policyDir + "/")) {
    throw new Error("unsafe policy staging directory");
  }
  const target = join(policyDir, DOMAIN_POLICY_FILE);
  const temp = join(stagingDir, `.policy-${hashBytes(policyDir).slice(0, 16)}.tmp`);
  const checkDirs = () => {
    const p = protectedDirectory(policyDir);
    const s = protectedDirectory(stagingDir, true);
    if (p.dev !== policy.dev || p.ino !== policy.ino || s.dev !== staging.dev || s.ino !== staging.ino) {
      throw new Error("managed directory changed");
    }
  };
  const read = (sync = false) => {
    checkDirs();
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== policy.uid || info.nlink !== 1 || (info.mode & 0o022) || info.size > MAX_POLICY_BYTES) {
        throw new Error("unsafe policy file");
      }
      if (sync) fsyncSync(fd);
      return readFileSync(fd).toString("utf8");
    } finally { closeSync(fd); }
  };
  return {
    read: () => read(),
    replace(expected, next) {
      if (Buffer.byteLength(next) > MAX_POLICY_BYTES || read() !== expected) throw new Error("managed policy changed");
      if (expected !== next) {
        // A crash before rename can leave one private staging file. Never follow it.
        const stale = lstatSync(temp, { throwIfNoEntry: false });
        if (stale) {
          if (!stale.isFile() || stale.uid !== staging.uid || stale.nlink !== 1 || (stale.mode & 0o022)) {
            throw new Error("unsafe policy staging file");
          }
          rmSync(temp);
        }
        const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          try {
            writeFileSync(fd, next);
            fchmodSync(fd, 0o644);
            fsyncSync(fd);
          } finally { closeSync(fd); }
          // Do not overwrite missing, redirected or unrecognized prior policy bytes.
          if (read() !== expected) throw new Error("managed policy changed");
          renameSync(temp, target);
        } finally { rmSync(temp, { force: true }); }
      }
      if (read(true) !== next) throw new Error("managed policy readback differs");
      syncDirectory(policyDir);
      syncDirectory(stagingDir);
    },
  };
}
