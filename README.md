# social-tunnel

Let AI agents on a server reach social platforms through your home internet.

Instagram, Facebook, Threads, LinkedIn and TikTok often block or challenge logins from datacenter IPs, so an AI agent driving a browser on a VPS cannot use those accounts. `social-tunnel` routes **only the domains you choose** from the server's browser through a computer at home, over an SSH reverse tunnel. Everything else keeps going out directly from the server.

```
 VPS                                              home computer
 ┌───────────────────────────────┐                ┌──────────────────────────────────┐
 │ agent's Chrome                │                │ social-tunnel run                │
 │   PAC: chosen domains ──┐     │   SSH reverse  │   allowlist proxy (in-process)   │
 │   everything else       │     │     tunnel     │     only chosen domains, :443    │──▶ internet,
 │   goes direct           ▼     │ ◀═════════════ │     never the home network       │    home IP
 │            127.0.0.1:8888 ────┼───────────────▶│                                  │
 └───────────────────────────────┘                └──────────────────────────────────┘
```

## How it works

There is **one program, and it runs only on your home computer**. The server needs no social-tunnel code: it already has `sshd`, and it only needs a locked-down SSH user, one `sshd` rule and a Chrome policy.

1. On the home computer, `social-tunnel run` opens an SSH connection to the server as a dedicated tunnel user and asks the server to listen on `127.0.0.1:8888`.
2. On the server, Chrome uses a PAC script that sends only the chosen domains to `127.0.0.1:8888`. Everything else goes out directly, as before.
3. Each connection to that port travels through the tunnel to the home computer. The built-in proxy accepts only `CONNECT <allowlisted host>:443`, resolves the name at home, refuses any private or home-network address, and relays the encrypted bytes. It never sees inside HTTPS.

The SSH client and the proxy are built in, so the home computer needs neither `ssh` nor tinyproxy.

## Safety rules

The home-side rules (allowlist, home network, no open port, pinned key, key handling, bounds) hold in code and are covered by tests. Two depend on the server, which you set up by hand until `setup` ships: failing closed needs the PAC from step 3, and narrow server access needs the account from step 2, which `doctor` checks.

- **Allowlist only.** The proxy refuses every host not on the list (`403`), every port other than 443, every IP literal and every plain-HTTP request (`405`). Lookalike names such as `evilinstagram.com` do not match `instagram.com`.
- **Never the home network.** If an allowlisted name resolves to a loopback, private, link-local, CGNAT, multicast or reserved address, or into a network the home computer is on, the proxy refuses it and connects nowhere. It connects to the exact address it checked, so a second DNS answer cannot redirect it.
- **No open port at home.** The proxy runs inside the tunnel process and opens no listening socket. The tunnel is the only way in.
- **Fails closed.** The PAC sends the chosen domains to the tunnel with no direct fallback. If the tunnel is down, those sites fail instead of switching to the datacenter IP, so accounts never flip between IPs.
- **Pinned server key.** The server's host key is pinned by its `SHA256:` fingerprint. A different key stops the connection before authenticating. There is no trust-on-first-use.
- **Narrow server access.** The tunnel user has no shell and may only listen on one loopback port. `social-tunnel doctor` checks this: it fails if that user can run a shell, run a command, use `sftp`, open a local forward or listen on another port.
- **You log in yourself.** The tool never asks for, stores or logs platform passwords, 2FA codes or cookies. The SSH private key stays on the home computer, must be readable only by you, and never appears in output or logs.
- **Bounded.** At most 256 relays at once; slow or idle connections are closed (10 s to send a request, 10 s to resolve and connect, 300 s idle).

The full threat model is in [docs/security/threat-model.md](docs/security/threat-model.md).

## Status

**v0.1 in progress.** The core works and is verified: `run`, `status` and `doctor`, with `--json` output and stable exit codes. Until `setup` and `install` ship, the server side and the start-at-login service are set up by hand, as shown below.

| Piece | State |
| --- | --- |
| `run`, `status`, `doctor` | Done |
| `setup` (key, server side, PAC, default domains) | Next |
| `install` / `uninstall` (start at login) | Planned |
| `domains add/remove/list`, `logs` | Planned |
| Single binaries, npm and Homebrew | Planned |
| Tray app (v0.2) | Concepts in [docs/design](docs/design/index.html) |
| MCP server | Later |

## Requirements

- **Home computer:** macOS or Linux (Windows is planned), [Bun](https://bun.sh) 1.4 or newer while running from source. It must stay on and online while agents use the accounts.
- **Server:** a Linux VPS with OpenSSH, root access once for the setup, and Google Chrome for the agents.

## Quick start (from source)

```sh
git clone <this repo> social-tunnel && cd social-tunnel
bun install
```

### 1. Create a dedicated key on the home computer

```sh
ssh-keygen -t ed25519 -N "" -C social-tunnel -f ~/.ssh/social_tunnel
chmod 600 ~/.ssh/social_tunnel
```

Use a key only for this. `doctor` warns if you point it at your personal `~/.ssh/id_*` key.

### 2. Prepare the server (once, as root)

Create a user with no shell:

```sh
useradd --create-home --shell /usr/sbin/nologin sotunnel
install -d -m 700 -o sotunnel -g sotunnel ~sotunnel/.ssh
```

Add the public key to `~sotunnel/.ssh/authorized_keys`, limited to one remote listen and nothing else:

```
restrict,port-forwarding,permitlisten="127.0.0.1:8888",command="/usr/sbin/nologin" ssh-ed25519 AAAA... social-tunnel
```

Make the file root-owned so the tunnel user cannot change it (`chown root:root`, `chmod 644`), and allow `sshd` to read it.

Append to `/etc/ssh/sshd_config`, then reload `sshd`:

```
Match User sotunnel
    AllowTcpForwarding remote
    PermitListen 127.0.0.1:8888
    PermitOpen none
    AllowStreamLocalForwarding no
    GatewayPorts no
    PermitTTY no
    X11Forwarding no
    AllowAgentForwarding no
    ForceCommand /usr/sbin/nologin
    ClientAliveInterval 30
    ClientAliveCountMax 3
```

The keepalive frees the port within about 90 seconds after the home computer drops off, so the tunnel can come back.

Point the agents' Chrome at a PAC through a managed policy, for example `/etc/opt/chrome/policies/managed/social-tunnel.json`:

```json
{
  "ProxySettings": {
    "ProxyMode": "pac_script",
    "ProxyPacUrl": "data:application/x-ns-proxy-autoconfig;base64,<base64 of the PAC below>",
    "ProxyPacMandatory": true
  }
}
```

```js
function FindProxyForURL(url, host) {
  var domains = ["instagram.com", "facebook.com", "threads.net", "linkedin.com", "tiktok.com"];
  host = host.toLowerCase();
  for (var i = 0; i < domains.length; i++) {
    if (host === domains[i] || dnsDomainIs(host, "." + domains[i])) return "PROXY 127.0.0.1:8888";
  }
  return "DIRECT";
}
```

`ProxyPacMandatory` keeps Chrome from going direct when the PAC cannot be used. Restart Chrome, or reload `chrome://policy`, to apply it. If your platform firewalls the agents from local ports, allow `tcp/8888` (on agentes.chat: `agentes-runner services allow tcp/8888`).

Get the server's host key fingerprint from a trusted network, and check it against the server's own `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`:

```sh
ssh-keyscan -p 22 -t ed25519 your.server | ssh-keygen -lf -
```

### 3. Write the config on the home computer

| OS | Default path |
| --- | --- |
| macOS | `~/Library/Application Support/social-tunnel/config.json` |
| Linux | `$XDG_CONFIG_HOME/social-tunnel/config.json`, else `~/.config/social-tunnel/config.json` |
| Windows | `%APPDATA%\social-tunnel\config.json` |

`--config <path>` or `SOCIAL_TUNNEL_CONFIG` overrides it.

```json
{
  "version": 1,
  "server": {
    "host": "your.server",
    "port": 22,
    "user": "sotunnel",
    "hostKey": "SHA256:abc123...43 characters, no padding"
  },
  "remotePort": 8888,
  "keyPath": "~/.ssh/social_tunnel",
  "domains": ["instagram.com", "facebook.com", "threads.net", "linkedin.com", "tiktok.com"]
}
```

| Field | Meaning |
| --- | --- |
| `server.host`, `server.port`, `server.user` | Where the tunnel user logs in |
| `server.hostKey` | The server's host key, `SHA256:` plus 43 base64 characters |
| `remotePort` | Loopback port the server listens on for the tunnel; default `8888` |
| `keyPath` | Private key file; `~` and paths relative to the config file work |
| `domains` | The allowlist. A domain also covers its subdomains (`instagram.com` covers `www.instagram.com`). Bare hostnames only: no scheme, port, path, wildcard or IP |

Unknown fields are rejected, so a typo or a pasted secret never goes unnoticed. The config holds no secrets.

### 4. Check every hop, then run

```sh
bun src/cli.ts doctor
bun src/cli.ts run
```

`run` stays in the foreground until Ctrl-C or SIGTERM. Until `install` ships, keep it running with your own launchd agent, systemd user unit or terminal multiplexer.

Then log in to each platform yourself, in the agent's browser on the server.

## Commands

| Command | Does |
| --- | --- |
| `social-tunnel run` | Holds the tunnel open, reconnects on its own and records every state change |
| `social-tunnel status` | Reports the tunnel state from the running `run` |
| `social-tunnel doctor` | Tests every hop in order and names the first broken one with a fix |
| `social-tunnel doctor --domain <host>` | Also checks that `<host>` is on the allowlist |

Options: `--json` (one JSON object on stdout), `--config <path>`, `--help`, `--version`. No command ever prompts or reads stdin.

### Tunnel states

| State | Meaning |
| --- | --- |
| `connecting` | First connection in progress |
| `connected` | Tunnel up; chosen domains go through home |
| `disconnected` | Connection lost, or the server refused the key (`auth_failed`); `retryAt` says when the next try starts |
| `reconnecting` | Trying again (1, 2, 4, 8, 16, then every 30 s) |
| `blocked` | The server refused the port (`port_blocked`, retried every 30 s) or presented a different host key (`host_key_mismatch`, stops) |
| `stopped` | No `run` is active, it stopped reporting (`stale`), or the running one serves another server or port than this config (`config_changed`: restart `run`) |

### Exit codes

Stable, so scripts and agents can branch on them:

| Code | Meaning |
| --- | --- |
| `0` | OK |
| `1` | Internal error |
| `2` | Usage or config error, a key that is missing, not a private key or readable by others, or `run` already active |
| `10` | Tunnel down, server unreachable, SSH login refused, or no home internet |
| `11` | Server refused the tunnel port |
| `12` | Domain not on the allowlist (`doctor --domain`) |
| `13` | Server host key does not match the pinned key |
| `14` | Server's tunnel user is too permissive (shell, command, `sftp` or other forwards work) |

### `doctor` hops

`config` → `domain` (with `--domain`) → `key` → `server_reachable` → `ssh_auth` → `forward` → `lockdown` → `egress`. It stops at the first failure and marks the rest `skipped`. Each hop reports `{hop, ok, skipped, detail, fix}`.

### JSON output

```sh
$ social-tunnel status --json
{"ok":true,"command":"status","configPath":"/Users/me/Library/Application Support/social-tunnel/config.json","state":"connected","reason":null,"since":"2026-11-21T18:04:12.000Z","retryAt":null,"pid":4242,"server":{"host":"your.server","port":22},"remotePort":8888,"domains":5}
```

## For AI agents

- Drive it with `--json` and branch on the exit code. Every command returns without input.
- `status` and `doctor` run on the **home** computer. An agent on the server cannot call them. There it sees only whether its requests succeed: a chosen site that fails to load means the tunnel is down, by design.
- Never type platform passwords or 2FA codes for the user. They log in themselves in the agent's browser.
- A `SKILL.md` that teaches coding agents to drive the CLI ships with v0.1.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `status` exits 10 | Is `run` running at home, and online? `doctor` names the broken hop |
| `blocked` / `port_blocked` (exit 11) | Something else holds the port on the server, often a stale tunnel. It frees within about 90 s with the keepalive above; otherwise check `PermitListen` and `permitlisten` |
| Exit 13 | The server's host key changed. Verify the new fingerprint out of band before updating `server.hostKey` |
| Exit 14 | Tighten the tunnel user: `restrict`, `command=`, `ForceCommand` and `PermitOpen none` as above |
| Sites fail in Chrome but `status` is `connected` | Check `chrome://policy` on the server, restart Chrome, and check the platform firewall allows the port |
| A platform loads but login breaks | It may use another domain for login. Add it to `domains` and to the PAC |

## Default domains

`setup` will start with `instagram.com`, `facebook.com`, `threads.net`, `linkedin.com` and `tiktok.com`. Subdomains are included. Image and video CDNs (`cdninstagram.com`, `fbcdn.net`, `tiktokcdn.com`) can keep loading directly from the server; add one only if logging in needs it.

## Limits

- Works only while the home computer is on and online. For 24/7 use, run it on an always-on device at home.
- Platforms may still restrict accounts used for automation. Prefer a secondary account and a human pace.
- Every process on the server that can reach `127.0.0.1:8888` can use the tunnel for the allowlisted domains. Keep the list short.

## Development

```sh
bun install
env -u CLAUDECODE taskpolicy -b nice -n 10 bun test   # macOS; plain `bun test` elsewhere
bun run typecheck
```

Tests need no internet and no `sshd`: they run an in-process SSH server and inject DNS and network fakes. Contributor and agent rules are in [AGENTS.md](AGENTS.md); the feature specs, checks and verification records are under [.specs/](.specs/).

## License

TBD (MIT suggested).
