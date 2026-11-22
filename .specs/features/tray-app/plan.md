# Tray app (v0.2): menu bar status, supervised tunnel, read-only settings

## Problem

The only way to learn whether the tunnel works is to type `social-tunnel status` or `doctor` in a
terminal on the home computer. When the tunnel drops, nothing on the Mac says so: the agents on the
server just see the chosen sites fail, by design (fail closed), and the user finds out when an agent
reports a broken login. Starting, restarting or stopping the tunnel means a terminal or `launchctl`.
`doctor`'s fix text (up to about 500 characters) exists only in terminal output.

This Mac runs the tunnel today from a hand-written LaunchAgent (`tech.antoniofulg.social-tunnel`,
`bun src/cli.ts run`, KeepAlive), which any new tool must leave alone. The source gives no usage
figures; the evidence is the README's release plan (tray app is v0.2) and the three design concepts in
`docs/design`.

When this ships, a menu bar icon shows the tunnel state at a glance (connected, reconnecting,
disconnected, blocked, not set up), its menu names the failing check and copies the fix, the app
keeps its own tunnel running (or only watches one started elsewhere), and a read-only Settings window
shows every `doctor` hop, the server, the key path and the domain list.

## Flow

Reuses the CLI as the only tunnel, status and check implementation: the app runs the compiled CLI as
a sidecar, relies on `run.lock` for one run per config directory and shows `doctor`'s own detail and
fix text. It adds no tunnel, proxy, config-parsing or check logic.

1. every 2 s, `poller` (new, no door - placement per conventions) -> `sidecar` argv builder (new, door 5) -> compiled `social-tunnel` binary (door 3) running `src/cli.ts` (exists) `status --json`, which reads `src/status.ts` (exists) and `src/config.ts` (exists) and prints the added fields (doors 1, 2)
2. status JSON, the latest `doctor --json` result, ownership (door 6) and the app-observed downtime -> `model` (new, no door - placement per conventions) - a pure mapping to tray state, image, menu model and Settings snapshot
3. `model` -> `tray` (new, no door - placement per conventions) - sets the template image or frame loop, rebuilds the native menu only when the model changed, emits the `snapshot` event (door 5)
4. menu action -> `supervisor` (new, no door - placement per conventions) - spawns, restarts or stops the `run --json` child and runs `doctor --json` single-flight through `sidecar` (door 5); clipboard through `tauri-plugin-clipboard-manager` and login item through `tauri-plugin-autostart` (doors 7, 8)
5. Settings window, React in `app/src` (new, door 8) - calls `get_snapshot`, `run_check`, `copy_fix`, `set_open_at_login` (door 5), draws the route strip and four tabs over OS vibrancy (door 9)
6. out: menu bar mark and native menu; `social-tunnel.app` (doors 3, 4) copied to `~/Applications` by `app/scripts/install-local.sh` (new, no door - placement per conventions)

## Impact

| Front | What changes |
| --- | --- |
| domain | new term: `tray state` - one of not set up, connected, reconnecting, disconnected, blocked; the app's grouping of CLI `state`, `reason` and exit code; lives in the app `model`. The CLI `state` set is unchanged |
| domain | new term: `ownership` - `owned` when the live run's pid is the app's own child, `external` when another live run holds the config directory; lives in the app `model` |
| interface | `status --json` gains `server.user`, `server.hostKey`, `keyPath`, `allowlist`; agents and scripts that read today's fields see the same values; `domains` stays a count (door 1) |
| interface | a `config_invalid` failure of `status --json` / `run --json` gains top-level `configPath` (door 2); `error.code` and exit 2 unchanged, so cli-core check C2 still holds |
| machine | the LaunchAgent `tech.antoniofulg.social-tunnel` and its live `run` are never signalled or edited; the app watches it (criteria 36, 47, 79, 82) |
| repository | new `app/` (own `package.json`, Vite, Vitest, Tauri crate in `app/src-tauri`); root `bun test` must keep collecting only `tests/`, so app Vitest files and the artifact tests in `app/bun-tests/` never run in cli-core's suite and its proofs stay unchanged |
| repository | `.gitignore` adds `app/node_modules/`, `app/dist/`, `app/src-tauri/target/`, `app/src-tauri/binaries/` (build output) |
| stored data | nothing to migrate - the app stores nothing; `config.json` and `state.json` keep their v1 shapes |

## Relations

None - no stored-data shape change. The app persists nothing; the two JSON additions are interface
changes and live in `Surface` and `Landing`.

## Surface

| Interface | In | Out | Outcomes |
| --- | --- | --- | --- |
| `social-tunnel status --json` (additive) | `--config <path>` | today's object plus `server.user`, `server.hostKey`, `keyPath`, `allowlist` | exit 0 connected, 2 config, 10 down, 11 port blocked, 13 host key mismatch (unchanged) |
| `status --json` / `run --json` config failure (additive) | missing or invalid config | `{ok:false, command, configPath, error:{code:"config_invalid", message, field}}` | exit 2 (unchanged) |
| `bun run build:sidecar` | `src/cli.ts` | `app/src-tauri/binaries/social-tunnel-<target triple>` | exit 0 built, non-zero on a compile error |
| `sidecar argv` | `SidecarCall` (app-internal; the only process the app starts) | `status --json`, `doctor --json`, `doctor --json --domain <host>`, `run --json`, each with optional `--config <absolute path>` | `ok`, `invalid_host`, `invalid_config_path` |
| IPC command `get_snapshot` | none | `Snapshot`: tray state, title, rows, status fields, latest doctor hops, server, keyPath, allowlist, configPath, ownership, openAtLogin, reduceTransparency | `ok`, `status_unreadable` (inside the snapshot) |
| IPC command `run_check` | none | the doctor result | `ok`, `busy` (a check already runs; joins it), `timeout` |
| IPC command `copy_fix` | `hop` | none | `ok`, `no_fix` |
| IPC command `set_open_at_login` | `enabled` | `enabled` read back | `ok`, `autostart_failed` |
| IPC event `snapshot` | - | `Snapshot` | emitted when the snapshot changes |
| `tauri build --bundles app` | `app/` | `social-tunnel.app` | exit 0 bundle written |
| `app/scripts/install-local.sh` | built bundle | `~/Applications/social-tunnel.app` | exit 0 copied, exit 1 `Quit social-tunnel first.` |

## Landing

| One-way door | Literal shape | Alternative rejected |
| --- | --- | --- |
| 1. Status JSON additions | `status --json` adds `"server":{"host","port","user","hostKey"}`, `"keyPath":"<absolute>"`, `"allowlist":["instagram.com",...]`; `domains` stays the count | App parses `config.json` itself: a second config parser beside `src/config.ts`, against AGENTS.md's one code path. `domains` as an array: breaks the README's documented count |
| 2. `configPath` on config failures | top-level `configPath` beside `error` when `error.code` is `config_invalid` (status, run) | New `config_missing` code: changes the outcome cli-core C2 approved for a missing file |
| 3. Sidecar binary | `bundle.externalBin: ["binaries/social-tunnel"]`, built as `binaries/social-tunnel-<triple>` by `bun build --compile src/cli.ts`; bundled `Contents/MacOS/social-tunnel`; app Cargo package `social-tunnel-app` | Cargo package `social-tunnel`: its binary would collide with the sidecar in `Contents/MacOS`. Shipping `src/` plus a Bun runtime: needs Bun on the user's Mac |
| 4. Bundle identity | `identifier: "tech.antoniofulg.social-tunnel.tray"`, `productName: "social-tunnel"` | `tech.antoniofulg.social-tunnel`: the label of the user's existing LaunchAgent; a login item under it would overwrite that plist. Changing the identifier later orphans the login item |
| 5. IPC and process boundary | webview capability holds core event permissions plus app commands `get_snapshot`, `run_check`, `copy_fix`, `set_open_at_login` and event `snapshot`; only Rust starts processes, through `enum SidecarCall { Status, Doctor { domain: Option<Host> }, Run }` -> argv | JS `Command.sidecar` with `shell:allow-spawn` and an args validator in JSON: a script in the webview could start or stop runs, and the allowlist would live in config no test reads. Stricter than, and satisfies, the decided "sidecar only, fixed arguments" |
| 6. Ownership rule | `owned` iff status `pid` equals the app child's pid; any other live run is `external` and only watched; the app signals only pids it spawned | Ownership marker file: needs app file writes and goes stale after a crash. Stopping other runs: would disturb the user's LaunchAgent |
| 7. Login item | `tauri-plugin-autostart`, `MacosLauncher::LaunchAgent`, label not `tech.antoniofulg.social-tunnel` | `MacosLauncher::AppleScript`: asks for Automation access to System Events on first use |
| 8. App dependencies | `app/package.json` (Bun): `react@19`, `react-dom@19`, `vite`, `@vitejs/plugin-react`, `tailwindcss@4`, `@tailwindcss/vite`, `@tauri-apps/api@2`, `@tauri-apps/cli@2`, `vitest`, `@testing-library/react`; crate: `tauri@2` (`tray-icon`, `macos-private-api`), `tauri-plugin-shell` (Rust side only), `tauri-plugin-autostart`, `tauri-plugin-clipboard-manager` (Rust side only), `serde`, `serde_json` | Native Swift/AppKit app: no Windows or Linux path; AGENTS.md fixes Tauri v2 + React + Vite + Tailwind v4 |
| 9. Window vibrancy | `app.macOSPrivateApi: true`; Settings window `transparent: true` with `windowEffects` from the OS (`NSVisualEffectView`) | CSS `backdrop-filter` only: blurs web content, not the desktop (design README open question 2). Closes Mac App Store distribution |

- Nothing else in this change is hard to reverse

## Criteria

Tray marks follow concept C · Beacon; menu rows follow concept A's native menu; Settings follows
concept B's route strip over tabs. Exact copy lives in [uiux.md](uiux.md#copy).

### S1: The tray shows the live tunnel state (P1)

Launch the app: one menu bar icon, no Dock icon, and a native menu whose title and rows follow
`status --json` within one poll.

**Acceptance Criteria**

1. WHEN `status --json` succeeds THEN the CLI SHALL also print `server.user`, `server.hostKey`, `keyPath` (absolute) and `allowlist` (the normalized domains in config order), keeping every existing field with its current value and type and `domains` as the count
2. WHEN `status --json` or `run --json` exits 2 with `error.code` `config_invalid` THEN the CLI SHALL also print the absolute top-level `configPath` it resolved, with `ok`, `command` and `error` unchanged
3. WHEN `bun run build:sidecar` runs THEN it SHALL write `app/src-tauri/binaries/social-tunnel-<host target triple>` compiled by `bun build --compile` from `src/cli.ts`, and that binary SHALL print the `package.json` version for `--version` with exit 0
4. WHEN the compiled sidecar runs `run --json` against an in-process `ssh2` test server with a pinned host key THEN `status --json` from the same binary SHALL report `"state":"connected"` with exit 0 within 10 s
5. The webview capability SHALL grant no permission whose identifier starts with `shell:`, `fs:`, `http:`, `opener:`, `process:`, `clipboard-manager:`, `autostart:`, `dialog:` or `updater:`, and SHALL list only core event permissions and the four app commands named in Surface
6. The sidecar argument builder SHALL return only `status --json`, `doctor --json`, `doctor --json --domain <host>` and `run --json`, each optionally followed by `--config <absolute path>`
7. IF the argument builder gets a host that is empty, starts with `-`, holds a NUL or whitespace, or fails the CLI hostname grammar, or a config path that is relative, starts with `-` or holds a NUL THEN it SHALL return an error and the app SHALL start no process
8. The app SHALL start the sidecar only from the absolute path `<directory of the app executable>/social-tunnel`, never through a `PATH` lookup
9. The `tauri.conf.json` SHALL set the CSP `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src ipc: http://ipc.localhost; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`, `withGlobalTauri` false, a local `frontendDist`, and no capability with a `remote` URL
10. The app's Rust source under `app/src-tauri/src` SHALL contain no filesystem read, write or open call (`std::fs::`, `File::open`, `File::create`, `OpenOptions`, `tokio::fs`) other than one `try_exists` on the `configPath` of criterion 2
11. WHEN the app starts on macOS THEN it SHALL set `ActivationPolicy::Accessory` and create exactly one tray icon
12. WHILE the app runs it SHALL call `status --json` every 2 s with at most one call in flight, skipping a tick that finds the previous call still running
13. IF a `status` call runs past 10 s, exits with a code outside 0, 2, 10, 11 and 13, or prints stdout that is not one JSON object or exceeds 1 MiB THEN the app SHALL kill the call if it still runs and show Disconnected with the row `Can't read the tunnel status.`
14. WHEN status exits 2 with `config_invalid` and no file exists at its `configPath` THEN the tray SHALL show the not-set-up mark and the menu SHALL hold exactly `Not set up`, `Nothing is routed yet.`, a separator, `Set Up…`, a separator and `Quit social-tunnel` (⌘Q)
15. WHEN status exits 2 with `config_invalid` and a file exists at its `configPath` THEN the tray SHALL show the disconnected mark with the title `Disconnected`
16. WHEN status exits 0 with `state` `connected` THEN the tray SHALL show the connected mark and the menu SHALL show `Connected`, a separator, the label `Through home` and one row per `allowlist` entry in order
17. WHILE status reports `connecting`, `reconnecting`, or `disconnected` with reason `connection_lost`, for less than 60 s since the app last saw `connected` or first saw this run not connected, the tray SHALL show the reconnecting mark with the title `Reconnecting…` and the row `Next try in <n> s.` (n = ceil((retryAt - now) / 1 s)), or `Trying now.` when `retryAt` is null or past
18. WHEN the condition of criterion 17 reaches 60 s THEN the tray SHALL show the disconnected mark with the title `Disconnected`
19. WHEN status reports `disconnected` with reason `auth_failed` THEN the tray SHALL show the disconnected mark with the title `Disconnected` at once, whatever the elapsed time
20. WHEN status reports `stopped` THEN the tray SHALL show Disconnected, except within 5 s after the app spawned a `run` child, when it SHALL show Reconnecting
21. WHEN status reports `stopped` with reason `stale` THEN the menu SHALL add the row `The tunnel stopped reporting.`
22. WHEN status reports `stopped` with reason `config_changed` THEN the menu SHALL add the row `The running tunnel uses an older config.`
23. WHEN status exits 11 with `blocked` and `port_blocked` THEN the tray SHALL show the blocked mark and the menu SHALL show `Blocked at the server`, `Tunnel port: the server refused port <remotePort>`, `Fix: free port <remotePort>, allow it for the key` and the action `Copy Fix`
24. WHEN status exits 13 THEN the tray SHALL show the blocked mark and the menu SHALL show `Server key changed`, `Server: host key does not match the saved one`, `Fix: do not connect until you know why` and the action `Review Server Key…`
25. WHEN the latest doctor result exits 14 THEN the tray SHALL show the blocked mark and the menu SHALL show `Server allows too much`, `Lock-down: the tunnel user can do more than forward`, `Fix: restrict the tunnel user on the server` and `Copy Fix`, whatever status reports, until a later doctor result exits with another code
26. WHEN the latest doctor result exits 12 THEN the tray SHALL keep the mark and menu title that status gives
27. WHILE the tray shows Disconnected and a doctor result exists, the menu SHALL show the two short rows of its first failing hop from the app's map of 11 hop-and-exit pairs in uiux.md
28. WHILE the tray shows Reconnecting, Disconnected or Blocked, the menu SHALL show `<domains> domains paused. Nothing goes direct.`, and WHILE it shows Connected or Not set up the menu SHALL omit that row
29. The menu SHALL end, in every state except Not set up, with in order: the state's action row if any, `Run Check`, `Reconnect` when shown, `Settings…` (⌘,), `Open at Login` with a checkmark when on, a separator and `Quit social-tunnel` (⌘Q)
30. IF a menu row built from CLI text is longer than 60 characters THEN the app SHALL cut it to 59 characters plus `…`
31. The app SHALL ship one template image per tray state (not set up, connected, disconnected, blocked, and reconnecting as 8 frames) at 18×18 and 36×36 px, drawn from concept C's marks, with every pixel's RGB at 0, and SHALL set each as a template image
32. WHILE the tray shows Reconnecting and Reduce Motion is off, the app SHALL cycle the 8 reconnecting frames at 150 ms each
33. WHILE the tray shows Reconnecting and Reduce Motion is on, the app SHALL show frame 0 and run no frame timer
34. WHEN the tray leaves Reconnecting THEN the app SHALL stop the frame timer and show the new state's single image
35. WHEN a poll yields the same menu model as the one shown THEN the app SHALL not rebuild the menu

**Independent test:** with a temp config pointing at an in-process test server, launch `tauri dev`; the menu
bar shows one icon and no Dock icon; stopping the test server moves the menu from `Connected` to
`Reconnecting…` and, after 60 s, `Disconnected`.

### S2: The app runs or watches the tunnel, and its actions work (P1)

The app keeps its own `run` alive, never touches a run it did not start, and Run Check, Copy Fix,
Reconnect and Quit do what they say.

**Acceptance Criteria**

36. WHEN status shows a live run (`pid` not null, `state` not `stopped`) whose pid is not the app's child THEN the app SHALL start no `run`, hide `Reconnect`, and show the row `Managed outside the app (pid <pid>).`
37. WHEN status shows no live run, its config exists and is valid, and status did not exit 13 THEN the app SHALL spawn exactly one `run --json` child
38. IF the app's child exits 2 with `error.code` `already_running` THEN the app SHALL not restart it and SHALL watch the live run per criterion 36
39. IF the app's child exits 13 THEN the app SHALL not restart it
40. IF the app's child exits 2 with any other `error.code` THEN the app SHALL not restart it and SHALL run `doctor --json` once
41. IF the app's child exits 0 without the app having signalled it THEN the app SHALL not restart it
42. IF the app's child exits 1, with any code not named in criteria 38-41, or by a signal the app did not send THEN the app SHALL spawn it again after 1, 2, 4, 8, 16, then every 30 s for successive failures, resetting to 1 s once a child has run 60 s
43. WHEN status exits 13 at app start THEN the app SHALL spawn no `run`
44. WHEN the user chooses Reconnect while the app owns a child THEN the app SHALL send it SIGTERM, wait up to 5 s, send SIGKILL if it still runs, spawn one new `run --json`, and reset the backoff to 1 s
45. WHEN the user chooses Reconnect while the app has no child and watches no external run THEN the app SHALL cancel any pending restart and spawn one `run --json` at once
46. WHEN the user quits THEN the app SHALL kill running `status` and `doctor` calls, send SIGTERM to its own child, wait up to 5 s, send SIGKILL if the child still runs, and then exit
47. The app SHALL send no signal to any pid other than those of processes it spawned
48. WHILE a child runs, the app SHALL read and discard its stdout and stderr as they arrive, so a child that writes 1 MiB to stderr keeps running
49. WHEN the user chooses Run Check THEN the app SHALL run `doctor --json` once and show that row as `Checking…`, disabled, until it ends, and a Run Check while one runs SHALL start no second doctor
50. WHEN the tray enters Disconnected or Blocked THEN the app SHALL run `doctor --json` unless a doctor run started within the last 30 s
51. IF a doctor call runs past 120 s THEN the app SHALL kill it and keep the previous doctor result
52. WHEN the user chooses Copy Fix THEN the clipboard SHALL hold, byte for byte, the `fix` of the first failing hop of the latest doctor result
53. WHILE no doctor result holds a failing hop with a non-empty `fix`, the app SHALL show Copy Fix disabled
54. IF `copy_fix` is invoked with a hop not in the latest doctor result or a hop with no fix THEN it SHALL leave the clipboard unchanged and return `no_fix`

**Independent test:** run the supervisor tests against a fake sidecar script that exits with each code and
traps SIGTERM; then, on this Mac with the LaunchAgent live, open the app and see `Managed outside the app`
with no `Reconnect`.

### S3: Settings shows the route, the server and the domains (P2)

Settings… opens one window with the four-stop route on top and Status, Server, Domains and General
tabs, all read-only except Open at login.

**Acceptance Criteria**

55. WHEN the user chooses Settings… THEN the app SHALL show one Settings window of 640×520 pt on the Status tab, focusing it when already open, never a second window
56. WHEN the user closes the Settings window THEN the app SHALL keep running with its tray icon
57. The Settings window SHALL show the route strip `This Mac`, `Server`, `Tunnel port`, `Domains` above the tabs `Status`, `Server`, `Domains`, `General`, in that order
58. WHEN a tab has focus and the user presses Left or Right Arrow THEN the Settings window SHALL move focus and selection to the previous or next tab, wrapping at the ends
59. The route strip SHALL group doctor hops as This Mac = `config`, `key`, `egress`; Server = `server_reachable`, `ssh_auth`; Tunnel port = `forward`, `lockdown`; Domains = `domain`, and word each stop `OK` when its hops passed, `Key changed` for an `ssh_auth` failure with exit 13, `Refused` for a `forward` failure with exit 11 or a `domain` failure, `Failed` for any other failed hop, `Skipped` when its hops were skipped, and `Not checked` before the first doctor result; a Domains stop with no `domain` hop SHALL read `OK` when the other three read `OK`, else `Skipped`
60. The Status tab SHALL list every hop of the latest doctor result in order as `Config file`, `Domain`, `Tunnel key`, `Server reachable`, `SSH sign-in`, `Tunnel port`, `Lock-down`, `Internet from this Mac`, each with `OK`, `Failed` or `Skipped` and its `detail`, and a failed hop with its full `fix` text and a `Copy Fix` button
61. WHEN the user presses `Check Again` on the Status tab THEN the app SHALL run doctor through the same single-flight call as Run Check and show `Checking…` until it ends
62. WHEN Settings opens and no doctor run started within the last 30 s THEN the app SHALL run doctor once
63. WHILE no snapshot has arrived, the Status tab SHALL show the stop names and tab labels with the word `Checking…`
64. WHILE the snapshot says the status is unreadable, the Status tab SHALL show `Can't read the tunnel status.` and every stop `Not checked`
65. The Server tab SHALL show host, SSH port, tunnel user, host key fingerprint, key path and tunnel port from the snapshot, and SHALL hold no field with the key file's content
66. The Domains tab SHALL list every `allowlist` entry in config order under `<n> domains use home internet`, with no add, remove or edit control
67. The General tab SHALL show an `Open at login` checkbox whose state comes from the snapshot and whose change calls `set_open_at_login`
68. WHEN the user chooses Set Up… THEN Settings SHALL open a Set Up view with the README quick-start steps titled `1. Create a dedicated key on this Mac`, `2. Prepare the server (once, as root)`, `3. Write the config on this Mac`, `4. Check every hop`, the `configPath` from status in step 3, and a `Check Again` button
69. WHEN a status call succeeds while the Set Up view is shown THEN Settings SHALL switch to the Status tab
70. WHEN the user chooses Review Server Key… THEN Settings SHALL open on the Server tab showing the pinned fingerprint and, when a doctor result has it, the full `fix` of the `ssh_auth` hop
71. WHILE Reduce Transparency is off, the Settings window SHALL show the OS vibrancy material behind a transparent page, and WHILE it is on the page SHALL fill with `#f2f2f4` in light and `#2a2a2e` in dark appearance
72. The Settings page SHALL follow the system appearance with the light and dark values of the design README token table
73. The Settings page SHALL render CLI-supplied text (hosts, paths, domains, details, fixes) as text only, so a domain value `<img src=x onerror=alert(1)>` shows those characters and adds no element
74. The built frontend in `app/dist` SHALL reference no `http://` or `https://` resource

**Independent test:** `bunx vitest run` over the Settings components with fixture snapshots for each state,
then open Settings in `tauri dev` and walk the four tabs with the keyboard.

### S4: A bundled app that opens at login (P2)

`social-tunnel.app` builds, installs to `~/Applications`, opens at login on request, and on this Mac
shows the live LaunchAgent tunnel without touching it.

**Acceptance Criteria**

75. WHEN `tauri build --bundles app` runs THEN it SHALL produce `social-tunnel.app` holding `Contents/MacOS/social-tunnel-app` and the sidecar `Contents/MacOS/social-tunnel`
76. The bundle's Info.plist SHALL set `CFBundleIdentifier` to `tech.antoniofulg.social-tunnel.tray` and `LSUIElement` to true
77. The bundle SHALL carry `Contents/Resources/icon.icns` generated from concept A's arch
78. WHEN Open at Login is switched on THEN the app SHALL register a login LaunchAgent through `tauri-plugin-autostart` whose label is not `tech.antoniofulg.social-tunnel` and whose program is the installed app, WHEN switched off SHALL remove it, and the checkmark SHALL show the state read back after the call
79. WHEN Open at Login is switched on or off THEN `~/Library/LaunchAgents/tech.antoniofulg.social-tunnel.plist` SHALL stay byte-identical
80. WHEN `app/scripts/install-local.sh` runs THEN it SHALL copy the built bundle to `~/Applications/social-tunnel.app`, replacing an older copy
81. IF the installed app is running when `install-local.sh` runs THEN the script SHALL exit 1 with `Quit social-tunnel first.` and copy nothing
82. WHEN the installed app opens on this Mac while the LaunchAgent's `run` is live THEN the menu bar SHALL show the connected mark, the menu SHALL show `Connected` and `Managed outside the app (pid <pid>).`, and after Quit the LaunchAgent run SHALL keep the same pid

**Independent test:** build, run `install-local.sh`, open `~/Applications/social-tunnel.app`, read the menu,
toggle Open at Login twice, quit, and compare the LaunchAgent pid and plist hash before and after.

## Traceability

| ID | Slice | Criteria | Status |
| --- | --- | --- | --- |
| SIDE-01 | S1 | 1, 2, 3, 4 | Pending |
| SAFE-01 | S1 | 5, 6, 7, 8, 9, 10 | Pending |
| TRAY-01 | S1 | 11-35 | Pending |
| SUP-01 | S2 | 36-54 | Pending |
| SET-01 | S3 | 55-74 | Pending |
| PKG-01 | S4 | 75-82 | Pending |

## Security Surfaces

| ID | Surface | Control | Requirements |
| --- | --- | --- | --- |
| S1 | New runtime (Tauri, React, Vite) and dependencies; the CLI compiled into the bundle | Pinned lockfiles (`app/bun.lock`, `Cargo.lock`); sidecar built from this repo's `src/cli.ts`; started only from the bundle path | SEC-003; criteria 3, 8, 75 |
| S2 | Webview -> Rust IPC boundary | No plugin permissions in the webview; four typed commands; strict CSP; no remote content | SEC-001, SEC-002, SEC-007; criteria 5, 9, 54, 74 |
| S5 | SSH key path and pinned host key shown in Settings | The app never reads a file, so it never holds key material; only the path and the public fingerprint are shown | SEC-004; criteria 10, 65 |
| S6 | CLI-, config- and server-supplied text into menu rows, Settings and the clipboard; argv to the sidecar | Text rendered as text; rows cut at 60 characters; argv from a typed allowlist; clipboard only from doctor's own `fix` | SEC-005, SEC-006, SEC-007; criteria 6, 7, 30, 52, 54, 73 |
| S11 | Child processes, signals, login item; the user's live LaunchAgent run | Signals only to own children; external runs watched; one run per config directory (`run.lock`); login-item label apart from the user's LaunchAgent; pipes drained | SEC-005, SEC-008, SEC-009; criteria 36, 38, 47, 48, 78, 79, 82 |

## Out of scope

| Excluded | Why |
| --- | --- |
| Setup assistant and a CLI `setup` | Needs admin SSH to the server and its own threat review; Set Up… shows the README steps instead |
| Editing config or domains from the UI (`Edit Domains…`, `Add <host>…`, Remove) | Needs server PAC sync from `setup`; Settings is read-only |
| A field to test one host (`doctor --domain`) in Settings | Not in the decided v0.2 Settings; the argv builder accepts `--domain` so a later slice needs no new IPC |
| `Logs` menu row and Logs tab | `run` keeps logs on stderr; persisted logs come with `install`/`logs` |
| Home IP in the menu | `status --json` has no home IP; finding it needs an outside lookup (design open question 3) |
| C's frosted control panel and B's popover as the tray dropdown | Decided: A's native menu first; the custom panel can follow |
| Pause action | Not drawn in the chosen design; Quit stops an owned tunnel |
| Re-adopting a run left by a crashed app | Needs a persisted child pid; such a run is watched as external |
| Windows and Linux packaging | macOS is the proof platform; code stays portable |
| Signing, notarization and the updater | Release work after v0.2 is proven locally |

## Assumptions

| Assumption | Chosen default | Rationale | Confirmed? |
| --- | --- | --- | --- |
| Where the 60 s reconnecting limit is measured | from the app's last `connected` poll, or from the first poll that saw this run not connected | `status` restarts `since` on every disconnected/reconnecting switch, so only the app can see total downtime | y - user delegated |
| Settings accent colour | system accent colour (concept A) | Native menu and macOS controls already follow it; design open question 9 | y - user delegated |
| Settings window size | 640×520 pt, not resizable | Fits the route strip and the longest fix text (lock-down, about 500 characters) wrapped | y - user delegated |
| Settings copy for the Check button | `Check Again` (concept B) in Settings; `Run Check` in the menu (decided) | Keeps both sources' words where they appear | y - user delegated |
| Child stderr | read and discarded; the app keeps no log in v0.2 | `Logs` is out of scope; nothing new to redact (invariant 5) | y - user delegated |

**Open questions:**

| # | Kind | Question | Until answered |
| --- | --- | --- | --- |
| 1 | blocks | A scoped threat model (`.specs/features/tray-app/threat-model.md`, skill `security-threat-model`) for the sidecar, IPC and login-item boundaries is required by AGENTS.md before building | S1 build does not start; plan and checks stand |
| 2 | open | Once the app opens at login, retire the hand-written LaunchAgent? With both on, whichever starts second gets `already_running`; launchd then restarts its `run` every 30 s (log noise only) | The app watches the LaunchAgent run; nothing is changed on the machine |
| 3 | open | Add a "test a host" field to Settings › Domains in a later slice? | No UI sends `--domain` in v0.2; criterion 26 covers a result that has one |

## Observable

| Surface | Decision | Landing |
| --- | --- | --- |
| tray menu | empty state (not set up) | AC 14 |
| tray menu | loading (first poll, child just spawned) | AC 20 (Reconnecting for 5 s after spawn); before the first poll the not-set-up mark is n/a - the first poll runs at launch |
| tray menu | error state | AC 13, 15, 18, 19, 23, 24, 25, 27 |
| tray menu | unauthorised state | n/a - one local user; the app has no accounts |
| tray menu | density and ordering | AC 16, 28, 29, 30 |
| tray menu | destructive action confirms | n/a - Quit and Reconnect stop only the app's own child, which restarts on the next Reconnect; no data is lost |
| screen Settings | empty state | AC 66 (allowlist is never empty: config schema rejects it), AC 68 (not set up) |
| screen Settings | loading state | AC 63, 61 |
| screen Settings | error state | AC 64 |
| screen Settings | unauthorised state | n/a - one local user |
| screen Settings | density and ordering | AC 57, 59, 60, 66 |
| screen Settings | destructive action confirms | n/a - read-only; the only control that changes anything is Open at login, reversible in one click |
| command `status --json` | output format | AC 1, 2 |
| command `status --json` | flags and defaults | existing - cli-core criterion 1 (`--config`, `--json`) unchanged |
| command `status --json` | exit codes | existing - cli-core door 1, unchanged |
| command `status --json` | fails halfway | existing - read-only, one file read (cli-core Observable) |
| command `bun run build:sidecar` | output, flags, exit codes | AC 3 |
| command `install-local.sh` | output, exit codes, fails halfway | AC 80, 81 |
| IPC commands | response and error shape | AC 49, 52, 54, 67; Surface rows |
| IPC commands | who may call | AC 5 (only the app's own webview, through its capability) |
| IPC commands | versioning, rate limits | n/a - app and webview ship in one bundle; doctor single-flight (AC 49) bounds the only expensive call |
| copy | tone and next step | uiux.md Copy; every failure row names a fix (AC 23-25, 27) |

## Sources

- [docs/design/README.md](../../../docs/design/README.md) - binding: states table, tray-mark rules, tokens; concept C marks, A menu, B Settings route ([uiux.md](uiux.md))
- [README.md](../../../README.md) - `--json` shapes, exit codes, quick-start steps shown by Set Up…
- [AGENTS.md](../../../AGENTS.md) - safety invariants; the app holds no tunnel logic and runs the CLI as a sidecar
- [cli-core plan](../cli-core/plan.md) - doors 1-3 and 7 this feature extends additively

## Approval

- Decision: "Prossiga com o V0.2 então" and "Vou me ausentar, mais tarde volto para ver o app pronto" - the user approved building v0.2 with the design direction, stack, ownership, polling, scope, security and proof decisions relayed by the coordinating agent, and gave standing delegation to approve criteria without asking
- Source: user in the coordinating Claude Code chat, relayed in the planner dispatch
- Date: 2026-11-22
- Reviewed revision: the user did not read this plan; criteria approved under the standing delegation at the commit that adds this file
- Scope: build S1-S4 with tests and local commits only, including the additive CLI changes of doors 1-2 and a local copy to `~/Applications`; no push, signing, publishing, server changes, or changes to the user's LaunchAgent
