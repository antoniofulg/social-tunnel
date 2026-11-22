// The token table and the surface rule, read from the stylesheet (checks C71, C72).
import { act, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { snapshot } from "./fixtures";
import { Settings } from "./settings/Settings";
import { installIpc } from "./test-support";
import { createElement } from "react";

const css = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

/** Body of the first rule whose selector is `selector` (optionally inside the dark media query). */
function block(selector: string, dark: boolean) {
  const scope = dark ? css.slice(css.indexOf("@media (prefers-color-scheme: dark)")) : css;
  const start = scope.indexOf(`${selector} {`);
  return scope.slice(start, scope.indexOf("}", start));
}

// docs/design/README.md Tokens, mapped to the roles of uiux.md.
const ROLES: Record<string, [string, string]> = {
  "--text": ["#1c1c1e", "#f0f0f3"],
  "--text-2": ["#46464b", "#bcbcc4"],
  "--text-3": ["#6c6c72", "#9a9aa2"],
  "--window": ["rgba(244, 244, 247, 0.8)", "rgba(30, 30, 34, 0.78)"],
  "--solid": ["#f2f2f4", "#2a2a2e"],
  "--tile": ["rgba(255, 255, 255, 0.42)", "rgba(255, 255, 255, 0.08)"],
  "--well": ["rgba(0, 0, 0, 0.055)", "rgba(0, 0, 0, 0.3)"],
  "--hairline": ["rgba(0, 0, 0, 0.13)", "rgba(255, 255, 255, 0.15)"],
  "--ok": ["#1b7f3b", "#45c869"],
  "--warn": ["#8f5d00", "#e4b643"],
  "--down": ["#c4252f", "#ff7a72"],
  "--busy": ["#46464b", "#bcbcc4"],
  "--skip": ["#6b6b70", "#a3a3ab"],
};

describe("tokens", () => {
  it("[tray-app C72] defines each of the 13 design roles with its light value and its dark value", () => {
    expect(Object.keys(ROLES)).toHaveLength(13);
    const light = block(":root", false);
    const dark = block(":root", true);
    for (const [role, [lightValue, darkValue]] of Object.entries(ROLES)) {
      expect(light, `${role} light`).toContain(`${role}: ${lightValue};`);
      expect(dark, `${role} dark`).toContain(`${role}: ${darkValue};`);
    }
    expect(css).toContain("@media (prefers-color-scheme: dark)");
  });
});

describe("surface", () => {
  it("[tray-app C71] leaves the page transparent for the OS material and fills it with the solid token under Reduce Transparency", async () => {
    expect(block(".surface", false)).toContain("background: transparent;");
    expect(block('.surface[data-surface="solid"]', false)).toContain("background: var(--solid);");
    // --solid is #f2f2f4 in light and #2a2a2e in dark (C72 above); Increase Contrast and the media
    // feature of the same preference fill it too.
    expect(css).toMatch(/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\) \{\s*\.surface \{\s*background: var\(--solid\);/);

    for (const [flag, surface] of [[false, "glass"], [true, "solid"]] as const) {
      installIpc({ snapshot: snapshot({ reduceTransparency: flag }) });
      const { container, unmount } = await act(async () => render(createElement(Settings)));
      expect(container.firstElementChild?.getAttribute("data-surface")).toBe(surface);
      expect(container.firstElementChild?.classList.contains("surface")).toBe(true);
      unmount();
    }
  });
});
