# cli-core proofs

**HEAD**: 3cc3737
**Shell**: /bin/sh
**Result**: 103 pass, 0 fail

| Proof | Result | Line |
| --- | --- | --- |
| C1: run unit / (pass) [C1] | pass | (pass) [C1] config path resolves flag, then env, then the platform config dir [1.42ms] |
| C2: run unit / (pass) [C2] | pass | (pass) [C2] status and run exit 2 with a config_invalid envelope for missing, non-JSON and schema-in |
| C3: run unit / (pass) [C3] | pass | (pass) [C3] domain entries that are not bare hostnames are rejected naming the entry [39.55ms] |
| C4: run unit / (pass) [C4] | pass | (pass) [C4] Instagram.COM. is stored as instagram.com [0.40ms] |
| C5: run unit / (pass) [C5] | pass | (pass) [C5] a config with an extra key password is rejected naming it [3.57ms] |
| C6: run unit / (pass) [C6] | pass | (pass) [C6] a key readable or writable by group or others fails with key_permissions before any read |
| C7: run unit / (pass) [C7] | pass | (pass) [C7] status --json and doctor --json include the absolute configPath they used [8.75ms] |
| C60: run unit / (pass) [C60] | pass | (pass) [C60] server.hostKey must be SHA256: plus 43 unpadded base64 characters [18.71ms] |
| C68: run unit / (pass) [C68] | pass | (pass) [C68] bad server fields, keyPath, unknown server keys and misplaced flags are rejected [49.94 |
| C72: run unit / (pass) [C72] | pass | (pass) [C72] a missing key exits 2 with key_unreadable, and a non-private-key file with key_invalid  |
| C8: run unit / (pass) [C8] | pass | (pass) [C8] CONNECT to an allowlisted host on 443 gets 200 and relays both ways [26.37ms] |
| C9: run unit / (pass) [C9] | pass | (pass) [C9] CONNECT to a host off the allowlist gets 403 with no lookup and no connection [26.16ms] |
| C10: run unit / (pass) [C10] | pass | (pass) [C10] CONNECT to a port other than 443 gets 403 with no lookup and no connection [16.64ms] |
| C11: run unit / (pass) [C11] | pass | (pass) [C11] CONNECT to an IP literal gets 403 with no lookup and no connection [18.74ms] |
| C12: run unit / (pass) [C12] | pass | (pass) [C12] the address guard refuses both ends of every listed range and accepts the neighbours [1 |
| C13: run unit / (pass) [C13] | pass | (pass) [C13] the address guard refuses addresses inside a prefix of a local interface [0.24ms] |
| C14: run unit / (pass) [C14] | pass | (pass) [C14] an allowlisted host resolving only to private addresses gets 403 with no connection [25 |
| C15: run unit / (pass) [C15] | pass | (pass) [C15] a host resolving to a private and a public address is dialled once, at the public addre |
| C16: run unit / (pass) [C16] | pass | (pass) [C16] a GET request gets 405 and the channel closes [6.41ms] |
| C17: run unit / (pass) [C17] | pass | (pass) [C17] a head over 8192 bytes gets 400 and an unfinished head gets 408 [66.15ms] |
| C18: run unit / (pass) [C18] | pass | (pass) [C18] DNS and connect failures get 502, and timeouts get 504 [107.34ms] |
| C19: run unit / (pass) [C19] | pass | (pass) [C19] with the default cap the 257th relay gets 503 until one closes [49.67ms] |
| C20: run unit / (pass) [C20] | pass | (pass) [C20] no file under src/ opens a listening socket [1.84ms] |
| C58: run unit / (pass) [C58] | pass | (pass) [C58] a connected run holds no listening TCP socket [455.31ms] |
| C21: run unit / (pass) [C21] | pass | (pass) [C21] malformed hosts and ports get 400 [58.00ms] |
| C22: run unit / (pass) [C22] | pass | (pass) [C22] bytes sent with the head reach upstream untouched and are never answered [67.92ms] |
| C23: run unit / (pass) [C23] | pass | (pass) [C23] the 403 body is identical for every refusal reason and names no resolved address [98.94 |
| C24: run unit / (pass) [C24] | pass | (pass) [C24] a relay idle past the idle timeout closes both sides [1280.78ms] |
| C63: run unit / (pass) [C63] | pass | (pass) [C63] the shipped defaults match the plan [1.08ms] |
| C65: run unit / (pass) [C65] | pass | (pass) [C65] the proxy refuses a host that resolves only into a local interface prefix [14.96ms] |
| C69: run unit / (pass) [C69] | pass | (pass) [C69] channels still sending their head count against the relay cap [42.36ms] |
| C70: run unit / (pass) [C70] | pass | (pass) [C70] a multi-megabyte response arrives byte-exact through the tunnel when upstream closes af |
| C79: run unit / (pass) [C79] | pass | (pass) [C79] bytes already handed to a slow upstream are delivered after the client closes first [50 |
| C80: run unit / (pass) [C80] | pass | (pass) [C80] a flush that cannot finish is cut off by the idle timeout, even while upstream keeps se |
| C81: run unit / (pass) [C81] | pass | (pass) [C81] a channel that closes during the DNS lookup causes no outbound connection [81.58ms] |
| C82: run unit / (pass) [C82] | pass | (pass) [C82] traffic in one direction alone keeps a relay open past the idle timeout [2380.25ms] |
| C85: run unit / (pass) [C85] | pass | (pass) [C85] on the tunnel's SSH channel, a channel closed or a connection lost during the DNS looku |
| C86: run unit / (pass) [C86] | pass | (pass) [C86] a refusal the SSH peer never takes is closed once the head timeout has passed [966.09ms |
| C89: run unit / (pass) [C89] | pass | (pass) [C89] the address guard judges an IPv4-translated address (::ffff:0:a.b.c.d) by its IPv4 addr |
| C90: run unit / (pass) [C90] | pass | (pass) [C90] on the tunnel's SSH channel, a relay ended by an upstream reset, an upstream close or t |
| C91: run unit / (pass) [C91] | pass | (pass) [C91] after upstream closes, a client that takes nothing but keeps sending is cut off by the  |
| C92: run unit / (pass) [C92] | pass | (pass) [C92] a channel that never reports its own close frees its slot when upstream closes and when |
| C93: run unit / (pass) [C93] | pass | (pass) [C93] a dial still pending at the connect timeout is told to stop, and the production dialer  |
| C98: run unit / (pass) [C98] | pass | (pass) [C98] on the tunnel's SSH channel, a connection that completes after the channel was lost is  |
| C99: run unit / (pass) [C99] | pass | (pass) [C99] a connection that completes after its dial timed out is closed and never relayed [51.82 |
| C100: run unit / (pass) [C100] | pass | (pass) [C100] a refused channel that is still open holds no relay slot [304.36ms] |
| C25: run unit / (pass) [C25] | pass | (pass) [C25] the tunnel authenticates with the key, requests the forward and state goes connecting - |
| C26: run unit / (pass) [C26] | pass | (pass) [C26] run against a server with another host key sends no auth request, records the mismatch  |
| C27: run unit / (pass) [C27] | pass | (pass) [C27] a refused forward gives blocked/port_blocked and the next attempt 30 s later [16.41ms] |
| C28: run unit / (pass) [C28] | pass | (pass) [C28] closing the server connection gives disconnected/connection_lost, reconnecting, connect |
| C59: run unit / (pass) [C59] | pass | (pass) [C59] unanswered keepalives give disconnected/connection_lost after 3 missed intervals, not b |
| C29: run unit / (pass) [C29] | pass | (pass) [C29] retry delays run 1, 2, 4, 8, 16, 30, 30 s and return to 1 s after a connection [88.57ms |
| C30: run unit / (pass) [C30] | pass | (pass) [C30] a connection to the forwarded port reaches the proxy and an allowlisted CONNECT gets 20 |
| C31: run unit / (pass) [C31] | pass | (pass) [C31] state.json holds exactly the nine fields and is replaced through a temp file and rename |
| C32: run unit / (pass) [C32] | pass | (pass) [C32] run stopped by SIGTERM or SIGINT cancels the forward, writes stopped and exits 0 [454.6 |
| C33: run unit / (pass) [C33] | pass | (pass) [C33] a second run while state.json names a live other pid exits 2 with already_running [4.48 |
| C34: run unit / (pass) [C34] | pass | (pass) [C34] no line of the private key appears in stdout, stderr or state.json on five paths [1010. |
| C35: run unit / (pass) [C35] | pass | (pass) [C35] a forwarded connection for another port or bind address is rejected before the proxy [2 |
| C36: run unit / (pass) [C36] | pass | (pass) [C36] updatedAt is rewritten every heartbeat while connected and while retrying a blocked por |
| C37: run unit / (pass) [C37] | pass | (pass) [C37] a log line for an invalid host shows no host, and control characters in server text are |
| C61: run unit / (pass) [C61] | pass | (pass) [C61] run --json stopped by SIGTERM prints one object on stdout and logs only on stderr [240. |
| C66: run unit / (pass) [C66] | pass | (pass) [C66] run starts when state.json names a live pid but stopped being refreshed over 90 s ago [ |
| C67: run unit / (pass) [C67] | pass | (pass) [C67] the forward filter accepts only 127.0.0.1 on the configured remote port [0.21ms] |
| C71: run unit / (pass) [C71] | pass | (pass) [C71] a refused key gives disconnected/auth_failed with retryAt, and status exits 10 with tha |
| C78: run unit / (pass) [C78] | pass | (pass) [C78] sanitize strips control, bidi and zero-width characters [0.55ms] |
| C83: run unit / (pass) [C83] | pass | (pass) [C83] sanitize also strips the soft hyphen, Arabic letter mark, word joiner, invisible operat |
| C94: run unit / (pass) [C94] | pass | (pass) [C94] stop() after a host key mismatch leaves blocked/host_key_mismatch in state.json and sta |
| C95: run unit / (pass) [C95] | pass | (pass) [C95] since stays at the first refusal while a blocked port is retried, and retryAt moves on  |
| C101: run unit / (pass) [C101] | pass | (pass) [C101] a mismatched forwarded connection that ssh2 itself lets through is rejected by the tun |
| C102: run unit / (pass) [C102] | pass | (pass) [C102] a blocked port is retried against the server while state.json stays blocked/port_block |
| C103: run unit / (pass) [C103] | pass | (pass) [C103] stop() cancels the pending retry, and a retry that fires anyway opens no connection [1 |
| C38: run unit / (pass) [C38] | pass | (pass) [C38] a live connected run exits 0 with state, since, server host, remote port and domain cou |
| C39: run unit / (pass) [C39] | pass | (pass) [C39] an absent file, a dead pid and a stopped state each report stopped and exit 10 [18.64ms |
| C40: run unit / (pass) [C40] | pass | (pass) [C40] connecting, disconnected and reconnecting each exit 10 with reason and retryAt [13.82ms |
| C41: run unit / (pass) [C41] | pass | (pass) [C41] blocked/port_blocked with a live pid exits 11 [5.58ms] |
| C42: run unit / (pass) [C42] | pass | (pass) [C42] blocked/host_key_mismatch exits 13 with a live pid and with a dead pid [23.87ms] |
| C43: run unit / (pass) [C43] | pass | (pass) [C43] status --json, doctor --json and a failing run --json each print exactly one JSON objec |
| C44: run unit / (pass) [C44] | pass | (pass) [C44] a live pid whose updatedAt is older than 90 s reports stopped/stale and exits 10 [4.49m |
| C73: run unit / (pass) [C73] | pass | (pass) [C73] status and doctor do not credit a live run that serves another server or port [1297.15m |
| C104: run unit / (pass) [C104] | pass | (pass) [C104] --json output strips control, bidi and zero-width characters from file-supplied string |
| C45: run unit / (pass) [C45] | pass | (pass) [C45] hops run in order and everything after a server_reachable failure is skipped [49.61ms] |
| C46: run unit / (pass) [C46] | pass | (pass) [C46] every failed hop has skipped false and a non-empty fix [160.91ms] |
| C62: run unit / (pass) [C62] | pass | (pass) [C62] doctor reports a bad config or key as a failed hop, never an error envelope, and exits  |
| C47: run unit / (pass) [C47] | pass | (pass) [C47] with a live connected run the forward hop passes without requesting the forward [76.41m |
| C48: run unit / (pass) [C48] | pass | (pass) [C48] with no live run the forward hop requests the forward and then cancels it [130.92ms] |
| C49: run unit / (pass) [C49] | pass | (pass) [C49] the egress hop resolves the first domain and connects on 443, and an unreachable host f |
| C50: run unit / (pass) [C50] | pass | (pass) [C50] --domain adds a domain hop after config; an unlisted host fails it, skips the rest and  |
| C51: run unit / (pass) [C51] | pass | (pass) [C51] a wrong host key fails ssh_auth with exit 13 through the connect function run uses [25. |
| C52: run unit / (pass) [C52] | pass | (pass) [C52] doctor exits with the failing hop's code, and 0 when every hop passes [228.81ms] |
| C53: run unit / (pass) [C53] | pass | (pass) [C53] the lockdown hop fails naming exactly what the server allowed, and passes when it allow |
| C54: run unit / (pass) [C54] | pass | (pass) [C54] keyPath ~/.ssh/id_ed25519 passes the key hop with advice to use a dedicated key [64.39m |
| C64: run unit / (pass) [C64] | pass | (pass) [C64] the lockdown hop fails for a shell without a PTY and for exec, and passes a forced comm |
| C74: run unit / (pass) [C74] | pass | (pass) [C74] doctor's fixes are safe to run: the chmod path is quoted and each fix says what to do [ |
| C75: run unit / (pass) [C75] | pass | (pass) [C75] a fish or tcsh login shell that runs commands fails the lockdown hop [593.51ms] |
| C76: run unit / (pass) [C76] | pass | (pass) [C76] a permitted local forward that cannot connect, and a forward two ports up, both fail th |
| C84: run unit / (pass) [C84] | pass | (pass) [C84] the lockdown fix also closes Unix-socket forwarding [127.31ms] |
| C87: run unit / (pass) [C87] | pass | (pass) [C87] an SSH connection that closes during the lockdown hop fails the hop with exit 10, never |
| C88: run unit / (pass) [C88] | pass | (pass) [C88] at the top of the port range the lockdown hop asks for real other ports below the tunne |
| C96: run unit / (pass) [C96] | pass | (pass) [C96] a server that stops answering during the lockdown hop fails the hop with exit 10, and a |
| C97: run unit / (pass) [C97] | pass | (pass) [C97] a forward request the connection never answers fails the forward hop with exit 10, not  |
| C55: run unit / (pass) [C55] | pass | (pass) [C55] unknown verbs and flags print usage on stderr and exit 2; --help and --version exit 0 [ |
| C56: run unit / (pass) [C56] | pass | (pass) [C56] no verb waits on stdin, and an unexpected exception exits 1 with error.code internal [9 |
| C77: run unit / (pass) [C77] | pass | (pass) [C77] status and doctor without --json print readable lines with control characters stripped  |

## Output

`Run unit` - exit 0

```
(pass) [C7] status --json and doctor --json include the absolute configPath they used [8.75ms]
(pass) [C60] server.hostKey must be SHA256: plus 43 unpadded base64 characters [18.71ms]
(pass) [C68] bad server fields, keyPath, unknown server keys and misplaced flags are rejected [49.94ms]
(pass) [C72] a missing key exits 2 with key_unreadable, and a non-private-key file with key_invalid [21.34ms]

tests/cli.test.ts:
(pass) [C55] unknown verbs and flags print usage on stderr and exit 2; --help and --version exit 0 [3967.29ms]
(pass) [C56] no verb waits on stdin, and an unexpected exception exits 1 with error.code internal [962.77ms]
(pass) [C77] status and doctor without --json print readable lines with control characters stripped [7.11ms]
(pass) [C104] --json output strips control, bidi and zero-width characters from file-supplied strings [9.94ms]

 103 pass
 0 fail
 1467 expect() calls
Ran 103 tests across 10 files. [28.88s]
```
