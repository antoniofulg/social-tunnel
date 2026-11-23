# Managed domains — threat model

Scope: automatic add/remove from the tray, local activation and dedicated Linux Chrome policy publication. Design basis and rollout boundary: [plan.md](plan.md). Existing forwarding threat model stays in force; no deployment is authorized and no current VPS state was assumed. Implementation controls below are requirements, not claims of completed protection.

## Trust boundaries and assets

| Boundary | Untrusted side | Protected asset |
| --- | --- | --- |
| Settings IPC → CLI | Webview-supplied hostname, operation and expected revision | Config integrity, edit authority, key material and command surface |
| Mac → VPS edit operation | Any holder of the distinct edit credential, including a compromised Mac | VPS shell, forwarding, privileged filesystem and other Chrome policies |
| Writer → managed policy | Malformed requests, concurrent revisions and abrupt interruption | Previous valid PAC, fixed proxy endpoint, selected-domain routing |
| PAC publication → browser context | Stale policy, new browser generation, missing or unrelated observer | Evidence that the current browser actually routes the requested revision |
| Snapshot → live CONNECT | New, removed or still-covered hostname; concurrent DNS/relay | Home network, public-IP/443 guard and active-list integrity |
| Live proxy → publisher gate | Edit key, stale connection, forged or unrelated receipt | Authority to publish one validated matching revision only after the local revocation barrier |

The Mac operator and the VPS administrator are separate principals even when one person fills both roles. Assume theft of the edit credential permits typed requests. Do not claim this stops other abuse of an already compromised Mac or protects a compromised VPS root. Never copy admin or tunnel credentials into the edit operation. A VPS process able to impersonate the enrolled browser observer or bind the proxy listener is a distinct server trust issue; production enrollment must establish control of both.

## Abuse cases and required proof

| ID | Abuse and priority | Control | Negative proof before delivery |
| --- | --- | --- | --- |
| SEC-001 | Stolen token gets shell, forwards, unrelated files, or forges commit authority. High. | Distinct edit and receipt roles, host pin, immutable scope and epoch, fixed operations and fixed policy destination. | Disposable OpenSSH refuses shell, arbitrary command, TTY, SFTP, local/reverse/agent/X11 forwarding and wrong key per role; publisher rejects absent/forged/wrong-epoch/scope/operation/digest/generation receipts even for an authenticated editor. Disable fences a connection already authenticated and pending work. |
| SEC-002 | Host data escapes into PAC JavaScript, changes the proxy endpoint, or adds a shared namespace or LAN target. High. | Both ends validate bounded canonical hostnames and public/private suffix rules; fixed template and proxy address; unchanged CONNECT public-IP and port guard. | Reject malformed/oversize, URL/IP/wildcard, public/shared suffix and stale request; no write or dial. Added name resolving to private/on-link address remains denied. |
| SEC-003 | Lost response, conflict, partial write, key revocation or reload exposes traffic or falsely claims removal. High. | One durable owner; immutable intent, atomic publication, fail-closed forward reconciliation with a fresh administrator epoch; home revocation barrier. | Crash at each mutation barrier, replay, restart/lost reply, invalid snapshot, pending dial and established relay. Revoke before either side writes: terminal cancelled with no effects. Revoke after local apply, publication or unknown effect: fence prior authority and normal writes, prove administrator-only higher-revision reconciliation with no restored access, then release the claim. |
| SEC-004 | File existence, old observer, browser restart or unrelated profile certifies activation. High. | Protected policy/runner ownership and matching baseline; mandatory bytes/digest, current context and positive/negative fresh route witnesses independent from the edit identity. | Disposable Linux Chrome distinguishes direct/proxied sinks and mandatory failure; absent/down proxy, missing/wrong/sibling/restarted context or conflicting policy never proves Applied. Scope to new browser routing decisions. |

Residual: the edit identity can request bounded disruption or rerouting, not directly commit a policy or forge runtime evidence. Full Mac compromise may also expose the separate proxy receipt identity and existing tunnel authority; none grants VPS shell, arbitrary files or administrative control. Pending additions may follow the pre-existing route; already-open browser connections may survive revision changes, so the activation claim covers fresh decisions only. Strict zero-direct from submission would require fencing browser traffic. Exclusive policy and loopback listener ownership, protected context enrollment, matching upgraded-proxy baseline and real deployment are separate prerequisites.
