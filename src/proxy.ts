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

type ManagedOptions = Omit<ProxyOptions, "domains" | "resolve" | "dial"> & {
  // Abort should cancel the query. Activation waits for the promise to settle even if it can't.
  resolve: (host: string, signal: AbortSignal) => Promise<string[]>;
  // Rejection means the dialer has already closed any socket it opened. Returned
  // sockets emit 'close' when local teardown finishes, not when destroy() starts.
  dial: Dialer;
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

type ForwardedChannel = Duplex & { incoming?: { state: string }; close?: () => void };

function destroyLocal(stream: Duplex): Promise<void> | undefined {
  if (stream.closed) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  stream.once("close", resolve);
  stream.destroy();
  return promise;
}

function closeForward(stream: ForwardedChannel): Promise<void> | undefined {
  if (!stream.incoming || !stream.close) return destroyLocal(stream);
  // ssh2 stops emitting CHANNEL_DATA at close(). Cut off writes before destroy()
  // ends the Node writable; the peer owns the remaining CLOSE handshake.
  if (stream.incoming.state !== "closed") {
    stream.close();
    stream.destroy();
  }
  stream.resume();
}

// One admitted channel owns one slot through head parsing, raw work, and local teardown.
// The hostname registry exists for revocation, not as a separate admission budget.
function managedLease(
  stream: ForwardedChannel, flows: Set<ManagedFlow>, options: ManagedOptions,
  connectTimeoutMs: number, detach: () => void, release: () => void,
) {
  let abort: AbortController | undefined;
  let flow: ManagedFlow | undefined;
  let remote: Duplex | undefined;
  let pending: Promise<void> | undefined;
  let done: Promise<void> | undefined;

  function stop(): Promise<void> {
    if (done) return done;
    const { promise, resolve } = Promise.withResolvers<void>();
    done = promise;
    detach();
    const channelClosed = closeForward(stream);
    const upstreamClosed = remote && destroyLocal(remote);
    abort?.abort();
    void Promise.all([channelClosed, upstreamClosed, pending]).then(() => {
      if (flow) flows.delete(flow);
      release();
      resolve();
    });
    return done;
  }

  function track<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = (abort ??= new AbortController()).signal;
    const result = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return work(signal);
    });
    // A response timeout does not end the raw obligation or free its admission slot.
    pending = result.then(() => {}, () => {});
    return withTimeout(result, connectTimeoutMs);
  }

  return {
    stop,
    get stopped() { return done !== undefined; },
    cancel() { abort?.abort(); },
    watch(host: string) {
      flow = { host, revoke: stop };
      flows.add(flow);
    },
    resolve(host: string) {
      return track((signal) => options.resolve(host, signal));
    },
    dial(address: string) {
      return track(async (signal) => {
        const socket = await options.dial(address, 443, signal);
        socket.on("error", () => {});
        if (signal.aborted) {
          await destroyLocal(socket);
          signal.throwIfAborted();
        }
        return (remote = socket);
      });
    },
  };
}

// Handles one forwarded channel. Nothing here opens a socket for others to connect to (plan door 4).
function channelHandler(options: ManagedOptions, allows: (host: string) => boolean, flows?: Set<ManagedFlow>) {
  const headTimeoutMs = options.headTimeoutMs ?? DEFAULTS.headTimeoutMs;
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULTS.connectTimeoutMs;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULTS.idleTimeoutMs;
  const relayCap = options.relayCap ?? DEFAULTS.relayCap;
  let open = 0;

  const handle = (stream: ForwardedChannel) => {
    let head = Buffer.alloc(0);
    let closed = false;
    // A channel holds a slot from its first byte, so slow heads count against the cap too.
    let holdsSlot = open < relayCap;
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
      if (!closed && stream.incoming?.state !== "closed") return false;
      stream.resume();
      return true;
    };
    let refusalTimer: ReturnType<typeof setTimeout> | undefined;
    let detachRelay: (() => void) | undefined;
    let onRelayClose: (() => void) | undefined;
    const managed = holdsSlot && flows ? managedLease(stream, flows, options, connectTimeoutMs, () => {
      clearTimeout(headTimer);
      clearTimeout(refusalTimer);
      stream.off("data", onData);
      stream.off("close", onClose);
      detachRelay?.();
      detachRelay = onRelayClose = undefined;
    }, release) : undefined;
    function closeRefusal() {
      if (managed) void managed.stop();
      else stream.destroy();
    }
    const refuse = (status: number, host?: string) => {
      if (!managed) release();
      if (gone()) {
        if (managed) void managed.stop();
        return;
      }
      options.log?.({ status, host });
      if (managed?.stopped) return;
      // A peer that grants no send window never takes the refusal: the channel is closed anyway
      // once the deadline passes, and what the peer still sends is discarded, not kept.
      refusalTimer = setTimeout(closeRefusal, headTimeoutMs);
      stream.resume();
      stream.end(refusal(status), closeRefusal);
    };
    const headTimer = setTimeout(() => {
      stream.off("data", onData);
      refuse(408);
    }, headTimeoutMs);

    stream.on("error", () => {});
    stream.once("close", onClose);
    function onClose() {
      closed = true;
      clearTimeout(headTimer);
      clearTimeout(refusalTimer);
      if (onRelayClose) onRelayClose();
      else if (managed) void managed.stop();
      else release();
    }
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
      const legacyAbort = managed ? undefined : new AbortController();
      managed?.watch(host);
      try {
        const addresses = await (managed
          ? managed.resolve(host)
          : withTimeout(options.resolve(host, legacyAbort!.signal), connectTimeoutMs));
        if (managed?.stopped) return;
        if (gone()) {
          if (managed) return void managed.stop();
          return release();
        }
        if (addresses.length === 0) return refuse(502, host);
        const interfaces = options.interfaces?.();
        if (managed?.stopped) return;
        const address = addresses.find((a) => !isRefusedAddress(a, interfaces));
        if (address === undefined) return refuse(403, host);
        // Dial the address that was checked, never the name: a second lookup could answer differently.
        remote = managed
          ? await managed.dial(address)
          : await withTimeout(options.dial(address, 443, legacyAbort!.signal), connectTimeoutMs, (late) => late.destroy());
      } catch (err) {
        // A dial that timed out is still connecting: stop it, or its socket outlives the slot.
        if (managed) managed.cancel();
        else legacyAbort!.abort();
        if (!managed?.stopped) return refuse(err === TIMEOUT ? 504 : 502, host);
        return;
      }
      if (managed?.stopped) return;
      if (gone()) {
        if (managed) return void managed.stop();
        release();
        return remote.destroy();
      }
      if (managed && remote.destroyed) return refuse(502, host);
      options.log?.({ status: 200, host });
      if (managed?.stopped) return;

      // Closes the channel from this side. Its slot is freed here and not on 'close': ssh2 reports a
      // channel's close only once the peer has answered and the channel has been read to its end.
      const drop = () => {
        if (managed) return void managed.stop();
        release();
        stream.destroy();
      };
      const idleTimer = setTimeout(() => {
        drop();
        if (!managed) remote.destroy();
      }, idleTimeoutMs);
      const touch = () => idleTimer.refresh();
      // When one side is gone the other is ended, not destroyed: bytes already accepted for it may
      // still be queued (an SSH channel waits for window) and are delivered first. What it still
      // sends has nowhere to go and is read and discarded, so its own close is seen. From then on
      // nothing refreshes the idle timer, so it bounds the flush.
      let flushing = false;
      let finishing: Duplex | undefined;
      const stopFlushing = () => { if (managed) void managed.stop(); };
      const flush = (to: Duplex, from: Duplex) => {
        if (managed) {
          if (managed.stopped) return;
          // Both sides may close without a 'finish' on a blocked ssh2 writable.
          if (flushing || to.destroyed || (to === stream && gone())) return void managed.stop();
          flushing = true;
        }
        stream.off("data", touch);
        remote.off("data", touch);
        to.unpipe(from);
        to.resume();
        if (managed) {
          if (to.writableFinished) return void managed.stop();
          finishing = to;
          to.once("finish", stopFlushing);
          to.end();
          return;
        }
        const shut = () => {
          if (to === stream) drop();
          else to.destroy();
        };
        if (to.destroyed) return clearTimeout(idleTimer);
        to.once("close", () => clearTimeout(idleTimer));
        if (to.writableFinished) return shut();
        to.once("finish", shut);
        to.end();
      };
      const onRemoteClose = () => flush(stream, remote);
      const onStreamClose = () => flush(remote, stream);
      if (managed) {
        onRelayClose = onStreamClose;
        detachRelay = () => {
          clearTimeout(idleTimer);
          finishing?.off("finish", stopFlushing);
          remote.off("close", onRemoteClose);
          stream.off("data", touch);
          remote.off("data", touch);
          stream.unpipe(remote);
          remote.unpipe(stream);
        };
      } else {
        remote.on("error", () => {});
        stream.once("close", onStreamClose);
      }
      remote.once("close", onRemoteClose);
      stream.on("data", touch);
      remote.on("data", touch);

      stream.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (managed?.stopped) return;
      if (rest.length > 0) remote.write(rest);
      if (managed?.stopped) return;
      stream.pipe(remote);
      if (!managed?.stopped) remote.pipe(stream);
    }
  };
  return handle;
}
