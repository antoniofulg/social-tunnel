# CLI core verification

**Verdict**: FAIL
**Profile**: standard
**Diff range**: fd86af3..4c66501 (code verified at cffb102; 4c66501 adds only `docs/design/`, committed by another agent during this run)
**Round**: 1 - full
**Verifier**: independent sub-agent (author != verifier)
**Quarantined tests**: none

Two Major findings block completion: the `lockdown` hop passes a server that grants a shell without a
PTY or grants exec (F1), and the own-interface refusal has no proof at the proxy boundary - a mutant
that disables it survives the whole suite (F2). 62/62 proofs are green and 61 checks hold as written.

## Findings

| # | Severity | Where | Failure scenario |
| --- | --- | --- | --- |
| F1 | Major (security, invariant 4, SEC-008, threat T5) | `src/doctor.ts:158` | The shell probe calls `c.shell(cb)` with ssh2's default PTY request. ssh2 (`node_modules/ssh2/lib/client.js:1273`) returns the PTY error and never sends the shell request. A server that refuses the PTY but grants the shell - what OpenSSH does for `restrict,port-forwarding,permitlisten=...` with no `command=` - gets `lockdown ok: true`, detail "the server refused a shell", exit 0. Reproduced in a scratch worktree against the test server with PTY refused and shell granted, and again with exec granted: both exit 0. Exec is never probed although threat-model control T5 (`docs/security/threat-model.md:132`) names "an exec or shell session". Builder deviation 4 understates this: it is not only an exec-only server. C53's table has no such server, so the check stays green. |
| F2 | Major (proof gap, invariant 1, SEC-003) | `src/proxy.ts:146`, `tests/proxy-harness.ts:37` | Criterion 11 requires a `403` from the proxy for an address inside a local interface prefix. C13 proves only `isRefusedAddress`; every proxy test passes `interfaces: () => ({})`, and no test sends a CONNECT through the production assembly (`src/cli.ts:160`). Mutant `isRefusedAddress(a, interfaces)` -> `isRefusedAddress(a, {})` at `src/proxy.ts:147`: full suite 62 pass. The code is correct today; a regression that reopens the LAN (global IPv6 /64) would ship green. |
| F3 | Medium | `src/cli.ts:149` | `run` refuses with `already_running` (exit 2) whenever `state.json` names any live pid, with no staleness check, while `status` reports the same file as `stopped`/`stale` (`src/status.ts:37`). After a SIGKILL or power loss and pid reuse, `run` cannot start until the user deletes `state.json`. Reproduced: state with pid 1 and an old `updatedAt` gives `status` exit 10 `stale` and `run` exit 2 `already_running`. Matches criterion 27 literally; the criterion and criterion 51 disagree. |
| F4 | Minor | `src/tunnel.ts:201` | The project's destIP/destPort filter is unreachable: ssh2 rejects any forward not registered by `forwardIn` before emitting `tcp connection` (`node_modules/ssh2/lib/client.js:1979`). Replacing the condition with `false` leaves C35 green. The claimed outcome holds through the pinned dependency; the project's own guard has no test and would not be missed if ssh2 changed. Builder deviation 5 confirmed. |
| F5 | Minor | `src/config.ts:72`, `:75`, `:76`, `:87`, `:69`; `src/cli.ts:69`, `:75` | No test asserts rejection of a bad `server.host`, `server.port`, `server.user`, `keyPath`, an unknown `server.*` key, `--config` with no value, or `--domain` on a verb other than `doctor`. |
| F6 | Minor (precision gap in the plan) | `src/tunnel.ts:194`, `src/config.ts:136` | Reason `auth_failed` and codes `key_invalid`, `key_unreadable` are part of the `--json` contract but the plan names none of them. `auth_failed` is retried forever with backoff capped at 30 s, which can trip a server-side lockout. |
| F7 | Minor | `src/proxy.ts:138` | The relay cap counts a channel only after its head parses, so channels still sending a head are unbounded (each limited to 8 KiB and 10 s). |
| F8 | Process | `.specs/features/cli-core/proofs.md:3` | `proofs.md` records HEAD 79cb9a2; HEAD is 4c66501. The gate refuses until `check_proofs.py` runs again. I reran the suite at cffb102 (source identical to 79cb9a2): 62 pass, 0 fail; typecheck clean. |

## Builder deviations

| # | Deviation | Judgment |
| --- | --- | --- |
| 1 | State stays `blocked`/`port_blocked` during the 30 s retries | Accept. Frozen check C36 names "while retrying in `blocked`/`port_blocked`", and `status` keeps exit 11. Criteria 21 and 23 conflict; the plan should say which wins. |
| 2 | Extra `auth_failed`, `key_invalid` | Accept as additive; recorded as F6. |
| 3 | Non-canonical port 400, well-formed non-443 403 | Accept. Matches C10 and C21 and criteria 9 and 44 read together. |
| 4 | Lockdown shell probe uses a TTY request | Finding F1 (Major). |
| 5 | C35 filter shadowed by ssh2 | Confirmed; outcome holds, guard untested. F4 (Minor). |
| 6 | C34 doctor paths in-process | Accept. They run through `main`, and the test also captures the real process streams (`tests/key-leak.test.ts:52`). A leak injected into a doctor hop detail was caught. |
| 7 | `--execute` baseline ran after S1 code | Accept. Not reconstructible; the injected faults show the Risk tests can fail. |

## Checks

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
| C13 | `tests/address-guard.test.ts` `[C13]` | yes | `tests/address-guard.test.ts:57` - `expect(isRefusedAddress("2a03:2880:1:2::99", interfaces)).toBe(true)`. Holds for the guard, as the check words it; the proxy boundary is F2 |
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
| C35 | `tests/tunnel.test.ts` `[C35]` | yes | `tests/tunnel.test.ts:197`-`:199` - both announcements `toBe(false)`, `expect(t.handled.length).toBe(0)`. The outcome is asserted and holds; ssh2 produces it, not `src/tunnel.ts:201` (F4) |
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
| C53 | `tests/doctor.test.ts` `[C53]` | yes | `tests/doctor.test.ts:253`, `:256` - code 14 and exactly the allowed attempt named; `:250` pass on the fifth. Holds for the five servers the check lists; F1 is outside that table |
| C54 | `tests/doctor.test.ts` `[C54]` | yes | `tests/doctor.test.ts:272`, `:274` - key hop ok, detail matches `/dedicated key/` |
| C55 | `tests/cli.test.ts` `[C55]` | yes | `tests/cli.test.ts:14`-`:15` - code 2, usage on stderr; `:20`, `:24` exit 0 |
| C56 | `tests/cli.test.ts` `[C56]` | yes | `tests/cli.test.ts:35`, `:45` - under 5000 ms with stdin held open; `:53`-`:54` code 1, `error.code` `internal` |

## Coverage

| Set (size) | Recomputed from | Member -> proof | Unproven |
| --- | --- | --- | --- |
| door 1 exit codes (8) | `src/defaults.ts:18` | 0 C38 · 1 C56 · 2 C2 · 10 C39 · 11 C41 · 12 C50 · 13 C42 · 14 C53 | - |
| door 2 envelope (3 verbs) | `src/cli.ts:96`, `:106`, `:126`, `:171` | status C43 · doctor C43 · run C43, C61 | - |
| door 3 path sources (6) | `src/config.ts:22` | all six C1 | - |
| door 3 schema validation (11 branches) | `src/config.ts:60`-`:106` | version, server, remotePort C2 · hostKey C60 · domains C3 · unknown top key C5 · key mode C6 | `server.host`, `server.port`, `server.user`, `keyPath`, unknown `server.*` key (F5) |
| door 4 no local listener (3) | `src/` scan, `src/cli.ts:156` | C20 · C58 · C30 | - |
| door 5 CONNECT-only 443 (2) | `src/proxy.ts:125`, `:136` | C16 · C10 | - |
| door 6 ssh2 under Bun (1) | `package.json` pin 1.17.0 | C25 | - |
| door 7 state fields (9) | `src/state.ts:13` | all nine C31 | - |
| door 8 host-key pin (3) | `src/tunnel.ts:72`, `src/config.ts:80` | run C26 · doctor C51 · format C60 | - |
| run outcomes (3) | `src/cli.ts:150`, `:170` | 0 C32 · 2 C33 · 13 C26 | - |
| status outcomes (5) | `src/status.ts:33`-`:40` | 0 C38 · 10 C39 · 11 C41 · 13 C42 · 2 C2 | - |
| doctor outcomes (7) | `src/doctor.ts` exits | 0 C52 · 2 C62 · 10 C52 · 11 C52 · 12 C50 · 13 C51 · 14 C53 | - |
| CLI meta outcomes (2) | `src/cli.ts:81`-`:92` | C55 | - |
| proxy outcomes (8) | `src/proxy.ts:23` | 200 C8 · 400 C17, C21 · 403 C9 · 405 C16 · 408 C17 · 502 C18 · 503 C19 · 504 C18 | - |
| refused ranges (25) | plan criterion 11 against `src/address-guard.ts:53`-`:82` | 24 ranges C12 (`tests/address-guard.test.ts:9`-`:33`) · own interface C13 at the guard only | own-interface prefix refused by the proxy with 403 (F2) |
| T1 request corpus (12) | `docs/security/threat-model.md:92` | C8, C9, C11, C21, C22 as listed | - |
| tunnel states (6) | `src/state.ts:25` | connecting, connected C25 · disconnected C28, C59 · reconnecting C28 · blocked C26, C27 · stopped C32 | - |
| status mapping (9) | `src/status.ts:30`-`:40` | C38-C42, C44 | - |
| doctor hops (8) | `src/doctor.ts:58`-`:219` | C62, C50, C54, C45, C51, C47, C48, C53, C49 | - |
| lockdown attempts (4 in the plan) | `docs/security/threat-model.md:132` | shell with PTY, sftp, local forward, other port C53 | exec session; shell without a PTY (F1) |
| key-leak paths (5) | `tests/key-leak.test.ts:68`-`:103` | all five C34 | - |
| shutdown signals (2) | `src/cli.ts:195` | C32 | - |
| backoff steps (7) | `src/defaults.ts:12` | C29 | - |
| startup assembly (2) | `src/cli.ts:179`-`:198`, `tests/tunnel.test.ts:26` | subprocess C26, C32, C58 · harness C25 | production resolver, dialer and interface list (`src/cli.ts:187`, `:160`) carry no CONNECT in any test (F2) |

## Test policy rows

| Row | Files it classifies | Required proof | Expectation met |
| --- | --- | --- | --- |
| Decides, reached across a boundary | `src/proxy.ts`, `src/host.ts`, `src/address-guard.ts`, `src/status.ts`, `src/doctor.ts` | boundary and own layer | gap - own-interface refusal has an own-layer proof (C13) and none at the boundary (F2); the rest is met |
| Decides, not reached across a boundary | `src/tunnel.ts` backoff, `src/config.ts` | own layer, one case per row | gap - five config validation branches have no case (F5); backoff and path resolution met |
| Entry point that decides nothing | `src/cli.ts` | boundary: accepted input, each rejected input, each error path | gap - `--config` with no value and `--domain` on another verb untested (F5); the rest is met by C55, C56, C2 |
| Instrumentation | `src/log.ts` | none of its own | yes - covered by C37 and C61 |

## Faults injected

Each fault was applied in a throwaway worktree at HEAD and the focused test file was run. The worktree is removed; the main tree's `git status --porcelain` matched the baseline.

| Check | Mutation | Location | Disposition |
| --- | --- | --- | --- |
| C9 | `host.endsWith("." + d)` -> `host.endsWith(d)` | `src/host.ts:12` | killed |
| C12 | `172.16.0.0/12` -> `/13` | `src/address-guard.ts:59` | killed |
| C14 | fall back to `addresses[0]` when every address is refused | `src/proxy.ts:147` | killed |
| C15 | dial the host name instead of the checked address | `src/proxy.ts:150` | killed |
| C20 | `net.createServer().listen(0, "127.0.0.1")` in `run` | `src/cli.ts:155` | killed |
| C58 | a listener built through computed property names, which the source scan does not see | `src/cli.ts:155` | killed |
| C21 | hostname grammar accepts `_` | `src/host.ts:1` | killed |
| C26 | `hostVerifier` returns `true` | `src/tunnel.ts:74` | killed |
| C34 | log the key bytes on `run` | `src/cli.ts:155` | killed |
| C34 | a key line added to the `ssh_auth` hop detail in `doctor` | `src/doctor.ts:130` | killed |
| C51 | host key mismatch exits 10 instead of 13 | `src/doctor.ts:118` | killed |
| C53 | sftp probe removed | `src/doctor.ts:159` | killed |
| C35 | filter condition replaced with `false` | `src/tunnel.ts:201` | equivalent - ssh2@1.17.0 rejects unregistered forwards at `client.js:1979` before the event fires, so no input reaches this line with a mismatch (F4) |
| C13 | `isRefusedAddress(a, interfaces)` -> `isRefusedAddress(a, {})` | `src/proxy.ts:147` | survived - full suite 62 pass (F2) |

## Security

- Skills applied: `security-review` on the full diff; WTK `security.md` section 5
- Threat model: `docs/security/threat-model.md`

| ID | Surface | Result | Evidence |
| --- | --- | --- | --- |
| SEC-001 | config | PASS | `tests/config.test.ts:84`, `:147` |
| SEC-002 | proxy allowlist | PASS | `tests/proxy.test.ts:24`, `:33`, `:42` |
| SEC-003 | address guard | FAIL | own-interface refusal unproven at the proxy, `src/proxy.ts:147` (F2); ranges PASS at `tests/address-guard.test.ts:36` |
| SEC-004 | no listener | PASS | `tests/no-listener.test.ts:17`, `tests/run.test.ts:83` |
| SEC-005 | host-key pin | PASS | `tests/run.test.ts:30`, `tests/doctor.test.ts:197` |
| SEC-006 | key leakage | PASS | `tests/config.test.ts:101`, `tests/key-leak.test.ts:73` |
| SEC-007 | request head | PASS | `tests/proxy.test.ts:144`, `:163` |
| SEC-008 | server lockdown | FAIL | `src/doctor.ts:158` (F1) |
| SEC-009 | resource limits | PASS | `tests/proxy.test.ts:118`, `:198`; head-phase channels uncapped (F7, Minor) |

Residual review found no injection path, no secret in output or state, no listener, and one pinned runtime dependency (`ssh2` 1.17.0 in `bun.lock`). Open Critical: 0. Open Major: 2 (F1, F2). Verdict: FAIL.

## Reuse review

First code in the repository, so nothing existing was bypassed. Inside the diff: the `doctor` egress hop repeats the proxy's resolve, guard and dial sequence (`src/doctor.ts:195`, `src/proxy.ts:144`), and two test files define the same locked-server helper (`tests/doctor.test.ts:19`, `tests/key-leak.test.ts:23`). Neither needs action now.

## Swept

Every `Swept` row that cites checks resolves to a test that exists and asserts the cited constraint. The `n/a` rows are approved policy.

## Approval

`plan.md` carries the `## Approval` receipt (user decision, 2026-11-21, revision fd86af3 plus the door 3 change). The later criteria revision is recorded as reported to the user for objection, not as a second approval.

## Gate

`env -u CLAUDECODE taskpolicy -b nice -n 10 bun test` at cffb102 - 62 passed, 0 failed
`taskpolicy -b nice -n 10 bun run typecheck` - clean

Lessons (step 7) are not distilled here: this run was limited to committing this report.
