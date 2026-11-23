import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { chmodSync, chownSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Duplex, Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { Client, utils, type ClientChannel, type ExecOptions } from "ssh2";
import { domainCommands, type RemoteOperation, type RoleIngress } from "../server/domain-ingress";
import { openDomainAuthority, type LiveProxyRevision } from "../server/domain-authority";
import { createDomainObserver, type EnrolledChrome } from "../server/domain-observer";
import { DOMAIN_POLICY_FILE, fileDomainPolicySink, hashBytes, renderDomainPolicy } from "../src/domain-policy";
import type { PublisherOperation, ProxyPublicationReceipt } from "../src/domain-publisher";
import { parseManagedDomainSnapshot } from "../src/managed-domains";
import { createManagedProxy } from "../src/proxy";
import { connectSsh, fingerprint } from "../src/tunnel";

const enroll = "isolated-fixture";
const sshPort = 22183;
const proxyPort = 18883;
const initial = ["mozilla.org", "wikipedia.org"];
const commandBin = "/usr/local/bin/st-domains-command";
const roles = { st_editor: 41111, st_receipt: 41112, st_editor_next: 41113, st_receipt_next: 41114, st_forward: 41115 } as const;
type Account = keyof typeof roles;

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
  assert.equal(result.code, 0);
  return JSON.parse(result.stdout);
}

function snapshot(revision: number, domains: readonly string[]) {
  const result = parseManagedDomainSnapshot(revision, domains);
  if (!result.ok) throw new Error(result.code);
  return result.snapshot;
}

const operationId = (epoch: number, expected: number, id: number) => `${epoch}.${expected}.${id.toString(16).padStart(32, "0")}`;

function ownsForward(): boolean {
  // Exactly one LISTEN on the fixed port, in this isolated namespace, owned by the dedicated
  // forward UID. SSH ingress role UIDs are distinct and cannot bind a substitute for this proof.
  const port = proxyPort.toString(16).toUpperCase().padStart(4, "0");
  const listeners = ["/proc/net/tcp", "/proc/net/tcp6"].flatMap((file) => readFileSync(file, "utf8").trim().split("\n").slice(1)
    .map((line) => line.trim().split(/\s+/)).filter((cols) => cols[3] === "0A" && cols[1]?.endsWith(`:${port}`)));
  return listeners.length === 1 && listeners[0]![1] === `0100007F:${port}` && listeners[0]![7] === String(roles.st_forward);
}

function fixtureChrome(root: string, label: string, uid = 65534): ChildProcess {
  const profile = join(root, label);
  mkdirSync(profile, { mode: 0o700 });
  chownSync(profile, uid, uid);
  return spawn("/usr/bin/setpriv", [`--reuid=${uid}`, `--regid=${uid}`, "--clear-groups", "--no-new-privs", "--",
    "/opt/google/chrome/chrome", "--headless", "--remote-debugging-pipe", "--disable-setuid-sandbox",
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync",
    "--disable-dev-shm-usage", "--renderer-process-limit=2", "--disable-gpu", `--user-data-dir=${profile}/profile`,
    "--host-resolver-rules=MAP *.pac.invalid ^NOTFOUND, MAP * ^NOTFOUND, EXCLUDE 127.0.0.1", "about:blank"], {
    env: { HOME: profile, XDG_CONFIG_HOME: `${profile}/config`, XDG_CACHE_HOME: `${profile}/cache`, PATH: "/usr/bin:/bin" },
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
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
  const connect = (user: Account, account = user, key = pin) => connectSsh({ host: "127.0.0.1", port: sshPort, user,
    hostKey: key, key: actualKeys.get(account)! }, { readyTimeoutMs: 3000 });
  const connectAgentTest = (user: Account) => new Promise<Client>((resolve, reject) => {
    const client = new Client();
    client.on("error", reject);
    client.once("ready", () => resolve(client));
    client.connect({ host: "127.0.0.1", port: sshPort, username: user, privateKey: actualKeys.get(user),
      hostVerifier: (key: Buffer) => fingerprint(key) === pin, readyTimeout: 3000,
      authHandler: ["publickey"], agent: join(root, "fixture-unused-agent.sock") });
  });
  return { sshd, connect, connectAgentTest, config };
}

function expectDenied(fn: (callback: (error?: Error | null) => void) => unknown) {
  return new Promise<void>((resolve, reject) => fn((err) => err ? resolve() : reject(new Error("unexpected SSH grant"))));
}

export async function runS3Proof(mode: "ssh" | "chrome") {
  assert.equal(process.platform, "linux");
  assert.equal(process.geteuid?.(), 0);
  assert.equal(process.env.ST_ISOLATED_FIXTURE, "c6fd921");
  assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
  const root = mkdtempSync("/run/st-domains-");
  chmodSync(root, 0o755);
  mkdirSync("/var/empty", { recursive: true, mode: 0o755 });
  const journal = join(root, "journal");
  mkdirSync(journal, { mode: 0o700 });
  const policyDir = "/etc/opt/chrome/policies/managed";
  mkdirSync(policyDir, { recursive: true, mode: 0o755 });
  const policyPath = join(policyDir, DOMAIN_POLICY_FILE);
  writeFileSync(policyPath, renderDomainPolicy(proxyPort, { epoch: 1, revision: 0, routes: initial }), { mode: 0o644, flag: "wx" });
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
  const { sshd, connect, connectAgentTest, config } = fixtureSsh(root, directories);
  const clients: Client[] = [];
  let chrome: ChildProcess | undefined;
  let sibling: ChildProcess | undefined;
  let controller: { close(): Promise<void> } | undefined;
  try {
    const sshdReady = () => readFileSync("/proc/net/tcp", "utf8").includes(`0100007F:${sshPort.toString(16).toUpperCase()}`);
    await until(sshdReady);
    const forward = await connect("st_forward");
    clients.push(forward);
    let live: LiveProxyRevision | null = { generation: "proxy-1", revision: 0, domainsDigest: hashBytes(JSON.stringify(initial)) };
    forward.on("close", () => (live = null));
    let watch: { names: Set<string>; seen: Set<string> } | undefined;
    let resolves = 0;
    const proxy = createManagedProxy({
      resolve: async () => { resolves++; return ["1.1.1.1"]; },
      dial: async () => { throw new Error("no real upstream in isolated proof"); },
      log: ({ host, status }) => { if (status === 403 && host && watch?.names.has(host)) watch.seen.add(host); },
    }, snapshot(0, initial));
    forward.on("tcp connection", (info, accept, reject) => info.destIP === "127.0.0.1" && info.destPort === proxyPort ? proxy.handle(accept() as Duplex) : reject());
    await new Promise<void>((resolve, reject) => forward.forwardIn("127.0.0.1", proxyPort, (err) => err ? reject(err) : resolve()));
    assert(ownsForward(), "fixture sshd forwarding UID owns the fixed loopback port");
    chrome = fixtureChrome(root, "enrolled");
    let ownsEnrolledBrowser = true;
    const policy = fileDomainPolicySink(policyDir, journal);
    let suppressCanary = false;
    function enrolledBrowser(process: ChildProcess, generation: string, selected: () => boolean): EnrolledChrome {
      return {
        generation, input: process.stdio[3] as Writable, output: process.stdio[4] as Readable,
        ownsContext: () => selected() && process.exitCode === null && process.signalCode === null && ownsForward() &&
          readdirSync(policyDir).filter((entry) => entry.endsWith(".json")).join() === DOMAIN_POLICY_FILE,
        watchCanaries(positive, negative) {
          const probe = { names: new Set([positive, negative]), seen: new Set<string>() };
          watch = probe;
          return { seen: (host) => !suppressCanary && probe.seen.has(host), close: () => { watch = undefined; } };
        },
      };
    }
    const authority = openDomainAuthority({
      enrollment: enroll, journalDir: journal, proxyPort, policy, liveProxy: () => live,
      chrome: enrolledBrowser(chrome, "isolated-browser-1", () => ownsEnrolledBrowser),
    });
    controller = authority;
    assert(await authority.provision({ epoch: 1, revision: 0, domains: initial, proxyGeneration: "proxy-1" }), "mandatory baseline was not independently proven");
    assert(await authority.observe());
    await authority.bind(roleIngress("st_editor", "editor", 1));
    await authority.bind(roleIngress("st_receipt", "proxy", 1));
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
      const blockers = await Promise.all([connect("st_editor"), connect("st_receipt"), connect("st_editor"), connect("st_receipt")]);
      clients.push(...blockers);
      const held = await Promise.all(blockers.map((client) => exec(client, domainCommands.remove)));
      try {
        // Through both role endpoints, continue until all four incomplete requests own admission slots.
        let limited = false;
        for (let i = 0; i < 8 && !limited; i++) {
          limited = (await request(editor, "inspect")).code === "limit";
          if (!limited) await sleep(20);
        }
        assert(limited, "shared role budget did not block inspect");
        assert.deepEqual(await request(receiptClient, "inspect"), { ok: false, code: "limit" });
        assert.equal(value(authority.inspectLocal()).pending, null);
      } finally { for (const channel of held) channel.close(); }
      console.log("[domains C3/C9] real pinned OpenSSH: fixed roles, denied channels and cross-role keys, shared pre-parse admission");
      return;
    }

    function ack(grant: PublisherOperation, epoch: number): ProxyPublicationReceipt {
      return { enrollment: enroll, epoch, operationId: grant.operationId, revision: grant.target.policy.revision,
        domainsDigest: grant.target.domainsDigest, proxyGeneration: grant.proxyGeneration };
    }
    async function apply(grant: PublisherOperation, from: number) {
      const result = await proxy.activate(from, snapshot(grant.target.policy.revision, grant.target.domains));
      assert(result.ok);
      live = { generation: grant.proxyGeneration, revision: result.snapshot.revision, domainsDigest: hashBytes(JSON.stringify(result.snapshot.domains)) };
    }
    const requestRemove = { version: 1, operationId: operationId(1, 0, 1), expectedRevision: 0, host: "wikipedia.org" };
    assert.equal(value<any>(await request(editor, "remove", requestRemove)).phase, "claimed");
    const granted = value<PublisherOperation>(await request(receiptClient, "begin", requestRemove.operationId));
    assert.equal(granted.phase, "activating");
    assert(!(await request(receiptClient, "begin", requestRemove.operationId)).ok);
    assert(!(await request(receiptClient, "receipt", ack(granted, 1))).ok);
    await apply(granted, 0);
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
    const unrelated = createDomainObserver(enrolledBrowser(sibling, "isolated-browser-2", () => true));
    assert.equal((await unrelated.prove(granted.target.policy, policy.read()))?.generation, "isolated-browser-2");
    assert.equal(await authority.observe(), false, "a live sibling on the same disk policy cannot finalize for the enrolled instance");
    assert.equal(value(authority.inspectLocal()).lastProven.policy.revision, 0);
    sibling.kill();
    ownsEnrolledBrowser = true;
    assert(await authority.observe(), "same real browser revision did not finalize");
    assert.deepEqual((await inspect()).active, { revision: 1, domains: ["mozilla.org"] });
    const finalized = value(authority.inspectLocal()).lastBrowserProof;
    assert.equal(finalized?.browserGeneration, "isolated-browser-1");
    assert.match(finalized!.positive, /^[0-9a-f]{32}\.e1\.r1\.pac\.invalid$/);
    assert.match(finalized!.negative, /^[0-9a-f]{32}\.e0\.r1\.pac\.invalid$/);
    assert(!(await request(editor, "remove", requestRemove)).ok);

    // A granted removal is uncertain after disable, even if its response was lost.
    const lost = { version: 1, operationId: operationId(1, 1, 2), expectedRevision: 1, host: "mozilla.org" };
    assert((await request(editor, "remove", lost)).ok);
    const uncertain = value<PublisherOperation>(await request(receiptClient, "begin", lost.operationId));
    assert.equal(value(authority.disable(1)), 2);
    await apply(uncertain, 1);
    assert.deepEqual(await request(receiptClient, "receipt", ack(uncertain, 1)), { ok: false, code: "fenced" });
    assert.deepEqual(await request(editor, "inspect"), { ok: false, code: "fenced" });
    assert.equal(value(authority.inspectLocal()).recovery?.operationId, lost.operationId);
    const recoveryId = operationId(2, 1, 3);
    const recovery = value(authority.authorizeRecovery({ epoch: 2, operationId: recoveryId, proxyGeneration: "proxy-2", domains: [], releaseDirect: [] }));
    assert.deepEqual(recovery.target.policy.routes, ["mozilla.org"]);
    await authority.bind(roleIngress("st_editor_next", "editor", 2));
    await authority.bind(roleIngress("st_receipt_next", "proxy", 2));
    const freshEditor = await connect("st_editor_next");
    const freshReceipt = await connect("st_receipt_next");
    clients.push(freshEditor, freshReceipt);
    const recoveryGrant = value<PublisherOperation>(await request(freshReceipt, "begin", recoveryId));
    await apply(recoveryGrant, uncertain.target.policy.revision);
    assert((await request(freshReceipt, "receipt", ack(recoveryGrant, 2))).ok);
    const rogue = join(policyDir, "conflicting.json");
    writeFileSync(rogue, "{}", { flag: "wx" });
    assert.equal(await authority.observe(), false);
    assert.equal((await inspect(freshEditor)).active, null);
    cmd("/bin/rm", [rogue]);
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
    console.log("[domains C7/C8/C9/C10/C11] protected Chrome reload and paired route witnesses on the real disposable SSH forward; epoch fencing and proved recovery");
  } finally {
    await controller?.close();
    chrome?.kill();
    sibling?.kill();
    for (const client of clients) client.end();
    sshd.kill();
  }
}

if (import.meta.main) {
  const mode = process.argv[2];
  if (mode !== "ssh" && mode !== "chrome") throw new Error("invalid isolated proof selection");
  await runS3Proof(mode);
}
