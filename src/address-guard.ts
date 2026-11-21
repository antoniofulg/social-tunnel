import { isIP } from "node:net";
import os from "node:os";

export type Interfaces = Record<string, readonly { cidr: string | null }[] | undefined>;

type Cidr = { bytes: number[]; bits: number };

function parseV4(text: string): number[] {
  return text.split(".").map(Number);
}

// `text` has already passed isIP, so every group is well formed.
function parseV6(text: string): number[] {
  const zone = text.indexOf("%");
  const [head = "", tail] = (zone === -1 ? text : text.slice(0, zone)).split("::");
  const groups = (part: string): number[] =>
    part === ""
      ? []
      : part.split(":").flatMap((g) => {
          if (g.includes(".")) return parseV4(g);
          const n = parseInt(g, 16);
          return [n >> 8, n & 0xff];
        });
  const h = groups(head);
  const t = tail === undefined ? [] : groups(tail);
  return [...h, ...new Array<number>(16 - h.length - t.length).fill(0), ...t];
}

function parseIp(text: string): number[] | null {
  const family = isIP(text);
  return family === 4 ? parseV4(text) : family === 6 ? parseV6(text) : null;
}

function cidr(text: string): Cidr | null {
  const slash = text.lastIndexOf("/");
  const bytes = parseIp(text.slice(0, slash));
  const bits = Number(text.slice(slash + 1));
  return bytes && slash !== -1 && Number.isInteger(bits) ? { bytes, bits } : null;
}

function inside(ip: number[], range: Cidr): boolean {
  if (ip.length !== range.bytes.length) return false;
  for (let bit = 0; bit < range.bits; bit += 8) {
    const left = Math.min(8, range.bits - bit);
    const mask = (0xff << (8 - left)) & 0xff;
    const i = bit / 8;
    if ((ip[i]! & mask) !== (range.bytes[i]! & mask)) return false;
  }
  return true;
}

// Plan criterion 11. Each entry is a range the proxy must never dial.
const REFUSED = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "224.0.0.0/4",
  "240.0.0.0/4",
  "::/128",
  "::1/128",
  "100::/64",
  "2001::/32",
  "64:ff9b:1::/48",
  "fc00::/7",
  "fe80::/10",
  "fec0::/10",
  "ff00::/8",
].map((c) => cidr(c)!);

// IPv6 forms that carry an IPv4 address; `at` is the byte where it starts.
const EMBEDDED = [
  { range: cidr("::/96")!, at: 12 },
  { range: cidr("::ffff:0:0/96")!, at: 12 },
  { range: cidr("64:ff9b::/96")!, at: 12 },
  { range: cidr("2002::/16")!, at: 2 },
];

function refusedBytes(ip: number[], own: Cidr[]): boolean {
  if (REFUSED.some((r) => inside(ip, r)) || own.some((r) => inside(ip, r))) return true;
  return EMBEDDED.some((e) => inside(ip, e.range) && refusedBytes(ip.slice(e.at, e.at + 4), own));
}

// True when `address` must not be dialled: a reserved range, an IPv4 hidden inside IPv6, or any
// prefix on this machine's own interfaces (which covers the LAN, including a global IPv6 /64).
// Anything that does not parse is refused.
export function isRefusedAddress(address: string, interfaces: Interfaces = os.networkInterfaces()): boolean {
  const ip = parseIp(address);
  if (!ip) return true;
  const own: Cidr[] = [];
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      const range = entry.cidr ? cidr(entry.cidr) : null;
      if (range) own.push(range);
    }
  }
  return refusedBytes(ip, own);
}
