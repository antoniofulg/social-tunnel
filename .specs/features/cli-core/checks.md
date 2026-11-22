# CLI core checks

Profile: standard
Risk: C9, C12, C14, C15, C20, C21, C26, C34, C35, C51, C53, C58, C64, C65, C75, C76, C87, C88, C89, C96, C101, C105, C112, C114, C115, C116, C117, C119 - allowlist, address guard, no-listener, host-key pin, single-instance claim, key leakage, channel filter and server lockdown are the safety invariants; a weak test there ships an open proxy, a MITM or a usable server account
Build: `taskpolicy -b nice -n 10 bun run typecheck`
Run unit: `env -u CLAUDECODE taskpolicy -b nice -n 10 bun test`
Plan: `.specs/features/cli-core/plan.md`

119 checks in 6 slices (ids C1-C120; C57 unused; C64-C69 added after verification round 1, C70-C78 after deep review round 1, C79-C84 after round 2, C85-C89 after round 4, C90-C104 after round 5, C105-C111 after round 6, C112-C116 after round 8, C117-C118 after round 9, C119 after round 10, C120 after round 11) · 8 one-way doors · 2 open, of which 0 block

Test names start with the check id in brackets, so `bun test` prints `(pass) [C<n>] ...`. Each id has exactly one test. `CLAUDECODE` is unset because Bun hides per-test pass lines when it is set.

Seams: the proxy and tunnel take their resolver and dialer as parameters; production wires `node:dns` and `node:net`. Tests inject counting fakes, and the fakes are the only resolver and dialer the code under test can reach, so "zero lookups" and "zero connections" are counts on those fakes.

## Checks

### S1 - Config loads or fails with a named field

Complete: C1-C7, C60, C68, C72, C114 - proofs green

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

**C68** - Each of a bad `server.host`, `server.port`, `server.user` or `keyPath` and an unknown `server.password` key exits 2 with `config_invalid` and `field` naming it on `status --json` and `run --json`; `--config` with no value, `--domain` with no value and `--domain` on `status` or `run` print usage on stderr and exit 2 (CFG-01, CLI-01, AC 2, 5, 42)
Proof: run unit | (pass) [C68]

**C72** - `run --json` with a missing key file exits 2 with `key_unreadable`; with a file of garbage, and with a 0600 file holding the public key, it exits 2 with `key_invalid`; `doctor --json` reports each as a failed `key` hop with no `error` envelope and exits 2 (CFG-01, AC 68)
Proof: run unit | (pass) [C72]

**C114** - `loadKey` given a key swapped for a 0644 file between the path check and the open returns `key_permissions` with zero reads; given a key swapped for another file between the descriptor check and the read, it returns the bytes of the file that was checked (CFG-01, AC 91)
Proof: run unit | (pass) [C114]

### S2 - Only allowlisted HTTPS hosts leave through the home IP

Complete: C8-C24, C63, C65, C69, C70, C79-C82, C85, C86, C89-C93, C98-C100 - proofs green; C58 needs the S3 `run` and is marked there

**C8** - With `instagram.com` allowlisted, `CONNECT instagram.com:443`, `www.instagram.com:443`, `WWW.Instagram.COM:443` and `instagram.com.:443` each get `HTTP/1.1 200 Connection Established` and bytes flow both ways (PRX-01, AC 7)
Proof: run unit | (pass) [C8]

**C9** - `CONNECT evilinstagram.com:443`, `instagram.com.evil.net:443` and `example.org:443` get `403` with zero lookups and zero connections (PRX-01, AC 8)
Proof: run unit | (pass) [C9]

**C10** - `CONNECT instagram.com:80` and `:8443` get `403` with zero lookups and zero connections (PRX-01, AC 9, 94)
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

**C21** - Hosts `insta_gram.com`, `user@instagram.com`, `insta%67ram.com`, a 64-character label and a 254-character name, and ports `+443`, `0443`, `443abc`, `443 `, each get `400` (PRX-01, AC 44, 94)
Proof: run unit | (pass) [C21]

**C22** - A TLS ClientHello, and separately a second `CONNECT example.org:443` request, sent in the same packet as the head both reach upstream byte-for-byte and are never answered by the proxy (PRX-01, AC 45)
Proof: run unit | (pass) [C22]

**C23** - The `403` body is byte-identical for an unlisted host, a wrong port and a private-resolving host, and no refusal body contains a resolved address (PRX-01, AC 46)
Proof: run unit | (pass) [C23]

**C24** - A relay idle past the idle timeout closes both sides (PRX-01, AC 47)
Proof: run unit | (pass) [C24]

**C63** - The exported defaults equal head timeout 10000 ms, DNS/connect timeout 10000 ms, idle 300000 ms, relay cap 256, keepalive 15000 ms × 3, heartbeat 30000 ms, stale 90000 ms (PRX-01, AC 58)
Proof: run unit | (pass) [C63]

**C65** - Through the proxy handler, an allowlisted host resolving only to addresses inside an injected local interface prefix (a public IPv6 /64 and a public IPv4 /24) gets `403` with zero connections; with no such interface the same answer is dialled (PRX-01, AC 11)
Proof: run unit | (pass) [C65]

**C69** - With 256 channels open that have not finished their head, the 257th CONNECT gets `503`; after one closes, the next CONNECT gets `200` (PRX-01, AC 16, 61)
Proof: run unit | (pass) [C69]

**C70** - An 8 MiB response whose origin closes right after sending arrives byte-exact (same length and SHA-256) at a client of the forwarded port, through the in-process tunnel, in each of 6 consecutive relays (PRX-01, AC 7, 66)
Proof: run unit | (pass) [C70]

**C79** - With 200 KiB already handed to an upstream that takes one chunk every 2 ms, the client closing first still leaves the upstream with all 204800 bytes and a finished write side before it is closed (PRX-01, AC 66)
Proof: run unit | (pass) [C79]

**C80** - With the client gone and an upstream that never completes a write but keeps sending, the upstream is not closed at a third of the idle timeout and is closed within three idle timeouts (PRX-01, AC 47, 66)
Proof: run unit | (pass) [C80]

**C81** - A channel that closes while its DNS lookup is pending causes zero connections when the lookup then answers; the same lookup answered on an open channel connects once (PRX-01, AC 8-12)
Proof: run unit | (pass) [C81]

**C82** - A relay carrying bytes only client-to-upstream, and separately only upstream-to-client, stays open for three idle timeouts and closes once quiet (PRX-01, AC 47)
Proof: run unit | (pass) [C82]

**C85** - Through the in-process tunnel, on a real `ssh2` channel: a forwarded channel the server closes, and separately one whose SSH connection is destroyed, while its DNS lookup is pending causes zero connections and no logged request when the lookup then answers; the same lookup answered on an open channel connects once and logs `200` (PRX-01, AC 73)
Proof: run unit | (pass) [C85]

**C86** - Through the in-process tunnel with a server that opens every channel with a send window of zero, relay cap 1 and head timeout 300 ms: a `503`, a `408` and a `403` channel are still open at a third of the timeout after the refusal, each is closed within the bound (the first two within four timeouts of opening), the server receives zero bytes and nothing is dialled (PRX-01, AC 74)
Proof: run unit | (pass) [C86]

**C89** - The address guard refuses `::ffff:0:127.0.0.1`, `::ffff:0:7f00:1`, `::ffff:0:10.0.0.1`, `::ffff:0:192.168.1.1`, `::ffff:0:169.254.169.254` and a translated address inside an injected interface prefix, and accepts `::ffff:0:157.240.1.1` (PRX-01, AC 77)
Proof: run unit | (pass) [C89]

**C90** - Through the in-process tunnel with relay cap 2, four consecutive relays to a loopback origin each get `200` and every forwarded channel reports its close, for an origin that resets the connection, one that closes it after sending, and one that stays silent past a 150 ms idle timeout (PRX-01, AC 78)
Proof: run unit | (pass) [C90]

**C91** - With a response still queued for a client that takes no more bytes, upstream closed and the client still sending every 20 ms, the channel is not closed at a third of the idle timeout and is closed within three idle timeouts (PRX-01, AC 78)
Proof: run unit | (pass) [C91]

**C92** - With relay cap 1 and a channel that emits no `close` event when the proxy closes it, the next CONNECT gets `503` while the relay is open and `200` after upstream closes, and separately after the idle timeout (PRX-01, AC 78)
Proof: run unit | (pass) [C92]

**C93** - A dial still pending at the connect timeout gets `504` and its abort signal is raised then, not before; a dial that completes is never aborted; the production dialer, aborted before its loopback connection is up, rejects and leaves zero open connections at the listener, and left alone connects (PRX-01, AC 79)
Proof: run unit | (pass) [C93]

**C98** - Through the in-process tunnel with relay cap 1, on a real `ssh2` channel: when the server closes the forwarded channel, and separately when the SSH connection is destroyed, while the outbound connection is pending, the connection that then completes is closed and no request is logged; the next forwarded CONNECT gets `200` (PRX-01, AC 73)
Proof: run unit | (pass) [C98]

**C99** - A connection that completes after its dial timed out with `504` is closed, receives zero bytes, and the only logged request is the `504` (PRX-01, AC 73)
Proof: run unit | (pass) [C99]

**C100** - With relay cap 1 and a peer that takes nothing, a channel refused with `405` is still open when the next CONNECT gets `200`, and is closed once the 300 ms head timeout has passed (PRX-01, AC 74)
Proof: run unit | (pass) [C100]

### S3 - `run` holds the tunnel open and reports every state change

Complete: C25-C33, C35-C37, C59, C61, C66, C67, C71, C78, C83, C94, C95, C101-C103, C106-C108, C111-C113, C115-C120 and C58 (S2) - proofs green; C34 covers two `doctor` paths and is marked with S5

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

**C66** - `run` with a `state.json` naming a live other pid whose `updatedAt` is 91 s old starts and reaches the server; the same file 60 s old exits 2 with `already_running` (TUN-01, AC 27, 60)
Proof: run unit | (pass) [C66]

**C67** - The forward filter accepts `127.0.0.1:<remotePort>` and rejects another port, `0.0.0.0`, `localhost`, `::1` and port 0 (TUN-01, AC 48)
Proof: run unit | (pass) [C67]

**C71** - A server that refuses the key gives `connecting` -> `disconnected`/`auth_failed` with `retryAt` one backoff step after `since`, and `status --json` then exits 10 with `reason` `auth_failed` (TUN-01, AC 62)
Proof: run unit | (pass) [C71]

**C78** - `sanitize` removes ESC, BEL, DEL, U+009B, U+200B, U+200E, U+200F, U+202A, U+202E, U+2028, U+2029, U+2066, U+2069 and U+FEFF, and leaves accented and CJK text unchanged (TUN-01, AC 50, 70)
Proof: run unit | (pass) [C78]

**C83** - `sanitize` removes U+00AD, U+061C, U+2060-U+2064, U+E0000, U+E0001, U+E0041 and U+E007F, and keeps U+00AC, U+00AE, U+061B, U+061D, U+205F, U+E0080 and U+1F600 (TUN-01, AC 71)
Proof: run unit | (pass) [C83]

**C94** - Against a server whose host key differs from the pin, the tunnel ends with `blocked`/`host_key_mismatch`; a `stop()` after that writes no further state, `state.json` still holds `blocked`/`host_key_mismatch` and `status --json` exits 13 (TUN-01, AC 80)
Proof: run unit | (pass) [C94]

**C95** - With a server that refuses the forward and a 60 ms blocked retry, the second and third `blocked`/`port_blocked` writes carry the first one's `since` while `retryAt` increases each time, and `status --json` exits 11 with that `since` (TUN-01, AC 81)
Proof: run unit | (pass) [C95]

**C101** - With `ssh2` made to register forwards for `127.0.0.1:<remotePort + 1>` and `0.0.0.0:<remotePort>` that the tunnel never requested, the server's forwarded connections for both reach the tunnel's handler and are rejected, each with the log line `rejected a forwarded connection for an unexpected address`, and never reach the proxy; the expected forward is accepted with no such line (TUN-01, AC 48)
Proof: run unit | (pass) [C101]

**C102** - With a server that refuses the forward and a 60 ms blocked retry, the server receives at least three `tcpip-forward` requests on at least three connections while every state written after `connecting` is `blocked`/`port_blocked` (TUN-01, AC 21)
Proof: run unit | (pass) [C102]

**C103** - `stop()` while a blocked retry is pending calls the retry's cancel function once and writes `stopped`; running the retry callback afterwards opens no SSH connection and leaves the state `stopped` (TUN-01, AC 26)
Proof: run unit | (pass) [C103]

**C106** - With the server down for three attempts (delays 1, 2, 4 s), then back with the forward refused (`blocked`/`port_blocked`, 30 s), then down again, the next delay is 1 s (TUN-01, AC 86)
Proof: run unit | (pass) [C106]

**C107** - `stop()` called while the first SSH connection is still being made writes `connecting` -> `stopped`; once that connection has authenticated the server has received no `tcpip-forward` request and `state.json` is still `stopped` (TUN-01, AC 26)
Proof: run unit | (pass) [C107]

**C108** - With a server that never answers the forward request, a connection closed by the server while the request is pending gives exactly `connecting` -> `disconnected`/`connection_lost` and one scheduled retry, never `blocked`/`port_blocked` (TUN-01, AC 22)
Proof: run unit | (pass) [C108]

**C111** - `DEFAULTS.stopWaitMs` is 2000; a connected tunnel given a 100 ms bound whose server has stopped reading finishes `stop()` within 1 s and writes `stopped` (TUN-01, AC 89)
Proof: run unit | (pass) [C111]

**C112** - Two `social-tunnel run --json` subprocesses started at once on one config: one exits 2 with `already_running`, the server sees one client and one `tcpip-forward`, `state.json` names the other's pid, and after SIGTERM it exits 0 and `run.lock` is gone (TUN-01, AC 90)
Proof: run unit | (pass) [C112]

**C113** - A `run.lock` naming a dead pid is taken over (`run` reaches the server and removes the lock on exit); a fresh `run.lock` naming a live pid with no `state.json` exits 2 with `already_running` and no connection (TUN-01, AC 90)
Proof: run unit | (pass) [C113]

**C116** - Four `social-tunnel run --json` subprocesses started at once over one `run.lock` naming a dead pid: the server sees one client and one `tcpip-forward`, the other three exit 2 with `already_running`, and the one that connected exits 0 on SIGTERM (TUN-01, AC 92)
Proof: run unit | (pass) [C116]

**C117** - With a 50 ms heartbeat and a 400 ms stale threshold, a connected in-process `run` whose `state.json` is replaced by a directory (so it stays missing) still holds `run.lock` 1.2 s later: a second `run` exits 2 with `already_running` and the server sees one client and one `tcpip-forward` (TUN-01, AC 93)
Proof: run unit | (pass) [C117]

**C118** - A text-mode log line prints `example.org` bare and quotes `a b`, `k=v`, `say "x"`, a backslash and an empty value as JSON strings that parse back to the input; a server banner `hi state=stopped reason="forged" pid=1` logged by a connecting tunnel parses as one field `text` holding that whole banner (TUN-01, AC 95)
Proof: run unit | (pass) [C118]

**C119** - A `run.lock` holding nothing, `garbage` or `0` is taken over at once: each of three `run`s reaches the in-process server (the wrong host-key pin ends it with exit 13), the server sees one more client each time, and the lock is gone afterwards (TUN-01, AC 96)
Proof: run unit | (pass) [C119]

**C120** - A fresh `run.lock` naming a live pid is not taken over when that pid's `state.json` says `stopped` or is stale: `run` exits 2 with `already_running`, the server sees no client and the lock stays (TUN-01, AC 97)
Proof: run unit | (pass) [C120]

**C115** - The key file's first 32 bytes as a JSON-serialised Buffer number array, and its first 96 bytes as base64 in two 48-byte blocks, appear nowhere in stdout, stderr or `state.json` of a connected `run --json`, a `run` with auth refused, `doctor --json` with all hops passing and `doctor --json` with `ssh_auth` failing; the detector finds both forms when they are printed (TUN-01, AC 28)
Proof: run unit | (pass) [C115]

### S4 - `status` answers in one call

Complete: C38-C44, C73, C104 - proofs green

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

**C73** - With a live `connected` state.json naming another `remotePort`, server host or server port than the config, `status --json` exits 10 with `stopped`/`config_changed`, and the `doctor` `forward` hop sends `tcpip-forward` then `cancel-tcpip-forward` for the config's port (STA-01, DOC-01, AC 63)
Proof: run unit | (pass) [C73]

**C104** - With U+009B, U+202E and U+200B placed in an unknown config key, in `reason` and `since` of `state.json`, and in a domain entry, the stdout of `status --json` (both cases) and `doctor --json` holds none of those characters, and the parsed `error.field`, `error.message`, `reason` and `since` are the text without them (STA-01, AC 84)
Proof: run unit | (pass) [C104]

### S5 - `doctor` names the broken hop and its fix

Complete: C45-C54, C62, C64, C74-C76, C84, C87, C88, C96, C97, C105, C109, C110 and C34 (S3) - proofs green

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

**C64** - A server that refuses a PTY but runs a shell fails the `lockdown` hop naming exactly `shell`; one that runs `exec` fails naming exactly `exec`; one that grants both requests but runs only its forced command passes (DOC-01, AC 59)
Proof: run unit | (pass) [C64]

**C74** - For a 0644 key whose path holds a space, a single quote and `; touch pwned #`, the `key` hop's fix run verbatim by `sh -c` sets the key to 0600 and creates no file; a missing config's fix says to create it; the `lockdown` fix names `restrict`, `permitlisten="127.0.0.1:<remotePort>"`, `command=`, `PermitOpen none`, `PermitTTY no` and `ForceCommand` (DOC-01, AC 67)
Proof: run unit | (pass) [C74]

**C75** - A server whose shell or exec runs commands but rejects `$((...))` as fish and tcsh do fails the `lockdown` hop with exit 14 naming exactly `shell` or `exec` (DOC-01, AC 64)
Proof: run unit | (pass) [C75]

**C76** - A server that permits a local forward but answers "connect failed" fails `lockdown` naming `local forward`, and the probe targets `127.0.0.1:<server.port>`; an administratively prohibited forward passes; a server refusing `<remotePort + 1>` but granting `<remotePort + 2>` fails naming `remote forward` (DOC-01, AC 65)
Proof: run unit | (pass) [C76]

**C84** - The `lockdown` hop's fix contains `AllowStreamLocalForwarding no` (DOC-01, AC 72)
Proof: run unit | (pass) [C84]

**C87** - Against servers that grant a remote forward on any port, with the SSH connection destroyed at the first session request, and separately while the forward on another port waits: `doctor` exits 10, the `forward` hop passed, the `lockdown` hop is failed and not skipped with a detail naming the closed connection and not "refused" and a fix saying to run doctor again, and `egress` is skipped (DOC-01, AC 75)
Proof: run unit | (pass) [C87]

**C88** - With `remotePort` 65535 and 65534 against a server granting every port 1-65535, `lockdown` fails with exit 14 naming `remote forward` and the only other port requested is `<remotePort - 1>`; with 65535 and a server granting only 65533 besides, it fails and the requests are 65535, 65534, 65533 (DOC-01, AC 76)
Proof: run unit | (pass) [C88]

**C96** - With a 300 ms timeout against a server that would run a shell and grant every forward but stops reading at the first session request, `doctor` exits 10, `forward` passed, `lockdown` is failed and not skipped with a detail saying the server did not answer (not "refused", not "closed") and a fix saying to run doctor again, and `egress` is skipped; a locked-down server whose forced command never prints or exits passes `lockdown` with exit 0 (DOC-01, AC 82)
Proof: run unit | (pass) [C96]

**C97** - With a server that destroys the connection when the tunnel forward is requested, and separately one that never answers that request (300 ms timeout), `doctor` exits 10, `ssh_auth` passed, the `forward` hop is failed with a detail naming the closed or unanswering connection and not "refused", its fix says to run doctor again and does not mention `permitlisten`, and `lockdown` is skipped (DOC-01, AC 83)
Proof: run unit | (pass) [C97]

**C105** - Against a locked-down server whose forced command is granted for shell, exec and the `sftp` subsystem and never prints or exits (300 ms timeout), `doctor` exits 0, `lockdown` passes, the local-forward probe reached the server and the forward on `<remotePort + 1>` was requested, and `egress` ran (DOC-01, AC 85)
Proof: run unit | (pass) [C105]

**C109** - The `lockdown` hop's fix contains `PermitListen 127.0.0.1:<remotePort>` and `GatewayPorts no` (DOC-01, AC 87)
Proof: run unit | (pass) [C109]

**C110** - With a 2 s timeout and a dialer that never connects, once for the SSH port and once for 443, `doctor` exits 10 failing `server_reachable` and `egress` respectively, and each pending dial's abort signal has fired (DOC-01, AC 88)
Proof: run unit | (pass) [C110]

### S6 - The CLI never blocks an agent

Complete: C55, C56, C77 - proofs green

**C55** - `social-tunnel frobnicate` and `status --bogus` print usage on stderr and exit 2; `--help` and `--version` exit 0 (CLI-01, AC 42)
Proof: run unit | (pass) [C55]

**C56** - With stdin held open and never written, `status` and `run` with an invalid config and `doctor` with a valid config against the in-process server each exit within 5 s; an unexpected exception exits 1 with `error.code` `internal` (CLI-01, AC 43; door 1)
Proof: run unit | (pass) [C56]

**C77** - `status` without `--json` prints `state`, `since`, `retry at`, `server`, `remote port` and `domains` lines with an escape character in `reason` removed and exits 10 for `disconnected`; `doctor` without `--json` prints `ok`, `FAIL` with its `fix`, and `skip` lines and exits 2 for a 0644 key (STA-01, DOC-01, AC 29, 36)
Proof: run unit | (pass) [C77]

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| door 1 exit codes (8) | 0 C38 · 1 C56 · 2 C2 · 10 C39 · 11 C41 · 12 C50 · 13 C42 · 14 C53 | - |
| door 2 `--json` envelope (3 verbs) | `status` C43 · `doctor` C43 · `run` C43, C61 | - |
| door 3 config path sources (6) | flag C1 · env C1 · macOS C1 · Linux XDG C1 · Linux home C1 · Windows C1 | - |
| door 3 schema v1 fields (11) | `version` C2 · `server` C2 · `server.host` C68 · `server.port` C68 · `server.user` C68 · `server.hostKey` C60 · `remotePort` C2 · `keyPath` C6, C68 · `domains` C3 · unknown key C5 · unknown `server.*` key C68 | - |
| door 4 no local listener (3) | source scan C20 · runtime socket list C58 · channel-only entry C30 | - |
| door 5 CONNECT-only 443 (2) | method C16 · port C10 | - |
| door 6 `ssh2` under Bun (1) | handshake, key auth and forward C25 | - |
| door 7 `state.json` fields (9) | `version` C31 · `pid` C31 · `state` C31 · `reason` C31 · `since` C31 · `retryAt` C31 · `server` C31 · `remotePort` C31 · `updatedAt` C31 | - |
| door 8 host-key pin (3) | `run` C26 · `doctor` C51 · format C60 | - |
| `social-tunnel run` outcomes (3) | 0 C32 · 2 C33, C66, C112, C113, C116, C117, C120 · 13 C26, C119 | - |
| `social-tunnel status` outcomes (5) | 0 C38 · 10 C39 · 11 C41 · 13 C42, C94 · 2 C2 | - |
| `social-tunnel doctor` outcomes (7) | 0 C52, C105 · 2 C62 · 10 C52, C87, C96, C97 · 11 C52 · 12 C50 · 13 C51 · 14 C53 | - |
| CLI meta outcomes (2) | unknown input 2 C55, C68 · help/version 0 C55 | - |
| `proxy over a forwarded channel` outcomes (8) | 200 C8 · 400 C17 · 403 C9 · 405 C16 · 408 C17 · 502 C18 · 503 C19, C69, C92 · 504 C18, C93 | - |
| refused address ranges (26) | `0/8` C12 · `10/8` C12 · `100.64/10` C12 · `127/8` C12 · `169.254/16` C12 · `172.16/12` C12 · `192.0.0/24` C12 · `192.168/16` C12 · `198.18/15` C12 · `224/4` C12 · `240/4` C12 · `::/128` C12 · `::1` C12 · `100::/64` C12 · `2001::/32` C12 · `64:ff9b:1::/48` C12 · `fc00::/7` C12 · `fe80::/10` C12 · `fec0::/10` C12 · `ff00::/8` C12 · `::/96` C12 · `::ffff:0:0/96` C12 · `::ffff:0:0:0/96` C89 · `64:ff9b::/96` C12 · `2002::/16` C12 · own interface C13, C65 | - |
| T1 request corpus (12) | lookalike C9 · suffix trick C9 · upper case C8 · trailing dot C8 · IPv4 literal C11 · bracketed IPv6 C11 · mapped IPv4 C11 · underscore C21 · userinfo C21 · percent C21 · odd port C21 · smuggled second request C22 | - |
| tunnel states (6) | `connecting` C25 · `connected` C25 · `disconnected` C28, C59 · `reconnecting` C28 · `blocked` C26, C27 · `stopped` C32 | - |
| `status` state mapping (9 cases) | connected C38 · absent C39 · dead pid C39 · stopped C39 · connecting C40 · disconnected C40 · reconnecting C40 · stale C44 · host key mismatch dead pid C42 | - |
| doctor hops (8) | `config` C62 · `domain` C50 · `key` C62, C54 · `server_reachable` C45 · `ssh_auth` C51 · `forward` C47, C48 · `lockdown` C53 · `egress` C49 | - |
| lockdown attempts (6) | shell C53 · shell without PTY C64, C75 · exec C64, C75 · sftp C53, C105 · local forward C53, C76 · other remote port C53, C76, C88 | - |
| `--json` reason and error codes (12) | `host_key_mismatch` C26 · `port_blocked` C27 · `connection_lost` C28 · `auth_failed` C71 · `stale` C44 · `config_changed` C73 · `config_invalid` C2 · `key_permissions` C6 · `key_unreadable` C72 · `key_invalid` C72 · `already_running` C33, C112, C113, C116, C117, C120 · `internal` C56 | - |
| key-leak paths (5) | connected run C34, C115 · auth refused C34, C115 · malformed key C34 · doctor pass C34, C115 · doctor ssh_auth fail C34, C115 | - |
| shutdown paths (5) | SIGTERM C32 · SIGINT C32 · pending retry cancelled C103 · stop during connect C107 · server ignores the cancel C111 | - |
| backoff steps (7) | 1 s C29 · 2 s C29 · 4 s C29 · 8 s C29 · 16 s C29 · 30 s cap C29 · reset C29, C106 | - |
| startup assembly (2) | CLI subprocess C26, C32, C58 · in-process harness C25 | - |

- Claims naming an outcome, interface or response shape: C2, C8-C19, C21-C23, C26, C32, C38-C44, C50-C53, C55, C58, C61, C62, C64-C66, C68-C77, C85-C88, C90, C94, C96-C100, C104, C105, C110, C112, C113, C116, C117 - each has a proof that crosses the boundary it names
- No other check claims more than the cases its proof enumerates

## Security cases

| ID | Abuse case | Expected | Checks |
| --- | --- | --- | --- |
| SEC-001 | Config smuggles a secret field or an unpinned host key | Config rejected naming the field | C5, C60 |
| SEC-002 | Server process asks the proxy for a non-allowlisted host, port or IP literal | `403`, no lookup, no connection | C9, C10, C11 |
| SEC-003 | Allowlisted name resolves into the home network or a reserved range | `403`, no connection | C12, C13, C14, C15, C65, C89 |
| SEC-004 | Something on the home machine or LAN reaches the proxy without the tunnel | No listening socket exists | C20, C58, C35, C67, C101 |
| SEC-005 | Server presents a different host key (MITM) | No auth sent, exit 13 on `run` and `doctor` | C26, C51 |
| SEC-006 | Private key leaks through output, logs or state | No key line in any captured output | C6, C34, C114, C115 |
| SEC-007 | Malformed or smuggled CONNECT head | `400`/`405`/`408`, trailing bytes never parsed | C16, C17, C21, C22, C23, C37 |
| SEC-008 | Tunnel user can open a shell, sftp or other forwards | `lockdown` hop fails, exit 14 | C53, C64, C75, C76, C84, C87, C88, C96, C105, C109 |
| SEC-009 | Connection flood or slow client exhausts the home machine | `503` past 256 relays, timeouts close stalled sockets | C17, C18, C19, C24, C63, C69, C80, C82, C85, C86, C90, C91, C92, C93, C98, C99, C100, C110, C112, C113, C116, C117, C119, C120 |
| SEC-010 | Server-, request- or config-supplied text carries terminal control characters or shell syntax into output a person or agent acts on | Characters stripped; printed commands quoted | C37, C74, C78, C83, C104, C118 |

## Test policy

The repo has no test guideline yet, so this feature uses these rows; they are not written into the repo's guidelines.

| Code | Required proofs | Coverage expectation |
| --- | --- | --- |
| Decides, reached across a boundary (proxy head parsing, allowlist, address guard, status mapping, doctor hops) | one at the boundary **and** one at its own layer | boundary: contract, wiring and one case per outcome; own layer: one asserted case per table row |
| Decides, not reached across a boundary (backoff, path resolution, config validation) | one at its own layer | one asserted case per row |
| Entry point that decides nothing (`cli.ts` dispatch) | one at the boundary | accepted input, each rejected input, each error path |
| Instrumentation (log writer, JSON printer) | none of its own | covered by its consumer's proof |

Evidence:

- `src/proxy.ts`: 8 outcomes, about 12 branch points -> decides
- `src/address-guard.ts`: 25 refused ranges -> decides
- `src/tunnel.ts`: 6 states, 7 backoff steps -> decides
- closest analogue in the repo: none - these modules are the first of their kind here

Cost: about 110 tests in 10 files, all `bun test`; SSH tests use an in-process `ssh2` server, network tests use injected resolvers and dialers, so the suite needs no internet and no sshd.

## Swept

- validation: C2, C3, C4, C5, C21, C60, C68, C72, C114
- failure modes: C18, C27, C28, C59, C70, C71, C79, C80, C81, C85, C86, C87, C90, C91, C92, C93, C96, C97, C98, C99, C100, C105, C106, C108, C110, C111
- idempotency: n/a - no request is retried by this tool; a reconnect re-requests the forward, covered by C28
- authorization: C9, C10, C11, C14, C35, C53, C64, C65, C67, C75, C76, C88, C89, C101, C105
- concurrency: C19, C33, C66, C69, C90, C92, C100, C107, C108, C112, C113, C116, C117, C119, C120
- data lifecycle: C31, C44, C113 - `state.json` is replaced atomically and goes stale after 90 s
- dependency failure: C18, C28, C49, C93, C110
- state transitions: C25, C26, C27, C28, C32, C94, C95, C102, C103, C106, C107, C108
- observability: C37, C43, C61, C73, C77, C78, C95, C104, C118 - state and hop results are the observable surface; no metrics in v0.1
- deploy compatibility: n/a - first release; schema `version: 1` in config and state allows later migration
- performance budget: C19, C24, C63, C86, C111 - relay cap and idle timeout bound memory and sockets; no throughput target in v0.1
