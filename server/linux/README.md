# Protected Managed Domains on Linux

One dedicated Debian/Linux guest, one Google Chrome installation and regular `Default` profile, one OpenSSH authority and existing reverse forward. Not a remote installer or an adoption path for a shared Chrome. The code does not modify OpenSSH, load BPF, start a competing home `run`, install login items, rotate keys or remove PAC files. Run the following provisioning and positive tests only in a separately authorized guest. The local Kiri proof is negative, not authorization to use this package on a real VPS.

## Fixed artifact and provisioner boundary

Build the three binaries with `sh server/linux/build-package.sh bun-linux-arm64 <empty-output-dir>` (or `bun-linux-x64`). The root provisioner installs them in `/usr/local/bin` as root-owned, mode 0755, without setuid or file capabilities. Provision `/etc/social-tunnel-domains` and its `keys` directory (0755 so OpenSSH can read public keys under the role UID), `/var/lib/social-tunnel-domains` (0755), its `journal` (0700), `/run/social-tunnel-domains` (0755), `admin` within it (0700), and one directory under `/run/social-tunnel-domains/<editor-or-receipt-user>` per role (root owned, unique role GID, 0710). Recreate the run directories on each boot before starting the supplied units. `/var/lib/social-tunnel-domains/chrome` is owned by the dedicated unprivileged Chrome account and is 0700. Put the root-private 0700 `.social-tunnel-staging` and root-owned 0755 `managed` directories under `/etc/opt/chrome/policies` on the same mount for atomic rename. Use no symlinks or other writers. The only accepted Chrome managed file is `social-tunnel.json`; the recommended policy directory must be absent or empty. Audit that the installation has no cloud/extension policy source or shared renderer/profile. Do not delete another policy to make these checks pass.

Root-only `/etc/social-tunnel-domains/enrollment.json` (0600) names no arbitrary paths or commands. Shape (types, not shell input):

```text
{
  version: 1, enrollment: tag, proxyPort: uint16, sshPort: uint16,
  chromeSha256: lowercase_sha256, sshdSha256: lowercase_sha256,
  profile: Account, witness: Account, forward: Account, probe: Account,
  epochs: [{epoch: uint, generation: tag, editor: Account, receipt: Account}, ...],
  baseline: {revision: uint, domains: [canonical_public_hostname, ...]}
}
Account = { user: local_name, uid: unprivileged_numeric_id, gid: unprivileged_numeric_id }
```

Use dedicated local accounts and groups with no supplementary membership or shared user IDs. OpenSSH accounts have an empty root-owned `/var/empty` home and `/bin/sh` only for the fixed `ForceCommand`; prohibit password, standalone shell and other sessions. Supply one separately issued restricted `ssh-ed25519` public key at `/etc/social-tunnel-domains/keys/<user>`, following the rules below. Do not put any home private key in the Linux enrollment. Pre-stage up to eight consecutive epochs with distinct IDs and roles; modifying this bootstrap manifest in place is refused. Match each UID and GID to the actual files and local accounts, and independently enforce that no other service has use of any of these identities. Provision system accounts/files outside the product; supervise the service under the supplied unit, not a general root shell or agent startup.

Configure dedicated `/etc/social-tunnel-domains/sshd.conf` (0600). Only the options below, an optional `ListenAddress` on the enrolled SSH port, and the per-role `Match User` options are supported. No includes, subsystems, external key or CA configuration, source-dependent matches, or accepted environments. Use these global settings (`<...>` are provisioner inputs, never literal values):

```text
Port <sshPort>
PidFile none
HostKey <dedicated root-owned OpenSSH host key>
AuthorizedKeysFile /etc/social-tunnel-domains/keys/%u
AllowUsers <forward> <editor-at-epoch1> <receipt-at-epoch1> ...
AuthenticationMethods publickey
PubkeyAuthentication yes
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
UsePAM no
PermitTTY no
X11Forwarding no
AllowAgentForwarding no
AllowStreamLocalForwarding no
PermitUserEnvironment no
PermitUserRC no
GatewayPorts no
PermitOpen none
PermitListen none
AllowTcpForwarding no
MaxSessions 1
StrictModes yes
```

For `<forward>` only, `Match User <forward>` sets `MaxSessions 0`, `AllowTcpForwarding remote`, `PermitListen 127.0.0.1:<proxyPort>`, and `ForceCommand /bin/false`. That key must start with `restrict,port-forwarding,permitlisten="127.0.0.1:<proxyPort>" `. Each editor and receipt `Match User <role>` sets `DisableForwarding yes` and `ForceCommand /usr/local/bin/st-domains-command /run/social-tunnel-domains/<role>/authority.sock`. Those keys start with `restrict `. Set all public key files to root:root 0644; keep the manifest, attestation and sshd configuration 0600. Network admission/SSH listen addresses are the operator's existing boundary; the default service does not install a firewall or expose an admin or CDP port.

Use the supplied `social-tunnel-domains-sshd.service`, not a direct `sshd` launch, reload, socket unit, or unit override. Its root-only `serve-sshd` entrypoint accepts no arguments. It runs `sshd -t` and per-role effective `sshd -T` against a private snapshot before launching that same snapshot. It also requires protected accounts, restricted key files and the live bind guard in the attested cgroup before launch. Provision OpenSSH's package-required privilege separation directory (for Debian, `/run/sshd`).

The launcher sets `ClientAliveInterval=15` and `ClientAliveCountMax=3` on the dedicated SSH daemon. OpenSSH closes a connection that stops responding and releases its reverse-forward listener so the home client can reconnect. The values also apply during configuration validation; existing configurations and the system SSH daemon are unchanged.

The launcher and its exact child inherit the attested network namespace; the unit denies namespace changes and grants neither `CAP_SYS_PTRACE` nor `CAP_SYS_ADMIN`. Its private `/run/social-tunnel-domains/sshd` launch record binds the boot guard, manifest, configuration and PID namespace to the live parent and child start stamps. The Chrome supervisor checks that record, the two process relationships, and the listener UID/inode without reading the sshd master's privileged `/proc` links. A missing, mismatched or stale record cannot make the authority ready. The launcher checks the pinned inputs and guard while running. A failed check withdraws the record and stops the owned daemon; systemd cleans up its remaining cgroup processes and stops the dependent Chrome supervisor. Stop both units before changing protected inputs; do not reload the daemon in place.

## Enforce port exclusion before staging

Use `domain-bind-guard.bpf.c` or the byte-reviewed equivalent. Build it for the exact forward port, authenticated forward UID and actual dedicated sshd cgroup kernel ID (`ST_PORT`, `ST_UID`, `ST_CGROUP`, all literals). The trusted host provisioner attaches one IPv4 and one IPv6 hook at the **initial cgroup-v2 root**, with no override flags. The IPv4 hook permits exactly one privileged trust combination at that port: TCP bind on `127.0.0.1` by the dedicated forward UID in the exact dedicated sshd cgroup. It rejects wildcard/other address binds; the IPv6 hook denies that TCP port, including dual-stack wildcard. Choose the enrolled port outside the guest's ephemeral range so an implicit port-zero bind cannot capture it. No other profiles, daemons, cgroup delegation into that leaf, inherited sockets, packet redirects, network policy writers or privileged users are in the supported trust boundary. Confirm the actual service and Chrome see the same network namespace and the role child remains in the dedicated cgroup without delegation. Stop both service and browser before changing hooks, cgroup, port, SSH configuration or boot identity.

The root provisioner checks the translated kernel programs against the approved literals (including cgroup ID, UID, address and byte order), verifies effective attachment on sshd and an unrelated sibling, rules out pre-existing or inherited listeners, then invokes `st-domains-supervisor attest-bind <absolute-cgroup-relative-path> <reviewed-ipv4-tag> <reviewed-ipv6-tag>`. This command queries actual root `bpftool -j cgroup show` and program information, requires the initial cgroup namespace, exact reviewed tags, non-overridable attachments and no mutable program maps, and runs real binds under the separate unprivileged probe UID before writing the root-only boot/namespace-bound attestation. For this command only, use the provisioner's already authorized host BPF administration boundary. Do not grant BPF or network-admin capabilities to the running supervisor. The service validates that attestation and repeats the unprivileged IPv4/IPv6 checks. `EADDRINUSE` is **not** evidence: an unrelated process must be denied even during a genuine forward outage. Process/UID/inode observation tracks which live forward the browser may use only after this independent facility is verified. A reboot, namespace/hook/config change or failed guard probe requires local review; do not make a replacement attachment while Chrome is active.

The cgroup ID is the live kernel leaf identity, not its name. If systemd removes or recreates the leaf on stop or reboot, the old attestation will not admit the next launch. Reprovision and attest the exact leaf before restarting.

`st-domains-reprovision` automates that cycle. Install it in `/usr/local/sbin` and a guard template in `/usr/local/lib/social-tunnel-domains/guard-template.o`, compiled from `domain-bind-guard.bpf.c` with the enrolled port and forward UID and the sentinel `ST_CGROUP=0x7ead1eafULL`. The script stops both units, recreates the leaf, patches the sentinel with the new leaf inode, checks the translated literals, attaches both replacements before detaching the old hooks, re-pins Chrome and OpenSSH (`st-domains-supervisor repin`), attests and starts the supervisor. `repin` changes only the two executable digests and keeps every account, port and epoch bound.

Enable `social-tunnel-domains-provision.service` for boot; leave the dedicated SSH and supervisor units disabled. For a manual restart, run `systemctl start social-tunnel-domains-provision.service`, not `systemctl restart social-tunnel-domains-sshd.service`. Do not order the provisioning unit `Before=` the units its script starts: the script waits for them to start after attestation.

Install `social-tunnel-domains-recover.service` with the other units; do not enable it. The dedicated SSH unit starts it on failure. It requests one provisioning run while that SSH unit is failed, with at most two recovery starts in ten minutes. Notifications that arrive during an active recovery are coalesced, not queued for another attempt. A clean stop does not trigger recovery, but a stop that times out or an already queued recovery can. For a maintenance stop, run as root:

```sh
touch /run/social-tunnel-domains-provision-inhibited &&
  systemctl --job-mode=replace-irreversibly stop social-tunnel-domains-recover.service social-tunnel-domains-provision.service &&
  systemctl stop social-tunnel-domains.service social-tunnel-domains-sshd.service
```

To resume, remove `/run/social-tunnel-domains-provision-inhibited` and start `social-tunnel-domains-provision.service`. The flag lasts until reboot and also blocks provisioning requested by package hooks. If recovery is exhausted or refused, inspect the SSH, recovery and provisioning journals before starting provisioning manually; do not restart SSH directly.

On APT hosts, install `80-social-tunnel-domains.apt.conf` in `/etc/apt/apt.conf.d` to start the provisioning unit when Chrome or OpenSSH changes. Where `needrestart` is installed, install `needrestart/social-tunnel-domains-sshd.service` as `/etc/needrestart/restart.d/social-tunnel-domains-sshd.service` (root-owned, mode `0755`). It replaces the direct SSH restart that can follow shared-library updates even when the Chrome and OpenSSH digests are unchanged.

Do not set `User=root` in the units. On systemd 259 (Ubuntu 26.04) it removed `CAP_SETUID` from the service's permitted set, so the unprivileged bind probe failed with `setresuid failed: Operation not permitted`.

Attach the root hooks with the `multi` flag. Without a flag, a descendant cgroup that has its own `inet4_bind`/`inet6_bind` programs (for example systemd `SocketBindAllow=`/`SocketBindDeny=` slices, as on the agentes VPS per-agent slices) runs only its own programs and escapes the guard. In `multi` mode the kernel runs every program on the path and any deny refuses the bind, so descendant policy can only narrow it. `attest-bind` accepts a root attachment with no flag or `multi`.

## Staging and root-local lifecycle

For an existing agentes-runner install, a Linux administrator can run `st-domains-supervisor legacy-preflight` with the Mac's domain array as JSON on stdin. The command recognizes the existing mandatory `agentes-meta-proxy.json` dialect for `127.0.0.1:8888`, verifies the same public hostname set and refuses competing local policy files. It prints the domain count and exact legacy policy SHA-256. It does not start Chrome, touch the policy, or establish activation readiness. Do not proceed to `stage` on the live installation on the strength of this check.

1. `st-domains-supervisor stage` is explicit, refuses existing policy or journal, and writes only the initial mandatory PAC and a one-time bootstrap marker. `serve` (the unit) owns the singleton and launches nonroot Chrome with its sandbox and a private inherited CDP pipe, no debug port. Failure does not remove or rewrite the mandatory policy; replacement requires root investigation rather than automatic provisioning.
2. Start exactly one matching existing/upgraded home `run` after authorized cutover. Initial receipt ingress accepts only the enrolled proxy identity. Root runs `st-domains-supervisor bootstrap`; this can create the durable journal only on a live matching proxy and enrolled Chrome proof, and editor ingress waits for the subsequent independently verified baseline. An attempted/missing or invalid journal does not silently reset the enrollment. `status` is historical journal metadata and live resource ownership, not proof that routing is currently active. Scoped CLI `domains list` uses the authority's bounded current proof.
3. Root-only typed commands traverse the private 0700 directory and Unix socket, never TCP or OpenSSH. `disable <expected-epoch>` retires old ingresses. Revoke old keys under the operator's procedure; monitor/stop only the agreed home process. `prepare <new-epoch>` enables receipt-only ingress of that pre-staged fresh epoch. After the same home owner explicitly rotates/restarts the process, root sends JSON on stdin to `recover`: `{epoch, operationId, expectedRecovery, domains, releaseDirect}`. `expectedRecovery` is the exact retired operation ID in the journal, or `null` only when none exists. This request must match the fresh prepared epoch and contemporaneous authenticated home preimage. `releaseDirect` must explicitly name approved removals from retained policy; `[]` retains guarded selectors. New editor ingress requires fresh paired browser proof of the higher revision. No CLI operation can modify the selection or control browser process outside this contract.
   While the root-local control socket is serving, Disable advances the journal epoch and retires older ingress without reading or writing the PAC. It still requires the exact current epoch of the protected journal. If startup rejects a missing, unreadable, or unrecognized PAC, it never opens that control socket; Disable is not an offline command.
   If a publication was interrupted after the PAC rename, startup recognizes the exact journaled preimage or the matching interrupted postimage, never a third version. Root can fence the old epoch and authorize forward recovery without rolling the PAC back. Authorization records only the intent. If it selects the interrupted postimage, the first activation synchronizes those exact, still-matching bytes before granting the home mutation. Recognition alone does not mark the old intent applied or make edits ready.
4. On stop, close ingress and invalidate leases before reaping owned Chrome, leaving PAC and journal intact. On abrupt service loss, use systemd cgroup cleanup, confirm no owned processes/old authorities survive, and inspect stale socket artifacts under the fixed `/run` directories before restart. Do not unlink a socket used by a live owner. There is no automatic policy rollback, migration of existing Chrome data, or production bootstrap through `doctor`.

The supervisor restarts automatically when the owned forward responds but the Chrome observer has stopped, or when proxy/browser proof has been unavailable for 60 seconds on the same responding forward. The diagnostic response does not authorize traffic. It does not restart for a missing or unresponsive home forward, during an edit or recovery, or for protected configuration failures. The unit waits five seconds before restarting and permits at most two starts per ten minutes. If that limit is reached, inspect `journalctl -u social-tunnel-domains.service` for the reason before resetting the unit's failed state.

## End-to-end monitoring

Install `st-domains-health` in `/usr/local/sbin` (mode `0755`) and install `social-tunnel-domains-health.service` and `.timer` with the other units. Set `ST_PROXY_PORT` to the enrolled loopback proxy port and `ST_PROBE_HOST` to an allowlisted public DNS hostname in `/etc/social-tunnel-domains/health.conf`. Choose a homepage that answers unauthenticated HTTPS `HEAD` with `2xx` or `3xx`. Enable and start the timer. The unprivileged probe runs once a minute, requires HTTP `CONNECT 200` plus a successful HTTPS response, and never tries the probe host directly. It logs whether the proxy did not answer, refused the tunnel, or the origin did not respond successfully. It does not restart services.

For notifications, create a dedicated Better Stack heartbeat with a 1-minute period and a 2-minute grace period. Store only its `https://incidents.betterstack.com/api/v1/heartbeat/…` URL in the root-owned credential `/etc/credstore/social-tunnel-heartbeat.url` (mode `0600`). The service sends a heartbeat only after a successful tunneled probe. Better Stack opens an incident when the pings stop and closes it when they resume. Without that credential, the systemd check and journal still work, but no external alert is sent.

## Proof level

`bun tests/managed-domains-supervisor-proof.ts` compiles the installed-package binary and runs it inside the pinned unprivileged network-none Kiri fixture (no mounts or published ports, two CPUs). It verifies that syntax-valid but out-of-scope role and listener configurations are rejected by the actual launch command with no listeners or launch state. A valid SSH configuration still fails without the bind guard. Other negatives cover missing/invalid attestation, a real unconfined bind, and nonroot admin, before policy/journal/Chrome/role effects. The publisher's C10 test interrupts after rename, reopens around Disable, rejects unrecognized bytes without writes, and requires a fresh receipt for forward recovery.

These are not positive assembly proofs. Kiri denies BPF loading, lacks the Landlock ABI, does not expose the initial cgroup-v2 root to the fixture, and does not run these services under systemd. Do not run Docker privileged, add capabilities, or move the test into an actual host namespace to force success.

On a separately authorized disposable dedicated Linux guest, prove the actual attached hooks and package commands together: unprivileged IPv4, IPv6, wildcard and dual-stack bind attempts fail before/after loss of an actual OpenSSH forward; the permitted role binds only the exact enrolled endpoint; distinct role keys cannot invoke admin or general shell/forwarding; scoped real home `run` + Chrome proves Add, retained route, Remove and selected fresh outage. Walk clean stop, unexpected browser/pipe loss, distinct generations, valid restart, lease expiry, conflict, prior authenticated SSH sessions, no-effect disable and uncertain forward recovery with actual key rotation. Keep mandatory PAC, root journal history and unrelated data unchanged, and report any platform assumption that fails. Production approval, operator rights/rollback access, actual Chrome policy and protected profile ownership, leaf identity and kernel qualification remain separate.
