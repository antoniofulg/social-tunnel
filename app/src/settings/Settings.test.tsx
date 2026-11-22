// Settings component proofs: checks C57-C70 and C73, C89 (plan criteria 57-70, 73, 89).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CONFIG_PATH, DOMAINS, FINGERPRINT, FIX_KEY, FIX_PORT, KEY_BODY_MARKER, KEY_PATH, doctor, keyChanged, notSetUp, portRefused, snapshot, unreadable } from "../fixtures";
import { installIpc } from "../test-support";
import type { Snapshot, View } from "../types";
import { Settings } from "./Settings";

async function open(snap: Snapshot | null | "never", opts: { view?: View; answers?: Record<string, (args: unknown) => unknown> } = {}) {
  const ipc = installIpc({ snapshot: snap, answers: opts.answers });
  const view = await act(async () => render(<Settings initialView={opts.view} />));
  return { ipc, ...view };
}

const STOPS = ["This Mac", "Server", "Tunnel port", "Domains"];
const TAB_NAMES = ["Status", "Server", "Domains", "General"];

/** The word under each stop, from the route strip. */
function stopWords() {
  const strip = screen.getByRole("list", { name: /Checks, from this Mac outward/ });
  return within(strip)
    .getAllByRole("listitem")
    .map((li) => Array.from(li.querySelectorAll("span")).at(-1)?.textContent);
}

describe("route strip and tabs", () => {
  it("[tray-app C57] shows the four stops before the tablist with its four tabs, in order", async () => {
    const { container } = await open(snapshot());
    const strip = screen.getByRole("list", { name: /Checks, from this Mac outward/ });
    const stops = within(strip).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(stops).toHaveLength(4);
    STOPS.forEach((name, i) => expect(stops[i]).toContain(name));
    const tablist = screen.getByRole("tablist");
    expect(strip.compareDocumentPosition(tablist) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(tablist).getAllByRole("tab").map((t) => t.textContent)).toEqual(TAB_NAMES);
    expect(container.querySelector("[aria-selected=true]")?.textContent).toBe("Status");
  });

  it("[tray-app C58] moves focus and selection with Left and Right Arrow, wrapping at the ends", async () => {
    await open(snapshot());
    const tab = (name: string) => screen.getByRole("tab", { name });
    tab("Status").focus();
    fireEvent.keyDown(tab("Status"), { key: "ArrowRight" });
    expect(tab("Server").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Server"));
    fireEvent.keyDown(tab("Server"), { key: "ArrowLeft" });
    fireEvent.keyDown(tab("Status"), { key: "ArrowLeft" });
    expect(tab("General").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("General"));
    fireEvent.keyDown(tab("General"), { key: "ArrowRight" });
    expect(tab("Status").getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(tab("Status"));
  });
});

describe("stop words", () => {
  const cases: [string, Snapshot, string[]][] = [
    ["all OK, no domain hop", snapshot(), ["OK", "OK", "OK", "OK"]],
    ["ssh_auth failed with exit 13", keyChanged(), ["OK", "Key changed", "Skipped", "Skipped"]],
    ["forward refused with exit 11", portRefused(), ["OK", "OK", "Refused", "Skipped"]],
    ["domain failed with exit 12", snapshot({ doctor: doctor({ withDomain: true, failAt: "domain", exit: 12, detail: "not on the allowlist" }) }), ["OK", "Skipped", "Skipped", "Refused"]],
    ["server_reachable failed with exit 10", snapshot({ doctor: doctor({ failAt: "server_reachable", exit: 10, detail: "no TCP connection" }) }), ["OK", "Failed", "Skipped", "Skipped"]],
    ["everything skipped after a config failure", snapshot({ doctor: doctor({ failAt: "config", exit: 2, detail: "bad config" }) }), ["Failed", "Skipped", "Skipped", "Skipped"]],
    ["no doctor result yet", snapshot({ doctor: null }), ["Not checked", "Not checked", "Not checked", "Not checked"]],
  ];
  for (const [name, snap, words] of cases) {
    it(`[tray-app C59] words ${name}`, async () => {
      await open(snap);
      expect(stopWords()).toEqual(words);
    });
  }

  it("[tray-app C59] words a Domains stop with a passing domain hop OK and a skipped one Skipped", async () => {
    await open(snapshot({ doctor: doctor({ withDomain: true }) }));
    expect(stopWords()).toEqual(["OK", "OK", "OK", "OK"]);
  });
});

describe("Status tab", () => {
  it("[tray-app C60] lists the 8 hops in order and gives the failed forward hop its detail, full fix and Copy Fix", async () => {
    const withDomain = snapshot({ doctor: doctor({ withDomain: true }) });
    const first = await open(withDomain);
    const names = within(screen.getByRole("list", { name: "Doctor checks" }))
      .getAllByRole("listitem")
      .map((li) => li.querySelector("div > div > span")?.textContent);
    expect(names).toEqual(["Config file", "Domain", "Tunnel key", "Server reachable", "SSH sign-in", "Tunnel port", "Lock-down", "Internet from this Mac"]);
    first.unmount();

    const { ipc } = await open(portRefused());
    const rows = within(screen.getByRole("list", { name: "Doctor checks" })).getAllByRole("listitem");
    const row = rows.find((li) => li.textContent?.includes("Tunnel port"))!;
    expect(within(row).getByText("Failed")).toBeTruthy();
    expect(row.textContent).toContain("the server refused a remote forward on 127.0.0.1:8888");
    expect(row.textContent).toContain(FIX_PORT);
    await act(async () => fireEvent.click(within(row).getByRole("button", { name: "Copy Fix" })));
    expect(ipc.calls("copy_fix")).toEqual([{ hop: "forward" }]);
    // Skipped hops say Skipped; passing hops say OK with their detail.
    expect(within(rows[0]).getByText("OK")).toBeTruthy();
    expect(within(rows.at(-1)!).getByText("Skipped")).toBeTruthy();
  });

  it("[tray-app C61] runs one check on Check Again, reads Checking… until it ends and ignores a second press", async () => {
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    const { ipc } = await open(snapshot(), { answers: { run_check: () => gate } });
    const press = () => fireEvent.click(screen.getByRole("button", { name: /Check Again|Checking…/ }));
    await act(async () => press());
    expect(ipc.calls("run_check")).toHaveLength(1);
    expect(stopWords()).toEqual(["Checking…", "Checking…", "Checking…", "Checking…"]);
    await act(async () => press());
    expect(ipc.calls("run_check")).toHaveLength(1);
    await act(async () => finish());
    await waitFor(() => expect(stopWords()).toEqual(["OK", "OK", "OK", "OK"]));
    expect(screen.getByRole("button", { name: "Check Again" })).toBeTruthy();
  });

  it("[tray-app C63] shows the stop names, the tab labels and Checking… before the first snapshot", async () => {
    await open("never");
    STOPS.forEach((name) => expect(screen.getAllByText(name).length).toBeGreaterThan(0));
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(TAB_NAMES);
    expect(stopWords()).toEqual(["Checking…", "Checking…", "Checking…", "Checking…"]);
  });

  it("[tray-app C64] shows Can't read the tunnel status. and every stop Not checked for an unreadable status", async () => {
    await open(unreadable());
    expect(screen.getByText("Can't read the tunnel status.")).toBeTruthy();
    expect(stopWords()).toEqual(["Not checked", "Not checked", "Not checked", "Not checked"]);
  });
});

const select = (name: string) => fireEvent.click(screen.getByRole("tab", { name }));

describe("Server, Domains and General tabs", () => {
  it("[tray-app C65] shows host, SSH port, tunnel user, fingerprint, key path and tunnel port, and no key content", async () => {
    const { container } = await open(snapshot());
    select("Server");
    const labels = Array.from(container.querySelectorAll("dt")).map((dt) => dt.textContent);
    expect(labels).toEqual(["Server", "SSH port", "Tunnel user", "Server key", "Key file", "Tunnel port"]);
    const values = Array.from(container.querySelectorAll("dd")).map((dd) => dd.textContent);
    expect(values).toEqual(["vps.example.com", "22", "sotunnel", FINGERPRINT, KEY_PATH, "8888"]);
    expect(FINGERPRINT.startsWith("SHA256:")).toBe(true);
    expect(container.textContent).not.toContain("PRIVATE KEY");
    expect(container.textContent).not.toContain(KEY_BODY_MARKER);
    expect(container.querySelector("textarea")).toBeNull();
    expect(container.querySelector("input")).toBeNull();
  });

  it("[tray-app C66] lists the domains in order under their count, with no control to change them", async () => {
    const { container, unmount } = await open(snapshot());
    select("Domains");
    expect(screen.getByRole("heading", { name: "5 domains use home internet" })).toBeTruthy();
    const items = within(screen.getByRole("list", { name: "Domains that use home internet" })).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(DOMAINS);
    expect(container.querySelector("input, textarea, select")).toBeNull();
    expect(within(screen.getByRole("tabpanel")).queryAllByRole("button")).toHaveLength(0);
    expect(container.textContent).not.toContain("Remove");
    unmount();

    const one = snapshot();
    one.status!.allowlist = ["instagram.com"];
    const single = await open(one);
    select("Domains");
    expect(screen.getByRole("heading", { name: "1 domain uses home internet" })).toBeTruthy();
    single.unmount();
  });

  it("[tray-app C67] checks Open at login from the snapshot and calls set_open_at_login with false on click", async () => {
    const { ipc } = await open(snapshot({ openAtLogin: true }), { answers: { set_open_at_login: () => false } });
    select("General");
    const box = screen.getByRole("checkbox", { name: "Open at login" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await act(async () => fireEvent.click(box));
    expect(ipc.calls("set_open_at_login")).toEqual([{ enabled: false }]);
    // The checkmark shows what the call read back.
    expect(box.checked).toBe(false);
  });

  it("[tray-app C67] keeps the checkmark and says so when the login item cannot change", async () => {
    await open(snapshot({ openAtLogin: false }), { answers: { set_open_at_login: () => Promise.reject("autostart_failed") } });
    select("General");
    const box = screen.getByRole("checkbox", { name: "Open at login" }) as HTMLInputElement;
    await act(async () => fireEvent.click(box));
    expect(box.checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toBe("Couldn't change Open at login.");
  });
});

describe("Set Up view", () => {
  it("[tray-app C68] shows the four step titles in order, the config path in step 3 and Check Again", async () => {
    const { container } = await open(notSetUp(), { view: "setup" });
    const titles = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual([
      "1. Create a dedicated key on this Mac",
      "2. Prepare the server (once, as root)",
      "3. Write the config on this Mac",
      "4. Check every hop",
    ]);
    const step3 = screen.getByRole("heading", { name: "3. Write the config on this Mac" }).parentElement!;
    expect(step3.textContent).toContain(CONFIG_PATH);
    expect(screen.getByRole("button", { name: "Check Again" })).toBeTruthy();
    expect(container.textContent).toContain("social-tunnel never sees passwords or codes.");
  });

  it("[tray-app C68] opens the Set Up view by itself when nothing is set up", async () => {
    await open(notSetUp());
    expect(screen.getByRole("heading", { name: "1. Create a dedicated key on this Mac" })).toBeTruthy();
  });

  it("[tray-app C69] switches to the Status tab when a snapshot event brings a readable status", async () => {
    const { ipc } = await open(notSetUp(), { view: "setup" });
    expect(screen.queryByRole("tablist")).toBeNull();
    ipc.emit("snapshot", snapshot());
    expect(screen.getByRole("tab", { name: "Status" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("heading", { name: "3. Write the config on this Mac" })).toBeNull();
  });

  it("[tray-app C69] stays on Set Up while the status is still unreadable", async () => {
    const { ipc } = await open(notSetUp(), { view: "setup" });
    ipc.emit("snapshot", unreadable());
    expect(screen.getByRole("heading", { name: "4. Check every hop" })).toBeTruthy();
  });

  it("[tray-app C70] opens on the Server tab with the pinned fingerprint and the full ssh_auth fix", async () => {
    await open(keyChanged(), { view: "server" });
    expect(screen.getByRole("tab", { name: "Server" }).getAttribute("aria-selected")).toBe("true");
    const panel = screen.getByRole("tabpanel");
    expect(panel.textContent).toContain(FINGERPRINT);
    expect(panel.textContent).toContain(FIX_KEY);
  });

  it("[tray-app C70] follows a settings-view event from Rust to the Server tab", async () => {
    const { ipc } = await open(keyChanged());
    ipc.emit("settings-view", "server");
    expect(screen.getByRole("tab", { name: "Server" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("text only", () => {
  const hostile = '<img src=x onerror=alert(1)>';
  it("[tray-app C73] renders a hostile domain, host, path, detail and fix as literal text", async () => {
    const snap = keyChanged();
    snap.status!.allowlist = [hostile, "<b>bold.example</b>"];
    snap.status!.server.host = "<b>host</b>";
    snap.status!.keyPath = "<i>/path</i>";
    snap.doctor = doctor({ failAt: "ssh_auth", exit: 13, detail: "<img src=x onerror=alert(2)>", fix: "<script>alert(3)</script>" });
    const { container } = await open(snap);
    const bad = () => container.querySelectorAll("img, b, i, script");
    expect(bad()).toHaveLength(0);
    expect(container.textContent).toContain("<img src=x onerror=alert(2)>");
    expect(container.textContent).toContain("<script>alert(3)</script>");
    select("Server");
    expect(container.textContent).toContain("<b>host</b>");
    expect(container.textContent).toContain("<i>/path</i>");
    expect(bad()).toHaveLength(0);
    select("Domains");
    expect(container.textContent).toContain(hostile);
    expect(container.textContent).toContain("<b>bold.example</b>");
    expect(bad()).toHaveLength(0);
    expect(container.querySelectorAll("[onerror]")).toHaveLength(0);
  });
});

describe("inline styles", () => {
  const states: [string, Snapshot | null | "never", View?][] = [
    ["loading", "never"],
    ["all OK", snapshot()],
    ["port refused", portRefused()],
    ["key changed", keyChanged()],
    ["unreadable", unreadable()],
    ["no doctor result", snapshot({ doctor: null })],
    ["reduce transparency", snapshot({ reduceTransparency: true })],
    ["checking", snapshot({ checking: true })],
    ["set up", notSetUp(), "setup"],
  ];
  for (const [name, snap, view] of states) {
    it(`[tray-app C89] carries no style attribute on any tab in the ${name} state`, async () => {
      const { container } = await open(snap, { view });
      const check = () => expect(container.querySelectorAll("[style]")).toHaveLength(0);
      check();
      if (view !== "setup") {
        for (const tab of TAB_NAMES) {
          select(tab);
          check();
        }
      }
    });
  }
});
