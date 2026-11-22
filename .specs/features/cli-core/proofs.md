# cli-core proofs

**HEAD**: d9d4133
**Shell**: /bin/sh
**Result**: 88 pass, 0 fail

| Proof | Result | Line |
| --- | --- | --- |
| C1: run unit / (pass) [C1] | pass | (pass) [C1] config path resolves flag, then env, then the platform config dir [0.67ms] |
| C2: run unit / (pass) [C2] | pass | (pass) [C2] status and run exit 2 with a config_invalid envelope for missing, non-JSON and schema-in |
| C3: run unit / (pass) [C3] | pass | (pass) [C3] domain entries that are not bare hostnames are rejected naming the entry [52.90ms] |
| C4: run unit / (pass) [C4] | pass | (pass) [C4] Instagram.COM. is stored as instagram.com [1.07ms] |
| C5: run unit / (pass) [C5] | pass | (pass) [C5] a config with an extra key password is rejected naming it [3.39ms] |
| C6: run unit / (pass) [C6] | pass | (pass) [C6] a key readable or writable by group or others fails with key_permissions before any read |
| C7: run unit / (pass) [C7] | pass | (pass) [C7] status --json and doctor --json include the absolute configPath they used [1.82ms] |
| C60: run unit / (pass) [C60] | pass | (pass) [C60] server.hostKey must be SHA256: plus 43 unpadded base64 characters [8.30ms] |
| C68: run unit / (pass) [C68] | pass | (pass) [C68] bad server fields, keyPath, unknown server keys and misplaced flags are rejected [51.26 |
| C72: run unit / (pass) [C72] | pass | (pass) [C72] a missing key exits 2 with key_unreadable, and a non-private-key file with key_invalid  |
| C8: run unit / (pass) [C8] | pass | (pass) [C8] CONNECT to an allowlisted host on 443 gets 200 and relays both ways [27.96ms] |
| C9: run unit / (pass) [C9] | pass | (pass) [C9] CONNECT to a host off the allowlist gets 403 with no lookup and no connection [17.49ms] |
| C10: run unit / (pass) [C10] | pass | (pass) [C10] CONNECT to a port other than 443 gets 403 with no lookup and no connection [11.84ms] |
| C11: run unit / (pass) [C11] | pass | (pass) [C11] CONNECT to an IP literal gets 403 with no lookup and no connection [20.87ms] |
| C12: run unit / (pass) [C12] | pass | (pass) [C12] the address guard refuses both ends of every listed range and accepts the neighbours [0 |
| C13: run unit / (pass) [C13] | pass | (pass) [C13] the address guard refuses addresses inside a prefix of a local interface [0.12ms] |
| C14: run unit / (pass) [C14] | pass | (pass) [C14] an allowlisted host resolving only to private addresses gets 403 with no connection [6. |
| C15: run unit / (pass) [C15] | pass | (pass) [C15] a host resolving to a private and a public address is dialled once, at the public addre |
| C16: run unit / (pass) [C16] | pass | (pass) [C16] a GET request gets 405 and the channel closes [6.16ms] |
| C17: run unit / (pass) [C17] | pass | (pass) [C17] a head over 8192 bytes gets 400 and an unfinished head gets 408 [65.60ms] |
| C18: run unit / (pass) [C18] | pass | (pass) [C18] DNS and connect failures get 502, and timeouts get 504 [109.71ms] |
| C19: run unit / (pass) [C19] | pass | (pass) [C19] with the default cap the 257th relay gets 503 until one closes [202.01ms] |
| C20: run unit / (pass) [C20] | pass | (pass) [C20] no file under src/ opens a listening socket [1.34ms] |
| C58: run unit / (pass) [C58] | pass | (pass) [C58] a connected run holds no listening TCP socket [393.62ms] |
| C21: run unit / (pass) [C21] | pass | (pass) [C21] malformed hosts and ports get 400 [59.37ms] |
| C22: run unit / (pass) [C22] | pass | (pass) [C22] bytes sent with the head reach upstream untouched and are never answered [54.78ms] |
| C23: run unit / (pass) [C23] | pass | (pass) [C23] the 403 body is identical for every refusal reason and names no resolved address [70.57 |
| C24: run unit / (pass) [C24] | pass | (pass) [C24] a relay idle past the idle timeout closes both sides [1293.07ms] |
| C63: run unit / (pass) [C63] | pass | (pass) [C63] the shipped defaults match the plan [12.86ms] |
| C65: run unit / (pass) [C65] | pass | (pass) [C65] the proxy refuses a host that resolves only into a local interface prefix [61.30ms] |
| C69: run unit / (pass) [C69] | pass | (pass) [C69] channels still sending their head count against the relay cap [66.75ms] |
| C70: run unit / (pass) [C70] | pass | (pass) [C70] a multi-megabyte response arrives byte-exact through the tunnel when upstream closes af |
| C79: run unit / (pass) [C79] | pass | (pass) [C79] bytes already handed to a slow upstream are delivered after the client closes first [52 |
| C80: run unit / (pass) [C80] | pass | (pass) [C80] a flush that cannot finish is cut off by the idle timeout, even while upstream keeps se |
| C81: run unit / (pass) [C81] | pass | (pass) [C81] a channel that closes during the DNS lookup causes no outbound connection [86.43ms] |
| C82: run unit / (pass) [C82] | pass | (pass) [C82] traffic in one direction alone keeps a relay open past the idle timeout [2404.03ms] |
| C85: run unit / (pass) [C85] | pass | (pass) [C85] on the tunnel's SSH channel, a channel closed or a connection lost during the DNS looku |
| C86: run unit / (pass) [C86] | pass | (pass) [C86] a refusal the SSH peer never takes is closed once the head timeout has passed [945.20ms |
| C89: run unit / (pass) [C89] | pass | (pass) [C89] the address guard judges an IPv4-translated address (::ffff:0:a.b.c.d) by its IPv4 addr |
| C25: run unit / (pass) [C25] | pass | (pass) [C25] the tunnel authenticates with the key, requests the forward and state goes connecting - |
| C26: run unit / (pass) [C26] | pass | (pass) [C26] run against a server with another host key sends no auth request, records the mismatch  |
| C27: run unit / (pass) [C27] | pass | (pass) [C27] a refused forward gives blocked/port_blocked and the next attempt 30 s later [63.86ms] |
| C28: run unit / (pass) [C28] | pass | (pass) [C28] closing the server connection gives disconnected/connection_lost, reconnecting, connect |
| C59: run unit / (pass) [C59] | pass | (pass) [C59] unanswered keepalives give disconnected/connection_lost after 3 missed intervals, not b |
| C29: run unit / (pass) [C29] | pass | (pass) [C29] retry delays run 1, 2, 4, 8, 16, 30, 30 s and return to 1 s after a connection [57.24ms |
| C30: run unit / (pass) [C30] | pass | (pass) [C30] a connection to the forwarded port reaches the proxy and an allowlisted CONNECT gets 20 |
| C31: run unit / (pass) [C31] | pass | (pass) [C31] state.json holds exactly the nine fields and is replaced through a temp file and rename |
| C32: run unit / (pass) [C32] | pass | (pass) [C32] run stopped by SIGTERM or SIGINT cancels the forward, writes stopped and exits 0 [1181. |
| C33: run unit / (pass) [C33] | pass | (pass) [C33] a second run while state.json names a live other pid exits 2 with already_running [8.28 |
| C34: run unit / (pass) [C34] | pass | (pass) [C34] no line of the private key appears in stdout, stderr or state.json on five paths [847.6 |
| C35: run unit / (pass) [C35] | pass | (pass) [C35] a forwarded connection for another port or bind address is rejected before the proxy [2 |
| C36: run unit / (pass) [C36] | pass | (pass) [C36] updatedAt is rewritten every heartbeat while connected and while retrying a blocked por |
| C37: run unit / (pass) [C37] | pass | (pass) [C37] a log line for an invalid host shows no host, and control characters in server text are |
| C61: run unit / (pass) [C61] | pass | (pass) [C61] run --json stopped by SIGTERM prints one object on stdout and logs only on stderr [328. |
| C66: run unit / (pass) [C66] | pass | (pass) [C66] run starts when state.json names a live pid but stopped being refreshed over 90 s ago [ |
| C67: run unit / (pass) [C67] | pass | (pass) [C67] the forward filter accepts only 127.0.0.1 on the configured remote port [0.12ms] |
| C71: run unit / (pass) [C71] | pass | (pass) [C71] a refused key gives disconnected/auth_failed with retryAt, and status exits 10 with tha |
| C78: run unit / (pass) [C78] | pass | (pass) [C78] sanitize strips control, bidi and zero-width characters [0.53ms] |
| C83: run unit / (pass) [C83] | pass | (pass) [C83] sanitize also strips the soft hyphen, Arabic letter mark, word joiner, invisible operat |
| C38: run unit / (pass) [C38] | pass | (pass) [C38] a live connected run exits 0 with state, since, server host, remote port and domain cou |
| C39: run unit / (pass) [C39] | pass | (pass) [C39] an absent file, a dead pid and a stopped state each report stopped and exit 10 [36.95ms |
| C40: run unit / (pass) [C40] | pass | (pass) [C40] connecting, disconnected and reconnecting each exit 10 with reason and retryAt [16.67ms |
| C41: run unit / (pass) [C41] | pass | (pass) [C41] blocked/port_blocked with a live pid exits 11 [6.84ms] |
| C42: run unit / (pass) [C42] | pass | (pass) [C42] blocked/host_key_mismatch exits 13 with a live pid and with a dead pid [40.88ms] |
| C43: run unit / (pass) [C43] | pass | (pass) [C43] status --json, doctor --json and a failing run --json each print exactly one JSON objec |
| C44: run unit / (pass) [C44] | pass | (pass) [C44] a live pid whose updatedAt is older than 90 s reports stopped/stale and exits 10 [6.43m |
| C73: run unit / (pass) [C73] | pass | (pass) [C73] status and doctor do not credit a live run that serves another server or port [18.10ms] |
| C45: run unit / (pass) [C45] | pass | (pass) [C45] hops run in order and everything after a server_reachable failure is skipped [33.43ms] |
| C46: run unit / (pass) [C46] | pass | (pass) [C46] every failed hop has skipped false and a non-empty fix [81.45ms] |
| C62: run unit / (pass) [C62] | pass | (pass) [C62] doctor reports a bad config or key as a failed hop, never an error envelope, and exits  |
| C47: run unit / (pass) [C47] | pass | (pass) [C47] with a live connected run the forward hop passes without requesting the forward [17.94m |
| C48: run unit / (pass) [C48] | pass | (pass) [C48] with no live run the forward hop requests the forward and then cancels it [17.79ms] |
| C49: run unit / (pass) [C49] | pass | (pass) [C49] the egress hop resolves the first domain and connects on 443, and an unreachable host f |
| C50: run unit / (pass) [C50] | pass | (pass) [C50] --domain adds a domain hop after config; an unlisted host fails it, skips the rest and  |
| C51: run unit / (pass) [C51] | pass | (pass) [C51] a wrong host key fails ssh_auth with exit 13 through the connect function run uses [19. |
| C52: run unit / (pass) [C52] | pass | (pass) [C52] doctor exits with the failing hop's code, and 0 when every hop passes [114.22ms] |
| C53: run unit / (pass) [C53] | pass | (pass) [C53] the lockdown hop fails naming exactly what the server allowed, and passes when it allow |
| C54: run unit / (pass) [C54] | pass | (pass) [C54] keyPath ~/.ssh/id_ed25519 passes the key hop with advice to use a dedicated key [42.65m |
| C64: run unit / (pass) [C64] | pass | (pass) [C64] the lockdown hop fails for a shell without a PTY and for exec, and passes a forced comm |
| C74: run unit / (pass) [C74] | pass | (pass) [C74] doctor's fixes are safe to run: the chmod path is quoted and each fix says what to do [ |
| C75: run unit / (pass) [C75] | pass | (pass) [C75] a fish or tcsh login shell that runs commands fails the lockdown hop [44.34ms] |
| C76: run unit / (pass) [C76] | pass | (pass) [C76] a permitted local forward that cannot connect, and a forward two ports up, both fail th |
| C87: run unit / (pass) [C87] | pass | (pass) [C87] an SSH connection that closes during the lockdown hop fails the hop with exit 10, never |
| C88: run unit / (pass) [C88] | pass | (pass) [C88] at the top of the port range the lockdown hop asks for real other ports below the tunne |
| C55: run unit / (pass) [C55] | pass | (pass) [C55] unknown verbs and flags print usage on stderr and exit 2; --help and --version exit 0 [ |
| C56: run unit / (pass) [C56] | pass | (pass) [C56] no verb waits on stdin, and an unexpected exception exits 1 with error.code internal [7 |
| C84: run unit / (pass) [C84] | pass | (pass) [C84] the lockdown fix also closes Unix-socket forwarding [23.20ms] |
| C77: run unit / (pass) [C77] | pass | (pass) [C77] status and doctor without --json print readable lines with control characters stripped  |

## Output

`Run unit` - exit 0

```
(pass) [C6] a key readable or writable by group or others fails with key_permissions before any read [30.41ms]
(pass) [C7] status --json and doctor --json include the absolute configPath they used [1.82ms]
(pass) [C60] server.hostKey must be SHA256: plus 43 unpadded base64 characters [8.30ms]
(pass) [C68] bad server fields, keyPath, unknown server keys and misplaced flags are rejected [51.26ms]
(pass) [C72] a missing key exits 2 with key_unreadable, and a non-private-key file with key_invalid [22.07ms]

tests/cli.test.ts:
(pass) [C55] unknown verbs and flags print usage on stderr and exit 2; --help and --version exit 0 [1071.39ms]
(pass) [C56] no verb waits on stdin, and an unexpected exception exits 1 with error.code internal [751.18ms]
(pass) [C77] status and doctor without --json print readable lines with control characters stripped [6.48ms]

 88 pass
 0 fail
 1356 expect() calls
Ran 88 tests across 10 files. [18.08s]
```
