// Serves the built page with the exact CSP of tauri.conf.json as a response header, so WebKit
// enforces here what the Tauri webview enforces.
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";

const root = join(import.meta.dirname, "..");
const TYPES: Record<string, string> = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };

export const csp: string = JSON.parse(readFileSync(join(root, "src-tauri", "tauri.conf.json"), "utf8")).app.security.csp;

export async function serveDist(dist = join(root, "dist")): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    const file = normalize(join(dist, path === "/" ? "index.html" : path));
    try {
      if (!file.startsWith(dist)) throw new Error("outside dist");
      const body = readFileSync(file);
      res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "content-security-policy": csp });
      res.end(body);
    } catch {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("no port");
  return { url: `http://127.0.0.1:${address.port}/`, server };
}
