import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isRefusedAddress, type Interfaces } from "./address-guard";
import { DEFAULTS } from "./defaults";
import { isAllowed, normalizeHost } from "./host";

export type Resolver = (host: string) => Promise<string[]>;
export type Dialer = (address: string, port: number) => Promise<Duplex>;

export interface ProxyOptions {
  domains: readonly string[];
  resolve: Resolver;
  dial: Dialer;
  interfaces?: () => Interfaces;
  // `host` is present only once it has passed the hostname grammar (criterion 50).
  log?: (entry: { status: number; host?: string }) => void;
  headTimeoutMs?: number;
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
  relayCap?: number;
}

const REASONS: Record<number, string> = {
  400: "Bad Request",
  403: "Forbidden",
  405: "Method Not Allowed",
  408: "Request Timeout",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

// Fixed text per status: a refusal never tells the server why, or what a name resolved to.
function refusal(status: number): string {
  const body = `${status} ${REASONS[status]}\n`;
  return (
    `HTTP/1.1 ${status} ${REASONS[status]}\r\n` +
    `Content-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`
  );
}

const TIMEOUT = Symbol("timeout");

function withTimeout<T>(work: Promise<T>, ms: number, onLate?: (value: T) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    let late = false;
    const timer = setTimeout(() => {
      late = true;
      reject(TIMEOUT);
    }, ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        if (late) onLate?.(value);
        else resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// Returns the handler for one forwarded channel. It reads a single CONNECT head, decides, and
// either relays to a checked public address or answers with a refusal and closes. The handler is
// the only way in: nothing here opens a socket for others to connect to (plan door 4).
export function createProxy(options: ProxyOptions): { handle: (stream: Duplex) => void } {
  const headTimeoutMs = options.headTimeoutMs ?? DEFAULTS.headTimeoutMs;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
  const relayCap = options.relayCap ?? DEFAULTS.relayCap;
  let open = 0;

  const handle = (stream: Duplex) => {
    let head = Buffer.alloc(0);
    let closed = false;
    let upstream: Duplex | undefined;
    let holdsSlot = false;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;

    const release = () => {
      if (holdsSlot) {
        holdsSlot = false;
        open--;
      }
    };
    const refuse = (status: number, host?: string) => {
      release();
      if (closed) return;
      options.log?.({ status, host });
      stream.end(refusal(status), () => stream.destroy());
    };
    const headTimer = setTimeout(() => {
      stream.off("data", onData);
      refuse(408);
    }, headTimeoutMs);

    stream.on("error", () => {});
    stream.once("close", () => {
      closed = true;
      clearTimeout(headTimer);
      clearTimeout(idleTimer);
      release();
      upstream?.destroy();
    });
    stream.on("data", onData);

    function onData(chunk: Buffer) {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      const tooBig = end === -1 ? head.length > DEFAULTS.maxHeadBytes : end + 4 > DEFAULTS.maxHeadBytes;
      if (end === -1 && !tooBig) return;
      stream.off("data", onData);
      stream.pause();
      clearTimeout(headTimer);
      if (tooBig) return refuse(400);
      // Bytes after the head belong to the tunnel payload and are never parsed (criterion 45).
      void connect(head.subarray(0, end).toString("latin1"), head.subarray(end + 4));
    }

    async function connect(text: string, rest: Buffer) {
      const parts = text.split("\r\n", 1)[0]!.split(" ");
      if (parts.length !== 3 || !/^HTTP\/1\.[01]$/.test(parts[2]!)) return refuse(400);
      if (parts[0] !== "CONNECT") return refuse(405);

      const target = parts[1]!;
      const colon = target.lastIndexOf(":");
      if (colon === -1) return refuse(400);
      const rawHost = target.slice(0, colon);
      const port = target.slice(colon + 1);
      const unbracketed = rawHost.startsWith("[") && rawHost.endsWith("]") ? rawHost.slice(1, -1) : rawHost;
      if (isIP(unbracketed)) return refuse(403);
      const host = normalizeHost(rawHost);
      if (!host || !/^[1-9][0-9]{0,4}$/.test(port)) return refuse(400);
      if (port !== "443" || !isAllowed(host, options.domains)) return refuse(403, host);

      if (open >= relayCap) return refuse(503, host);
      open++;
      holdsSlot = true;

      let remote: Duplex;
      try {
        const addresses = await withTimeout(options.resolve(host), connectTimeoutMs);
        if (addresses.length === 0) return refuse(502, host);
        const interfaces = options.interfaces?.();
        const address = addresses.find((a) => !isRefusedAddress(a, interfaces));
        if (address === undefined) return refuse(403, host);
        // Dial the address that was checked, never the name: a second lookup could answer differently.
        remote = await withTimeout(options.dial(address, 443), connectTimeoutMs, (late) => late.destroy());
      } catch (err) {
        return refuse(err === TIMEOUT ? 504 : 502, host);
      }
      if (closed) return remote.destroy();
      upstream = remote;
      options.log?.({ status: 200, host });

      const close = () => {
        stream.destroy();
        remote.destroy();
      };
      idleTimer = setTimeout(close, idleTimeoutMs);
      const touch = () => idleTimer!.refresh();
      remote.on("error", () => {});
      remote.once("close", close);
      stream.on("data", touch);
      remote.on("data", touch);

      stream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) remote.write(rest);
      stream.pipe(remote);
      remote.pipe(stream);
    }
  };
  return { handle };
}
