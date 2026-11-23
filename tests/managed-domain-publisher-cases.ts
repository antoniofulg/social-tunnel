import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runInNewContext } from "node:vm";
import { openDomainAuthority } from "../server/domain-authority";
import { dispatchLocalDisable } from "../server/domain-linux-supervisor";
import {
  DOMAIN_POLICY_FILE, fileDomainPolicySink, hashBytes, renderDomainPolicy, type DomainPolicySink,
} from "../src/domain-policy";
import {
  idleWindowDigest, openDomainPublisher, provisionDomainPublisher,
  type IdleReservationScope, type PublisherOperation, type PublisherOptions, type PublisherPrincipal, type PublisherResult, type ProxyPublicationReceipt,
} from "../src/domain-publisher";
import { tmp } from "./helpers";

const INIT = 7;
const EPOCH = 2;
const ENROLLMENT = "test-enrollment";
const PORT = 8788;
const PROXY = `PROXY 127.0.0.1:${PORT}`;
const nonce = "a".repeat(32);
const toBytes = new TextEncoder();
const opened = new Set<{ close(): void }>();
afterEach(() => {
  for (const publisher of opened) publisher.close();
  opened.clear();
});

const id = (n = 1, epoch = EPOCH, expected = INIT) => `${epoch}.${expected}.${n.toString(16).padStart(32, "0")}`;
const body = (host: string, operationId = id(), expectedRevision = INIT) => ({ version: 1, operationId, expectedRevision, host });
const wire = (host: string, operationId = id(), expectedRevision = INIT) => toBytes.encode(JSON.stringify(body(host, operationId, expectedRevision)));
const err = (code: Extract<PublisherResult<never>, { ok: false }>["code"]) => ({ ok: false, code } as const);
function value<T>(result: PublisherResult<T>): T {
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

function fixture(
  domains = ["amazonaws.com", "mozilla.org", "wikipedia.org"],
  currentIdleReservation?: PublisherOptions<object>["currentIdleReservation"],
) {
  const root = tmp();
  const journalDir = join(root, "journal");
  const policyDir = join(root, "managed");
  mkdirSync(journalDir, { mode: 0o700 });
  mkdirSync(policyDir, { mode: 0o755 });
  const policyPath = join(policyDir, DOMAIN_POLICY_FILE);
  const initial = renderDomainPolicy(PORT, { epoch: EPOCH, revision: INIT, routes: [...domains].sort() });
  writeFileSync(policyPath, initial, { mode: 0o644 });
  const identities = new WeakMap<object, PublisherPrincipal>();
  const session = (principal: Omit<Extract<PublisherPrincipal, { role: "proxy" }>, "enrollment"> |
    Omit<Extract<PublisherPrincipal, { role: "editor" }>, "enrollment"> |
    Omit<Extract<PublisherPrincipal, { role: "observer" }>, "enrollment"> | { role: "local_admin" }, enrollment = ENROLLMENT) => {
    const ticket = Object.freeze({});
    identities.set(ticket, { ...principal, enrollment });
    return ticket;
  };
  const editor = session({ role: "editor", epoch: EPOCH });
  const proxy = session({ role: "proxy", epoch: EPOCH, generation: "proxy-1" });
  const admin = session({ role: "local_admin" });
  const sink = fileDomainPolicySink(policyDir, journalDir);
  const options = { enrollment: ENROLLMENT, journalDir, proxyPort: PORT, policy: sink,
    identify: (ticket: object) => identities.get(ticket) ?? null, currentIdleReservation };
  provisionDomainPublisher(options, { epoch: EPOCH, revision: INIT, domains, proxyGeneration: "proxy-1" });
  const open = (policy: DomainPolicySink = sink, identify = options.identify) => {
    const p = openDomainPublisher({ ...options, policy, identify });
    opened.add(p);
    return { ...p, close: () => { opened.delete(p); p.close(); } };
  };
  return {
    root, journalDir, policyDir, policyPath, initial, sink, session, editor, proxy, admin, open, options,
    bytes: () => readFileSync(join(journalDir, "domains.sqlite")),
  };
}

function openLocalAuthority(f: ReturnType<typeof fixture>, policy = f.sink) {
  const browsers = [{ generation: "isolated", input: new PassThrough(), output: new PassThrough(), ownership: () => null }];
  const authority = openDomainAuthority({
    enrollment: ENROLLMENT, journalDir: f.journalDir, proxyPort: PORT, policy,
    forward: { epoch: EPOCH, generation: "proxy-1" },
    browserRoster: () => ({ version: 0, browsers }), forwardOwnership: () => null,
  });
  authority.open();
  return authority;
}

function receipt(operation: PublisherOperation): ProxyPublicationReceipt {
  return {
    enrollment: ENROLLMENT, epoch: operation.target.policy.epoch, operationId: operation.operationId,
    revision: operation.target.policy.revision, domainsDigest: operation.target.domainsDigest, proxyGeneration: operation.proxyGeneration,
  };
}

function pac(bytes: string) {
  const { ProxySettings } = JSON.parse(bytes);
  expect(ProxySettings).toEqual({
    ProxyMode: "pac_script", ProxyPacMandatory: true,
    ProxyPacUrl: expect.stringMatching(/^data:application\/x-ns-proxy-autoconfig;base64,/),
  });
  const source = Buffer.from(ProxySettings.ProxyPacUrl.split(",")[1], "base64").toString();
  const find = runInNewContext(`${source}\nFindProxyForURL`) as (url: string, host: string) => string;
  return (host: string) => find(`https://${host}/`, host);
}

test("[domains C9] a guarded publisher grants, publishes and finalizes only under the same durable idle reservation", () => {
  let held: { scope: IdleReservationScope; id: string } | undefined;
  let remainingChecks = Infinity;
  const f = fixture(["wikipedia.org"], scope => {
    if (--remainingChecks < 0 || !held) return null;
    const expected = held.scope;
    return scope.enrollment === expected.enrollment && scope.epoch === expected.epoch &&
      scope.operationId === expected.operationId && scope.revision === expected.revision &&
      scope.domainsDigest === expected.domainsDigest && scope.policyPreimageDigest === expected.policyPreimageDigest
      ? held.id : null;
  });
  let p = f.open();
  const edit = value(p.propose(f.editor, "add", wire("wipo.int")));
  expect(() => openDomainPublisher({ ...f.options, currentIdleReservation: undefined }))
    .toThrow("wrong journal binding");
  const beforeGrant = f.bytes();
  expect(p.beginActivation(f.proxy, edit.operationId)).toEqual(err("not_ready"));
  expect(f.bytes()).toEqual(beforeGrant);
  const scope = {
    enrollment: ENROLLMENT, epoch: EPOCH, operationId: edit.operationId, revision: INIT + 1,
    domainsDigest: edit.target.domainsDigest, policyPreimageDigest: hashBytes(f.initial),
  };
  const binding = { id: "exact-lease", operationDigest: idleWindowDigest(scope) };
  expect(p.inspectIdleCandidate(f.editor)).toEqual(err("unauthorized"));
  expect(p.inspectIdleCandidate(f.admin)).toEqual({ ok: true, value: { scope, recoveryOf: null, operationDigest: binding.operationDigest } });
  expect(f.bytes()).toEqual(beforeGrant);
  writeFileSync(f.policyPath, f.initial.trimEnd());
  expect(p.inspectIdleCandidate(f.admin)).toEqual(err("not_ready"));
  writeFileSync(f.policyPath, f.initial);
  expect(p.inspectCompletedIdleWindow(f.admin, binding)).toEqual(err("not_ready"));
  held = { id: "wrong-operation-lease", scope: { ...scope, operationId: id(9) } };
  expect(p.beginActivation(f.proxy, edit.operationId)).toEqual(err("not_ready"));
  held = { id: "old-pac-lease", scope: { ...scope, policyPreimageDigest: "0".repeat(64) } };
  expect(p.beginActivation(f.proxy, edit.operationId)).toEqual(err("not_ready"));
  held = { scope, id: "exact-lease" };
  value(p.beginActivation(f.proxy, edit.operationId));
  expect(p.inspectIdleCandidate(f.admin)).toEqual(err("not_ready"));
  p.close();
  p = f.open();
  held = { scope, id: "replacement-lease" };
  expect(p.publish(f.proxy, receipt(edit))).toEqual(err("not_ready"));
  expect(f.sink.read()).toBe(f.initial);
  held = { scope, id: "exact-lease" };
  remainingChecks = 1;
  expect(p.publish(f.proxy, receipt(edit))).toEqual(err("not_ready"));
  expect(f.sink.read()).toBe(f.initial);
  remainingChecks = Infinity;
  value(p.publish(f.proxy, receipt(edit)));
  const observed = {
    ...receipt(edit), browserGeneration: "verified-chrome", policyDigest: hashBytes(f.sink.read()),
    positive: `${"a".repeat(32)}.e${EPOCH}.r${INIT + 1}.pac.invalid`,
    negative: `${"b".repeat(32)}.e${EPOCH - 1}.r${INIT + 1}.pac.invalid`,
  };
  const observer = f.session({ role: "observer", epoch: EPOCH, generation: observed.browserGeneration });
  held = undefined;
  expect(p.inspectCompletedIdleWindow(f.admin, binding)).toEqual(err("not_ready"));
  expect(p.finalize(observer, observed)).toEqual(err("not_ready"));
  expect(value(p.inspect(f.admin)).lastProven.policy.revision).toBe(INIT);
  held = { scope, id: "exact-lease" };
  expect(value(p.finalize(observer, observed)).domains).toEqual(["wikipedia.org", "wipo.int"]);
  const applied = f.sink.read();
  p.close();
  p = f.open();
  expect(p.inspectCompletedIdleWindow(f.editor, binding)).toEqual(err("unauthorized"));
  expect(p.inspectCompletedIdleWindow(f.admin, { ...binding, id: "different-lease" })).toEqual(err("not_ready"));
  expect(p.inspectCompletedIdleWindow(f.admin, { ...binding, operationDigest: hashBytes(applied) })).toEqual(err("not_ready"));
  expect(p.inspectCompletedIdleWindow(f.admin, binding)).toEqual({ ok: true, value: null });
  writeFileSync(f.policyPath, f.initial);
  expect(p.inspectCompletedIdleWindow(f.admin, binding)).toEqual(err("not_ready"));
  writeFileSync(f.policyPath, applied);
  const next = value(p.propose(f.editor, "remove", wire("wipo.int", id(2, EPOCH, INIT + 1), INIT + 1)));
  held = { id: binding.id, scope: { ...scope, operationId: next.operationId, revision: INIT + 2,
    domainsDigest: next.target.domainsDigest, policyPreimageDigest: hashBytes(applied) } };
  expect(p.beginActivation(f.proxy, next.operationId)).toEqual(err("not_ready"));
  held = { ...held, id: "next-lease" };
  value(p.beginActivation(f.proxy, next.operationId));
  expect(p.inspectCompletedIdleWindow(f.admin, binding)).toEqual(err("not_ready"));
});

for (const version of [2, 3]) {
  test(`[domains C10] the guarded journal rejects unpublished format ${version} without writing`, () => {
    const f = fixture(["wikipedia.org"], () => "held");
    const db = new Database(join(f.journalDir, "domains.sqlite"));
    try {
      const old = JSON.parse(db.query<{ body: string }, []>("SELECT body FROM control WHERE id = 1").get()!.body);
      const body = JSON.stringify({ ...old, version });
      db.query("UPDATE control SET body = ?, digest = ? WHERE id = 1").run(body, hashBytes(body));
    } finally { db.close(); }
    const before = f.bytes();
    expect(() => f.open()).toThrow("wrong journal binding");
    expect(f.bytes()).toEqual(before);
    expect(f.sink.read()).toBe(f.initial);
  });
}

test("[domains C4] publisher rejects noncanonical or stale proposals and admits one durable winning projection", async () => {
  const f = fixture();
  const a = f.open();
  const b = f.open();
  const before = f.bytes();
  for (const [bytes, code] of [
    [new Uint8Array(4097), "limit"], [new Uint8Array([0xff]), "invalid_request"],
    [toBytes.encode(JSON.stringify({ ...body("wipo.int"), proxy: "127.0.0.1:9999" })), "invalid_request"],
    [toBytes.encode(JSON.stringify({ ...body("wipo.int"), role: "local_admin" })), "invalid_request"],
    [toBytes.encode(JSON.stringify(body("wipo.int")).slice(0, -1) + ',"host":"who.int"}'), "invalid_request"],
    [wire('wipo.int\");return "DIRECT";//'), "invalid_domain"], [wire("github.io"), "invalid_domain"],
    [wire("host.unlisted-suffix"), "invalid_domain"], [wire(`${nonce}.e2.r7.pac.invalid`), "invalid_domain"],
    [wire("wipo.int", id(1, EPOCH, INIT - 1), INIT - 1), "conflict"], [wire("MOZILLA.org."), "duplicate_domain"],
  ] as const) expect(a.propose(f.editor, "add", bytes)).toEqual(err(code));
  expect(a.propose(f.editor, "remove", wire("wipo.int"))).toEqual(err("domain_not_found"));
  expect(a.propose(f.proxy, "add", wire("wipo.int"))).toEqual(err("unauthorized"));
  expect(f.bytes()).toEqual(before);
  expect(f.sink.read()).toBe(f.initial);

  const exact = Buffer.alloc(4096, " ");
  exact.set(wire("WIPO.INT."));
  const [winner, loser] = await Promise.all([
    Promise.resolve().then(() => a.propose(f.editor, "add", exact)),
    Promise.resolve().then(() => b.propose(f.editor, "add", wire("who.int", id(2)))),
  ]);
  const claimed = value(winner);
  expect(loser).toEqual(err("conflict"));
  expect(value(b.propose(f.editor, "add", wire("wipo.int")))).toEqual(claimed);
  expect(b.propose(f.editor, "add", wire("who.int"))).toEqual(err("conflict"));
  expect(claimed.target.domains).toEqual(["amazonaws.com", "mozilla.org", "wikipedia.org", "wipo.int"]);
  expect(f.sink.read()).toBe(f.initial);
});

test("[domains C9] bounds the whole list and authenticated rejected proposals without journal writes", () => {
  const f = fixture(Array.from({ length: 128 }, (_, i) => `site${i}.wikipedia.org`));
  const p = f.open();
  const before = f.bytes();
  expect(p.propose(f.editor, "add", wire("wipo.int"))).toEqual(err("limit"));
  for (let i = 0; i < 63; i++) expect(p.propose(f.editor, "add", new Uint8Array())).toEqual(err("invalid_request"));
  expect(p.propose(f.editor, "remove", wire("site1.wikipedia.org"))).toEqual(err("limit"));
  expect(f.bytes()).toEqual(before);
  expect(f.sink.read()).toBe(f.initial);
});

test("[domains C7] publishing waits for the exact independent proxy receipt and does not claim browser activation", () => {
  const f = fixture();
  const p = f.open();
  const op = value(p.propose(f.editor, "remove", wire("wikipedia.org")));
  const ack = receipt(op);
  expect(p.publish(f.proxy, ack)).toEqual(err("receipt_mismatch"));
  expect(p.beginActivation(f.editor, op.operationId)).toEqual(err("unauthorized"));
  expect(value(p.beginActivation(f.proxy, op.operationId)).phase).toBe("activating");
  expect(p.beginActivation(f.proxy, op.operationId)).toEqual(err("conflict"));
  const fakeSession = { role: "proxy", generation: "proxy-1", enrollment: ENROLLMENT, epoch: EPOCH };
  expect(p.publish(fakeSession, ack)).toEqual(err("unauthorized"));
  expect(p.publish(f.editor, { ...ack, verified: true })).toEqual(err("unauthorized"));
  const stale = f.session({ role: "proxy", epoch: EPOCH, generation: "proxy-old" });
  const other = f.session({ role: "proxy", epoch: EPOCH, generation: "proxy-1" }, "other");
  expect(p.publish(stale, ack)).toEqual(err("fenced"));
  expect(p.publish(other, ack)).toEqual(err("unauthorized"));
  const before = f.bytes();
  for (const wrong of [null, { ...ack, enrollment: "other" }, { ...ack, epoch: EPOCH - 1 }, { ...ack, operationId: id(2) },
    { ...ack, proxyGeneration: "proxy-old" }, { ...ack, domainsDigest: "0".repeat(64) }, { ...ack, revision: INIT }]) {
    expect(p.publish(f.proxy, wrong)).toEqual(err("receipt_mismatch"));
  }
  expect(f.bytes()).toEqual(before);
  expect(f.sink.read()).toBe(f.initial);
  const oldRoute = pac(f.initial);
  expect(oldRoute("www.wikipedia.org")).toBe(PROXY);
  expect(oldRoute(`${nonce}.e${EPOCH}.r${INIT}.pac.invalid`)).toBe(PROXY);

  expect(value(p.publish(f.proxy, ack)).phase).toBe("published");
  const updated = f.sink.read();
  expect(updated).not.toBe(f.initial);
  const route = pac(updated);
  expect(route("www.wikipedia.org")).toBe("DIRECT");
  expect(route("WWW.MOZILLA.ORG.")).toBe(PROXY);
  expect(route("tenant.s3.amazonaws.com")).toBe(PROXY);
  expect(route("notamazonaws.com")).toBe("DIRECT");
  expect(route(`${nonce}.e${EPOCH}.r${INIT + 1}.pac.invalid`)).toBe(PROXY);
  expect(route(`${nonce}.e${EPOCH}.r${INIT}.pac.invalid`)).toBe("DIRECT");
  expect(route(`${nonce}.e${EPOCH + 1}.r${INIT + 1}.pac.invalid`)).toBe("DIRECT");
  expect(value(p.inspect(f.admin))).toMatchObject({ lastProven: { policy: { revision: INIT } }, pending: { phase: "published" } });
  const inode = statSync(f.policyPath).ino;
  expect(value(p.publish(f.proxy, ack)).phase).toBe("published");
  expect(statSync(f.policyPath).ino).toBe(inode);
});

test("[domains C9] authorization is checked again after arming; disabling fences a verified old session before effects", () => {
  const f = fixture();
  let allow = Number.POSITIVE_INFINITY;
  const p = f.open(f.sink, (ticket) => ticket === f.proxy && --allow < 0 ? null : f.options.identify(ticket));
  const op = value(p.propose(f.editor, "remove", wire("wikipedia.org")));
  value(p.beginActivation(f.proxy, op.operationId));
  allow = 1;
  expect(p.publish(f.proxy, receipt(op))).toEqual(err("unauthorized"));
  expect(value(p.inspect(f.admin)).pending?.phase).toBe("publishing");
  expect(f.sink.read()).toBe(f.initial);
  expect(value(p.inspectPolicy(f.admin))).toBe("recorded");
  allow = Number.POSITIVE_INFINITY;
  expect(value(p.disable(f.admin, EPOCH))).toBe(EPOCH + 1);
  expect(value(p.inspectPolicy(f.admin))).toBe("recorded");
  expect(p.publish(f.proxy, receipt(op))).toEqual(err("fenced"));
  expect(p.beginActivation(f.proxy, op.operationId)).toEqual(err("fenced"));
  expect(p.propose(f.editor, "remove", wire("wikipedia.org"))).toEqual(err("fenced"));
  const freshEditor = f.session({ role: "editor", epoch: EPOCH + 1 });
  expect(p.propose(freshEditor, "remove", wire("wikipedia.org", id(1, EPOCH + 1)))).toEqual(err("recovery_required"));
  expect(f.sink.read()).toBe(f.initial);
});

test("[domains C10] a lost publication response reconciles exact bytes on restart without repeating either side", () => {
  const f = fixture();
  const p = f.open({ ...f.sink, replace(expected, next) { f.sink.replace(expected, next); throw new Error("lost after rename"); } });
  const op = value(p.propose(f.editor, "remove", wire("wikipedia.org")));
  value(p.beginActivation(f.proxy, op.operationId));
  expect(p.publish(f.proxy, receipt(op))).toEqual(err("unavailable"));
  const inode = statSync(f.policyPath).ino;
  expect(pac(f.sink.read())("wikipedia.org")).toBe("DIRECT");
  expect(value(p.inspectPolicy(f.admin))).toBe("publishing");
  p.close();

  const resumed = f.open();
  expect(value(resumed.inspect(f.admin))).toMatchObject({
    lastProven: { policy: { revision: INIT } }, recordedPolicy: { revision: INIT }, pending: { phase: "publishing", operationId: id() },
  });
  expect(resumed.beginActivation(f.proxy, op.operationId)).toEqual(err("conflict"));
  expect(resumed.publish(f.proxy, { ...receipt(op), revision: INIT })).toEqual(err("receipt_mismatch"));
  expect(value(resumed.publish(f.proxy, receipt(op))).phase).toBe("published");
  expect(statSync(f.policyPath).ino).toBe(inode);
  expect(value(resumed.inspect(f.admin)).lastProven.policy.revision).toBe(INIT);

  // Replacing the target with unrelated or rolled-back bytes is not an implicit rollback/apply.
  writeFileSync(f.policyPath, f.initial);
  expect(resumed.publish(f.proxy, receipt(op))).toEqual(err("unavailable"));
  expect(resumed.inspectPolicy(f.admin)).toEqual(err("not_ready"));
  expect(f.sink.read()).toBe(f.initial);
});

test("[domains C10] a claimed no-effect edit cancels without a policy write and cannot be replayed", () => {
  const f = fixture();
  const p = f.open();
  const op = value(p.propose(f.editor, "remove", wire("wikipedia.org")));
  expect(p.disable(f.editor, EPOCH)).toEqual(err("unauthorized"));
  value(p.disable(f.admin, EPOCH));
  p.close();
  const resumed = f.open();
  expect(value(resumed.inspect(f.admin))).toMatchObject({
    history: [{ operationId: op.operationId, revision: INIT + 1, disposition: "cancelled" }], recovery: null, pending: null,
  });
  expect(resumed.beginActivation(f.proxy, op.operationId)).toEqual(err("fenced"));
  expect(resumed.propose(f.editor, "remove", wire("wikipedia.org"))).toEqual(err("fenced"));
  expect(f.sink.read()).toBe(f.initial);
});

test.each(["uninspectable", "mismatched"] as const)("[domains C10] local Disable fences the epoch with a %s PAC", async (fault) => {
  const f = fixture();
  if (fault === "mismatched") writeFileSync(f.policyPath, f.initial.trimEnd());
  const before = readFileSync(f.policyPath);
  let reads = 0;
  let writes = 0;
  const a = openLocalAuthority(f, {
    read() {
      reads++;
      if (fault === "uninspectable") throw new Error("mandatory policy ownership changed");
      return f.sink.read();
    },
    replace(expected, next) { writes++; f.sink.replace(expected, next); },
  });
  try {
    expect(a.inspectPolicyLocal()).toEqual(err(fault === "uninspectable" ? "unavailable" : "not_ready"));
    expect(await dispatchLocalDisable({ op: "disable", epoch: EPOCH }, a)).toEqual({ ok: true, value: EPOCH + 1 });
    expect({ reads, writes }).toEqual({ reads: 1, writes: 0 });
    expect(readFileSync(f.policyPath)).toEqual(before);
  } finally { await a.close(); }

  const reopened = f.open();
  expect(value(reopened.inspect(f.admin))).toMatchObject({ epoch: EPOCH + 1, editingEnabled: false });
  expect(reopened.inspect(f.editor)).toEqual(err("fenced"));
  expect(reopened.inspect(f.proxy)).toEqual(err("fenced"));
});

test("[domains C10] local Disable rejects a stale epoch and a replacement journal", async () => {
  const f = fixture();
  const other = fixture(["wipo.int"]);
  const a = openLocalAuthority(f);
  try {
    const before = f.bytes();
    const publisher = f.open();
    expect(publisher.disable(f.session({ role: "local_admin" }, "different-enrollment"), EPOCH)).toEqual(err("unauthorized"));
    publisher.close();
    expect(await dispatchLocalDisable({ op: "disable", epoch: EPOCH - 1 }, a)).toEqual(err("conflict"));
    expect(f.bytes()).toEqual(before);

    const replacement = other.bytes();
    const journal = join(f.journalDir, "domains.sqlite");
    renameSync(journal, join(f.journalDir, "original.sqlite"));
    renameSync(join(other.journalDir, "domains.sqlite"), journal);
    expect(await dispatchLocalDisable({ op: "disable", epoch: EPOCH }, a)).toEqual(err("unavailable"));
    expect(f.bytes()).toEqual(replacement);
    expect(readFileSync(join(f.journalDir, "original.sqlite"))).toEqual(before);
    expect(f.sink.read()).toBe(f.initial);
  } finally { await a.close(); }
});

test("[domains C10] no-effect reconciliation fences queued proposals without evicting live tombstones", () => {
  const f = fixture();
  const p = f.open();
  expect(p.reconcile(f.proxy, id())).toEqual(err("unauthorized"));
  expect(p.reconcile(f.editor, id(1, EPOCH + 1))).toEqual(err("invalid_request"));
  expect(p.reconcile(f.editor, id(1, EPOCH, INIT + 1))).toEqual(err("invalid_request"));
  const untouched = f.bytes();
  expect(value(p.inspect(f.editor)).pending).toBeNull();
  expect(f.bytes()).toEqual(untouched);
  for (let n = 1; n <= 128; n++) expect(p.reconcile(f.editor, id(n))).toEqual(err("operation_cancelled"));
  expect(p.reconcile(f.editor, id(129))).toEqual(err("limit"));
  p.close();
  const resumed = f.open();
  expect(resumed.propose(f.editor, "add", wire("wipo.int", id()))).toEqual(err("operation_cancelled"));
  const won = value(resumed.propose(f.editor, "add", wire("wipo.int", id(129))));
  expect(resumed.reconcile(f.editor, won.operationId)).toEqual({ ok: true, value: null });
  expect(value(resumed.inspect(f.editor)).pending).toEqual(won);
  expect(f.sink.read()).toBe(f.initial);
  value(resumed.beginActivation(f.proxy, won.operationId));
  value(resumed.publish(f.proxy, receipt(won)));
  const observer = f.session({ role: "observer", epoch: EPOCH, generation: "chrome" });
  const revision = won.target.policy.revision;
  value(resumed.finalize(observer, { ...receipt(won), browserGeneration: "chrome",
    policyDigest: hashBytes(f.sink.read()), positive: `${"a".repeat(32)}.e${EPOCH}.r${revision}.pac.invalid`,
    negative: `${"b".repeat(32)}.e${EPOCH - 1}.r${revision}.pac.invalid`,
  }));
  expect(resumed.reconcile(f.editor, id())).toEqual(err("superseded"));
  expect(resumed.propose(f.editor, "add", wire("who.int", id()))).toEqual(err("conflict"));
  expect(resumed.reconcile(f.editor, id(1, EPOCH, revision))).toEqual(err("operation_cancelled"));
});

test("[domains C10] only fresh protected publication proof can re-enable a no-effect fenced enrollment", () => {
  const f = fixture(["wikipedia.org"]);
  const p = f.open();
  const prior = value(p.propose(f.editor, "remove", wire("wikipedia.org")));
  const epoch = value(p.disable(f.admin, EPOCH));
  const editor = f.session({ role: "editor", epoch });
  const proxy = f.session({ role: "proxy", epoch, generation: "proxy-2" });
  const observer = f.session({ role: "observer", epoch, generation: "chrome-2" });
  const stale = f.session({ role: "observer", epoch: EPOCH, generation: "chrome-2" });
  const op = value(p.authorizeRecovery(f.admin, {
    epoch, operationId: id(1, epoch), proxyGeneration: "proxy-2", domains: ["wikipedia.org"], releaseDirect: [],
  }));
  expect(p.propose(editor, "add", wire("wipo.int", id(2, epoch)))).toEqual(err("not_ready"));
  value(p.beginActivation(proxy, op.operationId));
  value(p.publish(proxy, receipt(op)));
  const revision = op.target.policy.revision;
  const proof = {
    ...receipt(op), browserGeneration: "chrome-2", policyDigest: hashBytes(f.sink.read()),
    positive: `${"a".repeat(32)}.e${epoch}.r${revision}.pac.invalid`,
    negative: `${"b".repeat(32)}.e${epoch - 1}.r${revision}.pac.invalid`,
  };
  expect(p.finalize(editor, proof)).toEqual(err("unauthorized"));
  expect(p.finalize(proxy, proof)).toEqual(err("unauthorized"));
  expect(p.finalize(stale, proof)).toEqual(err("fenced"));
  expect(p.finalize(observer, { ...proof, browserGeneration: "sibling" })).toEqual(err("receipt_mismatch"));
  expect(p.finalize(observer, { ...proof, negative: proof.positive })).toEqual(err("receipt_mismatch"));
  expect(p.finalize(observer, { ...proof, policyDigest: "0".repeat(64) })).toEqual(err("not_ready"));
  expect(value(p.inspect(f.admin)).editingEnabled).toBe(false);
  value(p.finalize(observer, proof));
  p.close();
  const reopened = f.open();
  const state = value(reopened.inspect(f.admin));
  expect(state.lastBrowserProof).toEqual(proof);
  expect(state.history.find((item) => item.operationId === prior.operationId)?.disposition).toBe("cancelled");
  expect(value(reopened.propose(editor, "add", wire("wipo.int", id(2, epoch, revision), revision))).phase).toBe("claimed");
});

test("[domains C10] losing the idle reservation during recovery sync cannot issue a home grant", () => {
  let held = true;
  const f = fixture(["wikipedia.org"], () => held ? "idle-lease" : null);
  const interrupted = f.open({ ...f.sink, replace(old, next) {
    f.sink.replace(old, next);
    throw new Error("interrupted after rename");
  } });
  const edit = value(interrupted.propose(f.editor, "remove", wire("wikipedia.org")));
  value(interrupted.beginActivation(f.proxy, edit.operationId));
  expect(interrupted.publish(f.proxy, receipt(edit))).toEqual(err("unavailable"));
  const epoch = value(interrupted.disable(f.admin, EPOCH));
  interrupted.close();
  const p = f.open({ ...f.sink, replace(old, next) {
    f.sink.replace(old, next);
    if (old === next) held = false;
  } });
  const recovered = value(p.authorizeRecovery(f.admin, {
    epoch, operationId: id(3, epoch), proxyGeneration: "proxy-2", domains: [], releaseDirect: [],
  }));
  const proxy = f.session({ role: "proxy", epoch, generation: "proxy-2" });
  const beforeGrant = f.bytes();
  expect(value(p.inspectIdleCandidate(f.admin))).toMatchObject({
    scope: { operationId: recovered.operationId, policyPreimageDigest: hashBytes(f.sink.read()) },
    recoveryOf: { scope: { operationId: edit.operationId, policyPreimageDigest: hashBytes(f.initial) } },
  });
  expect(f.bytes()).toEqual(beforeGrant);
  expect(p.beginActivation(proxy, recovered.operationId)).toEqual(err("not_ready"));
  expect(f.bytes()).toEqual(beforeGrant);
  expect(value(p.inspectPolicy(f.admin))).toBe("interrupted");
  expect(value(p.inspect(f.admin)).pending?.phase).toBe("claimed");
});

test("[domains C10] repeated Disable and reopen keep the original idle hold bound to forward recovery", () => {
  let expected: IdleReservationScope;
  let recoveryScope: IdleReservationScope;
  let replacement = false;
  const f = fixture(["wikipedia.org"], (scope, origin) => {
    if (!origin) return scope.operationId === expected?.operationId ? "original-hold" : null;
    expect(origin).toEqual({ id: "original-hold", scope: expected });
    expect(scope).toEqual(recoveryScope);
    return replacement ? "other-hold" : origin.id;
  });
  let p = f.open();
  const edit = value(p.propose(f.editor, "remove", wire("wikipedia.org")));
  expected = { enrollment: ENROLLMENT, epoch: EPOCH, operationId: edit.operationId, revision: INIT + 1,
    domainsDigest: edit.target.domainsDigest, policyPreimageDigest: hashBytes(f.initial) };
  const original = { id: "original-hold", operationDigest: idleWindowDigest(expected) };
  value(p.beginActivation(f.proxy, edit.operationId));
  value(p.publish(f.proxy, receipt(edit)));
  const preimage = f.sink.read();
  let epoch = value(p.disable(f.admin, EPOCH));
  expect(p.inspectCompletedIdleWindow(f.admin, original)).toEqual(err("not_ready"));
  p.close();
  p = f.open();
  function claim(n: number) {
    const proxyGeneration = `proxy-${n}`;
    const operation = value(p.authorizeRecovery(f.admin, {
      epoch, operationId: id(n, epoch), proxyGeneration, domains: [], releaseDirect: [],
    }));
    recoveryScope = {
      enrollment: ENROLLMENT, epoch, operationId: operation.operationId, revision: operation.target.policy.revision,
      domainsDigest: operation.target.domainsDigest, policyPreimageDigest: hashBytes(preimage),
    };
    return { operation, scope: recoveryScope, proxy: f.session({ role: "proxy", epoch, generation: proxyGeneration }) };
  }
  const first = claim(2);
  value(p.beginActivation(first.proxy, first.operation.operationId));
  epoch = value(p.disable(f.admin, epoch));
  p.close();
  p = f.open();
  const latest = claim(3);
  replacement = true;
  expect(p.beginActivation(latest.proxy, latest.operation.operationId)).toEqual(err("not_ready"));
  expect(f.sink.read()).toBe(preimage);
  expect(p.inspectIdleCandidate(f.admin)).toEqual({ ok: true, value: {
    scope: latest.scope, recoveryOf: { id: original.id, scope: expected }, operationDigest: original.operationDigest,
  } });
  expect(value(p.inspect(f.admin)).pending?.phase).toBe("claimed");
  replacement = false;
  value(p.beginActivation(latest.proxy, latest.operation.operationId));
  value(p.publish(latest.proxy, receipt(latest.operation)));
  const proof = {
    ...receipt(latest.operation), browserGeneration: "new-browser", policyDigest: hashBytes(f.sink.read()),
    positive: `${"a".repeat(32)}.e${epoch}.r${latest.operation.target.policy.revision}.pac.invalid`,
    negative: `${"b".repeat(32)}.e${epoch - 1}.r${latest.operation.target.policy.revision}.pac.invalid`,
  };
  const observer = f.session({ role: "observer", epoch, generation: proof.browserGeneration });
  value(p.finalize(observer, proof));
  p.close();
  p = f.open();
  expect(p.inspectCompletedIdleWindow(f.admin, original)).toEqual({ ok: true, value: null });
  expect(p.inspectCompletedIdleWindow(f.admin, { ...original, operationDigest: idleWindowDigest(latest.scope) }))
    .toEqual(err("not_ready"));
  expect(value(p.inspect(f.admin))).toMatchObject({ recovery: null, pending: null, editingEnabled: true });
});

test("[domains C10] administrator recovery stays narrower, retains uncertain routes, and requires a fresh receipt", () => {
  const f = fixture(["wikipedia.org"]);
  const from = f.open({ ...f.sink, replace(old, next) { f.sink.replace(old, next); throw new Error("interrupt"); } });
  const beforeRename = f.sink.read();
  const op = value(from.propose(f.editor, "remove", wire("wikipedia.org")));
  value(from.beginActivation(f.proxy, op.operationId));
  expect(from.publish(f.proxy, receipt(op))).toEqual(err("unavailable"));
  const afterRename = f.sink.read();
  from.close();
  const restarted = f.open();
  expect(value(restarted.inspectPolicy(f.admin))).toBe("publishing");
  expect(restarted.inspectPolicy(f.editor)).toEqual(err("unauthorized"));
  const epoch = value(restarted.disable(f.admin, EPOCH));
  restarted.close();
  let syncs = 0;
  let failSync = false;
  const open = () => f.open({
    ...f.sink,
    replace(old, next) {
      if (old === next) {
        syncs++;
        if (failSync) throw new Error("sync failed");
      }
      f.sink.replace(old, next);
    },
  });
  let p = open();
  expect(value(p.inspectPolicy(f.admin))).toBe("interrupted");
  expect(value(p.inspect(f.admin))).toMatchObject({ editingEnabled: false, pending: null, lastProven: { policy: { revision: INIT } } });
  expect(f.sink.read()).toBe(afterRename);
  const adminRecovery = { epoch, operationId: id(3, epoch), proxyGeneration: "proxy-2", domains: [], releaseDirect: [] };
  const fresh = f.session({ role: "proxy", epoch, generation: "proxy-2" });
  const freshEditor = f.session({ role: "editor", epoch });
  expect(p.authorizeRecovery(freshEditor, adminRecovery)).toEqual(err("unauthorized"));
  expect(p.authorizeRecovery(f.admin, { ...adminRecovery, domains: ["www.wikipedia.org"] })).toEqual(err("invalid_domain"));
  expect(p.authorizeRecovery(f.admin, { ...adminRecovery, releaseDirect: ["who.int"] })).toEqual(err("invalid_domain"));
  const beforeRecovery = f.bytes();
  for (const unknown of [afterRename.trimEnd(), renderDomainPolicy(PORT, { epoch, revision: INIT + 1, routes: [] })]) {
    writeFileSync(f.policyPath, unknown);
    expect(p.inspectPolicy(f.admin)).toEqual(err("not_ready"));
    expect(p.authorizeRecovery(f.admin, adminRecovery)).toEqual(err("not_ready"));
    expect(f.sink.read()).toBe(unknown);
    expect(f.bytes()).toEqual(beforeRecovery);
  }
  writeFileSync(f.policyPath, afterRename);
  const inode = statSync(f.policyPath).ino;
  const recovery = value(p.authorizeRecovery(f.admin, adminRecovery));
  expect(f.sink.read()).toBe(afterRename);
  expect(statSync(f.policyPath).ino).toBe(inode);
  expect(syncs).toBe(0);
  p.close();
  p = open();
  expect(value(p.inspectPolicy(f.admin))).toBe("interrupted");
  expect(recovery.target).toMatchObject({ domains: [], policy: { revision: INIT + 2, routes: ["wikipedia.org"] } });
  expect(p.publish(fresh, receipt(recovery))).toEqual(err("receipt_mismatch"));
  writeFileSync(f.policyPath, beforeRename);
  expect(value(p.inspectPolicy(f.admin))).toBe("recorded");
  expect(p.beginActivation(fresh, recovery.operationId)).toEqual(err("not_ready"));
  expect(syncs).toBe(0);
  writeFileSync(f.policyPath, afterRename);
  failSync = true;
  expect(p.beginActivation(fresh, recovery.operationId)).toEqual(err("unavailable"));
  expect(value(p.inspect(f.admin)).pending?.phase).toBe("claimed");
  expect(f.sink.read()).toBe(afterRename);
  failSync = false;
  value(p.beginActivation(fresh, recovery.operationId));
  expect(syncs).toBe(2);
  expect(value(p.inspectPolicy(f.admin))).toBe("recorded");
  expect(p.publish(f.proxy, receipt(recovery))).toEqual(err("fenced"));
  expect(value(p.publish(fresh, receipt(recovery))).phase).toBe("published");
  expect(pac(f.sink.read())("wikipedia.org")).toBe(PROXY);
  expect(value(p.inspect(f.admin))).toMatchObject({ lastProven: { policy: { revision: INIT } }, recovery: { operationId: id() } });

  const nextEpoch = value(p.disable(f.admin, epoch));
  const explicit = value(p.authorizeRecovery(f.admin, {
    epoch: nextEpoch, operationId: id(4, nextEpoch), proxyGeneration: "proxy-3", domains: [], releaseDirect: ["wikipedia.org"],
  }));
  const current = f.session({ role: "proxy", epoch: nextEpoch, generation: "proxy-3" });
  value(p.beginActivation(current, explicit.operationId));
  expect(pac(f.sink.read())("wikipedia.org")).toBe(PROXY);
  expect(value(p.publish(current, receipt(explicit))).phase).toBe("published");
  expect(pac(f.sink.read())("wikipedia.org")).toBe("DIRECT");
  expect(value(p.inspect(f.admin))).toMatchObject({ lastProven: { policy: { revision: INIT } }, recovery: { operationId: id() } });

  let latest = value(p.disable(f.admin, nextEpoch));
  for (let i = 0; i < 34; i++) {
    value(p.authorizeRecovery(f.admin, { ...adminRecovery, epoch: latest, operationId: id(5, latest) }));
    latest = value(p.disable(f.admin, latest));
  }
  const bounded = value(p.inspect(f.admin));
  expect(bounded.history).toHaveLength(32);
  expect(bounded.recovery?.operationId).toBe(id());
  expect(p.authorizeRecovery(f.admin, { ...adminRecovery, epoch: latest })).toEqual(err("invalid_request"));
});

test("[domains C4] fixed policy and journal paths refuse symlinks rather than changing the destination", () => {
  const f = fixture();
  const p = f.open();
  const op = value(p.propose(f.editor, "add", wire("wipo.int")));
  value(p.beginActivation(f.proxy, op.operationId));
  const unrelated = join(f.root, "unrelated.json");
  renameSync(f.policyPath, unrelated);
  symlinkSync(unrelated, f.policyPath);
  expect(p.publish(f.proxy, receipt(op))).toEqual(err("unavailable"));
  expect(readFileSync(unrelated, "utf8")).toBe(f.initial);
  const redirect = join(f.root, "redirect");
  symlinkSync(f.policyDir, redirect);
  expect(() => fileDomainPolicySink(redirect, f.journalDir)).toThrow();
  const journal = join(f.journalDir, "domains.sqlite");
  const displaced = join(f.root, "displaced.sqlite");
  p.close();
  renameSync(journal, displaced);
  symlinkSync(displaced, journal);
  expect(() => f.open()).toThrow();
});
