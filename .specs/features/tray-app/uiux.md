# Tray app UI change map

## Reference

- **Approved source/frame:** `docs/design/concept-c/tray-{idle,connected,reconnecting,disconnected,blocked}.svg` and `tray-reconnecting-animated.svg` (tray marks); concept A dropdown `menuA()` in `docs/design/_src/parts.mjs` as rendered in `docs/design/concept-a/index.html` (menu rows and words); concept B `settings-domains` window in `docs/design/concept-b/index.html` (route strip over tabs); concept A arch (`ARCH` in `docs/design/_src/lib.mjs`) for the app icon; `docs/design/README.md` States, Tokens and shared decisions
- **Revision/frozen export:** the files above at commit `4359f13`
- **Intent:** binding implementation, with the departures below; the user chose this mix (C mark, A native menu, B route in Settings, A arch icon) on 2026-11-22
- **Route and mapping:** tray mark per state ↔ 18×18 pt menu bar; native menu per state ↔ its OS-drawn size; Settings window ↔ 640×520 pt; Set Up view ↔ 640×520 pt
- **Captures:** builder saves under `.specs/features/tray-app/captures/` (ignored): `ref-<screen>-<state>-<theme>.png` from the concept page, `full-…` and `view-…` from the running app (`screencapture -l <window id>` for Settings, `screencapture -R` around the menu bar item and open menu)
- **Scale/environment:** source scale 2 (concept pages captured at DPR 2); runtime macOS 27 (Darwin 27.2) WKWebView; scale 2; fixtures: in-process test server and temp configs per state, plus this Mac's live LaunchAgent tunnel for Connected; fonts: system UI and `ui-monospace`; themes light and dark
- **Tokens:** design README Tokens table, light and dark, mapped 1:1 to CSS custom properties in `app/src/styles.css` (`--text`, `--text-2`, `--text-3`, `--window`, `--solid`, `--tile`, `--well`, `--hairline`, `--ok`, `--warn`, `--down`, `--busy`, `--skip`); accent follows the system (`AccentColor`); radii from concept A (control 6, box 8, window 11)
- **Composition:** Settings: route strip (four stops, mark + name + word) on top, segmented tabs below, tab body, no footer; Status tab: hop list, then the failing hop's detail, fix and `Copy Fix`, then `Check Again` right-aligned
- **Visual requirements:** 13 px controls and rows, 12 px hints, 11 px section labels, 15 px titles weight 600; monospace only for hosts, ports, fingerprints, paths and commands; 4 px spacing base, 22 px window gutter; no pointer target under 24×24 px; colour always with a glyph and a word
- **Layout/responsive constraints:** fixed 640×520 pt window; long fix text wraps inside the Status tab and scrolls; route strip never wraps
- **Expected differences/tolerances:** listed below; native menu metrics, fonts and disabled-row dimming are the OS's

| Region/property | Source requirement | Implementation difference | Necessity and authority | Preserved requirement / verification |
| --- | --- | --- | --- | --- |
| Menu bar material | frosted mock menu | AppKit `NSMenu` material | native menu decided (README rec.) | rows, order, words; capture compare |
| Menu tone colours | coloured glyph in head row | template mark in the head is not drawn; tone shows in the menu bar mark shape only | native menus take no coloured glyphs reliably | state readable by shape and title |
| Connected sub-row | `Home IP 203.0.113.42` | omitted | `status` has no home IP (plan Out of scope) | `Through home` list stays |
| `Edit Domains…`, `Logs`, `Add <host>…` rows | present in A | omitted | plan Out of scope | remaining row order unchanged |
| `Run Check`, `Open at Login` rows | absent in A | added before `Settings…` | decided actions (plan Approval) | AC 29 order |
| `Managed outside the app (pid N).` row | absent | added after the title rows | decided ownership (door 6) | AC 36 |
| `Server allows too much` state | not drawn (README: belongs with red Blocked) | blocked mark, its own title | doctor exit 14 | AC 25 |
| Settings tabs | `Domains`, `Server`, `Logs`; Start at login in footer | `Status`, `Server`, `Domains`, `General`; Open at login in General | decided Settings scope | route strip on top unchanged; AC 57 |
| Settings Domains body | add field and removable chips | read-only list with count | editing out of scope | AC 66 |
| Route summary line | `All checks OK. Home IP …` | `All checks OK.` | no home IP | position and `Check Again` kept |
| Window chrome | mock traffic lights | real macOS title bar | OS | title `social-tunnel` |
| Setup | three-step assistant | read-only Set Up view with README steps | setup assistant out of scope | AC 68 |
| `Check Again` placement (resolved in S3 build, coordinator decision 2026-11-22) | B places it beside the route summary | one `Check Again` at the end of the Status tab, right-aligned | Composition above; one button per C61 | AC 61 |

## Screens

### Tray mark - menu bar

- **New or changed:** new
- **Story:** see the tunnel state without opening anything (S1)
- **Entry points:** always visible while the app runs
- **States:** not set up · connected · reconnecting (8-frame loop, frame 0 under Reduce Motion) · disconnected · blocked
- **Viewports:** 18×18 pt in the menu bar, light and dark menu bar (template tinting)

### Tray menu - native

- **New or changed:** new
- **Story:** know what broke and act on it (S1, S2)
- **Entry points:** click the tray mark
- **States:** 13 layouts: Not set up, and each of Connected, Reconnecting…, Disconnected, Blocked at the server, Server key changed, Server allows too much with ownership owned-or-none (`Reconnect` shown) or external (`Managed outside the app` row, no `Reconnect`); modifiers: doctor hop rows, status unreadable, stale, config changed, Run Check in progress
- **Viewports:** OS-drawn; captured at its natural size in light and dark

### Settings - `Status` tab

- **New or changed:** new
- **Story:** read every check and its full fix (S3)
- **Entry points:** menu `Settings…` (⌘,)
- **States:** loading (no snapshot) · all OK · failing hop (port refused) · server key changed · status unreadable · checking
- **Viewports:** 640×520 pt, light and dark, Reduce Transparency off and on

### Settings - `Server`, `Domains`, `General` tabs and the Set Up view

- **New or changed:** new
- **Story:** see where the tunnel goes and what it carries; start from nothing (S3)
- **Entry points:** tabs; `Review Server Key…` opens Server; `Set Up…` opens the Set Up view
- **States:** Server: populated, key changed with fix · Domains: populated · General: login on, login off · Set Up: config path shown
- **Viewports:** 640×520 pt, light and dark

## Components

| Component | New or existing | States and variants | Source |
| --- | --- | --- | --- |
| `RouteStrip` | new | stop words OK, Refused, Key changed, Failed, Skipped, Not checked, Checking… | concept B `route()` |
| `HopList` | new | OK, Failed (with detail, fix, Copy Fix), Skipped | concept A `doctorList()` |
| `Tabs` | new | four tabs, keyboard Left/Right | concept A/B `tabs()` |
| `KeyValueList` | new | Server rows, monospace values | concept A `serverSummary()` |
| `SetUpSteps` | new | four steps with commands | README quick start |

## Copy

Menu (native), per state; `<…>` comes from the CLI:

| State | Rows, in order |
| --- | --- |
| Not set up | `Not set up` · `Nothing is routed yet.` · — · `Set Up…` · — · `Quit social-tunnel` ⌘Q |
| Connected | `Connected` · [`Managed outside the app (pid <pid>).`] · — · `Through home` · `<domain>` (at most 10) · [`<n> more in Settings`] · — · `Run Check` · [`Reconnect`] · `Settings…` ⌘, · `Open at Login` · — · `Quit social-tunnel` ⌘Q |
| Reconnecting | `Reconnecting…` · `Next try in <n> s.` or `Trying now.` · [managed row] · `<n> domains paused. Nothing goes direct.` · — · `Run Check` · [`Reconnect`] · `Settings…` · `Open at Login` · — · `Quit social-tunnel` |
| Disconnected | `Disconnected` · [two hop rows] · [`The tunnel stopped reporting.` / `The running tunnel uses an older config.` / `Can't read the tunnel status.`] · [managed row] · paused row · — · `Run Check` · [`Reconnect`] · `Settings…` · `Open at Login` · — · Quit |
| Blocked, port | `Blocked at the server` · `Tunnel port: the server refused port <remotePort>` · `Fix: free port <remotePort>, allow it for the key` · paused row · — · `Copy Fix` · `Run Check` · … |
| Blocked, key | `Server key changed` · `Server: host key does not match the saved one` · `Fix: do not connect until you know why` · paused row · — · `Review Server Key…` · `Run Check` · … |
| Blocked, lock-down | `Server allows too much` · `Lock-down: the tunnel user can do more than forward` · `Fix: restrict the tunnel user on the server` · paused row · — · `Copy Fix` · `Run Check` · … |
| Checking | `Run Check` row reads `Checking…`, disabled |

`[Reconnect]` is shown in every layout except Not set up and external ownership. The paused row reads
`1 domain paused. Nothing goes direct.` when n is 1 and uses the last readable count when status is
unreadable (omitted if none was ever readable).

Short hop rows, 11 hop-and-exit pairs. Under Disconnected (AC 27) only the 7 pairs with exit 2 or
10 can appear; `ssh_auth`/13, `forward`/11 and `lockdown`/14 are the rows of the Blocked layouts
(AC 23-25); `domain`/12 is unreachable in v0.2 (no call sends `--domain`, AC 26) and kept for later:

| Hop, exit | Row 1 | Row 2 |
| --- | --- | --- |
| `config`, 2 | `This Mac: the config file needs a fix` | `Fix: open Settings for the field to change` |
| `key`, 2 | `This Mac: the tunnel key can't be used` | `Fix: open Settings for the key fix` |
| `server_reachable`, 10 | `Server: no connection to <host>:<port>` | `Fix: check the server is up and allows SSH` |
| `ssh_auth`, 10 | `Server: SSH sign-in failed` | `Fix: open Settings for the full fix` |
| `ssh_auth`, 13 | `Server: host key does not match the saved one` | `Fix: do not connect until you know why` |
| `forward`, 11 | `Tunnel port: the server refused port <remotePort>` | `Fix: free port <remotePort>, allow it for the key` |
| `forward`, 10 | `Tunnel port: the server did not answer` | `Fix: run the check again` |
| `lockdown`, 14 | `Lock-down: the tunnel user can do more than forward` | `Fix: restrict the tunnel user on the server` |
| `lockdown`, 10 | `Lock-down: the server did not answer` | `Fix: run the check again` |
| `egress`, 10 | `This Mac: no internet connection to <domain>` | `Fix: check this Mac's internet and DNS` |
| `domain`, 12 | `Domains: the host is not on the list` | `Fix: add it only if it should use home` |

Settings: window title `social-tunnel`; stops `This Mac`, `Server`, `Tunnel port`, `Domains`; tabs
`Status`, `Server`, `Domains`, `General`; hop names `Config file`, `Domain`, `Tunnel key`,
`Server reachable`, `SSH sign-in`, `Tunnel port`, `Lock-down`, `Internet from this Mac`; words `OK`,
`Failed`, `Skipped`, `Refused`, `Key changed`, `Not checked`, `Checking…`; buttons `Check Again`,
`Copy Fix`; summary `All checks OK.`; Server labels `Server`, `SSH port`, `Tunnel user`, `Server key`,
`Key file`, `Tunnel port`; Domains heading `<n> domains use home internet` (`1 domain uses home internet`); General
`Open at login`; Set Up steps per AC 68; error `Can't read the tunnel status.`; note (Server and
Set Up) `You sign in to each site yourself in the server's browser. social-tunnel never sees passwords or codes.`

## Out of scope

Setup assistant windows, Logs tab, add/remove domain controls, the C control panel and B popover as
the tray dropdown, Windows and Linux chrome and tray sets.
