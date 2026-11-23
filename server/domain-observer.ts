import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { hashBytes, type PolicyRevision } from "../src/domain-policy";
import { withTimeout } from "../src/proxy";
import { DIRECT_WITNESS_MAPPING, startDirectWitness, type DirectWitness, type DirectWitnessEnrollment } from "./domain-direct-witness";

const PROOF_MS = 30000;

const CDP_TIMEOUT = 4000;
const MAX_FRAME = 256 * 1024;
const POLICY_PAGE = "chrome://policy/";
const POLICY_STATE = `(() => {
  if (location.href !== 'chrome://policy/') return null;
  const rows = [];
  let button;
  function walk(root) {
    rows.push(...root.querySelectorAll('policy-row'));
    button ??= root.querySelector('#reload-policies');
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) walk(el.shadowRoot);
  }
  walk(document);
  const matches = rows.filter(r => r.policy?.name === 'ProxySettings');
  if (!button || matches.length !== 1) return null;
  const row = matches[0];
  let value = row.policy.value;
  if (typeof value === 'string') try { value = JSON.parse(value); } catch { return null; }
  const labels = row.shadowRoot?.textContent ?? '';
  return {value, disabled:button.disabled, valid:['Platform','Machine','Mandatory','OK'].every(v => labels.includes(v)) && !row.policy.conflicts?.length};
})()`;
const RELOAD = `(() => {
  if (location.href !== 'chrome://policy/') return false;
  function find(root) {
    const button = root.querySelector('#reload-policies');
    if (button) return button;
    for (const el of root.querySelectorAll('*')) if (el.shadowRoot) {
      const match = find(el.shadowRoot);
      if (match) return match;
    }
  }
  const button = find(document);
  if (!button || button.disabled) return false;
  button.click();
  return true;
})()`;

type Json = Record<string, unknown>;
type Pending = { id: number; sessionId?: string; resolve: (response: Json | null) => void };
type Visit = { targetId: string; sessionId: string; browserContextId?: string };

export interface EnrolledChrome {
  readonly generation: string;
  readonly input: Writable;
  readonly output: Readable;
  // Protected supervisor increments on every process/profile, private resolver,
  // policy or forward ownership transition, even between reads.
  ownership(): number | null;
  readonly directWitness?: DirectWitnessEnrollment;
}

interface ForwardWitness {
  positiveSeen(): Promise<boolean>;
  valid(): boolean;
  close(): void;
}

export interface BrowserEvidence {
  readonly generation: string;
  readonly policyDigest: string;
  readonly positive: string;
  readonly negative: string;
  readonly ownership: number;
  readonly expiresAt: number;
}

export function createDomainObserver(chrome: EnrolledChrome, now = () => performance.now(), directOrigin = startDirectWitness) {
  let active = true;
  let busy = false;
  let next = 0;
  let pending: Pending | undefined;
  let frame: Buffer = Buffer.alloc(0);
  let highest = -1;
  let fenced = -1;
  function ownership(): number | null {
    const generation = active && chrome.directWitness?.mapping === DIRECT_WITNESS_MAPPING ? chrome.ownership() : null;
    if (generation === null || generation < highest || !Number.isSafeInteger(generation) || generation < 0) {
      fenced = highest;
      return null;
    }
    if (generation <= fenced) return null;
    highest = generation;
    return generation;
  }
  const alive = () => ownership() !== null;
  const valid = (proof: BrowserEvidence) => ownership() === proof.ownership && now() < proof.expiresAt;
  function stop() { active = false; pending?.resolve(null); }
  chrome.output.once("end", stop);
  chrome.output.once("error", stop);
  chrome.input.once("error", stop);
  chrome.output.on("data", (chunk: Buffer) => {
    if (!active) return;
    let start = 0;
    while (start < chunk.length) {
      const end = chunk.indexOf(0, start);
      const data = chunk.subarray(start, end < 0 ? chunk.length : end);
      if (frame.length + data.length > MAX_FRAME) return stop();
      if (end < 0) { frame = Buffer.concat([frame, data]); return; }
      try {
        const message = JSON.parse(frame.length ? Buffer.concat([frame, data]).toString() : data.toString());
        if (pending && message.id === pending.id && message.sessionId === pending.sessionId) {
          pending.resolve(message.error ? null : message.result);
        }
      } catch { return stop(); }
      frame = Buffer.alloc(0);
      start = end + 1;
    }
  });

  async function call(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (!alive() || pending) throw new Error("browser observer unavailable");
    const { promise, resolve } = Promise.withResolvers<Json | null>();
    const id = ++next;
    pending = { id, sessionId, resolve };
    const timer = setTimeout(() => stop(), CDP_TIMEOUT);
    try {
      chrome.input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
      const result = await promise;
      if (!result || !alive()) throw new Error("browser witness unavailable");
      return result;
    } finally { clearTimeout(timer); pending = undefined; }
  }

  async function tab(): Promise<Visit> {
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    if (typeof targetId !== "string") throw new Error("missing browser target");
    const info = await pageInfo(targetId);
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    if (typeof sessionId !== "string") throw new Error("wrong browser target");
    return { targetId, sessionId, browserContextId: info };
  }
  async function pageInfo(targetId: string): Promise<string | undefined> {
    const info = (await call("Target.getTargetInfo", { targetId })).targetInfo as Json;
    if (info?.type !== "page" || info.targetId !== targetId) throw new Error("wrong browser target");
    return typeof info.browserContextId === "string" ? info.browserContextId : undefined;
  }
  async function evaluate(expr: string, page: Visit, awaitPromise = false): Promise<unknown> {
    const result = await call("Runtime.evaluate", { expression: expr, awaitPromise, returnByValue: true }, page.sessionId);
    if (result.exceptionDetails) return null;
    return (result.result as Json).value;
  }
  async function navigate(url: string, page: Visit): Promise<unknown> {
    return (await call("Page.navigate", { url }, page.sessionId)).errorText;
  }
  const nonce = () => randomBytes(16).toString("hex");

  async function prove(
    policy: PolicyRevision, expectedBytes: string, accept: (proof: BrowserEvidence) => boolean,
    watchForward: (positive: string) => ForwardWitness,
  ): Promise<BrowserEvidence | null> {
    const owner = ownership();
    if (busy || owner === null || !chrome.directWitness) return null;
    busy = true;
    const pages: Visit[] = [];
    const positive = `${nonce()}.e${policy.epoch}.r${policy.revision}.pac.invalid`;
    const wrongEpoch = policy.epoch === 0 ? 1 : policy.epoch - 1;
    const negative = `${nonce()}.e${wrongEpoch}.r${policy.revision}.pac.invalid`;
    let watch: ForwardWitness | undefined;
    let direct: DirectWitness | undefined;
    try {
      const expected = JSON.parse(expectedBytes).ProxySettings;
      async function effective(page: Visit) {
        const state = await evaluate(POLICY_STATE, page) as { value?: Json; valid?: boolean; disabled?: boolean } | null;
        return state?.valid && !state.disabled && state.value && Object.keys(state.value).length === 3 &&
          state.value.ProxyMode === "pac_script" && state.value.ProxyPacMandatory === true &&
          state.value.ProxyPacUrl === expected.ProxyPacUrl;
      }
      const page = await tab();
      pages.push(page);
      if (await navigate(POLICY_PAGE, page)) return null;
      let deadline = performance.now() + CDP_TIMEOUT;
      while (await evaluate(RELOAD, page) !== true) {
        if (performance.now() >= deadline) return null;
        await sleep(50);
      }
      deadline = performance.now() + 10000;
      while (!(await effective(page))) {
        if (performance.now() >= deadline) return null;
        await sleep(50);
      }
      const expiresAt = now() + PROOF_MS;
      const witness = await tab();
      pages.push(witness);
      if (page.browserContextId !== witness.browserContextId) return null;
      watch = watchForward(positive);
      if (await navigate(`https://${positive}/`, witness) !== "net::ERR_TUNNEL_CONNECTION_FAILED" ||
          !(await withTimeout(watch.positiveSeen(), CDP_TIMEOUT))) return null;
      const path = `/${nonce()}`;
      direct = await directOrigin(chrome.directWitness, negative, path);
      const url = `http://${negative}:${direct.port}${path}`;
      if (await navigate(url, witness)) return null;
      const receipt = await withTimeout(direct.seen, CDP_TIMEOUT);
      if (!receipt) return null;
      // The sink chooses the receipt after the one-use GET. Browser success alone,
      // or a request sent to the sink by anything other than this target, is insufficient.
      const body = await evaluate(`(async () => {
        if (location.href !== ${JSON.stringify(url)}) return null;
        if (document.readyState !== 'complete') await new Promise(done => addEventListener('load', done, {once:true}));
        return location.href === ${JSON.stringify(url)} ? document.body?.textContent ?? null : null;
      })()`, witness, true);
      if (body !== receipt || await pageInfo(witness.targetId) !== witness.browserContextId) return null;
      if ((await call("Target.closeTarget", { targetId: witness.targetId })).success !== true) return null;
      pages.pop();
      // Commit only against effective browser policy read *after* the paired visits.
      // The protected callback is synchronous so no other request can race the CAS.
      if (!(await effective(page))) return null;
      const evidence = {
        generation: `${chrome.generation}.${owner}`, ownership: owner, expiresAt,
        policyDigest: hashBytes(expectedBytes), positive, negative,
      };
      return watch.valid() && valid(evidence) && accept(evidence) ? evidence : null;
    } catch { return null; }
    finally {
      direct?.close();
      watch?.close();
      while (pages.length && alive()) {
        try { await call("Target.closeTarget", { targetId: pages.pop()!.targetId }); } catch { break; }
      }
      busy = false;
    }
  }
  return { alive, valid, prove };
}
