import { isIP } from "node:net";
import type { Duplex } from "node:stream";
import { isRefusedAddress, type Interfaces } from "./address-guard";
import { DEFAULTS } from "./defaults";
import { isAllowed, normalizeHost } from "./host";
import type { ManagedDomainSnapshot } from "./managed-domains";

export type Resolver = (host: string) => Promise<string[]>;
// `signal` aborts when the caller has given up on the dial; the dialer then closes what it opened.
export type Dialer = (address: string, port: number, signal?: AbortSignal) => Promise<Duplex>;

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

export const TIMEOUT = Symbol("timeout");

export function withTimeout<T>(work: Promise<T>, ms: number, onLate?: (value: T) => void): Promise<T> {
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

// The legacy allowlist stays fixed to the config loaded by run.
export function createProxy(options: ProxyOptions): { handle: (stream: Duplex) => void } {
  return { handle: channelHandler(options, (host) => isAllowed(host, options.domains)) };
}

type ManagedOptions = Omit<ProxyOptions, "domains" | "resolve"> & {
  // Abort should cancel the query. Activation waits for the promise to settle even if it can't.
  resolve: (host: string, signal: AbortSignal) => Promise<string[]>;
};

type ManagedFlow = { host: string; revoke: () => Promise<void> };

type LocalActivation =
  | { ok: true; snapshot: ManagedDomainSnapshot }
  | { ok: false; code: "conflict" | "invalid_revision" };

// Internal only. The caller verifies intent and tunnel ownership; this is not a publication receipt.
export function createManagedProxy(options: ManagedOptions, initial: ManagedDomainSnapshot) {
  const flows = new Set<ManagedFlow>();
  let current = initial;
  let activating = false;
  const handle = channelHandler(options, (host) => current.allows(host), flows);

  const activate = async (expectedRevision: number, next: ManagedDomainSnapshot): Promise<LocalActivation> => {
    if (activating || current.revision !== expectedRevision) return { ok: false, code: "conflict" };
    if (next.revision <= expectedRevision) return { ok: false, code: "invalid_revision" };
    activating = true;
    current = next;
    try {
      const revoked = [];
      for (const flow of flows) {
        if (!next.allows(flow.host)) revoked.push(flow.revoke());
      }
      await Promise.all(revoked);
      return { ok: true, snapshot: next };
    } finally {
      activating = false;
    }
  };
  return { handle, activate };
}

// Handles one forwarded channel. Nothing here opens a socket for others to connect to (plan door 4).
function channelHandler(options: ManagedOptions, allows: (host: string) => boolean, flows?: Set<ManagedFlow>) {
  const headTimeoutMs = options.headTimeoutMs ?? DEFAULTS.headTimeoutMs;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
  const relayCap = options.relayCap ?? DEFAULTS.relayCap;
  let open = 0;

  const handle = (stream: Duplex) => {
    let head = Buffer.alloc(0);
    let closed = false;
    // A channel holds a slot from its first byte, so slow heads count against the cap too.
    let holdsSlot = open < relayCap && (!flows || flows.size < relayCap);
    if (holdsSlot) open++;

    const release = () => {
      if (holdsSlot) {
        holdsSlot = false;
        open--;
      }
    };
    // ssh2 holds back 'close' on a channel nobody is reading, so a paused channel that the peer
    // closed, or whose connection dropped, is told apart by its channel state. Reading it again
    // lets ssh2 finish the close.
    const gone = () => {
      if (!closed && (stream as { incoming?: { state?: string } }).incoming?.state !== "closed") return false;
      stream.resume();
      return true;
    };
    let refusalTimer: ReturnType<typeof setTimeout> | undefined;
    const refuse = (status: number, host?: string) => {
      release();
      if (gone()) return;
      options.log?.({ status, host });
      // A peer that grants no send window never takes the refusal: the channel is closed anyway
      // once the deadline passes, and what the peer still sends is discarded, not kept.
      refusalTimer = setTimeout(() => stream.destroy(), headTimeoutMs);
      stream.resume();
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
      clearTimeout(refusalTimer);
      release();
    });
    if (!holdsSlot) {
      clearTimeout(headTimer);
      return refuse(503);
    }
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
      if (port !== "443" || !allows(host)) return refuse(403, host);

      let remote: Duplex;
      const giveUp = new AbortController();
      let opening: Duplex | undefined;
      let pending: Promise<void> | undefined;
      let dropRelay: (() => void) | undefined;
      let revoked = false;
      const flow = flows && {
        host,
        async revoke() {
          revoked = true;
          if (dropRelay) dropRelay();
          else {
            release();
            stream.destroy();
            stream.resume();
            opening?.destroy();
          }
          giveUp.abort();
          await pending;
          flows.delete(this);
        },
      };
      if (flows && flow) flows.add(flow);

      function track<T>(work: () => Promise<T>) {
        const result = Promise.resolve().then(() => {
          giveUp.signal.throwIfAborted();
          return work();
        });
        // The timeout only bounds what the request waits for, not what activation must drain.
        pending = result.then(() => {}, () => {});
        return withTimeout(result, connectTimeoutMs);
      }
      try {
        const addresses = await (flow
          ? track(() => options.resolve(host, giveUp.signal))
          : withTimeout(options.resolve(host, giveUp.signal), connectTimeoutMs));
        if (revoked || gone()) return release();
        if (addresses.length === 0) return refuse(502, host);
        const interfaces = options.interfaces?.();
        const address = addresses.find((a) => !isRefusedAddress(a, interfaces));
        if (address === undefined) return refuse(403, host);
        // Dial the address that was checked, never the name: a second lookup could answer differently.
        remote = flow
          ? await track(async () => {
              const socket = await options.dial(address, 443, giveUp.signal);
              if (giveUp.signal.aborted) {
                socket.destroy();
                giveUp.signal.throwIfAborted();
              }
              return (opening = socket);
            })
          : await withTimeout(options.dial(address, 443, giveUp.signal), connectTimeoutMs, (late) => late.destroy());
      } catch (err) {
        // A dial that timed out is still connecting: stop it, or its socket outlives the slot.
        giveUp.abort();
        if (!revoked) return refuse(err === TIMEOUT ? 504 : 502, host);
        return;
      } finally {
        if (flow && !opening) void pending?.then(() => flows!.delete(flow));
      }
      if (revoked) return;
      if (gone()) {
        release();
        if (flow) flows!.delete(flow);
        return remote.destroy();
      }
      options.log?.({ status: 200, host });
      if (revoked) return;

      // Closes the channel from this side. Its slot is freed here and not on 'close': ssh2 reports a
      // channel's close only once the peer has answered and the channel has been read to its end.
      const drop = () => {
        release();
        stream.destroy();
      };
      const idleTimer = setTimeout(() => {
        if (dropRelay) {
          flows!.delete(flow!);
          return dropRelay();
        }
        drop();
        remote.destroy();
      }, idleTimeoutMs);
      const touch = () => idleTimer.refresh();
      if (flow) {
        dropRelay = () => {
          clearTimeout(idleTimer);
          stream.off("data", touch);
          remote.off("data", touch);
          stream.unpipe(remote);
          remote.unpipe(stream);
          drop();
          stream.resume();
          remote.destroy();
        };
      }
      // When one side is gone the other is ended, not destroyed: bytes already accepted for it may
      // still be queued (an SSH channel waits for window) and are delivered first. What it still
      // sends has nowhere to go and is read and discarded, so its own close is seen. From then on
      // nothing refreshes the idle timer, so it bounds the flush.
      const flush = (to: Duplex, from: Duplex) => {
        if (revoked) return;
        stream.off("data", touch);
        remote.off("data", touch);
        to.unpipe(from);
        to.resume();
        const shut = () => {
          if (flow) flows!.delete(flow);
          if (to === stream) drop();
          else to.destroy();
        };
        if (to.destroyed) {
          if (flow) flows!.delete(flow);
          return clearTimeout(idleTimer);
        }
        to.once("close", () => clearTimeout(idleTimer));
        if (to.writableFinished) return shut();
        to.once("finish", shut);
        to.end();
      };
      remote.on("error", () => {});
      remote.once("close", () => flush(stream, remote));
      stream.once("close", () => flush(remote, stream));
      stream.on("data", touch);
      remote.on("data", touch);

      stream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (rest.length > 0) remote.write(rest);
      stream.pipe(remote);
      remote.pipe(stream);
    }
  };
  return handle;
}
