# CLI core checks

Profile: standard
Risk: C9, C12, C14, C15, C20, C21, C26, C34, C35, C51, C53, C58 - allowlist, address guard, no-listener, host-key pin, key leakage, channel filter and server lockdown are the safety invariants; a weak test there ships an open proxy, a MITM or a usable server account
Build: `taskpolicy -b nice -n 10 bun run typecheck`
Run unit: `env -u CLAUDECODE taskpolicy -b nice -n 10 bun test`
Plan: `.specs/features/cli-core/plan.md`

63 checks in 6 slices · 8 one-way doors · 2 open, of which 0 block

Test names start with the check id in brackets, so `bun test` prints `(pass) [C<n>] ...`. Each id has exactly one test. `CLAUDECODE` is unset because Bun hides per-test pass lines when it is set.

Seams: the proxy and tunnel take their resolver and dialer as parameters; production wires `node:dns` and `node:net`. Tests inject counting fakes, and the fakes are the only resolver and dialer the code under test can reach, so "zero lookups" and "zero connections" are counts on those fakes.

## Checks

### S1 - Config loads or fails with a named field

**C1** - Config path resolves `--config` > `$SOCIAL_TUNNEL_CONFIG` > platform dir: macOS `~/Library/Application Support`, Linux `$XDG_CONFIG_HOME` then `~/.config`, Windows `%APPDATA%`, each + `social-tunnel/config.json` (CFG-01, AC 1)
Proof: run unit | (pass) [C1]

**C2** - For both `status --json` and `run --json`: missing, non-JSON and schema-invalid config each exit 2 with `{"ok":false,"command":<verb>,"error":{"code":"config_invalid","field":...}}` (CFG-01, AC 2)
Proof: run unit | (pass) [C2]

**C3** - Domain entries `instagram`, `https://instagram.com`, `instagram.com:443`, `instagram.com/x`, `*.instagram.com`, `1.2.3.4`, `[::1]`, `::1` are each rejected naming the entry (CFG-01, AC 3)
Proof: run unit | (pass) [C3]

**C4** - `Instagram.COM.` is stored as `instagram.com` (CFG-01, AC 4)
Proof: run unit | (pass) [C4]

**C5** - A config with an extra key `password` is rejected with `field` naming it (CFG-01, AC 5)
Proof: run unit | (pass) [C5]

**C6** - Key modes 0644, 0640, 0604, 0660 fail with `key_permissions` and exit 2 while a read spy on the key file records zero reads; 0600 and 0400 pass (CFG-01, AC 6)
Proof: run unit | (pass) [C6]

**C7** - `status --json` and `doctor --json` include the absolute `configPath` they used (CFG-01, AC 55)
Proof: run unit | (pass) [C7]

**C60** - `server.hostKey` missing, `MD5:ab:cd...`, padded `SHA256:...=` and a 42-character body are each rejected naming `server.hostKey`; a 43-character `SHA256:` value passes (CFG-01, AC 56)
Proof: run unit | (pass) [C60]

### S2 - Only allowlisted HTTPS hosts leave through the home IP

**C8** - With `instagram.com` allowlisted, `CONNECT instagram.com:443`, `www.instagram.com:443`, `WWW.Instagram.COM:443` and `instagram.com.:443` each get `HTTP/1.1 200 Connection Established` and bytes flow both ways (PRX-01, AC 7)
Proof: run unit | (pass) [C8]

**C9** - `CONNECT evilinstagram.com:443`, `instagram.com.evil.net:443` and `example.org:443` get `403` with zero lookups and zero connections (PRX-01, AC 8)
Proof: run unit | (pass) [C9]

**C10** - `CONNECT instagram.com:80` and `:8443` get `403` with zero lookups and zero connections (PRX-01, AC 9)
Proof: run unit | (pass) [C10]

**C11** - `CONNECT 157.240.1.1:443`, `[2a03:2880::1]:443` and `[::ffff:157.240.1.1]:443` get `403` with zero lookups and zero connections (PRX-01, AC 10, 44 precedence)
Proof: run unit | (pass) [C11]

**C12** - For every listed range the address guard refuses the first and last address and accepts the addresses just outside it (where they are public); it accepts `157.240.1.1`, `2a03:2880::1` and `::ffff:157.240.1.1`, and refuses `::ffff:10.0.0.1`, `::10.0.0.1`, `64:ff9b::a00:1` and `2002:a00:1::` (PRX-01, AC 11)
Proof: run unit | (pass) [C12]

**C13** - The address guard refuses an address inside a prefix assigned to a local interface, including a public IPv6 /64 (PRX-01, AC 11)
Proof: run unit | (pass) [C13]

**C14** - An allowlisted host resolving only to `192.168.1.1` and `::1` gets `403` with zero connections (PRX-01, AC 11)
Proof: run unit | (pass) [C14]

**C15** - An allowlisted host resolving to `[10.0.0.1, 157.240.1.1]` causes exactly one lookup and one connection, to `157.240.1.1:443` (PRX-01, AC 12)
Proof: run unit | (pass) [C15]

**C16** - `GET http://instagram.com/ HTTP/1.1` gets `405` and closes (PRX-01, AC 13)
Proof: run unit | (pass) [C16]

**C17** - A head over 8192 bytes gets `400`; a head not finished within the head timeout gets `408` (PRX-01, AC 14)
Proof: run unit | (pass) [C17]

**C18** - An empty DNS answer gets `502`, a refused outbound connection gets `502`, and a lookup or connect past the timeout gets `504` (PRX-01, AC 15)
Proof: run unit | (pass) [C18]

**C19** - With the default cap, 256 open relays leave the 257th CONNECT with `503`; after one relay closes, the next CONNECT gets `200` (PRX-01, AC 16)
Proof: run unit | (pass) [C19]

**C20** - No file under `src/` calls `listen(`, `createServer(`, `Bun.listen(` or `Bun.serve(`, or constructs `net.Server` (PRX-01, AC 17)
Proof: run unit | (pass) [C20]

**C58** - While `social-tunnel run` is connected as a subprocess, `lsof -a -p <pid> -iTCP -sTCP:LISTEN` prints no socket (its exit 1 with empty output counts as none; the test fails if `lsof` is absent) (PRX-01, AC 17)
Proof: run unit | (pass) [C58]

**C21** - Hosts `insta_gram.com`, `user@instagram.com`, `insta%67ram.com`, a 64-character label and a 254-character name, and ports `+443`, `0443`, `443abc`, `443 `, each get `400` (PRX-01, AC 44)
Proof: run unit | (pass) [C21]

**C22** - A TLS ClientHello, and separately a second `CONNECT example.org:443` request, sent in the same packet as the head both reach upstream byte-for-byte and are never answered by the proxy (PRX-01, AC 45)
Proof: run unit | (pass) [C22]

**C23** - The `403` body is byte-identical for an unlisted host, a wrong port and a private-resolving host, and no refusal body contains a resolved address (PRX-01, AC 46)
Proof: run unit | (pass) [C23]

**C24** - A relay idle past the idle timeout closes both sides (PRX-01, AC 47)
Proof: run unit | (pass) [C24]

**C63** - The exported defaults equal head timeout 10000 ms, DNS/connect timeout 10000 ms, idle 300000 ms, relay cap 256, keepalive 15000 ms × 3, heartbeat 30000 ms, stale 90000 ms (PRX-01, AC 58)
Proof: run unit | (pass) [C63]

### S3 - `run` holds the tunnel open and reports every state change

**C25** - Against an in-process SSH server, the tunnel authenticates with the key, requests `tcpip-forward` on `127.0.0.1:<remotePort>`, and `state.json` goes `connecting` -> `connected` (TUN-01, AC 18, 20)
Proof: run unit | (pass) [C25]

**C26** - `social-tunnel run` as a subprocess against a server whose host key differs from `server.hostKey` sends no auth request, leaves `state.json` at `blocked`/`host_key_mismatch` and exits 13 (TUN-01, AC 19)
Proof: run unit | (pass) [C26]

**C27** - When the server refuses `tcpip-forward`, state is `blocked`/`port_blocked` and the next attempt is scheduled 30 s later (TUN-01, AC 21)
Proof: run unit | (pass) [C27]

**C28** - Closing the server connection gives `disconnected`/`connection_lost` with `retryAt`, then `reconnecting`, then `connected` (TUN-01, AC 22, 23)
Proof: run unit | (pass) [C28]

**C59** - A server that stops answering keepalives gives `disconnected`/`connection_lost` after 3 missed intervals, not before (TUN-01, AC 22)
Proof: run unit | (pass) [C59]

**C29** - Retry delays run 1, 2, 4, 8, 16, 30, 30 s and return to 1 s after a successful connection (TUN-01, AC 23)
Proof: run unit | (pass) [C29]

**C30** - A connection to the forwarded port reaches the proxy handler and an allowlisted CONNECT gets `200` through the tunnel (TUN-01, AC 24)
Proof: run unit | (pass) [C30]

**C31** - `state.json` holds exactly `version, pid, state, reason, since, retryAt, server, remotePort, updatedAt` and is replaced via a temp file and rename (TUN-01, AC 25)
Proof: run unit | (pass) [C31]

**C32** - `social-tunnel run` as a subprocess, sent SIGTERM and in a second run SIGINT, cancels the forward, writes `stopped` and exits 0 (TUN-01, AC 26)
Proof: run unit | (pass) [C32]

**C33** - A second `run` while `state.json` names a live other pid exits 2 with `already_running` (TUN-01, AC 27)
Proof: run unit | (pass) [C33]

**C34** - No line of the private key file appears in stdout, stderr or `state.json` across five paths: a connected `run --json`, a `run` with auth refused, a `run` with a malformed key, `doctor --json` with all hops passing, and `doctor --json` with `ssh_auth` failing (TUN-01, AC 28)
Proof: run unit | (pass) [C34]

**C35** - A forwarded connection announced for `127.0.0.1:<remotePort + 1>` or `0.0.0.0:<remotePort>` is rejected and never reaches the proxy (TUN-01, AC 48)
Proof: run unit | (pass) [C35]

**C36** - Both while `connected` and while retrying in `blocked`/`port_blocked`, `updatedAt` is rewritten at least once per heartbeat interval (TUN-01, AC 49)
Proof: run unit | (pass) [C36]

**C37** - A log line for an invalid host shows no host, and control characters in server text are stripped (TUN-01, AC 50)
Proof: run unit | (pass) [C37]

**C61** - `run --json` stopped by SIGTERM prints exactly one object `{ok, command: "run", state, reason}` on stdout, and every log line is on stderr (TUN-01, AC 57)
Proof: run unit | (pass) [C61]

### S4 - `status` answers in one call

**C38** - Live pid + `connected` exits 0 with `state`, `since`, `server.host`, `remotePort`, `domains` count (STA-01, AC 29)
Proof: run unit | (pass) [C38]

**C39** - Absent file, dead pid with `connected`, and `stopped` each report `stopped` and exit 10 (STA-01, AC 30)
Proof: run unit | (pass) [C39]

**C40** - `connecting`, `disconnected` and `reconnecting` each exit 10 and include `reason` and `retryAt` (STA-01, AC 31)
Proof: run unit | (pass) [C40]

**C41** - `blocked`/`port_blocked` with a live pid exits 11 (STA-01, AC 32)
Proof: run unit | (pass) [C41]

**C42** - `blocked`/`host_key_mismatch` exits 13 with a live pid and with a dead pid (STA-01, AC 33)
Proof: run unit | (pass) [C42]

**C43** - `status --json`, `doctor --json` and a failing `run --json` each print exactly one JSON object and a newline on stdout (STA-01, AC 34)
Proof: run unit | (pass) [C43]

**C44** - A live pid with `updatedAt` older than 90 s reports `stopped`/`stale` and exits 10 (STA-01, AC 51)
Proof: run unit | (pass) [C44]

### S5 - `doctor` names the broken hop and its fix

**C45** - Hops run in order `config, key, server_reachable, ssh_auth, forward, lockdown, egress`; after a `server_reachable` failure the later hops have `ok: false`, `skipped: true` and an empty `fix` (DOC-01, AC 35, 36)
Proof: run unit | (pass) [C45]

**C46** - Every failed hop has `skipped: false` and a non-empty `fix` (DOC-01, AC 36)
Proof: run unit | (pass) [C46]

**C62** - `doctor --json` with an invalid config and with a 0644 key prints a hop list with `config` or `key` failed, no `error` envelope, and exits 2 (DOC-01, AC 36, 41)
Proof: run unit | (pass) [C62]

**C47** - With a live `connected` state, the `forward` hop passes without sending `tcpip-forward` (DOC-01, AC 37)
Proof: run unit | (pass) [C47]

**C48** - With no live run, the `forward` hop sends `tcpip-forward` then `cancel-tcpip-forward` (DOC-01, AC 38)
Proof: run unit | (pass) [C48]

**C49** - The `egress` hop resolves the first domain and connects on 443; an unreachable host fails within the timeout (DOC-01, AC 39)
Proof: run unit | (pass) [C49]

**C50** - `--domain www.instagram.com` adds a passing `domain` hop right after `config`; `--domain example.org` fails it, skips the rest and exits 12 (DOC-01, AC 40)
Proof: run unit | (pass) [C50]

**C51** - A wrong host key fails `ssh_auth` with exit 13 through the same connect function `run` uses (DOC-01, AC 41, 52)
Proof: run unit | (pass) [C51]

**C52** - Exit code per failing hop: `config` 2, `key` 2, `server_reachable` 10, `ssh_auth` 10, `forward` 11, `lockdown` 14, `egress` 10, `domain` 12; all pass 0 (DOC-01, AC 41)
Proof: run unit | (pass) [C52]

**C53** - Table over five servers: one allowing only a shell, one only `sftp`, one only a local forward to `127.0.0.1:22`, one only a remote forward on `<remotePort + 1>`, one refusing all four; the `lockdown` hop fails naming exactly the allowed attempt on the first four and passes on the fifth (DOC-01, AC 53)
Proof: run unit | (pass) [C53]

**C54** - `keyPath` `~/.ssh/id_ed25519` passes the `key` hop with a dedicated-key advice in `detail` (DOC-01, AC 54)
Proof: run unit | (pass) [C54]

### S6 - The CLI never blocks an agent

**C55** - `social-tunnel frobnicate` and `status --bogus` print usage on stderr and exit 2; `--help` and `--version` exit 0 (CLI-01, AC 42)
Proof: run unit | (pass) [C55]

**C56** - With stdin held open and never written, `status` and `run` with an invalid config and `doctor` with a valid config against the in-process server each exit within 5 s; an unexpected exception exits 1 with `error.code` `internal` (CLI-01, AC 43; door 1)
Proof: run unit | (pass) [C56]

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| door 1 exit codes (8) | 0 C38 · 1 C56 · 2 C2 · 10 C39 · 11 C41 · 12 C50 · 13 C42 · 14 C53 | - |
| door 2 `--json` envelope (3 verbs) | `status` C43 · `doctor` C43 · `run` C43, C61 | - |
| door 3 config path sources (6) | flag C1 · env C1 · macOS C1 · Linux XDG C1 · Linux home C1 · Windows C1 | - |
| door 3 schema v1 fields (7) | `version` C2 · `server` C2 · `server.hostKey` C60 · `remotePort` C2 · `keyPath` C6 · `domains` C3 · unknown key C5 | - |
| door 4 no local listener (3) | source scan C20 · runtime socket list C58 · channel-only entry C30 | - |
| door 5 CONNECT-only 443 (2) | method C16 · port C10 | - |
| door 6 `ssh2` under Bun (1) | handshake, key auth and forward C25 | - |
| door 7 `state.json` fields (9) | `version` C31 · `pid` C31 · `state` C31 · `reason` C31 · `since` C31 · `retryAt` C31 · `server` C31 · `remotePort` C31 · `updatedAt` C31 | - |
| door 8 host-key pin (3) | `run` C26 · `doctor` C51 · format C60 | - |
| `social-tunnel run` outcomes (3) | 0 C32 · 2 C33 · 13 C26 | - |
| `social-tunnel status` outcomes (5) | 0 C38 · 10 C39 · 11 C41 · 13 C42 · 2 C2 | - |
| `social-tunnel doctor` outcomes (7) | 0 C52 · 2 C62 · 10 C52 · 11 C52 · 12 C50 · 13 C51 · 14 C53 | - |
| CLI meta outcomes (2) | unknown input 2 C55 · help/version 0 C55 | - |
| `proxy over a forwarded channel` outcomes (8) | 200 C8 · 400 C17 · 403 C9 · 405 C16 · 408 C17 · 502 C18 · 503 C19 · 504 C18 | - |
| refused address ranges (25) | `0/8` C12 · `10/8` C12 · `100.64/10` C12 · `127/8` C12 · `169.254/16` C12 · `172.16/12` C12 · `192.0.0/24` C12 · `192.168/16` C12 · `198.18/15` C12 · `224/4` C12 · `240/4` C12 · `::/128` C12 · `::1` C12 · `100::/64` C12 · `2001::/32` C12 · `64:ff9b:1::/48` C12 · `fc00::/7` C12 · `fe80::/10` C12 · `fec0::/10` C12 · `ff00::/8` C12 · `::/96` C12 · `::ffff:0:0/96` C12 · `64:ff9b::/96` C12 · `2002::/16` C12 · own interface C13 | - |
| T1 request corpus (12) | lookalike C9 · suffix trick C9 · upper case C8 · trailing dot C8 · IPv4 literal C11 · bracketed IPv6 C11 · mapped IPv4 C11 · underscore C21 · userinfo C21 · percent C21 · odd port C21 · smuggled second request C22 | - |
| tunnel states (6) | `connecting` C25 · `connected` C25 · `disconnected` C28, C59 · `reconnecting` C28 · `blocked` C26, C27 · `stopped` C32 | - |
| `status` state mapping (9 cases) | connected C38 · absent C39 · dead pid C39 · stopped C39 · connecting C40 · disconnected C40 · reconnecting C40 · stale C44 · host key mismatch dead pid C42 | - |
| doctor hops (8) | `config` C62 · `domain` C50 · `key` C62, C54 · `server_reachable` C45 · `ssh_auth` C51 · `forward` C47, C48 · `lockdown` C53 · `egress` C49 | - |
| lockdown attempts (4) | shell C53 · sftp C53 · local forward C53 · other remote port C53 | - |
| key-leak paths (5) | connected run C34 · auth refused C34 · malformed key C34 · doctor pass C34 · doctor ssh_auth fail C34 | - |
| shutdown signals (2) | SIGTERM C32 · SIGINT C32 | - |
| backoff steps (7) | 1 s C29 · 2 s C29 · 4 s C29 · 8 s C29 · 16 s C29 · 30 s cap C29 · reset C29 | - |
| startup assembly (2) | CLI subprocess C26, C32, C58 · in-process harness C25 | - |

- Claims naming an outcome, interface or response shape: C2, C8-C19, C21-C23, C26, C32, C38-C44, C50-C53, C55, C58, C61, C62 - each has a proof that crosses the boundary it names
- No other check claims more than the cases its proof enumerates

## Security cases

| ID | Abuse case | Expected | Checks |
| --- | --- | --- | --- |
| SEC-001 | Config smuggles a secret field or an unpinned host key | Config rejected naming the field | C5, C60 |
| SEC-002 | Server process asks the proxy for a non-allowlisted host, port or IP literal | `403`, no lookup, no connection | C9, C10, C11 |
| SEC-003 | Allowlisted name resolves into the home network or a reserved range | `403`, no connection | C12, C13, C14, C15 |
| SEC-004 | Something on the home machine or LAN reaches the proxy without the tunnel | No listening socket exists | C20, C58, C35 |
| SEC-005 | Server presents a different host key (MITM) | No auth sent, exit 13 on `run` and `doctor` | C26, C51 |
| SEC-006 | Private key leaks through output, logs or state | No key line in any captured output | C6, C34 |
| SEC-007 | Malformed or smuggled CONNECT head | `400`/`405`/`408`, trailing bytes never parsed | C16, C17, C21, C22, C23, C37 |
| SEC-008 | Tunnel user can open a shell, sftp or other forwards | `lockdown` hop fails, exit 14 | C53 |
| SEC-009 | Connection flood or slow client exhausts the home machine | `503` past 256 relays, timeouts close stalled sockets | C17, C18, C19, C24, C63 |

## Test policy

The repo has no test guideline yet, so this feature uses these rows; they are not written into the repo's guidelines.

| Code | Required proofs | Coverage expectation |
| --- | --- | --- |
| Decides, reached across a boundary (proxy head parsing, allowlist, address guard, status mapping, doctor hops) | one at the boundary **and** one at its own layer | boundary: contract, wiring and one case per outcome; own layer: one asserted case per table row |
| Decides, not reached across a boundary (backoff, path resolution, config validation) | one at its own layer | one asserted case per row |
| Entry point that decides nothing (`cli.ts` dispatch) | one at the boundary | accepted input, each rejected input, each error path |
| Instrumentation (log writer, JSON printer) | none of its own | covered by its consumer's proof |

Evidence:

- `src/proxy.ts` (planned): 8 outcomes, about 12 branch points -> decides
- `src/address-guard.ts` (planned): 25 refused ranges -> decides
- `src/tunnel.ts` (planned): 6 states, 7 backoff steps -> decides
- closest analogue in the repo: none - first code in the repository

Cost: about 62 tests in 9 files, all `bun test`; SSH tests use an in-process `ssh2` server, network tests use injected resolvers and dialers, so the suite needs no internet and no sshd.

## Swept

- validation: C2, C3, C4, C5, C21, C60
- failure modes: C18, C27, C28, C59
- idempotency: n/a - no request is retried by this tool; a reconnect re-requests the forward, covered by C28
- authorization: C9, C10, C11, C14, C35, C53
- concurrency: C19, C33
- data lifecycle: C31, C44 - `state.json` is replaced atomically and goes stale after 90 s
- dependency failure: C18, C28, C49
- state transitions: C25, C26, C27, C28, C32
- observability: C37, C43, C61 - state and hop results are the observable surface; no metrics in v0.1
- deploy compatibility: n/a - first release; schema `version: 1` in config and state allows later migration
- performance budget: C19, C24, C63 - relay cap and idle timeout bound memory and sockets; no throughput target in v0.1
