---
name: social-tunnel
description: Check or repair the social-tunnel home tunnel and edit which domains the server's Chrome sends through home. Use when a social platform fails to load or log in from a VPS agent's browser, or when asked to add or remove a tunneled domain.
---

# social-tunnel

`social-tunnel` runs on the **home** computer. It holds an SSH reverse tunnel to a server and proxies only allowlisted domains from the server's Chrome out through the home internet. Run every command below on the home computer, with `--json`, and branch on the exit code. No command prompts or reads stdin.

On the server you cannot run these commands. There, a chosen site that fails to load means the tunnel is down: it fails closed by design and never falls back to the datacenter IP.

## Diagnose

1. `social-tunnel status --json`. `state` is the tunnel state; `connected` means it is up.
2. If it is not `connected`, or a site still fails, run `social-tunnel doctor --json` (add `--domain <host>` to also check that host is on the allowlist). It stops at the first failed hop; that hop's `fix` field says what to do.
3. Done when `status` reports `connected` and `doctor` exits `0`.

| Exit | Meaning | Next |
| --- | --- | --- |
| `0` | OK | |
| `2` | Usage, config or invalid input | Read `error.message`; fix the command or config |
| `10` | Tunnel, home internet or domain authority unavailable | Is the app or `social-tunnel run` running? Read `doctor` |
| `11` | Server refused the tunnel port | Usually a stale tunnel; it frees within about 90 s |
| `12` | Domain not on the allowlist | Add it, after asking the user (below) |
| `13` | Server host key changed | Stop. Ask the user to verify the new fingerprint out of band |
| `14` | Server tunnel user is too permissive | Report to the server administrator |

## Edit domains

Editing works only when the server runs the protected package; otherwise `domains list` returns `state: "setup_required"` and the list lives in the server's Chrome policy.

An edit applies immediately and can interrupt what the agents are doing in their browsers, so confirm with the user before every `add` or `remove`, naming the host.

1. `social-tunnel domains list --json`. Use `active.revision` as the expected revision. `active` is `null` when the current state is unproven; retry `list` rather than guessing.
2. `social-tunnel domains add <host> --expected-revision <revision> --json` (or `remove`). Pass a bare public hostname: no scheme, port, path, wildcard or IP. A domain covers its subdomains.
3. A `pending` result holds `pending.operationId`. Run `social-tunnel domains retry <operation-id> --json` every few seconds until `state` is `applied`. Retry checks the same edit and never submits it twice.
4. Done when `state` is `applied` and `domains list` shows the new revision.

Exit `10` with `conflict` means the revision changed or another edit is pending: list again and use the new revision. `recovery_required` needs the server administrator; stop and report it.

## Boundaries

- The user logs in to each platform in the agent's browser. Leave passwords, 2FA codes and cookies to them.
- Change the allowlist only through `domains add/remove` or the app. The config, keys and server policy are the user's.
