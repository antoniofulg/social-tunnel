# Tray app design concepts

Three visual concepts for the v0.2 tray app. Mockups only: no app code.

Open [`index.html`](index.html) for the side-by-side overview, then one concept page:

- [`concept-a/index.html`](concept-a/index.html): A · Portal
- [`concept-b/index.html`](concept-b/index.html): B · Route
- [`concept-c/index.html`](concept-c/index.html): C · Beacon

Each concept page shows the tray icon set with an animated state sequence, the dropdown in seven states, and the setup and settings windows, all in light and dark. The pages are self-contained: inline CSS, system fonts, no network requests.

## Comparison

| | A · Portal | B · Route | C · Beacon |
| --- | --- | --- | --- |
| Direction | Quiet native. SF Symbols habits, system menu. | Shows the path. The route is the whole interface. | Read at a glance. One silhouette per state. |
| Tray mark | Tunnel arch. Solid doorway, dashes, slash, exclamation mark. | Two dots and a line. Solid line, walking dots, cross, wall. | Ring and centre. Solid centre, turning arc, broken ring, no-entry disc. |
| Motion | Fill, drain, sweep | Draw, pull back, walking dots | Pop, ripple, turning arc |
| Dropdown | Native menu, one line per row | Popover with the four-stop route | Panel of tiles plus menu rows |
| Setup and settings | Three-step assistant, tabbed settings | Route as stepper, route on top of tabs | One page of cards, one page of rows |
| Strengths | Least to build: the native tray menu works on macOS, Windows and Linux. Vibrancy, keyboard and screen reader support come from the system. Most ownable mark. | Shows which check failed without opening anything else. Room for the full fix text. One component is tray mark, status strip and stepper. | Easiest to read at 16 px. Most visible transitions, and still calm. Room for cause, fix and a button without a diagram. |
| Risks | Rows cannot wrap, and `doctor`'s fix strings run up to 160 characters, so each needs a short form. The four states share one outline. Native menus dim disabled rows more than the mock shows. | Custom popover: position, focus, dismissal, keyboard and VoiceOver are ours to build. Linux trays only open menus, so a menu fallback is still needed. Least legible mark at 16 px. Closest to a dashboard. | Least distinctive mark; a solid dot can read as a recording light. Same custom-window cost and Linux fallback as B. Ink buttons ignore the system accent colour. |

## Recommendation

Build **C · Beacon**. The brief puts the tray mark first, and C is the only set where every state has its own silhouette at 16 px. Its changes are the easiest to notice from the corner of the eye, and they stop moving once the state settles.

Borrow the **native menu from A**. Linux needs it anyway, and it makes a cheaper first release: the rows and words match C's panel, so C's mark can ship with A's menu first and the frosted panel can follow.

Keep **B's route for Settings**. It is the best explanation of a failure, but it turns the dropdown into a small dashboard.

Main risk: the ring is the least distinctive mark. Use A's arch as the app icon (Dock, installer, About) so the product still has its own face.

## Decisions shared by all three

1. **Native first.** System font stack (SF on macOS, Segoe UI on Windows), 13 px controls, macOS window chrome. The identity lives in the tray mark, its motion and the words.
2. **Frosted glass.** Dropdowns and windows are translucent fills over a blur. In the mock this is `backdrop-filter: blur() saturate()` over a wallpaper, a sun or moon, and a terminal window, so the blur is visible. In the app the blur must come from the OS (see open question 2). With Reduce Transparency or Increase Contrast, surfaces turn solid.
3. **The tray mark is a template image.** Black plus alpha only, 18 × 18 pt, so macOS tints it for light and dark menu bars. No colour in the menu bar. States differ by shape, and changes by motion. Windows and Linux have no template tinting, so they need a light and a dark set.
4. **Colour is tone, never the only signal.** Inside the dropdown and windows each tone always comes with a glyph and a word. Green is connected. Reconnecting is neutral grey, not amber, because the tunnel is handling it by itself. Amber is blocked. Red is for what needs the user: disconnected, and a changed server key.
5. **Motion plays once, then stops.** A change takes under a second. Only Reconnecting loops. Nothing moves while connected. With Reduce Motion, states swap instantly and Reconnecting shows its still frame.
6. **Fail closed is said in words.** Whenever the tunnel is not up: "4 domains paused. Nothing goes direct."
7. **Safety in the interface.** No field asks for a platform password, 2FA code or cookie. The private key is never shown, only its fingerprint. Setup lists each change it makes on the server. A changed server key has no one-click "trust". Adding a refused domain always opens a deliberate step.
8. **One vocabulary.** All three concepts use the same states and the same words; only the layout differs.

## States

`state` and `reason` are the fields of `social-tunnel status --json` as implemented in `src/` today. The grouping in the last two rows is a proposal.

| Tray state | From the CLI | Status line | Tone | Second lines | Main action |
| --- | --- | --- | --- | --- | --- |
| Not set up | no config | Not set up | neutral | Nothing is routed yet. | Set Up… |
| Connected | `connected`, exit 0 | Connected | green | Home IP, domain list | none |
| Reconnecting | `connecting`, `reconnecting`, and `disconnected` + `connection_lost` during the first retries | Reconnecting… | neutral | Next try in 8 s. Domains paused. | Reconnect (try now) |
| Disconnected | `disconnected` after several failed tries, `auth_failed`, `stopped`, stale; exit 10 | Disconnected | red | Failing check, fix, domains paused | Reconnect |
| Blocked | `blocked` + `port_blocked`, exit 11 | Blocked at the server | amber | Failing check, fix, domains paused | Copy Fix |
| Blocked | `blocked` + `host_key_mismatch`, exit 13 | Server key changed | red | Failing check, fix, domains paused | Review Server Key… |
| Blocked | `doctor --domain` exit 12 | Domain refused | amber | Host that is not on the list | Add *host*… |

Not drawn: `doctor` exit 14 (lock-down failed, the server allows the tunnel user more than one port). It belongs with the red Blocked row.

How each concept draws the tray states, without colour:

| State | A · Portal | B · Route | C · Beacon |
| --- | --- | --- | --- |
| Connected | Arch with a solid doorway | Two solid dots joined by a line | Ring with a solid centre |
| Reconnecting | Arch in three dashes; a segment sweeps | Three small dots light up in order; far end hollow | Open ring turning; small centre beating |
| Disconnected | Empty arch with a slash | Line stops halfway; far end is a cross | Ring broken in four; empty centre |
| Blocked | Empty arch with an exclamation mark | Line runs into a wall | Solid disc with a bar |
| Not set up | Empty arch | One solid dot, one hollow ring | Plain ring |

The dropdown groups `doctor`'s checks into four stops: This Mac (`config`, `key`, `egress`), Server (`server_reachable`, `ssh_auth`), Tunnel port (`forward`, `lockdown`), Domains (`domain`). Settings lists every check.

## Tokens

Semantic roles; only the mapping changes per theme. Values are in the `<style>` block of each page and in `_src/css.mjs`.

| Role | Light | Dark |
| --- | --- | --- |
| Text | `#1c1c1e` | `#f0f0f3` |
| Secondary text | `#46464b` | `#bcbcc4` |
| Disabled text | `#6c6c72` | `#9a9aa2` |
| Dropdown material | `rgba(246,246,248,.60)`, blur 34 px, saturate 1.9 | `rgba(32,32,36,.60)`, same blur |
| Window material | `rgba(244,244,247,.80)`, blur 40 px, saturate 1.7 | `rgba(30,30,34,.78)`, same blur |
| Solid fallback | `#f2f2f4` | `#2a2a2e` |
| Tile, list | `rgba(255,255,255,.42)` | `rgba(255,255,255,.08)` |
| Field | `#ffffff` | `#3a3a40` |
| Well (logs, segmented track) | `rgba(0,0,0,.055)` | `rgba(0,0,0,.30)` |
| Hairline | `rgba(0,0,0,.13)` | `rgba(255,255,255,.15)` |
| Field border | `#86868b` | `#8a8a93` |
| OK | `#1b7f3b` | `#45c869` |
| Blocked | `#8f5d00` | `#e4b643` |
| Down | `#c4252f` | `#ff7a72` |
| Busy | `#46464b` | `#bcbcc4` |
| Skipped | `#6b6b70` | `#a3a3ab` |
| Accent A (system blue) | `#0a64d6` | `#1f6fde`, focus `#7ab8ff` |
| Accent B (indigo) | `#5146d8` | `#665ce6`, focus `#b3adff` |
| Accent C (ink) | `#1c1c1e` | `#f0f0f3` |

Dark is not light inverted: depth comes from lighter surfaces, not shadows, and status colours are retuned.

- **Type.** System UI font. 13 px controls and rows, 12 px hints, 11 px section labels, 15 to 16 px titles at weight 600. Monospace (`ui-monospace`, SF Mono) only for hosts, ports, fingerprints, commands and logs. C sets titles in `ui-rounded`.
- **Spacing.** 4 px base. Menu rows 24 to 26 px, controls 28 px (small 24 px), list rows 32 to 36 px, window gutter 22 px. No pointer target under 24 × 24 px.
- **Radius** (control / box / dropdown / window). A: 6 / 8 / 10 / 11. B: 8 / 10 / 15 / 13. C: pill / 12 / 19 / 15.
- **Motion.** Changes 200 to 380 ms, ease-out `cubic-bezier(.3,.7,.2,1)`; pops overshoot with `cubic-bezier(.3,1.5,.5,1)`; loops 1.1 to 1.5 s.

## Open questions

1. **Which concept?** The recommendation is C, with A's menu as fallback and first release.
2. **Native menu or custom window?** B and C need a transparent webview window with an OS blur behind it (`NSVisualEffectView` on macOS, Acrylic or Mica on Windows). CSS `backdrop-filter` only blurs web content, not the desktop. Linux tray icons open menus only. Is a native menu acceptable for the first release?
3. **Where does the home IP come from?** `status --json` has no home IP field today. The dropdown needs one.
4. **When does Reconnecting become Disconnected?** The tunnel retries forever (1, 2, 4, 8, 16, then every 30 s). The mock assumes the icon turns to Disconnected after several failed tries, or at once for `auth_failed`. What number?
5. **Should a refused domain change the tray icon?** Refusing is the allowlist working. Today exit 12 only comes from `doctor --domain`. Proposal: show it in the dropdown only when the user tests a host, and never raise the tray state for it.
6. **Short fix strings.** A native menu needs a one-line form of each `doctor` fix. Should `doctor --json` carry a short field, or should the app keep its own map per check?
7. **How does setup sign in as admin?** The mock assumes the SSH agent or default key, with no password field, and shows the server key fingerprint to confirm before it is pinned. Is that the intended flow?
8. **Animating a real tray icon.** The OS has no animated tray icons: the app swaps PNG frames. Is a short frame sequence on each change acceptable, and should Reconnecting loop or hold a still frame?
9. **Accent.** Follow the system accent colour (A), or a product colour (B indigo, C ink)?
10. **Domain presets.** Platforms need more than one host (Instagram also loads `cdninstagram.com`). Should the CLI ship presets, so setup offers "Instagram" instead of single domains?
11. **Not drawn.** A Pause action, the auto-update prompt, and Windows or Linux window chrome. Say if any is needed for the decision.

## How it was checked

Headless Chrome over the DevTools protocol, on the generated pages.

- **Renders.** All four pages load with no console errors, no duplicate ids and every label tied to a field. Screenshots were read for the tray tables, every dropdown family and every window family in both themes.
- **Viewports.** 390, 820, 1100 and 1440 px: no horizontal overflow on any page.
- **Contrast.** Measured against the pixels actually rendered behind each text run and glyph, because the materials are translucent: text is hidden, the page is captured, and the worst pixel in each box is compared with the computed colour. 262 to 480 items per page and theme. All text is at or above 4.5:1 and all glyphs above 3:1, in both themes. The only values below 4.5:1 are disabled button labels (3.3:1 to 4.1:1), which WCAG exempts.
- **Motion.** Each transition was captured at 60, 180, 320 and 520 ms for the three concepts. With Reduce Motion emulated, the sequence does not autoplay and Reconnecting has no animation.
- **Other.** Focus ring seen on a primary button in light and dark. Reduce Transparency gives a solid surface. The SVG files parse as XML and render.

Not checked: Safari or WKWebView (the engine Tauri uses on macOS), real macOS vibrancy and native menus, a screen reader, forced colours, Windows and Linux, and how the marks look in a real menu bar at 16 px. The `status` JSON in the background terminals follows `src/cli.ts`; sample values are invented.

## Files

- `index.html`: overview and comparison.
- `concept-<a|b|c>/index.html`: one concept each.
- `concept-<a|b|c>/tray-{idle,connected,reconnecting,disconnected,blocked}.svg`: static tray marks, black plus alpha, ready to export as template PNGs at 1x and 2x.
- `concept-<a|b|c>/tray-reconnecting-animated.svg`: the reconnecting loop as a browser preview.
- `_src/`: the generator. The pages are static output, so edit here and run `node docs/design/_src/build.mjs`. Delete it with the two concepts that are not chosen.
