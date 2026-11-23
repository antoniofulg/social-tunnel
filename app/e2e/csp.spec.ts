// WebKit under the real CSP, with the Tauri IPC stubbed (checks C71, C89). Run after `vite build`.
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { doctor, keyChanged, notSetUp, snapshot } from "../src/fixtures";
import type { Snapshot } from "../src/types";
import { serveDist } from "./serve";

const captures = join(import.meta.dirname, "..", "..", ".specs", "features", "tray-app", "captures");

let origin = "";
let close = async () => {};
test.beforeAll(async () => {
  const { url, server } = await serveDist();
  origin = url;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});
test.afterAll(() => close());

/** Replaces the Tauri IPC with fixtures and counts every `securitypolicyviolation`. */
async function open(page: Page, snap: Snapshot | null, hash = "") {
  await page.addInitScript(({ snap }) => {
    const callbacks = new Map<number, (event: unknown) => void>();
    const listeners = new Map<string, number[]>();
    let next = 1;
    const w = window as unknown as Record<string, unknown>;
    w.__violations = [] as string[];
    document.addEventListener("securitypolicyviolation", (e) => (w.__violations as string[]).push(`${e.violatedDirective} ${e.blockedURI}`));
    w.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (event: unknown) => void) => {
        callbacks.set(next, cb);
        return next++;
      },
      unregisterCallback: (id: number) => callbacks.delete(id),
      invoke: async (cmd: string, args: { event?: string; handler?: number }) => {
        if (cmd === "get_snapshot") return snap;
        if (cmd === "plugin:event|listen") {
          listeners.set(args.event!, [...(listeners.get(args.event!) ?? []), args.handler!]);
          return args.handler;
        }
        return undefined;
      },
      metadata: { currentWindow: { label: "settings" }, currentWebview: { label: "settings", windowLabel: "settings" } },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => undefined };
    w.__emit = (event: string, payload: unknown) => {
      for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
    };
  }, { snap });
  await page.goto(origin + hash);
}

const violations = (page: Page) => page.evaluate(() => (window as unknown as { __violations: string[] }).__violations);
const styled = (page: Page) => page.evaluate(() => document.querySelectorAll("[style]").length);

test("[tray-app C55] healthy Status fits the native Settings content area without scrolling", async ({ page }) => {
  // Use the measured 32 pt title-bar allowance from the native Settings fixture.
  await page.setViewportSize({ width: 640, height: 528 });
  await open(page, snapshot());
  await expect(page.getByText("All checks OK.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Check Again" })).toBeInViewport({ ratio: 1 });
  const overflow = await page.getByRole("tabpanel").evaluate((panel) => panel.scrollHeight - panel.clientHeight);
  expect(overflow).toBe(0);
  const panel = page.getByRole("tabpanel");
  await expect(panel).toHaveCSS("overscroll-behavior", "none");
  await expect(page.locator("html")).toHaveCSS("overscroll-behavior", "none");
  await page.getByRole("tab", { name: "Server" }).click();
  expect(await panel.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(0);
});

test("[tray-app C55] a long Status diagnostic can still be scrolled", async ({ page }) => {
  await page.setViewportSize({ width: 640, height: 528 });
  const fix = "Compare the expected restrictions with the server configuration. ".repeat(12).trim();
  await open(page, snapshot({ doctor: doctor({ failAt: "lockdown", exit: 14, fix }) }));
  await expect(page.getByText(fix)).toBeVisible();
  const panel = page.getByRole("tabpanel");
  expect(await panel.evaluate((el) => el.scrollHeight - el.clientHeight)).toBeGreaterThan(0);
  await panel.hover();
  await page.mouse.wheel(0, 500);
  await expect(page.getByRole("button", { name: "Check Again" })).toBeInViewport({ ratio: 1 });
});

for (const scheme of ["light", "dark"] as const) {
  test.describe(`${scheme} appearance`, () => {
    test.use({ colorScheme: scheme });

    test(`[tray-app C89] raises no CSP violation and carries no style attribute on Status, Server, Domains, General and Set Up (${scheme})`, async ({ page }) => {
      await open(page, keyChanged());
      for (const tab of ["Status", "Server", "Domains", "General"]) {
        await page.getByRole("tab", { name: tab }).click();
        await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
        await expect(page.getByRole("tabpanel")).toBeVisible();
        expect(await styled(page), tab).toBe(0);
        expect(await violations(page), tab).toEqual([]);
      }
      // The page really rendered the snapshot: this is not an empty page passing for want of content.
      await page.getByRole("tab", { name: "Server" }).click();
      await expect(page.getByText("SHA256:", { exact: false }).first()).toBeVisible();

      await page.evaluate(() => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit("settings-view", "setup"));
      await expect(page.getByRole("heading", { name: "4. Check every hop" })).toBeVisible();
      expect(await styled(page), "setup").toBe(0);
      expect(await violations(page), "setup").toEqual([]);
    });

    // Playwright injects a <style> element to take a picture, which the CSP rightly reports, so the
    // pictures come from their own test and assert nothing about violations.
    test(`captures every view from the stubbed page (${scheme})`, async ({ page }) => {
      mkdirSync(captures, { recursive: true });
      await open(page, keyChanged());
      for (const tab of ["Status", "Server", "Domains", "General"]) {
        await page.getByRole("tab", { name: tab }).click();
        await page.screenshot({ path: join(captures, `stub-${tab.toLowerCase()}-${scheme}.png`) });
      }
      await page.evaluate(() => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit("settings-view", "setup"));
      await page.getByRole("heading", { name: "4. Check every hop" }).waitFor();
      await page.screenshot({ path: join(captures, `stub-setup-${scheme}.png`) });
    });
  });
}

test("[tray-app C89] the harness sees a violation when the page breaks the CSP", async ({ page }) => {
  await open(page, snapshot());
  await page.getByRole("tab", { name: "Status" }).waitFor();
  expect(await violations(page)).toEqual([]);
  await page.evaluate(() => document.body.setAttribute("style", "color: red"));
  await expect.poll(() => violations(page)).not.toEqual([]);
});

test.describe("Reduce Transparency", () => {
  const filled = { light: "rgb(242, 242, 244)", dark: "rgb(42, 42, 46)" };
  for (const scheme of ["light", "dark"] as const) {
    test.describe(scheme, () => {
      test.use({ colorScheme: scheme });
      const root = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector(".surface")!).backgroundColor);

      test(`[tray-app C71] leaves the page transparent over the OS material (${scheme})`, async ({ page }) => {
        await open(page, snapshot({ reduceTransparency: false }));
        await page.getByRole("tab", { name: "Status" }).waitFor();
        expect(await root(page)).toBe("rgba(0, 0, 0, 0)");
      });

      test(`[tray-app C71] fills the page with ${filled[scheme]} under Reduce Transparency (${scheme})`, async ({ page }) => {
        await open(page, snapshot({ reduceTransparency: true }));
        await page.getByRole("tab", { name: "Status" }).waitFor();
        expect(await root(page)).toBe(filled[scheme]);
      });
    });
  }

  test("[tray-app C71] fills the page when the system asks for Increase Contrast", async ({ page }) => {
    await page.emulateMedia({ contrast: "more" });
    await open(page, snapshot({ reduceTransparency: false }));
    await page.getByRole("tab", { name: "Status" }).waitFor();
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".surface")!).backgroundColor)).toBe(filled.light);
  });
});

test.describe("Reduce Motion", () => {
  const march = (page: Page) =>
    page.evaluate(() => getComputedStyle(document.querySelector(".route-busy")!, "::before").animationName);

  test("[tray-app C89] walks the route dots while a check runs and stops them under Reduce Motion", async ({ page, browser }) => {
    await open(page, snapshot({ checking: true }));
    await page.locator(".route-busy").first().waitFor();
    expect(await march(page)).toBe("march");

    const calm = await browser.newContext({ reducedMotion: "reduce" });
    const still = await calm.newPage();
    await open(still, snapshot({ checking: true }));
    await still.locator(".route-busy").first().waitFor();
    expect(await march(still)).toBe("none");
    expect(await still.evaluate(() => getComputedStyle(document.querySelector("svg.motion-safe\\:animate-\\[spin_1\\.1s_linear_infinite\\]")!).animationName)).toBe("none");
    await calm.close();
  });
});

test("[tray-app C89] shows the Set Up view when nothing is set up", async ({ page }) => {
  await open(page, notSetUp());
  await expect(page.getByRole("heading", { name: "1. Create a dedicated key on this Mac" })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  expect(await styled(page)).toBe(0);
});
