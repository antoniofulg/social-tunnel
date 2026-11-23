import { dlopen, FFIType } from "bun:ffi";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { dirname } from "node:path";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { openDomainAuthority } from "./domain-authority";
import { DIRECT_WITNESS_MAPPING } from "./domain-direct-witness";
import { ADMIN_SOCKET, CHROME, JOURNAL, POLICY, PROFILE, ROOT, SETPRIV, SSH_LAUNCH, SSH_RUN, SSH_SNAPSHOT, STAGING,
  dropped, exact, guardedPlatform, guardedSshd, inspectBindHooks, inspectLegacyPolicy, loadManifest, policyScope, proc, readSshConfig, roleDirectory,
  type Epoch, type Manifest } from "./domain-linux-platform";
import { DOMAIN_POLICY_FILE, fileDomainPolicySink, hashBytes, protectedDirectory, renderDomainPolicy, syncDirectory } from "../src/domain-policy";
import { domainUInt, operationIdFormat } from "../src/domain-wire";
import { parseManagedDomainSnapshot } from "../src/managed-domains";
import { withTimeout } from "../src/proxy";

const MARKER = `${JOURNAL}/bootstrap.json`;
const DB = `${JOURNAL}/domains.sqlite`;
const PAC = `${POLICY}/${DOMAIN_POLICY_FILE}`;
const CONTROL_LIMIT = 70000;
const GUARD_MS = 2500;
const FORWARD_MS = 4200;
const OBSERVE_RETRY_MS = 5500;
const ORIGIN_MS = 22_000;
const utf8 = new TextDecoder("utf-8", { fatal: true });

type Stage = "staged" | "attempted" | "complete";
type Authority = ReturnType<typeof openDomainAuthority>;
const error = (code: string) => ({ ok: false as const, code });
const success = <T>(value: T) => ({ ok: true as const, value });

// Called only after root-local admin admission. Revocation changes the journal, not the PAC.
export function dispatchLocalDisable(raw: unknown, authority: Pick<Authority, "disable">) {
  const request = exact(raw, "op epoch");
  if (request?.op === "disable" && domainUInt(request.epoch)) {
    return authority.disable(request.epoch).then((result) => result ?? error("not_ready"));
  }
}

function safeSmall(path: string, max: number) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== 0 || (s.mode & 0o077) || s.size > max) throw new Error("unsafe service state");
    const data = readFileSync(fd, "utf8");
    if (Buffer.byteLength(data) !== s.size) throw new Error("service state changed");
    return data;
  } finally { closeSync(fd); }
}

function createSynced(path: string, data: string | Buffer, mode: number) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try { writeFileSync(fd, data); fchmodSync(fd, mode); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

function lifecycle(m: Manifest) {
  const binding = hashBytes(JSON.stringify(m));
  return {
    read() {
      const o = exact(JSON.parse(safeSmall(MARKER, 192)), "version binding stage");
      if (!o || o.version !== 1 || o.binding !== binding || (o.stage !== "staged" && o.stage !== "attempted" && o.stage !== "complete")) {
        throw new Error("invalid bootstrap marker or manifest differs");
      }
      return o.stage;
    },
    write(stage: Stage, initial = false) {
      const data = JSON.stringify({ version: 1, binding, stage });
      if (initial) return createSynced(MARKER, data, 0o600);
      const temp = `${JOURNAL}/.bootstrap-${randomBytes(16).toString("hex")}`;
      try {
        createSynced(temp, data, 0o600);
        renameSync(temp, MARKER);
        syncDirectory(JOURNAL);
      } finally { rmSync(temp, { force: true }); }
    },
  };
}

function locked() {
  protectedDirectory(dirname(ADMIN_SOCKET), true);
  const fd = openSync(`${dirname(ADMIN_SOCKET)}/supervisor.lock`, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  const libc = dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  try {
    const s = fstatSync(fd);
    if (!s.isFile() || s.nlink !== 1 || s.uid !== 0 || (s.mode & 0o777) !== 0o600 || libc.symbols.flock(fd, 2 | 4) !== 0) {
      throw new Error("unsafe or already running supervisor");
    }
    return () => { closeSync(fd); libc.close(); };
  } catch (e) { closeSync(fd); libc.close(); throw e; }
}

function stage(m: Manifest) {
  const unlock = locked();
  try {
    if ([MARKER, DB, PAC].some((path) => lstatSync(path, { throwIfNoEntry: false }))) throw new Error("enrollment already staged or requires local review");
    const temp = `${STAGING}/.initial-${randomBytes(16).toString("hex")}`;
    try {
      createSynced(temp, renderDomainPolicy(m.proxyPort, { epoch: m.baseline.epoch, revision: m.baseline.revision, routes: m.baseline.domains }), 0o644);
      // Atomic no-overwrite publication. A crash before the marker still requires local review.
      linkSync(temp, PAC);
      syncDirectory(POLICY);
    } finally { rmSync(temp, { force: true }); syncDirectory(STAGING); }
    lifecycle(m).write("staged", true);
  } finally { unlock(); }
}

function launchChrome(m: Manifest) {
  for (const pid of readdirSync("/proc")) {
    if (/^[1-9]\d*$/.test(pid) && proc(pid)?.uid === m.profile.uid) throw new Error("Chrome UID already in use");
  }
  return spawn(SETPRIV, [...dropped(m.profile), CHROME, "--headless", "--remote-debugging-pipe", "--disable-setuid-sandbox",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-extensions", "--disable-dev-shm-usage", `--user-data-dir=${PROFILE}`, "--profile-directory=Default",
    `--host-resolver-rules=${DIRECT_WITNESS_MAPPING}`, "about:blank"], {
    detached: true, env: { HOME: PROFILE, XDG_CONFIG_HOME: PROFILE, XDG_CACHE_HOME: PROFILE, PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
}

function binding(authority: Authority, m: Manifest, epoch: Epoch, role: "editor" | "proxy") {
  const who = role === "editor" ? epoch.editor : epoch.receipt;
  const scope = { enrollment: m.enrollment, epoch: epoch.epoch };
  return authority.bind({ directory: roleDirectory(who.user), group: who.gid,
    identity: role === "editor" ? { role, ...scope } : { role, ...scope, generation: epoch.generation } });
}

function serialLoop(work: () => Promise<unknown>, delay: number, fail: (e: unknown) => void) {
  const signal = new AbortController();
  const done = (async () => {
    try {
      while (!signal.signal.aborted) {
        const start = performance.now();
        await work();
        await sleep(Math.max(1, delay - (performance.now() - start)), undefined, { signal: signal.signal });
      }
    } catch (e) { if (!signal.signal.aborted) fail(e); }
  })();
  return async () => { signal.abort(); await done; };
}

async function serveSshd(m: Manifest) {
  protectedDirectory(SSH_RUN, true);
  if (lstatSync(SSH_LAUNCH, { throwIfNoEntry: false })) throw new Error("SSH launch record already exists");
  const cfg = readSshConfig();
  createSynced(SSH_SNAPSHOT, cfg, 0o600);
  const ending = Promise.withResolvers<void>();
  const exited = Promise.withResolvers<void>();
  let stopping = false;
  let failure: unknown;
  const stop = (e?: unknown) => {
    if (!stopping) failure = e;
    stopping = true;
    ending.resolve();
  };
  const signal = () => stop();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  let child: ChildProcess | undefined;
  let closeLoop: (() => Promise<void>) | undefined;
  let recorded = false;
  try {
    const launch = guardedSshd(m, cfg);
    const sshd = child = launch.start();
    sshd.once("error", stop);
    sshd.once("exit", () => {
      exited.resolve();
      stop(new Error("owned SSH master exited"));
    });
    if (!sshd.pid) await ending.promise;
    else {
      createSynced(SSH_LAUNCH, JSON.stringify(launch.evidence(sshd.pid)), 0o600);
      recorded = true;
      closeLoop = serialLoop(async () => launch.check(), GUARD_MS, stop);
      await ending.promise;
    }
    if (failure) throw failure;
  } finally {
    stopping = true;
    try {
      if (recorded) rmSync(SSH_LAUNCH);
    } finally {
      if (child?.pid && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        try { await withTimeout(exited.promise, 1800); } catch {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await withTimeout(exited.promise, 1800);
        }
      }
      await closeLoop?.();
      rmSync(SSH_SNAPSHOT);
      process.off("SIGINT", signal);
      process.off("SIGTERM", signal);
    }
  }
}

function control(dispatch: (request: unknown) => Promise<unknown>) {
  const open = new Set<Socket>();
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    if (open.size >= 2) { socket.destroy(); return; }
    open.add(socket);
    const chunks: Buffer[] = [];
    let size = 0;
    const deadline = setTimeout(() => socket.destroy(), 26000);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => { clearTimeout(deadline); open.delete(socket); });
    socket.on("data", (chunk: Buffer) => {
      if ((size += chunk.length) > CONTROL_LIMIT) socket.destroy(); else chunks.push(chunk);
    });
    socket.once("end", () => void (async () => {
      try {
        if (socket.destroyed || size === 0) return socket.destroy();
        const answer = JSON.stringify(await dispatch(JSON.parse(utf8.decode(Buffer.concat(chunks, size)))));
        socket.end(Buffer.byteLength(answer) < CONTROL_LIMIT ? answer + "\n" : '{"ok":false,"code":"limit"}\n');
      } catch { socket.end('{"ok":false,"code":"invalid_request"}\n'); }
    })());
  });
  return {
    async start() {
      if (lstatSync(ADMIN_SOCKET, { throwIfNoEntry: false })) throw new Error("admin socket already exists");
      await new Promise<void>((go, reject) => { server.once("error", reject); server.listen(ADMIN_SOCKET, go); });
    },
    stop: async () => {
      for (const socket of open) socket.destroy();
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function serve(m: Manifest, platform: ReturnType<typeof guardedPlatform>) {
  const unlock = locked();
  const ending = Promise.withResolvers<void>();
  let stopping = false;
  let failed = false;
  const stop = (e?: unknown) => {
    if (e) { failed = true; console.error(e instanceof Error ? e.message : "protected supervisor stopped"); }
    stopping = true;
    ending.resolve();
  };
  const signal = () => stop();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  let child: ChildProcess | undefined;
  let childExit: Promise<unknown> | undefined;
  let authority: Authority | undefined;
  let ipc: ReturnType<typeof control> | undefined;
  const loops: (() => Promise<void>)[] = [];
  let currentAdmin: Promise<unknown> | undefined;
  try {
    const marker = lifecycle(m);
    const boot = marker.read();
    const exists = !!lstatSync(DB, { throwIfNoEntry: false });
    if ((!exists && boot !== "staged") || (exists && boot === "staged")) throw new Error("journal/boot marker mismatch; local review required");
    const fsPolicy = fileDomainPolicySink(POLICY, STAGING);
    const fileIdentity = () => {
      const s = lstatSync(PAC, { bigint: true });
      return `${s.dev}:${s.ino}:${s.ctimeNs}`;
    };
    let policyIdentity = fileIdentity();
    const policy = {
      read() {
        if (policyIdentity !== fileIdentity()) throw new Error("mandatory policy ownership changed");
        return fsPolicy.read();
      },
      replace(expected: string, next: string) {
        if (stopping || policyIdentity !== fileIdentity()) throw new Error("mandatory policy ownership changed");
        fsPolicy.replace(expected, next);
        policyIdentity = fileIdentity();
      },
    };
    if (!exists && policy.read() !== renderDomainPolicy(m.proxyPort, { epoch: m.baseline.epoch, revision: m.baseline.revision, routes: m.baseline.domains })) {
      throw new Error("mandatory baseline differs");
    }
    const browser = child = launchChrome(m);
    childExit = new Promise((resolve) => { browser.once("exit", resolve); browser.once("error", resolve); });
    void childExit.then(() => { if (!stopping) stop(new Error("owned Chrome exited")); });
    const input = browser.stdio[3] as Writable;
    const output = browser.stdio[4] as Readable;
    const lostPipe = () => { if (!stopping) stop(new Error("owned Chrome pipe lost")); };
    input.once("error", lostPipe);
    output.once("end", lostPipe);
    output.once("error", lostPipe);
    const generation = randomBytes(16).toString("hex");
    let ownership = 0;
    let prior: string | null = null;
    let guardUntil = performance.now() + GUARD_MS * 2;
    const lose = () => {
      if (prior !== null) { prior = null; ownership++; }
      return null;
    };
    const own = () => {
      try {
        if (stopping || performance.now() >= guardUntil || !browser.pid || browser.exitCode !== null || browser.signalCode !== null) return lose();
        const p = proc(browser.pid, true);
        if (p?.uid !== m.profile.uid || (p.exe !== undefined && p.exe !== CHROME) || !p.noNewPrivs || !p.start) return lose();
        const profile = lstatSync(PROFILE);
        if (!profile.isDirectory() || `${profile.dev}:${profile.ino}` !== platform.profileIdentity || profile.uid !== m.profile.uid ||
            profile.gid !== m.profile.gid || (profile.mode & 0o777) !== 0o700 || fileIdentity() !== policyIdentity) {
          stop(new Error("protected Chrome resources changed"));
          return null;
        }
        policyScope();
        const forward = platform.forwardIdentity();
        const next = forward ? `${p.start}:${forward}` : null;
        if (next !== prior) { prior = next; ownership++; }
        return next === null ? null : ownership;
      } catch (e) { stop(e); return null; }
    };
    const browsers = [{ generation, input, output, ownership: own, directWitness: { ...m.witness, mapping: DIRECT_WITNESS_MAPPING } }] as const;
    const a = authority = openDomainAuthority({ enrollment: m.enrollment, journalDir: JOURNAL, proxyPort: m.proxyPort, policy,
      forward: { epoch: m.baseline.epoch, generation: m.baseline.proxyGeneration },
      browserRoster: () => ({ version: 0, browsers }), forwardOwnership: own,
    });
    if (exists) {
      a.open();
      if (!a.inspectPolicyLocal()?.ok) throw new Error("mandatory policy is not a journaled image");
      if (boot === "attempted") marker.write("complete");
    }
    let receipt: Epoch | undefined;
    let editor: Epoch | undefined;
    let prepared: Epoch | undefined;
    let lastProofAt = -Infinity;
    let lastObserveAttempt = -Infinity;
    let lastProofRevision: number | undefined;
    let observing: Promise<boolean> | undefined;
    let refreshing: Promise<boolean> | undefined;
    const bindReceipt = async (epoch: Epoch) => {
      if (receipt === epoch) return;
      if (receipt) throw new Error("previous receipt ingress not retired");
      platform.requireRole(epoch.receipt);
      await binding(a, m, epoch, "proxy");
      receipt = epoch;
    };
    const refresh = () => refreshing ??= a.refreshRuntime().finally(() => { refreshing = undefined; });
    const observe = () => observing ??= (async () => {
      lastObserveAttempt = performance.now();
      const result = await a.observe();
      if (!result || stopping) return false;
      const view = a.inspectLocal();
      if (!view?.ok || !view.value.editingEnabled || view.value.recovery) return false;
      const epoch = m.epochs.find((entry) => entry.epoch === view.value.epoch && entry.generation === view.value.proxyGeneration);
      if (!epoch || receipt !== epoch) throw new Error("proved epoch missing protected roles");
      if (editor !== epoch) {
        platform.requireRole(epoch.editor);
        await binding(a, m, epoch, "editor");
        editor = epoch;
      }
      lastProofRevision = view.value.lastProven.policy.revision;
      lastProofAt = performance.now();
      return true;
    })().finally(() => { observing = undefined; });
    if (!exists) await bindReceipt(m.epochs[0]!);
    else {
      const v = a.inspectLocal();
      if (!v?.ok) throw new Error("journal unavailable");
      if (v.value.editingEnabled || v.value.pending) {
        const epoch = m.epochs.find((e) => e.epoch === v.value.epoch && e.generation === v.value.proxyGeneration);
        if (!epoch) throw new Error("current journal scope not provisioned");
        await bindReceipt(epoch);
      }
    }
    async function admin(raw: unknown) {
      if (stopping) return error("unavailable");
      if (exact(raw, "op")?.op === "status") {
        const v = a.inspectLocal();
        if (!v?.ok) return success({ stage: marker.read(), state: "activation_unknown", generation });
        const { epoch, proxyGeneration, editingEnabled, pending, recovery, lastProven } = v.value;
        return success({ epoch, proxyGeneration, journalEditingEnabled: editingEnabled, pending: pending && { operationId: pending.operationId, phase: pending.phase },
          recovery: recovery?.operationId ?? null, lastProven: lastProven.policy.revision, generation, ownership: own() });
      }
      if (exact(raw, "op")?.op === "bootstrap") {
        if (marker.read() !== "staged" || a.inspectLocal() || lstatSync(DB, { throwIfNoEntry: false })) return error("conflict");
        if (!(await refresh()) || stopping) return error("not_ready");
        marker.write("attempted");
        if (!(await a.provision(m.baseline))) {
          if (!lstatSync(DB, { throwIfNoEntry: false })) marker.write("staged");
          return error("not_ready");
        }
        marker.write("complete");
        return success({ staged: false });
      }
      const disable = dispatchLocalDisable(raw, a);
      if (disable) {
        const disabled = await disable;
        if (disabled.ok) { receipt = editor = prepared = undefined; lastProofAt = -Infinity; }
        return disabled;
      }
      const prepare = exact(raw, "op epoch");
      if (prepare?.op === "prepare" && domainUInt(prepare.epoch)) {
        const epoch = m.epochs.find((e) => e.epoch === prepare.epoch);
        if (!epoch || !a.prepareRecovery(epoch)) return error("not_ready");
        await bindReceipt(epoch);
        prepared = epoch;
        return success({ epoch: epoch.epoch, proxyGeneration: epoch.generation });
      }
      const recover = exact(raw, "op epoch operationId expectedRecovery domains releaseDirect");
      if (recover?.op === "recover" && prepared && recover.epoch === prepared.epoch && operationIdFormat(recover.operationId) &&
          (recover.expectedRecovery === null || operationIdFormat(recover.expectedRecovery))) {
        const before = a.inspectLocal();
        if (!before?.ok || before.value.epoch !== prepared.epoch || before.value.pending || before.value.editingEnabled ||
            (before.value.recovery?.operationId ?? null) !== recover.expectedRecovery) return error("conflict");
        const selected = parseManagedDomainSnapshot(0, recover.domains);
        const release = parseManagedDomainSnapshot(0, recover.releaseDirect);
        if (!selected.ok || !release.ok) return error("invalid_request");
        const result = a.authorizeRecovery({ epoch: prepared.epoch, proxyGeneration: prepared.generation, operationId: recover.operationId,
          domains: selected.snapshot.domains, releaseDirect: release.snapshot.domains });
        if (!result?.ok) return result ?? error("not_ready");
        prepared = undefined;
        return success({ operationId: result.value.operationId, revision: result.value.target.policy.revision });
      }
      return error("invalid_request");
    }
    ipc = control(async (request) => {
      if (currentAdmin || stopping) return error("busy");
      const response = currentAdmin = admin(request);
      try { return await response; } finally { currentAdmin = undefined; }
    });
    await ipc.start();
    loops.push(serialLoop(async () => {
      if (performance.now() >= guardUntil) lose();
      platform.probe();
      guardUntil = performance.now() + 2 * GUARD_MS;
      own();
    }, GUARD_MS, stop));
    loops.push(serialLoop(async () => { if (own() !== null && receipt) await refresh(); }, FORWARD_MS, stop));
    loops.push(serialLoop(async () => {
      if (own() === null || currentAdmin || refreshing || performance.now() - lastObserveAttempt < OBSERVE_RETRY_MS) return;
      const v = a.inspectLocal();
      if (!v?.ok) return;
      const p = v.value.pending;
      if (p?.phase === "published" || (p?.phase === "claimed" && p.intent.kind !== "recovery" && !editor) || (!p && v.value.editingEnabled &&
          (v.value.lastProven.policy.revision !== lastProofRevision || performance.now() - lastProofAt > ORIGIN_MS))) await observe();
    }, 1400, stop));
    await ending.promise;
  } finally {
    stopping = true;
    await ipc?.stop();
    await authority?.close();
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, "SIGTERM"); } catch { /* already gone */ }
      try { await withTimeout(childExit!, 1800); } catch {
        if (child.exitCode === null && child.signalCode === null) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
          await withTimeout(childExit!, 1800);
        }
      }
    }
    child?.stdio[3]?.destroy();
    child?.stdio[4]?.destroy();
    await withTimeout(Promise.allSettled([...loops.map((close) => close()), currentAdmin]), 7000);
    unlock();
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
  }
  if (failed) throw new Error("protected supervisor failed closed");
}

async function probeBinding(port: number) {
  if (!process.geteuid?.() || !Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("invalid bind exclusion probe");
  async function denied(host: string) {
    const server = createServer();
    return withTimeout(new Promise<boolean>((resolve) => {
      server.once("error", (e: NodeJS.ErrnoException) => resolve(e.code === "EACCES" || e.code === "EPERM"));
      server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(false)));
    }), 600);
  }
  for (const host of ["127.0.0.1", "0.0.0.0", "::1", "::"]) {
    if (!(await denied(host))) throw new Error(`kernel did not deny protected bind: ${host}`);
  }
  console.log("ipv4-and-ipv6-denied");
}

async function sendAdmin(request: unknown) {
  const dir = protectedDirectory(dirname(ADMIN_SOCKET), true);
  const s = lstatSync(ADMIN_SOCKET);
  if (dir.uid !== 0 || !s.isSocket() || s.uid !== 0 || (s.mode & 0o077)) throw new Error("unsafe admin path");
  const socket = createConnection({ path: ADMIN_SOCKET });
  const result = Promise.withResolvers<string>();
  let data = "";
  socket.on("data", (chunk: Buffer) => {
    if (Buffer.byteLength(data) + chunk.length > CONTROL_LIMIT) return socket.destroy(new Error("admin reply too large"));
    data += chunk.toString("utf8");
  });
  socket.once("error", result.reject);
  socket.once("end", () => result.resolve(data));
  try {
    socket.end(JSON.stringify(request));
    const response = JSON.parse(await withTimeout(result.promise, 27000));
    console.log(JSON.stringify(response));
    if (!response.ok) process.exitCode = 1;
  } finally { socket.destroy(); }
}

if (import.meta.main) {
  try {
    const [op, arg, extra, fourth, fifth] = process.argv.slice(2);
    if (process.platform === "linux" && op === "bind-probe" && arg && !extra) await probeBinding(Number(arg));
    else {
      if (process.platform !== "linux" || process.geteuid?.() !== 0 || fifth || (extra && op !== "attest-bind")) throw new Error("Linux local root required");
      process.umask(0o077);
      if (op === "attest-bind" && arg && extra && fourth) {
        const attestation = inspectBindHooks(loadManifest(), arg, extra, fourth);
        const temp = `${ROOT}/.bind-guard-${randomBytes(16).toString("hex")}`;
        try {
          createSynced(temp, JSON.stringify(attestation), 0o600);
          renameSync(temp, `${ROOT}/bind-guard.json`);
          syncDirectory(ROOT);
        } finally { rmSync(temp, { force: true }); }
      } else if (op === "serve-sshd" && !arg) {
        await serveSshd(loadManifest());
      } else if ((op === "stage" || op === "serve") && !arg) {
        const m = loadManifest();
        const platform = guardedPlatform(m, op === "stage");
        if (op === "stage") stage(m); else await serve(m, platform);
      } else if ((op === "status" || op === "bootstrap") && !arg) await sendAdmin({ op });
      else if ((op === "disable" || op === "prepare") && arg && /^\d{1,16}$/.test(arg) && domainUInt(Number(arg))) await sendAdmin({ op, epoch: Number(arg) });
      else if ((op === "recover" || op === "legacy-preflight") && !arg) {
        let bytes = 0;
        const input: Buffer[] = [];
        for await (const chunk of process.stdin) {
          if ((bytes += chunk.length) > CONTROL_LIMIT) throw new Error(`${op} request too large`);
          input.push(chunk);
        }
        let inputJson: unknown;
        try { inputJson = JSON.parse(utf8.decode(Buffer.concat(input, bytes))); }
        catch { throw new Error(`invalid ${op} request`); }
        if (op === "legacy-preflight") {
          console.log(JSON.stringify({ ok: true, ...inspectLegacyPolicy(inputJson) }));
        } else {
          const req = exact(inputJson, "epoch operationId expectedRecovery domains releaseDirect");
          if (!req) throw new Error("invalid recovery request");
          await sendAdmin({ ...req, op });
        }
      } else throw new Error("use legacy-preflight (domain array stdin), attest-bind <cgroup> <ipv4-tag> <ipv6-tag>, stage, serve, serve-sshd, status, bootstrap, disable <epoch>, prepare <epoch>, or recover (JSON stdin)");
    }
  } catch (e) { console.error(e instanceof Error ? e.message : "managed supervisor unavailable"); process.exitCode = 1; }
}
