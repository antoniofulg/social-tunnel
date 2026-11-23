import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { createDomainObserver } from "../server/domain-observer";
import { renderDomainPolicy } from "../src/domain-policy";

const policy = { epoch: 1, revision: 12, routes: ["wikipedia.org"] };
const bytes = renderDomainPolicy(8888, policy);

function cdpFixture(fault: "late_policy" | "expired" | null) {
  const input = new PassThrough();
  const output = new PassThrough();
  const expected = JSON.parse(bytes).ProxySettings;
  let now = 0;
  let generation = 1;
  let reads = 0;
  let visits = 0;
  input.on("data", (data: Buffer) => {
    const { id, method, params } = JSON.parse(data.toString().slice(0, -1));
    let result: object;
    if (method === "Target.createTarget") result = { targetId: `t${id}` };
    else if (method === "Target.getTargetInfo") result = { targetInfo: { type: "page", browserContextId: "enrolled" } };
    else if (method === "Target.attachToTarget") result = { sessionId: `s${id}` };
    else if (method === "Target.closeTarget") result = { success: true };
    else if (method === "Page.navigate") {
      if (params.url.startsWith("chrome:")) result = {};
      else {
        visits++;
        if (fault === "expired" && visits === 2) now = 31000;
        result = { errorText: visits === 1 ? "net::ERR_TUNNEL_CONNECTION_FAILED" : "net::ERR_NAME_NOT_RESOLVED" };
      }
    } else if (method === "Runtime.evaluate") {
      if (!params.expression.includes("const matches = rows")) result = { result: { value: true } };
      else {
        reads++;
        const value = fault === "late_policy" && visits === 2 ? { ...expected, ProxyPacMandatory: false } : expected;
        result = { result: { value: { valid: true, disabled: false, value } } };
      }
    } else throw new Error("unexpected proof command");
    output.write(JSON.stringify({ id, result }) + "\0");
  });
  const observer = createDomainObserver({ generation: "fixture", input, output, ownership: () => generation,
    watchCanaries: (positive) => ({ seen: (host) => host === positive, close() {} }),
  }, () => now);
  return {
    observer, reads: () => reads, visits: () => visits,
    nextOwnership() { generation++; }, close() { input.end(); output.end(); },
  };
}

test("[domains C11] paired browser visits do not commit after effective policy drift or proof expiry", async () => {
  for (const fault of ["late_policy", "expired", null] as const) {
    const f = cdpFixture(fault);
    let accepted = 0;
    try {
      const proof = await f.observer.prove(policy, bytes, () => { accepted++; return true; });
      expect(f.visits()).toBe(2);
      expect(f.reads()).toBe(2);
      expect(accepted).toBe(fault ? 0 : 1);
      if (fault) expect(proof).toBeNull();
      else {
        expect(f.observer.valid(proof!)).toBe(true);
        f.nextOwnership();
        expect(f.observer.valid(proof!)).toBe(false);
      }
    } finally { f.close(); }
  }
});
