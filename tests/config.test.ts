import { expect, test } from "bun:test";
import { chmodSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { loadKey, parseConfig, resolveConfigPath } from "../src/config";
import { baseConfig, cli, tmp, writeConfig, writeKey } from "./helpers";

test("[C1] config path resolves flag, then env, then the platform config dir", () => {
  const home = () => "/home/u";
  const env = { SOCIAL_TUNNEL_CONFIG: "/env/config.json", XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\Roaming" };

  expect(resolveConfigPath("flag/config.json", env, "linux", home)).toBe(resolve("flag/config.json"));
  expect(resolveConfigPath(undefined, env, "linux", home)).toBe("/env/config.json");
  expect(resolveConfigPath(undefined, {}, "darwin", () => "/Users/u")).toBe(
    "/Users/u/Library/Application Support/social-tunnel/config.json",
  );
  expect(resolveConfigPath(undefined, { XDG_CONFIG_HOME: "/xdg" }, "linux", home)).toBe(
    "/xdg/social-tunnel/config.json",
  );
  expect(resolveConfigPath(undefined, {}, "linux", home)).toBe("/home/u/.config/social-tunnel/config.json");
  expect(resolveConfigPath(undefined, { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", home)).toBe(
    "C:\\Users\\u\\AppData\\Roaming\\social-tunnel\\config.json",
  );
});

test("[C2] status and run exit 2 with a config_invalid envelope for missing, non-JSON and schema-invalid config", async () => {
  const dir = tmp();
  const notJson = join(dir, "not-json.json");
  writeFileSync(notJson, "{ nope");
  const cases: [string, string][] = [
    [join(dir, "missing.json"), "$"],
    [notJson, "$"],
    [writeConfig((c) => (c.version = 2)).path, "version"],
    [writeConfig((c) => (c.server = "example.com")).path, "server"],
    [writeConfig((c) => (c.remotePort = 70000)).path, "remotePort"],
  ];
  for (const verb of ["status", "run"]) {
    for (const [path, field] of cases) {
      const result = await cli([verb, "--json", "--config", path]);
      expect(result.code).toBe(2);
      const body = result.json();
      expect(body).toEqual({
        ok: false,
        command: verb,
        error: { code: "config_invalid", field, message: expect.any(String) },
      });
      expect(body.error.message.length).toBeGreaterThan(0);
    }
  }
});

test("[C3] domain entries that are not bare hostnames are rejected naming the entry", async () => {
  const entries = [
    "instagram",
    "https://instagram.com",
    "instagram.com:443",
    "instagram.com/x",
    "*.instagram.com",
    "1.2.3.4",
    "[::1]",
    "::1",
  ];
  for (const entry of entries) {
    const { path } = writeConfig((c) => (c.domains = ["facebook.com", entry]));
    const result = await cli(["status", "--json", "--config", path]);
    expect(result.code).toBe(2);
    const { error } = result.json();
    expect(error.code).toBe("config_invalid");
    expect(error.field).toBe("domains[1]");
    expect(error.message).toContain(entry);
  }
});

test("[C4] Instagram.COM. is stored as instagram.com", () => {
  const config = { ...baseConfig("/k"), domains: ["Instagram.COM."] };
  const parsed = parseConfig(config, "/cfg", () => "/home/u");
  expect(parsed.ok).toBe(true);
  if (parsed.ok) expect(parsed.config.domains).toEqual(["instagram.com"]);
});

test("[C5] a config with an extra key password is rejected naming it", async () => {
  const { path } = writeConfig((c) => (c.password = "hunter2-secret"));
  const result = await cli(["status", "--json", "--config", path]);
  expect(result.code).toBe(2);
  expect(result.json().error).toMatchObject({ code: "config_invalid", field: "password" });
  expect(result.stdout + result.stderr).not.toContain("hunter2-secret");
});

test("[C6] a key readable or writable by group or others fails with key_permissions before any read", async () => {
  for (const mode of [0o644, 0o640, 0o604, 0o660]) {
    const { path, keyPath } = writeConfig(() => {}, mode);
    const keyReads: string[] = [];
    const result = await cli(["run", "--json", "--config", path], {
      readFile: (p) => {
        if (p === keyPath) keyReads.push(p);
        return readFileSync(p);
      },
    });
    expect(result.code).toBe(2);
    expect(result.json()).toMatchObject({ ok: false, command: "run", error: { code: "key_permissions" } });
    expect(result.json().error.message).toContain(keyPath);
    expect(keyReads).toEqual([]);
  }

  for (const mode of [0o600, 0o400]) {
    const key = writeKey(tmp(), mode);
    let reads = 0;
    const loaded = loadKey(
      key.path,
      { stat: statSync, readFile: (p) => (reads++, readFileSync(p)) },
      "linux",
    );
    expect(loaded.ok).toBe(true);
    expect(reads).toBe(1);
    chmodSync(key.path, 0o600);
  }
});

test("[C7] status --json and doctor --json include the absolute configPath they used", async () => {
  const { path } = writeConfig();
  const rel = relative(process.cwd(), path);
  expect(rel).not.toBe(path);

  const status = await cli(["status", "--json", "--config", rel]);
  expect(status.json().configPath).toBe(path);

  const doctor = await cli(["doctor", "--json"], { env: { SOCIAL_TUNNEL_CONFIG: rel } });
  expect(doctor.json().configPath).toBe(path);
});

test("[C60] server.hostKey must be SHA256: plus 43 unpadded base64 characters", async () => {
  const body43 = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNO+/";
  expect(body43.length).toBe(43);
  const good = "SHA256:" + body43;
  const rejected: (string | undefined)[] = [
    undefined,
    "MD5:ab:cd:ef:01:23:45:67:89:ab:cd:ef:01:23:45:67:89",
    good + "=",
    "SHA256:" + body43.slice(0, 42),
  ];
  for (const hostKey of rejected) {
    const { path } = writeConfig((c) => {
      if (hostKey === undefined) delete c.server.hostKey;
      else c.server.hostKey = hostKey;
    });
    const result = await cli(["status", "--json", "--config", path]);
    expect(result.code).toBe(2);
    expect(result.json().error).toMatchObject({ code: "config_invalid", field: "server.hostKey" });
  }

  const { path } = writeConfig((c) => (c.server.hostKey = good));
  const accepted = await cli(["status", "--json", "--config", path]);
  expect(accepted.json().error).toBeUndefined();
  expect(accepted.json().state).toBe("stopped");
});

test("[C68] bad server fields, keyPath, unknown server keys and misplaced flags are rejected", async () => {
  const fields: [string, (c: Record<string, any>) => void][] = [
    ["server.host", (c) => (c.server.host = "bad host\u001b[31m")],
    ["server.host", (c) => (c.server.host = "")],
    ["server.port", (c) => (c.server.port = 0)],
    ["server.port", (c) => (c.server.port = 65536)],
    ["server.port", (c) => (c.server.port = "22")],
    ["server.user", (c) => (c.server.user = "tunnel user")],
    ["server.user", (c) => delete c.server.user],
    ["keyPath", (c) => (c.keyPath = "")],
    ["keyPath", (c) => (c.keyPath = 7)],
    ["server.password", (c) => (c.server.password = "hunter2-secret")],
  ];
  for (const [field, edit] of fields) {
    const { path } = writeConfig(edit);
    for (const verb of ["status", "run"]) {
      const result = await cli([verb, "--json", "--config", path]);
      expect([field, result.code]).toEqual([field, 2]);
      expect(result.json()).toMatchObject({ ok: false, command: verb, error: { code: "config_invalid", field } });
      expect(result.stdout).not.toContain("hunter2-secret");
    }
  }

  const { path } = writeConfig();
  const misuse = [
    ["status", "--config"],
    ["status", "--config", ""],
    ["status", "--domain", "instagram.com", "--config", path],
    ["run", "--domain", "instagram.com", "--config", path],
    ["doctor", "--config", path, "--domain"],
  ];
  for (const argv of misuse) {
    const result = await cli(argv);
    expect([argv, result.code]).toEqual([argv, 2]);
    expect(result.stderr).toContain("usage: social-tunnel");
    expect(result.stdout).toBe("");
  }
});

test("[C72] a missing key exits 2 with key_unreadable, and a non-private-key file with key_invalid", async () => {
  const cases: [string, (keyPath: string, publicKey: string) => void][] = [
    ["key_unreadable", (keyPath) => rmSync(keyPath)],
    ["key_invalid", (keyPath) => writeFileSync(keyPath, "not a key\n", { mode: 0o600 })],
    // A public key parses as a key, but it is not a private key.
    ["key_invalid", (keyPath, publicKey) => writeFileSync(keyPath, publicKey, { mode: 0o600 })],
  ];
  for (const [code, breakKey] of cases) {
    const files = writeConfig();
    breakKey(files.keyPath, files.publicKey);

    const run = await cli(["run", "--json", "--config", files.path]);
    expect([code, run.code]).toEqual([code, 2]);
    expect(run.json()).toMatchObject({ ok: false, command: "run", error: { code } });
    expect(run.json().error.message).toContain(files.keyPath);

    const doctor = await cli(["doctor", "--json", "--config", files.path]);
    expect(doctor.code).toBe(2);
    expect(doctor.json().error).toBeUndefined();
    expect(doctor.json().hops.find((h: any) => h.hop === "key")).toMatchObject({ ok: false, skipped: false });
  }
});

test("[C114] a key file swapped after the mode check is never loaded; one swapped after open still yields the checked file", async () => {
  const dir = tmp();
  // Swapped for a group-readable file between the path check and the open: refused on the descriptor's mode.
  const checked = writeKey(dir, 0o600, "checked");
  const swap = writeKey(dir, 0o644, "swap");
  let reads = 0;
  const before = loadKey(
    checked.path,
    { stat: (p) => { const s = statSync(p); renameSync(swap.path, checked.path); return s; }, readFile: (p) => (reads++, readFileSync(p)) },
    "linux",
  );
  expect(before).toMatchObject({ ok: false, code: "key_permissions" });
  expect(reads).toBe(0);

  // Swapped between the descriptor's mode check and the read: the bytes come from the file that was checked.
  const original = writeKey(dir, 0o600, "original");
  const other = writeKey(dir, 0o600, "other");
  const want = readFileSync(original.path);
  const after = loadKey(
    original.path,
    { stat: statSync, readFile: (p) => (renameSync(other.path, original.path), readFileSync(p)) },
    "linux",
  );
  expect(after.ok).toBe(true);
  expect(after.ok && after.key.equals(want)).toBe(true);
  expect(readFileSync(original.path).equals(want)).toBe(false);
});
