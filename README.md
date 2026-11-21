# social-tunnel

Let AI agents on a server reach social platforms through your home internet.

Instagram, Facebook, LinkedIn and others often block logins from datacenter IPs. `social-tunnel` routes **only the domains you choose** from a server's browser through a computer at home, over an SSH reverse tunnel. Everything else keeps going out directly from the server.

```
agent's Chrome (server) ── PAC: only chosen domains ──▶ 127.0.0.1:8888 (server)
        ▲                                                   │ SSH reverse tunnel
        └── other traffic goes direct                       ▼
                                          allowlist proxy (home computer) ──▶ internet, home IP
```

## Safety rules

- **Allowlist only.** The home proxy refuses every domain not on the list, so nothing on the server can reach your home network, router or local services.
- **Fails closed.** If the tunnel is down, the chosen domains fail instead of falling back to the datacenter IP, so accounts don't flip between IPs.
- **Narrow server access.** The tunnel uses a dedicated SSH user with no shell, allowed to listen on one loopback port only.
- **You log in yourself.** The tool never handles platform passwords or 2FA.

## Status

Planning. Proven by hand on one setup (Ubuntu VPS running [agentes.chat](https://agentes.chat), macOS at home). This repository turns that setup into a tool.

## Plan

### v0.1: CLI (Bun)

One TypeScript codebase compiled with `bun build --compile` to single binaries for macOS, Linux and Windows. It embeds the SSH client (`ssh2`) and the allowlist proxy, so it needs neither `ssh` nor tinyproxy.

| Command | Does |
| --- | --- |
| `social-tunnel setup` | Creates the key, sets up the server side (tunnel user, keepalive, browser policy) and the local config |
| `social-tunnel install` / `uninstall` | Starts at login: launchd, systemd user unit, or Task Scheduler |
| `social-tunnel status` | Proxy, tunnel and server port state |
| `social-tunnel doctor` | Tests every hop and says which one broke and how to fix it |
| `social-tunnel domains add/remove/list` | Edits the allowlist and the server's PAC together |
| `social-tunnel logs` | Recent tunnel and proxy logs |

Built for agents too: every command takes `--json`, never prompts when given flags, and returns stable exit codes (0 ok, distinct codes for tunnel down, server port blocked, domain refused). A `SKILL.md` ships in the repo so coding agents know how to drive it.

Integrations: optional server-side steps for platforms that firewall their agents. For agentes.chat that is `agentes-runner services allow tcp/<port>`.

Distribution: npm (`npx social-tunnel` / `bunx social-tunnel`, with per-platform prebuilt binaries) and Homebrew (macOS, Linux).

### v0.2: Tray app (Tauri)

A Tauri shell around the same Bun binary (as a sidecar): tray icon with connected/disconnected state, reconnect, setup wizard, auto-update. Shipped as `.dmg` (Homebrew cask), `.msi` (winget) and `.AppImage`/`.deb`. Signing and notarization on macOS.

### Later: MCP

`social-tunnel mcp` exposes `status`, `doctor` and `restart` as MCP tools for assistants without a shell, calling the same code as the CLI.

## Limits

- Works only while the home computer is on and online. For 24/7 use, run it on an always-on device at home.
- Platforms may still restrict accounts used for automation. Prefer a secondary account and a human-like pace.

## License

TBD (MIT suggested).
