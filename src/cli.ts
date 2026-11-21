#!/usr/bin/env bun
import { lookup } from "node:dns/promises";
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import pkg from "../package.json" with { type: "json" };
import { loadConfig, loadKey, resolveConfigPath } from "./config";
import { DEFAULTS, EXIT } from "./defaults";
import { runDoctor } from "./doctor";
import { createLogger, sanitize } from "./log";
import { createProxy, type Dialer, type Resolver } from "./proxy";
import { pidAlive, readState, statePath } from "./state";
import { evaluateStatus, isLiveRun } from "./status";
import { startTunnel } from "./tunnel";

// Everything the CLI touches outside its own process. Tests replace entries; production uses REAL_IO.
export interface Io {
  env: Record<string, string | undefined>;
  platform: string;
  homedir: () => string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readFile: (path: string) => Buffer;
  stat: (path: string) => { mode: number };
  resolve: Resolver;
  dial: Dialer;
  onSignal: (stop: () => void) => void;
  // Tests shorten doctor's network timeout; production leaves it at the default.
  connectTimeoutMs?: number;
}

const USAGE = `usage: social-tunnel <command> [options]

commands:
  run       hold the tunnel open until SIGINT or SIGTERM
  status    report the tunnel state
  doctor    check every hop and name the broken one

options:
  --config <path>   config file (default: $SOCIAL_TUNNEL_CONFIG, then the platform config dir)
  --json            print one JSON object on stdout
  --domain <host>   doctor only: also check that <host> is on the allowlist
  --help, --version
`;

const VERBS = ["run", "status", "doctor"] as const;
type Verb = (typeof VERBS)[number];

interface Args {
  verb: Verb;
  json: boolean;
  config?: string;
  domain?: string;
}

// Returns the parsed arguments, or "help" / "version", or null for anything unknown.
function parseArgs(argv: string[]): Args | "help" | "version" | null {
  let verb: Verb | undefined;
  let json = false;
  let config: string | undefined;
  let domain: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--version") return "version";
    if (arg === "--json") json = true;
    else if (arg === "--config" || arg === "--domain") {
      const value = argv[++i];
      // An empty value is what an unset shell variable leaves behind; never fall back to another config.
      if (value === undefined || value === "") return null;
      if (arg === "--config") config = value;
      else domain = value;
    } else if (!verb && (VERBS as readonly string[]).includes(arg)) verb = arg as Verb;
    else return null;
  }
  if (!verb || (domain !== undefined && verb !== "doctor")) return null;
  return { verb, json, config, domain };
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

  const print = (value: unknown) => io.stdout(JSON.stringify(value) + "\n");
  const fail = (exit: number, code: string, message: string, field?: string): number => {
    if (args.json) print({ ok: false, command: args.verb, error: { code, message, field } });
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

    const loaded = loadConfig(configPath, io.readFile, io.homedir);
    if (!loaded.ok) return fail(EXIT.usage, "config_invalid", loaded.message, loaded.field);
    const config = loaded.config;

    if (args.verb === "status") {
      const view = evaluateStatus(readState(statePath(configPath)), pidAlive, Date.now(), DEFAULTS.staleMs, config);
      const { exit, ...fields } = view;
      const server = { host: config.server.host, port: config.server.port };
      if (args.json) {
        print({
          ok: exit === EXIT.ok,
          command: "status",
          configPath,
          ...fields,
          server,
          remotePort: config.remotePort,
          domains: config.domains.length,
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

    const log = createLogger(io.stderr, args.json);
    const tunnel = startTunnel({
      config,
      key: key.key,
      statePath: statePath(configPath),
      handle: createProxy({
        domains: config.domains,
        resolve: io.resolve,
        dial: io.dial,
        log: (entry) => log("proxy request", entry),
      }).handle,
      log,
    });
    io.onSignal(() => void tunnel.stop());
    const end = await tunnel.done;
    const exit = end.reason === "host_key_mismatch" ? EXIT.hostKeyMismatch : EXIT.ok;
    if (args.json) print({ ok: exit === EXIT.ok, command: "run", state: end.state, reason: end.reason });
    return exit;
  } catch (err) {
    return fail(EXIT.internal, "internal", err instanceof Error ? err.message : "unexpected error");
  }
}

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
    dial: (address, port) =>
      new Promise((resolve, reject) => {
        const socket = net.connect({ host: address, port });
        socket.once("error", reject);
        socket.once("connect", () => resolve(socket));
      }),
    onSignal: (stop) => {
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    },
  });
  // Flush stdout before leaving: an agent reads the JSON object from a pipe.
  process.stdout.write("", () => process.exit(code));
}
