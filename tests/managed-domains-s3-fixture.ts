import assert from "node:assert/strict";
import { Database } from "bun:sqlite";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { createConnection } from "node:net";
import type { Duplex, Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, utils, type ClientChannel, type ExecOptions } from "ssh2";
import { createDomainIngress, domainCommands, type RemoteOperation, type RoleIngress } from "../server/domain-ingress";
import { openDomainAuthority, type LiveProxyRevision } from "../server/domain-authority";
import type { EnrolledChrome } from "../server/domain-observer";
import { DIRECT_WITNESS_HELPER, DIRECT_WITNESS_MAPPING, startDirectWitness } from "../server/domain-direct-witness";
import { DOMAIN_POLICY_FILE, fileDomainPolicySink, hashBytes, renderDomainPolicy } from "../src/domain-policy";
import { createProofOutbox } from "../src/domain-proof-outbox";
import { DOMAIN_COMMAND_UNAVAILABLE, DOMAIN_RESPONSE_LIMIT } from "../src/domain-protocol";
import type { PublisherOperation, ProxyPublicationReceipt } from "../src/domain-publisher";
import { domainRoleClient, proofHost } from "../src/domain-wire";
import { parseManagedDomainSnapshot } from "../src/managed-domains";
import { createManagedProxy } from "../src/proxy";
import { connectSsh, fingerprint } from "../src/tunnel";
import { main, type Io } from "../src/cli";
import { loadConfig } from "../src/config";
import { enrollmentBinding, managedKeyFingerprint } from "../src/domain-enrollment";
import { fixtureOrigins, fixtureVisits } from "./managed-domains-browser-routes";

const enroll = "isolated-fixture";
const sshPort = 22183;
const proxyPort = 18883;
const initial = ["mozilla.org", "wikipedia.org"];
const capacityRevision = 9007199254740960;
const longHost = (i: number) => `${i.toString(16).padStart(3, "0")}${"a".repeat(60)}.${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}.org`;
const capacityInitial = Array.from({ length: 127 }, (_, i) => longHost(i));
const capacityAdd = longHost(127);
const capacityKeep = capacityInitial[0]!;
const checkedFixtureAddress = "1.1.1.1";
const commandBin = "/usr/local/bin/st-domains-command";
const roles = { st_editor: 41111, st_receipt: 41112, st_editor_next: 41113, st_receipt_next: 41114, st_forward: 41115 } as const;
type Account = keyof typeof roles;

const directWitness = { uid: 41116, gid: 41116, mapping: DIRECT_WITNESS_MAPPING } as const;
function cmd(file: string, args: string[]): string {
  const result = spawnSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 12000 });
  if (result.status !== 0) throw new Error(`${file} failed (${result.status}): ${result.stderr.slice(0, 1000)}`);
  return result.stdout;
}

async function until(ok: () => boolean, ms = 4000) {
  const end = performance.now() + ms;
  while (!ok()) {
    if (performance.now() >= end) throw new Error("fixture condition timed out");
    await sleep(20);
  }
}

function value<T>(result: { ok: true; value: T } | { ok: false; code: string } | undefined): T {
  if (!result?.ok) throw new Error(result?.code ?? "missing result");
  return result.value;
}

type Response = { code: number | undefined; stdout: string };
function collect(channel: ClientChannel): Promise<Response> {
  let stdout = "";
  channel.on("data", (chunk: Buffer) => { stdout += chunk.toString(); if (stdout.length > 128 * 1024) channel.destroy(); });
  channel.stderr.resume();
  return new Promise((resolve) => channel.once("close", (code: number | undefined) => resolve({ code, stdout })));
}

function exec(client: Client, command: string, options: ExecOptions & { agentForward?: boolean } = {}): Promise<ClientChannel> {
  return new Promise((resolve, reject) => client.exec(command, options, (err, channel) => err ? reject(err) : resolve(channel)));
}

async function request(client: Client, name: RemoteOperation, body?: unknown) {
  const channel = await exec(client, domainCommands[name]);
  const reply = collect(channel);
  channel.end(body === undefined ? undefined : JSON.stringify(body));
  const result = await reply;
  assert.equal(result.code, 0, `${name} exited ${result.code} after ${Buffer.byteLength(result.stdout)} stdout bytes`);
  assert(Buffer.byteLength(result.stdout) <= DOMAIN_RESPONSE_LIMIT);
  return JSON.parse(result.stdout);
}

function snapshot(revision: number, domains: readonly string[]) {
  const result = parseManagedDomainSnapshot(revision, domains);
  if (!result.ok) throw new Error(result.code);
  return result.snapshot;
}

const operationId = (epoch: number, expected: number, id: number) => `${epoch}.${expected}.${id.toString(16).padStart(32, "0")}`;

function forwardInode(): string | null {
  // Exactly one LISTEN on the fixed port, in this isolated namespace, owned by the dedicated
  // forward UID. SSH ingress role UIDs are distinct and cannot bind a substitute for this proof.
  const port = proxyPort.toString(16).toUpperCase().padStart(4, "0");
  const listeners = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) => readFileSync(file, "utf8").trim().split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/)).filter((cols) => cols[3] === "0A" && cols[1]?.endsWith(`:${port}`)));
  return listeners.length === 1 && listeners[0]![1] === `0100007F:${port}` && listeners[0]![7] === String(roles.st_forward)
    ? listeners[0]![9] ?? null : null;
}

const ownsForward = () => forwardInode() !== null;

function fixtureChrome(root: string, label: string, uid = 65534, routes?: { spki: string }): ChildProcess {
  const profile = join(root, label);
  mkdirSync(profile, { mode: 0o700 });
  chownSync(profile, uid, uid);
  const rules = routes ? `, MAP ${capacityAdd} 127.0.0.1, MAP ${capacityKeep} 127.0.0.1` : "";
  return spawn("/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--",
    "/opt/google/chrome/chrome", "--headless", "--remote-debugging-pipe", "--disable-setuid-sandbox",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-dev-shm-usage", "--renderer-process-limit=2", "--disable-gpu", `--user-data-dir=${profile}/profile`,
    `--host-resolver-rules=${DIRECT_WITNESS_MAPPING}${rules}, MAP * ^NOTFOUND, EXCLUDE 127.0.0.1`,
    ...(routes ? [`--ignore-certificate-errors-spki-list=${routes.spki}`] : []), "about:blank"], {
    env: { HOME: profile, XDG_CONFIG_HOME: `${profile}/config`, XDG_CACHE_HOME: `${profile}/cache`, PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
}

async function forwardReply(request: string) {
  const socket = createConnection({ host: "127.0.0.1", port: proxyPort });
  socket.setTimeout(2500, () => socket.destroy(new Error("fixture forward timeout")));
  let reply = "";
  try {
    socket.write(request);
    for await (const chunk of socket) {
      reply += chunk.toString("latin1");
      assert(reply.length <= 1024);
    }
    return reply;
  } finally { socket.destroy(); }
}

function fixtureSsh(root: string, sockets: Record<Account, string>) {
  const keys = join(root, "keys");
  const authorized = join(root, "authorized");
  mkdirSync(keys, { mode: 0o700 });
  mkdirSync(authorized, { mode: 0o755 });
  const hostKeyPath = join(keys, "host");
  cmd("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKeyPath]);
  const host = utils.parseKey(readFileSync(hostKeyPath + ".pub"));
  assert(!(host instanceof Error) && !Array.isArray(host));
  const pin = fingerprint(host.getPublicSSH());
  const actualKeys = new Map<Account, Buffer>();
  let matches = "";
  for (const [name, uid] of Object.entries(roles) as [Account, number][]) {
    cmd("/usr/sbin/groupadd", ["-g", String(uid), name]);
    cmd("/usr/sbin/useradd", ["-M", "-u", String(uid), "-g", name, "-d", "/var/empty", "-s", "/bin/sh", name]);
    cmd("/usr/bin/passwd", ["-d", name]);
    const path = join(keys, name);
    cmd("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", path]);
    actualKeys.set(name, readFileSync(path));
    const opts = name === "st_forward" ? `restrict,port-forwarding,permitlisten="127.0.0.1:${proxyPort}"` : "restrict";
    writeFileSync(join(authorized, name), `${opts} ${readFileSync(path + ".pub", "utf8")}`, { mode: 0o644 });
    matches += name === "st_forward"
      ? `\nMatch User ${name}\n  AllowTcpForwarding remote\n  PermitListen 127.0.0.1:${proxyPort}\n  ForceCommand /bin/false\n`
      : `\nMatch User ${name}\n  DisableForwarding yes\n  ForceCommand ${commandBin} ${sockets[name]}/authority.sock\n`;
  }
  mkdirSync("/run/sshd", { recursive: true, mode: 0o755 });
  const config = join(root, "sshd_config");
  writeFileSync(config, `Port ${sshPort}\nListenAddress 127.0.0.1\nHostKey ${hostKeyPath}\nPidFile ${root}/pid\n` +
    `AuthorizedKeysFile ${authorized}/%u\nAllowUsers ${Object.keys(roles).join(" ")}\nAuthenticationMethods publickey\n` +
    `PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitEmptyPasswords no\nPermitRootLogin no\n` +
    `UsePAM no\nPermitUserEnvironment no\nPermitUserRC no\nPermitTTY no\nAllowAgentForwarding no\nX11Forwarding no\n` +
    `AllowStreamLocalForwarding no\nAllowTcpForwarding no\nGatewayPorts no\nPermitOpen none\nLoginGraceTime 5\n` +
    `MaxSessions 4\nMaxStartups 4:50:8\nSubsystem sftp internal-sftp\nLogLevel ERROR\n` + matches, { mode: 0o600 });
  cmd("/usr/sbin/sshd", ["-t", "-f", config]);
  const sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", config], { stdio: ["ignore", "ignore", "inherit"] });
  const target = (user: Account, account = user, key = pin) => ({ host: "127.0.0.1", port: sshPort, user,
    hostKey: key, key: actualKeys.get(account)! });
  const connect = (user: Account, account = user, key = pin) => connectSsh(target(user, account, key), { readyTimeoutMs: 3000 });
  const connectAgentTest = (user: Account) => new Promise<Client>((resolve, reject) => {
    const client = new Client();
    client.on("error", reject);
    client.once("ready", () => resolve(client));
    client.connect({ host: "127.0.0.1", port: sshPort, username: user, privateKey: actualKeys.get(user),
      hostVerifier: (key: Buffer) => fingerprint(key) === pin, readyTimeout: 3000,
      authHandler: ["publickey"], agent: join(root, "fixture-unused-agent.sock") });
  });
  const proxyClient = (user: Account) => domainRoleClient("proxy", target(user));
  return { sshd, connect, connectAgentTest, proxyClient, target, config };
}

function expectDenied(fn: (callback: (error?: Error | null) => void) => unknown) {
  return new Promise<void>((resolve, reject) => fn((err) => err ? resolve() : reject(new Error("unexpected SSH grant"))));
}

export async function runS3Proof(mode: "ssh" | "chrome" | "integrated") {
  assert.equal(process.platform, "linux");
  assert.equal(process.geteuid?.(), 0);
  assert.equal(process.env.ST_ISOLATED_FIXTURE, "c6fd921");
  assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
  chmodSync(DIRECT_WITNESS_HELPER, 0o755);
  const root = mkdtempSync("/run/st-domains-");
  chmodSync(root, 0o755);
  mkdirSync("/var/empty", { recursive: true, mode: 0o755 });
  const journal = join(root, "journal");
  mkdirSync(journal, { mode: 0o700 });
  const policyDir = "/etc/opt/chrome/policies/managed";
  mkdirSync(policyDir, { recursive: true, mode: 0o755 });
  const policyPath = join(policyDir, DOMAIN_POLICY_FILE);
  const baseline = mode === "integrated" ? { revision: capacityRevision, domains: capacityInitial } : { revision: 0, domains: initial };
  writeFileSync(policyPath, renderDomainPolicy(proxyPort, { epoch: 1, revision: baseline.revision, routes: baseline.domains }), { mode: 0o644, flag: "wx" });
  const directories = {} as Record<Account, string>;
  const roleIngress = (name: Account, role: RoleIngress["identity"]["role"], epoch: number): RoleIngress => {
    const base = { enrollment: enroll, epoch };
    return { directory: directories[name], group: roles[name], identity: role === "proxy" ? { role, ...base, generation: `proxy-${epoch}` } : { role, ...base } };
  };
  for (const [name, group] of Object.entries(roles) as [Account, number][]) {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o710 });
    chownSync(directory, 0, group);
    directories[name] = directory;
  }
  const { sshd, connect, connectAgentTest, proxyClient, target, config } = fixtureSsh(root, directories);
  const clients: Client[] = [];
  let chrome: ChildProcess | undefined;
  let sibling: ChildProcess | undefined;
  let controller: { close(): Promise<void> } | undefined;
  try {
    const sshdReady = () => readFileSync("/proc/net/tcp", "utf8").includes(`0100007F:${sshPort.toString(16).toUpperCase()}`);
    if (mode === "integrated") {
      await until(sshdReady);
      const origins = await fixtureOrigins(root, capacityAdd, capacityKeep);
      try {
        chrome = fixtureChrome(root, "enrolled", 65534, origins);
        await integratedProof(root, journal, policyDir, chrome, target, connect, origins);
      } finally { origins.close(); }
      return;
    }
    await until(sshdReady);
    const forward = await connect("st_forward");
    clients.push(forward);
    let live: LiveProxyRevision | null = { generation: "proxy-1", revision: 0, domainsDigest: hashBytes(JSON.stringify(initial)) };
    forward.on("close", () => (live = null));
    let resolves = 0;
    let sendProof = proxyClient("st_receipt");
    const proofs = createProofOutbox((proof) => sendProof.attest(proof));
    let receiptEpoch = 1;
    let suppressCanary = false;
    const proxy = createManagedProxy({
      resolve: async () => { resolves++; return ["1.1.1.1"]; },
      dial: async () => { throw new Error("no real upstream in isolated proof"); },
      log: ({ host, status }) => {
        if (status !== 403 || !host) return;
        if (live && proofHost(host) && (!suppressCanary || host.includes(".live."))) {
          proofs.observe({ ...live, host, enrollment: enroll, epoch: receiptEpoch });
        }
      },
    }, snapshot(0, initial));
    forward.on("tcp connection", (info, accept, reject) => info.destIP === "127.0.0.1" && info.destPort === proxyPort ? proxy.handle(accept() as Duplex) : reject());
    await new Promise<void>((resolve, reject) => forward.forwardIn("127.0.0.1", proxyPort, (err) => err ? reject(err) : resolve()));
    assert(ownsForward(), "fixture sshd forwarding UID owns the fixed loopback port");
    chrome = fixtureChrome(root, "enrolled");
    let ownsEnrolledBrowser = true;
    let ownership = 1;
    let clockOffset = 0;
    const policy = fileDomainPolicySink(policyDir, journal);
    function enrolledBrowser(process: ChildProcess, generation: string, selected: () => boolean): EnrolledChrome {
      return {
        generation, input: process.stdio[3] as Writable, output: process.stdio[4] as Readable,
        ownership: () => selected() && process.exitCode === null && process.signalCode === null && ownsForward() &&
          readdirSync(policyDir).filter((entry) => entry.endsWith(".json")).join() === DOMAIN_POLICY_FILE ? ownership : null,
        directWitness,
      };
    }
    const enrolled = enrolledBrowser(chrome, "isolated-browser-1", () => ownsEnrolledBrowser);
    const browsers = [enrolled];
    const authority = openDomainAuthority({
      enrollment: enroll, journalDir: journal, proxyPort, policy,
      forward: { epoch: 1, generation: "proxy-1" },
      browserRoster: () => ({ version: 0, browsers }), forwardOwnership: enrolled.ownership,
    }, () => performance.now() + clockOffset);
    controller = authority;
    await authority.bind(roleIngress("st_receipt", "proxy", 1));
    assert(await authority.refreshRuntime(), "protected forward challenge did not attest");
    const startedProof = performance.now();
    const provisioned = await authority.provision({ epoch: 1, revision: 0, domains: initial, proxyGeneration: "proxy-1" });
    assert(provisioned, `mandatory baseline was not independently proven (${Math.round(performance.now() - startedProof)} ms)`);
    assert(await authority.observe());
    // close() must see a binding that has started listening but has not registered its completion.
    const closingIngress = createDomainIngress(() => { throw new Error("retired listener dispatched"); });
    const incompleteBind = closingIngress.bind(roleIngress("st_editor", "editor", 1));
    await Promise.all([closingIngress.close(), assert.rejects(incompleteBind, /retired before bind/)]);
    assert(!lstatSync(join(directories.st_editor, "authority.sock"), { throwIfNoEntry: false }));
    await authority.bind(roleIngress("st_editor", "editor", 1));
    const editor = await connect("st_editor");
    const receiptClient = await connect("st_receipt");
    clients.push(editor, receiptClient);

    const inspect = async (client = editor) => value<any>(await request(client, "inspect"));
    assert.equal((await inspect()).active.revision, 0);
    if (mode === "ssh") {
      await assert.rejects(connect("st_editor", "st_receipt"));
      await assert.rejects(connect("st_receipt", "st_editor"));
      await assert.rejects(connect("st_editor", "st_editor", "SHA256:" + "A".repeat(43)));
      for (const [client, account] of [[editor, "st_editor"], [receiptClient, "st_receipt"]] as const) {
        const effective = cmd("/usr/sbin/sshd", ["-T", "-f", config, "-C", `user=${account},host=localhost,addr=127.0.0.1`]);
        for (const deny of ["disableforwarding yes", "allowagentforwarding no", "x11forwarding no", "permittty no", "permituserenvironment no"]) {
          assert(effective.split("\n").includes(deny));
        }
        for (const original of ["id", "domains-v1 inspect; id", "domains-v1 finalize", "domains-v1 disable", "domains-v1 authorizeRecovery", "domains-v1 observe"]) {
          const channel = await exec(client, original);
          const result = collect(channel);
          channel.end();
          assert.deepEqual(await result, { code: 1, stdout: "" });
        }
        await assert.rejects(exec(client, domainCommands.inspect, { pty: true }), /Unable to request a pseudo-terminal/);
        await assert.rejects(exec(client, domainCommands.inspect, { x11: true }), /X11/i);
        const agent = await connectAgentTest(account);
        clients.push(agent);
        await assert.rejects(exec(agent, domainCommands.inspect, { agentForward: true }), /agent forwarding/);
        const shell = await new Promise<ClientChannel>((resolve, reject) => client.shell(false, (err, channel) => err ? reject(err) : resolve(channel)));
        const output = collect(shell);
        shell.end("id\n");
        assert.deepEqual(await output, { code: 1, stdout: "" });
        await expectDenied((done) => client.sftp(done));
        await expectDenied((done) => client.forwardIn("127.0.0.1", 24518, done));
        await expectDenied((done) => client.forwardOut("127.0.0.1", 4, "127.0.0.1", proxyPort, done));
        await expectDenied((done) => client.openssh_forwardInStreamLocal(join(root, "no-forward.sock"), done));
        await expectDenied((done) => client.openssh_forwardOutStreamLocal(join(directories["st_editor"], "authority.sock"), done));
      }
      const payload = { version: 1, operationId: operationId(1, 0, 1), expectedRevision: 0, host: "wikipedia.org" };
      assert.deepEqual(await request(receiptClient, "remove", payload), { ok: false, code: "unauthorized" });
      assert.deepEqual(await request(editor, "begin", payload.operationId), { ok: false, code: "unauthorized" });
      assert.deepEqual(await request(receiptClient, "reconcile", payload.operationId), { ok: false, code: "unauthorized" });
      const late = await exec(editor, domainCommands.remove);
      const lateResult = collect(late);
      await until(() => authority.admittedCount() === 1);
      assert.deepEqual(await request(editor, "reconcile", payload.operationId), { ok: false, code: "operation_cancelled" });
      late.end(JSON.stringify(payload));
      const denied = await lateResult;
      assert.equal(denied.code, 0);
      assert.deepEqual(JSON.parse(denied.stdout), { ok: false, code: "operation_cancelled" });
      const blockers = await Promise.all([connect("st_editor"), connect("st_receipt"), connect("st_editor"), connect("st_receipt")]);
      clients.push(...blockers);
      const held = await Promise.all(blockers.map((client) => exec(client, domainCommands.remove)));
      try {
        await until(() => authority.admittedCount() === 4, 2800);
        assert.deepEqual(await request(editor, "inspect"), { ok: false, code: "limit" });
        assert.deepEqual(await request(receiptClient, "inspect"), { ok: false, code: "limit" });
        assert.equal(value(authority.inspectLocal()).pending, null);
      } finally { for (const channel of held) channel.close(); }
      console.log("[domains C3/C9] real pinned OpenSSH: fixed roles, denied channels and cross-role keys, shared pre-parse admission");
      return;
    }

    // The actual owned SSH forward cannot act as a relay to the affirmative sink,
    // even with the exact synthetic URL or a delayed CONNECT to its ephemeral port.
    const probeHost = `${"b".repeat(32)}.e0.r0.pac.invalid`;
    const probePath = `/${"d".repeat(32)}`;
    const direct = await startDirectWitness(directWitness, probeHost, probePath);
    try {
      assert.notEqual(direct.port, proxyPort);
      assert.match(await forwardReply(`GET http://${probeHost}:${direct.port}${probePath} HTTP/1.1\r\nHost: ${probeHost}:${direct.port}\r\n\r\n`), /^HTTP\/1.1 405 /);
      assert.match(await forwardReply(`CONNECT ${probeHost}:${direct.port} HTTP/1.1\r\n\r\n`), /^HTTP\/1.1 403 /);
      assert.match(await forwardReply(`CONNECT ${probeHost}:443 HTTP/1.1\r\n\r\n`), /^HTTP\/1.1 403 /);
    } finally { direct.close(); }
    assert.equal(await direct.seen, null);

    function ack(grant: PublisherOperation, epoch: number): ProxyPublicationReceipt {
      return { enrollment: enroll, epoch, operationId: grant.operationId, revision: grant.target.policy.revision,
        domainsDigest: grant.target.domainsDigest, proxyGeneration: grant.proxyGeneration };
    }
    async function apply(grant: PublisherOperation) {
      const result = await proxy.activate(grant.homePreimage?.revision ?? grant.expectedRevision,
        snapshot(grant.target.policy.revision, grant.target.domains));
      assert(result.ok);
      live = { generation: grant.proxyGeneration, revision: result.snapshot.revision, domainsDigest: hashBytes(JSON.stringify(result.snapshot.domains)) };
    }
    clockOffset += 31000;
    assert.equal((await inspect()).active, null);
    assert(await authority.refreshRuntime());
    assert(await authority.observe(), "expired evidence needs fresh paired witnesses");
    const requestRemove = { version: 1, operationId: operationId(1, 0, 1), expectedRevision: 0, host: "wikipedia.org" };
    assert.equal(value<any>(await request(editor, "remove", requestRemove)).phase, "claimed");
    const granted = value<PublisherOperation>(await request(receiptClient, "begin", requestRemove.operationId));
    assert.equal(granted.phase, "activating");
    assert(!(await request(receiptClient, "begin", requestRemove.operationId)).ok);
    assert(!(await request(receiptClient, "receipt", ack(granted, 1))).ok);
    await apply(granted);
    assert(await authority.refreshRuntime());
    assert(!(await request(editor, "receipt", ack(granted, 1))).ok);
    assert(!(await request(receiptClient, "receipt", { ...ack(granted, 1), proxyGeneration: "old" })).ok);
    assert.equal(value<PublisherOperation>(await request(receiptClient, "receipt", ack(granted, 1))).phase, "published");
    assert.equal((await inspect()).state, "activation_unknown");
    assert.equal(value(authority.inspectLocal()).lastProven.policy.revision, 0);
    suppressCanary = true;
    assert.equal(await authority.observe(), false, "Chrome error without current nonce evidence must not finalize");
    suppressCanary = false;
    ownsEnrolledBrowser = false;
    sibling = fixtureChrome(root, "sibling", 65533);
    assert.equal(sibling.exitCode, null);
    assert.equal(await authority.observe(), false, "a live sibling on the same disk policy cannot finalize for the enrolled instance");
    assert.equal(value(authority.inspectLocal()).lastProven.policy.revision, 0);
    sibling.kill();
    ownsEnrolledBrowser = true;
    assert.equal(await authority.observe(), false, "restoring a retired ownership token cannot prove readiness");
    ownership++;
    assert(await authority.refreshRuntime());
    assert(await authority.observe(), "same real browser revision did not finalize");
    assert.deepEqual((await inspect()).active, { revision: 1, domains: ["mozilla.org"] });
    const finalized = value(authority.inspectLocal()).lastBrowserProof;
    assert.equal(finalized?.browserGeneration, "isolated-browser-1.2");
    assert.match(finalized!.positive, /^[0-9a-f]{32}\.e1\.r1\.pac\.invalid$/);
    assert.match(finalized!.negative, /^[0-9a-f]{32}\.e0\.r1\.pac\.invalid$/);
    assert(!(await request(editor, "remove", requestRemove)).ok);

    // A granted removal is uncertain after disable, even if its response was lost.
    const lost = { version: 1, operationId: operationId(1, 1, 2), expectedRevision: 1, host: "mozilla.org" };
    assert((await request(editor, "remove", lost)).ok);
    const uncertain = value<PublisherOperation>(await request(receiptClient, "begin", lost.operationId));
    const stalled = await exec(editor, domainCommands.remove);
    const retired = collect(stalled);
    assert.equal(value(await authority.disable(1)), 2);
    await retired;
    await apply(uncertain);
    await assert.rejects(request(receiptClient, "receipt", ack(uncertain, 1)));
    const retiredInspect = await exec(editor, domainCommands.inspect);
    const retiredOutput = collect(retiredInspect);
    retiredInspect.end();
    assert.deepEqual(await retiredOutput, { code: DOMAIN_COMMAND_UNAVAILABLE, stdout: "" });
    assert.equal(value(authority.inspectLocal()).recovery?.operationId, lost.operationId);
    const recoveryId = operationId(2, 1, 3);
    receiptEpoch = 2;
    live = { ...live!, generation: "proxy-2" };
    sendProof = proxyClient("st_receipt_next");
    assert(authority.prepareRecovery({ epoch: 2, generation: "proxy-2" }));
    await authority.bind(roleIngress("st_receipt_next", "proxy", 2));
    assert(await authority.refreshRuntime());
    const recovery = value(authority.authorizeRecovery({ epoch: 2, operationId: recoveryId, proxyGeneration: "proxy-2", domains: [], releaseDirect: [] }));
    assert.deepEqual(recovery.target.policy.routes, ["mozilla.org"]);
    await authority.bind(roleIngress("st_editor_next", "editor", 2));
    const freshEditor = await connect("st_editor_next");
    const freshReceipt = await connect("st_receipt_next");
    clients.push(freshEditor, freshReceipt);
    const currentHome = live!;
    live = { ...currentHome, domainsDigest: "1".repeat(64) };
    assert(await authority.refreshRuntime());
    assert.deepEqual(await request(freshReceipt, "begin", recoveryId), { ok: false, code: "not_ready" });
    live = currentHome;
    assert(await authority.refreshRuntime());
    const recoveryGrant = value<PublisherOperation>(await request(freshReceipt, "begin", recoveryId));
    assert.deepEqual(recoveryGrant.homePreimage, currentHome);
    assert(!Object.hasOwn(recoveryGrant.target.policy, "routes"));
    assert.deepEqual(recoveryGrant.intent, { kind: "recovery" });
    await apply(recoveryGrant);
    assert(await authority.refreshRuntime());
    assert((await request(freshReceipt, "receipt", ack(recoveryGrant, 2))).ok);
    const rogue = join(policyDir, "conflicting.json");
    writeFileSync(rogue, "{}", { flag: "wx" });
    assert.equal(await authority.observe(), false);
    assert.equal((await inspect(freshEditor)).active, null);
    cmd("/bin/rm", [rogue]);
    assert.equal(await authority.observe(), false);
    ownership++;
    assert(await authority.refreshRuntime());
    assert(await authority.observe());
    const done = value(authority.inspectLocal());
    assert.deepEqual(done.lastProven.domains, []);
    assert.deepEqual(done.lastProven.policy.routes, ["mozilla.org"]);
    assert.equal(done.history.find((item) => item.operationId === lost.operationId)?.disposition, "reconciled");
    assert.equal(done.recovery, null);
    assert.deepEqual((await inspect(freshEditor)).active, { revision: recoveryGrant.target.policy.revision, domains: [] });
    assert.equal(resolves, 0, "reserved route witnesses must not reach home DNS");
    forward.end();
    await until(() => !ownsForward());
    assert.equal(await authority.observe(), false);
    assert.equal((await inspect(freshEditor)).state, "activation_unknown");
    console.log("[domains C7/C8/C9/C10/C11] pinned Chrome: authenticated positive over the real SSH forward, affirmative direct GET at the unprivileged loopback sink, wrong forwarding denied, epoch fencing and recovery");
  } finally {
    await controller?.close();
    chrome?.kill();
    sibling?.kill();
    for (const client of clients) client.end();
    sshd.kill();
  }
}

async function integratedProof(
  root: string, journal: string, policyDir: string, chrome: ChildProcess,
  target: ReturnType<typeof fixtureSsh>["target"], connect: ReturnType<typeof fixtureSsh>["connect"],
  origins: Awaited<ReturnType<typeof fixtureOrigins>>,
) {
  const home = join(root, "home");
  mkdirSync(home, { mode: 0o700 });
  const path = join(home, "config.json");
  const dir = `${path}.domains`;
  const tunnel = target("st_forward");
  const editor = target("st_editor");
  const receipt = target("st_receipt");
  mkdirSync(dir, { mode: 0o700 });
  const keyPath = join(home, "tunnel.key");
  for (const [file, key] of [[keyPath, tunnel.key], [join(dir, "editor.key"), editor.key], [join(dir, "proxy.key"), receipt.key]] as const) {
    writeFileSync(file, key, { mode: 0o600, flag: "wx" });
  }
  writeFileSync(path, JSON.stringify({ version: 1, server: { host: tunnel.host, port: tunnel.port, user: tunnel.user, hostKey: tunnel.hostKey },
    remotePort: proxyPort, domains: capacityInitial, keyPath }), { mode: 0o600, flag: "wx" });
  const loaded = loadConfig(path, readFileSync, () => home);
  assert(loaded.ok);
  const epoch = 1;
  const generation = "proxy-1";
  writeFileSync(`${path}.domains.json`, JSON.stringify({ version: 1, enrollment: enroll, epoch, proxyGeneration: generation,
    binding: enrollmentBinding(path, loaded.config), baseline: { revision: capacityRevision, domains: capacityInitial },
    tunnelKey: managedKeyFingerprint(tunnel.key), editor: { user: editor.user, fingerprint: managedKeyFingerprint(editor.key) },
    proxy: { user: receipt.user, fingerprint: managedKeyFingerprint(receipt.key) } }), { mode: 0o600, flag: "wx" });
  let stop: (() => void) | undefined;
  let clockOffset = 0;
  let knownOwner = true;
  const policy = fileDomainPolicySink(policyDir, journal);
  const browsers = [{
    generation: "integrated-browser", input: chrome.stdio[3] as Writable, output: chrome.stdio[4] as Readable, directWitness,
    ownership: () => knownOwner && chrome.exitCode === null && chrome.signalCode === null && ownsForward() &&
      readdirSync(policyDir).filter((name) => name.endsWith(".json")).join() === DOMAIN_POLICY_FILE ? 1 : null,
  }] as const;
  const authority = openDomainAuthority({
    enrollment: enroll, journalDir: journal, proxyPort, policy, forward: { epoch, generation },
    browserRoster: () => ({ version: 0, browsers }), forwardOwnership: browsers[0].ownership,
  }, () => performance.now() + clockOffset);
  const visit = fixtureVisits(chrome, origins);
  const resolved: string[] = [];
  const io: Io = {
    env: {}, platform: "linux", homedir: () => home, stdout: () => {}, stderr: () => {}, readFile: readFileSync, stat: statSync,
    resolve: async () => { throw new Error("fixture must not resolve external names"); },
    dial: async () => { throw new Error("fixture must not dial externally"); },
    managedResolve: async (host) => {
      resolved.push(host);
      assert(host === capacityAdd || host === capacityKeep);
      return [checkedFixtureAddress];
    },
    // Existing fixture I/O seam: leave public-IP and :443 checks intact, but
    // deliver the authorized synthetic egress to the fixture's other loopback origin.
    managedDial: async (address, port, signal) => {
      assert.equal(address, checkedFixtureAddress);
      assert.equal(port, 443);
      const socket = createConnection({ host: "127.0.0.1", port: origins.port, signal });
      return new Promise((resolve, reject) => {
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    },
    managedPollMs: 950, connectTimeoutMs: 3000, onSignal: (fn) => { stop = fn; },
  };
  async function cli(...args: string[]) {
    let stdout = "";
    const code = await main(["--json", "--config", path, ...args], { ...io, stdout: (s) => stdout += s });
    return { code, value: JSON.parse(stdout) };
  }
  const run = main(["--json", "--config", path, "run"], io);
  let editorSsh: Client | undefined;
  let proxySsh: Client | undefined;
  try {
    await until(() => !!stop && ownsForward());
    const forwardIdentity = forwardInode();
    const role = (user: "st_receipt" | "st_editor") => ({ directory: join(root, user), group: roles[user] });
    await authority.bind({ ...role("st_receipt"), identity: { role: "proxy", enrollment: enroll, epoch, generation } });
    assert(await authority.refreshRuntime());
    assert(await authority.provision({ epoch, revision: capacityRevision, domains: capacityInitial, proxyGeneration: generation }));
    // Seed completed history only. The 127→128 claim and all new proofs use the real controller.
    const db = new Database(join(journal, "domains.sqlite"), { create: false });
    try {
      db.transaction(() => {
        const row = db.query<{ body: string }, []>("SELECT body FROM control WHERE id = 1").get()!;
        const prior = JSON.parse(row.body);
        prior.history = Array.from({ length: 32 }, (_, i) => {
          const revision = capacityRevision - 31 + i;
          return { operationId: operationId(epoch, revision - 1, i), revision, disposition: "applied" };
        });
        const next = JSON.stringify(prior);
        db.query("UPDATE control SET body = ?, digest = ? WHERE id = 1").run(next, hashBytes(next));
      }).immediate();
    } finally { db.close(); }
    assert(await authority.observe());
    await authority.bind({ ...role("st_editor"), identity: { role: "editor", enrollment: enroll, epoch } });
    editorSsh = await connect("st_editor");
    proxySsh = await connect("st_receipt");
    let status: Awaited<ReturnType<typeof cli>>;
    for (const until = performance.now() + 5000;;) {
      status = await cli("status", "--tray-scope");
      if (status.value.managedDomains.active?.revision === capacityRevision) break;
      assert(performance.now() < until, "managed run did not report a fresh baseline");
      await sleep(30);
    }
    const scope = ["--expected-enrollment", status.value.trayEnrollment];
    await visit(capacityAdd, "DIRECT");
    await visit(capacityKeep, "PROXY");
    assert(!resolved.includes(capacityAdd), "unselected Add preimage must not reach home DNS");
    const proposal = await cli("domains", "add", capacityAdd, "--expected-revision", String(capacityRevision), ...scope);
    assert.equal(proposal.code, 0);
    const id = proposal.value.pending.operationId;
    clockOffset += 31000;
    const expired = value<any>(await request(proxySsh, "inspect"));
    assert.equal(expired.active, null);
    assert.equal(expired.pending.operationId, id);
    assert.equal(expired.pending.phase, "claimed");
    assert.deepEqual(await request(proxySsh, "begin", id), { ok: false, code: "not_ready" });
    assert(await authority.refreshRuntime(), "protected refresh did not renew the same claim");
    const editorRead = value<any>(await request(editorSsh, "inspect"));
    const proxyRead = value<any>(await request(proxySsh, "inspect"));
    assert.equal(editorRead.history.length, 32);
    assert.equal(proxyRead.history.length, 32);
    assert.equal(proxyRead.active.domains.length, 127);
    assert.equal(proxyRead.pending.target.domains.length, 128);
    assert(proxyRead.pending.target.domains.every((host: string) => host.length === 253));
    assert.equal(proxyRead.pending.target.policy.routes, undefined);
    assert.equal(editorRead.pending.operationId, id);
    assert.equal(proxyRead.pending.operationId, id);
    const wireBytes = (value: unknown) => Buffer.byteLength(JSON.stringify({ ok: true, value }) + "\n");
    console.log(`[domains C9] bounded role inspect replies: editor ${wireBytes(editorRead)} B, proxy ${wireBytes(proxyRead)} B, cap ${DOMAIN_RESPONSE_LIMIT} B`);
    async function publishAndObserve(id: string) {
      const deadline = performance.now() + 12000;
      for (;;) {
        const operation = value(authority.inspectLocal()).pending;
        assert.equal(operation?.operationId, id);
        if (operation.phase === "published") break;
        assert(performance.now() < deadline, "managed run did not publish the admitted operation");
        await authority.refreshRuntime();
        await sleep(150);
      }
      assert(await authority.observe(), "enrolled Chrome did not prove the updated publisher policy");
      assert.equal(forwardInode(), forwardIdentity);
    }
    async function readRevision(revision: number) {
      const deadline = performance.now() + 5000;
      for (;;) {
        const current = await cli("status", "--tray-scope");
        if (current.value.managedDomains.active?.revision === revision) return;
        assert(performance.now() < deadline, "managed run did not report the applied revision");
        await sleep(40);
      }
    }
    await publishAndObserve(id);
    const final = value(authority.inspectLocal());
    assert.equal(final.lastProven.domains.length, 128);
    assert.equal(final.history.length, 32);
    assert.equal(final.history.at(-1)?.operationId, id);
    assert.equal(final.history.at(-1)?.disposition, "applied");
    console.log("[domains C7/C9] 127→128 × 253-byte names and 32 history: both role replies cross production caps; expired claim re-proved and applied by actual managed run");
    const added = capacityRevision + 1;
    await readRevision(added);
    const reconciled = await cli("domains", "retry", id, ...scope);
    assert.equal(reconciled.value.state, "applied");
    assert.equal(reconciled.value.active.revision, added);
    await visit(capacityAdd, "PROXY");
    const addLookups = resolved.filter((name) => name === capacityAdd).length;
    assert(addLookups > 0);
    await visit(capacityKeep, "PROXY");
    const remove = await cli("domains", "remove", capacityAdd, "--expected-revision", String(added), ...scope);
    assert.equal(remove.code, 0);
    await publishAndObserve(remove.value.pending.operationId);
    await readRevision(added + 1);
    const removed = await cli("domains", "retry", remove.value.pending.operationId, ...scope);
    assert.equal(removed.value.state, "applied");
    assert(!removed.value.active.domains.includes(capacityAdd));
    await visit(capacityAdd, "DIRECT");
    await visit(capacityKeep, "PROXY");
    assert.equal(resolved.filter((name) => name === capacityAdd).length, addLookups, "removed host must stop reaching home DNS");
    stop!();
    assert.equal(await run, 0);
    await until(() => !ownsForward());
    const beforeOutage = [...resolved];
    await visit(capacityKeep, "unavailable");
    await visit(capacityAdd, "DIRECT");
    assert.deepEqual(resolved, beforeOutage);
    assert.equal(await authority.observe(), false);
    console.log("[domains C5/C11] actual managed CLI, Linux OpenSSH and enrolled Chrome: add DIRECT→PROXY, remove PROXY→DIRECT, retained PROXY throughout; selected fresh outage never reaches either origin");
  } finally {
    knownOwner = false;
    stop?.();
    await run;
    editorSsh?.end();
    proxySsh?.end();
    await authority.close();
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "ssh" && mode !== "chrome" && mode !== "integrated") throw new Error("invalid isolated proof selection");
  await runS3Proof(mode);
}
