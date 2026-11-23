# Managed Domains surface contract

## CLI and Settings IPC

The CLI follows existing `--json` and `--config` conventions. The native adapter chooses the CLI executable and config path; the WebView cannot supply either.

| CLI verb | Settings-only IPC | Request |
| --- | --- | --- |
| `domains list` | `get_domains` | `{scope: number}` |
| `domains add <host>` / `domains remove <host>` | `edit_domain` | `{scope: number, operation: "add" | "remove", host: string, expectedRevision: number}`; edit CLI accepts `--expected-revision <uint>` |
| `domains retry <operation-id>` | `retry_domain_edit` | `{scope: number, operationId: string}`; reconcile the existing immutable intent, never replay a new mutation |

The WebView echoes only the opaque scope of the displayed native snapshot. Native rejects superseded scopes, takes the enrollment fingerprint from its private `status --json --tray-scope` result, and supplies it to each `domains` call using `--expected-enrollment`. The sidecar returns `conflict` before journal or SSH effects if the captured config/enrollment changed; equality of revision numbers never confers authority across scope. Standalone unscoped CLI invocations remain supported.

Successful reads return `{ok:true, command:"domains", state, active, pending}`. A revision is `{revision, domains}`; `active` is null when current agreement is unproven, never an overloaded empty list. `pending` is null or `{operationId, operation, host, phase, pendingMayGoDirect}`. States: `setup_required`, `ready`, `pending`, `activation_unknown`, `recovery_required`, `applied`. A successful mutation returns the same envelope; pending is a valid result, not applied. CLI exit 0 indicates a valid response, not necessarily an applied revision. Current agreement is scoped to fresh routing decisions in the enrolled Chrome context. Past `lastProven` is recovery metadata, not an assertion about current state. The tray uses the same active/uncertain source, not the config list.

Failures use `{ok:false, command:"domains", error:{code,message}}`: exit 2 for `invalid_domain`, `duplicate_domain`, `domain_not_found`, `invalid_revision`, `unknown_operation` or `operation_cancelled`; exit 1 for `internal`; exit 10 for `not_ready`, `conflict`, `unavailable` or `recovery_required`. An ambiguous write result returns pending/unknown if the saved operation can be identified, not success-by-timeout and not a fresh retry. All other CLI verbs and their existing shapes stay unchanged except an additive, optional managed-domain state in `status --json`; legacy consumers do not gain edit privileges. No actual host/session/key bytes in errors.

## Provisioned ingress and limits

- No general command service. The separate edit principal can only read its own revision or propose `add`/`remove` with `{version:1, operationId, expectedRevision, host}`. Lowercase bare DNS hostnames, max 253 bytes each, no more than 128 distinct entries per revision. One ASCII/UTF-8 JSON request, max 4 KiB, at most one durable pending operation per enrollment. No requested filesystem path, shell, PAC, port, browser command, or address. Rate and resource limits apply per enrollment, including rejected requests.
- Identical operation ID and intent returns the existing outcome. A reused ID with different intent, stale expected revision, key-epoch mismatch, malformed/oversized data, or wrong scope is rejected without changing policy or local state. Superseded/retired operations can never be replayed to mutate current state.
- Ordinary inspect is read-only. Explicit same-ID reconciliation by the current editor may durably cancel a saved but never admitted intent under the same CAS as proposal admission. No route or policy changes occur. Known admitted IDs return their existing state; a cancelled ID is fenced against late delivery even after bounded history eviction. Only an authenticated terminal reply clears the corresponding local submission record.
- The edit-key holder cannot commit publication itself or supply a trusted acknowledgement. The publisher only accepts the current enrolled live proxy's separately authenticated receipt for the exact enrollment, key epoch, proxy generation, operation ID, revision and canonical list digest. The proxy receipt role cannot propose edits or control Chrome. The trusted Chrome observer is server-side and cannot be steered by any request field. Its current-generation evidence binds the actual mandatory policy/digest and two fresh route witnesses to the pending revision.
- No remote command or network endpoint is exposed through WebView, MCP, or the existing tunnel user. One-time admin enrollment and approval of the actual VPS policy scope and browser ownership are outside this implementation's execution scope.

## Local administrator recovery

- Revocation atomically fences the retired epoch. A proven no-effect operation becomes terminal `cancelled`. With an applied, published or unknown effect, it instead stays `recovery_required` and normal proposals/Retry cannot mutate either side. Old operation ID and outcome remain auditable.
- Only the local VPS administrator can authorize a fresh-epoch forward reconciliation for that enrollment. Recovery keeps the same fixed destination and normal receipt/activation checks; it never rolls back to an older broader allowlist, replays fenced input, or publishes a revision as active without current evidence. A confirmed higher revision marks the old intent `reconciled` and unlocks normal operations. No remote or WebView recovery entrypoint.
- Retain the mandatory PAC for uncertain destinations until the administrator explicitly chooses the final disposition of each affected entry; never turn a previously proxy-only route into `DIRECT` merely by dropping an unknown entry. Authorization for deliberate direct routing does not waive the local-deny and Chrome activation barriers.
