import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { snapshot } from "../fixtures";
import { installIpc } from "../test-support";
import type { DomainRevision, DomainView } from "../types";
import { DomainsTab } from "./DomainsTab";

const base: DomainRevision = { revision: 7, domains: ["example.com", "www.example.com"] };
const id = "1.7.0123456789abcdef0123456789abcdef";
const ready = (active = base): DomainView => ({ state: "ready", active, pending: null });
const unknown: DomainView = { state: "activation_unknown", active: null, pending: null };
const pending: DomainView = {
  state: "pending", active: null,
  pending: { operationId: id, operation: "add", host: "wipo.int", phase: "claimed", pendingMayGoDirect: true },
};
const managed = (active: DomainRevision | null = base, state: DomainView["state"] = active ? "ready" : "activation_unknown") => {
  const snap = snapshot();
  snap.status!.managedDomains = { state, active, pending: null };
  return snap;
};
const field = () => screen.getByRole<HTMLInputElement>("textbox", { name: "Add domain" });
const add = () => screen.getByRole("button", { name: "Add" });

async function stage(answers: Record<string, (args: unknown) => unknown> = {}, active: DomainRevision | null = base) {
  const ipc = installIpc({ answers: { get_domains: () => active ? ready(active) : unknown, ...answers } });
  const ui = render(<DomainsTab snapshot={managed(active)} />);
  if (active) await waitFor(() => expect(field().readOnly).toBe(false));
  else await screen.findByText("Couldn't confirm the new routing.");
  return { ...ui, ipc };
}

it("[domains C12] submits the labelled form, waits for the same operation and never adds an optimistic row", async () => {
  const next = { revision: 8, domains: [...base.domains, "wipo.int"] };
  const { ipc, rerender } = await stage({ edit_domain: () => pending, retry_domain_edit: () => ({ state: "applied", active: next, pending: null }) });
  fireEvent.change(field(), { target: { value: "wipo.int" } });
  fireEvent.submit(field().form!); // WebKit proof exercises actual Enter in the same form.
  await screen.findByText("Until applied, this domain may still go directly from the server.");
  expect(ipc.calls("edit_domain")).toEqual([{ operation: "add", host: "wipo.int", expectedRevision: 7 }]);
  expect(within(screen.getByRole("list", { name: "Last verified domains" })).queryByText("wipo.int")).toBeNull();
  expect(add().getAttribute("aria-disabled")).toBe("true");
  fireEvent.submit(field().form!);
  expect(ipc.calls("edit_domain")).toHaveLength(1);
  rerender(<DomainsTab snapshot={managed(next)} />);
  await screen.findByText("Applied to new connections in the enrolled browser.");
  expect(ipc.calls("retry_domain_edit")).toEqual([{ operationId: id }]);
  expect(within(screen.getByRole("list", { name: "Domains that use home internet" })).getByText("wipo.int")).toBeTruthy();
  expect(field().value).toBe("");
});

it("[domains C12] keeps the draft on duplicate and conflict, and refreshes without replaying the edit", async () => {
  let calls = 0;
  const { ipc } = await stage({ edit_domain: () => Promise.reject({ code: ++calls === 1 ? "duplicate_domain" : "conflict", message: "private payload" }) });
  fireEvent.change(field(), { target: { value: "wipo.int" } });
  fireEvent.submit(field().form!);
  await screen.findByText("That hostname is already selected.");
  expect(field().value).toBe("wipo.int");
  expect(field().getAttribute("aria-describedby")).toContain("managed-domain-error");
  expect(field()).toBe(document.activeElement);
  await waitFor(() => expect(field().readOnly).toBe(false));
  fireEvent.submit(field().form!);
  await screen.findByText("The managed revision changed or another operation is pending.");
  await waitFor(() => expect(ipc.calls("get_domains")).toHaveLength(2));
  expect(field().value).toBe("wipo.int");
  expect(screen.queryByText("private payload")).toBeNull();
  expect(ipc.calls("edit_domain")).toHaveLength(2);
});

it("[domains C12] confirms a named removal, keeps covered routes clear, and supports keyboard cancel", async () => {
  const { ipc } = await stage({ edit_domain: () => ({ ...pending, pending: { ...pending.pending!, operation: "remove", host: "example.com", pendingMayGoDirect: false } }) });
  const child = screen.getByRole("button", { name: "Remove www.example.com" });
  fireEvent.click(child);
  const confirmation = screen.getByRole("group", { name: "Remove www.example.com?" });
  expect(confirmation.textContent).toContain("because example.com covers it");
  const cancel = within(confirmation).getByRole("button", { name: "Cancel" });
  expect(cancel).toBe(document.activeElement);
  fireEvent.keyDown(cancel, { key: "Escape" });
  expect(document.activeElement).toBe(child);
  expect(ipc.calls("edit_domain")).toEqual([]);
  fireEvent.click(screen.getByRole("button", { name: "Remove example.com" }));
  const remove = screen.getByRole("group", { name: "Remove example.com?" });
  expect(remove.textContent).toContain("may go directly from the server");
  fireEvent.click(within(remove).getByRole("button", { name: "Remove" }));
  await screen.findByText("Waiting for the tunnel and enrolled browser to confirm the change.");
  expect(ipc.calls("edit_domain")).toEqual([{ operation: "remove", host: "example.com", expectedRevision: 7 }]);
});

it("[domains C12] distinguishes legacy, unknown, recovery and verified empty", async () => {
  let response: DomainView = { state: "setup_required", active: null, pending: null };
  installIpc({ answers: { get_domains: () => response } });
  const first = render(<DomainsTab snapshot={snapshot()} />);
  await screen.findByText("Automatic domain updates aren't set up.");
  expect(screen.getByRole("list", { name: "Configured domains (not verified)" })).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Add domain" })).toBeNull();
  first.unmount();
  response = unknown;
  const second = render(<DomainsTab snapshot={managed(null)} />);
  await screen.findByText("Couldn't confirm the new routing.");
  expect(screen.queryByText("No domains use the tunnel.")).toBeNull();
  expect(field().readOnly).toBe(true);
  response = { ...unknown, state: "recovery_required", pending: pending.pending };
  second.rerender(<DomainsTab snapshot={managed(null, "recovery_required")} />);
  await screen.findByText("Domain changes are paused. The server administrator needs to reconcile the policy.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(add().getAttribute("aria-disabled")).toBe("true");
  response = ready({ revision: 9, domains: [] });
  second.rerender(<DomainsTab snapshot={managed(response.active)} />);
  await screen.findByText("No domains use the tunnel.");
  expect(field().readOnly).toBe(false);
});

it("[domains C12] bounds pending refreshes and offers manual Retry of only the saved ID", async () => {
  const { ipc } = await stage({ edit_domain: () => pending, retry_domain_edit: () => unknown });
  vi.useFakeTimers();
  try {
    fireEvent.change(field(), { target: { value: "wipo.int" } });
    fireEvent.submit(field().form!);
    await act(async () => {});
    for (let i = 0; i < 7; i++) await act(async () => { await vi.advanceTimersByTimeAsync(2500); });
    expect(ipc.calls("retry_domain_edit")).toEqual(Array.from({ length: 4 }, () => ({ operationId: id })));
    expect(screen.getByText("Couldn't confirm the new routing.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(ipc.calls("retry_domain_edit").at(-1)).toEqual({ operationId: id });
    expect(ipc.calls("edit_domain")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});
