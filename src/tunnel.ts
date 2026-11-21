import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { Client } from "ssh2";
import type { Config } from "./config";
import { DEFAULTS } from "./defaults";
import type { Log } from "./log";
import { writeState, type State, type TunnelState } from "./state";

export type ConnectFailure = "host_key_mismatch" | "auth_failed" | "unreachable";

export class ConnectError extends Error {
  constructor(
    readonly kind: ConnectFailure,
    detail: string,
  ) {
    super(detail);
  }
}

export interface SshTarget {
  host: string;
  port: number;
  user: string;
  hostKey: string;
  key: Buffer;
}

export interface ConnectOptions {
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  readyTimeoutMs?: number;
  onBanner?: (text: string) => void;
}

// OpenSSH-style fingerprint of a raw host key blob (plan door 8).
export function fingerprint(hostKey: Buffer): string {
  return "SHA256:" + createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
}

// The one way this program opens an SSH connection; `run` and `doctor` both go through it, so the
// host key is pinned on every path. A key that does not match ends the handshake before any
// authentication request is sent.
export function connectSsh(target: SshTarget, options: ConnectOptions = {}): Promise<Client> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let mismatch = false;
    let settled = false;
    const failed = (err?: Error & { level?: string }) => {
      if (settled) return;
      settled = true;
      client.destroy();
      const kind = mismatch
        ? "host_key_mismatch"
        : err?.level === "client-authentication"
          ? "auth_failed"
          : "unreachable";
      reject(new ConnectError(kind, err?.message ?? "connection closed"));
    };
    client.on("error", failed);
    client.once("close", () => failed());
    client.on("banner", (text) => options.onBanner?.(text));
    client.once("ready", () => {
      settled = true;
      resolve(client);
    });
    try {
      client.connect({
        host: target.host,
        port: target.port,
        username: target.user,
        privateKey: target.key,
        hostVerifier: (key: Buffer) => {
          mismatch = fingerprint(key) !== target.hostKey;
          return !mismatch;
        },
        keepaliveInterval: options.keepaliveIntervalMs ?? DEFAULTS.keepaliveIntervalMs,
        keepaliveCountMax: options.keepaliveCountMax ?? DEFAULTS.keepaliveCountMax,
        readyTimeout: options.readyTimeoutMs ?? DEFAULTS.connectTimeoutMs,
      });
    } catch {
      // ssh2 throws when it cannot use the key. Its message is dropped: nothing about the key is echoed.
      settled = true;
      reject(new ConnectError("auth_failed", "the SSH client could not use the private key"));
    }
  });
}

export function retryDelay(failures: number, backoffMs: readonly number[] = DEFAULTS.backoffMs): number {
  return backoffMs[Math.min(failures, backoffMs.length - 1)]!;
}

export interface TunnelOptions extends ConnectOptions {
  config: Config;
  key: Buffer;
  statePath: string;
  // Receives each forwarded channel that names the expected forward.
  handle: (stream: Duplex) => void;
  log?: Log;
  onState?: (state: State) => void;
  // Retry timer; returns a cancel function. Tests replace it to read the delay.
  schedule?: (fn: () => void, ms: number) => () => void;
  heartbeatMs?: number;
  backoffMs?: readonly number[];
  blockedRetryMs?: number;
}

export interface Tunnel {
  stop: () => Promise<void>;
  // Settles when the tunnel has ended for good: stopped, or blocked by a host key mismatch.
  done: Promise<{ state: TunnelState; reason: string | null }>;
}

// Holds the reverse forward open, reconnecting with backoff, and records every state change.
export function startTunnel(options: TunnelOptions): Tunnel {
  const { config, log } = options;
  const { remotePort } = config;
  const schedule =
    options.schedule ??
    ((fn, ms) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });

  let current: State;
  let client: Client | undefined;
  let failures = 0;
  let attempts = 0;
  let stopping = false;
  let cancelRetry = () => {};
  let finish!: (end: { state: TunnelState; reason: string | null }) => void;
  const done = new Promise<{ state: TunnelState; reason: string | null }>((resolve) => (finish = resolve));

  const persist = () => {
    try {
      writeState(options.statePath, current);
    } catch {
      log?.("could not write the state file");
    }
  };
  const set = (state: TunnelState, reason: string | null = null, retryInMs?: number) => {
    const now = Date.now();
    const stamp = new Date(now).toISOString();
    current = {
      version: 1,
      pid: process.pid,
      state,
      reason,
      since: stamp,
      retryAt: retryInMs === undefined ? null : new Date(now + retryInMs).toISOString(),
      server: { host: config.server.host, port: config.server.port },
      remotePort,
      updatedAt: stamp,
    };
    persist();
    log?.("tunnel state", { state, reason, retryAt: current.retryAt });
    options.onState?.(current);
  };
  const heartbeat = setInterval(() => {
    current = { ...current, updatedAt: new Date().toISOString() };
    persist();
  }, options.heartbeatMs ?? DEFAULTS.heartbeatMs);
  const end = () => {
    clearInterval(heartbeat);
    finish({ state: current.state, reason: current.reason });
  };

  // `blocked` stays the visible state while the forward is retried, so `status` keeps answering
  // "port blocked" instead of flapping.
  const retry = (state: TunnelState, reason: string, ms: number) => {
    set(state, reason, ms);
    cancelRetry = schedule(() => void attempt(state === "blocked"), ms);
  };

  async function attempt(quiet: boolean) {
    if (stopping) return;
    if (!quiet) set(attempts === 0 ? "connecting" : "reconnecting");
    attempts++;

    let c: Client;
    try {
      c = await connectSsh(
        { ...config.server, key: options.key },
        { ...options, onBanner: (text) => log?.("server banner", { text }) },
      );
    } catch (err) {
      if (stopping) return;
      const kind = err instanceof ConnectError ? err.kind : "unreachable";
      log?.("connection failed", { reason: kind, detail: err instanceof Error ? err.message : undefined });
      if (kind === "host_key_mismatch") {
        // Never retried: a changed host key needs a person to look at it.
        set("blocked", "host_key_mismatch");
        return end();
      }
      return retry("disconnected", kind === "auth_failed" ? "auth_failed" : "connection_lost", retryDelay(failures++, options.backoffMs));
    }
    if (stopping) return void c.end();
    client = c;

    c.on("tcp connection", (info, accept, reject) => {
      // Only the forward this tunnel asked for may reach the proxy (criterion 48).
      if (info.destIP !== "127.0.0.1" || info.destPort !== remotePort) {
        log?.("rejected a forwarded connection for an unexpected address");
        return reject();
      }
      options.handle(accept());
    });
    c.once("close", () => {
      if (client !== c) return;
      client = undefined;
      if (!stopping) retry("disconnected", "connection_lost", retryDelay(failures++, options.backoffMs));
    });
    c.forwardIn("127.0.0.1", remotePort, (err) => {
      if (client !== c) return;
      if (err) {
        client = undefined;
        c.end();
        return retry("blocked", "port_blocked", options.blockedRetryMs ?? DEFAULTS.blockedRetryMs);
      }
      failures = 0;
      set("connected");
    });
  }

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    cancelRetry();
    const c = client;
    client = undefined;
    if (c) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 2000);
        const cancelled = () => {
          clearTimeout(timer);
          resolve();
        };
        try {
          c.unforwardIn("127.0.0.1", remotePort, cancelled);
        } catch {
          cancelled();
        }
      });
      c.end();
    }
    set("stopped");
    end();
  };

  void attempt(false);
  return { stop, done };
}
