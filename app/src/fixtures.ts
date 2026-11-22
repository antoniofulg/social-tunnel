// Fixture snapshots for tests: one per Settings state. Shapes follow driver.rs and status.rs.
import type { Doctor, Hop, Snapshot } from "./types";

export const CONFIG_PATH = "/Users/me/Library/Application Support/social-tunnel/config.json";
export const KEY_PATH = "/Users/me/.ssh/social_tunnel";
export const FINGERPRINT = `SHA256:${"Jq4vT0x9mYb2Rk7LwPz3Ue8NcHs5AdG1FoXi6VtKyM0".slice(0, 43)}`;
export const DOMAINS = ["instagram.com", "facebook.com", "threads.net", "linkedin.com", "tiktok.com"];
/** A marker that must never reach the screen (a stand-in for key file content). */
export const KEY_BODY_MARKER = "b3BlbnNzaC1rZXktdjEAAAAA-FIXTURE-KEY-BODY";

export const FIX_PORT = 'Free port 8888 on the server and allow it for the tunnel key: permitlisten="127.0.0.1:8888".';
export const FIX_KEY =
  "Do not connect until you know why. Compare the server's fingerprint over a channel you trust, then update server.hostKey only if the server was really re-keyed.";

const ORDER = ["config", "key", "server_reachable", "ssh_auth", "forward", "lockdown", "egress"] as const;
const OK_DETAIL: Record<string, string> = {
  config: "config loaded",
  key: "key file is readable and private",
  server_reachable: "vps.example.com:22 accepts connections",
  ssh_auth: "signed in as sotunnel; host key matches",
  forward: "the server opened 127.0.0.1:8888",
  lockdown: "the tunnel user can only forward",
  egress: "instagram.com:443 is reachable from this computer",
  domain: "instagram.com is on the allowlist",
};

/** Doctor's hops: ok up to `failAt`, the failure itself, then skipped, as `runDoctor` reports them. */
export function doctor(opts: { failAt?: string; exit?: number; detail?: string; fix?: string; withDomain?: boolean; startedAt?: number } = {}): Doctor {
  const ids: string[] = [...ORDER];
  if (opts.withDomain) ids.splice(1, 0, "domain");
  const failIndex = opts.failAt ? ids.indexOf(opts.failAt) : -1;
  const hops: Hop[] = ids.map((hop, i) => {
    if (failIndex === -1 || i < failIndex) return { hop, ok: true, skipped: false, detail: OK_DETAIL[hop], fix: "" };
    if (i === failIndex) return { hop, ok: false, skipped: false, detail: opts.detail ?? "it failed", fix: opts.fix ?? "" };
    return { hop, ok: false, skipped: true, detail: "skipped", fix: "" };
  });
  return { exit: opts.exit ?? 0, hops, startedAt: opts.startedAt ?? 1_790_000_000_000 };
}

export function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    trayState: "connected",
    title: "Connected",
    rows: ["Connected"],
    statusUnreadable: false,
    status: {
      exit: 0,
      state: "connected",
      reason: null,
      pid: 4127,
      retryAt: null,
      server: { host: "vps.example.com", port: 22, user: "sotunnel", hostKey: FINGERPRINT },
      remotePort: 8888,
      domains: DOMAINS.length,
      allowlist: DOMAINS,
      keyPath: KEY_PATH,
      configPath: CONFIG_PATH,
    },
    configPath: CONFIG_PATH,
    doctor: doctor(),
    ownership: "owned",
    openAtLogin: false,
    reduceTransparency: false,
    ...overrides,
  };
}

export const unreadable = (): Snapshot =>
  snapshot({ trayState: "disconnected", title: "Disconnected", statusUnreadable: true, status: null, configPath: null, doctor: null, ownership: null });

export const notSetUp = (): Snapshot =>
  snapshot({ trayState: "notSetUp", title: "Not set up", status: null, doctor: null, ownership: null });

export const portRefused = (): Snapshot =>
  snapshot({ trayState: "blocked", doctor: doctor({ failAt: "forward", exit: 11, detail: "the server refused a remote forward on 127.0.0.1:8888", fix: FIX_PORT }) });

export const keyChanged = (): Snapshot =>
  snapshot({
    trayState: "blocked",
    doctor: doctor({ failAt: "ssh_auth", exit: 13, detail: "the server's host key does not match the one saved in the config", fix: FIX_KEY }),
  });
