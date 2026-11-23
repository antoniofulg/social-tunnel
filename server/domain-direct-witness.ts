import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync } from "node:fs";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import { dirname } from "node:path";

export const DIRECT_WITNESS_HELPER = "/usr/local/bin/st-domains-direct-witness";
// Only the privately enrolled regular profile receives this rule, not the system resolver.
export const DIRECT_WITNESS_MAPPING = "MAP *.pac.invalid 127.0.0.1";
const LEASE_MS = 4000;
const LOOPBACK = "127.0.0.1";
const WITNESS_HOST = /^[0-9a-f]{32}\.e\d{1,16}\.r\d{1,16}\.pac\.invalid$/;
const WITNESS_PATH = /^\/[0-9a-f]{32}$/;
const RECEIPT = /^[0-9a-f]{32}$/;

export interface DirectWitnessEnrollment {
  readonly uid: number;
  readonly gid: number;
  // Included in the protected supervisor's ownership check for this exact browser generation.
  readonly mapping: typeof DIRECT_WITNESS_MAPPING;
}

export interface DirectWitness {
  readonly port: number;
  readonly seen: Promise<string | null>;
  close(): void;
}

export async function listenDirectWitness(host: string, path: string, leaseMs = LEASE_MS): Promise<DirectWitness> {
  if (!WITNESS_HOST.test(host) || !WITNESS_PATH.test(path)) throw new Error("invalid direct challenge");
  const sockets = new Set<Socket>();
  const { promise: seen, resolve } = Promise.withResolvers<string | null>();
  let port = 0;
  let consumed = false;
  let closed = false;
  const server = createServer({ maxHeaderSize: 4096 }, (req, res) => {
    let hosts = 0;
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      if (req.rawHeaders[i]?.toLowerCase() === "host") hosts++;
    }
    if (closed || consumed || req.socket.remoteAddress !== LOOPBACK || req.socket.localAddress !== LOOPBACK ||
        req.method !== "GET" || req.url !== path || req.headers.host !== `${host}:${port}` || hosts !== 1 ||
        req.headers["transfer-encoding"] !== undefined || (req.headers["content-length"] ?? "0") !== "0") {
      req.socket.destroy();
      return;
    }
    consumed = true;
    const receipt = randomBytes(16).toString("hex");
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": receipt.length,
      "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'", "Connection": "close" });
    res.end(receipt, () => resolve(receipt));
  });
  server.on("connection", (socket) => {
    if (sockets.size >= 4) return socket.destroy();
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("connect", (_req, socket) => socket.destroy());
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  server.on("checkContinue", (req) => req.socket.destroy());
  const timer = setTimeout(() => close(), leaseMs);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    server.close();
    for (const socket of sockets) socket.destroy();
    resolve(null);
  }
  try {
    await new Promise<void>((ready, reject) => {
      server.once("error", reject);
      server.listen(0, LOOPBACK, ready);
    });
    const address = server.address();
    if (closed || !address || typeof address === "string" || address.address !== LOOPBACK || address.port <= 1023) {
      throw new Error("direct witness did not bind");
    }
    port = address.port;
    return { port, seen, close };
  } catch (error) { close(); throw error; }
}

function protectedHelper() {
  let path = DIRECT_WITNESS_HELPER;
  const file = lstatSync(path);
  if (!file.isFile() || file.uid !== 0 || (file.mode & 0o6022) || !(file.mode & 0o001)) throw new Error("unsafe direct witness executable");
  for (path = dirname(path); ; path = dirname(path)) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.uid !== 0 || (info.mode & 0o022)) throw new Error("unsafe direct witness directory");
    if (path === "/") return;
  }
}

export async function startDirectWitness(enrollment: DirectWitnessEnrollment, host: string, path: string): Promise<DirectWitness> {
  const { uid, gid, mapping } = enrollment;
  if (process.platform !== "linux" || mapping !== DIRECT_WITNESS_MAPPING || !WITNESS_HOST.test(host) || !WITNESS_PATH.test(path) ||
      ![uid, gid].every((id) => Number.isInteger(id) && id > 0 && id < 0xffffffff) ||
      (process.geteuid?.() !== 0 && (uid !== process.geteuid?.() || gid !== process.getegid?.()))) throw new Error("direct witness not enrolled");
  protectedHelper();
  const drop = process.geteuid?.() === 0 ? [`--reuid=${uid}`, `--regid=${gid}`, "--clear-groups"] : [];
  const child = spawn("/usr/bin/setpriv", [...drop, "--no-new-privs", "--", DIRECT_WITNESS_HELPER], {
    stdio: ["pipe", "pipe", "ignore"], env: { PATH: "/usr/bin:/bin" },
  });
  const { promise: ready, resolve: readyPort } = Promise.withResolvers<number>();
  const { promise: seen, resolve: received } = Promise.withResolvers<string | null>();
  let output = "";
  let closed = false;
  const timer = setTimeout(() => close(), LEASE_MS);
  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    readyPort(0);
    received(null);
  }
  child.once("error", close);
  child.stdin.once("error", close);
  child.stdout.on("data", (data: Buffer) => {
    if (closed) return;
    if (output.length + data.length > 40) return close();
    output += data.toString("latin1");
    const end = output.indexOf("\n");
    if (end < 0) return;
    const raw = output.slice(0, end);
    const port = Number(raw);
    if (!/^[1-9]\d{3,4}$/.test(raw) || port <= 1023 || port > 65535) return close();
    readyPort(port);
  });
  child.once("close", (code) => {
    const lines = output.split("\n");
    if (!closed && code === 0 && lines.length === 3 && lines[2] === "" && RECEIPT.test(lines[1]!)) received(lines[1]!);
    close();
  });
  child.stdin.end(`${host} ${path}\n`);
  const port = await ready;
  if (!port || closed) throw new Error("direct witness unavailable");
  return { port, seen, close };
}

if (import.meta.main) {
  try {
    if (process.platform !== "linux" || !process.geteuid?.() || !process.getegid?.() || process.argv.length !== 2) throw new Error();
    let request = "";
    for await (const chunk of process.stdin) {
      if (request.length + chunk.length > 128) throw new Error();
      request += chunk.toString("latin1");
    }
    const [host, path, extra] = request.trimEnd().split(" ");
    if (!host || !path || extra !== undefined) throw new Error();
    const sink = await listenDirectWitness(host, path);
    process.stdout.write(`${sink.port}\n`);
    const receipt = await sink.seen;
    sink.close();
    if (!receipt) throw new Error();
    process.stdout.write(`${receipt}\n`);
  } catch { process.exitCode = 1; }
}
