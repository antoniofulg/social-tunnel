// Groups doctor's hops into the four stops of the route strip and words each one (plan criterion 59).
import type { Doctor, Hop } from "./types";

export const STOP_NAMES = ["This Mac", "Server", "Tunnel port", "Domains"] as const;

const GROUPS: readonly (readonly string[])[] = [
  ["config", "key", "egress"],
  ["server_reachable", "ssh_auth"],
  ["forward", "lockdown"],
  ["domain"],
];

export type Word = "OK" | "Key changed" | "Refused" | "Failed" | "Skipped" | "Not checked" | "Checking…";
export type Tone = "ok" | "warn" | "down" | "busy" | "off";

export const TONE: Record<Word, Tone> = {
  OK: "ok",
  "Key changed": "down",
  Refused: "warn",
  Failed: "down",
  Skipped: "off",
  "Not checked": "off",
  "Checking…": "busy",
};

export const HOP_NAMES: Record<string, string> = {
  config: "Config file",
  domain: "Domain",
  key: "Tunnel key",
  server_reachable: "Server reachable",
  ssh_auth: "SSH sign-in",
  forward: "Tunnel port",
  lockdown: "Lock-down",
  egress: "Internet from this Mac",
};

export const failedHop = (doctor: Doctor): Hop | undefined => doctor.hops.find((h) => !h.ok && !h.skipped);

function failedWord(hop: string, exit: number): Word {
  if (hop === "ssh_auth" && exit === 13) return "Key changed";
  if ((hop === "forward" && exit === 11) || hop === "domain") return "Refused";
  return "Failed";
}

function stopWord(hops: Hop[], exit: number): Word {
  const failed = hops.find((h) => !h.ok && !h.skipped);
  if (failed) return failedWord(failed.hop, exit);
  if (hops.length === 0 || hops.every((h) => h.skipped)) return "Skipped";
  return "OK";
}

/** The four stop words; `Not checked` before a doctor result or while the status is unreadable. */
export function stopWords(doctor: Doctor | null, unreadable: boolean): Word[] {
  if (!doctor || unreadable) return STOP_NAMES.map(() => "Not checked");
  const words = GROUPS.slice(0, 3).map((ids) =>
    stopWord(doctor.hops.filter((h) => ids.includes(h.hop)), doctor.exit),
  );
  const domainHops = doctor.hops.filter((h) => h.hop === "domain");
  const domains: Word = domainHops.length > 0 ? stopWord(domainHops, doctor.exit) : words.every((w) => w === "OK") ? "OK" : "Skipped";
  return [...words, domains];
}
