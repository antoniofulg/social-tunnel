# domain-management proofs

**HEAD**: 1784f8d
**Shell**: /bin/sh
**Result**: 8 pass, 9 fail

| Proof | Result | Line |
| --- | --- | --- |
| C1: run core / (pass) [domains C1] | no test ran |  |
| C2: run core / (pass) [domains C2] | no test ran |  |
| C3: load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-ssh-proof.ts | pass | exit 0 |
| C4: run core / (pass) [domains C4] | no test ran |  |
| C5: load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-chrome-proof.ts | pass | exit 0 |
| C6: run core / (pass) [domains C6] | no test ran |  |
| C7: run core / (pass) [domains C7] | no test ran |  |
| C8: load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-chrome-proof.ts | pass | exit 0 |
| C9: run core / (pass) [domains C9] | no test ran |  |
| C10: run core / (pass) [domains C10] | no test ran |  |
| C11: run core / (pass) [domains C11] | no test ran |  |
| C11: load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-chrome-proof.ts | pass | exit 0 |
| C12: run core / (pass) [domains C12] | no test ran |  |
| C12: run UI / [domains C12] | pass | ✓ src/settings/DomainsTab.test.tsx > [domains C12] submits the labelled form, waits for the same ope |
| C12: run native / domains_c12_ipc_rejects_unknown_payload_fields_and_non_settings_origins ... ok | pass | test domains_c12_ipc_rejects_unknown_payload_fields_and_non_settings_origins ... ok |
| C12: run native / domains_c12_native_scope_advances_before_settings_receives_equal_revision ... ok | pass | test domain_calls::tests::domains_c12_native_scope_advances_before_settings_receives_equal_revision  |
| C12: run native / domains_c12_quit_rejects_admission_and_cancels_and_reaps_the_owned_child ... ok | pass | test domain_calls::tests::domains_c12_quit_rejects_admission_and_cancels_and_reaps_the_owned_child . |

## Output

`Run core` - exit 0

```
bun test v1.4.4 (38afee6c8)

 35 pass
 0 fail
 566 expect() calls
Ran 35 tests across 1 file. [3.81s]
```

`load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-ssh-proof.ts` - exit 0

```
GO mode=normal load=4.87<=14
GO mode=normal load=4.87<=14
  [16ms]  bundle  4 modules
 [278ms] compile  /private/var/folders/lc/_v1mn5h560d2tsmz474y7d1c0000gn/T/st-domain-proof-rUZ4Yv/command bun-linux-aarch64-v1.4.4
GO mode=normal load=4.87<=14
  [36ms]  bundle  66 modules
 [151ms] compile  /private/var/folders/lc/_v1mn5h560d2tsmz474y7d1c0000gn/T/st-domain-proof-rUZ4Yv/fixture bun-linux-aarch64-v1.4.4
GO mode=normal load=4.87<=14
   [4ms]  bundle  1 modules
 [566ms] compile  /private/var/folders/lc/_v1mn5h560d2tsmz474y7d1c0000gn/T/st-domain-proof-rUZ4Yv/direct-witness bun-linux-aarch64-v1.4.4
b7e5f6e72dbe2ae0fcef712d058cc28a7ac633ac761d279c8239fd762dd09fee
GO mode=normal load=5.03<=14
Received disconnect from 127.0.0.1 port 44482:3:  [preauth]
[domains C3/C9] real pinned OpenSSH: fixed roles, denied channels and cross-role keys, shared pre-parse admission
st-domains-proof-a2f3b18f-526b-436d-bf63-31b098c2a108
```

`load-gate wait && taskpolicy -b nice -n 10 bun tests/managed-domains-chrome-proof.ts` - exit 0

```
GO mode=normal load=4.95<=14
GO mode=normal load=4.95<=14
  [20ms]  bundle  4 modules
 [281ms] compile  /private/var/folders/lc/_v1mn5h560d2tsmz474y7d1c0000gn/T/st-domain-proof-nqVcPh/command bun-linux-aarch64-v1.4.4
GO mode=normal load=4.79<=14
  [65ms]  bundle  66 modules
 [283ms] compile  /private/var/folders/lc/_v1mn5h560d2tsmz474y7d1c0000gn/T/st-domain-proof-nqVcPh/fixture bun-linux-aarch64-v1.4.4
GO mode=normal load=4.79<=14
  [11ms]  bundle  1 modules
 [382ms] compile  /private/var/folders/lc/_v1mn5h560d2tsmz474y7d1c0000gn/T/st-domain-proof-nqVcPh/direct-witness bun-linux-aarch64-v1.4.4
0636fdc75dad11fbe06d4f1ae5a43b7166a36eaf5bfecf193bfb73831e5aaaf0
GO mode=normal load=4.79<=14
[domains C7/C8/C9/C10/C11] pinned Chrome: authenticated positive over the real SSH forward, affirmative direct GET at the unprivileged loopback sink, wrong forwarding denied, epoch fencing and recovery
st-domains-proof-fc87dbe0-9e5b-4123-b78c-34ea724f5005
```

`Run UI` - exit 0

```
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] keeps the draft on duplicate and conflict, and refreshes without replaying the edit 88ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] confirms a named removal, keeps covered routes clear, and supports keyboard cancel 95ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] distinguishes legacy, unknown, recovery and verified empty 32ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] bounds pending refreshes and offers manual Retry of only the saved ID 42ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] preserves the exact pending ID and historical rows across tab switches and unreadable status 100ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] reopens by reading the durable CLI intent before offering the same-ID Retry 65ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] same-path config replacement clears rows and pending and ignores the outgoing Retry reply 75ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] a late baseline snapshot cannot put the window back on an older config 102ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] tab reentry keeps old rows historical until a fresh read confirms them 76ms
 ✓ src/settings/DomainsTab.test.tsx > [domains C12] confirms against the displayed scope, not an equal-revision replacement seen only by native 78ms

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Start at  08:08:49
   Duration  2.61s (environment 45%, tests 41%, setup 9%, transform 2%, import 2%)
```

`Run native` - exit 0

```
test tray_c9_csp_global_tauri_frontend_and_no_remote_capability ... ok
test tray_c31_twelve_template_images_at_18_and_36_px_with_rgb_zero ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s

     Running tests/sidecar.rs (target/debug/build/social-tunnel-app/9ade3c6f5d2397d6/out/sidecar-9ade3c6f5d2397d6)

running 5 tests
test tray_c13_runner_caps_stdout_at_the_limit ... ok
test tray_c6_legacy_argv_shapes_stay_unchanged ... ok
test tray_c7_bad_hosts_and_config_paths_are_refused_and_start_nothing ... ok
test tray_c8_sidecar_resolves_next_to_the_executable_not_on_path ... ok
test tray_c13_hung_garbled_oversized_or_rejected_status_reads_as_unreadable ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 10.07s
```

## Supplemental nominal Bun evidence

The automatic report above records nine `no test ran` rows because Bun suppressed individual names in this environment; the command exited zero with 35 passing tests. The Linux OpenSSH/Chrome, component and Rust commands all exited zero. They were not repeated for a console formatting issue.

On the same product source, ran `env -u CI -u CLAUDECODE taskpolicy -b nice -n 10 bun test --reporter=junit --reporter-outfile=/private/tmp/st-domain-core.DfzTexyG/core.xml tests/managed-domains.test.ts`. Exit 0; 35 passing JUnit cases, zero failed/skipped; Python XML readback produced the names below.

| Proof affected by missing names | Located passing test name from JUnit |
| --- | --- |
| C1 | `[domains C1] canonical public names, explicit PSL rules, and reserved proof names` |
| C2 | `[domains C2] only explicit unsupported returns setup required for a recognized enrollment` |
| C4 | `[domains C4] local guard keeps CONNECT 443 and dials only the checked public IP after activation` |
| C6 | `[domains C6] same SSH forward revokes DNS, late dials and live bytes before acknowledgement` |
| C7 | `[domains C7] publishing waits for the exact independent proxy receipt and does not claim browser activation` |
| C9 | `[domains C9] authorization is checked again after arming; disabling fences a verified old session before effects` |
| C10 | `[domains C10] a killed fixture CLI exposes the durably saved ID and Retry never resubmits` |
| C11 | `[domains C11] affirmative visits need current policy, exact browser context, fresh sink receipt and provisioned source` |
| C12 | `[domains C12] the real sidecar rejects equal-revision file substitution before Add or same-ID Retry` |

`checks.md` now derives console markers from the actual JUnit output and preserves the exit code. The original automatic report is not retroactively relabelled green.
