# Managed Domains UI change map

## Reference

- Approved source: `docs/design/concept-b/index.html#win-settings-domains` (the route over Settings tabs, editable list and add field), canonical geometry/material/typography from [tray-app/uiux.md](../tray-app/uiux.md), with 640×560 pt native Settings.
- Only Domains and its derived native status summaries change. Existing Settings tabs, IPC origin restrictions, scroll behavior, route strip and visual tokens remain intact. Reuse field/list/button primitives. No new window, footer, webview or permission outside Settings.
- Capture paired Domains views at the same 640×560 pt scale in light/dark, over the same synthetic input states; runtime native smoke is isolated. The reference's start-at-login footer is not added; that setting stays in General.

## Screens

| State | Visible structure and action |
| --- | --- |
| Not enrolled / unsupported | Existing configured-list readout qualified as unverified; `Automatic domain updates aren't set up.` No active Add/Remove affordance; no write. |
| Loading | Keep last known rows visible as last verified; neutral loading indicator; no claim of matching live routes. |
| Ready, populated | Existing route strip and tabs, `Add domain` field + `Add`, rows with named `Remove <domain>` controls. Bare public hostname hint, not URL. |
| Ready, empty | `No domains use the tunnel.` — verified zero, not missing/unavailable. Add remains available. |
| Validation / duplicate / conflict | Inline specific error linked to field, input preserved, no optimistic mutation. On conflict refresh without discarding the user's input. |
| Confirm remove | Inline confirmation, text names the domain and that it may use the server's direct route. If another selected entry covers it, say it will remain routed. Cancel is non-mutating. |
| Pending | Show requested change alongside the previously verified list and suppress conflicting actions. For adds, `Until applied, this domain may still go directly from the server.` |
| Activation unknown / unavailable | `Couldn't confirm the new routing.` No claim of applied/rolled back. Offer `Retry` for the same operation when possible, not an implicit new edit. |
| Recovery required | `Domain changes are paused. The server administrator needs to reconcile the policy.` Keep previous proof distinct from current routing, disable Add/Remove/Retry until the new verified baseline. |
| Applied | Show the revised list and `Applied to new connections in the enrolled browser.` No claim about browser connections already open. |

Settings state, native `Through home` and paused summaries use the same evidenced revision. An unverified configured list is never called active or presented with a definitive routed count. Keep existing opaque fallback/transparency behavior and permit real overflow; wrap long hostnames. Keyboard: submit Add with Enter, announce status and inline errors, keep error and remove-confirm flows usable without a pointer.
