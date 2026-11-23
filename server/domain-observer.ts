import { randomBytes } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { hashBytes, type PolicyRevision } from "../src/domain-policy";

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
type Pending = { id: number; resolve: (response: Json | null) => void };
type Visit = { targetId: string; sessionId: string; browserContextId?: string };

export interface EnrolledChrome {
  readonly generation: string;
  readonly input: Writable;
  readonly output: Readable;
  // Protected supervisor-owned process identity and exclusive loopback bind; never SSH data.
  ownsContext(): boolean;
  // Arms only the two generated synthetic names at a protected refusal observer, with no payload access.
  watchCanaries(positive: string, negative: string): { seen(host: string): boolean; close(): void };
}

export interface BrowserEvidence {
  readonly generation: string;
  readonly policyDigest: string;
  readonly positive: string;
  readonly negative: string;
}

export function createDomainObserver(chrome: EnrolledChrome) {
  let active = true;
  let busy = false;
  let next = 0;
  let pending: Pending | undefined;
  let frame: Buffer = Buffer.alloc(0);
  const generation = chrome.generation;
  const alive = () => active && chrome.ownsContext();
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
        if (pending && message.id === pending.id) pending.resolve(message.error ? null : message.result);
      } catch { return stop(); }
      frame = Buffer.alloc(0);
      start = end + 1;
    }
  });

  async function call(method: string, params: Json = {}, sessionId?: string): Promise<Json> {
    if (!alive() || pending) throw new Error("browser observer unavailable");
    const { promise, resolve } = Promise.withResolvers<Json | null>();
    const id = ++next;
    pending = { id, resolve };
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
    const info = (await call("Target.getTargetInfo", { targetId })).targetInfo as Json;
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    if (typeof sessionId !== "string" || info.type !== "page") throw new Error("wrong browser target");
    return { targetId, sessionId, browserContextId: typeof info.browserContextId === "string" ? info.browserContextId : undefined };
  }
  async function evaluate(expr: string, page: Visit): Promise<unknown> {
    const result = await call("Runtime.evaluate", { expression: expr, returnByValue: true }, page.sessionId);
    if (result.exceptionDetails) return null;
    return (result.result as Json).value;
  }
  async function navigate(url: string, page: Visit): Promise<unknown> {
    return (await call("Page.navigate", { url }, page.sessionId)).errorText;
  }
  const nonce = () => randomBytes(16).toString("hex");

  async function prove(policy: PolicyRevision, expectedBytes: string): Promise<BrowserEvidence | null> {
    if (busy || !alive()) return null;
    busy = true;
    const pages: Visit[] = [];
    const positive = `${nonce()}.e${policy.epoch}.r${policy.revision}.pac.invalid`;
    const wrongEpoch = policy.epoch === 0 ? 1 : policy.epoch - 1;
    const negative = `${nonce()}.e${wrongEpoch}.r${policy.revision}.pac.invalid`;
    let watch: ReturnType<EnrolledChrome["watchCanaries"]> | undefined;
    try {
      const expected = JSON.parse(expectedBytes).ProxySettings;
      const page = await tab();
      pages.push(page);
      if (await navigate(POLICY_PAGE, page)) return null;
      let deadline = performance.now() + CDP_TIMEOUT;
      while (await evaluate(RELOAD, page) !== true) {
        if (performance.now() >= deadline) return null;
        await sleep(50);
      }
      deadline = performance.now() + 10000;
      for (;;) {
        const policyState = await evaluate(POLICY_STATE, page) as { value?: Json; valid?: boolean; disabled?: boolean } | null;
        if (policyState?.valid && !policyState.disabled && policyState.value?.ProxyMode === "pac_script" &&
            policyState.value.ProxyPacMandatory === true && policyState.value.ProxyPacUrl === expected.ProxyPacUrl) break;
        if (performance.now() >= deadline) return null;
        await sleep(50);
      }
      const witness = await tab();
      pages.push(witness);
      if (page.browserContextId !== witness.browserContextId) return null;
      watch = chrome.watchCanaries(positive, negative);
      if (await navigate(`https://${positive}/`, witness) !== "net::ERR_TUNNEL_CONNECTION_FAILED" || !watch.seen(positive)) return null;
      if (await navigate(`https://${negative}/`, witness) !== "net::ERR_NAME_NOT_RESOLVED" || watch.seen(negative)) return null;
      return alive() ? { generation, policyDigest: hashBytes(expectedBytes), positive, negative } : null;
    } catch { return null; }
    finally {
      watch?.close();
      while (pages.length && alive()) {
        try { await call("Target.closeTarget", { targetId: pages.pop()!.targetId }); } catch { break; }
      }
      busy = false;
    }
  }
  return { alive, generation, prove };
}
