# Tray app checks

Profile: ui
Risk: C5, C6, C7, C8, C9, C10, C14, C23, C24, C36, C38, C39, C41, C44, C46, C47, C48, C54, C73, C79, C82, C83, C84, C85 - the webview boundary, the sidecar argv allowlist and path, file access, the states that must stop retrying, and every rule that keeps the app off the user's own LaunchAgent run; a weak test there ships a webview that starts processes, a key on screen, or a killed tunnel
Build: `taskpolicy -b nice -n 10 bun run typecheck && (test ! -d app || (cd app && taskpolicy -b nice -n 10 bunx tsc --noEmit && cd src-tauri && taskpolicy -b nice -n 10 cargo clippy -j 2 --all-targets -- -D warnings))`
Run cli: `env -u CLAUDECODE taskpolicy -b nice -n 10 bun test tests/app-contract.test.ts tests/install-local.test.ts`
Run sidecar: `taskpolicy -b nice -n 10 bun run build:sidecar && cd app && env -u CLAUDECODE taskpolicy -b nice -n 10 bun test ./bun-tests/sidecar-compiled.test.ts`
Run rust: `cd app/src-tauri && taskpolicy -b nice -n 10 cargo test -j 2 -- --test-threads=2`
Run ui: `cd app && taskpolicy -b nice -n 10 bunx vitest run src --reporter=verbose --maxWorkers=2`
Run dist: `cd app && taskpolicy -b nice -n 10 bunx vite build && taskpolicy -b nice -n 10 bunx vitest run tests/dist --reporter=verbose`
Run bundle: `cd app && CARGO_BUILD_JOBS=2 taskpolicy -b nice -n 10 bunx tauri build --bundles app && env -u CLAUDECODE taskpolicy -b nice -n 10 bun test ./bun-tests/bundle.test.ts`
Run smoke: `app/scripts/smoke-installed.sh`
Plan: `.specs/features/tray-app/plan.md`
UI contract: `.specs/features/tray-app/uiux.md`

85 checks in 4 slices (C<n> proves plan criterion n) · 9 one-way doors · 2 open, of which 0 block

Root `bun test` (cli-core's `Run unit`) must keep collecting only `tests/`: the Bun tests that need a
built sidecar or bundle live in `app/bun-tests/`, and app Vitest files live in `app/src` and
`app/tests`, so neither runs under cli-core's suite.

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

`smoke-installed.sh` runs against the copy in `~/Applications` after `install-local.sh`, in three
steps (menu, login, quit) and prints one `PASS [tray-app C<n>] <step>` or `FAIL ...` line per check.
It reads and clicks the menu through System Events, which needs Accessibility access for the
terminal. Without that access the degraded path is a computer-use walk of the same steps with
captures, recorded in `verification.md`; the affected checks stay unproven until then.

## Checks

### S1 - The tray shows the live tunnel state

**C1** - `status --json` on a valid config prints `server.user`, `server.hostKey`, absolute `keyPath` and `allowlist` equal to the normalized config domains in order, and every field of cli-core C7/C30 with an unchanged value and type, `domains` a number (SIDE-01, AC 1)
Proof: run cli | (pass) [tray-app C1]

**C2** - With a missing config and with a non-JSON config, `status --json` and `run --json` each exit 2 with `error.code` `config_invalid` and a top-level `configPath` equal to the absolute path they resolved (SIDE-01, AC 2)
Proof: run cli | (pass) [tray-app C2]

**C3** - `bun run build:sidecar` writes `app/src-tauri/binaries/social-tunnel-<rustc host triple>`, and that file run with `--version` prints `package.json`'s version and exits 0 (SIDE-01, AC 3)
Proof: run sidecar | (pass) [tray-app C3]

**C4** - The compiled sidecar's `run --json` against an in-process `ssh2` server with the pinned host key makes the same binary's `status --json` print `"state":"connected"` and exit 0 within 10 s (SIDE-01, AC 4)
Proof: run sidecar | (pass) [tray-app C4]

**C5** - Every capability file under `app/src-tauri/capabilities/` holds no permission starting with any of the 9 forbidden prefixes, and the union of permissions equals the expected set: core event listen/unlisten plus `get_snapshot`, `run_check`, `copy_fix`, `set_open_at_login` (SAFE-01, AC 5)
Proof: run rust | tray_c5_ ok

**C6** - The argv builder returns exactly `["status","--json"]`, `["doctor","--json"]`, `["doctor","--json","--domain","instagram.com"]`, `["run","--json"]`, and each with `"--config","/abs/config.json"` appended, for its 4 call kinds (SAFE-01, AC 6)
Proof: run rust | tray_c6_ ok

**C7** - The argv builder returns an error for hosts `""`, `-x.com`, `a\0b.com`, `a b.com`, `exa_mple.com` and config paths `config.json`, `-c`, `/a\0b`, and the supervisor's runner records zero spawns for each (SAFE-01, AC 7)
Proof: run rust | tray_c7_ ok

**C8** - The sidecar path resolver given executable `/X/social-tunnel.app/Contents/MacOS/social-tunnel-app` returns `/X/social-tunnel.app/Contents/MacOS/social-tunnel`, and with `PATH` holding a directory with another `social-tunnel` the resolved path is unchanged (SAFE-01, AC 8)
Proof: run rust | tray_c8_ ok

**C9** - `tauri.conf.json` has the exact CSP string of AC 9, `withGlobalTauri` false, `frontendDist` `../dist`, and no capability carries a `remote` key (SAFE-01, AC 9)
Proof: run rust | tray_c9_ ok

**C10** - `app/src-tauri/src` holds no `std::fs::`, `fs::read`, `fs::write`, `File::open`, `File::create`, `OpenOptions` or `tokio::fs`, and exactly one `try_exists` (SAFE-01, AC 10)
Proof: `! grep -rnE 'std::fs::|fs::read|fs::write|File::open|File::create|OpenOptions|tokio::fs' app/src-tauri/src && test "$(grep -rn 'try_exists' app/src-tauri/src | wc -l | tr -d ' ')" = 1`

**C11** - The installed app runs as a UI element (`lsappinfo` `ApplicationType` = `UIElement`) with exactly one menu bar extra (TRAY-01, AC 11)
Proof: run smoke | PASS [tray-app C11]

**C12** - With a fake runner whose status call takes 5 s and a fake clock advanced 10 s, the poller starts exactly 2 calls with never 2 in flight; with an instant runner it starts 5 calls in 10 s (TRAY-01, AC 12)
Proof: run rust | tray_c12_ ok

**C13** - A status call that hangs past 10 s (killed), exits 1, exits 14, prints `not json`, prints two objects, or prints 1 MiB + 1 byte each yields Disconnected with the row `Can't read the tunnel status.` (TRAY-01, AC 13)
Proof: run rust | tray_c13_ ok

**C14** - Status exit 2 `config_invalid` with a `configPath` that does not exist yields the not-set-up image and exactly the 6 menu entries of AC 14 (TRAY-01, AC 14)
Proof: run rust | tray_c14_ ok

**C15** - Status exit 2 `config_invalid` with an existing `configPath` yields the disconnected image and title `Disconnected` (TRAY-01, AC 15)
Proof: run rust | tray_c15_ ok

**C16** - Status exit 0 `connected` with allowlist `[instagram.com, facebook.com, threads.net]` yields the connected image and rows `Connected`, separator, `Through home`, the 3 domains in that order (TRAY-01, AC 16)
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

**C24** - Status exit 13 yields the blocked image and rows `Server key changed`, `Server: host key does not match the saved one`, `Fix: do not connect until you know why`, then action `Review Server Key…` (TRAY-01, AC 24)
Proof: run rust | tray_c24_ ok

**C25** - A doctor result with exit 14 and status `connected` yields the blocked image and `Server allows too much` rows with `Copy Fix`; a later doctor result with exit 0 returns to `Connected` (TRAY-01, AC 25)
Proof: run rust | tray_c25_ ok

**C26** - A doctor result with exit 12 leaves status `connected` as `Connected` and status `reconnecting` as `Reconnecting…` (TRAY-01, AC 26)
Proof: run rust | tray_c26_ ok

**C27** - Table-driven over the 11 hop-and-exit pairs of uiux.md: a Disconnected model with that doctor result shows exactly that pair's two rows, each at most 60 characters with sample values substituted (TRAY-01, AC 27)
Proof: run rust | tray_c27_ ok

**C28** - Reconnecting, Disconnected and Blocked models with status `domains` 5 contain `5 domains paused. Nothing goes direct.`; Connected and Not set up models contain no row with `paused` (TRAY-01, AC 28)
Proof: run rust | tray_c28_ ok

**C29** - For each of the 8 non-idle menu states the trailing entries are, in order: action (when any), `Run Check`, `Reconnect` (owned only), `Settings…` with accelerator `CmdOrCtrl+,`, `Open at Login` checkable, separator, `Quit social-tunnel` with `CmdOrCtrl+Q` (TRAY-01, AC 29)
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

**C84** - The Settings window's navigation policy denies `https://example.com/` and `file:///etc/hosts`, allows the app's own origin, and its new-window handler denies every request (SAFE-01, AC 84)
Proof: run rust | tray_c84_ ok

### S2 - The app runs or watches the tunnel, and its actions work

**C36** - Status with `state` `connected` and pid 4242 while the app has no child yields zero spawns, no `Reconnect` entry and the row `Managed outside the app (pid 4242).` (SUP-01, AC 36)
Proof: run rust | tray_c36_ ok

**C37** - Status `stopped` with an existing valid config and exit 10 yields exactly one spawn of `run --json`, and no second spawn over the next 5 polls while the child lives (SUP-01, AC 37)
Proof: run rust | tray_c37_ ok

**C38** - A child that exits 2 with `{"error":{"code":"already_running"}}` is not respawned over 60 s of fake time, and the next poll with a live external pid is watched (SUP-01, AC 38)
Proof: run rust | tray_c38_ ok

**C39** - A child that exits 13 is not respawned over 60 s of fake time (SUP-01, AC 39)
Proof: run rust | tray_c39_ ok

**C40** - A child that exits 2 with `key_permissions` is not respawned and exactly one `doctor --json` starts (SUP-01, AC 40)
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

**C48** - A fake sidecar that writes 1 MiB to stderr then sleeps is still running 2 s later, and its exit is observed when it ends (SUP-01, AC 48)
Proof: run rust | tray_c48_ ok

**C49** - Run Check starts one `doctor --json`, the menu shows `Checking…` disabled while it runs, and a second Run Check and a `run_check` IPC call during it start no second doctor and return the same result (SUP-01, AC 49)
Proof: run rust | tray_c49_ ok

**C50** - Entering Disconnected starts one doctor; entering Blocked 20 s later starts none; entering Disconnected again 31 s after the first starts one (SUP-01, AC 50)
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

**C66** - The Domains tab lists 5 fixture domains in order under `5 domains use home internet` and holds no input, no button and no `Remove` text (SET-01, AC 66)
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
| unreadable status causes (6) | timeout C13 · exit 1 C13 · exit 14 C13 · not JSON C13 · two objects C13 · over 1 MiB C13 | - |
| doctor exit -> tray (3) | 14 raises Blocked C25 · 12 leaves state C26 · other exits give rows only C27 | - |
| tray images (5) | not set up C14, C31 · connected C16, C31 · reconnecting C17, C31-C33 · disconnected C15, C31 · blocked C23, C31 | - |
| menu titles (7) | `Not set up` C14 · `Connected` C16 · `Reconnecting…` C17 · `Disconnected` C15 · `Blocked at the server` C23 · `Server key changed` C24 · `Server allows too much` C25 | - |
| short hop rows (11) | config/2 C27 · key/2 C27 · server_reachable/10 C27 · ssh_auth/10 C27 · ssh_auth/13 C27 · forward/11 C27 · forward/10 C27 · lockdown/14 C27 · lockdown/10 C27 · egress/10 C27 · domain/12 C27 | - |
| menu trailing rows (6) | action C29 · `Run Check` C29, C49 · `Reconnect` C29, C36 · `Settings…` C29 · `Open at Login` C29, C78 · `Quit social-tunnel` C29, C46 | - |
| motion (3) | loop C32 · Reduce Motion still C33 · stop on leave C34 | - |
| ownership (2) | owned C44 · external C36, C47, C82 | - |
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
| SEC-002 | Remote content loads into the webview (script, style, font, frame) or the window navigates away | CSP blocks it; the built page references no remote URL; navigation outside the app and new windows refused | C9, C74, C84 |
| SEC-003 | A `social-tunnel` earlier on `PATH` replaces the bundled sidecar | The app runs only the binary next to its own executable | C8, C75 |
| SEC-004 | The SSH private key is read by the app or shown in Settings | The app's Rust source has no file read; Settings shows path and fingerprint only | C10, C65 |
| SEC-005 | The app stops, signals or duplicates a run it did not start (the user's LaunchAgent) | External run watched only; signals only to own live children, never to a reaped pid; `already_running` stops the app's attempt | C36, C38, C47, C82, C83 |
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

- app `model`: 15 status inputs, 3 doctor overrides, 11 hop rows, 8 menu layouts -> decides
- app `supervisor`: 6 exit outcomes, 7 backoff steps, 2 ownership cases, 3 signal paths -> decides
- app `sidecar` argv: 4 shapes, 8 rejections -> decides
- closest analogue in the repo: `src/status.ts` `evaluateStatus`, a state-to-output decision table proven row by row at its own layer (cli-core C30-C34, C121) and at the CLI boundary

Cost: about 60 Rust tests and 17 Vitest tests in `app/`, 6 Bun tests in `tests/`, 3 bundle commands
and 3 smoke-script runs on the installed app.

## Swept

- validation: C7, C13, C30, C54
- failure modes: C13, C38, C39, C40, C41, C42, C51, C81
- idempotency: C35, C37, C49, C55 - a repeated poll, spawn decision, check or Settings open does nothing twice
- authorization: C5, C6, C8, C9, C47, C54, C83, C84, C85 - the webview reaches four commands only; the app signals only its own children
- concurrency: C12, C38, C49, C61 - one status and one doctor in flight; `run.lock` settles a start race with the LaunchAgent (C38); a second app instance only watches the first one's child (C36)
- data lifecycle: C10, C78 - the app stores nothing; the login item is removed when switched off
- dependency failure: C13, C18, C42, C51 - sidecar unreadable or hung, tunnel down, child crashing
- state transitions: C17, C18, C19, C20, C34, C42, C44, C45, C69
- observability: C13, C27, C60 - the menu and Settings are the observable surface; the app writes no log in v0.2 (C10)
- deploy compatibility: C1, C2 - JSON additions are additive and cli-core proofs stay green; rollback is deleting the `.app`, the CLI fields stay harmless
- performance budget: C12, C35, C48 - one status process at a time every 2 s and a menu rebuilt only on change; CPU use is a service target, not a criterion, in v0.2
