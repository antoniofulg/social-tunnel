# CLI core verification

**Verdict**: PASS
**Profile**: standard
**Diff range**: fd86af3..271cedf
**Round**: 2 - scoped
**Verifier**: independent sub-agent (author != verifier)
**Quarantined tests**: none

Round 1 (report 3a31e20, verified at cffb102) was FAIL on two Major findings. Both are closed, and no
Critical or Major finding is open. This round is scoped to the fix diff `3a31e20..271cedf` and to every
round 1 verdict that was not a pass. 161710a (README and `docs/design`) is outside the feature.

## Findings

Round 1 findings, rechecked at 271cedf:

| # | Round 1 | Status | Evidence |
| --- | --- | --- | --- |
| F1 | Major - `lockdown` passed a PTY-less shell and exec | Closed by 1572b03 | `src/doctor.ts:177` requests the shell with no PTY and `:182` probes exec; a probe counts when the marker comes back (`:165`). C64; three faults killed |
| F2 | Major - own-interface refusal unproven at the proxy | Closed by 93a83ac at the proxy boundary; one residual below (R1) | C65; the round 1 surviving mutant at `src/proxy.ts:149` is now killed |
| F3 | Medium - `run` refused over a stale state file | Closed by 4b9fc5b | `src/cli.ts:150`; C66; fault killed |
| F4 | Minor - forward filter untested | Closed by 4b9fc5b | `src/tunnel.ts:95`; C67; fault killed. The call site (`src/tunnel.ts:206`) stays unreachable through ssh2 |
| F5 | Minor - config and flag rejections untested | Closed by 74c39b6 | C68; fault killed |
| F6 | Minor - undeclared reasons and codes | Closed by 2356a63 | Surface row in `plan.md` names `auth_failed`, `key_invalid`, `key_unreadable` |
| F7 | Minor - head-phase channels uncapped | Closed by 93a83ac | `src/proxy.ts:80`; C69; fault killed |
| F8 | Process - `proofs.md` stale | Open, see Gate | `proofs.md` records 6465b40; HEAD is 271cedf, which differs only in `proofs.md` itself |

Open after this round (none blocks):

| # | Severity | Where | Scenario |
| --- | --- | --- | --- |
| R1 | Minor (proof gap) | `src/address-guard.ts:92` | Every test injects the interface list. Changing the production default from `os.networkInterfaces()` to an empty object leaves all 68 tests green. Read directly, the production assembly is right: `src/cli.ts:162` passes no `interfaces`, `src/proxy.ts:148` then passes `undefined`, and the default at `src/address-guard.ts:92` is evaluated on every call. |
| R2 | Minor (security residual) | `src/doctor.ts:159` | The probe command needs POSIX arithmetic (`$((6*7))`). A tunnel user whose login shell is `tcsh` or `fish` gets a working shell, never prints the marker, and passes `lockdown`. A second probe with a plain marker would close it. |
| R3 | Minor (process) | `.specs/features/cli-core/plan.md` `## Approval` | Criteria 59-61 were appended after round 1 and the approval receipt does not mention them. They tighten behaviour and remove nothing; the receipt should record that the user saw them. |

## Builder choices judged

| Choice | Judgment |
| --- | --- |
| A shell or exec counts as allowed only when the evaluated marker returns; a server that grants both requests and runs only its forced command passes | Accept. OpenSSH grants the session request and then runs `command=`, so counting the grant would fail the configuration the hop's own fix text recommends. The arithmetic keeps a forced command that echoes its input from counting. Criterion 59 records the rule. Residual R2. |
| Past the cap a channel gets `503` before its head is parsed | Accept. Criterion 61 records it. A malformed or unlisted request past the cap now gets `503` instead of `400` or `403`; the body stays fixed and nothing is looked up or dialled (`tests/proxy.test.ts:234`). Slots free on refusal and on close (`src/proxy.ts:84`, `:103`). |
| Round 1 deviations 1, 2, 3, 6, 7 | Carried from 3a31e20: accepted; 2 is now in the plan. |

## Checks

C64-C69 verified at 271cedf. The other 62 rows are carried from 3a31e20: their tests are unchanged
except the C53 name list, and the source changes under them were re-read and re-faulted where the fix
touched them (C14, C19, C33, C35, C53).

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
| C8 | `tests/proxy.test.ts` `[C8]` | yes | `tests/proxy.test.ts:10` - `expect(await channel.head()).toBe(OK head)`; `:14`, `:16` bytes both ways |
| C9 | `tests/proxy.test.ts` `[C9]` | yes | `tests/proxy.test.ts:24` - `toBe("HTTP/1.1 403 Forbidden")`; `:25`-`:26` `lookups` and `dials` equal `[]` |
| C10 | `tests/proxy.test.ts` `[C10]` | yes | `tests/proxy.test.ts:33` - 403; `:34`-`:35` no lookup, no dial |
| C11 | `tests/proxy.test.ts` `[C11]` | yes | `tests/proxy.test.ts:42` - 403; `:43`-`:44` no lookup, no dial |
| C12 | `tests/address-guard.test.ts` `[C12]` | yes | `tests/address-guard.test.ts:36` - `expect([first, isRefusedAddress(first, none)]).toEqual([first, true])`; `:38`-`:39` neighbours false; `:46` embedded forms |
| C13 | `tests/address-guard.test.ts` `[C13]` | yes | `tests/address-guard.test.ts:57` - `expect(isRefusedAddress("2a03:2880:1:2::99", interfaces)).toBe(true)`; the proxy boundary is C65 |
| C14 | `tests/proxy.test.ts` `[C14]` | yes | `tests/proxy.test.ts:50` - 403; `:52` `expect(h.dials).toEqual([])` |
| C15 | `tests/proxy.test.ts` `[C15]` | yes | `tests/proxy.test.ts:59` - `expect(h.dials.map(...)).toEqual([[PUBLIC, 443]])`; `:58` one lookup |
| C16 | `tests/proxy.test.ts` `[C16]` | yes | `tests/proxy.test.ts:65` - `toBe("HTTP/1.1 405 Method Not Allowed")`; `:66` ended |
| C17 | `tests/proxy.test.ts` `[C17]` | yes | `tests/proxy.test.ts:80` - 8193 bytes gives 400 (`:77` 8192 gives 200); `:90` 408 |
| C18 | `tests/proxy.test.ts` `[C18]` | yes | `tests/proxy.test.ts:99`, `:103` - 502; `:106`, `:109` - 504 |
| C19 | `tests/proxy.test.ts` `[C19]` | yes | `tests/proxy.test.ts:118` - 257th `toBe("HTTP/1.1 503 Service Unavailable")`; `:123` 200 after one closes |
| C20 | `tests/no-listener.test.ts` `[C20]` | yes | `tests/no-listener.test.ts:17` - `expect(hits).toEqual([])` |
| C58 | `tests/run.test.ts` `[C58]` | yes | `tests/run.test.ts:83` - `expect(listening.stdout.toString().trim()).toBe("")`; `:82` lsof sees the SSH socket |
| C21 | `tests/proxy.test.ts` `[C21]` | yes | `tests/proxy.test.ts:144` - `toEqual([target, "HTTP/1.1 400 Bad Request"])` over nine targets |
| C22 | `tests/proxy.test.ts` `[C22]` | yes | `tests/proxy.test.ts:163` - `expect(h.dials[0].received().equals(trailing)).toBe(true)`; `:164`-`:166` one answer, one lookup, one dial |
| C23 | `tests/proxy.test.ts` `[C23]` | yes | `tests/proxy.test.ts:175`-`:176` - `expect(wrongPort).toBe(unlisted)`, `expect(privateOnly).toBe(unlisted)`; `:186`-`:188` no address |
| C24 | `tests/proxy.test.ts` `[C24]` | yes | `tests/proxy.test.ts:198` - `until(() => channel.ended() && h.dials[0].remote.destroyed)` |
| C63 | `tests/proxy.test.ts` `[C63]` | yes | `tests/proxy.test.ts:203`-`:210` - `expect(DEFAULTS.headTimeoutMs).toBe(10000)` and the seven others |
| C25 | `tests/tunnel.test.ts` `[C25]` | yes | `tests/tunnel.test.ts:47` - `expect(t.names()).toEqual(["connecting", "connected"])`; `:49` the `tcpip-forward` request |
| C26 | `tests/run.test.ts` `[C26]` | yes | `tests/run.test.ts:30` - `expect(env.ssh.auth).toEqual([])`; `:28` code 13; `:31` state |
| C27 | `tests/tunnel.test.ts` `[C27]` | yes | `tests/tunnel.test.ts:59`-`:60` - names end `blocked/port_blocked`, `expect(delays).toEqual([30000])` |
| C28 | `tests/tunnel.test.ts` `[C28]` | yes | `tests/tunnel.test.ts:72` - five states in order; `:74` `retryAt` |
| C59 | `tests/tunnel.test.ts` `[C59]` | yes | `tests/tunnel.test.ts:91` - still connected before 3 intervals; `:94`-`:95` lost after |
| C29 | `tests/tunnel.test.ts` `[C29]` | yes | `tests/tunnel.test.ts:123` - `expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])`; `:127` reset to 1000 |
| C30 | `tests/tunnel.test.ts` `[C30]` | yes | `tests/tunnel.test.ts:141` - `expect(received).toBe(OK head)` through the forwarded port |
| C31 | `tests/tunnel.test.ts` `[C31]` | yes | `tests/tunnel.test.ts:163` - `expect(Object.keys(state).sort()).toEqual([nine fields])`; `:186`-`:187` inode changes, no `.tmp` left |
| C32 | `tests/run.test.ts` `[C32]` | yes | `tests/run.test.ts:42`-`:44` - code 0, `state: "stopped"`, forward then cancel requests |
| C33 | `tests/run.test.ts` `[C33]` | yes | `tests/run.test.ts:68`-`:69` - code 2, `error: { code: "already_running" }` |
| C34 | `tests/key-leak.test.ts` `[C34]` | yes | `tests/key-leak.test.ts:73`, `:80`, `:89`, `:96`, `:103` - `expect(leaked(keyPath, captured)).toEqual([])` on each of five paths |
| C35 | `tests/tunnel.test.ts` `[C35]` | yes | `tests/tunnel.test.ts:197`-`:199` - both announcements `toBe(false)`, `expect(t.handled.length).toBe(0)`. ssh2 produces the outcome; the project's own filter is now proven by C67 |
| C36 | `tests/tunnel.test.ts` `[C36]` | yes | `tests/tunnel.test.ts:225` - `expect(seen.size).toBeGreaterThanOrEqual(4)` for `connected` and `blocked` |
| C37 | `tests/tunnel.test.ts` `[C37]` | yes | `tests/tunnel.test.ts:240`-`:241` - line has no `host`, no `evil`; `:255` no control characters |
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
| C55 | `tests/cli.test.ts` `[C55]` | yes | `tests/cli.test.ts:14`-`:15` - code 2, usage on stderr; `:20`, `:24` exit 0 |
| C56 | `tests/cli.test.ts` `[C56]` | yes | `tests/cli.test.ts:35`, `:45` - under 5000 ms with stdin held open; `:53`-`:54` code 1, `error.code` `internal` |
| C64 | `tests/doctor.test.ts` `[C64]` | yes | `tests/doctor.test.ts:298`, `:302` - `expect([allowed, code]).toEqual([allowed, 14])` and exactly `shell` or `exec` named; `:295`-`:296` the forced-command server passes |
| C65 | `tests/proxy.test.ts` `[C65]` | yes | `tests/proxy.test.ts:218`, `:220` - `toBe("HTTP/1.1 403 Forbidden")`, `expect(home.dials).toEqual([])`; `:225` the same answer is dialled with no such interface |
| C66 | `tests/run.test.ts` `[C66]` | yes | `tests/run.test.ts:124`, `:126` - 91 s old: code 13 after one server connection; `:131`-`:132` 60 s old: code 2 `already_running` |
| C67 | `tests/tunnel.test.ts` `[C67]` | yes | `tests/tunnel.test.ts:259`-`:264` - `expect(isExpectedForward({ destIP: "0.0.0.0", destPort: 8888 }, 8888)).toBe(false)` and five more |
| C68 | `tests/config.test.ts` `[C68]` | yes | `tests/config.test.ts:174` - `toMatchObject({ ok: false, command: verb, error: { code: "config_invalid", field } })` over ten edits; `:188`-`:189` usage, exit 2 for four misplaced flags |
| C69 | `tests/proxy.test.ts` `[C69]` | yes | `tests/proxy.test.ts:233` - 257th channel `toBe("HTTP/1.1 503 Service Unavailable")` with 256 unfinished heads; `:239` 200 after one closes |

## Coverage

Rows whose authority the fix touched were recomputed at 271cedf; the rest are carried from 3a31e20.

| Set (size) | Recomputed from | Member -> proof | Unproven |
| --- | --- | --- | --- |
| door 1 exit codes (8) | `src/defaults.ts:18` | 0 C38 · 1 C56 · 2 C2 · 10 C39 · 11 C41 · 12 C50 · 13 C42 · 14 C53, C64 | - |
| door 2 envelope (3 verbs) | `src/cli.ts:96`, `:106`, `:126`, `:173` | status C43 · doctor C43 · run C43, C61 | - |
| door 3 path sources (6) | `src/config.ts:22` | all six C1 | - |
| door 3 schema validation (11 branches) | `src/config.ts:60`-`:106` | version, server, remotePort C2 · server.host, server.port, server.user, keyPath, unknown `server.*` key C68 · hostKey C60 · domains C3 · unknown top key C5 · key mode C6 | - |
| door 4 no local listener (3) | `src/` scan, `src/cli.ts:158` | C20 · C58 · C30 | - |
| door 5 CONNECT-only 443 (2) | `src/proxy.ts:131`, `:142` | C16 · C10 | - |
| door 6 ssh2 under Bun (1) | `package.json` pin 1.17.0 | C25 | - |
| door 7 state fields (9) | `src/state.ts:13` | all nine C31 | - |
| door 8 host-key pin (3) | `src/tunnel.ts:72`, `src/config.ts:80` | run C26 · doctor C51 · format C60 | - |
| run outcomes (3) | `src/cli.ts:151`, `:172` | 0 C32 · 2 C33, C66 · 13 C26 | - |
| status outcomes (5) | `src/status.ts:33`-`:40` | 0 C38 · 10 C39 · 11 C41 · 13 C42 · 2 C2 | - |
| doctor outcomes (7) | `src/doctor.ts` exits | 0 C52 · 2 C62 · 10 C52 · 11 C52 · 12 C50 · 13 C51 · 14 C53, C64 | - |
| CLI meta outcomes (2) | `src/cli.ts:69`, `:75`, `:81`-`:92` | unknown input C55, C68 · help and version C55 | - |
| proxy outcomes (8) | `src/proxy.ts:23` | 200 C8 · 400 C17, C21 · 403 C9 · 405 C16 · 408 C17 · 502 C18 · 503 C19, C69 · 504 C18 | - |
| refused ranges (25) | plan criterion 11 against `src/address-guard.ts:53`-`:82` | 24 ranges C12 · own interface C13 at the guard, C65 at the proxy | - |
| T1 request corpus (12) | `docs/security/threat-model.md:92` | C8, C9, C11, C21, C22 as listed | - |
| tunnel states (6) | `src/state.ts:25` | connecting, connected C25 · disconnected C28, C59 · reconnecting C28 · blocked C26, C27 · stopped C32 | - |
| status mapping (9) | `src/status.ts:30`-`:40` | C38-C42, C44 | - |
| doctor hops (8) | `src/doctor.ts:58`-`:243` | C62, C50, C54, C45, C51, C47, C48, C53, C49 | - |
| lockdown attempts (6) | `docs/security/threat-model.md:132`, `src/doctor.ts:172`-`:196` | shell C53 · shell without a PTY C64 · exec C64 · sftp C53 · local forward C53 · other port C53 | - |
| reason and error codes (11) | `plan.md` Surface row against `src/tunnel.ts:200`, `src/config.ts:136`, `src/cli.ts` | host_key_mismatch C26 · port_blocked C27 · connection_lost C28 · auth_failed C34 (`tests/key-leak.test.ts:78`) · stale C44 · config_invalid C2 · key_permissions C6 · key_invalid C34 (`tests/key-leak.test.ts:88`) · already_running C33 · internal C56 · key_unreadable read at `src/config.ts:150` | - |
| key-leak paths (5) | `tests/key-leak.test.ts:68`-`:103` | all five C34 | - |
| shutdown signals (2) | `src/cli.ts:197` | C32 | - |
| backoff steps (7) | `src/defaults.ts:12` | C29 | - |
| startup assembly (2) | read directly: `src/cli.ts:180`-`:200`, `:162`; `tests/tunnel.test.ts:26` | subprocess C26, C32, C58 · harness C25 · production interface source read at `src/address-guard.ts:92` (R1) | - |

`key_unreadable` has no test of its own; it is a fixed-text branch read at `src/config.ts:150` and `:163`.

## Test policy rows

| Row | Files it classifies | Required proof | Expectation met |
| --- | --- | --- | --- |
| Decides, reached across a boundary | `src/proxy.ts`, `src/host.ts`, `src/address-guard.ts`, `src/status.ts`, `src/doctor.ts` | boundary and own layer | yes - own-interface refusal now has C13 at its layer and C65 at the boundary |
| Decides, not reached across a boundary | `src/tunnel.ts` backoff and forward filter, `src/config.ts` | own layer, one case per row | yes - C29, C67, C1, C2, C3, C5, C60, C68 |
| Entry point that decides nothing | `src/cli.ts` | boundary: accepted input, each rejected input, each error path | yes - C55, C56, C2, C68 |
| Instrumentation | `src/log.ts` | none of its own | yes - covered by C37 and C61 |

## Faults injected

Round 2 faults were applied in a throwaway worktree at 271cedf; it is removed and the main tree's
`git status --porcelain` matched the baseline. Rows marked "carried" were killed at cffb102 in round 1
on code the fix did not touch.

| Check | Mutation | Location | Disposition |
| --- | --- | --- | --- |
| C64 | shell probe requests a PTY again | `src/doctor.ts:177` | killed |
| C64 | exec probe removed | `src/doctor.ts:182` | killed |
| C64 | a granted channel counts without the marker | `src/doctor.ts:161` | killed |
| C65 | `isRefusedAddress(a, interfaces)` -> `isRefusedAddress(a, {})` (the round 1 survivor) | `src/proxy.ts:149` | killed |
| C14 | fall back to `addresses[0]` when every address is refused | `src/proxy.ts:149` | killed |
| C53 | sftp probe removed | `src/doctor.ts:183` | killed |
| C35 | filter call site replaced with `false` | `src/tunnel.ts:206` | equivalent - ssh2@1.17.0 rejects unregistered forwards at `client.js:1979` before the event fires, so no input reaches this line with a mismatch; the predicate itself is killed under C67 |
| C67 | bind-address comparison removed | `src/tunnel.ts:95` | killed |
| C66 | freshness condition removed from the guard | `src/cli.ts:151` | killed |
| C33 | freshness always false | `src/cli.ts:150` | killed |
| C69 | every channel takes a slot regardless of the cap | `src/proxy.ts:80` | killed |
| C19 | `open < relayCap` -> `open <= relayCap` | `src/proxy.ts:80` | killed |
| C68 | `server.port` validation removed | `src/config.ts:75` | killed |
| C13 | production default `os.networkInterfaces()` -> empty object | `src/address-guard.ts:92` | accepted - outside the Risk checks; the default is confirmed by direct read and recorded as R1 |
| C9 | carried: `host.endsWith("." + d)` -> `host.endsWith(d)` | `src/host.ts:12` | killed |
| C12 | carried: `172.16.0.0/12` -> `/13` | `src/address-guard.ts:59` | killed |
| C15 | carried: dial the host name instead of the checked address | `src/proxy.ts:152` | killed |
| C20 | carried: plain listener added to `run` | `src/cli.ts:157` | killed |
| C58 | carried: listener hidden from the source scan | `src/cli.ts:157` | killed |
| C21 | carried: hostname grammar accepts `_` | `src/host.ts:1` | killed |
| C26 | carried: `hostVerifier` returns `true` | `src/tunnel.ts:74` | killed |
| C34 | carried: key bytes logged on `run`; key line in a doctor hop detail | `src/cli.ts:157`, `src/doctor.ts:130` | killed |
| C51 | carried: host key mismatch exits 10 instead of 13 | `src/doctor.ts:118` | killed |

## Security

- Skills applied: `security-review` on the fix diff; WTK `security.md` section 5
- Threat model: `docs/security/threat-model.md`

| ID | Surface | Result | Evidence |
| --- | --- | --- | --- |
| SEC-001 | config | PASS | `tests/config.test.ts:84`, `:147`, `:174` |
| SEC-002 | proxy allowlist | PASS | `tests/proxy.test.ts:24`, `:33`, `:42` |
| SEC-003 | address guard | PASS | `tests/address-guard.test.ts:36`, `tests/proxy.test.ts:218` |
| SEC-004 | no listener | PASS | `tests/no-listener.test.ts:17`, `tests/run.test.ts:83`, `tests/tunnel.test.ts:261` |
| SEC-005 | host-key pin | PASS | `tests/run.test.ts:30`, `tests/doctor.test.ts:197` |
| SEC-006 | key leakage | PASS | `tests/config.test.ts:101`, `tests/key-leak.test.ts:73` |
| SEC-007 | request head | PASS | `tests/proxy.test.ts:144`, `:163` |
| SEC-008 | server lockdown | PASS | `tests/doctor.test.ts:256`, `:302`; residual R2 |
| SEC-009 | resource limits | PASS | `tests/proxy.test.ts:118`, `:198`, `:233` |

The fix diff adds no listener, no new dependency and no output of key or server text outside the
sanitised paths; the probe command is a fixed string. Open Critical: 0. Open Major: 0. Verdict: PASS.

## Reuse review

Carried from 3a31e20. The fix round adds one shared test helper (`tests/helpers.ts:23` `keyPair`) used by
both key generators, and exports the forward predicate instead of duplicating it.

## Swept

The new `Swept` entries (C64-C69) resolve to tests that exist and assert the cited constraint.

## Approval

`plan.md` carries the `## Approval` receipt for the plan (2026-11-21, revision fd86af3 plus the door 3
change). Criteria 59-61 are not in the receipt (R3).

## Gate

`env -u CLAUDECODE taskpolicy -b nice -n 10 bun test` at 271cedf - 68 passed, 0 failed
`taskpolicy -b nice -n 10 bun run typecheck` - clean

Lessons (step 7) are not distilled here: this run was limited to committing this report.
