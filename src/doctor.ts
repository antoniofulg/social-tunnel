import { loadConfig, loadKey, type Config, type KeyFs } from "./config";
import { EXIT } from "./defaults";

export interface Hop {
  hop: string;
  ok: boolean;
  skipped: boolean;
  detail: string;
  fix: string;
}

export interface DoctorDeps extends KeyFs {
  platform: string;
  homedir: () => string;
}

type Outcome = { ok: true; detail: string } | { ok: false; detail: string; fix: string; exit: number };
type Step = { hop: string; run: () => Outcome | Promise<Outcome> };

const pass = (detail: string): Outcome => ({ ok: true, detail });
const fail = (detail: string, fix: string, exit: number): Outcome => ({ ok: false, detail, fix, exit });

// Runs the hops in order and stops at the first failure; the rest are reported as skipped.
export async function runDoctor(
  configPath: string,
  deps: DoctorDeps,
): Promise<{ hops: Hop[]; exit: number }> {
  let config!: Config;

  const steps: Step[] = [
    {
      hop: "config",
      run: () => {
        const loaded = loadConfig(configPath, deps.readFile, deps.homedir);
        if (!loaded.ok) {
          return fail(`${loaded.field}: ${loaded.message}`, `Fix ${loaded.field} in ${configPath}.`, EXIT.usage);
        }
        config = loaded.config;
        return pass(`${configPath} is valid`);
      },
    },
    {
      hop: "key",
      run: () => {
        const key = loadKey(config.keyPath, deps, deps.platform);
        if (!key.ok) {
          const fix =
            key.code === "key_permissions"
              ? `Run: chmod 600 ${config.keyPath}`
              : `Point keyPath at an unencrypted SSH private key that only you can read.`;
          return fail(key.message, fix, EXIT.usage);
        }
        return pass(`${config.keyPath} is private to you`);
      },
    },
  ];

  const hops: Hop[] = [];
  let exit: number = EXIT.ok;
  for (const step of steps) {
    if (exit !== EXIT.ok) {
      hops.push({ hop: step.hop, ok: false, skipped: true, detail: "skipped", fix: "" });
      continue;
    }
    const outcome = await step.run();
    if (outcome.ok) {
      hops.push({ hop: step.hop, ok: true, skipped: false, detail: outcome.detail, fix: "" });
    } else {
      hops.push({ hop: step.hop, ok: false, skipped: false, detail: outcome.detail, fix: outcome.fix });
      exit = outcome.exit;
    }
  }
  return { hops, exit };
}
