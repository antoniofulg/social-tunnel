import { expect, test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { snapshot } from "../src/fixtures";
import type { DomainView } from "../src/types";
import { serveDist } from "./serve";

interface TestWindow extends Window {
  __finishDomainFixture(): void;
  __domainCalls: [string, unknown][];
}

const id = "1.7.0123456789abcdef0123456789abcdef";
const initial: DomainView = { state: "ready", active: { revision: 7, domains: ["example.com", "mozilla.org", "wikipedia.org"] }, pending: null };
const applied: DomainView = { state: "applied", active: { revision: 8, domains: [...initial.active!.domains, "wipo.int"] }, pending: null };
const queued: DomainView = { state: "pending", active: null,
  pending: { operationId: id, operation: "add", host: "wipo.int", phase: "claimed", pendingMayGoDirect: true } };

for (const scheme of ["light", "dark"] as const) {
  test(`[domains C12] real WebKit Enter, pending and applied at 640×560 (${scheme})`, async ({ page }) => {
    const dist = process.env.ST_PROOF_DIST;
    const captures = process.env.ST_PROOF_CAPTURES;
    if (!dist || !captures) throw new Error("Set disposable ST_PROOF_DIST and ST_PROOF_CAPTURES paths.");
    mkdirSync(captures, { recursive: true });
    const { server, url } = await serveDist(dist);
    try {
      await page.setViewportSize({ width: 640, height: 560 });
      await page.emulateMedia({ colorScheme: scheme });
      const origin = new URL(url).origin;
      const external: string[] = [];
      await page.context().route("**/*", (route) => {
        if (new URL(route.request().url()).origin === origin) return route.continue();
        external.push(route.request().url());
        return route.abort();
      });
      const snap = snapshot({ reduceTransparency: true });
      snap.status!.managedDomains = initial;
      await page.addInitScript(({ snap, initial, queued, applied }) => {
        const w = window as unknown as Record<string, unknown>;
        const callbacks = new Map<number, (event: unknown) => void>();
        const subscriptions = new Map<string, number>();
        const calls: [string, unknown][] = [];
        let index = 0;
        let finish = false;
        w.__domainCalls = calls;
        w.__finishDomainFixture = () => {
          finish = true;
          const key = subscriptions.get("snapshot");
          if (key) callbacks.get(key)?.({ event: "snapshot", id: key,
            payload: { ...snap, status: { ...snap.status, managedDomains: { ...applied, state: "ready" } } } });
        };
        w.__TAURI_INTERNALS__ = {
          metadata: { currentWindow: { label: "settings" }, currentWebview: { label: "settings", windowLabel: "settings" } },
          transformCallback(cb: (event: unknown) => void) { callbacks.set(++index, cb); return index; },
          unregisterCallback(id: number) { callbacks.delete(id); },
          async invoke(cmd: string, args: { event?: string; handler?: number }) {
            calls.push([cmd, args]);
            if (cmd === "get_snapshot") return snap;
            if (cmd === "get_domains") return finish ? applied : initial;
            if (cmd === "edit_domain") return queued;
            if (cmd === "retry_domain_edit") return finish ? applied : queued;
            if (cmd === "plugin:event|listen") { subscriptions.set(args.event!, args.handler!); return args.handler; }
            if (cmd === "plugin:event|unlisten") return;
            throw new Error("Unexpected command in isolated Settings fixture");
          },
        };
        w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
      }, { snap, initial, queued, applied });
      await page.goto(`${url}#domains`);
      const field = page.getByRole("textbox", { name: "Add domain" });
      await expect(field).toBeEditable();
      await field.fill("wipo.int");
      await field.press("Enter");
      await expect(page.getByText("Until applied, this domain may still go directly from the server.")).toBeVisible();
      await expect(page.getByRole("list", { name: "Last verified domains" }).getByText("wipo.int")).toHaveCount(0);
      await page.screenshot({ path: join(captures, `domains-pending-${scheme}.png`) });
      await page.evaluate(() => {
        const fixture = window as unknown as TestWindow;
        fixture.__finishDomainFixture();
      });
      await expect(page.getByText("Applied to new connections in the enrolled browser.")).toBeVisible();
      await expect(page.getByRole("list", { name: "Domains that use home internet" }).getByText("wipo.int")).toBeVisible();
      await expect(field).toHaveValue("");
      await page.screenshot({ path: join(captures, `domains-applied-${scheme}.png`) });
      const calls = await page.evaluate(() => {
        const fixture = window as unknown as TestWindow;
        return fixture.__domainCalls;
      });
      expect(calls.filter(([cmd]) => cmd === "edit_domain")).toEqual([["edit_domain", { operation: "add", host: "wipo.int", expectedRevision: 7 }]]);
      const retries = calls.filter(([cmd]) => cmd === "retry_domain_edit");
      expect(retries.length).toBeGreaterThanOrEqual(1);
      for (const [, args] of retries) expect(args).toEqual({ operationId: id });
      expect(external).toEqual([]);
    } finally {
      await page.goto("about:blank");
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}
