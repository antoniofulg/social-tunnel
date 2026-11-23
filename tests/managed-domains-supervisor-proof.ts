import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Manifest } from "../server/domain-linux-platform";
// Include the installed entrypoint in the normal TypeScript proof as well.
import type {} from "../server/domain-linux-supervisor";

const MANIFEST: Pick<Manifest, "enrollment" | "proxyPort" | "sshPort" | "profile" | "witness" | "forward" | "probe" | "epochs"> = {
  enrollment: "rejection-fixture", proxyPort: 18883, sshPort: 22183,
  profile: { user: "st_chrome", uid: 41001, gid: 41001 },
  witness: { user: "st_witness", uid: 41002, gid: 41002 },
  forward: { user: "st_forward", uid: 41003, gid: 41003 },
  probe: { user: "st_probe", uid: 41004, gid: 41004 },
  epochs: [{ epoch: 1, generation: "proxy-1", editor: { user: "st_editor", uid: 41005, gid: 41005 },
    receipt: { user: "st_receipt", uid: 41006, gid: 41006 } }],
};

const SSH_CONFIG = `Port ${MANIFEST.sshPort}
ListenAddress 127.0.0.1
PidFile none
HostKey /etc/social-tunnel-domains/fixture-host-key
AuthorizedKeysFile /etc/social-tunnel-domains/keys/%u
AllowUsers st_forward st_editor st_receipt
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
Match User st_forward
  MaxSessions 0
  AllowTcpForwarding remote
  PermitListen 127.0.0.1:${MANIFEST.proxyPort}
  ForceCommand /bin/false
Match User st_editor
  DisableForwarding yes
  ForceCommand /usr/local/bin/st-domains-command /run/social-tunnel-domains/st_editor/authority.sock
Match User st_receipt
  DisableForwarding yes
  ForceCommand /usr/local/bin/st-domains-command /run/social-tunnel-domains/st_receipt/authority.sock
`;

function run(file: string, args: string[], capture = false) {
  const r = spawnSync(file, args, { stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, `${file} exited ${r.status ?? r.signal}`);
  return r.stdout?.trim() ?? "";
}

function proof() {
  const image = process.env.ST_DOMAIN_FIXTURE_IMAGE;
  const seccomp = process.env.ST_DOMAIN_FIXTURE_SECCOMP;
  assert(image && seccomp, "provide pinned disposable fixture image and seccomp profile");
  const dockerEnv = ["-u", "DOCKER_HOST", "-u", "DOCKER_CONTEXT", "docker", "--context", "kiri"];
  const docker = (args: string[], capture = false) => run("env", [...dockerEnv, ...args], capture);
  const background = (file: string, args: string[]) => {
    run("load-gate", ["wait"]);
    run("taskpolicy", ["-b", "nice", "-n", "10", file, ...args]);
  };
  const endpoint = docker(["context", "inspect", "kiri", "--format", "{{.Endpoints.docker.Host}}"], true);
  assert(endpoint.startsWith("unix:///") && statSync(endpoint.slice(7)).isSocket());
  const imageId = docker(["image", "inspect", image, "--format", "{{.Id}}"], true);
  assert.match(imageId, /^sha256:[0-9a-f]{64}$/);
  const dir = mkdtempSync(join(tmpdir(), "st-domains-supervisor-"));
  const id = randomUUID();
  const name = `st-domains-supervisor-${id}`;
  let created = false;
  try {
    background("sh", ["server/linux/build-package.sh", "bun-linux-arm64", dir]);
    const script = String.raw`
root=/etc/social-tunnel-domains
state=/var/lib/social-tunnel-domains
profile=$state/chrome
run=/run/social-tunnel-domains
policy=/etc/opt/chrome/policies/managed/social-tunnel.json
bin=/usr/local/bin/st-domains-supervisor
umask 077
mkdir -p "$root" "$state/journal" "$profile" "$run/admin" "$run/sshd" "$run/st_receipt" "$run/st_editor" /etc/opt/chrome/policies/managed /run/sshd
sshd_hash=$(sha256sum /usr/sbin/sshd | cut -d' ' -f1)
printf '{"sshdSha256":"%s",%s' "$sshd_hash" "$(printf '%s' "$ST_REJECTION_MANIFEST" | cut -c2-)" > "$root/enrollment.json"
printf '%s' 'existing mandatory policy sentinel' > "$policy"
expect_failure() {
  label=$1; shift
  if "$@" >/tmp/proof.stdout 2>/tmp/proof.stderr; then echo "$label unexpectedly succeeded" >&2; exit 1; fi
  test ! -s /tmp/proof.stdout
  reason=$(cat /tmp/proof.stderr)
  case "$reason" in *"$label"*) ;; *) echo "unexpected rejection: $reason" >&2; exit 1 ;; esac
  printf 'rejected: %s\n' "$reason"
}
no_ssh_effects() {
  test -z "$(ls -A "$run/sshd")"
  awk -v ports=':(${[MANIFEST.sshPort, MANIFEST.sshPort + 1, MANIFEST.proxyPort].map((port) => port.toString(16).toUpperCase()).join("|")})$' \
    '$4 == "0A" && $2 ~ ports { found=1 } END { exit found }' /proc/net/tcp /proc/net/tcp6
}
ssh-keygen -q -t ed25519 -N '' -f "$root/fixture-host-key"
printf '%s' "$ST_SSH_CONFIG" > "$root/sshd.conf"
/usr/sbin/sshd -t -f "$root/sshd.conf"
expect_failure 'bind exclusion attestation unavailable' "$bin" serve-sshd
no_ssh_effects
# These are accepted by the real syntax check. The unit's entrypoint must reject
# effective role scope and bind scope independently of the absent kernel guard.
printf '%s' "$ST_SSH_ROLE_MISMATCH" > "$root/sshd.conf"
/usr/sbin/sshd -t -f "$root/sshd.conf"
expect_failure 'effective managed SSH restrictions differ' "$bin" serve-sshd
no_ssh_effects
printf '%s' "$ST_SSH_PORT_MISMATCH" > "$root/sshd.conf"
/usr/sbin/sshd -t -f "$root/sshd.conf"
expect_failure 'unexpected dedicated SSH listen port' "$bin" serve-sshd
no_ssh_effects
expect_failure 'use attest-bind' "$bin" serve-sshd -f
no_ssh_effects
printf '%s\n' '[domains C3/C5/C11] compiled SSH unit entrypoint rejected syntactically valid role and listen-port mismatches without a listener or launch state'
expect_failure 'bind exclusion attestation unavailable' "$bin" stage
expect_failure 'bind exclusion attestation unavailable' "$bin" serve
expect_failure 'Linux local root required' /usr/bin/setpriv --reuid=41005 --regid=41005 --clear-groups --no-new-privs -- "$bin" disable 1
# A real unprivileged bind with no enforcing hook must not produce the verifier token.
expect_failure 'kernel did not deny' /usr/bin/setpriv --reuid=41004 --regid=41004 --clear-groups --no-new-privs -- "$bin" bind-probe 18883
# Real provisioner command: a private cgroup root / unavailable BPF tools cannot be an attestation.
expect_failure 'cgroup' "$bin" attest-bind /system.slice/social-tunnel-domains-sshd.service 123456789abcdef0 123456789abcdef1
test ! -e "$root/bind-guard.json"
printf '%s' '{}' > "$root/bind-guard.json"
expect_failure 'bind exclusion attestation absent or invalid' "$bin" stage
expect_failure 'bind exclusion attestation absent or invalid' "$bin" serve
test "$(cat "$policy")" = 'existing mandatory policy sentinel' || { echo 'the mandatory policy changed' >&2; exit 1; }
test -z "$(ls -A "$state/journal")" || { echo 'unexpected journal effects' >&2; ls -la "$state/journal"; exit 1; }
test -z "$(ls -A "$run/admin")" || { echo 'unexpected control effects' >&2; ls -la "$run/admin"; exit 1; }
for untouched in "$profile" "$run/st_receipt" "$run/st_editor"; do
  test -z "$(ls -A "$untouched")" || { echo 'unexpected Chrome or role effects' >&2; exit 1; }
done
test "$(awk -F : 'NR > 2 {gsub(/ /, "", $1); print $1}' /proc/net/dev)" = lo
printf '%s\n' '[domains C5/C11] compiled Linux package rejected missing/unverified IPv4 and IPv6 bind exclusion before policy, journal, browser or role ingress effects'
`;
    const payload = { version: 1, ...MANIFEST, baseline: { revision: 0, domains: ["mozilla.org"] }, chromeSha256: "a".repeat(64) };
    docker(["create", "--name", name, "--label", `social-tunnel.proof=${id}`, "--platform", "linux/arm64", "--network", "none",
      "--cpus", "2", "--memory", "768m", "--pids-limit", "96", "--init", "--security-opt", "no-new-privileges=true",
      "--security-opt", `seccomp=${seccomp}`, "-e", `ST_REJECTION_MANIFEST=${JSON.stringify(payload)}`,
      "-e", `ST_SSH_CONFIG=${SSH_CONFIG}`, "-e", `ST_SSH_ROLE_MISMATCH=${SSH_CONFIG.replace("DisableForwarding yes", "DisableForwarding no")}`,
      "-e", `ST_SSH_PORT_MISMATCH=${SSH_CONFIG.replace("ListenAddress 127.0.0.1", `ListenAddress 127.0.0.1:${MANIFEST.sshPort + 1}`)}`,
      imageId, "/usr/bin/timeout", "20", "/bin/sh", "-eu", "-c", script]);
    created = true;
    assert.equal(docker(["inspect", name, "--format", "{{.HostConfig.NetworkMode}} {{.HostConfig.NanoCpus}} {{.HostConfig.Privileged}} {{len .Mounts}} {{len .HostConfig.PortBindings}}"], true),
      "none 2000000000 false 0 0");
    for (const file of ["st-domains-supervisor", "st-domains-command", "st-domains-direct-witness"]) docker(["cp", join(dir, file), `${name}:/usr/local/bin/${file}`]);
    background("env", [...dockerEnv, "start", "-a", name]);
    assert.equal(docker(["inspect", name, "--format", "{{.State.ExitCode}}"], true), "0");
  } finally {
    if (created) {
      assert.equal(docker(["inspect", name, "--format", '{{index .Config.Labels "social-tunnel.proof"}}'], true), id);
      docker(["rm", "-f", name]);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) proof();
