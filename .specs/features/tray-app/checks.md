# Tray app checks

Profile: ui
Risk: C5, C6, C7, C8, C9, C10, C13, C14, C25, C36, C86, C87, C89, C90, C23, C24, C36, C38, C39, C41, C44, C46, C47, C48, C54, C73, C79, C82, C83, C84, C85 - the webview boundary, the sidecar argv allowlist and path, file access, the states that must stop retrying, and every rule that keeps the app off the user's own LaunchAgent run; a weak test there ships a webview that starts processes, a key on screen, or a killed tunnel
Build: `taskpolicy -b nice -n 10 bun run typecheck && (test ! -d app || (cd app && taskpolicy -b nice -n 10 bunx tsc --noEmit && cd src-tauri && taskpolicy -b nice -n 10 cargo clippy -j 2 --all-targets -- -D warnings))`
Run cli: `env -u CLAUDECODE taskpolicy -b nice -n 10 bun test tests/app-contract.test.ts tests/install-local.test.ts`
Run sidecar: `taskpolicy -b nice -n 10 bun run build:sidecar && cd app && env -u CLAUDECODE taskpolicy -b nice -n 10 bun test ./bun-tests/sidecar-compiled.test.ts`
Run rust: `cd app/src-tauri && taskpolicy -b nice -n 10 cargo test -j 2 -- --test-threads=2`
Run ui: `cd app && taskpolicy -b nice -n 10 bunx vitest run src --reporter=verbose --maxWorkers=2`
Run dist: `cd app && taskpolicy -b nice -n 10 bunx vite build && taskpolicy -b nice -n 10 bunx vitest run tests/dist --reporter=verbose && taskpolicy -b nice -n 10 bunx playwright test --project=webkit --workers=1 --reporter=list`
Run bundle: `cd app && load-gate wait && CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 bunx tauri build --bundles app --no-sign --no-binary-patching -- --locked && env -u CI -u CLAUDECODE taskpolicy -b nice -n 10 bun test ./bun-tests/bundle.test.ts`
Run smoke: `app/scripts/smoke-installed.sh`
Plan: `.specs/features/tray-app/plan.md`
UI contract: `.specs/features/tray-app/uiux.md`

90 checks in 4 slices (C<n> proves plan criterion n) · 11 one-way doors · 0 open (questions 2 and 3 answered; retiring the user's LaunchAgent is a non-blocking follow-up)

Root `bun test` (cli-core's `Run unit`) collects only `tests/` through `bunfig.toml` `[test] root = "tests"`
(plan Landing 10, C86): the Bun tests that need a built sidecar or bundle live in `app/bun-tests/`,
and app Vitest files live in `app/src` and `app/tests`, so neither runs under cli-core's suite. Checked
on Bun 1.4.4 on 2026-11-22: with that bunfig, root `bun test` ran only `tests/`, and
`cd app && env -u CLAUDECODE bun test ./bun-tests/<file>` printed `(pass) [tray-app C<n>] ...`.

Test names carry the feature and check id so they never match cli-core's `[C<n>]` lines: Bun and
Vitest tests are named `[tray-app C<n>] ...`, Rust tests `tray_c<n>_...` (cargo prints
`test <path>::tray_c<n>_<name> ... ok`). Rust tests that read files (config, capabilities, PNGs,
fixtures) live in `app/src-tauri/tests/`, never in `src/`, so C10's scan of `src/` stays exact.

Seams: the app's `model` is a pure function of (status result, latest doctor result, ownership,
observed downtime, clock, Reduce Motion flag); the poller and supervisor take a `Runner` (spawns a
command, returns pid, exit and output), a `Clock`, a `Clipboard` and a `LoginItem`; production wires
the bundled sidecar, the system clock, `tauri-plugin-clipboard-manager` and `tauri-plugin-autostart`.
Supervisor tests run a fake sidecar shell script from `app/src-tauri/tests/fixtures/` that exits
with the code it is given, traps SIGTERM and records the signals it received.

Load gate: run `load-gate wait` before `Run sidecar`, `Run rust`, `Run dist`, `Run bundle` and the
build line; never change the mode.

`smoke-installed.sh` runs against the copy in `~/Applications` after `install-local.sh`. `login`
and `preflight` do not launch the tray. Native smoke requires a matching connected sidecar PID,
an unlocked session and Accessibility access before launch. It reads the menu without printing
private values. Only a real native walk and cropped captures can settle the installed UI checks.

## Checks

### S1 - The tray shows the live tunnel state

**C1** - `status --json` on a valid config prints `server.user`, `server.hostKey`, absolute `keyPath` and `allowlist` equal to the normalized config domains in order, and every field of cli-core C7/C30 with an unchanged value and type, `configPath` unchanged and `domains` a number (SIDE-01, AC 1)
Proof: run cli | (pass) [tray-app C1]

**C2** - With a missing config and with a non-JSON config, `status --json` and `run --json` each exit 2 with `error.code` `config_invalid` and a top-level `configPath` equal to the absolute path they resolved (SIDE-01, AC 2)
Proof: run cli | (pass) [tray-app C2]

**C3** - `bun run build:sidecar` writes `app/src-tauri/binaries/social-tunnel-<rustc host triple>`, and that file run with `--version` prints `package.json`'s version and exits 0 (SIDE-01, AC 3)
Proof: run sidecar | (pass) [tray-app C3]

**C4** - The compiled sidecar's `run --json` against an in-process `ssh2` server with the pinned host key makes the same binary's `status --json` print `"state":"connected"` and exit 0 within 10 s (SIDE-01, AC 4)
Proof: run sidecar | (pass) [tray-app C4]

**C5** - Every capability file under `app/src-tauri/capabilities/` holds no permission starting with any of the 9 forbidden prefixes; the union of permissions equals core event listen/unlisten plus `allow-get-snapshot`, `allow-run-check`, `allow-copy-fix`, `allow-set-open-at-login`; and because Tauri v2 lets the webview call any registered command unless an app manifest is set, `build.rs` sets `AppManifest::commands` to exactly those 4 names and `generate_handler!` registers exactly those 4 (SAFE-01, AC 5)
Proof: run rust | tray_c5_ ok

**C6** - The argv builder returns exactly `["status","--json"]`, `["doctor","--json"]`, `["doctor","--json","--domain","instagram.com"]`, `["run","--json"]`, and each with `"--config","/abs/config.json"` appended, for its 4 call kinds (SAFE-01, AC 6)
Proof: run rust | tray_c6_ ok

**C7** - The argv builder returns an error for hosts `""`, `-x.com`, `a\0b.com`, `a b.com`, `exa_mple.com` and config paths `config.json`, `-c`, `/a\0b`, and the supervisor's runner records zero spawns for each (SAFE-01, AC 7)
Proof: run rust | tray_c7_ ok

**C8** - The sidecar path resolver given executable `/X/social-tunnel.app/Contents/MacOS/social-tunnel-app` returns `/X/social-tunnel.app/Contents/MacOS/social-tunnel`, and with `PATH` holding a directory with another `social-tunnel` the resolved path is unchanged (SAFE-01, AC 8)
Proof: run rust | tray_c8_ ok

**C9** - `tauri.conf.json` has the exact CSP string of AC 9, `withGlobalTauri` false, `frontendDist` `../dist`, and no capability carries a `remote` key (SAFE-01, AC 9)
Proof: run rust | tray_c9_ ok

**C10** - `app/src-tauri/src` holds no `fs::` path (so no `use std::fs;` then `fs::metadata`, `fs::read_dir`, `fs::copy`, `fs::remove_file`), no `std::fs`, `read_dir`, `metadata(`, `include_str!`, `include_bytes!`, `File::`, `OpenOptions` or `tokio::fs` (tray images come from `tauri::include_image!`), and exactly one line calling `.try_exists(` that is not a comment (SAFE-01, AC 10)
Proof: `! grep -rnE '\bfs::|std::fs\b|read_dir|metadata\(|include_str!|include_bytes!|File::|OpenOptions|tokio::fs' app/src-tauri/src && test "$(grep -rhE '^[^/]*\.try_exists\(' app/src-tauri/src | wc -l | tr -d ' ')" = 1`

**C11** - The installed app runs as a UI element (`lsappinfo` `ApplicationType` = `UIElement`) with exactly one menu bar extra (TRAY-01, AC 11)
Proof: run smoke | PASS [tray-app C11]

**C12** - With ticks at 0, 2, 4, 6, 8 and 10 s of fake time: an instant runner gets 6 calls; a runner whose call takes 5 s gets calls at 0 and 6 s only, never 2 in flight (TRAY-01, AC 12)
Proof: run rust | tray_c12_ ok

**C13** - A status call that hangs past 10 s (killed), prints `not json`, prints two objects, prints 1 MiB + 1 byte, or gives a result C90 rejects each yields Disconnected with the row `Can't read the tunnel status.` (TRAY-01, AC 13)
Proof: run rust | tray_c13_ ok

**C14** - Status exit 2 `config_invalid` with a `configPath` that does not exist yields the not-set-up image and exactly the 6 menu entries of AC 14 (TRAY-01, AC 14)
Proof: run rust | tray_c14_ ok

**C15** - Status exit 2 `config_invalid` with an existing `configPath` yields the disconnected image and title `Disconnected` (TRAY-01, AC 15)
Proof: run rust | tray_c15_ ok

**C16** - Status exit 0 `connected` with allowlist `[instagram.com, facebook.com, threads.net]` yields the connected image and rows `Connected`, separator, `Through home`, the 3 domains in that order; an allowlist of 12 shows the first 10 then `2 more in Settings` (TRAY-01, AC 16)
Proof: run rust | tray_c16_ ok

**C17** - `connecting`, `reconnecting`, and `disconnected`/`connection_lost` at 59 s of downtime each yield `Reconnecting…`; retryAt now+7.2 s gives `Next try in 8 s.`, retryAt null and retryAt in the past give `Trying now.` (TRAY-01, AC 17)
Proof: run rust | tray_c17_ ok

**C18** - The same three inputs at 60 s of downtime yield the disconnected image and `Disconnected`; a `connected` poll in between restarts the count (TRAY-01, AC 18)
Proof: run rust | tray_c18_ ok

**C19** - `disconnected`/`auth_failed` at 0 s of downtime yields `Disconnected` (TRAY-01, AC 19)
Proof: run rust | tray_c19_ ok

**C20** - `stopped` yields `Disconnected`, and `Reconnecting…` at 4.9 s after a spawn, `Disconnected` at 5 s (TRAY-01, AC 20)
Proof: run rust | tray_c20_ ok

**C21** - `stopped`/`stale` adds the row `The tunnel stopped reporting.` (TRAY-01, AC 21)
Proof: run rust | tray_c21_ ok

**C22** - `stopped`/`config_changed` adds the row `The running tunnel uses an older config.` (TRAY-01, AC 22)
Proof: run rust | tray_c22_ ok

**C23** - Status exit 11 `blocked`/`port_blocked` with `remotePort` 8888 yields the blocked image and rows `Blocked at the server`, `Tunnel port: the server refused port 8888`, `Fix: free port 8888, allow it for the key`, then action `Copy Fix` (TRAY-01, AC 23)
Proof: run rust | tray_c23_ ok

**C24** - Status exit 13 yields the blocked image and rows `Server key changed`, `Server: host key does not match the saved one`, `Fix: do not connect until you know why`, then action `Review Server Key…`, also when the current doctor result exits 14 (precedence over AC 25) (TRAY-01, AC 24)
Proof: run rust | tray_c24_ ok

**C25** - Status `connected` (and status exit 10, and 11) with a current doctor result exiting 14 yields the blocked image and `Server allows too much` rows with `Copy Fix`; negatives: status exit 13 with it yields `Server key changed`, status exit 2 yields its config state, unreadable status yields `Can't read the tunnel status.`, the same doctor result after a status change or 10 minutes old yields `Connected`, and a later doctor exit 0 yields `Connected` (TRAY-01, AC 25)
Proof: run rust | tray_c25_ ok

**C26** - Across Run Check, the automatic doctor runs, `run_check` and Settings' `Check Again`, the fake runner records no argv containing `--domain` (TRAY-01, AC 26)
Proof: run rust | tray_c26_ ok

**C27** - Table-driven over the 7 pairs reachable under Disconnected (config/2, key/2, server_reachable/10, ssh_auth/10, forward/10, lockdown/10, egress/10): a Disconnected model with that current doctor result shows exactly that pair's two rows, each at most 60 characters with sample values; no current result and a current result with exit 0 (no failing hop) show no hop rows; a result older than the last status change shows none (TRAY-01, AC 27)
Proof: run rust | tray_c27_ ok

**C28** - Reconnecting, Disconnected and Blocked models with `domains` 5 contain `5 domains paused. Nothing goes direct.`; with 1, `1 domain paused. Nothing goes direct.`; an unreadable status after a readable one with 3 shows `3 domains paused. Nothing goes direct.`; an unreadable status with none ever readable has no `paused` row; Connected and Not set up models have no `paused` row (TRAY-01, AC 28)
Proof: run rust | tray_c28_ ok

**C29** - For each of the 12 non-idle layouts (titles `Connected`, `Reconnecting…`, `Disconnected`, `Blocked at the server`, `Server key changed`, `Server allows too much`, each with ownership owned-or-none and external) the trailing entries are, in order: action (when any), `Run Check`, `Reconnect` (in the 6 owned-or-none layouts, absent in the 6 external ones), `Settings…` with accelerator `CmdOrCtrl+,`, `Open at Login` checkable, separator, `Quit social-tunnel` with `CmdOrCtrl+Q` (TRAY-01, AC 29)
Proof: run rust | tray_c29_ ok

**C30** - A 61-character domain row becomes 59 characters plus `…`; a 60-character row is unchanged (TRAY-01, AC 30)
Proof: run rust | tray_c30_ ok

**C31** - `app/src-tauri/icons/tray/` holds 12 images (4 states + 8 reconnecting frames) at 18×18 and their @2x at 36×36, every pixel with RGB 0, and the tray code sets `icon_as_template(true)` for each (TRAY-01, AC 31)
Proof: run rust | tray_c31_ ok

**C32** - With Reduce Motion off, a Reconnecting model drives the frame scheduler through frames 0-7 at 150 ms each and back to 0 at 1200 ms (TRAY-01, AC 32)
Proof: run rust | tray_c32_ ok

**C33** - With Reduce Motion on, a Reconnecting model shows frame 0 and the scheduler holds zero timers (TRAY-01, AC 33)
Proof: run rust | tray_c33_ ok

**C34** - A Reconnecting -> Connected transition cancels the frame timer and sets the connected image once (TRAY-01, AC 34)
Proof: run rust | tray_c34_ ok

**C35** - Three identical polls cause one menu build and one `snapshot` event; a fourth poll with a changed `retryAt` causes a second (TRAY-01, AC 35)
Proof: run rust | tray_c35_ ok

**C86** - Root `bunfig.toml` sets `[test] root = "tests"`; with app test files present, root `bun test` prints no file path under `app/` (SIDE-01, AC 86)
Proof: `grep -qx 'root = "tests"' bunfig.toml && test -n "$(ls app/bun-tests/*.test.ts)" && ! env -u CLAUDECODE taskpolicy -b nice -n 10 bun test 2>&1 | grep -qE '^(\./)?app/'`

**C87** - A doctor result started before the latest change of status `state`, `reason` or exit, or 10 minutes old, is not current: the model shows no hop rows and no lock-down Blocked from it, while the snapshot still carries it as `latest` for Settings; one started after the change and 9 min 59 s old is current (TRAY-01, AC 87)
Proof: run rust | tray_c87_ ok

**C90** - Table-driven: the 5 valid rows of AC 90 are accepted; exit 0 with `reconnecting`, exit 10 with `connected`, unknown state `paused`, missing `server`, `pid` `"4242"`, `domains` `"5"`, `allowlist` not an array, exit 11 with `host_key_mismatch`, exit 2 with `error.code` `internal`, exit 2 without `configPath`, and exit 14 are each rejected as unreadable (TRAY-01, AC 90)
Proof: run rust | tray_c90_ ok

**C84** - The Settings window's navigation policy denies `https://example.com/` and `file:///etc/hosts`, allows the app's own origin, and its new-window handler denies every request (SAFE-01, AC 84)
Proof: run rust | tray_c84_ ok

### S2 - The app runs or watches the tunnel, and its actions work

**C36** - Status pid 4242 while the app has no child, with `state` `connected`, with `stopped`/`stale` and with `stopped`/`config_changed`, each yields zero spawns over 10 polls, no `Reconnect` entry and the row `Managed outside the app (pid 4242).` (SUP-01, AC 36)
Proof: run rust | tray_c36_ ok

**C37** - Status exit 10 `stopped` with pid null and no child or pending restart yields exactly one spawn of `run --json`, and no second spawn over the next 5 polls while the child lives (SUP-01, AC 37)
Proof: run rust | tray_c37_ ok

**C38** - A child that writes 1 MiB to stderr and then `{"ok":false,"command":"run","error":{"code":"already_running",...}}` on stdout and exits 2 is classified `already_running`; with polls then showing `stopped`/`config_changed` pid 4242 it is not respawned over 60 s of fake time (no spawn every 2 s); a later poll with pid null respawns only after the 1 s backoff (SUP-01, AC 38)
Proof: run rust | tray_c38_ ok

**C39** - A child that exits 13 is not respawned over 60 s of fake time (SUP-01, AC 39)
Proof: run rust | tray_c39_ ok

**C40** - A child that writes 1 MiB to stderr, then the `key_permissions` error JSON on stdout, and exits 2 is not respawned and exactly one `doctor --json` starts (SUP-01, AC 40)
Proof: run rust | tray_c40_ ok

**C41** - A child that exits 0 without an app-sent signal is not respawned over 60 s of fake time (SUP-01, AC 41)
Proof: run rust | tray_c41_ ok

**C42** - Successive child exits with 1, 3, 1, 1, 1, 1, 1 and one killed by SIGKILL from outside respawn after 1, 2, 4, 8, 16, 30, 30, 30 s; a child that lived 60 s then exits 1 respawns after 1 s (SUP-01, AC 42)
Proof: run rust | tray_c42_ ok

**C43** - At start, status exit 13 yields zero spawns (SUP-01, AC 43)
Proof: run rust | tray_c43_ ok

**C44** - Reconnect on an owned fake child that ignores SIGTERM records SIGTERM, then SIGKILL at 5 s, then one new spawn; one that exits on SIGTERM gets no SIGKILL; the next failure backs off 1 s (SUP-01, AC 44)
Proof: run rust | tray_c44_ ok

**C45** - Reconnect during a pending 16 s restart spawns at once and the pending restart never fires (SUP-01, AC 45)
Proof: run rust | tray_c45_ ok

**C46** - Quit with an owned child, a running status call and a running doctor call kills both calls, sends the child SIGTERM, sends SIGKILL only if it is alive at 5 s, and exits the app after the child is gone (SUP-01, AC 46)
Proof: run rust | tray_c46_ ok

**C47** - Across Quit, Reconnect and every exit path with an external live pid in status, the signal log holds only pids the runner spawned (SUP-01, AC 47)
Proof: run rust | tray_c47_ ok

**C48** - A fake sidecar that writes 1 MiB to stderr then sleeps is still running 2 s later; one that writes 200 KiB of stdout lines then a JSON line keeps exactly the last 64 KiB and its exit is classified from that JSON line (SUP-01, AC 48)
Proof: run rust | tray_c48_ ok

**C49** - Run Check starts one `doctor --json`, the menu shows `Checking…` disabled while it runs, and a second Run Check and a `run_check` IPC call during it start no second doctor and return the same result (SUP-01, AC 49)
Proof: run rust | tray_c49_ ok

**C50** - Entering Disconnected starts one doctor; entering Blocked 20 s later starts none; entering Disconnected again 31 s after the first starts one; at launch with status exit 10 `stopped` pid null the first poll spawns `run`, shows Reconnecting (AC 20) and starts no doctor (SUP-01, AC 50)
Proof: run rust | tray_c50_ ok

**C51** - A doctor call that hangs is killed at 120 s and the model keeps the previous doctor result (SUP-01, AC 51)
Proof: run rust | tray_c51_ ok

**C52** - Copy Fix with a doctor result whose first failing hop is `forward` writes that hop's `fix` to the fake clipboard byte for byte, including quotes and `=` (SUP-01, AC 52)
Proof: run rust | tray_c52_ ok

**C53** - With no doctor result, with all hops OK, and with a failing hop whose `fix` is empty, the `Copy Fix` entry is disabled (SUP-01, AC 53)
Proof: run rust | tray_c53_ ok

**C54** - `copy_fix("nope")`, `copy_fix("egress")` on a passed hop and `copy_fix` with no doctor result each return `no_fix` and make zero clipboard writes (SUP-01, AC 54)
Proof: run rust | tray_c54_ ok

**C83** - With a fake runner whose child has exited and been observed, Reconnect and Quit make zero signal calls; with a live child, the signal goes through its handle and the signal log names its pid (SUP-01, AC 83)
Proof: run rust | tray_c83_ ok

**C88** - With a current doctor result exiting 14 and status `connected`, fake time advanced 30 min starts doctor at 10, 20 and 30 min; once a doctor exits 0 no further run starts (SUP-01, AC 88)
Proof: run rust | tray_c88_ ok

**C85** - `copy_fix` on a failing hop whose `fix` holds `\n`, `\r`, `\x1b` or `\x7f` returns `no_fix` and makes zero clipboard writes; a fix with quotes and `=` still copies (SUP-01, AC 85)
Proof: run rust | tray_c85_ ok

### S3 - Settings shows the route, the server and the domains

**C55** - Under the mock runtime, choosing Settings… twice leaves exactly one window labelled `settings` of 640×520 on the Status tab, and the second choice focuses it (SET-01, AC 55)
Proof: run rust | tray_c55_ ok

**C56** - Under the mock runtime, closing the Settings window leaves the app running with its tray icon (exit prevented) (SET-01, AC 56)
Proof: run rust | tray_c56_ ok

**C57** - The Settings page renders stops `This Mac`, `Server`, `Tunnel port`, `Domains` before a tablist with tabs `Status`, `Server`, `Domains`, `General`, in that order (SET-01, AC 57)
Proof: run ui | ✓ [tray-app C57]

**C58** - With `Status` focused, ArrowRight selects and focuses `Server`, ArrowLeft from `Status` selects `General`, ArrowRight from `General` selects `Status` (SET-01, AC 58)
Proof: run ui | ✓ [tray-app C58]

**C59** - Table-driven over the 6 stop words: fixtures all-OK, ssh_auth exit 13, forward exit 11, domain exit 12, server_reachable exit 10, all-skipped after config failure, and no doctor result give the words of AC 59 per stop, Domains `OK`/`Skipped` by rule (SET-01, AC 59)
Proof: run ui | ✓ [tray-app C59]

**C60** - A doctor fixture with the `domain` hop lists 8 rows named in AC 60 order; a failed `forward` row shows its detail, the full fix and a `Copy Fix` button that calls `copy_fix("forward")` (SET-01, AC 60)
Proof: run ui | ✓ [tray-app C60]

**C61** - `Check Again` calls `run_check` once, the stops read `Checking…` until it resolves, and a second press while pending makes no second call (SET-01, AC 61)
Proof: run ui | ✓ [tray-app C61]

**C62** - Opening Settings with the last doctor start 31 s ago starts one doctor; at 29 s it starts none (SET-01, AC 62)
Proof: run rust | tray_c62_ ok

**C63** - Before the first snapshot the page shows the 4 stop names, the 4 tab labels and `Checking…` (SET-01, AC 63)
Proof: run ui | ✓ [tray-app C63]

**C64** - A snapshot with `status_unreadable` shows `Can't read the tunnel status.` and all 4 stops `Not checked` (SET-01, AC 64)
Proof: run ui | ✓ [tray-app C64]

**C65** - The Server tab shows host, SSH port, tunnel user, `SHA256:` fingerprint, key path and tunnel port from the fixture, and the rendered text holds no `PRIVATE KEY` and no key-body fixture marker (SET-01, AC 65)
Proof: run ui | ✓ [tray-app C65]

**C66** - The Domains tab lists 5 fixture domains in order under `5 domains use home internet` (one domain: `1 domain uses home internet`) and holds no input, no button and no `Remove` text (SET-01, AC 66)
Proof: run ui | ✓ [tray-app C66]

**C67** - The General tab's `Open at login` checkbox is checked for `openAtLogin: true`, and clicking it calls `set_open_at_login` with `false` once (SET-01, AC 67)
Proof: run ui | ✓ [tray-app C67]

**C68** - The Set Up view shows the 4 step titles of AC 68 in order, step 3 contains the fixture `configPath`, and a `Check Again` button is present (SET-01, AC 68)
Proof: run ui | ✓ [tray-app C68]

**C69** - A `snapshot` event with a successful status while Set Up is shown switches the selected tab to `Status` (SET-01, AC 69)
Proof: run ui | ✓ [tray-app C69]

**C70** - Opening on the Server tab with a doctor fixture whose `ssh_auth` failed with exit 13 shows the pinned fingerprint and that hop's full fix (SET-01, AC 70)
Proof: run ui | ✓ [tray-app C70]

**C71** - The page root has a transparent background with `reduceTransparency: false` and background `#f2f2f4` (light) / `#2a2a2e` (dark) with `true`; `tauri.conf.json` gives the settings window `transparent: true` and OS window effects (SET-01, AC 71)
Proof: run ui | ✓ [tray-app C71]
Proof: run rust | tray_c71_ ok

**C72** - `app/src/styles.css` defines each design README token role with its light value and, under `prefers-color-scheme: dark`, its dark value (13 roles × 2) (SET-01, AC 72)
Proof: run ui | ✓ [tray-app C72]

**C73** - A domain `<img src=x onerror=alert(1)>`, a host with `<b>`, and a fix with `<script>` render as literal text, and the container holds zero `img`, `b` and `script` elements (SET-01, AC 73)
Proof: run ui | ✓ [tray-app C73]

**C74** - After `vite build`, no `src`, `href` or CSS `url()` in `app/dist` starts with `http://` or `https://` (SET-01, AC 74)
Proof: run dist | ✓ [tray-app C74]

**C89** - The built page in Playwright WebKit, served with the exact CSP of `tauri.conf.json` as a response header and IPC stubbed with fixture snapshots, records zero `securitypolicyviolation` events on each of Status, Server, Domains, General and the Set Up view; and across every Vitest fixture state no rendered element has a `style` attribute (SET-01, AC 89)
Proof: run dist | ✓ [tray-app C89]
Proof: run ui | ✓ [tray-app C89]

### S4 - A bundled app that opens at login

**C75** - `tauri build --bundles app` exits 0 and the bundle holds executable `Contents/MacOS/social-tunnel-app` and `Contents/MacOS/social-tunnel` (PKG-01, AC 75)
Proof: run bundle | (pass) [tray-app C75]

**C76** - The bundle Info.plist has `CFBundleIdentifier` `tech.antoniofulg.social-tunnel.tray` and `LSUIElement` true (PKG-01, AC 76)
Proof: run bundle | (pass) [tray-app C76]

**C77** - The bundle has a non-empty `Contents/Resources/icon.icns` named by `CFBundleIconFile` (PKG-01, AC 77)
Proof: run bundle | (pass) [tray-app C77]

**C78** - With a fake login-item backend, switching on calls enable once and the checkmark shows the read-back `true`; a failing enable leaves it unchecked and returns `autostart_failed`; switching off calls disable and shows `false`; the configured label is not `tech.antoniofulg.social-tunnel` (PKG-01, AC 78)
Proof: run rust | tray_c78_ ok
Proof: run smoke | PASS [tray-app C78]

**C79** - Toggling Open at Login on and off in the installed app leaves the SHA-256 of `~/Library/LaunchAgents/tech.antoniofulg.social-tunnel.plist` unchanged, and while on a new plist exists whose `Label` differs and whose program is inside `~/Applications/social-tunnel.app` (PKG-01, AC 79)
Proof: run smoke | PASS [tray-app C79]

**C80** - With a temp `HOME` holding an older `Applications/social-tunnel.app`, the script exits 0 and the copy matches the built bundle file for file (PKG-01, AC 80)
Proof: run cli | (pass) [tray-app C80]

**C81** - With a temp `HOME` and a process running from that copy's `Contents/MacOS/social-tunnel-app`, the script exits 1, prints `Quit social-tunnel first.`, and the copy is unchanged (PKG-01, AC 81)
Proof: run cli | (pass) [tray-app C81]

**C82** - With the LaunchAgent run live, the installed app's menu (read through System Events) holds `Connected` and `Managed outside the app (pid <LaunchAgent pid>).`, the app spawns no `run`, and after Quit `launchctl print gui/$UID/tech.antoniofulg.social-tunnel` shows the same pid (PKG-01, AC 82)
Proof: run smoke | PASS [tray-app C82] menu
Proof: run smoke | PASS [tray-app C82] quit

## Coverage

| Set (size) | Member -> proof | Unproven |
| --- | --- | --- |
| status input -> tray state (15) | not set up C14 · config invalid C15 · connected C16 · connecting C17 · reconnecting C17 · lost <60 s C17 · lost >=60 s C18 · auth_failed C19 · stopped C20 · stopped after spawn C20 · stale C21 · config_changed C22 · port_blocked C23 · host_key_mismatch C24 · unreadable C13 | - |
| unreadable status causes (5) | timeout C13 · not JSON C13 · two objects C13 · over 1 MiB C13 · rejected by the validity table C13, C90 | - |
| status validity table (16) | exit 0 ok C90 · exit 10 ok C90 · exit 11 ok C90 · exit 13 ok C90 · exit 2 ok C90 · 0+reconnecting C90 · 10+connected C90 · unknown state C90 · missing server C90 · pid string C90 · domains string C90 · allowlist not array C90 · 11+host_key_mismatch C90 · 2+internal C90 · 2 without configPath C90 · exit 14 C90 | - |
| doctor exit -> tray (3) | 14 raises Blocked C25 · 12 never produced in v0.2 C26 · other exits give rows only C27 | - |
| doctor result freshness (4) | current C87 · started before status change C87, C25, C27 · 10 minutes old C87, C25 · exit 0 no failing hop C27 | - |
| lock-down precedence (4) | status 13 wins C24, C25 · status 2 wins C25 · unreadable wins C25 · re-check every 10 min C88 | - |
| paused row (4) | plural C28 · singular C28 · last known count C28 · never readable C28 | - |
| domain rows cap (2) | up to 10 C16 · `<n> more in Settings` C16 | - |
| tray images (5) | not set up C14, C31 · connected C16, C31 · reconnecting C17, C31-C33 · disconnected C15, C31 · blocked C23, C31 | - |
| menu titles (7) | `Not set up` C14 · `Connected` C16 · `Reconnecting…` C17 · `Disconnected` C15 · `Blocked at the server` C23 · `Server key changed` C24 · `Server allows too much` C25 | - |
| short hop rows (11) | config/2 C27 · key/2 C27 · server_reachable/10 C27 · ssh_auth/10 C27 · forward/10 C27 · lockdown/10 C27 · egress/10 C27 · ssh_auth/13 as Blocked rows C24 · forward/11 as Blocked rows C23 · lockdown/14 as Blocked rows C25 · domain/12 unreachable in v0.2 C26 | - |
| menu layouts (13) | Not set up C14 · Connected owned C29 · Connected external C29 · Reconnecting owned C29 · Reconnecting external C29 · Disconnected owned C29 · Disconnected external C29 · Blocked port owned C29 · Blocked port external C29 · key changed owned C29 · key changed external C29 · lock-down owned C29 · lock-down external C29 | - |
| menu trailing rows (6) | action C29 · `Run Check` C29, C49 · `Reconnect` C29, C36 · `Settings…` C29 · `Open at Login` C29, C78 · `Quit social-tunnel` C29, C46 | - |
| motion (3) | loop C32 · Reduce Motion still C33 · stop on leave C34 | - |
| ownership (4) | owned C44 · external live C36, C47, C82 · external `stopped`/`stale` with pid C36 · external `stopped`/`config_changed` with pid C36, C38 | - |
| child stdout handling (3) | final JSON after 1 MiB stderr C38, C40 · 64 KiB tail kept C48 · stderr drained C48 | - |
| child exit outcomes (6) | `already_running` C38 · 13 C39 · 2 other C40 · 0 unsignalled C41 · 1 or other code C42 · outside signal C42 | - |
| backoff steps (7) | 1 s C42 · 2 s C42 · 4 s C42 · 8 s C42 · 16 s C42 · 30 s cap C42 · reset after 60 s C42, C44 | - |
| `sidecar argv` accepted shapes (8) | status C6 · doctor C6 · doctor --domain C6 · run C6 · status --config C6 · doctor --config C6 · doctor --domain --config C6 · run --config C6 | - |
| `sidecar argv` rejections (8) | empty host C7 · `-` host C7 · NUL host C7 · space host C7 · grammar C7 · relative path C7 · `-` path C7 · NUL path C7 | - |
| forbidden permission prefixes (9) | `shell:` C5 · `fs:` C5 · `http:` C5 · `opener:` C5 · `process:` C5 · `clipboard-manager:` C5 · `autostart:` C5 · `dialog:` C5 · `updater:` C5 | - |
| startup assembly: sidecar path and webview policy (2 places) | `tauri dev` (target/debug) C8 · bundle C8, C75, C82; CSP and capabilities live once in `tauri.conf.json` + `capabilities/` C5, C9 | - |
| route stop words (6) | `OK` C59 · `Key changed` C59 · `Refused` C59 · `Failed` C59 · `Skipped` C59 · `Not checked` C59, C64 | - |
| hop display names (8) | Config file C60 · Domain C60 · Tunnel key C60 · Server reachable C60 · SSH sign-in C60 · Tunnel port C60 · Lock-down C60 · Internet from this Mac C60 | - |
| tabs (4) | Status C57, C58 · Server C57, C65, C70 · Domains C57, C66 · General C57, C67 | - |
| Settings states (5) | loading C63 · unreadable C64 · checking C61 · not set up C68 · populated C59, C60 | - |
| Reduce Transparency (2) | off C71 · on C71 | - |
| CSP behaviour views (5) | Status C89 · Server C89 · Domains C89 · General C89 · Set Up C89 | - |
| root test discovery (2) | `app/bun-tests` excluded C86 · `app/src` Vitest files excluded C86 | - |
| `social-tunnel status --json` added fields (4) | `server.user` C1 · `server.hostKey` C1 · `keyPath` C1 · `allowlist` C1 | - |
| config-failure `configPath` (2 verbs) | status C2 · run C2 | - |
| `get_snapshot` outcomes (2) | ok C55, C57 · `status_unreadable` C13, C64 | - |
| `run_check` outcomes (3) | ok C49, C61 · `busy` C49 · `timeout` C51 | - |
| `copy_fix` outcomes (2) | ok C52, C60 · `no_fix` C54, C85 | - |
| `set_open_at_login` outcomes (2) | ok C67, C78 · `autostart_failed` C78 | - |
| `snapshot` event (1) | emitted on change C35, C69 | - |
| `build:sidecar` outcomes (1) | built C3, C4 | - |
| `tauri build` outputs (3) | app binary C75 · sidecar C75 · Info.plist C76, C77 | - |
| `app/scripts/install-local.sh` outcomes (2) | exit 0 C80 · exit 1 C81 | - |
| login item (3) | on C78, C79 · off C78, C79 · user plist untouched C79 | - |

- Claims naming an outcome, interface or response shape: C1-C4, C6, C7, C13, C14, C23-C25, C49, C52, C54, C61, C67, C75-C77, C80-C82 - each has a proof that crosses the boundary it names (CLI process, compiled binary, IPC call from the component, bundle, script, installed app)
- No other check claims more than the cases its proof enumerates

## Security cases

| ID | Abuse case | Expected | Checks |
| --- | --- | --- | --- |
| SEC-001 | Script running in the webview starts a process, passes its own arguments, or reads a file | No plugin permission to do so; only four typed commands; argv only from the allowlist | C5, C6, C7, C10 |
| SEC-002 | Remote content loads into the webview (script, style, font, frame) or the window navigates away | CSP blocks it and the page runs under it with zero violations; the built page references no remote URL; navigation outside the app and new windows refused | C9, C74, C84, C89 |
| SEC-003 | A `social-tunnel` earlier on `PATH` replaces the bundled sidecar | The app runs only the binary next to its own executable | C8, C75 |
| SEC-004 | The SSH private key is read by the app or shown in Settings | The app's Rust source has no file read; Settings shows path and fingerprint only | C10, C65 |
| SEC-005 | The app stops, signals or duplicates a run it did not start (the user's LaunchAgent) | External run (any status with a pid not the app's) watched only; signals only to own live children, never to a reaped pid; `already_running` stops the app's attempt without a respawn loop | C36, C38, C47, C82, C83 |
| SEC-006 | Config- or server-supplied text injects markup into Settings or forges menu rows | Text rendered as text; rows cut at 60 characters | C30, C73 |
| SEC-007 | The webview places arbitrary text on the clipboard for the user to paste into a terminal | `copy_fix` takes a hop name and copies only doctor's own `fix`, never one holding a control character | C52, C54, C85 |
| SEC-008 | The login item overwrites or edits the user's LaunchAgent plist | Different label; plist hash unchanged | C78, C79 |
| SEC-009 | A child that floods its pipes stalls and the tunnel stops relaying | Pipes read continuously | C48 |

## Test policy

The repo answers neither question for the app's layers (cli-core's rows cover `src/` only), so this
feature builds under these rows; they are not written into the repo's guidelines.

| Code | Required proofs | Coverage expectation |
| --- | --- | --- |
| Decides, reached across a boundary (status-to-tray mapping, supervisor exit handling, argv builder) | one at its own layer **and** one at the boundary | own layer: one asserted case per table row (Rust); boundary: the installed app with the live LaunchAgent run (C82) and the compiled sidecar (C4) |
| Decides, not reached across a boundary (frame scheduler, backoff, row cutting, route-stop wording) | one at its own layer | one asserted case per row (Rust, Vitest) |
| Settings components | one at the component layer | each state of uiux.md, keyboard and text-only rendering (Vitest + Testing Library) |
| Static policy (capabilities, CSP, file access, bundle plist) | one assertion over the shipped file | every forbidden member named (C5, C9, C10, C76) |
| Instrumentation (Tauri wiring that forwards to `model`/`supervisor`, IPC glue) | none of its own | covered by C55, C56 and the smoke checks |

Evidence:

- app `model`: 15 status inputs, 16-row validity table, doctor freshness and precedence, 11 hop rows, 13 menu layouts -> decides
- app `supervisor`: 6 exit outcomes, 7 backoff steps, 2 ownership cases, 3 signal paths -> decides
- app `sidecar` argv: 4 shapes, 8 rejections -> decides
- closest analogue in the repo: `src/status.ts` `evaluateStatus`, a state-to-output decision table proven row by row at its own layer (cli-core C30-C34, C121) and at the CLI boundary

Cost: about 60 Rust tests and 17 Vitest tests in `app/`, 6 Bun tests in `tests/`, 3 bundle commands
and 3 smoke-script runs on the installed app.

## Swept

- validation: C7, C13, C30, C54, C90
- failure modes: C13, C38, C39, C40, C41, C42, C51, C81
- idempotency: C35, C37, C49, C55 - a repeated poll, spawn decision, check or Settings open does nothing twice
- authorization: C5, C6, C8, C9, C47, C54, C83, C84, C85 - the webview reaches four commands only; the app signals only its own children
- concurrency: C12, C38, C49, C61 - one status and one doctor in flight; `run.lock` settles a start race with the LaunchAgent (C38); a second app instance only watches the first one's child (C36)
- data lifecycle: C10, C78 - the app stores nothing; the login item is removed when switched off
- dependency failure: C13, C18, C42, C51 - sidecar unreadable or hung, tunnel down, child crashing
- state transitions: C17, C18, C19, C20, C25, C34, C42, C44, C45, C50, C69, C87, C88
- observability: C13, C27, C60 - the menu and Settings are the observable surface; the app writes no log in v0.2 (C10)
- deploy compatibility: C1, C2 - JSON additions are additive and cli-core proofs stay green; rollback is deleting the `.app`, the CLI fields stay harmless
- performance budget: C12, C35, C48 - one status process at a time every 2 s and a menu rebuilt only on change; CPU use is a service target, not a criterion, in v0.2

## Amendments

Append-only notes on approved rows; the rows above stay as approved.

- C55, C56 (S2/S3 build): the words "Under the mock runtime" no longer describe the proof. Tauri's
  mock runtime crashes (SIGSEGV) on macOS when a test thread drives it off the main thread, so
  `tray_c55_*` and `tray_c56_*` run `settings::open` against a fake window object and check the
  exit-request rule `settings::exit_allowed` plus its wiring in `lib.rs`. The claims and proof lines
  are unchanged. The real window close of C56 is confirmed on screen in the S4 smoke on this Mac
  (captures `s4-settings-*.png`, `s4-after-close-*.png`).
- C78 (smoke), C79 (S4 build): Open at Login is not switched on for this Mac's user (coordinator
  brief, 2026-11-22: "the toggle exists, the user decides"). The smoke `login` step therefore runs
  `tray_c79_*`: the real `auto_launch` LaunchAgent backend the autostart plugin uses, labelled
  `login::LABEL`, with the installed app's executable as its program, under a temporary `HOME`, on
  then off, hashing the user's `~/Library/LaunchAgents/tech.antoniofulg.social-tunnel.plist`
  before, while on and after. The app's own menu toggle is proven by `tray_c78_*` with a fake
  backend; the toggle is not clicked in the installed app.
- C75–C77 (S4 recovery): preserve the compiler's executable metadata/signature without invoking
  bundle signing; `beforeBuildCommand` rebuilds the compiled CLI so the bundle cannot pick up a
  stale sidecar. The generated Portal and Beacon assets are tracked, including on machines whose
  global macOS `Icon?` rule otherwise hides `icons/`.
- C56, C82 (S4 recovery): never click Settings on the live tunnel under the no-live-doctor
  guardrail. On first open C62 calls `doctor` even when connected. A native C56 walk needs a
  separately authorized isolated fixture or a revised live-doctor guardrail; do not treat the
  fake-window proof as the on-screen close.
- C78/C79 (Landing 15, user-approved): macOS uses the same pinned `auto-launch` LaunchAgent
  backend directly. The isolated proof calls the production `MacLogin` adapter and inspects
  `ProgramArguments.0` in the resulting plist, including after a launcher alias is retargeted.
  Other desktop targets retain the Tauri wrapper. No new webview permission.
- C11/C56/C82 (user-approved): a disposable bundle copy with a no-network sidecar may provide
  native tray and Settings evidence. It cannot prove the original installed/live-tunnel C82.
- C55 (Landing 16, user-approved): the fixed native size is now 640×560 pt. Verify the healthy
  Status route, seven check rows, and `Check Again` fit without scrolling. Keep scroll for
  diagnostic content that exceeds the panel; no change to single-window and focus behavior.

## Handoff

- OMP accepted coordination. Checkout `main` at `37ca08d`; S2 `8237ff0`, S3 Rust `0805120`, and S3 component/WebKit commits are on this branch. Claude's pane stays open with automatic continue cancelled.
- Claude S4 builder `a8469fbd47e8f0421` is finished (native owner metadata and quota stop). Its S4 edits are uncommitted. No bundle, installed app, or native S4 captures were found. Prior C78 fake and C79 temporary-HOME results passed; the last filtered Clippy result is not a reliable proof.
- S4 recovery, Run `run_61744c2ca329`, starting revision `37ca08d`: OMP `implementer-risk`, `openai-codex/gpt-6.2-sol` / `xhigh`, pending dispatch in this checkout. Scope: finish C75–C82 and installed C11/C56, adopt the known Claude edits, retain local proof. Local install and capture are approved; no push, production/VPS changes, second tunnel, tunnel signals/restarts, or enabling Open at Login.
- Orca accepted the S4 assignment: Task `task_ce994d158297`, Dispatch `ctx_c47cad1e791d`, worker `term_bc57f8d3-0868-4ade-aed2-4967d1c3e863`, state `ready`. The worker owns S4 in this checkout; wait for its evidence before final verification.
- S4 returned blocked at `1811eeb81e`: C75–C81 passed and the app is installed, not launched. Orca reported `screen_locked`. Opening live Settings would run `doctor` against the VPS; keep it out of live native proof. The existing tunnel stayed at the same PID and start time, with one matching process and an unchanged plist. Open at Login stayed off.
- Independent S4 risk review is pending at `37ca08d..1811eeb81e` in Run `run_61744c2ca329`; it does not replace the full `ui` verifier or missing native evidence.
- Orca accepted the independent, read-only S4 risk review: Task `task_cf13b1c25277`, Dispatch `ctx_c1a7e6add984`, state `ready`.
- S4 risk review returned with a **FAIL** verdict at `1811eeb81e`: C75–C77, C79, and serial C80 hold. C81 relied on textual argv and concurrent replacement could nest a bundle. C78 used the current executable without ensuring it was the installed app. Native launch is unsafe under the current guardrails: C37/C50/C62 can act after the read-only preflight, so no launch or live Settings click is authorized as verification.
- S4 remediation pending dispatch to the settled OMP builder: fix the C80/C81 installer races and C78 installed-target guard; verify with isolated fixtures. Preserve S2/S3 behavior and leave the installed app closed, tunnel untouched, and Open at Login off.
- Orca reopened the settled S4 builder for remediation: Task `task_12e55ddc82a5`, Dispatch `ctx_f8343c707f01`, state `ready`. Native proof and aggregate verification remain blocked.
- Remediation returned successfully at `778bd9fa9a`; the rebuilt unsigned app replaced the previous local copy and was not launched. Focused installer, login, permission and bundle proofs passed. The existing external PID and start time, process count, and plist hash again matched before and after; Open at Login stayed off. Follow-up risk verification of the fixes is pending; the native and aggregate gates remain open.
- Orca accepted the follow-up risk verification: Task `task_21f30a79e6bb`, Dispatch `ctx_5ef6d1848eac`, state `ready`, scope `1811eeb81e..778bd9fa9a`.
- Recheck `ctx_5ef6d1848eac` at `778bd9fa9a`: C80/C81 passed within the documented launch race. C78 failed: the guard resolves the executable at toggle time, while `tauri-plugin-autostart` 2.7.0 stores its canonical path at setup. A launcher alias retargeted between those calls can satisfy the guard while the backend still points to the build. The pinned wrapper offers no target getter or setter. Next decision: approve using the same `auto-launch` LaunchAgent backend directly on macOS with an explicit target, or retain the plugin requirement and leave C78 open. The tray stays closed and Open at Login off.
- User approved both proposed changes in the OMP chat: explicit macOS LaunchAgent program via `auto-launch`, and fixture-only native tray/Settings proof (not a live C82 pass). See plan Approval and Landing 15. Orca can reach the display again. OMP S4 follow-up at `157e1a185b` is pending dispatch; preserve the original live-system restrictions.
- Orca accepted the approved C78 fix and isolated native proof: Task `task_521eedfa125c`, Dispatch `ctx_ddcb01816822`, state `ready`.
- Approved follow-up returned at `b798ba4f98`: exact login program passed under temporary HOME; fixed app rebuilt and installed but not launched. Fixture Beacon and Connected/external menu observed with zero `run` requests. Settings opened once but vanished before the route, Server or close/reopen walk. Live C82 not run. Independent login risk review and non-author native Settings retest are pending dispatch at this revision.
- Orca accepted two independent follow-ups: C78/C79 risk recheck `ctx_ca4248a66f9a` (`task_6cca6a1aafde`) and fixture-only native Settings retest `ctx_e3fd5d549c56` (`task_1c606fb6315b`), both `ready` at `b798ba4f98`. The fixture observations are behavioral, not a claim of Concept A visual parity.
- Independent risk verdict `ctx_ca4248a66f9a` at `b798ba4f98`: scoped C78/C79 **PASS**. The same validated startup path is persisted; the isolated real-backend test covers both alias retarget directions, exact plist program, disable/read-back, and unchanged external plist. No additional IPC grants, live toggles, or runtime actions. Native Settings retest remains in progress.
- Native Settings retest `ctx_e3fd5d549c56` at `b798ba4f98`: **not observed**. Both PID-scoped menu paths returned AX `-1719`; the PID-scoped shortcut produced no window. The fixture stayed alive (169 `status`, zero `doctor`, zero `run`) and was cleaned. Evidence: [retest report](captures/s4-fixture-retest-report.md). This attempt did not confirm delivery of the Settings action or an app defect. Next: an attended click through the same isolated fixture, not the installed live-config tray. External PID/start/count/plist matched before and after; real tray closed, Open at Login off. Live C82 and full `ui` remain unverified.
- Attended fixture retest at `b798ba4f98`: Antonio saw the native `fixture.invalid` menu and confirmed clicking `Settings…` did not leave a visible window. System Events reported zero windows; fixture PID `85759` remained alive, stderr empty before cleanup. The isolated fixture logged 695 `status`, four synthetic `doctor`, and zero `run` events. The exact fixture PID/text mapping was verified before stopping it; the disposable directory was removed. Evidence: `captures/s4-attended-events.log` and the user-supplied native menu image. This is now a user-observed native visibility failure, not just failed automation. Scoped root-cause investigation and fix at `d815f111ef` pending dispatch; no tray redesign or live-config launch.
- Orca reopened the S4 implementer for the attended Settings failure: Task `task_3e29fea5d84b`, Dispatch `ctx_f6cf817c74f1`, state `ready`, at `d815f111ef`.
- Diagnostic `ctx_f6cf817c74f1` reported at `345a7ba0c8`: instrumented native Settings showed Status and the synthetic Server fingerprint, closed without quitting the tray, and reopened on the same fixture PID. Prior failure did not recur; no cause, product fix or installed-binary pass claimed. Instrumentation removed and the fixture cleaned; existing tunnel and Open at Login unchanged. A matching attended walk on the exact installed binary in a disposable fixture is the remaining safe proof.
- Attended exact-binary retest **passed** in isolation after the diagnostic. Antonio confirmed Status, Server SHA-256, close with the Beacon remaining, and reopen. On the same fixture PID `25348`, System Events independently confirmed one reopened Settings window and one menu extra; Orca AX read the four-stop route, `All checks OK.`, and the synthetic Server fingerprint/path. Captures: [reopened Status](captures/s4-exact-binary-reopen.png) and [Server](captures/s4-exact-binary-server.png). The tray binary matched the installed `b798ba4f98` executable SHA-256 `d626ed341421288ceb16ddc63889ffaae3d7c84e2962f0fa739940989d091fa7`, with only the sidecar replaced. Final event log: 77 `status`, two synthetic `doctor`, zero `run` or unknown. Exact PID/start/text mapping verified before fixture termination; its temp directory was removed. External PID `19886`, start time and plist hash matched preflight; real tray login plist/job absent. This closes the authorized isolated behavior walk, not original live C82, full visual parity, or the prior intermittent cause.
- Antonio reported native Settings scrolling/rendering feels like about 10 fps and asked whether the work was complete. The earlier check proved functionality, not frame pacing. At intake, the laptop's 1-minute load was `32.97` (limit `14`) and WindowServer was sampled at `59.4%`; neither proves causation. Investigation pending dispatch at `f286f7f7a9`. Keep the approved material (C71), IPC and live-system guardrails unless evidence and user approval justify a change.
- Orca accepted native Settings pacing diagnosis in dispatch `ctx_ef64db75d3b4` (`task_f18321884800`), state `ready`. Use the no-network fixture only; prove causality before editing, and run heavy commands only after the load gate clears.
- Pacing dispatch `ctx_ef64db75d3b4` returned: Antonio reported slow scroll and tab changes on both displays in the exact-binary fixture; dragging was not selected in this retest. The load gate stayed above `14` during interaction (`31.40`, `18.88`), so frame/stack attribution was not collected. No product edit. Fixture isolated and removed (98 `status`, one synthetic `doctor`, zero `run`); external PID/start/count/plist unchanged, app closed, login off. [Measurement notes](captures/s4-settings-pacing-report.md).
- Next: prepare a gated, disposable native A/B with target-scoped frame timing and one compositor factor, plus a scripted comparison if possible. No new attended test before instrumentation is ready; no product or approved-material change based on the missed sample. Pending dispatch at `f286f7f7a9`.
- Orca accepted the controlled pacing comparison follow-up at `f286f7f7a9`: Dispatch `ctx_8f0b7b00e51b`, Task `task_a35dddebd72c`, state `ready`. Both arms must be isolated from the real tunnel.
- Temporary local machine hold relayed by Orca for PR #992: no new browser tests, heavy local gates, CI-triggering pushes, merges or release actions until Antonio lifts it. Pause notice sent to `ctx_8f0b7b00e51b` (`msg_912a4967e4d2`). The S4 scratch Cargo process was gone before a guarded interruption could act; no signal was sent. Preserve diagnostic artifacts and resume only after the hold is lifted.
- A/B dispatch `ctx_8f0b7b00e51b` settled without measurements. The worker preserved an isolated harness for alternating material-on/off trials, stopped its own scratch build under the hold, and removed the runtime copy (nine `status`, one synthetic `doctor`, zero `run`). No arm reached Settings readiness. External PID/start/count/plist matched; installed app closed and login off. [A/B notes](captures/s4-settings-material-ab-report.md). After Antonio lifts the hold, rebuild the scratch variant under the load gate, verify the readiness marker, and run the prepared comparison.
- The PR #992 hold was lifted via Orca `msg_78d81efc40aa`. The previous A/B worker has exited and the private scratch source is still present. Pacing comparison resume pending dispatch; same no-network, no live-config launch and load-gate constraints.
- Orca resumed the existing experiment in dispatch `ctx_e10f734b2fa2` (`task_543457116e52`), state `ready`; source anchor `f286f7f7a9`, docs checkpoint `5043dbc0e8`.
- Resumed A/B `ctx_e10f734b2fa2` returned three valid but unfocused synthetic rounds: rAF median `384 ms` with native material on, `395/407 ms` off, load `7.62–8.53`. Neither actual displayed FPS nor the foreground cause is measured. A second on-arm timed out and retry did not reach Settings. Scratch/fixtures cleaned and live invariants held; no product change. [Raw timing and limitations](captures/s4-settings-material-ab-report.md#resumed-comparison--dispatch-ctx_e10f734b2fa2).
- Next discriminating step, pending dispatch: establish foreground timing on the same display and diagnose whether the background-priority launch path used by the test itself explains slow callbacks. Do not repeat an unfocused A/B or change C71.
- Orca accepted the scoped foreground pacing follow-up `ctx_54ad6c1a672d` (`task_c7a1dd4c128d`), state `ready`. Do not repeat an inactive A/B or make a shipping change without foreground evidence.
- Antonio clarified the ordinary-priority script did open Settings and felt much more fluid. The foreground log confirms the exact-binary disposable copy launched with normal priority, used local fixture output (33 `status`, one synthetic `doctor`, zero runs), then exited without timing results; original external state matched. No measured speedup or causal attribution. Antonio asked for the final visual adjustment only: make Settings slightly taller so healthy Status does not scroll. Height implementation proceeds at the coordinator; performance dispatch must only settle the observed evidence.
- Height follow-up at `f286f7f7a9` code base: `cargo test --locked -j 2 --test settings tray_c55_ -- --test-threads=1` (3 passed); WebKit `e2e/csp.spec.ts --project=webkit --workers=1 -g '\[tray-app C55\]'` (1 passed; tab panel overflow 0 and `Check Again` fully in view). The unsigned bundle built with `tauri build --bundles app --no-sign --no-binary-patching -- --locked`. Native isolated PID `10296` reported a visible 640×560 pt Settings window; all seven rows and the full button fit in the [native capture](captures/s4-status-560.png). Fixture cleanup: 200 `status`, one synthetic `doctor`, zero `run`. Replaced the closed local install with the tested bundle (`diff -qr` clean) without opening it; packaged read-only preflight found one external run at PID `19886`, same start/plist hash, and no tray login job/plist. No visual-material or scheduling change. Live C82 and aggregate WTK not run.

### S4 recovery proof

Tested on `main`, base `37ca08d`, with the S4 source and generated assets in the commit that adds
this record. This slice does not redo S1–S3 or replace their captures.

| Check | Result | Command and evidence |
| --- | --- | --- |
| C75–C77 | Pass | From `app/`: `taskpolicy -b nice -n 10 bun run icons`; gated `CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 bunx tauri build --bundles app --no-sign --no-binary-patching -- --locked`; `env -u CLAUDECODE taskpolicy -b nice -n 10 bun test ./bun-tests/bundle.test.ts` (3 pass, 0 fail). The bundle is arm64, holds both executables, declares the tray ID and `LSUIElement`, and carries the generated Portal arch ICNS byte for byte. |
| C78 (fake) | Pass | From `app/src-tauri/`: gated `CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 cargo test --locked -j 2 --test login -- --test-threads=1` (4 pass, 0 fail). The backend read-back drives the menu checkmark, including after a failed enable. |
| C78 (backend), C79 | Pass | `app/scripts/smoke-installed.sh login` (exit 0, `tray_c79_… ok` and both PASS lines). The pinned `auto-launch` 0.6.0 LaunchAgent branch only creates, checks or removes a file beneath `dirs::home_dir()`; `dirs-sys` uses nonempty `HOME`. No registration, launching or signaling occurs in that branch. The test subprocess used its own temporary HOME and the exact installed executable, checked the real plist hash before, during and after, removed its fixture, and left the real tray login plist and job absent. |
| C80, C81 | Pass | `env -u CLAUDECODE taskpolicy -b nice -n 10 bun test tests/install-local.test.ts` (2 pass, 0 fail). C81 starts a disposable executable at the target path and checks the exact refusal and unchanged tree. `HOME=<temporary home> app/scripts/install-local.sh` also replaced an older copy with the real build: `diff -qr` exited 0 and the old-only file disappeared. `app/scripts/install-local.sh` then installed only to `~/Applications/social-tunnel.app`; `diff -qr` against the build exited 0. |
| C11, C82 | Blocked | `app/scripts/smoke-installed.sh preflight` exited 0. The packaged sidecar's read-only status matched the live connected PID; `Supervisor::on_status` returns without spawning for a non-null PID and the connected startup poll has no alarm, child exit, or prior doctor to trigger another call. `orca computer permissions --json` exited 1 (`screen_locked`), so no tray launch, native Beacon/menu read, Quit or reopen. |
| C56 (native), Settings route/Server | Blocked | In addition to `screen_locked`, opening Settings on a fresh process triggers the live `doctor` through `settings::check_due(None, …)` (C62). The no-live-doctor guardrail forbids the click, even if the screen is unlocked. Do not count the fake-window proof as a native close. |
| Static and WTK | Scoped pass; aggregate not run | `validate_checks.py tray-app` exited 0 with the inherited `settings-view` and `Snapshot.checking` coverage warnings. The gated root `bun run typecheck`, app `bunx tsc --noEmit`, and Rust `cargo clippy --locked -j 2 --lib --test login --test login_agent -- -D warnings` all exited 0. Both shell scripts passed `/bin/sh -n`. `check_proofs.py` has no slice selector: it reruns the full root suite for C86 and requires native smoke while the GUI is unavailable. No aggregate green claim. |

Live before/after (read-only `launchctl print`, `ps` and SHA-256): PID `19886`, started
`Sun Nov 22 13:07:58 2026`, matching tunnel process count `1`, external plist SHA-256
`86a4a528b4f23c8c1845bd3f0ab4f9b05162ce32a40903ae0fed66a448d99b5e`. All matched after
install and isolated login. No tray process was running and Open at Login was off. No live doctor
or new `run` was started and no production state was changed.

Installed executable and sidecar SHA-256 respectively:
`52868b5f963738adb0264324d4e22446b19c5186045f1988bf32a2598b56a1e1` and
`d36fe1bcdce756464afde7b1d1483f8a322ffdde1a63e463940217269e93d753`. The linker signatures
verified; ordinary bundle-level `codesign --verify` reported no sealed resources with signing
skipped, while `--ignore-resources` exited 0. Native launch was not tested.

Native captures: none; no `.specs/features/tray-app/captures/s4-*.png` files were created.

### S4 remediation proof

Tested on `main` at base `1811eeb81e` plus the remediation committed with this record. Approved
check rows and both prior amendments remain unchanged.

| Check | Result | Command and evidence |
| --- | --- | --- |
| C80–C81 | Pass | Gated `env -u CI -u CLAUDECODE taskpolicy -b nice -n 10 bun test tests/install-local.test.ts`: 3 passed. A ready Mach-O fixture invoked by absolute path, relative path, hard link and symlink was refused with the exact diagnostic and unchanged bundle. A second installer could neither stage nor replace while another process held the destination directory lock; it replaced the bundle after release. `/bin/sh -n app/scripts/install-local.sh` passed. |
| C78, C5, C10 | Pass (scoped) | Gated `cargo test --locked -j 2 --test login -- --test-threads=1`: 5 passed. The production enable guard accepted the canonical installed target and an alias resolving to it; it rejected development, build, copied, missing, hard-link alias and redirected install paths without calling the backend. Disable and read-back still passed. Gated `cargo test --locked -j 2 --test policy tray_c5_ -- --test-threads=1`: 1 passed; no autostart permission. The C10 source policy passed; canonicalization resolves paths without reading config or key contents. C79 evidence above applies to the unchanged plugin backend and label. |
| Static | Pass (scoped) | Gated `bun run typecheck` and `cargo clippy --locked -j 2 --lib --test login -- -D warnings` exited 0. `validate_checks.py tray-app` and `check_commit.py --message 'fix(tray-app): guard install replacement and login paths'` exited 0. |
| C75–C77, C80 actual copy | Pass | Gated `CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 bunx tauri build --bundles app --no-sign --no-binary-patching -- --locked` from `app/`; `env -u CI -u CLAUDECODE taskpolicy -b nice -n 10 bun test ./bun-tests/bundle.test.ts`: 3 passed. `app/scripts/install-local.sh` replaced only the prior verified copy at `~/Applications/social-tunnel.app`, and `diff -qr` against the rebuilt bundle exited 0. |
| C11, C56 (native), C82 | Blocked as before | No desktop interaction or native launch was authorized. Opening Settings would trigger live `doctor` (C62); the preflight does not rule out a later status-driven action. No native captures, aggregate WTK gate, or full root suite. |

`/usr/sbin/lsof -a -d txt` matches the installed executable by device/inode before staging and
immediately before the swap. `/usr/bin/lockf` holds the physical Applications directory across
staging, publishing and rollback, with no lock path to remove. A competing installer fails without
copying. The OS launcher does not take this lock: a launch after the final probe can still race
the rename. If publication fails and the destination has appeared, rollback preserves the backup
instead of replacing the new destination.

`app/scripts/smoke-installed.sh preflight` (read-only) reported the installed sidecar connected.
Before and after replacement: external PID `19886`, start `Sun Nov 22 13:07:58 2026`, one matching
process, plist SHA-256 `86a4a528b4f23c8c1845bd3f0ab4f9b05162ce32a40903ae0fed66a448d99b5e`.
The tray executable was closed and the tray login plist and launchd job were absent both times.
Installed executable SHA-256: `db404940a0dc29d53277de25dfb75a22e4699aebe5161affef3b2b8cf3c2c6fc`;
sidecar: `d36fe1bcdce756464afde7b1d1483f8a322ffdde1a63e463940217269e93d753`.

### S4 explicit login program and native fixture proof

Implementation: `main` at `157e1a185b` plus the fix in the commit that adds this record.
The macOS adapter resolves the startup program once. It passes that canonical installed path
to `auto-launch` 0.6.0 and refuses enable if it is noncanonical, missing, or unsafe in that
backend's unescaped XML. Disable/read-back do not depend on the program path.

| Check | Result | Command and evidence |
| --- | --- | --- |
| C78/C79 | Pass, isolated | From `app/src-tauri/`: gated `CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 cargo test --locked -j 2 --test login --test login_agent -- --test-threads=1`: 4 fake tests and 1 real-backend test passed. Under temporary HOME, a launcher alias resolved to the build at setup and redirected to the install still refused; the inverse wrote the exact canonical installed executable to `ProgramArguments.0`. Direct dev/build/copied paths refused. Substituting a symlink at the installed path made enable fail while read-back stayed on, and disable through a rejected adapter removed only the tray plist. The external plist hash was unchanged before, during and after. Never toggled real Open at Login. |
| C5/C10, static | Pass, scoped | Gated `cargo test --locked -j 2 --test policy tray_c5_ -- --test-threads=1` (1 pass), C10 source policy, gated `cargo clippy --locked -j 2 --lib --test login --test login_agent -- -D warnings`, `validate_checks.py tray-app` and conventional commit validator passed. No new plugin grant. |
| C75–C77, local replacement | Pass | Gated `CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 bunx tauri build --bundles app --no-sign --no-binary-patching -- --locked` from `app/`; `env -u CI -u CLAUDECODE taskpolicy -b nice -n 10 bun test ./bun-tests/bundle.test.ts` (3 pass). Confirmed the prior app was closed, the packaged read-only status matched the external PID, and login was off before `app/scripts/install-local.sh`. `diff -qr` matched the approved installed path to the rebuilt bundle. |
| Native fixture: Beacon/menu | Observed | Direct background launch of PID `89844`; text vnode verified against the fixture binary with `lsof`, and `lsappinfo` reported `UIElement`. System Events found exactly one `AXMenuExtra`. A PID-directed input opened its native menu; AX read `Connected`, `Managed outside the app (pid 424242).`, and no `Reconnect`. The visible Beacon was cropped to its exact 36×24 px item on macOS 27.2.1: [`s4-fixture-beacon.png`](captures/s4-fixture-beacon.png). Menu rectangle was transient; no menu image retained. |
| Native fixture: Settings / C56 | Partial, not a pass | The Settings action produced one local fixture `doctor`, and Orca observed a `social-tunnel` window once. Waiting for `All checks OK.` then failed with `wait_timeout` / `window_not_found`; System Events subsequently reported zero windows and repeated background menu attempts returned `-1719` (`Invalid index`) or an empty menu rectangle. No stable route, Server fingerprint, explicit close/reopen, or native Quit was verified. AX and screenshot permissions were granted; no settings changes or requests for extra permission. The fixture alone was terminated by its verified PID and its temporary workspace removed. |
| Original live C82 / full WTK `ui` | Not run | No live launch, live doctor, real login toggle, root full suite, or aggregate proof. The fixture is not live-tunnel evidence. |

The fixture's app executable and Info.plist matched the rebuilt bundle byte for byte. Only the
copied sidecar was replaced; a clean per-process environment used temporary `HOME`, the synthetic
`SOCIAL_TUNNEL_CONFIG` and fixture root. The replacement only reads two local files and appends
verb events. Preflight compared both JSON outputs byte for byte and verified `run --json` exited
64 without output; malformed arguments were rejected. During the actual fixture run:
**137 status, 1 doctor, 0 run, 0 unknown**.

| Fixture evidence (ignored local artifacts) | SHA-256 |
| --- | --- |
| [No-network sidecar](captures/s4-fixture-sidecar.sh) | `0422e13778194f352b572e25696554feeb576e92dd5dc9f8b9ac95f9d9bb291c` |
| [Status input](captures/s4-fixture-status.json) | `57837c89bf245d06f79f80d11cc10d005975c2b22b4a625041015b7b19c62cce` |
| [Doctor input](captures/s4-fixture-doctor.json) | `06790271beb30f83f940a51960a68df63e96e594fd7813482aa60b002302cd53` |
| [Actual run events](captures/s4-fixture-events.log) | `2d7460bae13e78b4c5dbbd673e469baf6fbf78d38587421c1eb0338099006135` |
| [Beacon capture](captures/s4-fixture-beacon.png) | `bad92832d5c0377254e062d99ac84ef119788e190c45d538234830eaae247a6d` |

Before/after read-only external evidence: PID `19886`, start `Sun Nov 22 13:07:58 2026`,
one matching process, plist SHA-256
`86a4a528b4f23c8c1845bd3f0ab4f9b05162ce32a40903ae0fed66a448d99b5e`. No tunnel or VPS
interaction beyond local read-only status. Installed app and fixture were both closed after the
walk; the tray login plist and job were absent. Reinstalled app executable (also fixture app)
SHA-256 `d626ed341421288ceb16ddc63889ffaae3d7c84e2962f0fa739940989d091fa7`; installed
sidecar SHA-256 `d36fe1bcdce756464afde7b1d1483f8a322ffdde1a63e463940217269e93d753`.

### Attended Settings visibility investigation

**Result: native behavior observed in an instrumented fixture; prior failure not localized.**
No product fix, reinstall or launch of the installed app. `d815f111ef` source was built unsigned
with temporary logs around the existing Settings dispatch and Tauri window events. The logs
queried visibility, position, size, focus, and AppKit state without changing window policy or
actions. The diagnostic executable SHA-256 was
`3e949fc2ee41c85c150b0ac0bc8c18b520694c1336d65c6e7e79c348398ee718`, distinct from the installed
`b798ba4f98` executable (`d626ed341421288ceb16ddc63889ffaae3d7c84e2962f0fa739940989d091fa7`).

- **Dispatch and focus:** pinned Tauri 2.12.7 forwards the native menu action over its runtime
  event-loop proxy; the `settings` callback calls `settings::show`. In tao 0.37.3, `set_focus`
  checks that the AppKit window is already visible and not minimized, calls
  `makeKeyAndOrderFront`, and requests app activation. The close delegate emits `CloseRequested`
  and `Destroyed`; the existing exit hook prevents closing the last window from quitting the tray.
- **Attended result, fixture PID `4479`:** Antonio confirmed Settings opened and stayed visible.
  A canonical `lsof` text mapping verified the exact fixture PID. The first and second clicks both
  entered the real menu callback and returned `Ok(Created)` with one visible 640×520 window and
  accessory activation policy. The AppKit app was inactive immediately after showing the window;
  it then activated and the window became key. Later `Focused(false)` left the window visible.
- **Native walk:** captured the Status route with four stops and `All checks OK.`; used the
  Server tab and read back its synthetic SHA-256 fingerprint and path, not key material. Pressed
  the native close control. Orca did not provide a successful action receipt, but the tray trace
  independently reported `CloseRequested` then `Destroyed`. System Events returned zero windows
  and one menu extra while the same verified PID remained alive. Antonio then reopened Settings;
  the same PID created the Status window again and the route was read back.
- **Unresolved:** the earlier attended failure remains a valid observation. The first diagnostic
  PID (`91293`) expired without a confirmed Settings click or window trace. The successful
  diagnostic PID had logging and an attended click confirmed before its deadline, but those
  differences do not establish a cause or a fix. Missing dispatch, failed creation, lost
  activation, off-screen placement and dismissal were not observed in the successful trial;
  they cannot be distinguished for the original failure without a trace of that failure.
  The diagnostic edits were discarded; porting activation or placement changes would be
  speculative. This is not independent visual parity, installed-build Settings certification,
  or original live C82 evidence.

Proof command from `app/`: gated `CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 bunx tauri build
--bundles app --no-sign --no-binary-patching -- --locked`. A direct launch used the copied bundle
with only its sidecar replaced by the previously verified no-network fixture. Temporary HOME and
per-process environment were isolated. Before launch, the fixture outputs matched their known
hashes and bytes and `run --json` returned 64 without output. The attended walk called
96 `status`, two synthetic `doctor`, zero `run`, and zero unknown. No aggregate checks were run.

| Ignored local evidence | SHA-256 |
| --- | --- |
| [Status](captures/s4-settings-diagnostic-status.png) | `460e096ff2fa441c90956594d26dd720e6cbf9ec764fd9416e8ecfc7bee23de8` |
| [Server](captures/s4-settings-diagnostic-server.png) | `00c5da87cb584f0dd058fcacbf27d9021f597c8cf56dcc371be204f4f93fd6b2` |
| [Reopened Status](captures/s4-settings-diagnostic-reopen.png) | `399105320a323195dbac969a9316d055748d678e3f75e7c5ab182934867213fc` |
| [Native lifecycle trace](captures/s4-settings-diagnostic-app.stderr) | `022c21f0e7d3d9966b07c7894aa81a1f2b1c3b2b3622a15466175554f422a4ed` |
| [Fixture events](captures/s4-settings-diagnostic-events.log) | `a8e1ed22f94edde10d7c2fbacda858e6019d4f27490f3f9c08ca9de746358905` |

The supervisor terminated only the verified fixture it owned and removed the disposable bundle.
Before and after, read-only checks matched external PID `19886`, start `Sun Nov 22 13:07:58 2026`,
one matching process and plist SHA-256
`86a4a528b4f23c8c1845bd3f0ab4f9b05162ce32a40903ae0fed66a448d99b5e`. The installed app stayed
closed and the tray login plist and launchd job were absent.
