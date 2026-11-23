#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, loadKey, resolveConfigPath } from "./config";
import { DEFAULTS, EXIT } from "./defaults";
import { runDoctor } from "./doctor";
import { domainAction, type DomainAction } from "./domain-cli";
import { captureDomainSelection, managedKeyFingerprint, readDomainEnrollment, readDomainRole } from "./domain-enrollment";
import { dialManagedAddress, resolveManagedHost } from "./domain-network";
import { createManagedRun, readActiveHome, SETUP_REQUIRED, UNKNOWN_DOMAINS } from "./domain-runtime";
import { domainDigest, domainRoleClient } from "./domain-wire";
import { createLogger, sanitize } from "./log";
import { createProxy, type Dialer, type Resolver } from "./proxy";
import { claimRun, lockPath, pidAlive, readState, refreshRun, releaseRun, statePath } from "./state";
import { evaluateStatus, isLiveRun } from "./status";
import { startTunnel } from "./tunnel";

// Everything the CLI touches outside its own process. Tests replace entries; production uses REAL_IO.
export interface Io {
  env: Record<string, string | undefined>;
  platform: string;
  homedir: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string | number) => Buffer;
  stat: (path: string) => { mode: number };
  resolve: Resolver;
  dial: Dialer;
  onSignal: (stop: () => void) => void;
  // Tests shorten doctor's network timeout; production leaves it at the default.
  connectTimeoutMs?: number;
  // Tests shorten run's heartbeat and the stale threshold; production leaves them at the defaults.
  heartbeatMs?: number;
  staleMs?: number;
  managedResolve?: (host: string, signal: AbortSignal) => Promise<string[]>;
  managedDial?: Dialer;
  managedPollMs?: number;
}

const USAGE = `usage: social-tunnel <command> [options]

commands:
  run       hold the tunnel open until SIGINT or SIGTERM
  status    report the tunnel state
  doctor    check every hop and name the broken one
  domains list | add <host> | remove <host> | retry <operation-id>

options:
  --config <path>   config file (default: $SOCIAL_TUNNEL_CONFIG, then the platform config dir)
  --json            print one JSON object on stdout
  --domain <host>   doctor only: also check that <host> is on the allowlist
  --expected-revision <uint>  required for domains add/remove
  Native sidecar only: status --json --tray-scope; domains --json --expected-enrollment <scope>.
  A changed enrollment refuses the scoped command with conflict (exit 10).
  --help, --version
`;

const VERBS = ["run", "status", "doctor", "domains"] as const;
type Verb = (typeof VERBS)[number];

interface Args {
  verb: Verb;
  json: boolean;
  config?: string;
  domain?: string;
  trayScope?: boolean;
  expectedEnrollment?: string;
  action?: DomainAction;
}

// Returns the parsed arguments, or "help" / "version", or null for anything unknown.
function parseArgs(argv: string[]): Args | "help" | "version" | null {
  let verb: Verb | undefined;
  let json = false;
  let config: string | undefined;
  let domain: string | undefined;
  const operands: string[] = [];
  let expected: string | undefined;
  let trayScope = false;
  let expectedEnrollment: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--version") return "version";
    if (arg === "--json") json = true;
    else if (arg === "--tray-scope" && !trayScope) trayScope = true;
    else if (arg === "--config" || arg === "--domain" || arg === "--expected-revision" || arg === "--expected-enrollment") {
      const value = argv[++i];
      // An empty value is what an unset shell variable leaves behind; never fall back to another config.
      if (value === undefined || value === "") return null;
      if (arg === "--config") config = value;
      else if (arg === "--domain") domain = value;
      else if (arg === "--expected-enrollment") {
        if (expectedEnrollment !== undefined || !domainDigest(value)) return null;
        expectedEnrollment = value;
      } else if (expected === undefined) expected = value;
      else return null;
    } else if (!verb && (VERBS as readonly string[]).includes(arg)) verb = arg as Verb;
    else if (verb === "domains" && !arg.startsWith("-") && operands.length < 2) operands.push(arg);
    else return null;
  }
  if (!verb || (domain !== undefined && verb !== "doctor") ||
      (trayScope && (!json || verb !== "status")) ||
      (expectedEnrollment !== undefined && (!json || verb !== "domains"))) return null;
  if (verb !== "domains") return expected === undefined ? { verb, json, config, domain, trayScope } : null;
  const [kind, subject] = operands;
  let action: DomainAction;
  if (kind === "list" && subject === undefined && expected === undefined) action = { kind };
  else if (kind === "retry" && subject && expected === undefined) action = { kind, id: subject };
  else if ((kind === "add" || kind === "remove") && subject) action = { kind, host: subject, expected };
  else return null;
  return { verb, json, config, action, expectedEnrollment };
}

export async function main(argv: string[], io: Io): Promise<number> {
  const args = parseArgs(argv);
  if (args === "help") {
    io.stdout(USAGE);
    return EXIT.ok;
  }
  if (args === "version") {
    io.stdout(`${pkg.version}\n`);
    return EXIT.ok;
  }
  if (!args) {
    io.stderr(USAGE);
    return EXIT.usage;
  }

  // File-supplied text (config keys and entries, state.json fields, paths) reaches the agent or app
  // that parses the object: string values get the same stripping as text output.
  const print = (value: unknown) =>
    io.stdout(JSON.stringify(value, (_key, v) => (typeof v === "string" ? sanitize(v) : v)) + "\n");
  const fail = (exit: number, code: string, message: string, field?: string, configPath?: string): number => {
    if (args.json) print({ ok: false, command: args.verb, configPath, error: { code, message, field } });
    else io.stderr(`error: ${sanitize(message)}\n`);
    return exit;
  };

  try {
    const configPath = resolveConfigPath(args.config, io.env, io.platform, io.homedir);

    if (args.verb === "doctor") {
      const { hops, exit } = await runDoctor(configPath, args.domain, io);
      if (args.json) print({ ok: exit === EXIT.ok, command: "doctor", configPath, hops });
      else {
        for (const h of hops) {
          const mark = h.skipped ? "skip" : h.ok ? "ok  " : "FAIL";
          io.stdout(`${mark} ${h.hop}: ${sanitize(h.detail)}\n`);
          if (h.fix) io.stdout(`     fix: ${sanitize(h.fix)}\n`);
        }
      }
      return exit;
    }

    const selection = args.trayScope || args.action ? captureDomainSelection(configPath, io.homedir) : null;
    if (args.expectedEnrollment !== undefined &&
        (!selection || selection.token !== args.expectedEnrollment || (args.action?.kind !== "list" && !selection.enrollment))) {
      return fail(EXIT.down, "conflict", "The selected managed enrollment changed.");
    }
    if (args.action) {
      const config = selection?.loaded.config;
      const enrollment = selection?.enrollment;
      const editor = config && enrollment ? readDomainRole(enrollment, config, "editor") : null;
      try {
        const client = editor && domainRoleClient("editor", editor, io.connectTimeoutMs, selection?.current);
        const result = await domainAction(args.action, enrollment, client, () => {
          if (!config || !enrollment) return null;
          const s = evaluateStatus(readState(statePath(configPath)), pidAlive, Date.now(), io.staleMs, config);
          return s.state === "connected" ? readActiveHome(enrollment, s.pid) : null;
        }, selection?.current);
        if (!result.ok) {
          if (args.json) print({ ok: false, command: "domains", error: result.error });
          else io.stderr(`error: ${result.error.message}\n`);
          return result.exit;
        }
        if (args.json) print({ ok: true, command: "domains", ...result.view });
        else {
          const { state, active, queueBase } = result.view;
          io.stdout([state, ...(queueBase
            ? [`Configured revision ${queueBase.revision} (routing not confirmed)`, ...queueBase.domains]
            : active?.domains ?? [])].join("\n") + "\n");
        }
        return EXIT.ok;
      } finally { editor?.key.fill(0); }
    }
    // The path it resolved tells a tray app "not set up" (no file there) from a broken config.
    const loaded = selection?.loaded ?? loadConfig(configPath, io.readFile, io.homedir);
    if (!loaded.ok) return fail(EXIT.usage, "config_invalid", loaded.message, loaded.field, configPath);
    const config = loaded.config;
    const enrollment = selection ? selection.enrollment : readDomainEnrollment(configPath, config);

    if (args.verb === "status") {
      const view = evaluateStatus(readState(statePath(configPath)), pidAlive, Date.now(), DEFAULTS.staleMs, config);
      const { exit, ...fields } = view;
      const server = { host: config.server.host, port: config.server.port };
      if (args.json) {
        // user, hostKey, keyPath and allowlist are additive for the tray app (tray-app door 1);
        // the key path is shown, never the key.
        const active = enrollment && view.state === "connected" ? readActiveHome(enrollment, view.pid) : null;
        const managed = enrollment === undefined ? {} : { managedDomains:
          !enrollment ? SETUP_REQUIRED : active ? { state: "ready", active, pending: null } : UNKNOWN_DOMAINS,
        };
        print({
          ok: exit === EXIT.ok,
          command: "status",
          configPath,
          ...fields,
          server: { ...server, user: config.server.user, hostKey: config.server.hostKey },
          remotePort: config.remotePort,
          domains: config.domains.length,
          keyPath: config.keyPath,
          allowlist: config.domains,
          ...(args.trayScope && selection?.current() ? { trayEnrollment: selection.token } : {}),
          ...managed,
        });
      } else {
        io.stdout(
          `state: ${view.state}${view.reason ? ` (${sanitize(view.reason)})` : ""}\n` +
            (view.since ? `since: ${sanitize(view.since)}\n` : "") +
            (view.retryAt ? `retry at: ${sanitize(view.retryAt)}\n` : "") +
            `server: ${server.host}:${server.port}\n` +
            `remote port: ${config.remotePort}\n` +
            `domains: ${config.domains.length}\n`,
        );
      }
      return exit;
    }

    // A state that stopped being refreshed belongs to a dead run whose pid may have been reused.
    const prior = readState(statePath(configPath));
    if (prior && prior.pid !== process.pid && isLiveRun(prior, pidAlive, Date.now())) {
      // Also when that run serves another config in this directory: both would write one state.json.
      return fail(
        EXIT.usage,
        "already_running",
        `social-tunnel run (pid ${prior.pid}) already owns ${statePath(configPath)}; one run per config directory`,
      );
    }
    const key = loadKey(config.keyPath, io, io.platform);
    if (!key.ok) return fail(EXIT.usage, key.code, key.message);
    if (enrollment === null || (enrollment && managedKeyFingerprint(key.key) !== enrollment.tunnelKey)) {
      return fail(EXIT.usage, "not_ready", "managed enrollment does not match this tunnel");
    }

    // The state.json check above cannot see a run that started a moment ago and has not written yet.
    const lock = lockPath(configPath);
    // A running holder refreshes its lock on every heartbeat, so only a dead pid or a lock left
    // unrefreshed past the stale threshold is taken over; state.json plays no part (criterion 93).
    const staleMs = io.staleMs ?? DEFAULTS.staleMs;
    // A lock is published only once its pid is written, so pid 0 (empty or corrupt) names no run.
    const holder = claimRun(lock, (pid, ageMs) => pid > 0 && pidAlive(pid) && ageMs <= staleMs);
    if (holder !== null) {
      return fail(
        EXIT.usage,
        "already_running",
        `social-tunnel run (pid ${holder}) already owns ${lock}; one run per config directory`,
      );
    }
    let managedRun: ReturnType<typeof createManagedRun> | undefined;
    let roleKey: Buffer | undefined;
    try {
      const log = createLogger(io.stderr, args.json);
      if (enrollment) {
        const target = readDomainRole(enrollment, config, "proxy");
        if (!target) return fail(EXIT.usage, "not_ready", "managed proxy credential is unavailable");
        roleKey = target.key;
        try {
          managedRun = createManagedRun({ enrollment, client: domainRoleClient("proxy", target, io.connectTimeoutMs),
            resolve: io.managedResolve ?? resolveManagedHost, dial: io.managedDial ?? dialManagedAddress, pollMs: io.managedPollMs });
        } catch { return fail(EXIT.usage, "not_ready", "managed runtime cannot safely resume its journal"); }
      }
      const tunnel = startTunnel({
        config,
        key: key.key,
        statePath: statePath(configPath),
        handle: managedRun?.handle ?? createProxy({
          domains: config.domains,
          resolve: io.resolve,
          dial: io.dial,
          log: (entry) => log("proxy request", entry),
        }).handle,
        log,
        heartbeatMs: io.heartbeatMs,
        onState: managedRun && (({ state }) => managedRun?.onState(state)),
        onHeartbeat: () => refreshRun(lock),
      });
      io.onSignal(() => void tunnel.stop());
      const end = await tunnel.done;
      const exit = end.reason === "host_key_mismatch" ? EXIT.hostKeyMismatch : EXIT.ok;
      if (args.json) print({ ok: exit === EXIT.ok, command: "run", state: end.state, reason: end.reason });
      return exit;
    } finally {
      await managedRun?.stop();
      roleKey?.fill(0);
      releaseRun(lock);
    }
  } catch (err) {
    return fail(EXIT.internal, "internal", err instanceof Error ? err.message : "unexpected error");
  }
}

// The production dialer. A dial the caller gives up on closes its socket instead of leaving it
// connecting until the operating system's own timeout.
export const dial: Dialer = (address, port, signal) =>
  new Promise((resolve, reject) => {
    const socket = net.connect({ host: address, port });
    const giveUp = () => {
      socket.destroy();
      reject(new Error("dial abandoned"));
    };
    signal?.addEventListener("abort", giveUp, { once: true });
    socket.once("error", reject);
    socket.once("connect", () => {
      signal?.removeEventListener("abort", giveUp);
      resolve(socket);
    });
  });

if (import.meta.main) {
  const code = await main(process.argv.slice(2), {
    env: process.env,
    platform: process.platform,
    homedir: os.homedir,
    stdout: (text) => void process.stdout.write(text),
    stderr: (text) => void process.stderr.write(text),
    readFile: (path) => readFileSync(path),
    stat: (path) => statSync(path),
    resolve: async (host) => (await lookup(host, { all: true })).map((answer) => answer.address),
    dial,
    onSignal: (stop) => {
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  });
  // Flush stdout before leaving: an agent reads the JSON object from a pipe.
  process.stdout.write("", () => process.exit(code));
}
