// Renders the tray template images (concept C · Beacon) and the app icon (concept A arch) from the
// design SVGs. Run with `bun run icons` from app/; the PNGs are committed.
import { Resvg } from "@resvg/resvg-js";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const root = join(import.meta.dir, "..");
const design = join(root, "..", "docs", "design");
const trayDir = join(root, "src-tauri", "icons", "tray");
mkdirSync(trayDir, { recursive: true });

// Template images: shape in alpha only, every pixel's RGB forced to 0 (plan criterion 31).
function render(svg: string, px: number): Buffer {
  const image = new Resvg(svg, { fitTo: { mode: "width", value: px } }).render();
  if (image.width !== px || image.height !== px) throw new Error(`rendered ${image.width}x${image.height}, wanted ${px}`);
  const rgba = Buffer.from(image.pixels);
  for (let i = 0; i < rgba.length; i += 4) rgba[i] = rgba[i + 1] = rgba[i + 2] = 0;
  return encode(rgba, px);
}

// Minimal PNG encoder (RGBA, 8-bit, no filter) so the output is exactly the forced pixels.
function encode(rgba: Buffer, size: number): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.subarray(y * size * 4, (y + 1) * size * 4).copy(raw, y * (size * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const svg = (name: string) => readFileSync(join(design, "concept-c", `tray-${name}.svg`), "utf8");
const marks: Record<string, string> = {
  "not-set-up": svg("idle"),
  connected: svg("connected"),
  disconnected: svg("disconnected"),
  blocked: svg("blocked"),
};
// The reconnecting loop: concept C's still reconnecting mark, its arc turned 45° per frame (C spins).
const still = svg("reconnecting");
for (let f = 0; f < 8; f++) {
  marks[`reconnecting-${f}`] = still.replace(
    /<path d="([^"]+)"\/>/,
    `<path d="$1" transform="rotate(${f * 45} 9 9)"/>`,
  );
}

for (const [name, source] of Object.entries(marks)) {
  writeFileSync(join(trayDir, `${name}.png`), render(source, 18));
  writeFileSync(join(trayDir, `${name}@2x.png`), render(source, 36));
}

// App icon: concept A's arch, black on a light tile, as PNG sizes and the macOS .icns.
const ARCH = "M3.5 14.6V9a5.5 5.5 0 0 1 11 0v5.6";
const appIcon = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="-3 -3 24 24">
  <rect x="-2" y="-2" width="22" height="22" rx="5" fill="#f2f2f4"/>
  <path d="${ARCH}" fill="none" stroke="#1d1d1f" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
const iconsDir = join(root, "src-tauri", "icons");
const appPng = (px: number) => new Resvg(appIcon, { fitTo: { mode: "width", value: px } }).render().asPng();
writeFileSync(join(iconsDir, "icon.png"), appPng(1024));
for (const [name, px] of [["32x32", 32], ["128x128", 128], ["128x128@2x", 256]] as const) {
  writeFileSync(join(iconsDir, `${name}.png`), appPng(px));
}
// macOS bundle icon (plan criterion 77): an .iconset of every size, packed by `iconutil`.
const scratch = mkdtempSync(join(tmpdir(), "social-tunnel-"));
try {
  const iconset = join(scratch, "icon.iconset");
  mkdirSync(iconset);
  for (const base of [16, 32, 128, 256, 512]) {
    writeFileSync(join(iconset, `icon_${base}x${base}.png`), appPng(base));
    writeFileSync(join(iconset, `icon_${base}x${base}@2x.png`), appPng(base * 2));
  }
  const packed = Bun.spawnSync(["iconutil", "-c", "icns", iconset, "-o", join(iconsDir, "icon.icns")]);
  if (packed.exitCode !== 0) throw new Error(`iconutil failed: ${packed.stderr}`);
} finally {
  rmSync(scratch, { recursive: true });
}
console.log(`wrote ${Object.keys(marks).length * 2} tray images, icon.png, 3 PNG sizes and icon.icns`);
