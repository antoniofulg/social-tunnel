# CLI core verification

**Verdict**: PASS
**Profile**: standard
**Diff range**: fd86af3..dd5ece4
**Round**: 3 - full
**Verifier**: independent sub-agent (author != verifier)
**Quarantined tests**: none

Round 3 re-verifies the whole feature at dd5ece4 after three deep-review rounds
(`.wtk-deep-review/cli-core/review.md`, final verdict SHIP). No Critical or Major finding is open.
All 83 proofs were rerun at dd5ece4 on a clean tree with `check_proofs.py`; typecheck is clean.

## Findings

Earlier findings, rechecked at dd5ece4:

| # | Finding | Status | Evidence |
| --- | --- | --- | --- |
| F1 | `lockdown` passed a PTY-less shell and exec (round 1, Major) | Closed | `src/doctor.ts:189`, `:194`; C64, C75 |
| F2 | own-interface refusal unproven at the proxy (round 1, Major) | Closed | C65 at `tests/proxy.test.ts:241`; residual R1 |
| F3 | `run` refused over a stale state (round 1) | Closed | one liveness rule, `src/status.ts:24`, used at `src/cli.ts:151`; C66 |
| F4 | forward filter untested (round 1) | Closed | `src/tunnel.ts:95`; C67 |
| F5 | config and flag rejections untested (round 1) | Closed | C68 |
| F6 | undeclared reasons and codes (round 1) | Closed | plan Surface rows; C71, C72, C73 |
| F7 | head-phase channels uncapped (round 1) | Closed | `src/proxy.ts:79`; C69 |
| F8 | `proofs.md` stale (rounds 1-2) | Closed for this gate | regenerated at dd5ece4; see Gate |
| R2 | probe needed POSIX arithmetic, so `fish` and `tcsh` shells passed (round 2) | Closed | `src/doctor.ts:171` joins quoted pieces; C75; fault killed |

Open after this round (none blocks):

| # | Severity | Where | Scenario |
| --- | --- | --- | --- |
| R1 | Minor (proof gap) | `src/address-guard.ts:92` | Every test injects the interface list. Changing the production default from `os.networkInterfaces()` to an empty object leaves the proxy, guard and doctor tests green. Read directly, production is right: `src/cli.ts:167` passes no `interfaces`, `src/proxy.ts:145` passes `undefined`, and the default is evaluated per call. |
| R3 | Process (needs the user) | `.specs/features/cli-core/plan.md` `## Approval` | Criteria 59-72 were added after the approved revision. The receipt now says so plainly: "Approver: none recorded". Each one tightens a safety rule or records shipped behaviour and none removes a capability, but the user's recorded approval does not cover them. |
| R4 | Minor | `src/proxy.ts:165`-`:166` | Removing the `off("data", touch)` lines changes nothing observable: a pipe pauses its source when the other side closes, so no data event reaches the idle timer anyway. The lines are defensive and untested. |
| R5 | Minor (test realism) | `tests/ssh-server.ts` shell stand-in | C75's "fish" and "tcsh" servers differ from the POSIX one only for a command containing `$((`. The shipped probe has no arithmetic, so the test proves the probe avoids it, not that real fish or tcsh join quoted pieces. That they do is my reading of those shells, not something this suite runs. |

## README against the code

Read `README.md` at dd5ece4 against the source. No mismatch found.

| Claim | Code |
| --- | --- |
| Exit codes 0, 1, 2, 10, 11, 12, 13, 14 and their meanings | `src/defaults.ts:18`; exit 2 for a missing, non-private or loose key at `src/config.ts:150`, `:168`, and for `already_running` at `src/cli.ts:155` |
| Six states, their reasons, backoff 1, 2, 4, 8, 16, 30 s, blocked retried every 30 s | `src/state.ts:25`, `src/defaults.ts:12`, `src/tunnel.ts:200`, `src/status.ts:50` |
| Hop order `config`, `domain`, `key`, `server_reachable`, `ssh_auth`, `forward`, `lockdown`, `egress`; hop shape | `src/doctor.ts:66`, `:254` |
| 256 relays, 10 s head, 10 s resolve and connect, 300 s idle, port 8888 | `src/defaults.ts` (asserted by C63) |
| `doctor` fails for a shell, a command, sftp, a local forward, another port | `src/doctor.ts:184` |
| Server setup block and the exit 14 advice | match the lockdown fix text at `src/doctor.ts:225`: `restrict`, `port-forwarding`, `permitlisten`, `command="/usr/sbin/nologin"`, `AllowTcpForwarding remote`, `PermitOpen none`, `AllowStreamLocalForwarding no`, `PermitTTY no`, `ForceCommand` |
| `status --json` example field order | `src/cli.ts:129` |
| Config paths, schema fields, unknown fields rejected, `~` and relative `keyPath` | `src/config.ts:22`, `:60`-`:105` |
| PAC has no direct fallback for chosen domains | the README's own PAC returns only `PROXY 127.0.0.1:8888` for them; this is server-side text, not code in this feature |

The README says `GatewayPorts no` belongs in `sshd_config`; `doctor` does not probe it (plan, out of scope) and the README does not claim it does.

## Checks

All 83 rows verified at dd5ece4. Line numbers for C1-C69 were remapped to the current files and each
first citation was read back against its assertion.

| Check | Test | Holds | Evidence |
| --- | --- | --- | --- |
| C1 | `tests/config.test.ts` `[C1]` | yes | `tests/config.test.ts:13` - `resolveConfigPath(undefined, {}, "darwin", ...)` toBe `/Users/u/Library/Application Support/social-tunnel/config.json`; `:11`-`:22` cover flag, env, XDG, home, Windows |
| C2 | `tests/config.test.ts` `[C2]` | yes | `tests/config.test.ts:41` - `expect(body).toEqual({ ok: false, command: verb, error: { code: "config_invalid", field, message } })`; `:39` code 2 |
| C3 | `tests/config.test.ts` `[C3]` | yes | `tests/config.test.ts:68` - `expect(error.field).toBe("domains[1]")`; `:69` message contains the entry |
| C4 | `tests/config.test.ts` `[C4]` | yes | `tests/config.test.ts:77` - `expect(parsed.config.domains).toEqual(["instagram.com"])` |
| C5 | `tests/config.test.ts` `[C5]` | yes | `tests/config.test.ts:84` - `toMatchObject({ code: "config_invalid", field: "password" })` |
| C6 | `tests/config.test.ts` `[C6]` | yes | `tests/config.test.ts:101` - `expect(keyReads).toEqual([])`; `:99` `error: { code: "key_permissions" }`; `:112` 0600/0400 `loaded.ok` true |
| C7 | `tests/config.test.ts` `[C7]` | yes | `tests/config.test.ts:124` - `expect(status.json().configPath).toBe(path)`; `:127` doctor |
| C60 | `tests/config.test.ts` `[C60]` | yes | `tests/config.test.ts:147` - `toMatchObject({ code: "config_invalid", field: "server.hostKey" })`; `:152` 43 chars accepted |
| C8 | `tests/proxy.test.ts` `[C8]` | yes | `tests/proxy.test.ts:11` - `expect(await channel.head()).toBe(OK head)`; `:15`, `:17` bytes both ways |
| C9 | `tests/proxy.test.ts` `[C9]` | yes | `tests/proxy.test.ts:25` - `toBe("HTTP/1.1 403 Forbidden")`; `:26`-`:27` `lookups` and `dials` equal `[]` |
| C10 | `tests/proxy.test.ts` `[C10]` | yes | `tests/proxy.test.ts:34` - 403; `:35`-`:36` no lookup, no dial |
| C11 | `tests/proxy.test.ts` `[C11]` | yes | `tests/proxy.test.ts:43` - 403; `:44`-`:45` no lookup, no dial |
| C12 | `tests/address-guard.test.ts` `[C12]` | yes | `tests/address-guard.test.ts:36` - `expect([first, isRefusedAddress(first, none)]).toEqual([first, true])`; `:38`-`:39` neighbours false; `:46` embedded forms |
| C13 | `tests/address-guard.test.ts` `[C13]` | yes | `tests/address-guard.test.ts:57` - `expect(isRefusedAddress("2a03:2880:1:2::99", interfaces)).toBe(true)`; the proxy boundary is C65 |
| C14 | `tests/proxy.test.ts` `[C14]` | yes | `tests/proxy.test.ts:51` - 403; `:53` `expect(h.dials).toEqual([])` |
| C15 | `tests/proxy.test.ts` `[C15]` | yes | `tests/proxy.test.ts:60` - `expect(h.dials.map(...)).toEqual([[PUBLIC, 443]])`; `:59` one lookup |
| C16 | `tests/proxy.test.ts` `[C16]` | yes | `tests/proxy.test.ts:66` - `toBe("HTTP/1.1 405 Method Not Allowed")`; `:67` ended |
| C17 | `tests/proxy.test.ts` `[C17]` | yes | `tests/proxy.test.ts:81` - 8193 bytes gives 400 (`:78` 8192 gives 200); `:91` 408 |
| C18 | `tests/proxy.test.ts` `[C18]` | yes | `tests/proxy.test.ts:100`, `:104` - 502; `:114`, `:117` - 504 |
| C19 | `tests/proxy.test.ts` `[C19]` | yes | `tests/proxy.test.ts:126` - 257th `toBe("HTTP/1.1 503 Service Unavailable")`; `:131` 200 after one closes |
| C20 | `tests/no-listener.test.ts` `[C20]` | yes | `tests/no-listener.test.ts:17` - `expect(hits).toEqual([])` |
| C58 | `tests/run.test.ts` `[C58]` | yes | `tests/run.test.ts:83` - `expect(listening.stdout.toString().trim()).toBe("")`; `:82` lsof sees the SSH socket |
| C21 | `tests/proxy.test.ts` `[C21]` | yes | `tests/proxy.test.ts:152` - `toEqual([target, "HTTP/1.1 400 Bad Request"])` over nine targets |
| C22 | `tests/proxy.test.ts` `[C22]` | yes | `tests/proxy.test.ts:171` - `expect(h.dials[0].received().equals(trailing)).toBe(true)`; `:172`-`:174` one answer, one lookup, one dial |
| C23 | `tests/proxy.test.ts` `[C23]` | yes | `tests/proxy.test.ts:183`-`:184` - `expect(wrongPort).toBe(unlisted)`, `expect(privateOnly).toBe(unlisted)`; `:194`-`:196` no address |
| C24 | `tests/proxy.test.ts` `[C24]` | yes | `tests/proxy.test.ts:206` - `until(() => channel.ended() && h.dials[0].remote.destroyed)` |
| C63 | `tests/proxy.test.ts` `[C63]` | yes | `tests/proxy.test.ts:226`-`:233` - `expect(DEFAULTS.headTimeoutMs).toBe(10000)` and the seven others |
| C25 | `tests/tunnel.test.ts` `[C25]` | yes | `tests/tunnel.test.ts:48` - `expect(t.names()).toEqual(["connecting", "connected"])`; `:50` the `tcpip-forward` request |
| C26 | `tests/run.test.ts` `[C26]` | yes | `tests/run.test.ts:30` - `expect(env.ssh.auth).toEqual([])`; `:28` code 13; `:31` state |
| C27 | `tests/tunnel.test.ts` `[C27]` | yes | `tests/tunnel.test.ts:60`-`:61` - names end `blocked/port_blocked`, `expect(delays).toEqual([30000])` |
| C28 | `tests/tunnel.test.ts` `[C28]` | yes | `tests/tunnel.test.ts:73` - five states in order; `:75` `retryAt` |
| C59 | `tests/tunnel.test.ts` `[C59]` | yes | `tests/tunnel.test.ts:92` - still connected before 3 intervals; `:95`-`:96` lost after |
| C29 | `tests/tunnel.test.ts` `[C29]` | yes | `tests/tunnel.test.ts:124` - `expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])`; `:128` reset to 1000 |
| C30 | `tests/tunnel.test.ts` `[C30]` | yes | `tests/tunnel.test.ts:142` - `expect(received).toBe(OK head)` through the forwarded port |
| C31 | `tests/tunnel.test.ts` `[C31]` | yes | `tests/tunnel.test.ts:164` - `expect(Object.keys(state).sort()).toEqual([nine fields])`; `:187`-`:188` inode changes, no `.tmp` left |
| C32 | `tests/run.test.ts` `[C32]` | yes | `tests/run.test.ts:42`-`:44` - code 0, `state: "stopped"`, forward then cancel requests |
| C33 | `tests/run.test.ts` `[C33]` | yes | `tests/run.test.ts:68`-`:69` - code 2, `error: { code: "already_running" }` |
| C34 | `tests/key-leak.test.ts` `[C34]` | yes | `tests/key-leak.test.ts:73`, `:80`, `:89`, `:96`, `:103` - `expect(leaked(keyPath, captured)).toEqual([])` on each of five paths |
| C35 | `tests/tunnel.test.ts` `[C35]` | yes | `tests/tunnel.test.ts:198`-`:200` - both announcements `toBe(false)`, `expect(t.handled.length).toBe(0)`. ssh2 produces the outcome; the project's own filter is now proven by C67 |
| C36 | `tests/tunnel.test.ts` `[C36]` | yes | `tests/tunnel.test.ts:226` - `expect(seen.size).toBeGreaterThanOrEqual(4)` for `connected` and `blocked` |
| C37 | `tests/tunnel.test.ts` `[C37]` | yes | `tests/tunnel.test.ts:241`-`:242` - line has no `host`, no `evil`; `:256` no control characters |
| C61 | `tests/run.test.ts` `[C61]` | yes | `tests/run.test.ts:97`-`:98` - `expect(body).toEqual({ ok: true, command: "run", state: "stopped", reason: null })`; `:100` stderr lines parse |
| C38 | `tests/status.test.ts` `[C38]` | yes | `tests/status.test.ts:42`-`:43` - code 0 and the field object |
| C39 | `tests/status.test.ts` `[C39]` | yes | `tests/status.test.ts:59`-`:60` - code 10, `state: "stopped"` for three cases |
| C40 | `tests/status.test.ts` `[C40]` | yes | `tests/status.test.ts:73`, `:76`-`:77` - code 10, `reason`, `retryAt` |
| C41 | `tests/status.test.ts` `[C41]` | yes | `tests/status.test.ts:83` - `expect(code).toBe(11)` |
| C42 | `tests/status.test.ts` `[C42]` | yes | `tests/status.test.ts:93` - `expect(code).toBe(13)` live, dead and stale |
| C43 | `tests/status.test.ts` `[C43]` | yes | `tests/status.test.ts:107` - `expect(JSON.stringify(body) + "\n").toBe(result.stdout)` for three verbs |
| C44 | `tests/status.test.ts` `[C44]` | yes | `tests/status.test.ts:125`-`:126` - 90000 ms connected, 90001 ms `stopped`/`stale` exit 10 |
| C45 | `tests/doctor.test.ts` `[C45]` | yes | `tests/doctor.test.ts:81` - hop order; `:85` later hops `{ ok: false, skipped: true, fix: "" }` |
| C46 | `tests/doctor.test.ts` `[C46]` | yes | `tests/doctor.test.ts:94`, `:96` - `skipped` false, `fix.trim().length > 0` for eight scenarios |
| C62 | `tests/doctor.test.ts` `[C62]` | yes | `tests/doctor.test.ts:103`-`:106`, `:110`-`:113` - code 2, `error` undefined, failed hop |
| C47 | `tests/doctor.test.ts` `[C47]` | yes | `tests/doctor.test.ts:138` - `expect(env.ssh.requests.filter(r => r.bindPort === env.remotePort)).toEqual([])` |
| C48 | `tests/doctor.test.ts` `[C48]` | yes | `tests/doctor.test.ts:146` - first two requests are forward then cancel |
| C49 | `tests/doctor.test.ts` `[C49]` | yes | `tests/doctor.test.ts:158`-`:159` - lookup `linkedin.com`, dial `[PUBLIC, 443]`; `:164`, `:168` fails inside the timeout |
| C50 | `tests/doctor.test.ts` `[C50]` | yes | `tests/doctor.test.ts:175` - hop order with `domain`; `:181`, `:184` code 12, rest skipped |
| C51 | `tests/doctor.test.ts` `[C51]` | yes | `tests/doctor.test.ts:191` - `expect(code).toBe(13)`; `:197` no auth request; `:202` one `new Client` |
| C52 | `tests/doctor.test.ts` `[C52]` | yes | `tests/doctor.test.ts:216` - `expect(seen).toEqual([...nine pairs])` |
| C53 | `tests/doctor.test.ts` `[C53]` | yes | `tests/doctor.test.ts:253`, `:256` - code 14 and exactly the allowed attempt named, now out of five names (`:230`); `:250` pass on the fifth |
| C54 | `tests/doctor.test.ts` `[C54]` | yes | `tests/doctor.test.ts:272`, `:274` - key hop ok, detail matches `/dedicated key/` |
| C55 | `tests/cli.test.ts` `[C55]` | yes | `tests/cli.test.ts:15`-`:16` - code 2, usage on stderr; `:21`, `:25` exit 0 |
| C56 | `tests/cli.test.ts` `[C56]` | yes | `tests/cli.test.ts:36`, `:46` - under 5000 ms with stdin held open; `:54`-`:55` code 1, `error.code` `internal` |
| C64 | `tests/doctor.test.ts` `[C64]` | yes | `tests/doctor.test.ts:298`, `:302` - `expect([allowed, code]).toEqual([allowed, 14])` and exactly `shell` or `exec` named; `:295`-`:296` the forced-command server passes |
| C65 | `tests/proxy.test.ts` `[C65]` | yes | `tests/proxy.test.ts:241`, `:243` - `toBe("HTTP/1.1 403 Forbidden")`, `expect(home.dials).toEqual([])`; `:248` the same answer is dialled with no such interface |
| C66 | `tests/run.test.ts` `[C66]` | yes | `tests/run.test.ts:124`, `:126` - 91 s old: code 13 after one server connection; `:131`-`:132` 60 s old: code 2 `already_running` |
| C67 | `tests/tunnel.test.ts` `[C67]` | yes | `tests/tunnel.test.ts:260`-`:265` - `expect(isExpectedForward({ destIP: "0.0.0.0", destPort: 8888 }, 8888)).toBe(false)` and five more |
| C68 | `tests/config.test.ts` `[C68]` | yes | `tests/config.test.ts:174` - `toMatchObject({ ok: false, command: verb, error: { code: "config_invalid", field } })` over ten edits; `:189`-`:190` usage, exit 2 for four misplaced flags |
| C69 | `tests/proxy.test.ts` `[C69]` | yes | `tests/proxy.test.ts:256` - 257th channel `toBe("HTTP/1.1 503 Service Unavailable")` with 256 unfinished heads; `:262` 200 after one closes |
| C70 | `tests/tunnel.test.ts` `[C70]` | yes | `tests/tunnel.test.ts:307`-`:308` - `expect([run, all.length - head.length]).toEqual([run, size])` and the SHA-256 `toBe(expected)`, six relays through the real tunnel |
| C71 | `tests/tunnel.test.ts` `[C71]` | yes | `tests/tunnel.test.ts:320` - `expect(t.names()).toEqual(["connecting", "disconnected/auth_failed"])`; `:323` retryAt; `:326`-`:327` status exit 10 with the reason |
| C72 | `tests/config.test.ts` `[C72]` | yes | `tests/config.test.ts:207`-`:208` - `expect([code, run.code]).toEqual([code, 2])`, `error: { code }` for missing, garbage and public key; `:213`-`:214` doctor key hop, no envelope |
| C73 | `tests/doctor.test.ts` `[C73]` | yes | `tests/doctor.test.ts:319`-`:320` - code 10, `state: "stopped", reason: "config_changed"` for three mismatches; `:327` doctor sends forward then cancel |
| C74 | `tests/doctor.test.ts` `[C74]` | yes | `tests/doctor.test.ts:353`-`:355` - after `sh -c` of the printed fix: mode `0o600`, empty cwd, no `pwned`; `:359` create-config fix; `:367` lockdown fix parts |
| C75 | `tests/doctor.test.ts` `[C75]` | yes | `tests/doctor.test.ts:381`, `:383` - `expect([flavor, allowed, code]).toEqual([flavor, allowed, 14])` and exactly `shell` or `exec` named, fish and tcsh |
| C76 | `tests/doctor.test.ts` `[C76]` | yes | `tests/doctor.test.ts:391`-`:394` - code 14, `local forward`, probe at `destPort: permitted.ssh.port`; `:398` prohibited passes; `:407`-`:408` second port named |
| C77 | `tests/cli.test.ts` `[C77]` | yes | `tests/cli.test.ts:81` - `expect(status.stdout).toBe(...)` six lines with the escape removed, `:79` code 10; `:94`-`:97` doctor `ok`, `FAIL`, `fix`, `skip` lines |
| C78 | `tests/tunnel.test.ts` `[C78]` | yes | `tests/tunnel.test.ts:334` - `expect([code, sanitize(...)]).toEqual([code, "payload"])` over 14 code points; `:336` accented and CJK text unchanged |
| C79 | `tests/proxy.test.ts` `[C79]` | yes | `tests/proxy.test.ts:295`-`:296` - `expect(slow.size()).toBe(chunks * 1024)`, `writableFinished` true |
| C80 | `tests/proxy.test.ts` `[C80]` | yes | `tests/proxy.test.ts:314` - not destroyed at a third of the timeout; `:316` `toBeLessThan(idleTimeoutMs * 3)` |
| C81 | `tests/proxy.test.ts` `[C81]` | yes | `tests/proxy.test.ts:338` - `expect(h.dials).toEqual([])`; `:345` the open channel dials once |
| C82 | `tests/proxy.test.ts` `[C82]` | yes | `tests/proxy.test.ts:362` - `expect([direction, channel.ended(), remote.destroyed]).toEqual([direction, false, false])` after three timeouts, both directions |
| C83 | `tests/tunnel.test.ts` `[C83]` | yes | `tests/tunnel.test.ts:343` - 11 code points stripped; `:349` seven neighbours kept |
| C84 | `tests/doctor.test.ts` `[C84]` | yes | `tests/doctor.test.ts:415` - `expect(hop("lockdown").fix).toContain("AllowStreamLocalForwarding no")` |

## Coverage

Recomputed at dd5ece4.

| Set (size) | Recomputed from | Member -> proof | Unproven |
| --- | --- | --- | --- |
| door 1 exit codes (8) | `src/defaults.ts:18` | 0 C38 · 1 C56 · 2 C2 · 10 C39 · 11 C41 · 12 C50 · 13 C42 · 14 C53, C64, C75, C76 | - |
| door 2 envelope (3 verbs) | `src/cli.ts:97`, `:107`, `:129`, `:178` | status C43 · doctor C43 · run C43, C61 | - |
| door 3 path sources (6) | `src/config.ts:22` | all six C1 | - |
| door 3 schema validation (11 branches) | `src/config.ts:60`-`:105` | version, server, remotePort C2 · server.host, server.port, server.user, keyPath, unknown `server.*` key C68 · hostKey C60 · domains C3 · unknown top key C5 | - |
| key file outcomes (4) | `src/config.ts:134`-`:175` | loose mode C6 · missing C72 · garbage C72, C34 · public key C72 | - |
| door 4 no local listener (3) | `src/` scan, `src/cli.ts:167` | C20 · C58 · C30 | - |
| door 5 CONNECT-only 443 (2) | `src/proxy.ts:127`, `:138` | C16 · C10 | - |
| door 6 ssh2 under Bun (1) | `package.json` pin 1.17.0 | C25, C70 | - |
| door 7 state fields (9) | `src/state.ts:13` | all nine C31 | - |
| door 8 host-key pin (3) | `src/tunnel.ts:72`, `src/config.ts:80` | run C26 · doctor C51 · format C60 | - |
| run outcomes (3) | `src/cli.ts:155`, `:178` | 0 C32 · 2 C33, C66 · 13 C26 | - |
| status outcomes (5) | `src/status.ts:42`-`:61` | 0 C38 · 10 C39, C73 · 11 C41 · 13 C42 · 2 C2 | - |
| doctor outcomes (7) | `src/doctor.ts` exits | 0 C52 · 2 C62, C72 · 10 C52 · 11 C52 · 12 C50 · 13 C51 · 14 C53 | - |
| CLI meta outcomes (2) | `src/cli.ts:70`, `:76`, `:82` | unknown input, empty and missing values C55, C68 · help and version C55 | - |
| human-readable output (2 verbs) | `src/cli.ts` text branches | status C77 · doctor C77 | - |
| proxy outcomes (8) | `src/proxy.ts:23` | 200 C8 · 400 C17, C21 · 403 C9 · 405 C16 · 408 C17 · 502 C18 · 503 C19, C69 · 504 C18 | - |
| relay close paths (4) | `src/proxy.ts:158`-`:177` | origin closes first C70 · client closes first C79 · flush that cannot finish C80 · idle with one-way traffic C82, C24 | - |
| refused ranges (25) | plan criterion 11 against `src/address-guard.ts:53`-`:81` | 24 ranges C12 · own interface C13 at the guard, C65 at the proxy | - |
| T1 request corpus (12) | `docs/security/threat-model.md:92` | C8, C9, C11, C21, C22 as listed | - |
| tunnel states (6) | `src/state.ts:25` | connecting, connected C25 · disconnected C28, C59, C71 · reconnecting C28 · blocked C26, C27 · stopped C32 | - |
| status mapping (10) | `src/status.ts:42`-`:61` | C38-C42, C44 · another server or port C73 | - |
| doctor hops (8) | `src/doctor.ts:66`-`:254` | C62, C50, C54, C45, C51, C47, C48, C73, C53, C49 | - |
| lockdown attempts (6) | `docs/security/threat-model.md:132`, `src/doctor.ts:184`-`:219` | shell without a PTY C53, C64, C75 · exec C64, C75 · sftp C53 · local forward C53, C76 · other port C53, C76 · second port C76 | - |
| lockdown fix parts (9) | `src/doctor.ts:225` | seven parts C74 (`tests/doctor.test.ts:366`) · `AllowStreamLocalForwarding no` C84 · `AllowTcpForwarding remote` read at `src/doctor.ts:225` | - |
| reason and error codes (12) | plan Surface rows against `src/tunnel.ts:200`, `src/status.ts:50`, `src/config.ts:136` | host_key_mismatch C26 · port_blocked C27 · connection_lost C28 · auth_failed C71 · stale C44 · config_changed C73 · config_invalid C2 · key_permissions C6 · key_unreadable C72 · key_invalid C72 · already_running C33 · internal C56 | - |
| stripped character ranges (9) | `src/log.ts:5` | C0, DEL, C1 C37, C78 · U+00AD, U+061C C83 · U+200B-200F, U+2028-202E, U+FEFF C78 · U+2060-2069 C78, C83 · tags C83 | - |
| key-leak paths (5) | `tests/key-leak.test.ts:68`-`:103` | all five C34 | - |
| shutdown signals (2) | `src/cli.ts:202` | C32 | - |
| backoff steps (7) | `src/defaults.ts:12` | C29 | - |
| startup assembly (2) | read directly: `src/cli.ts:185`-`:205`, `:167`; `tests/tunnel.test.ts:27` | subprocess C26, C32, C58 · harness C25 · production interface source read at `src/address-guard.ts:92` (R1) | - |

## Test policy rows

| Row | Files it classifies | Required proof | Expectation met |
| --- | --- | --- | --- |
| Decides, reached across a boundary | `src/proxy.ts`, `src/host.ts`, `src/address-guard.ts`, `src/status.ts`, `src/doctor.ts` | boundary and own layer | yes - proxy through channels and through the real tunnel (C30, C70); guard C12, C13 with C14, C65; status C38-C44, C73; doctor through `main` |
| Decides, not reached across a boundary | `src/tunnel.ts` backoff and forward filter, `src/config.ts`, `src/log.ts` sanitize | own layer, one case per row | yes - C29, C67, C1-C6, C60, C68, C72, C78, C83 |
| Entry point that decides nothing | `src/cli.ts` | boundary: accepted input, each rejected input, each error path | yes - C55, C56, C2, C68, C77 |
| Instrumentation | `src/log.ts` writer | none of its own | yes - covered by C37 and C61 |

## Faults injected

All faults were applied in a throwaway worktree at dd5ece4, one at a time, and the focused test files
were run. The worktree is removed and the main tree's `git status --porcelain` matched the baseline.
The Risk checks not listed here (C9, C12, C20, C21, C26, C34, C51, C58) were killed in round 1 at
cffb102; their decision lines are unchanged since.

| Check | Mutation | Location | Disposition |
| --- | --- | --- | --- |
| C64 | exec probe removed | `src/doctor.ts:194` | killed |
| C65 | `isRefusedAddress(a, interfaces)` -> `isRefusedAddress(a, {})` | `src/proxy.ts:146` | killed |
| C70 | origin close destroys the channel instead of flushing it | `src/proxy.ts:174` | killed |
| C75 | probe command given POSIX arithmetic again | `src/doctor.ts:171` | killed |
| C76 | "connect failed" no longer counts as allowed | `src/doctor.ts:203` | killed |
| C76 | local forward aimed at port 22 instead of `server.port` | `src/doctor.ts:201` | killed |
| C76 | second remote port never tried | `src/doctor.ts:213` | killed |
| C14 | fall back to `addresses[0]` when every address is refused | `src/proxy.ts:146` | killed |
| C15 | dial the host name instead of the checked address | `src/proxy.ts:149` | killed |
| C53 | sftp probe removed | `src/doctor.ts:195` | killed |
| C35 | filter call site replaced with `false` | `src/tunnel.ts:206` | equivalent - ssh2@1.17.0 rejects unregistered forwards at `client.js:1979` before the event fires, so no input reaches this line with a mismatch; the predicate itself is proven by C67 |
| C33 | single-instance guard removed | `src/cli.ts:151` | killed |
| C71 | `auth_failed` reported as `connection_lost` | `src/tunnel.ts:200` | killed |
| C72 | public keys accepted as private keys | `src/config.ts:168` | killed |
| C73 | target comparison disabled | `src/status.ts:47` | killed |
| C74 | key path printed unquoted | `src/doctor.ts:89` | killed |
| C79 | flush destroys instead of ending | `src/proxy.ts:171` | killed |
| C80 | idle timer cleared when a flush starts | `src/proxy.ts:165` | killed |
| C80 | `remote.off("data", touch)` removed | `src/proxy.ts:166` | equivalent - the pipe pauses its source when the other side closes, so no data event reaches the timer (R4) |
| C81 | closed-channel check after the lookup removed | `src/proxy.ts:143` | killed |
| C82 | upstream data no longer refreshes the idle timer | `src/proxy.ts:177` | killed |
| C83 | soft hyphen dropped from the stripped set | `src/log.ts:5` | killed |
| C84 | `AllowStreamLocalForwarding no` dropped from the fix | `src/doctor.ts:225` | killed |
| C13 | production default `os.networkInterfaces()` -> empty object | `src/address-guard.ts:92` | accepted - outside the Risk checks; confirmed by direct read and recorded as R1 |

## Security

- Skills applied: `security-review` on `9d043ee..dd5ece4` and the residual of the whole diff; WTK `security.md` section 5
- Threat model: `docs/security/threat-model.md`

| ID | Surface | Result | Evidence |
| --- | --- | --- | --- |
| SEC-001 | config | PASS | `tests/config.test.ts:84`, `:147`, `:174` |
| SEC-002 | proxy allowlist | PASS | `tests/proxy.test.ts:25`, `:34`, `:43` |
| SEC-003 | address guard | PASS | `tests/address-guard.test.ts:36`, `tests/proxy.test.ts:241` |
| SEC-004 | no listener | PASS | `tests/no-listener.test.ts:17`, `tests/run.test.ts:83`, `tests/tunnel.test.ts:262` |
| SEC-005 | host-key pin | PASS | `tests/run.test.ts:30`, `tests/doctor.test.ts:197` |
| SEC-006 | key leakage | PASS | `tests/config.test.ts:101`, `tests/key-leak.test.ts:73` |
| SEC-007 | request head | PASS | `tests/proxy.test.ts:152`, `:171` |
| SEC-008 | server lockdown | PASS | `tests/doctor.test.ts:253`, `:298`, `:381`, `:391`, `:415` |
| SEC-009 | resource limits | PASS | `tests/proxy.test.ts:126`, `:256`, `:316`, `:362` |
| SEC-010 | text reaching terminals and shells | PASS | `tests/doctor.test.ts:355`, `tests/tunnel.test.ts:334`, `:343` |

The changes since round 2 add no listener and no dependency. The one printed command quotes its path
and was run verbatim against a hostile path. The lockdown probe now counts "connect failed" as an
allowed local forward, which errs toward failing the hop. Open Critical: 0. Open Major: 0. Verdict: PASS.

## Reuse review

`run`, `status` and `doctor` now share one liveness rule (`src/status.ts:24`) instead of two copies.
The deep review lists remaining duplicates as unresolved advisories; none affects behaviour.

## Swept

Every `Swept` row that cites checks resolves to a test that exists and asserts the cited constraint.

## Approval

`plan.md` carries the user's approval for the revision at fd86af3 plus the door 3 change. Criteria
59-72 have no recorded approver (R3).

## Gate

`check_proofs.py cli-core` on a clean tree at dd5ece4 - 83 passed, 0 failed
`taskpolicy -b nice -n 10 bun run typecheck` - clean
`validate_verification.py cli-core` run at HEAD dd5ece4 with the regenerated `proofs.md` in the working tree, uncommitted.

Lessons (step 7) are not distilled here: this run was limited to committing this report.
