# Domain management screens

**Verifier**: independent pictures-only worker (author != verifier)  
**Round**: 1  
**HEAD**: e87c811578

**Verdict: matches.** All four pictures omit `Check Again` and replace the reference's left-aligned route summary with centered `All checks OK.` without a Home IP phrase. Domain hostnames use monospaced rather than proportional type. These observed differences are approved under the inherited tray contract; no unapproved mismatch remains in the inventory. The four-node route, segmented tabs, individually framed hostname pills, and Add/Remove placement in the applied state preserve the concept's structure.

## Evidence and scope

- Binding source: authored Concept B Domains, light and dark, unresized 468×406 CSS px at DPR 2. No separate pending frame exists; the pending pictures are judged on inherited layout and their visible state changes, not against a fabricated pending reference.
- Actual viewport: 640×560 CSS px at DPR 2, offscreen production WebKit with synthetic IPC, in light and dark. Executable inputs: `9028dca921`; the dispatch states that these inputs are unchanged at final report anchor `e87c811578`, which supersedes docs-only anchor `1784f8d722`. This is supplied provenance, not a source or revision audit.
- Listed departures count as `same`: wider fixed Settings, no native chrome in the offscreen images, actual English tabs, title `Social Tunnel` when native chrome is present, login control in General, synthetic data, inline form/list feedback, opaque light/dark fallback. The corrected Round 1 brief also supplies inherited approvals from `domain-management/uiux.md` by reference to `tray-app/uiux.md` lines 12–14, 28, and 31: omit Home IP, keep the existing centered summary, place the sole `Check Again` at the end of Status rather than in the route strip or Domains, and set hostnames in monospace. This corrects the comparison inputs at the same anchor; no images or implementation inputs changed. The reference frames individual pills, not the aggregate list.
- Judged only these six PNGs. No source, builder handoff, new captures, or runtime interaction. Native title/chrome, AppKit vibrancy, clickability, focus behavior, and the live pending-to-applied transition are not established by static captures. The paired states show the expected before/after content, not a live sequence.

| Screen | Compared with | Verdict | Finding |
| --- | --- | --- | --- |
| `/tmp/st-domain-selection.ef65ghdk/captures/domains-applied-light.png` | `/private/tmp/st-domains-reference.vWp7H5xV/reference-light.png` | matches | Four observed differences accounted for by the inherited contract. |
| `/tmp/st-domain-selection.ef65ghdk/captures/domains-applied-dark.png` | `/private/tmp/st-domains-reference.vWp7H5xV/reference-dark.png` | matches | Four observed differences accounted for by the inherited contract. |
| `/tmp/st-domain-selection.ef65ghdk/captures/domains-pending-light.png` | `/private/tmp/st-domains-reference.vWp7H5xV/reference-light.png` (inherited structure only) | matches | Same approved differences; pending feedback stays inside Domains. |
| `/tmp/st-domain-selection.ef65ghdk/captures/domains-pending-dark.png` | `/private/tmp/st-domains-reference.vWp7H5xV/reference-dark.png` (inherited structure only) | matches | Same approved differences; pending feedback stays inside Domains. |

### `/tmp/st-domain-selection.ef65ghdk/captures/domains-applied-light.png`

| Element | Result | Picture draws |
| --- | --- | --- |
| Window extent and outer frame | same | Approved larger, rectangular offscreen viewport instead of the concept's smaller rounded window. |
| Red, yellow and green window controls | same | None; approved offscreen chrome exclusion. |
| Centered `social-tunnel` title | same | No title bar in the capture; approved production title is `Social Tunnel`, not visible here. |
| Light backdrop, decorative upper disc and lower color shapes | same | Approved uniform pale opaque surface; no wallpaper treatment. |
| Vertical order: route strip, navigation, Domains | same | Same stack, with more empty space below at the approved viewport. |
| Route node 1: `This Mac` | same | First label. |
| Route node 1: green circle, white check, `OK` | same | Visible in that order on the node. |
| Route node 2: `Server` | same | Second label. |
| Route node 2: green circle, white check, `OK` | same | Visible in that order on the node. |
| Route node 3: `Tunnel port` | same | Third label. |
| Route node 3: green circle, white check, `OK` | same | Visible in that order on the node. |
| Route node 4: `Domains` | same | Fourth label. |
| Route node 4: green circle, white check, `OK` | same | Visible in that order on the node. |
| Connectors 1–2, 2–3, 3–4 | same | Three green spans; longer at the wider viewport. |
| Summary copy: `All checks OK. Home IP 203.0.113.42` | same | `All checks OK.` only; Home IP intentionally omitted by the inherited contract. |
| Summary/action row layout | same | A single centered status line replaces left status with a right-side action; this preserves the existing strip under the inherited contract. |
| Right-side `Check Again` button | same | Absent from the strip, as approved; the Status-only placement is not visible in this Domains picture. |
| Full-width rule below the route strip | same | Thin horizontal rule above tabs. |
| Centered rounded segmented track | same | Light-gray track with a light raised selected segment. |
| `Domains` tab and selected mark | same | Selected white rounded segment; third slot in the approved tab set. |
| `Server` tab | same | Unselected, second slot. |
| `Logs` tab | same | Absent under approved current tab set. |
| `Status` tab | same | Unselected, first slot; approved. |
| `General` tab | same | Unselected, fourth slot; approved. |
| `Add domain` label | same | Left-aligned above the field. |
| Hostname input frame and `example.com` placeholder | same | Wide rounded field, light fill, same placeholder, with blue focus outline in this state. |
| `Add` button | same | Rounded adjacent right-hand button; empty-input disabled styling rather than the concept's raised face. |
| Field/button alignment and form-to-list order | same | Input and Add on one line above the pills. |
| Inline input helper | same | Approved `Public hostname only, not a URL.` below the field. |
| Hostname collection and pill borders | same | Outlined round pills below input helper; wider viewport and four fixture entries fit one row instead of 3+2. |
| `instagram.com` and trailing `×` | same | Synthetic `example.com`, trailing `×` retained. |
| `facebook.com` and trailing `×` | same | Synthetic `mozilla.org`, trailing `×` retained. |
| `threads.net` and trailing `×` | same | Synthetic `wikipedia.org`, trailing `×` retained. |
| `linkedin.com` and trailing `×` | same | Synthetic `wipo.int`, trailing `×` retained. |
| `tiktok.com` and trailing `×` | same | No fifth synthetic item; four visible items each retain `×`. |
| Pill-label drawing | same | Fixed-width hostname glyphs replace the concept's proportional sans-serif labels, as approved. |
| `Saved on this Mac and on the server together.` below the list | same | Approved `Applied to new connections in the enrolled browser.` in the same feedback slot. |
| Footer divider, purple checked box and `Start at login` label | same | Footer, rule, mark and label omitted; login control moved to General by approval. |

### `/tmp/st-domain-selection.ef65ghdk/captures/domains-applied-dark.png`

| Element | Result | Picture draws |
| --- | --- | --- |
| Window extent and outer frame | same | Approved larger, rectangular offscreen viewport instead of the concept's smaller rounded window. |
| Red, yellow and green window controls | same | None; approved offscreen chrome exclusion. |
| Centered `social-tunnel` title | same | No title bar in the capture; approved production title is `Social Tunnel`, not visible here. |
| Dark backdrop, decorative upper disc and lower color shapes | same | Approved charcoal opaque surface without indigo wallpaper treatment; controls and text also switch to dark theme. |
| Vertical order: route strip, navigation, Domains | same | Same stack, with more empty space below at the approved viewport. |
| Route node 1: `This Mac` | same | First label. |
| Route node 1: green circle, dark check, `OK` | same | Visible in that order on the node. |
| Route node 2: `Server` | same | Second label. |
| Route node 2: green circle, dark check, `OK` | same | Visible in that order on the node. |
| Route node 3: `Tunnel port` | same | Third label. |
| Route node 3: green circle, dark check, `OK` | same | Visible in that order on the node. |
| Route node 4: `Domains` | same | Fourth label. |
| Route node 4: green circle, dark check, `OK` | same | Visible in that order on the node. |
| Connectors 1–2, 2–3, 3–4 | same | Three green spans; longer at the wider viewport. |
| Summary copy: `All checks OK. Home IP 203.0.113.42` | same | `All checks OK.` only; Home IP intentionally omitted by the inherited contract. |
| Summary/action row layout | same | A single centered status line replaces left status with a right-side action; this preserves the existing strip under the inherited contract. |
| Right-side `Check Again` button | same | Absent from the strip, as approved; the Status-only placement is not visible in this Domains picture. |
| Full-width rule below the route strip | same | Thin horizontal rule above tabs. |
| Centered rounded segmented track | same | Near-black track with a gray selected segment. |
| `Domains` tab and selected mark | same | Selected lighter rounded segment; third slot in the approved tab set. |
| `Server` tab | same | Unselected, second slot. |
| `Logs` tab | same | Absent under approved current tab set. |
| `Status` tab | same | Unselected, first slot; approved. |
| `General` tab | same | Unselected, fourth slot; approved. |
| `Add domain` label | same | Left-aligned above the field. |
| Hostname input frame and `example.com` placeholder | same | Wide rounded dark field, same placeholder, with blue focus outline in this state. |
| `Add` button | same | Rounded adjacent right-hand button; empty-input disabled styling rather than the concept's brighter face. |
| Field/button alignment and form-to-list order | same | Input and Add on one line above the pills. |
| Inline input helper | same | Approved `Public hostname only, not a URL.` below the field. |
| Hostname collection and pill borders | same | Outlined dark pills below input helper; wider viewport and four fixture entries fit one row instead of 3+2. |
| `instagram.com` and trailing `×` | same | Synthetic `example.com`, trailing `×` retained. |
| `facebook.com` and trailing `×` | same | Synthetic `mozilla.org`, trailing `×` retained. |
| `threads.net` and trailing `×` | same | Synthetic `wikipedia.org`, trailing `×` retained. |
| `linkedin.com` and trailing `×` | same | Synthetic `wipo.int`, trailing `×` retained. |
| `tiktok.com` and trailing `×` | same | No fifth synthetic item; four visible items each retain `×`. |
| Pill-label drawing | same | Fixed-width hostname glyphs replace the concept's proportional sans-serif labels, as approved. |
| `Saved on this Mac and on the server together.` below the list | same | Approved `Applied to new connections in the enrolled browser.` in the same feedback slot. |
| Footer divider, purple checked box and `Start at login` label | same | Footer, rule, mark and label omitted; login control moved to General by approval. |

### `/tmp/st-domain-selection.ef65ghdk/captures/domains-pending-light.png`

| Element | Result | Picture draws |
| --- | --- | --- |
| Window extent and outer frame | same | Approved larger, rectangular offscreen viewport instead of the concept's smaller rounded window. |
| Red, yellow and green window controls | same | None; approved offscreen chrome exclusion. |
| Centered `social-tunnel` title | same | No title bar in the capture; approved production title is `Social Tunnel`, not visible here. |
| Light backdrop, decorative upper disc and lower color shapes | same | Approved uniform pale opaque surface; no wallpaper treatment. |
| Vertical order: route strip, navigation, Domains | same | Same stack; pending UI adds no separate region outside Domains. |
| Route node 1: `This Mac` | same | First label. |
| Route node 1: green circle, white check, `OK` | same | Visible in that order on the node. |
| Route node 2: `Server` | same | Second label. |
| Route node 2: green circle, white check, `OK` | same | Visible in that order on the node. |
| Route node 3: `Tunnel port` | same | Third label. |
| Route node 3: green circle, white check, `OK` | same | Visible in that order on the node. |
| Route node 4: `Domains` | same | Fourth label. |
| Route node 4: green circle, white check, `OK` | same | Inherited route check mark; pending change reported separately in Domains. |
| Connectors 1–2, 2–3, 3–4 | same | Three green spans; longer at the wider viewport. |
| Summary copy: `All checks OK. Home IP 203.0.113.42` | same | `All checks OK.` only; Home IP intentionally omitted by the inherited contract. |
| Summary/action row layout | same | A single centered status line replaces left status with a right-side action; this preserves the existing strip under the inherited contract. |
| Right-side `Check Again` button | same | Absent from the strip, as approved; Status-only placement is not visible. `Retry` is in Domains, not a route-check control. |
| Full-width rule below the route strip | same | Thin horizontal rule above tabs. |
| Centered rounded segmented track | same | Light-gray track with a light raised selected segment. |
| `Domains` tab and selected mark | same | Selected white rounded segment; third slot in the approved tab set. |
| `Server` tab | same | Unselected, second slot. |
| `Logs` tab | same | Absent under approved current tab set. |
| `Status` tab | same | Unselected, first slot; approved. |
| `General` tab | same | Unselected, fourth slot; approved. |
| `Add domain` label | same | Left-aligned above the field. |
| Hostname input and field frame | same | Wide rounded light field with blue focus outline; pending synthetic `wipo.int` remains visible. |
| `Add` button | same | Adjacent, rounded, visually disabled while pending. |
| Field/button alignment and form-to-list order | same | Input and Add on one line above helper and pills. |
| Inline input helper | same | Approved `Public hostname only, not a URL.` below the field. |
| List-state heading | same | Inline `Last verified domains` distinguishes verified entries from the staged addition. |
| Hostname collection and pill borders | same | Three rounded bordered pills in one row at the wider viewport. |
| First hostname and remove mark | same | `example.com`; no `×` in the pending readout. Applied state shows `×`. |
| Second hostname and remove mark | same | `mozilla.org`; no `×` in the pending readout. Applied state shows `×`. |
| Third hostname and remove mark | same | `wikipedia.org`; no `×` in the pending readout. Applied state shows `×`. |
| Staged hostname and remove mark | same | `wipo.int` is absent from the verified list and has no remove mark here; shown as a pill with `×` in Applied. |
| Fifth reference hostname and remove mark | same | No fifth item in the synthetic roster. |
| Pill-label drawing | same | Fixed-width hostname glyphs replace the concept's proportional sans-serif labels, as approved. |
| Pending verification sentence | same | `Waiting for the tunnel and enrolled browser to confirm the change.` takes the feedback slot below the list. |
| Pending operation sentence | same | `Adding wipo.int.` on the next line, not in the verified list. |
| Direct-routing warning | same | `Until applied, this domain may still go directly from the server.` below the operation. |
| `Retry` control | same | Rounded button below the warning, inside Domains. |
| Success sentence under the list | same | No `Applied` sentence while pending. The matched Applied picture shows the new pill and replaces pending feedback. |
| Footer divider, purple checked box and `Start at login` label | same | Footer, rule, mark and label omitted; login control moved to General by approval. |

### `/tmp/st-domain-selection.ef65ghdk/captures/domains-pending-dark.png`

| Element | Result | Picture draws |
| --- | --- | --- |
| Window extent and outer frame | same | Approved larger, rectangular offscreen viewport instead of the concept's smaller rounded window. |
| Red, yellow and green window controls | same | None; approved offscreen chrome exclusion. |
| Centered `social-tunnel` title | same | No title bar in the capture; approved production title is `Social Tunnel`, not visible here. |
| Dark backdrop, decorative upper disc and lower color shapes | same | Approved charcoal opaque surface without indigo wallpaper treatment; controls and text also switch to dark theme. |
| Vertical order: route strip, navigation, Domains | same | Same stack; pending UI adds no separate region outside Domains. |
| Route node 1: `This Mac` | same | First label. |
| Route node 1: green circle, dark check, `OK` | same | Visible in that order on the node. |
| Route node 2: `Server` | same | Second label. |
| Route node 2: green circle, dark check, `OK` | same | Visible in that order on the node. |
| Route node 3: `Tunnel port` | same | Third label. |
| Route node 3: green circle, dark check, `OK` | same | Visible in that order on the node. |
| Route node 4: `Domains` | same | Fourth label. |
| Route node 4: green circle, dark check, `OK` | same | Inherited route check mark; pending change reported separately in Domains. |
| Connectors 1–2, 2–3, 3–4 | same | Three green spans; longer at the wider viewport. |
| Summary copy: `All checks OK. Home IP 203.0.113.42` | same | `All checks OK.` only; Home IP intentionally omitted by the inherited contract. |
| Summary/action row layout | same | A single centered status line replaces left status with a right-side action; this preserves the existing strip under the inherited contract. |
| Right-side `Check Again` button | same | Absent from the strip, as approved; Status-only placement is not visible. `Retry` is in Domains, not a route-check control. |
| Full-width rule below the route strip | same | Thin horizontal rule above tabs. |
| Centered rounded segmented track | same | Near-black track with a gray selected segment. |
| `Domains` tab and selected mark | same | Selected lighter rounded segment; third slot in the approved tab set. |
| `Server` tab | same | Unselected, second slot. |
| `Logs` tab | same | Absent under approved current tab set. |
| `Status` tab | same | Unselected, first slot; approved. |
| `General` tab | same | Unselected, fourth slot; approved. |
| `Add domain` label | same | Left-aligned above the field. |
| Hostname input and field frame | same | Wide rounded near-black field with blue focus outline; pending synthetic `wipo.int` remains visible. |
| `Add` button | same | Adjacent, rounded, visually disabled while pending. |
| Field/button alignment and form-to-list order | same | Input and Add on one line above helper and pills. |
| Inline input helper | same | Approved `Public hostname only, not a URL.` below the field. |
| List-state heading | same | Inline `Last verified domains` distinguishes verified entries from the staged addition. |
| Hostname collection and pill borders | same | Three rounded dark bordered pills in one row at the wider viewport. |
| First hostname and remove mark | same | `example.com`; no `×` in the pending readout. Applied state shows `×`. |
| Second hostname and remove mark | same | `mozilla.org`; no `×` in the pending readout. Applied state shows `×`. |
| Third hostname and remove mark | same | `wikipedia.org`; no `×` in the pending readout. Applied state shows `×`. |
| Staged hostname and remove mark | same | `wipo.int` is absent from the verified list and has no remove mark here; shown as a pill with `×` in Applied. |
| Fifth reference hostname and remove mark | same | No fifth item in the synthetic roster. |
| Pill-label drawing | same | Fixed-width hostname glyphs replace the concept's proportional sans-serif labels, as approved. |
| Pending verification sentence | same | `Waiting for the tunnel and enrolled browser to confirm the change.` takes the feedback slot below the list. |
| Pending operation sentence | same | `Adding wipo.int.` on the next line, not in the verified list. |
| Direct-routing warning | same | `Until applied, this domain may still go directly from the server.` below the operation. |
| `Retry` control | same | Rounded button below the warning, inside Domains. |
| Success sentence under the list | same | No `Applied` sentence while pending. The matched Applied picture shows the new pill and replaces pending feedback. |
| Footer divider, purple checked box and `Start at login` label | same | Footer, rule, mark and label omitted; login control moved to General by approval. |
