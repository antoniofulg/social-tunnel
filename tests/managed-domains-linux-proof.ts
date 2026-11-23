import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

function run(command: string, args: string[], capture = false): string {
  const result = spawnSync(command, args, { stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"], encoding: "utf8", timeout: 180000 });
  if (result.status !== 0) throw new Error(`${command} failed with ${result.status ?? result.signal}`);
  return result.stdout?.trim() ?? "";
}

export function linuxDomainProof(mode: "ssh" | "chrome" | "integrated") {
  const image = process.env.ST_DOMAIN_FIXTURE_IMAGE;
  const seccomp = process.env.ST_DOMAIN_FIXTURE_SECCOMP;
  assert(image && seccomp, "provide the pinned disposable fixture image and namespace sandbox seccomp profile");
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "st-domain-proof-")));
  const id = randomUUID();
  const name = `st-domains-proof-${id}`;
  const docker = (args: string[], capture = false) => run("env", ["-u", "DOCKER_HOST", "-u", "DOCKER_CONTEXT", "docker", "--context", "kiri", ...args], capture);
  const bg = (command: string, ...args: string[]) => {
    run("load-gate", ["wait"]);
    run("taskpolicy", ["-b", "nice", "-n", "10", command, ...args]);
  };
  let created = false;
  try {
    const endpoint = docker(["context", "inspect", "kiri", "--format", "{{.Endpoints.docker.Host}}"], true);
    assert(endpoint.startsWith("unix:///"));
    assert(statSync(endpoint.slice(7)).isSocket());
    const imageId = docker(["image", "inspect", image, "--format", "{{.Id}}"], true);
    assert.match(imageId, /^sha256:[0-9a-f]{64}$/);
    bg(process.execPath, "build", "--compile", "--target=bun-linux-arm64", "server/domain-command.ts", "--outfile", join(dir, "command"));
    bg(process.execPath, "build", "--compile", "--target=bun-linux-arm64", "tests/managed-domains-s3-fixture.ts", "--outfile", join(dir, "fixture"));
    bg(process.execPath, "build", "--compile", "--target=bun-linux-arm64", "server/domain-direct-witness.ts", "--outfile", join(dir, "direct-witness"));
    docker(["create", "--name", name, "--label", `social-tunnel.proof=${id}`, "--platform", "linux/arm64", "--network", "none",
      "--cpus", "2", "--memory", "1400m", "--pids-limit", "448", "--init", "--security-opt", "no-new-privileges=true",
      "--security-opt", `seccomp=${seccomp}`, "-e", "ST_ISOLATED_FIXTURE=c6fd921", imageId,
      "/usr/bin/timeout", "--kill-after=5s", "120s", "/usr/local/bin/st-domains-fixture", mode]);
    created = true;
    const actual = docker(["inspect", name, "--format", "{{.HostConfig.NetworkMode}} {{.HostConfig.NanoCpus}} {{.HostConfig.Privileged}} {{len .Mounts}} {{len .HostConfig.PortBindings}}"], true);
    assert.equal(actual, "none 2000000000 false 0 0");
    docker(["cp", join(dir, "command"), `${name}:/usr/local/bin/st-domains-command`]);
    docker(["cp", join(dir, "fixture"), `${name}:/usr/local/bin/st-domains-fixture`]);
    docker(["cp", join(dir, "direct-witness"), `${name}:/usr/local/bin/st-domains-direct-witness`]);
    bg("env", "-u", "DOCKER_HOST", "-u", "DOCKER_CONTEXT", "docker", "--context", "kiri", "start", "-a", name);
    assert.equal(docker(["inspect", name, "--format", "{{.State.ExitCode}} {{.State.OOMKilled}}"], true), "0 false");
  } finally {
    if (created) {
      assert.equal(docker(["inspect", name, "--format", '{{index .Config.Labels "social-tunnel.proof"}}'], true), id);
      docker(["rm", "-f", name]);
    }
    rmSync(dir, { recursive: true, force: true });
  }
}
