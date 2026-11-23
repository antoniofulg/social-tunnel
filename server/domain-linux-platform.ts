import { spawn, spawnSync } from "node:child_process";
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { DIRECT_WITNESS_HELPER } from "./domain-direct-witness";
import { DOMAIN_POLICY_FILE, hashBytes, protectedDirectory } from "../src/domain-policy";
import { domainDigest, domainTag, domainUInt, wireObject } from "../src/domain-wire";
import { parseManagedDomainSnapshot } from "../src/managed-domains";

export const ROOT = "/etc/social-tunnel-domains";
export const STATE = "/var/lib/social-tunnel-domains";
export const RUN = "/run/social-tunnel-domains";
export const POLICY = "/etc/opt/chrome/policies/managed";
export const STAGING = "/etc/opt/chrome/policies/.social-tunnel-staging";
const recommended = "/etc/opt/chrome/policies/recommended";
export const CHROME = "/opt/google/chrome/chrome";
export const PROGRAM = "/usr/local/bin/st-domains-supervisor";
export const COMMAND = "/usr/local/bin/st-domains-command";
export const SETPRIV = "/usr/bin/setpriv";
const SSHD = "/usr/sbin/sshd";
const SSH_CONFIG = `${ROOT}/sshd.conf`;
export const SSH_RUN = `${RUN}/sshd`;
export const SSH_SNAPSHOT = `${SSH_RUN}/sshd.conf`;
export const SSH_LAUNCH = `${SSH_RUN}/launch.json`;
const SSH_ENV = { PATH: "/usr/bin:/bin", LC_ALL: "C" };
const CGROUP = "/sys/fs/cgroup";
const UTF8 = new TextDecoder("utf-8", { fatal: true });
export const ADMIN_SOCKET = `${RUN}/admin/control.sock`;
export const PROFILE = `${STATE}/chrome`;
export const JOURNAL = `${STATE}/journal`;

export function exact(value: unknown, fields: string) {
  const o = wireObject(value);
  const keys = fields.split(" ");
  return o && Object.keys(o).length === keys.length && keys.every((key) => Object.hasOwn(o, key)) ? o : null;
}

function checkDirectories(path: string) {
  if (realpathSync(path) !== path) throw new Error("redirected protected directory");
  for (;;) {
    const s = lstatSync(path);
    if (!s.isDirectory() || s.uid !== 0 || (s.mode & 0o022)) throw new Error("insecure root directory");
    if (path === "/") return;
    path = dirname(path);
  }
}

function protectedFile(path: string, max: number, privateOnly = false) {
  checkDirectories(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== 0 || st.nlink !== 1 || (st.mode & (privateOnly ? 0o077 : 0o022)) || st.size > max) {
      throw new Error("insecure provisioned file");
    }
    const bytes = readFileSync(fd);
    if (bytes.length !== st.size) throw new Error("provisioned file changed");
    return bytes;
  } finally { closeSync(fd); }
}

function executable(path: string) {
  checkDirectories(dirname(path));
  const info = lstatSync(path);
  if (!info.isFile() || info.uid !== 0 || (info.mode & 0o6022) || !(info.mode & 0o001)) throw new Error("insecure executable");
}

const id = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 1000 && n < 2 ** 31;
const username = (v: unknown): v is string => typeof v === "string" && /^[a-z_][a-z0-9_-]{0,30}$/.test(v);
const portInRange = (v: unknown): v is number => domainUInt(v) && v >= 1024 && v <= 65535;
type Account = { user: string; uid: number; gid: number };
function account(raw: unknown): Account {
  const o = exact(raw, "user uid gid");
  if (!o || !username(o.user) || !id(o.uid) || !id(o.gid)) throw new Error("invalid account");
  return { user: o.user, uid: o.uid, gid: o.gid };
}

function invoke(program: string, args: string[], maxBuffer = 16384) {
  const result = spawnSync(program, args, { env: SSH_ENV, timeout: 3000, maxBuffer, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`protected check failed: ${program}`);
  return result.stdout.trimEnd();
}

export function loadManifest() {
  const o = exact(JSON.parse(UTF8.decode(protectedFile(`${ROOT}/enrollment.json`, 49152, true))),
    "version enrollment proxyPort sshPort chromeSha256 sshdSha256 profile witness forward probe epochs baseline");
  if (!o || o.version !== 1 || !domainTag(o.enrollment) || !portInRange(o.proxyPort) || !portInRange(o.sshPort) ||
      o.sshPort === o.proxyPort || !domainDigest(o.chromeSha256) || !domainDigest(o.sshdSha256) ||
      !Array.isArray(o.epochs) || o.epochs.length < 1 || o.epochs.length > 8) throw new Error("invalid enrollment manifest");
  const profile = account(o.profile), witness = account(o.witness), forward = account(o.forward), probe = account(o.probe);
  const epochs = o.epochs.map((raw: unknown) => {
    const epoch = exact(raw, "epoch generation editor receipt");
    if (!epoch || !domainUInt(epoch.epoch) || !domainTag(epoch.generation)) throw new Error("invalid role epoch");
    return { epoch: epoch.epoch, generation: epoch.generation, editor: account(epoch.editor), receipt: account(epoch.receipt) };
  });
  for (let i = 1; i < epochs.length; i++) {
    if (epochs[i]!.epoch !== epochs[i - 1]!.epoch + 1) throw new Error("nonconsecutive role epochs");
  }
  if (new Set(epochs.map((e) => e.generation)).size !== epochs.length) throw new Error("reused proxy generation");
  const accounts = [profile, witness, forward, probe, ...epochs.flatMap((e) => [e.editor, e.receipt])];
  for (const key of ["user", "uid", "gid"] as const) {
    if (new Set(accounts.map((a) => a[key])).size !== accounts.length) throw new Error("shared protected account");
  }
  const base = exact(o.baseline, "revision domains");
  const snapshot = parseManagedDomainSnapshot(base?.revision, base?.domains);
  if (!snapshot.ok) throw new Error("invalid baseline");
  const first = epochs[0]!;
  return { enrollment: o.enrollment, proxyPort: o.proxyPort, sshPort: o.sshPort, chromeSha256: o.chromeSha256,
    sshdSha256: o.sshdSha256, profile, witness, forward, probe, epochs, accounts,
    baseline: { epoch: first.epoch, proxyGeneration: first.generation, revision: snapshot.snapshot.revision, domains: snapshot.snapshot.domains } };
}

export type Manifest = ReturnType<typeof loadManifest>;
export type Epoch = Manifest["epochs"][number];

function namespace(pid: string | number) { return readlinkSync(`/proc/${pid}/ns/net`); }
const atInitialCgroup = () => statSync("/proc/self/ns/cgroup").ino === 0xeffffffb;
const bootId = () => readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
function cgroupRoot() {
  return readFileSync("/proc/self/mountinfo", "utf8").split("\n").some((line) => {
    const [locations, type] = line.split(" - ");
    const fields = locations?.split(" ");
    return fields?.[3] === "/" && fields[4] === CGROUP && type?.startsWith("cgroup2 ");
  });
}

function readGuard(m: Manifest) {
  let raw: Buffer;
  try { raw = protectedFile(`${ROOT}/bind-guard.json`, 4096, true); }
  catch { throw new Error("bind exclusion attestation unavailable"); }
  const g = exact(JSON.parse(UTF8.decode(raw)), "version bootId netns cgroupRoot forwardCgroup forwardCgroupId forwardUid port ipv4Tag ipv6Tag");
  const tag = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{16}$/.test(v);
  if (!g || g.version !== 1 || g.bootId !== bootId() || g.netns !== namespace("self") || g.cgroupRoot !== String(statSync(CGROUP, { bigint: true }).ino) ||
      !domainUInt(g.forwardUid) || g.forwardUid !== m.forward.uid || g.port !== m.proxyPort || !tag(g.ipv4Tag) || !tag(g.ipv6Tag) ||
      g.ipv4Tag === g.ipv6Tag || typeof g.forwardCgroup !== "string" || !/^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(g.forwardCgroup) ||
      g.forwardCgroup.split("/").some((v) => v === "." || v === "..") || !atInitialCgroup() || !cgroupRoot() ||
      g.forwardCgroupId !== String(statSync(`${CGROUP}${g.forwardCgroup}`, { bigint: true }).ino)) {
    throw new Error("bind exclusion attestation absent or invalid for this boot and namespace");
  }
  const ephemeral = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8").trim().split(/\s+/).map(Number);
  if (ephemeral.length !== 2 || ephemeral.some((v) => !portInRange(v)) || m.proxyPort >= ephemeral[0]! && m.proxyPort <= ephemeral[1]!) {
    throw new Error("protected forward port overlaps ephemeral assignment");
  }
  return { cgroup: g.forwardCgroup, raw };
}

// This entrypoint is for the host provisioner, not the service process. The
// provisioner reviews the translated programs and supplies their known tags.
// A private cgroup-namespace root elsewhere in the hierarchy is not enough.
export function inspectBindHooks(m: Manifest, forwardCgroup: string, ipv4Tag: string, ipv6Tag: string) {
  executable(SETPRIV);
  executable(PROGRAM);
  if (!atInitialCgroup() || !cgroupRoot() || !/^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(forwardCgroup) ||
      forwardCgroup.split("/").some((v) => v === "." || v === "..")) throw new Error("initial cgroup-v2 root and dedicated sshd cgroup required");
  const path = `${CGROUP}${forwardCgroup}`;
  checkDirectories(path);
  const tool = "/usr/sbin/bpftool";
  executable(tool);
  const attachments: unknown = JSON.parse(invoke(tool, ["-j", "cgroup", "show", CGROUP]));
  if (!Array.isArray(attachments)) throw new Error("invalid kernel hook report");
  const records = attachments.map(wireObject);
  for (const [family, tag] of [["inet4_bind", ipv4Tag], ["inet6_bind", ipv6Tag]] as const) {
    if (!/^[0-9a-f]{16}$/.test(tag)) throw new Error("expected reviewed BPF tag");
    const matching = records.filter((row) => row?.attach_type === family || row?.attach_type === `cgroup_${family}`);
    const attach = matching[0];
    // Root, non-overridable attachment. No descendant can replace this hook.
    if (matching.length !== 1 || !attach || !domainUInt(attach.id) || attach.id === 0 ||
        !(attach.attach_flags === "" || Array.isArray(attach.attach_flags) && attach.attach_flags.length === 0)) {
      throw new Error(`missing non-overridable ${family} attachment at cgroup root`);
    }
    const info = JSON.parse(invoke(tool, ["-j", "prog", "show", "id", String(attach.id)]));
    const record = wireObject(Array.isArray(info) && info.length === 1 ? info[0] : info);
    if (record?.tag !== tag || record?.type !== "cgroup_sock_addr" || Array.isArray(record.map_ids) && record.map_ids.length) {
      throw new Error(`unreviewed or mutable ${family} bind guard`);
    }
  }
  invoke(SETPRIV, [...dropped(m.probe), PROGRAM, "bind-probe", String(m.proxyPort)]);
  return { version: 1, bootId: bootId(), netns: namespace("self"), cgroupRoot: String(statSync(CGROUP, { bigint: true }).ino),
    forwardCgroup, forwardCgroupId: String(statSync(path, { bigint: true }).ino), forwardUid: m.forward.uid, port: m.proxyPort, ipv4Tag, ipv6Tag };
}

function accountRestrictions(m: Manifest) {
  const passwd = protectedFile("/etc/passwd", 65536).toString().trim().split("\n").map((l) => l.split(":"));
  const groups = protectedFile("/etc/group", 65536).toString().trim().split("\n").map((l) => l.split(":"));
  for (const a of m.accounts) {
    const matches = passwd.filter((row) => row[0] === a.user || row[2] === String(a.uid) || row[3] === String(a.gid));
    const row = matches[0];
    const group = groups.filter((entry) => entry[2] === String(a.gid));
    if (matches.length !== 1 || row?.[0] !== a.user || row[2] !== String(a.uid) || row[3] !== String(a.gid) ||
        group.length !== 1 || group[0]?.[3] !== "" || groups.some((entry) => entry[3]?.split(",").includes(a.user))) throw new Error("role UID or group is not dedicated");
    if ([m.forward, ...m.epochs.flatMap((e) => [e.editor, e.receipt])].includes(a) && (row[5] !== "/var/empty" || row[6] !== "/bin/sh")) {
      throw new Error("unsupported SSH account home or shell");
    }
  }
  checkDirectories("/var/empty");
  if (readdirSync("/var/empty").length !== 0) throw new Error("SSH account home is not empty");
}

export function dropped(a: Account) { return [`--reuid=${a.uid}`, `--regid=${a.gid}`, "--clear-groups", "--no-new-privs", "--"]; }
export const roleDirectory = (user: string) => `${RUN}/${user}`;

export const readSshConfig = () => protectedFile(SSH_CONFIG, 65536, true);

function sshSettings(m: Manifest, config: string) {
  const cfg = UTF8.decode(protectedFile(config, 65536, true));
  const authorities = [m.forward, ...m.epochs.flatMap((e) => [e.editor, e.receipt])];
  const globalOptions = new Set(("port listenaddress pidfile hostkey authorizedkeysfile allowusers authenticationmethods " +
    "pubkeyauthentication passwordauthentication kbdinteractiveauthentication permitrootlogin permitemptypasswords usepam " +
    "permittty x11forwarding allowagentforwarding allowstreamlocalforwarding permituserenvironment permituserrc gatewayports " +
    "permitopen permitlisten allowtcpforwarding maxsessions strictmodes").split(" "));
  const matchOptions = new Set(["maxsessions", "allowtcpforwarding", "permitlisten", "forcecommand", "disableforwarding"]);
  let options = globalOptions;
  for (const line of cfg.split("\n")) {
    const text = line.trim();
    if (!text || text.startsWith("#")) continue;
    const entry = /^match\s+user\s+([a-z_][a-z0-9_-]*)\s*(?:#.*)?$/i.exec(text);
    if (entry && authorities.some((a) => a.user === entry[1])) options = matchOptions;
    else if (!options.has(/^([a-z][a-z0-9]*)\s+\S/i.exec(text)?.[1]?.toLowerCase() ?? "")) throw new Error("unsupported managed SSH directive");
  }
  invoke(SSHD, ["-t", "-f", config]);
  for (const who of authorities) {
    const n = who.user;
    const text = invoke(SSHD, ["-T", "-f", config, "-C", `user=${n},addr=127.0.0.1,host=localhost,laddr=127.0.0.1,lport=${m.sshPort}`]);
    const lines = text.split("\n");
    const expected = ["pubkeyauthentication yes", "authenticationmethods publickey", "passwordauthentication no", "kbdinteractiveauthentication no",
      "permitrootlogin no", "permitemptypasswords no", "usepam no", "permittty no", "x11forwarding no", "allowagentforwarding no", "allowstreamlocalforwarding no",
      "permituserenvironment no", "permituserrc no", "gatewayports no", "permitopen none", "strictmodes yes", `port ${m.sshPort}`, "pidfile none",
      `authorizedkeysfile ${ROOT}/keys/%u`, `forcecommand ${who === m.forward ? "/bin/false" : `${COMMAND} ${roleDirectory(n)}/authority.sock`}`,
      ...(who === m.forward ? ["maxsessions 0", "disableforwarding no", "allowtcpforwarding remote", `permitlisten 127.0.0.1:${m.proxyPort}`]
        : ["maxsessions 1", "disableforwarding yes", "allowtcpforwarding no", "permitlisten none"]),
    ];
    if (lines.filter((line) => line.startsWith("port ")).length !== 1) throw new Error("ambiguous dedicated SSH port");
    const listeners = lines.filter((line) => line.startsWith("listenaddress "));
    if (!listeners.length || listeners.some((line) => !line.endsWith(`:${m.sshPort}`))) throw new Error("unexpected dedicated SSH listen port");
    const expectedUsers = authorities.map((a) => `allowusers ${a.user}`);
    const actualUsers = lines.filter((line) => line.startsWith("allowusers "));
    if (actualUsers.length !== expectedUsers.length || expectedUsers.some((line) => !actualUsers.includes(line))) {
      throw new Error("ambiguous dedicated SSH users");
    }
    if (!expected.every((line) => lines.includes(line)) || lines.some((line) => /^(subsystem|acceptenv|setenv|match)\b/.test(line))) {
      throw new Error("effective managed SSH restrictions differ");
    }
  }
}

function roleKeys(m: Manifest, required: string[]) {
  const roles = [m.forward, ...m.epochs.flatMap((e) => [e.editor, e.receipt])];
  const keys = new Set<string>();
  for (const who of roles) {
    const path = `${ROOT}/keys/${who.user}`;
    if (!required.includes(who.user) && !lstatSync(path, { throwIfNoEntry: false })) continue;
    if ((lstatSync(path).mode & 0o777) !== 0o644) throw new Error("role public key must be readable by sshd's authenticated UID");
    const text = protectedFile(path, 1024).toString().trim();
    const prefix = who === m.forward ? `restrict,port-forwarding,permitlisten="127.0.0.1:${m.proxyPort}" ` : "restrict ";
    const match = /^ssh-ed25519 ([A-Za-z0-9+/]{68})(?: [!-~][ -~]{0,128})?$/.exec(text.slice(prefix.length));
    if (!text.startsWith(prefix) || !match?.[1]) throw new Error("invalid restricted public key");
    if (keys.has(match[1])) throw new Error("managed roles reuse an SSH key");
    keys.add(match[1]);
  }
}

function stamp(file: string) {
  const s = lstatSync(file, { bigint: true });
  return `${s.dev}:${s.ino}:${s.ctimeNs}`;
}

function pinExecutable(file: string, expected: string) {
  executable(file);
  const identity = stamp(file);
  const hash = createHash("sha256");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const buf = Buffer.allocUnsafe(128 * 1024);
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
  } finally { closeSync(fd); }
  const check = () => {
    if (stamp(file) !== identity) throw new Error("pinned executable changed");
  };
  if (hash.digest("hex") !== expected) throw new Error("pinned executable differs");
  check();
  return check;
}

function probeGuard(m: Manifest, guard: ReturnType<typeof readGuard>) {
  if (invoke(SETPRIV, [...dropped(m.probe), PROGRAM, "bind-probe", String(m.proxyPort)]) !== "ipv4-and-ipv6-denied") {
    throw new Error("kernel bind exclusion missing");
  }
  if (!guard.raw.equals(readGuard(m).raw)) throw new Error("bind guard changed");
}

function sshLaunchScope(m: Manifest, guard: ReturnType<typeof readGuard>, cfg: Buffer) {
  const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  return hashBytes(JSON.stringify([m, readlinkSync("/proc/self/ns/pid"), digest(guard.raw), digest(cfg)]));
}

// Runs only inside the attested service cgroup. Its fixed child inherits both
// cgroup and network namespace; the unit denies namespace changes.
export function guardedSshd(m: Manifest, cfg: Buffer) {
  const checkExecutable = pinExecutable(SSHD, m.sshdSha256);
  for (const file of [COMMAND, SETPRIV, PROGRAM]) executable(file);
  sshSettings(m, SSH_SNAPSHOT);
  const guard = readGuard(m);
  const launcher = proc(process.pid);
  if (!launcher || launcher.uid !== 0 || !launcher.noNewPrivs || launcher.cgroup !== guard.cgroup) {
    throw new Error("dedicated guarded SSH service cgroup required");
  }
  const check = () => {
    checkExecutable();
    if (!cfg.equals(readSshConfig()) || !cfg.equals(protectedFile(SSH_SNAPSHOT, 65536, true))) throw new Error("SSH configuration changed");
    accountRestrictions(m);
    roleKeys(m, [m.forward.user]);
    probeGuard(m, guard);
  };
  const scope = sshLaunchScope(m, guard, cfg);
  return {
    check,
    start() {
      check();
      return spawn(SSHD, ["-D", "-f", SSH_SNAPSHOT], { env: SSH_ENV, stdio: ["ignore", "inherit", "inherit"] });
    },
    evidence(pid: number) {
      const child = proc(pid);
      if (!child || child.uid !== 0 || child.ppid !== process.pid || !child.noNewPrivs || child.cgroup !== guard.cgroup) {
        throw new Error("owned SSH child unavailable");
      }
      return { scope, parent: process.pid, parentStart: launcher.start, pid, start: child.start };
    },
  };
}

function sshMaster(cgroup: string, scope: string) {
  const launch = exact(JSON.parse(UTF8.decode(protectedFile(SSH_LAUNCH, 512, true))), "scope parent parentStart pid start");
  if (!launch || launch.scope !== scope || !domainUInt(launch.parent) || !domainUInt(launch.pid) ||
      launch.parent <= 1 || launch.pid <= 1) return null;
  const parent = proc(launch.parent);
  const child = proc(launch.pid);
  if (parent?.uid !== 0 || !parent.noNewPrivs || parent.start !== launch.parentStart || parent.cgroup !== cgroup ||
      child?.uid !== 0 || !child.noNewPrivs || child.start !== launch.start || child.ppid !== launch.parent || child.cgroup !== cgroup) return null;
  return `${launch.pid}:${child.start}`;
}

export function policyScope() {
  checkDirectories(POLICY);
  const entries = readdirSync(POLICY);
  if (entries.some((name) => name !== DOMAIN_POLICY_FILE) || lstatSync(recommended, { throwIfNoEntry: false }) &&
      (checkDirectories(recommended), readdirSync(recommended).length > 0)) throw new Error("competing Chrome policy sources");
}

// No effective BPF capabilities are needed by the service. Root's boot-scoped
// attestation identifies the enforcing host hooks; a real unprivileged bind
// must additionally be refused by the kernel, not by an already occupied port.
export function guardedPlatform(m: Manifest, staging: boolean) {
  if (process.platform !== "linux" || process.geteuid?.() !== 0) throw new Error("Linux local root required");
  executable(SETPRIV);
  executable(PROGRAM);
  const g = readGuard(m);
  probeGuard(m, g);
  for (const file of [COMMAND, DIRECT_WITNESS_HELPER]) executable(file);
  pinExecutable(CHROME, m.chromeSha256);
  pinExecutable(SSHD, m.sshdSha256);
  accountRestrictions(m);
  const ssh = readSshConfig();
  if (staging) sshSettings(m, SSH_CONFIG);
  const scope = sshLaunchScope(m, g, ssh);
  roleKeys(m, [m.forward.user]);
  for (const dir of [ROOT, STATE, RUN, dirname(ADMIN_SOCKET), JOURNAL, STAGING]) checkDirectories(dir);
  for (const dir of [dirname(ADMIN_SOCKET), JOURNAL, STAGING]) protectedDirectory(dir, true);
  const profile = lstatSync(PROFILE);
  if (!profile.isDirectory() || profile.uid !== m.profile.uid || profile.gid !== m.profile.gid || (profile.mode & 0o777) !== 0o700) {
    throw new Error("Chrome profile is not dedicated");
  }
  for (const e of m.epochs) for (const who of [e.editor, e.receipt]) {
    const d = protectedDirectory(roleDirectory(who.user));
    if (d.uid !== 0 || d.gid !== who.gid || (d.mode & 0o777) !== 0o710) throw new Error("unsafe SSH role directory");
  }
  policyScope();
  return {
    profileIdentity: `${profile.dev}:${profile.ino}`,
    probe() {
      probeGuard(m, g);
      if (!readSshConfig().equals(ssh)) throw new Error("SSH configuration changed");
      accountRestrictions(m);
    },
    requireRole(who: Account) { roleKeys(m, [m.forward.user, who.user]); },
    // The root-only launch record already binds the attested network namespace.
    // Do not read the higher-capability sshd master's procfs namespace or exe links.
    forwardIdentity() {
      try {
        const master = sshMaster(g.cgroup, scope);
        if (!master) return null;
        const hex = m.proxyPort.toString(16).toUpperCase().padStart(4, "0");
        const listeners = ["tcp", "tcp6"].flatMap((file) => readFileSync(`/proc/net/${file}`, "utf8").trim().split("\n").slice(1)
          .map((line) => line.trim().split(/\s+/)).filter((cols) => cols[3] === "0A" && cols[1]?.endsWith(`:${hex}`)));
        const socket = listeners[0];
        if (listeners.length !== 1 || !socket || socket[1] !== `0100007F:${hex}` || socket[7] !== String(m.forward.uid) || !/^\d+$/.test(socket[9] ?? "")) return null;
        // The attached host guard grants this UID only in the fixed sshd cgroup.
        // This is a listener identity, not the exclusion mechanism.
        return master === sshMaster(g.cgroup, scope) ? `${master}:${socket[9]}` : null;
      } catch { /* absent or unobservable means not enrolled */ }
      return null;
    },
  };
}

export function proc(pid: string | number, readExecutable = false) {
  try {
    const dir = `/proc/${pid}`;
    const stat = readFileSync(`${dir}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    const start = fields[19];
    if (!start || !/^\d+$/.test(start) || /[XZ]/.test(fields[0] ?? "")) return null;
    const status = readFileSync(`${dir}/status`, "utf8");
    const uid = Number(/^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1]);
    const cgroup = /^0::(\S+)$/m.exec(readFileSync(`${dir}/cgroup`, "utf8"))?.[1];
    let exe: string | undefined;
    if (readExecutable) {
      try { exe = readlinkSync(`${dir}/exe`); } catch { /* credential transition can restrict procfs links */ }
    }
    return { uid, cgroup, exe, start, ppid: Number(fields[1]),
      noNewPrivs: /^NoNewPrivs:\s+1$/m.test(status) };
  } catch { return null; }
}
