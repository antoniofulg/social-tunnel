import assert from "node:assert/strict";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { withTimeout } from "../src/proxy";

export async function fixtureOrigins(root: string, changed: string, retained: string) {
  const certFile = join(root, "tls-cert.pem");
  const keyFile = join(root, "tls-key.pem");
  const openssl = spawnSync("/usr/bin/openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256",
    "-nodes", "-subj", "/CN=managed-domains-fixture", "-days", "1", "-addext", `subjectAltName=DNS:${changed},DNS:${retained}`,
    "-keyout", keyFile, "-out", certFile], { timeout: 5000 });
  assert.equal(openssl.status, 0, openssl.stderr?.toString());
  const cert = readFileSync(certFile);
  const key = readFileSync(keyFile);
  const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const seen = new Map<string, ("DIRECT" | "PROXY")[]>();
  function origin(route: "DIRECT" | "PROXY") {
    return createServer({ key, cert }, (req, res) => {
      const host = req.headers.host;
      if (req.method !== "GET" || (host !== changed && host !== retained) || !/^\/visit-[0-9a-f]{32}$/.test(req.url ?? "")) {
        res.writeHead(404, { Connection: "close" }).end();
        return;
      }
      const visit = `${host}${req.url}`;
      const previous = seen.get(visit) ?? [];
      previous.push(route);
      seen.set(visit, previous);
      res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store", Connection: "close" }).end(`${route}:${visit}`);
    });
  }
  const direct = origin("DIRECT");
  const proxied = origin("PROXY");
  let connections = 0;
  for (const server of [direct, proxied]) server.on("connection", () => { connections++; });
  const close = () => { direct.close(); proxied.close(); direct.closeAllConnections(); proxied.closeAllConnections(); };
  try {
    await Promise.all(([[direct, 443], [proxied, 0]] as const).map(([server, port]) => new Promise<void>((ready, reject) => {
      server.once("error", reject).listen(port, "127.0.0.1", ready);
    })));
    const address = proxied.address();
    assert(address && typeof address !== "string");
    return { spki, port: address.port, seen, close, connections: () => connections };
  } catch (error) { close(); throw error; }
}

// Test-only visits on the already enrolled private pipe. Production proof ids
// never overlap this serial range and the fixture does not steer policy.
export function fixtureVisits(chrome: ChildProcess, origins: Awaited<ReturnType<typeof fixtureOrigins>>) {
  const input = chrome.stdio[3] as Writable;
  const output = chrome.stdio[4] as Readable;
  let next = 1000000;
  async function call(method: string, params: object, sessionId?: string): Promise<any> {
    const id = ++next;
    const { promise, resolve, reject } = Promise.withResolvers<any>();
    let partial = "";
    const receive = (chunk: Buffer) => {
      partial += chunk.toString();
      for (let end = partial.indexOf("\0"); end >= 0; end = partial.indexOf("\0")) {
        const raw = partial.slice(0, end);
        partial = partial.slice(end + 1);
        try {
          const r = JSON.parse(raw);
          if (r.id !== id || r.sessionId !== sessionId) continue;
          if (r.error) reject(new Error(`${method}: ${r.error.message}`)); else resolve(r.result);
        } catch (error) { reject(error); }
      }
      if (partial.length > 256 * 1024) reject(new Error("fixture CDP frame overflow"));
    };
    output.on("data", receive);
    try {
      input.write(JSON.stringify({ id, method, params, sessionId }) + "\0");
      return await withTimeout(promise, 4500);
    } finally { output.off("data", receive); }
  }
  return async (host: string, route: "DIRECT" | "PROXY" | "unavailable") => {
    const path = `/visit-${randomBytes(16).toString("hex")}`;
    const url = `https://${host}${path}`;
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    try {
      const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
      const before = origins.connections();
      const result = await call("Page.navigate", { url }, sessionId);
      if (route === "unavailable") {
        assert.equal(result.errorText, "net::ERR_PROXY_CONNECTION_FAILED");
        assert.equal(origins.connections(), before, "selected outage opened an origin TCP connection");
        assert.deepEqual(origins.seen.get(`${host}${path}`) ?? [], []);
      } else {
        assert.equal(result.errorText, undefined);
        const expression = `(async () => {
          if (document.readyState !== 'complete') await new Promise(done => addEventListener('load', done, {once:true}));
          return { url: location.href, body: document.body?.textContent };
        })()`;
        const view = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, sessionId);
        assert.deepEqual(view.result.value, { url, body: `${route}:${host}${path}` });
        assert.deepEqual(origins.seen.get(`${host}${path}`), [route]);
      }
    } finally { await call("Target.closeTarget", { targetId }); }
  };
}
