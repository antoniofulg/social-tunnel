# CLI core: tunnel, allowlist proxy, status and doctor

## Problem

Instagram, Facebook, LinkedIn and similar platforms block or challenge logins from datacenter IPs, so
AI agents running a browser on a VPS cannot use those accounts. Today the only fix is a hand-built
setup (system `ssh -R`, tinyproxy, a hand-written PAC) proven on one Ubuntu VPS and one Mac: it has
no allowlist enforcement in code, no stable way for an agent to ask whether the route works, and
nothing tells the user which hop broke. The source gives no usage figures; the evidence is the one
working manual setup described in the README.

When this ships, one Bun program on the home computer holds the reverse tunnel open, forwards only
allowlisted domains to the internet, and answers `status` and `doctor` with JSON and stable exit
codes that an agent or the future tray app can branch on.

## Flow

Reuses `ssh2` for the SSH client and Bun's `node:net` / `node:dns` for sockets; the repo has no code
yet, so nothing is duplicated.

1. argv -> `cli` (new, no door - placement per conventions) - parses verb and flags, never prompts
2. `cli` -> `config` (new, door 3) - resolves the path, validates schema v1, returns a typed config or exit 2
3. `run`: `tunnel` (new, door 6) - SSH connect with key auth, host key pinned (door 8), requests remote forward `127.0.0.1:<remotePort>`
4. each forwarded channel -> `proxy` (new, door 4) - parses one CONNECT, applies the allowlist and address guard, dials the checked IP, relays bytes (door 5)
5. every tunnel state change -> `state` (new, door 7) - atomic write of `state.json`
6. `status` -> `config` + `state` - reads `state.json`, checks the pid is alive, maps state to output and exit code (door 1, door 2)
7. `doctor` -> `config`, `tunnel` (probe mode), `proxy` allowlist and address guard - runs hops in order, out: hop list + exit code (door 1, door 2)

## Impact

| Front | What changes |
| --- | --- |
| domain | new term: `allowlist` - the configured domains; a host matches when it equals a domain or ends with `.` + domain |
| domain | new term: tunnel `state` - one of `connecting`, `connected`, `disconnected`, `reconnecting`, `blocked`, `stopped`; the tray badge (docs/design) and agents branch on it |
| domain | new term: `hop` - one doctor check: `config`, `key`, `server_reachable`, `ssh_auth`, `forward`, `lockdown`, `egress`, `domain` |
| stored data | nothing to migrate - first version of `config.json` and `state.json` |
| repository | first code: `package.json`, `tsconfig.json`, `src/`, `tests/`; `bun.lock` committed |

## Relations

None - no stored-data shape change beyond two new local JSON files, whose literal shapes are doors 3 and 7.

## Surface

| Interface | In | Out | Outcomes |
| --- | --- | --- | --- |
| `social-tunnel run` | `--config <path>`, `--json` | log lines on stderr (JSON lines with `--json`); `state.json` | exit 0 on SIGINT/SIGTERM, 2 config/usage or already running, 13 host key mismatch |
| `social-tunnel status` | `--config <path>`, `--json` | `{ok, command, state, reason, since, retryAt, pid, server, remotePort, domains}` | exit 0 connected, 10 not connected, 11 port blocked, 13 host key mismatch, 2 config |
| `social-tunnel doctor` | `--config <path>`, `--json`, `--domain <host>` | `{ok, command, hops: [{hop, ok, detail, fix}]}` | exit 0 all pass, 2 config/key, 10 unreachable/auth/egress, 11 forward refused, 12 domain refused, 13 host key mismatch, 14 lockdown failed |
| any verb, `--help`, `--version` | unknown verb or flag | usage on stderr | exit 2 for unknown input, 0 for help/version |
| proxy over a forwarded channel | `CONNECT host:443 HTTP/1.1` | relayed bytes | `200 Connection Established`, `400`, `403`, `405`, `408`, `502`, `503`, `504` |

## Landing

| One-way door | Literal shape | Alternative rejected |
| --- | --- | --- |
| 1. Exit codes | `0` ok · `1` internal error · `2` usage/config · `10` tunnel down · `11` server port blocked · `12` domain refused · `13` host key mismatch · `14` server tunnel user too permissive | One non-zero code: agents could not tell which hop to fix |
| 2. `--json` envelope | one JSON object on stdout, top-level `ok` (bool) and `command` (verb); errors as `error: {code, message, field?}` | NDJSON streams: harder to parse for a one-shot status call |
| 3. Config path and schema v1 | `--config` > `$SOCIAL_TUNNEL_CONFIG` > `$XDG_CONFIG_HOME/social-tunnel/config.json` > `~/.config/social-tunnel/config.json` (`%APPDATA%\social-tunnel\config.json` on Windows); `{version: 1, server: {host, port, user, hostKey}, remotePort, keyPath, domains}`; unknown keys rejected | `~/Library/Application Support` on macOS: two paths for agents and docs to know on the two main platforms |
| 4. Proxy runs in-process on forwarded channels | `tunnel` passes each `tcp connection` stream to `proxy.handle(stream)`; no listening socket on the home machine | Local `127.0.0.1` TCP listener: any local process, or a mis-bind to the LAN, could use the home IP |
| 5. CONNECT-only, port 443 | method other than CONNECT gets `405`, port other than 443 gets `403` | Plain-HTTP absolute-form forwarding: more parsing surface, and the target platforms are HTTPS-only |
| 6. `ssh2` dependency | `ssh2@1.17.0`, pure JS under Bun (spike: handshake, host key pin, key auth and reverse-forward round trip pass on Bun 1.4.4) | System `ssh` binary: README requires no external `ssh`, and Windows lacks it by default |
| 7. State file | `state.json` beside the config: `{version: 1, pid, state, reason, since, retryAt, server, remotePort, updatedAt}`, written by temp file + rename | Local control socket or HTTP endpoint: adds a listener (see door 4) |
| 8. Host key pin | `server.hostKey` = OpenSSH-style `SHA256:<base64 without padding>`; mismatch disconnects before auth | Trust on first use: silently accepts a MITM on the first connection |

- Nothing else in this change is hard to reverse

## Criteria

### S1: Config loads or fails with a named field (P1)

A command either gets a valid config or tells the user exactly what is wrong, in text or JSON.

**Acceptance Criteria**

1. WHEN a command starts THEN the system SHALL read the config from the first present of `--config`, `$SOCIAL_TUNNEL_CONFIG`, `$XDG_CONFIG_HOME/social-tunnel/config.json`, `~/.config/social-tunnel/config.json`
2. IF the config file is missing, is not JSON, or fails schema v1 validation THEN the system SHALL exit 2 and, with `--json`, print `{"ok":false,"command":<verb>,"error":{"code":"config_invalid","field":<json path>,"message":<text>}}`
3. IF a domain entry is not a DNS hostname with at least two labels, or contains a scheme, port, path, wildcard or IP literal THEN the system SHALL reject the config naming that entry
4. WHEN a domain entry has upper-case letters or one trailing dot THEN the system SHALL store it lower-cased without the dot
5. IF the config contains a key not in schema v1 THEN the system SHALL reject it naming that key
6. IF `run` or `doctor` finds the key file readable or writable by group or others on macOS or Linux THEN the system SHALL exit 2 with error code `key_permissions` and the key path, without reading the key

**Independent test:** run `social-tunnel status --json --config <fixture>` against valid, missing, malformed and bad-domain fixtures and read the exit code and JSON.

### S2: Only allowlisted HTTPS hosts leave through the home IP (P1)

The proxy handler, given a forwarded stream, relays only allowlisted `host:443` to a public address.

**Acceptance Criteria**

7. WHEN a CONNECT request names `host:443` and the host equals an allowlisted domain or ends with `.` + an allowlisted domain THEN the system SHALL connect to a checked address, reply `HTTP/1.1 200 Connection Established`, and relay bytes both ways until either side closes
8. IF the CONNECT host matches no allowlisted domain THEN the system SHALL reply `403 Forbidden` and close without a DNS lookup or outbound connection
9. IF the CONNECT port is not 443 THEN the system SHALL reply `403 Forbidden` and close without an outbound connection
10. IF the CONNECT host is an IPv4 or IPv6 literal THEN the system SHALL reply `403 Forbidden` and close without an outbound connection
11. IF every resolved address is in a refused range - IPv4 `0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.0.0/24`, `192.168/16`, `198.18/15`, `224/4`, `240/4`; IPv6 `::/128`, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`; the IPv4 embedded in `::ffff:0:0/96`, `64:ff9b::/96` or `2002::/16` falling in a refused IPv4 range; or any prefix assigned to the home machine's own network interfaces - THEN the system SHALL reply `403 Forbidden` and close without an outbound connection
12. WHEN the host resolves to at least one public address THEN the system SHALL connect to that exact address without a second DNS lookup
13. IF the request method is not CONNECT THEN the system SHALL reply `405 Method Not Allowed` and close
14. IF the request head exceeds 8 KiB or is not complete within 10 s THEN the system SHALL reply `400 Bad Request` or `408 Request Timeout` respectively and close
15. IF the outbound connection fails THEN the system SHALL reply `502 Bad Gateway`, and IF the DNS lookup or connection does not complete within 10 s THEN `504 Gateway Timeout`, and close
16. IF 256 relays are already open THEN the system SHALL reply `503 Service Unavailable` to the next CONNECT and close it
17. The system SHALL open no listening socket on the home machine
44. IF the CONNECT host is not dot-separated labels of letters, digits and hyphens (1-63 characters each, 253 total) or the port is not exactly the digits `443` THEN the system SHALL reply `400 Bad Request` and close
45. WHEN the request head completes THEN the system SHALL relay any bytes after it upstream without parsing them as a request
46. The system SHALL send refusal responses with a fixed body that names no resolved address
47. IF a relay carries no bytes in either direction for 300 s THEN the system SHALL close both sides

**Independent test:** feed the handler in-memory duplex streams with allowed, refused, IP-literal, private-resolving, malformed and oversized requests; assert status lines and that refused cases made no lookup or connection.

### S3: `run` holds the tunnel open and reports every state change (P1)

The home machine keeps a reverse tunnel to the server and records connected, lost and reconnecting as they happen.

**Acceptance Criteria**

18. WHEN `run` starts with a valid config THEN the system SHALL connect to `server.host:server.port` as `server.user` with the key at `keyPath` and request a remote forward on `127.0.0.1:<remotePort>`
19. IF the server host key's SHA256 fingerprint differs from `server.hostKey` THEN the system SHALL disconnect before authenticating, write state `blocked` with reason `host_key_mismatch`, and exit 13
20. WHEN the forward is granted THEN the system SHALL write state `connected`
21. IF the server refuses the forward THEN the system SHALL write state `blocked` with reason `port_blocked` and retry every 30 s
22. WHEN the SSH connection closes or 3 consecutive keepalives (15 s interval) go unanswered THEN the system SHALL write state `disconnected` with reason `connection_lost` and the next `retryAt`
23. WHEN a retry attempt starts THEN the system SHALL write state `reconnecting`, with retry delays of 1, 2, 4, 8, 16 then 30 s, reset to 1 s after a successful connection
24. WHEN a forwarded connection arrives THEN the system SHALL pass its stream to the proxy handler (criteria 7-16, 44-47)
48. IF a forwarded connection names a bind address or port other than `127.0.0.1:<remotePort>` THEN the system SHALL reject it without passing it to the proxy
49. WHILE `run` is running the system SHALL rewrite `updatedAt` in `state.json` at least every 30 s
50. The system SHALL log a request host only after it passes criterion 44, and SHALL strip control characters from server-supplied text before logging it
25. WHEN the state changes THEN the system SHALL replace `state.json` atomically with `{version, pid, state, reason, since, retryAt, server, remotePort, updatedAt}`
26. WHEN `run` receives SIGINT or SIGTERM THEN the system SHALL cancel the forward, close the connection, write state `stopped` and exit 0
27. IF `state.json` names a live pid other than its own with a state other than `stopped` THEN `run` SHALL exit 2 with error code `already_running`
28. The system SHALL write no private key material and no passphrase to stdout, stderr, `state.json` or `--json` output

**Independent test:** start `run` against an in-process `ssh2` test server; kill the server, watch `state.json` go `connected` -> `disconnected` -> `reconnecting` -> `connected`; present a wrong host key and see exit 13.

### S4: `status` answers in one call (P1)

An agent or the tray learns the tunnel state and acts on the exit code.

**Acceptance Criteria**

29. WHEN `status` runs and `state.json` names a live pid in state `connected` THEN the system SHALL exit 0 and print state, since, server host, remote port and domain count
30. IF `state.json` is absent, names a dead pid, or holds state `stopped` THEN `status` SHALL report state `stopped` and exit 10
31. WHILE the state is `connecting`, `disconnected` or `reconnecting` `status` SHALL exit 10 and include `reason` and `retryAt`
32. WHILE the state is `blocked` with reason `port_blocked` `status` SHALL exit 11
33. WHILE the state is `blocked` with reason `host_key_mismatch` `status` SHALL exit 13
51. IF `updatedAt` in `state.json` is older than 90 s THEN `status` SHALL report state `stopped` with reason `stale` and exit 10
34. WHEN any command gets `--json` THEN the system SHALL write exactly one JSON object and a newline to stdout and nothing else

**Independent test:** write fixture `state.json` files for each state and pid case; run `status --json` and assert exit code and fields.

### S5: `doctor` names the broken hop and its fix (P2)

The user or an agent learns which hop failed and what to do about it.

**Acceptance Criteria**

35. WHEN `doctor` runs THEN the system SHALL run hops `config`, `key`, `server_reachable`, `ssh_auth`, `forward`, `lockdown`, `egress` in that order, stop at the first failure, and report the remaining hops as `skipped`
36. The system SHALL report each hop as `{hop, ok, detail, fix}` where `fix` is a non-empty sentence whenever `ok` is false
37. WHEN a live `run` is `connected` THEN the `forward` hop SHALL pass from `state.json` without requesting a second forward
38. WHEN no live `run` holds the forward THEN the `forward` hop SHALL request the forward on `127.0.0.1:<remotePort>` and cancel it on success
39. WHEN the `egress` hop runs THEN the system SHALL resolve the first allowlisted domain and open a TCP connection to it on port 443 from the home machine within 10 s
40. WHEN `--domain <host>` is given THEN the system SHALL add hop `domain`, passing when the host matches the allowlist (criteria 4 and 7) and failing otherwise
41. WHEN a hop fails THEN `doctor` SHALL exit with that hop's code: `config`/`key` 2, `server_reachable`/`ssh_auth`/`egress` 10, `forward` 11, `domain` 12, host key mismatch 13, `lockdown` 14; all pass exits 0
52. WHEN the `ssh_auth` hop connects THEN the system SHALL verify the host key exactly as criterion 19 does, through the same connect path as `run`
53. WHEN the `lockdown` hop runs THEN the system SHALL, as the tunnel user, try a shell session, an `sftp` subsystem, a local forward to `127.0.0.1:22` and a remote forward on `127.0.0.1:<remotePort + 1>`, and fail naming each attempt the server allowed
54. WHEN `keyPath` names a file matching `~/.ssh/id_*` THEN the `key` hop SHALL pass with a detail advising a dedicated tunnel key

**Independent test:** run `doctor --json` against the in-process test server with a good setup, a wrong host key, a refused forward and an unlisted `--domain`; assert hop list and exit code.

### S6: The CLI never blocks an agent (P1)

**Acceptance Criteria**

42. IF the verb or a flag is unknown THEN the system SHALL print usage to stderr and exit 2
43. The system SHALL read nothing from stdin and never wait for interactive input

**Independent test:** run with an unknown verb and with stdin closed; assert exit 2 and that every verb returns without input.

## Traceability

| ID | Slice | Criteria | Status |
| --- | --- | --- | --- |
| CFG-01 | S1 | 1, 2, 3, 4, 5, 6 | Pending |
| PRX-01 | S2 | 7-17, 44, 45, 46, 47 | Pending |
| TUN-01 | S3 | 18-28, 48, 49, 50 | Pending |
| STA-01 | S4 | 29-34, 51 | Pending |
| DOC-01 | S5 | 35-41, 52, 53, 54 | Pending |
| CLI-01 | S6 | 42, 43 | Pending |

## Security Surfaces

| ID | Surface | Control | Requirements |
| --- | --- | --- | --- |
| S1 | New runtime, `ssh2` dependency, config and state files | Pinned dependency in `bun.lock`; strict schema v1 with unknown keys rejected | Criteria 2, 3, 5 |
| S2 | Forwarded channels from the server's loopback port into the home machine | Allowlist, port 443 only, IP literal and refused-range check incl. own interface prefixes, only the expected forward accepted, no local listener | Criteria 7-12, 17, 48 |
| S5 | SSH private key and server host key | Key file permission check, dedicated-key advice, no key material in output, one pinned connect path for `run` and `doctor` | Criteria 6, 19, 28, 52, 54 |
| S6 | Untrusted CONNECT request head and server-supplied text | 8 KiB / 10 s head bounds, strict hostname and port grammar, post-head bytes never parsed, sanitised logs, generic refusal bodies | Criteria 13, 14, 44, 45, 46, 50 |
| S9 | Server-side tunnel user restrictions (configured by hand in v0.1) | `doctor` lockdown hop proves shell, sftp, local forward and other ports are refused | Criterion 53 |
| S11 | Long-running process on the user's laptop | 256-relay cap, DNS/connect and idle timeouts, single-instance guard, stale-state detection | Criteria 15, 16, 27, 47, 49, 51 |

## Out of scope

| Excluded | Why |
| --- | --- |
| `setup` (key creation, server provisioning, PAC, browser policy) | Next feature; needs admin SSH on the server and its own threat review |
| `install` / `uninstall` (launchd, systemd, Task Scheduler) | Next feature; wraps `run` once it is stable |
| `domains add/remove/list` | Needs server PAC sync from `setup` |
| `logs` | `run` logs to stderr in v0.1; persisted logs come with `install` |
| Single-binary builds and npm/Homebrew distribution | Release work after the core is proven |
| Plain-HTTP and SOCKS proxying | Door 5 |
| Windows key-permission check | Windows ACLs need a different mechanism; v0.1 checks macOS and Linux |
| Tray app and MCP server | v0.2 and later |
| Per-host rate limits and per-host counters in `status` (threat T4) | Needs real traffic data to set limits; the 256-relay cap bounds damage meanwhile |
| Server-side guard against another process binding the port while the tunnel is down (threat T3) | Needs root on the server; belongs to `setup` |
| Rejecting public-suffix allowlist entries (threat T1) | Belongs to `domains add`, which writes the list |
| Refusing the home's own public IP (threat T2) | Needs an external IP lookup; recorded as open question 4 |

## Assumptions

| Assumption | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Name of the long-running verb | `run` (foreground; `install` will launch it later) | README lists no verb that holds the tunnel; `run` is the plain word agents will guess | n |
| Default `remotePort` | 8888 | Matches the README diagram and the working manual setup | n |
| Logs from `run` | human lines on stderr, JSON lines with `--json`; no log file in v0.1 | `logs` is out of scope | y |
| Supported runtime | Bun 1.4.x on macOS and Linux for tests | Bun 1.4.4 is installed; spike ran on it | y |
| Host key fingerprint source before `setup` exists | user pastes the `SHA256:` value from `ssh-keyscan <host> \| ssh-keygen -lf -` into the config | No first-use trust (door 8) | n |

**Open questions:**

| # | Kind | Question | Until answered |
| --- | --- | --- | --- |
| 1 | open | Approve CONNECT-only to port 443 (door 5)? Recommended: yes - all target platforms are HTTPS and it removes the HTTP-parsing surface | Criteria 9 and 13 are written for CONNECT-only |
| 2 | open | Confirm `run` as the verb name and `~/.config/social-tunnel/` as the config home on macOS too (door 3) | Criteria 1 and 18 use these names |
| 3 | open | Keep default `remotePort` 8888 (fixed by the agentes.chat firewall rule?) or move to a less common port to reduce accidental takeover (threat T3) | Default stays 8888 |
| 4 | open | Does the home network use IPv6 or a VPN, and should the proxy also refuse the home's public IPv4 (router hairpin, threat T2)? | Criterion 11 covers interface prefixes only |

## Observable

| Surface | Decision | Landing |
| --- | --- | --- |
| command `run` | output format and verbosity | Assumption: stderr lines, JSON lines with `--json` |
| command `run` | flags and defaults | Surface row; AC 1 |
| command `run` | exit codes | AC 19, 26, 27; door 1 |
| command `run` | fails halfway | AC 21, 22, 23 (state recorded, retries) |
| command `status` | output format | AC 29, 34; door 2 |
| command `status` | flags and defaults | Surface row; AC 1 |
| command `status` | exit codes | AC 29-33; door 1 |
| command `status` | fails halfway | n/a - read-only, single file read |
| command `doctor` | output format | AC 36, 34 |
| command `doctor` | flags and defaults | AC 40; AC 1 |
| command `doctor` | exit codes | AC 41; door 1 |
| command `doctor` | fails halfway | AC 35 (later hops `skipped`), AC 38 (forward cancelled) |
| all verbs | unknown input, prompts | AC 42, 43 |
| proxy channel | error shape and codes | AC 8-16; door 5 |
| proxy channel | who may call it | AC 17; door 4 (only the tunnel's channels) |
| proxy channel | rate limits | AC 16 (concurrency cap); request-rate limit n/a - the only callers are the user's own server processes |
| proxy channel | versioning | n/a - HTTP CONNECT is a fixed protocol |

## Sources

- [README.md](../../../README.md) - v0.1 CLI plan, safety rules, `--json` and exit-code contract
- [AGENTS.md](../../../AGENTS.md) - safety invariants this feature must keep
- [Threat model](../../../docs/security/threat-model.md) - provisional v0.1 model; controls T1-T8 land in criteria 11, 44-54
- Coordinator dispatch, 2026-11-21 - scope: config, allowlist proxy, `ssh2` reverse tunnel, `status`/`doctor` with `--json` and stable exit codes
