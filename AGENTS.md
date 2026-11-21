# social-tunnel

What it does, why, and the release plan: [README.md](README.md). Read it before planning any feature.

## Stack and layout

The CLI core (`run`, `status`, `doctor`) is built; `app/` and `skills/` are still planned. Change the layout by decision, not drift:

| Path | Holds | Stack |
| --- | --- | --- |
| `src/` | CLI: commands, SSH tunnel, allowlist proxy, server setup, login services, config | Bun, TypeScript, `ssh2`, `bun test` |
| `app/` | v0.2 tray app; runs the compiled CLI as a sidecar | Tauri v2 (Rust), React, Vite, Tailwind CSS v4 |
| `skills/social-tunnel/SKILL.md` | The shipped skill that teaches agents to drive the CLI | Markdown |

The tray app holds no tunnel or proxy logic: it calls the CLI (`--json`), so CLI, app and the later MCP server share one code path.

## Commands

- Run the CLI from source: `bun src/cli.ts <run|status|doctor> [--json] [--config <path>]`.
- Tests: `env -u CLAUDECODE taskpolicy -b nice -n 10 bun test` (Bun hides per-test pass lines when `CLAUDECODE` is set). Test names start with their check id, `[C12] ...`.
- Tests use an in-process `ssh2` server and injected resolvers and dialers: no internet, no sshd. Keep it that way.
- `ssh2`'s `utils.generateKeyPairSync("ed25519")` under Bun returns a pair `ssh2` cannot parse about 1 time in 200; parse-check any generated key before use.

## Safety invariants

These are the product. Every change that touches the proxy, tunnel, server setup, PAC or key handling keeps each one and adds a regression test for it:

1. **Allowlist only.** The home proxy forwards a request only when its host is on the allowlist, and refuses every other host with an error. It also refuses targets that resolve to loopback, private or link-local addresses, so an allowlisted name can never reach the home network.
2. **No local listener.** The home proxy runs in-process on the tunnel's forwarded channels and opens no listening socket; the tunnel is its only way in.
3. **Fail closed.** The PAC routes chosen domains to the tunnel with no `DIRECT` fallback. Tunnel down means those domains fail.
4. **Narrow server access.** The tunnel's SSH user has no shell and no TTY, and may only listen on one remote loopback port (`permitlisten="127.0.0.1:<port>"`, no gateway ports).
5. **Secrets stay put.** The tool never asks for, stores or logs platform passwords, 2FA codes or session cookies; the user logs in in the browser. The SSH private key stays on the home machine with mode `0600`, and logs and `--json` output redact it.

## Skills

Installed project-scoped in `.agents/skills/` (Claude links in `.claude/skills/`), pinned in `skills-lock.json`. Update with `npx skills@latest update --project`.

- **Flow:** start feature and fix work with `wtk`; it routes to the right phase skill (`wtk-lean`, `wtk-plan`, `wtk-deep-review`, `wtk-ship`, …). Run `wtk-setup` to adopt project guidelines once code exists.
- **Security:** `security-threat-model` before building v0.1 and whenever a trust boundary changes (keys, tunnel, proxy, remote root setup, sidecar); `security-spec` to turn a feature into abuse cases and negative tests; `security-implementation` while writing that code; `security-review` on every diff that touches the invariants above.
- **Tray UI:** `frontend-craft` for design, review and accessibility of the settings and setup screens; `react` and `tailwindcss` for code; `tauri-v2` for commands, capabilities, tray, sidecar and updater.
- **Bun and `ssh2`:** no skill installed; read the current docs before relying on an API or flag.

## Working on this machine

This is the user's daily laptop; keep most of it free.

- Run heavy commands (tests beyond a few files, typecheck, `bun build --compile`, `cargo`/Tauri builds, installs) as `taskpolicy -b nice -n 10 <cmd>`.
- Cap parallelism: test runners and type checkers at 2 threads, `cargo build -j 2`, Playwright `workers: 1`, Docker `--cpus 2`.
- Prove locally with the focused tests the change touches; full suites belong in hosted CI.
- Commit with Conventional Commits.
