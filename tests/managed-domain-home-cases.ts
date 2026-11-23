import { expect, test } from "bun:test";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { Server, utils, type Connection, type ServerChannel } from "ssh2";
import { main } from "../src/cli";
import { domainAction } from "../src/domain-cli";
import { loadConfig } from "../src/config";
import { captureDomainSelection, enrollmentBinding, managedKeyFingerprint, readDomainEnrollment, readDomainRole, writeDomainLocal } from "../src/domain-enrollment";
import { dialManagedAddress, resolveManagedHost } from "../src/domain-network";
import { DOMAIN_COMMAND_UNAVAILABLE, DOMAIN_RESPONSE_LIMIT } from "../src/domain-protocol";
import { domainSubmission } from "../src/domain-submission";
import { hashBytes } from "../src/domain-policy";
import type { PublisherOperation, ProxyPublicationReceipt } from "../src/domain-publisher";
import { createManagedRun, readActiveHome } from "../src/domain-runtime";
import { DOMAIN_COMMANDS, domainRoleClient, type DomainAttestation, type DomainVerb, type ProposalBody, type WireError } from "../src/domain-wire";
import { fingerprint } from "../src/tunnel";
import { writeState } from "../src/state";
import { createForwardAttestation } from "../server/forward-attestation";
import { forwardDomainCommand } from "../server/domain-ingress";
import { cli, keyPair, spawnCli, testIo, tmp, until, writeConfig } from "./helpers";
import { pair } from "./proxy-harness";
import { freePort } from "./ssh-server";

const EPOCH = 1;
const GEN = "runtime-1";
const ENROLL = "home-test";
const INITIAL = { revision: 0, domains: ["wikipedia.org"] };
const DENY = "HTTP/1.1 403 Forbidden";

type Account = "tunnel" | "editor" | "proxy";
type Dispatch = (role: Account, verb: DomainVerb, input: string, channel: ServerChannel) => void;
const reply = (channel: ServerChannel, value: unknown) => { channel.exit(0); channel.end(JSON.stringify(value) + "\n"); };
const ok = (value: unknown) => ({ ok: true, value } as const);
const error = <T extends WireError>(code: T) => ({ ok: false, code } as const);

async function sshFixture(dispatch: Dispatch, beforeReady?: () => void) {
  const files = writeConfig();
  const host = keyPair();
  const editor = keyPair();
  const proxy = keyPair();
  const keys = { tunnel: files.publicKey, editor: editor.public, proxy: proxy.public };
  const channels = new Set<net.Socket>();
  const conns = new Set<Connection>();
  const auth: Account[] = [];
  let forwards = 0;
  let status: net.Server | undefined;
  const port = await freePort();
  const server = new Server({ hostKeys: [host.private] }, (conn) => {
    conns.add(conn);
    conn.on("error", () => {});
    conn.once("close", () => conns.delete(conn));
    let account: Account | undefined;
    conn.on("authentication", (ctx) => {
      if (!Object.hasOwn(keys, ctx.username) || ctx.method !== "publickey") return ctx.reject(["publickey"]);
      const role = ctx.username as Account;
      auth.push(role);
      const candidate = utils.parseKey(keys[role]);
      if (candidate instanceof Error || Array.isArray(candidate) || ctx.key.algo !== candidate.type ||
          !ctx.key.data.equals(candidate.getPublicSSH()) || (ctx.signature && candidate.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) !== true)) {
        return ctx.reject(["publickey"]);
      }
      account = role;
      ctx.accept();
    });
    conn.on("ready", () => {
      beforeReady?.();
      conn.on("request", (accept, reject, name, info) => {
        if (account !== "tunnel" || info.bindAddr !== "127.0.0.1" || info.bindPort !== port) return reject?.();
        if (name === "tcpip-forward" && !status) {
          forwards++;
          status = net.createServer((socket) => {
            channels.add(socket);
            socket.on("error", () => {});
            socket.once("close", () => channels.delete(socket));
            conn.forwardOut("127.0.0.1", port, "127.0.0.1", socket.remotePort!, (err, stream) => {
              if (err) return socket.destroy();
              stream.on("error", () => {});
              socket.pipe(stream).pipe(socket);
            });
          });
          status.listen(port, "127.0.0.1", () => accept?.());
        } else if (name === "cancel-tcpip-forward") { status?.close(); status = undefined; accept?.(); }
        else reject?.();
      });
      conn.on("session", (accept, reject) => {
        if (!account || account === "tunnel") return reject?.();
        const session = accept();
        session.on("exec", (allow, no, info) => {
          const verb = (Object.keys(DOMAIN_COMMANDS) as DomainVerb[]).find((v) => DOMAIN_COMMANDS[v] === info.command);
          if (!verb || !account) return no();
          const stream = allow();
          let data = "";
          stream.on("data", (chunk: Buffer) => data += chunk.toString());
          stream.on("end", () => dispatch(account!, verb, data, stream));
        });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const hostKey = utils.parseKey(host.public);
  if (hostKey instanceof Error || Array.isArray(hostKey)) throw new Error("bad fixture host key");
  const actual = server.address() as net.AddressInfo;
  const ssh = { host: "127.0.0.1", port: actual.port, user: "tunnel", hostKey: fingerprint(hostKey.getPublicSSH()) };
  writeFileSync(files.path, JSON.stringify({ version: 1, server: ssh, keyPath: files.keyPath, remotePort: port, domains: ["instagram.com"] }));
  const loaded = loadConfig(files.path, readFileSync, () => files.dir);
  if (!loaded.ok) throw new Error(loaded.message);
  const config = loaded.config;
  const folder = `${files.path}.domains`;
  const metadata = `${files.path}.domains.json`;
  function enroll() {
    mkdirSync(folder, { mode: 0o700 });
    writeFileSync(join(folder, "editor.key"), editor.private, { mode: 0o600 });
    writeFileSync(join(folder, "proxy.key"), proxy.private, { mode: 0o600 });
    writeFileSync(metadata, JSON.stringify({ version: 1, enrollment: ENROLL, epoch: EPOCH, proxyGeneration: GEN,
      binding: enrollmentBinding(files.path, config), baseline: INITIAL, tunnelKey: managedKeyFingerprint(readFileSync(files.keyPath)),
      editor: { user: "editor", fingerprint: managedKeyFingerprint(Buffer.from(editor.private)) },
      proxy: { user: "proxy", fingerprint: managedKeyFingerprint(Buffer.from(proxy.private)) },
    }), { mode: 0o600 });
    const result = captureDomainSelection(files.path, () => files.dir)?.enrollment;
    if (!result) throw new Error("invalid fixture enrollment");
    return result;
  }
  return {
    ...files, config, folder, metadata, enroll, auth, forwards: () => forwards,
    close: async () => {
      for (const conn of conns) conn.end();
      for (const socket of channels) socket.destroy();
      status?.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function connectRequest(port: number, host: string) {
  const socket = net.connect(port, "127.0.0.1");
  socket.on("error", () => {});
  let text = "";
  socket.on("data", (chunk: Buffer) => text += chunk.toString());
  socket.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
  return { socket, status: async () => { await until(() => text.includes("\r\n\r\n")); return text.split("\r\n", 1)[0]; } };
}

const fromJson = (output: string) => JSON.parse(output);

async function runCli(path: string, words: string[]) {
  const result = await cli(["--config", path, "--json", ...words]);
  return { code: result.code, payload: fromJson(result.stdout) };
}

test("[domains C2] [domains C12] legacy and missing enrollment perform no domain writes or SSH", async () => {
  const f = await sshFixture(() => { throw new Error("legacy used managed SSH"); });
  try {
    const before = readdirSync(f.dir).sort();
    const expected = { ok: true, command: "domains", state: "setup_required", active: null, pending: null };
    expect((await runCli(f.path, ["domains", "list"])).payload).toEqual(expected);
    expect((await runCli(f.path, ["domains", "add", "wipo.int", "--expected-revision", "0"])).payload).toEqual(expected);
    const status = (await runCli(f.path, ["status"])).payload;
    expect(status).not.toHaveProperty("managedDomains");
    expect(status.allowlist).toEqual(["instagram.com"]);
    expect(status).not.toHaveProperty("trayEnrollment");
    const scopedStatus = (await runCli(f.path, ["status", "--tray-scope"])).payload;
    expect(scopedStatus.trayEnrollment).toMatch(/^[a-f0-9]{64}$/);
    expect((await runCli(f.path, ["domains", "list", "--expected-enrollment", scopedStatus.trayEnrollment])).payload).toEqual(expected);
    expect(readdirSync(f.dir).sort()).toEqual(before);
    expect(f.auth).toEqual([]);
  } finally { await f.close(); }
});

test("[domains C9] fixed role transport rejects wrong host pin, keys, oversize bodies/outputs and silence", async () => {
  let mode = "accept";
  let received = 0;
  const f = await sshFixture((_role, verb, input, ch) => {
    received++;
    if (mode === "oversize") { ch.exit(0); ch.end(Buffer.alloc(96 * 1024 + 1)); }
    else if (mode === "accept") reply(ch, ok({ verb, body: input }));
  });
  try {
    const enrollment = f.enroll();
    const editor = readDomainRole(enrollment, f.config, "editor")!;
    const proxy = readDomainRole(enrollment, f.config, "proxy")!;
    const client = domainRoleClient("editor", editor, 250);
    expect(await domainRoleClient("editor", { ...editor, hostKey: "SHA256:" + "A".repeat(43) }, 250).inspect()).toEqual(error("unavailable"));
    expect(f.auth).toEqual([]);
    expect(await domainRoleClient("editor", { ...editor, key: proxy.key }, 250).inspect()).toEqual(error("unauthorized"));
    expect(await client.begin("unused")).toEqual(error("unauthorized"));
    expect(await client.propose("add", { version: 1, operationId: "unused", expectedRevision: 0, host: "a".repeat(5000) })).toEqual(error("limit"));
    expect(received).toBe(0);
    expect(await client.inspect()).toEqual(ok({ verb: "inspect", body: "" }));
    mode = "oversize";
    expect(await client.inspect()).toEqual(error("unavailable"));
    mode = "silent";
    expect(await client.inspect()).toEqual(error("unavailable"));
    expect(received).toBe(3);
    writeFileSync(join(f.folder, "proxy.key"), editor.key, { mode: 0o600 });
    expect(readDomainRole(enrollment, f.config, "proxy")).toBeNull();
  } finally { await f.close(); }
});

test("[domains C6] [domains C7] [domains C12] CLI and managed run reconcile one lost claim on one SSH forward and attest only after abort", async () => {
  const activeEmpty = { revision: 1, domains: [] as string[] };
  let proposed = 0;
  let grants = 0;
  let pending: PublisherOperation | null = null;
  let archived: { operationId: string; revision: number; disposition: "applied" }[] = [];
  let observed = INITIAL;
  let baselineProved = false;
  let fault: unknown;
  let lookup: AbortSignal | undefined;
  let receipt: ProxyPublicationReceipt | undefined;
  let receiptAttempted = false;
  let attested: DomainAttestation | undefined;
  let forwardProof: ReturnType<typeof createForwardAttestation>;
  const scope = { epoch: EPOCH, generation: GEN };
  const f = await sshFixture((role, verb, input, ch) => {
    try {
      const live = forwardProof.current(scope);
      if (verb === "attest") {
        const body: DomainAttestation = JSON.parse(input);
        const accepted = role === "proxy" && forwardProof.attest({ enrollment: ENROLL, ...scope }, body);
        if (accepted) attested = body;
        return reply(ch, accepted ? ok(null) : error("receipt_mismatch"));
      }
      if (verb === "inspect" || (role === "editor" && verb === "reconcile")) {
        if (verb === "reconcile" && JSON.parse(input) !== (pending?.operationId ?? archived[0]?.operationId)) {
          return reply(ch, error("unknown_operation"));
        }
        const active = baselineProved && live?.revision === observed.revision && live.domainsDigest === hashBytes(JSON.stringify(observed.domains)) ? observed : null;
        return reply(ch, ok({ epoch: EPOCH, proxyGeneration: GEN, active, activeForMs: active ? forwardProof.freshFor(scope) : 0, lastRevision: observed.revision,
          state: pending ? pending.phase === "published" ? "activation_unknown" : "pending" : active ? "ready" : "activation_unknown",
          pending: role === "proxy" ? pending : pending && { operationId: pending.operationId, operation: "remove", host: "wikipedia.org", phase: pending.phase },
          history: archived,
        }));
      }
      if (role === "editor" && verb === "remove") {
        proposed++;
        const request: ProposalBody = JSON.parse(input);
        pending = { operationId: request.operationId, expectedRevision: 0, proxyGeneration: GEN, phase: "claimed",
          intent: { kind: "remove", proposal: request },
          target: { policy: { epoch: EPOCH, revision: 1, routes: [] }, domains: [], domainsDigest: hashBytes("[]") },
        };
        ch.exit(2); ch.end(); // Commit won, response is lost.
        return;
      }
      if (role === "proxy" && verb === "begin" && pending?.phase === "claimed" && JSON.parse(input) === pending.operationId) {
        grants++;
        pending.phase = "activating";
        return reply(ch, ok(pending));
      }
      if (role === "proxy" && verb === "receipt" && pending?.phase === "activating") {
        receiptAttempted = true;
        if (!lookup?.aborted) throw new Error("home acknowledged before lookup abort");
        const candidate: ProxyPublicationReceipt = JSON.parse(input);
        if (live?.revision !== 1) return reply(ch, error("not_ready"));
        receipt = candidate;
        pending.phase = "published";
        return reply(ch, ok(pending));
      }
      reply(ch, error("conflict"));
    } catch (err) { fault = err; reply(ch, error("unavailable")); }
  });
  forwardProof = createForwardAttestation(ENROLL, f.config.remotePort, () => 1);
  const sockets: net.Socket[] = [];
  let stop: (() => void) | undefined;
  let run: Promise<number> | undefined;
  try {
    f.enroll();
    const runIO = testIo({ connectTimeoutMs: 750, managedPollMs: 40, managedDial: async () => { throw new Error("must not dial"); },
      managedResolve: (_host, signal) => {
        lookup = signal;
        return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      }, onSignal: (fn) => { stop = fn; },
    });
    run = main(["run", "--config", f.path, "--json"], runIO.io);
    await until(() => f.forwards() === 1 && stop !== undefined);
    expect((await runCli(f.path, ["domains", "list"])).payload.active).toBeNull();
    const early = connectRequest(f.config.remotePort, "wikipedia.org");
    sockets.push(early.socket);
    expect(await early.status()).toBe(DENY);
    expect(await forwardProof.refresh(scope)).toBe(true);
    const acceptedBaseline = attested!;
    const target = readDomainRole(readDomainEnrollment(f.path, f.config)!, f.config, "proxy")!;
    expect(await domainRoleClient("proxy", target, 750).attest(acceptedBaseline)).toEqual(error("receipt_mismatch"));
    baselineProved = true;
    await until(() => readFileSync(join(f.folder, "live.json"), "utf8").includes("wikipedia.org"));
    expect((await runCli(f.path, ["status"])).payload.managedDomains.active).toEqual(INITIAL);
    expect((await runCli(f.path, ["domains", "remove", "wikipedia.org", "--expected-revision", "5"])).payload.error.code).toBe("conflict");
    const held = connectRequest(f.config.remotePort, "wikipedia.org");
    sockets.push(held.socket);
    await until(() => !!lookup);
    const removal = await runCli(f.path, ["domains", "remove", "WIKIPEDIA.ORG.", "--expected-revision", "0"]);
    expect(removal.payload.state).toBe("activation_unknown");
    expect(removal.payload.pending.phase).toBe("unconfirmed");
    const id: string = removal.payload.pending.operationId;
    expect((await runCli(f.path, ["domains", "retry", id])).payload.pending.operationId).toBe(id);
    await until(() => receiptAttempted);
    expect(lookup?.aborted).toBe(true);
    expect(await forwardProof.refresh(scope)).toBe(true);
    await until(() => !!receipt || !!fault);
    if (fault) throw fault;
    expect(receipt).toEqual({ enrollment: ENROLL, epoch: EPOCH, operationId: id, revision: 1, domainsDigest: hashBytes("[]"), proxyGeneration: GEN });
    expect((await runCli(f.path, ["domains", "retry", id])).payload.active).toBeNull();
    const revoked = connectRequest(f.config.remotePort, "wikipedia.org");
    sockets.push(revoked.socket);
    expect(await revoked.status()).toBe(DENY);
    observed = activeEmpty;
    pending = null;
    archived = [{ operationId: id, revision: 1, disposition: "applied" }];
    await until(() => readFileSync(join(f.folder, "live.json"), "utf8").includes('"domains":[]'));
    const done = (await runCli(f.path, ["domains", "retry", id])).payload;
    expect(done).toMatchObject({ state: "applied", active: activeEmpty, pending: null });
    expect(proposed).toBe(1);
    expect(grants).toBe(1);
    expect(f.forwards()).toBe(1);
  } finally {
    for (const socket of sockets) socket.destroy();
    stop?.();
    await run;
    await f.close();
  }
}, 15000);

test.each(["matching", "expiry", "wrong digest", "activating", "interrupted"] as const)(
  "[domains C6] [domains C11] guarded reconnect with %s matcher never grants an edit or claims active routing",
  async (scenario) => {
    const f = await sshFixture(() => {});
    const enrollment = f.enroll();
    if (scenario === "interrupted") writeDomainLocal(enrollment, "journal", {
      version: 1, binding: enrollment.binding, enrollment: ENROLL, epoch: EPOCH,
      active: INITIAL, applying: { revision: 1, domains: ["wikipedia.org", "wipo.int"] },
    });
    const id = `${EPOCH}.0.${"a".repeat(32)}`;
    let reads = 0;
    let grants = 0;
    let reportMatcher = true;
    const pendingRead = Promise.withResolvers<ReturnType<typeof ok>>();
    const admitted = scenario === "matching" || scenario === "expiry";
    const dials: string[] = [];
    const noop = async () => error("unavailable");
    const managed = createManagedRun({ enrollment, pollMs: 10, client: {
      async inspect() {
        reads++;
        if (scenario === "expiry" && reads > 1) return pendingRead.promise;
        return ok({
          epoch: EPOCH, proxyGeneration: GEN, lastRevision: 0, active: null, activeForMs: 0,
          ...(reportMatcher ? { homeMatcher: { revision: 0, forMs: scenario === "expiry" ? 700 : 5000,
            domainsDigest: hashBytes(JSON.stringify(scenario === "wrong digest" ? ["wipo.int"] : INITIAL.domains)) },
          } : {}),
          state: "activation_unknown", history: [],
          pending: { operationId: id, expectedRevision: 0, proxyGeneration: GEN,
            phase: scenario === "activating" ? "activating" : "claimed",
            intent: { kind: "add", proposal: { host: "wipo.int", operationId: id, expectedRevision: 0 } },
            target: { domains: ["wikipedia.org", "wipo.int"], domainsDigest: hashBytes('["wikipedia.org","wipo.int"]'),
              policy: { epoch: EPOCH, revision: 1 } } },
        });
      },
      async begin() { grants++; return noop(); },
      receipt: noop, attest: noop, propose: noop, reconcile: noop,
    }, resolve: async (host) => { dials.push(host); return ["157.240.1.1"]; }, dial: async () => pair()[0] });
    const status = async (host: string) => {
      const [client, stream] = pair();
      managed.handle(stream);
      try {
        const reply = new Promise<string>((resolve) => client.once("data", (b: Buffer) => resolve(b.toString())));
        client.write(`CONNECT ${host}:443 HTTP/1.1\r\n\r\n`);
        return (await reply).split("\r\n")[0];
      } finally { client.destroy(); }
    };
    try {
      managed.onState("connected");
      await until(() => reads >= 2);
      expect(readActiveHome(enrollment, process.pid)).toBeNull();
      expect(await status("wikipedia.org")).toBe(admitted ? "HTTP/1.1 200 Connection Established" : DENY);
      expect(await status("wipo.int")).toBe(DENY);
      expect(grants).toBe(0);
      expect(dials).toEqual(admitted ? ["wikipedia.org"] : []);
      if (scenario === "matching") {
        const before = reads;
        reportMatcher = false;
        await until(() => reads >= before + 2);
        expect(await status("wikipedia.org")).toBe(DENY);
      }
      if (scenario === "expiry") {
        await Bun.sleep(700);
        expect(await status("wikipedia.org")).toBe(DENY);
        pendingRead.resolve(ok(null));
      }
      await managed.stop();
      expect(await status("wikipedia.org")).toBe(DENY);
    } finally {
      pendingRead.resolve(ok(null));
      await managed.stop();
      await f.close();
    }
  },
);

test("[domains C6] [domains C10] interrupted runtime neither replays a grant nor reopens its uncertain removal", async () => {
  const f = await sshFixture(() => {});
  const enrollment = f.enroll();
  writeDomainLocal(enrollment, "journal", { version: 1, binding: enrollment.binding, enrollment: ENROLL, epoch: EPOCH,
    active: INITIAL, applying: { revision: 1, domains: [] } });
  const operationId = "1.0." + "a".repeat(32);
  let issued = 0;
  let receipts = 0;
  let observed = 0;
  const noop = async () => error("unavailable");
  const managed = createManagedRun({ enrollment, pollMs: 10, client: {
    inspect: async () => { observed++; return ok({ epoch: 1, proxyGeneration: GEN, active: INITIAL, activeForMs: 5000, lastRevision: 0,
      state: "pending", pending: { operationId, phase: "activating", operation: "remove", host: "wikipedia.org" }, history: [] }); },
    begin: async () => { issued++; return noop(); }, receipt: async () => { receipts++; return noop(); }, attest: noop, propose: noop,
    reconcile: noop,
  }, resolve: async () => { throw new Error("uncertain route reached DNS"); }, dial: async () => pair()[0] });
  try {
    managed.onState("connected");
    await until(() => observed >= 2);
    const [client, stream] = pair();
    managed.handle(stream);
    const refused = new Promise<string>((resolve) => client.once("data", (b: Buffer) => resolve(b.toString())));
    client.write("CONNECT wikipedia.org:443 HTTP/1.1\r\n\r\n");
    expect(await refused).toContain(DENY);
    expect(issued).toBe(0);
    expect(receipts).toBe(0);
  } finally { await managed.stop(); await f.close(); }
});

test("[domains C6] managed DNS cancels both outstanding DNS queries on abort", async () => {
  const a = Promise.withResolvers<string[]>();
  const aaaa = Promise.withResolvers<string[]>();
  const abort = new AbortController();
  let cancelled = 0;
  const lookup = resolveManagedHost("wikipedia.org", abort.signal, {
    resolve4: () => a.promise, resolve6: () => aaaa.promise,
    cancel() { cancelled++; a.reject(new Error("cancelled A")); aaaa.reject(new Error("cancelled AAAA")); },
  });
  abort.abort(new Error("revoked"));
  await expect(lookup).rejects.toThrow("revoked");
  expect(cancelled).toBe(1);
});

test("[domains C11] [domains C12] active needs both matching bytes and unexpired local evidence", async () => {
  const f = await sshFixture(() => {});
  try {
    const enrollment = f.enroll();
    writeDomainLocal(enrollment, "state", { version: 1, binding: enrollment.binding, enrollment: ENROLL,
      epoch: EPOCH, generation: GEN, pid: process.pid, at: 1000, expiresAt: 2000, active: INITIAL });
    expect(readActiveHome(enrollment, process.pid, 1999)).toEqual(INITIAL);
    expect(readActiveHome(enrollment, process.pid, 2000)).toBeNull();
    let proposed = 0;
    const noop = async () => error("unauthorized");
    const client = {
      inspect: async () => ok({ epoch: EPOCH, proxyGeneration: GEN, active: { revision: 0, domains: ["mozilla.org"] },
        activeForMs: 5000, lastRevision: 0, state: "ready", pending: null, history: [] }),
      propose: async () => { proposed++; return noop(); }, begin: noop, receipt: noop, attest: noop,
      reconcile: noop,
    };
    expect(await domainAction({ kind: "list" }, enrollment, client, () => INITIAL)).toMatchObject({
      ok: true, view: { state: "activation_unknown", active: null },
    });
    expect(await domainAction({ kind: "add", host: "wipo.int", expected: "0" }, enrollment, client, () => INITIAL)).toMatchObject({
      ok: false, error: { code: "not_ready" },
    });
    expect(proposed).toBe(0);
  } finally { await f.close(); }
});

test("[domains C6] an aborted managed dial leaves no unreturned loopback socket", async () => {
  const peers = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    peers.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => peers.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const pending = dialManagedAddress("127.0.0.1", (server.address() as net.AddressInfo).port, controller.signal);
  controller.abort();
  try {
    await expect(pending).rejects.toThrow("managed dial closed");
    await until(() => peers.size === 0);
  } finally {
    for (const peer of peers) peer.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("[domains C10] a killed fixture CLI exposes the durably saved ID and Retry never resubmits", async () => {
  const sent = Promise.withResolvers<ProposalBody>();
  const finish = Promise.withResolvers<void>();
  let proposals = 0;
  const reconciled: string[] = [];
  let retained: ProposalBody | undefined;
  const f = await sshFixture((_role, verb, input, ch) => {
    if (verb === "add") {
      proposals++;
      retained = JSON.parse(input);
      sent.resolve(retained!);
      // The claim is visible to the next connection, but this client gets no stdout.
      void finish.promise.then(() => { ch.exit(2); ch.end(); });
      return;
    }
    if (verb === "reconcile") reconciled.push(JSON.parse(input));
    return reply(ch, ok({ epoch: EPOCH, proxyGeneration: GEN, active: INITIAL, lastRevision: 0, activeForMs: 6500,
      state: retained ? "pending" : "ready", history: [],
      pending: retained && { operation: "add", phase: "claimed", ...retained } || null,
    }));
  });
  const e = f.enroll();
  writeState(f.statePath, { version: 1, pid: process.pid, state: "connected", reason: null, since: new Date().toISOString(),
    retryAt: null, updatedAt: new Date().toISOString(), server: f.config.server, remotePort: f.config.remotePort });
  const at = Date.now();
  writeDomainLocal(e, "state", { version: 1, binding: e.binding, enrollment: ENROLL, epoch: EPOCH, generation: GEN,
    pid: process.pid, at, expiresAt: at + 6500, active: INITIAL });
  const child = Bun.spawn([process.execPath, new URL("../src/cli.ts", import.meta.url).pathname,
    "--config", f.path, "--json", "domains", "add", "WIPO.INT.", "--expected-revision", "0"], { stdout: "pipe", stderr: "pipe" });
  try {
    const proposal = await Promise.race([sent.promise, child.exited.then(() => { throw new Error("fixture child exited before send"); })]);
    expect(domainSubmission(e).saved).toEqual({ kind: "add", proposal });
    child.kill("SIGKILL");
    await child.exited;
    expect(await new Response(child.stdout).text()).toBe("");
    const recovered = (await runCli(f.path, ["domains", "list"])).payload.pending;
    expect(recovered).toMatchObject({ operationId: proposal.operationId, host: "wipo.int" });
    const scope = (await runCli(f.path, ["status", "--tray-scope"])).payload.trayEnrollment;
    expect((await runCli(f.path, ["domains", "list", "--expected-enrollment", scope])).payload.pending.operationId).toBe(proposal.operationId);
    const refused = (await runCli(f.path, ["domains", "add", "mozilla.org", "--expected-revision", "0"])).payload;
    expect(refused.error.code).toBe("conflict");
    const wrong = "1.0." + "e".repeat(32);
    expect((await runCli(f.path, ["domains", "retry", wrong])).payload.error.code).toBe("unknown_operation");
    expect(reconciled).toEqual([]);
    expect((await runCli(f.path, ["domains", "retry", proposal.operationId, "--expected-enrollment", scope])).payload.pending.operationId).toBe(proposal.operationId);
    expect(reconciled).toEqual([proposal.operationId]);
    expect(proposals).toBe(1);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    finish.resolve();
    await child.exited;
    await f.close();
  }
}, 8000);

test("[domains C10] no-effect proof releases the crash-before-send slot and accepted edits return no old proof", async () => {
  let queries = 0;
  let proposals = 0;
  const f = await sshFixture(() => {});
  try {
    const enrollment = f.enroll();
    const id = "1.0." + "c".repeat(32);
    const proposal = { version: 1 as const, operationId: id, expectedRevision: 0, host: "wipo.int" };
    expect(domainSubmission(enrollment, { claim: { kind: "add", proposal } }).claimed).toBe(true);
    const seen = ok({ epoch: EPOCH, proxyGeneration: GEN, active: INITIAL, lastRevision: 0, activeForMs: 6500,
      state: "ready", history: [], pending: null });
    const noop = async () => error("unauthorized");
    const client = {
      inspect: async () => seen,
      reconcile: async (id: string) => { queries++; expect(id).toBe(proposal.operationId); return error("operation_cancelled"); },
      propose: async (_kind: string, sent: ProposalBody) => {
        proposals++;
        expect(domainSubmission(enrollment).saved?.proposal).toEqual(sent);
        return ok({ operationId: sent.operationId, revision: 1, phase: "claimed" });
      },
      begin: noop, receipt: noop, attest: noop,
    };
    expect(await domainAction({ kind: "list" }, enrollment, client, () => INITIAL)).toMatchObject({
      view: { state: "activation_unknown", active: null, pending: { operationId: id, phase: "unconfirmed" } },
    });
    expect(await domainAction({ kind: "retry", id }, enrollment, client, () => INITIAL)).toMatchObject({ error: { code: "operation_cancelled" } });
    expect(domainSubmission(enrollment).saved).toBeNull();
    expect(queries).toBe(1);
    expect(proposals).toBe(0);
    const add = () => domainAction({ kind: "add", host: "mozilla.org", expected: "0" }, enrollment, client, () => INITIAL);
    const results = await Promise.all([add(), add()]);
    expect(results.filter((r) => r.ok)).toMatchObject([{ view: { state: "pending", active: null } }]);
    expect(results.filter((r) => !r.ok)).toMatchObject([{ error: { code: "conflict" } }]);
    expect(proposals).toBe(1);
  } finally { await f.close(); }
});

function fixtureActive(f: Awaited<ReturnType<typeof sshFixture>>, enrollment: ReturnType<Awaited<ReturnType<typeof sshFixture>>["enroll"]>) {
  const at = Date.now();
  writeState(f.statePath, { version: 1, pid: process.pid, state: "connected", reason: null, since: new Date(at).toISOString(),
    retryAt: null, updatedAt: new Date(at).toISOString(), server: f.config.server, remotePort: f.config.remotePort });
  writeDomainLocal(enrollment, "state", { version: 1, binding: enrollment.binding, enrollment: enrollment.enrollment,
    epoch: EPOCH, generation: GEN, pid: process.pid, at, expiresAt: at + 6500, active: INITIAL });
}

function replaceEnrollment(f: Awaited<ReturnType<typeof sshFixture>>) {
  const cfg = `${f.path}.replacement`;
  const metadata = `${f.metadata}.replacement`;
  writeFileSync(cfg, readFileSync(f.path));
  writeFileSync(metadata, JSON.stringify({ ...JSON.parse(readFileSync(f.metadata, "utf8")), enrollment: "replacement" }), { mode: 0o600 });
  renameSync(cfg, f.path);
  renameSync(metadata, f.metadata);
  const replacement = captureDomainSelection(f.path, () => f.dir)?.enrollment;
  if (!replacement) throw new Error("replacement fixture did not load");
  return replacement;
}

const readyAtZero = { epoch: EPOCH, proxyGeneration: GEN, active: INITIAL, lastRevision: 0, activeForMs: 6500,
  state: "ready", pending: null, history: [] };

test("[domains C12] the real sidecar rejects equal-revision file substitution before Add or same-ID Retry", async () => {
  const requests: DomainVerb[] = [];
  const f = await sshFixture((_role, verb, input, ch) => {
    requests.push(verb);
    if (verb === "reconcile") return reply(ch, error("operation_cancelled"));
    if (verb === "add") return reply(ch, ok({ operationId: JSON.parse(input).operationId, revision: 1, phase: "claimed" }));
    return reply(ch, ok(readyAtZero));
  });
  const invoke = async (words: string[]) => {
    const r = await spawnCli(["--json", ...words], { SOCIAL_TUNNEL_CONFIG: f.path }).exit(4500);
    return { code: r.code, payload: fromJson(r.stdout) };
  };
  try {
    const original = f.enroll();
    fixtureActive(f, original);
    const a = (await invoke(["status", "--tray-scope"])).payload;
    expect(a.managedDomains.active.revision).toBe(0);
    expect(a.trayEnrollment).toMatch(/^[a-f0-9]{64}$/);

    // Native approved A. Replace both files at the already-selected path before the CLI loads.
    const replacement = replaceEnrollment(f);
    fixtureActive(f, replacement);
    const b = (await invoke(["status", "--tray-scope"])).payload;
    expect(b.managedDomains.active).toEqual(a.managedDomains.active);
    expect(b.trayEnrollment).not.toBe(a.trayEnrollment);
    const stale = ["--expected-enrollment", a.trayEnrollment];
    const bound = ["--expected-enrollment", b.trayEnrollment];
    const add = ["domains", "add", "wipo.int", "--expected-revision", "0"];
    const conflict = { code: 10, payload: { ok: false, command: "domains", error: { code: "conflict" } } };
    const beforeEdit = readdirSync(f.folder).sort();
    expect(await invoke([...add, ...stale])).toMatchObject(conflict);
    expect(readdirSync(f.folder).sort()).toEqual(beforeEdit);
    expect(f.auth).toEqual([]);

    // A matching ID in B would trigger reconcile without the bound-selection check.
    const id = "1.0." + "b".repeat(32);
    const proposal = { version: 1 as const, operationId: id, expectedRevision: 0, host: "wipo.int" };
    expect(domainSubmission(replacement, { claim: { kind: "add", proposal } }).claimed).toBe(true);
    const journal = replacement.submissionPath;
    const beforeRetry = readFileSync(journal);
    expect(await invoke(["domains", "retry", id, ...stale])).toMatchObject(conflict);
    expect(readFileSync(journal)).toEqual(beforeRetry);
    expect(f.auth).toEqual([]);
    expect(requests).toEqual([]);

    expect((await invoke(["domains", "list", ...bound])).payload.pending.operationId).toBe(id);
    expect((await invoke(["domains", "retry", id, ...bound])).payload.error.code).toBe("operation_cancelled");
    expect((await invoke([...add, ...bound])).payload.state).toBe("pending");
    expect(requests).toEqual(["inspect", "reconcile", "inspect", "add"]);
  } finally { await f.close(); }
}, 10000);

for (const scoped of [true, false]) test(`[domains C12] replacement during SSH preflight cannot reserve or send a ${scoped ? "tray" : "standalone"} edit`, async () => {
  const requests: DomainVerb[] = [];
  const f = await sshFixture((_role, verb, _input, ch) => {
    requests.push(verb);
    if (verb === "inspect") replaceEnrollment(f);
    reply(ch, ok(readyAtZero));
  });
  try {
    fixtureActive(f, f.enroll());
    const scope = (await runCli(f.path, ["status", "--tray-scope"])).payload.trayEnrollment;
    const before = readdirSync(f.folder).sort();
    const guard = scoped ? ["--expected-enrollment", scope] : [];
    const result = await runCli(f.path, ["domains", "remove", "wikipedia.org", "--expected-revision", "0", ...guard]);
    expect(result).toMatchObject({ code: 10, payload: { error: { code: "conflict" } } });
    expect(requests).toEqual(["inspect"]);
    expect(readdirSync(f.folder).sort()).toEqual(before);
  } finally { await f.close(); }
});

test("[domains C12] replacement during Retry authentication cannot send reconciliation", async () => {
  const requests: DomainVerb[] = [];
  const f = await sshFixture((_role, verb, _input, ch) => {
    requests.push(verb);
    reply(ch, error("operation_cancelled"));
  }, () => { replaceEnrollment(f); });
  try {
    const enrollment = f.enroll();
    const id = "1.0." + "d".repeat(32);
    const proposal = { version: 1 as const, operationId: id, expectedRevision: 0, host: "wipo.int" };
    expect(domainSubmission(enrollment, { claim: { kind: "add", proposal } }).claimed).toBe(true);
    const journal = enrollment.submissionPath;
    const before = readFileSync(journal);
    const scope = (await runCli(f.path, ["status", "--tray-scope"])).payload.trayEnrollment;
    const result = await runCli(f.path, ["domains", "retry", id, "--expected-enrollment", scope]);
    expect(result).toMatchObject({ code: 10, payload: { error: { code: "conflict" } } });
    expect(f.auth).toContain("editor");
    expect(requests).toEqual([]);
    expect(readFileSync(journal)).toEqual(before);
  } finally { await f.close(); }
});

for (const change of ["claim", "clear"] as const) for (const swap of ["directory", "generation", "config"] as const) {
  test(`[domains C12] final ${change} check cannot write ${swap} replacement storage`, async () => {
    const f = await sshFixture(() => {});
    try {
      const original = f.enroll();
      const captured = captureDomainSelection(f.path, () => f.dir)!;
      expect(captured.enrollment?.submissionPath).toBe(original.submissionPath);
      const id = "1.0." + "f".repeat(32);
      const saved = { kind: "add" as const, proposal: { version: 1 as const, operationId: id, expectedRevision: 0, host: "wipo.int" } };
      if (change === "clear") expect(domainSubmission(original, { claim: saved }).claimed).toBe(true);
      let replacement: typeof original | undefined;
      const readReplacementFiles = () => readdirSync(f.folder).sort().map((name) => [name, hashBytes(readFileSync(join(f.folder, name)).toString("base64"))]);
      let replacementFiles: ReturnType<typeof readReplacementFiles> = [];
      let replacementJournal = "";
      let boundary = 0;
      let proposals = 0;
      const reconciles: string[] = [];
      const noop = async () => error("unauthorized");
      const result = await domainAction(change === "claim"
        ? { kind: "add", host: "wipo.int", expected: "0" } : { kind: "retry", id }, captured.enrollment, {
        inspect: async () => ok(readyAtZero),
        reconcile: async (operationId) => { reconciles.push(operationId); boundary = 2; return error("operation_cancelled"); },
        propose: async () => { proposals++; return noop(); }, begin: noop, receipt: noop, attest: noop,
      }, () => { boundary = 1; return INITIAL; }, () => {
        const fresh = captured.current();
        if (boundary > 0 && --boundary === 0 && fresh) {
          const dir = lstatSync(f.folder);
          if (swap === "directory") {
            renameSync(f.folder, `${f.folder}.old`);
            mkdirSync(f.folder, { mode: 0o700 });
            writeFileSync(join(f.folder, "replacement-only"), "untouched");
            expect(lstatSync(f.folder).ino).not.toBe(dir.ino);
          } else if (swap === "config") {
            const before = lstatSync(f.path);
            const bytes = readFileSync(f.path);
            const next = `${f.path}.next`;
            const metadata = lstatSync(f.metadata);
            writeFileSync(next, bytes);
            renameSync(next, f.path);
            expect(lstatSync(f.path).ino).not.toBe(before.ino);
            expect(readFileSync(f.path)).toEqual(bytes);
            expect(lstatSync(f.folder).ino).toBe(dir.ino);
            expect(lstatSync(f.metadata).ino).toBe(metadata.ino);
          } else {
            const metadata = JSON.parse(readFileSync(f.metadata, "utf8"));
            writeFileSync(f.metadata, JSON.stringify({ ...metadata, proxyGeneration: "same-directory-replacement" }));
            expect(lstatSync(f.folder).ino).toBe(dir.ino);
          }
          replacement = captureDomainSelection(f.path, () => f.dir)?.enrollment;
          if (!replacement) throw new Error("replacement fixture did not load");
          if (change === "clear") {
            if (!domainSubmission(replacement).saved) expect(domainSubmission(replacement, { claim: saved }).claimed).toBe(true);
            replacementJournal = readFileSync(replacement.submissionPath).toString("base64");
          }
          replacementFiles = readReplacementFiles();
        }
        return fresh; // Replacement happens after the last successful freshness measurement.
      });
      expect(result).toMatchObject({ ok: false, error: { code: "conflict" } });
      expect(proposals).toBe(0);
      expect(reconciles).toEqual(change === "clear" ? [id] : []);
      expect(f.auth).toEqual([]);
      expect(replacement).toBeDefined();
      expect(readReplacementFiles()).toEqual(replacementFiles);
      if (change === "clear") {
        expect(readFileSync(replacement!.submissionPath).toString("base64")).toBe(replacementJournal);
        expect(domainSubmission(replacement!, { clear: saved }).saved).toBeNull();
      } else expect(lstatSync(replacement!.submissionPath, { throwIfNoEntry: false })).toBeUndefined();
      expect(domainSubmission(replacement!, { claim: saved }).claimed).toBe(true);
      expect(domainSubmission(replacement!).saved).toEqual(saved);
    } finally { await f.close(); }
  });
}

test("[domains C2] only explicit unsupported returns setup required for a recognized enrollment", async () => {
  let code = 1;
  let errorCode: WireError | undefined;
  const f = await sshFixture((_role, _verb, _input, ch) => {
    if (errorCode) reply(ch, error(errorCode));
    else { ch.exit(code); ch.end(); }
  });
  try {
    expect((await runCli(f.path, ["domains", "list"])).payload.state).toBe("setup_required");
    f.enroll();
    for (code of [1, DOMAIN_COMMAND_UNAVAILABLE]) {
      expect((await runCli(f.path, ["domains", "list"])).payload.state).toBe("activation_unknown");
    }
    errorCode = "fenced";
    expect((await runCli(f.path, ["domains", "list"])).payload.state).toBe("recovery_required");
    errorCode = "unsupported";
    expect((await runCli(f.path, ["domains", "list"])).payload.state).toBe("setup_required");
  } finally { await f.close(); }
});

test("[domains C9] a full role reply drains stdout after the Unix socket closes", async () => {
  const path = join(tmp(), "role.sock");
  const text = '{"ok":true,"value":"';
  const reply = text + "x".repeat(DOMAIN_RESPONSE_LIMIT - text.length - 3) + '"}\n';
  const closed = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const drained = Promise.withResolvers<void>();
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.once("close", () => closed.resolve());
    socket.once("end", () => socket.end(reply));
    socket.resume();
    socket.write("+");
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  try {
    let bytes = 0;
    const result = forwardDomainCommand(path, DOMAIN_COMMANDS.inspect, (async function* () {})(), async (data) => {
      bytes = data.length;
      started.resolve();
      await drained.promise;
    });
    await Promise.all([closed.promise, started.promise]);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    drained.resolve();
    expect(await result).toBe(0);
    expect(bytes).toBe(DOMAIN_RESPONSE_LIMIT);
  } finally {
    drained.resolve();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
