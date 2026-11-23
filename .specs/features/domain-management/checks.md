# Managed domains checks

Profile: ui
Risk: C2, C3, C4, C5, C6, C7, C8, C9, C10, C11 - authorization, fail-closed routing, publication and recovery.
Build: `load-gate wait && taskpolicy -b nice -n 10 bun run typecheck`
Run core: `set -e; report=$(mktemp -t managed-domains-junit); trap 'rm -f "$report"' EXIT; env -u CI -u CLAUDECODE taskpolicy -b nice -n 10 bun test --reporter=junit --reporter-outfile="$report" tests/managed-domains.test.ts; python3 -c 'import sys, xml.etree.ElementTree as x; print("\n".join("(pass) " + c.attrib["name"] for c in x.parse(sys.argv[1]).iter("testcase") if not any(e.tag in {"failure","error","skipped"} for e in c)))' "$report"`
Run UI: `cd app && load-gate wait && taskpolicy -b nice -n 10 bunx --no-install vitest run src/settings/DomainsTab.test.tsx --reporter=verbose --maxWorkers=2`
Run native: `cd app/src-tauri && load-gate wait && taskpolicy -b nice -n 10 cargo test --offline --locked -j 2 --lib --test domains --test policy --test sidecar -- --test-threads=2`
Plan: `.specs/features/domain-management/plan.md`
UI contract: `.specs/features/domain-management/uiux.md`

## Checks

**C1** - Add/remove canonical public hostnames including a non-social domain; reject URL, IP, wildcard, private/public suffix or reserved probe names, distinguish duplicate, absent and parent-covered entries, and allow a verified empty deny-all list (AC 1, SEC-002).
Proof: run core | (pass) [domains C1]

**C2** - Setup required performs no writes, and published, stale-observer or missing-receipt operations remain pending or activation unknown rather than applied (AC 2, SEC-004).
Proof: run core | (pass) [domains C2]

**C3** - Disposable OpenSSH accepts only the enrolled role's defined operation; shell, arbitrary command, TTY, SFTP, all forwarding directions and cross-role keys cannot acquire effects (AC 3, SEC-001).
Proof: `load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-ssh-proof.ts`

**C4** - Stale/invalid/racing writes cannot overwrite the one valid revision or inject PAC text/alternate proxy targets. An added host still must pass CONNECT 443 and checked-public-address gates (AC 4, SEC-002).
Proof: run core | (pass) [domains C4]

**C5** - Isolated integration test uses its own identities, profiles and policy; production/tunnel/login actions never occur. Chrome routes requested changes and fails closed when its selected proxy is unavailable (AC 5, SEC-004).
Proof: `load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-chrome-proof.ts`

**C6** - Revision acknowledgement follows matcher replacement and revocation of affected resolving, dialing and connected relays. Unchanged and still-covered hosts keep one tunnel connection and no new home listener (AC 6, SEC-003).
Proof: run core | (pass) [domains C6]

**C7** - An add/remove publishes only after home acknowledgement, unrelated selected domains stay proxy-only, stale PAC removal stays denied, and lost response repeats no edit (AC 7, SEC-003).
Proof: run core | (pass) [domains C7]

**C8** - In disposable Chrome, actual policy digest and matching current/wrong fresh route witnesses prove reload for that instance only; another instance or generation cannot satisfy it (AC 8, SEC-004).
Proof: `load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-chrome-proof.ts`

**C9** - A single durable intent exists before local work. No publication accepts missing, forged, edit-signed, stale, wrong-scope, wrong-digest or wrong-generation receipt. Disable fences the previous epoch including authenticated sessions. Request and list limits fail without writes (AC 9, SEC-001).
Proof: run core | (pass) [domains C9]

**C10** - Lost-response/restart recovery reads the immutable intent; revocation before effects cancels, while applied/published/unknown fences normal operations until a local admin proves a higher revision without restoring access or introducing unintended direct routing (AC 10, SEC-003).
Proof: run core | (pass) [domains C10]

**C11** - Unsupported, conflicting-policy or stale-baseline enrollment cannot edit. Browser observer loss/replacement and proxy-down, wrong context or wrong nonce do not prove an applied revision (AC 11, SEC-004).
Proof: run core | (pass) [domains C11]
Proof: `load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-chrome-proof.ts`

**C12** - Settings-only typed IPC and CLI preserve error/retry contract. Domains and tray distinguish verified zero, pending, unknown and applied; Add is keyboard-submittable and removal is explicitly confirmed (AC 12).
Proof: run core | (pass) [domains C12]
Proof: run UI | [domains C12]
Proof: run native | domains_c12_ipc_rejects_unknown_payload_fields_and_non_settings_origins ... ok
Proof: run native | domains_c12_native_scope_advances_before_settings_receives_equal_revision ... ok
Proof: run native | domains_c12_quit_rejects_admission_and_cancels_and_reaps_the_owned_child ... ok

## Coverage

| Set | Member → proof | Unproven |
| --- | --- | --- |
| Settings → Domains and native summaries (9) | setup required C2 C12 · verified empty C1 C12 · ready C12 · validation error C1 C12 · removal confirmation C12 · pending C2 C12 · activation unknown C2 C11 C12 · recovery required C10 C12 · applied C5 C8 C12 | - |
| Local CLI and Settings IPC (5) | list C12 · accepted C1 C12 · rejected C1 C4 C12 · conflict C4 C12 · retry of same intent C7 C10 C12 | - |
| Server policy control (6) | claimed C9 · rate limited C9 · stale C4 C9 · fenced C9 C10 · published C7 · proved C8 C11 | - |
| Recovery (4) | resumed C7 C10 · cancelled C10 · recovery required C10 C12 · reconciled C10 | - |
| Landings (8) | automatic restricted C3 C5 C12 · no admin key C3 C9 · publication and activation C2 C7 C8 C11 · local revocation C6 · transitions C7 · publication authority C9 · readiness C11 · revocation recovery C10 | - |
| Entities (6) | edit credential C3 C9 · domain list C1 C4 · PAC C5 C8 · live proxy C4 C6 · receipt principal C9 · operation C7 C10 | - |

## Test policy

| Subject | Proof layer | Why |
| --- | --- | --- |
| Validation, transaction and revocation | Bun hermetic injected fs/SSH/proxy controls, including existing proxy guard checks | Exercise the boundary without live DNS or keys |
| SSH account restrictions and browser policy | Disposable Linux OpenSSH and sandboxed Chrome | Fakes cannot prove SSH authorization, managed policy activation or real route selection |
| View states and shortcuts | Focused component test plus paired isolated rendered screenshots | DOM/state and native appearance prove different claims |

## Swept

- validation: C1, C4, C9.
- failure modes: C2, C5, C7, C10, C11.
- idempotency: C7, C9, C10.
- authorization: C3, C9, C11, C12.
- concurrency: C4, C6, C9.
- data lifecycle: C4, C9, C10.
- dependency failure: C5, C8, C10, C11.
- state transitions: C2, C6–C12.
- observability: C2, C8, C11, C12.
- deploy compatibility: C2, C5, C11; actual enrollment and external process upgrade remain authorization-gated.
- performance budget: C6, C9; one restricted forwarding session, one in-flight edit and bounded input.
