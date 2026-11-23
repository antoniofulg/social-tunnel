import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { snapshot, unreadable } from "../fixtures";
import { installIpc } from "../test-support";
import type { DomainRevision, DomainView } from "../types";
import { DomainsTab } from "./DomainsTab";
import { Settings } from "./Settings";

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
  expect(ipc.calls("edit_domain")).toEqual([{ scope: 1, operation: "add", host: "wipo.int", expectedRevision: 7 }]);
  expect(within(screen.getByRole("list", { name: "Last verified domains" })).queryByText("wipo.int")).toBeNull();
  expect(add().getAttribute("aria-disabled")).toBe("true");
  fireEvent.submit(field().form!);
  expect(ipc.calls("edit_domain")).toHaveLength(1);
  rerender(<DomainsTab snapshot={managed(next)} />);
  await screen.findByText("Applied to new connections in the enrolled browser.");
  expect(ipc.calls("retry_domain_edit")).toEqual([{ scope: 1, operationId: id }]);
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
  expect(confirmation.textContent).toContain("the enrolled browser will still select the tunnel because example.com matches this domain");
  expect(confirmation.textContent).toContain("The home proxy may still block the connection.");
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
  expect(ipc.calls("edit_domain")).toEqual([{ scope: 1, operation: "remove", host: "example.com", expectedRevision: 7 }]);
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
    expect(ipc.calls("retry_domain_edit")).toEqual(Array.from({ length: 4 }, () => ({ scope: 1, operationId: id })));
    expect(screen.getByText("Couldn't confirm the new routing.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => {});
    expect(ipc.calls("retry_domain_edit").at(-1)).toEqual({ scope: 1, operationId: id });
    expect(ipc.calls("edit_domain")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it("[domains C12] preserves the exact pending ID and historical rows across tab switches and unreadable status", async () => {
  const edit = Promise.withResolvers<DomainView>();
  const ipc = installIpc({ snapshot: managed(), answers: {
    get_domains: () => ready(), edit_domain: () => edit.promise, retry_domain_edit: () => unknown,
  } });
  render(<Settings initialView="domains" />);
  await waitFor(() => expect(field().readOnly).toBe(false));
  fireEvent.change(field(), { target: { value: "wipo.int" } });
  fireEvent.submit(field().form!);
  fireEvent.click(screen.getByRole("tab", { name: "General" }));
  ipc.emit("snapshot", unreadable());
  await act(async () => edit.resolve(pending));
  ipc.emit("snapshot", managed(null));
  vi.useFakeTimers();
  try {
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(ipc.calls("get_domains")).toHaveLength(1);
    expect(ipc.calls("retry_domain_edit")).toEqual([]);
    ipc.emit("snapshot", unreadable());
    fireEvent.click(screen.getByRole("tab", { name: "Domains" }));
    expect(screen.getByText("Domain routing is unavailable.")).toBeTruthy();
    expect(within(screen.getByRole("list", { name: "Last verified domains" })).getByText("www.example.com")).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Domains that use home internet" })).toBeNull();
    expect(screen.getByRole("button", { name: "Retry" }).getAttribute("aria-disabled")).toBe("true");
    ipc.emit("snapshot", managed(null));
    await act(async () => {});
    expect(ipc.calls("retry_domain_edit")).toEqual([{ scope: 1, operationId: id }]);
    expect(screen.getByText("wipo.int")).toBeTruthy();
    expect(ipc.calls("edit_domain")).toHaveLength(1);
  } finally { vi.useRealTimers(); }
});

it("[domains C12] reopens by reading the durable CLI intent before offering the same-ID Retry", async () => {
  let saved = ready();
  const ipc = installIpc({ snapshot: managed(), answers: {
    get_domains: () => saved,
    edit_domain: () => { saved = { ...unknown, pending: pending.pending }; return saved; },
    retry_domain_edit: () => Promise.reject({ code: "operation_cancelled" }),
  } });
  const first = render(<Settings initialView="domains" />);
  await waitFor(() => expect(field().readOnly).toBe(false));
  fireEvent.change(field(), { target: { value: "wipo.int" } });
  fireEvent.submit(field().form!);
  await screen.findByRole("button", { name: "Retry" });
  first.unmount();

  render(<Settings initialView="domains" />);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
  await screen.findByText("The authority cancelled that operation.");
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(ipc.calls("get_domains")).toHaveLength(2);
  expect(ipc.calls("retry_domain_edit")).toEqual([{ scope: 1, operationId: id }]);
  expect(ipc.calls("edit_domain")).toHaveLength(1);
});

it("[domains C12] same-path config replacement clears rows and pending and ignores the outgoing Retry reply", async () => {
  const oldReply = Promise.withResolvers<DomainView>();
  const newRevision = { revision: 7, domains: ["wikimedia.org"] };
  let list = ready();
  const ipc = installIpc({ snapshot: managed(), answers: {
    get_domains: () => list, edit_domain: () => pending, retry_domain_edit: () => oldReply.promise,
  } });
  render(<Settings initialView="domains" />);
  await waitFor(() => expect(field().readOnly).toBe(false));
  fireEvent.change(field(), { target: { value: "wipo.int" } });
  fireEvent.submit(field().form!);
  fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

  list = ready(newRevision);
  ipc.emit("snapshot", { ...managed(newRevision), domainsScope: 2 });
  await within(await screen.findByRole("list", { name: "Domains that use home internet" })).findByText("wikimedia.org");
  await act(async () => oldReply.resolve({ ...pending, pending: { ...pending.pending!, host: "retired.example.com" } }));
  expect(screen.queryByRole("list", { name: "Last verified domains" })).toBeNull();
  expect(screen.queryByText(/retired\.example\.com|wipo\.int|www\.example\.com/)).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(ipc.calls("retry_domain_edit")).toEqual([{ scope: 1, operationId: id }]);
  expect(field().readOnly).toBe(false);
});

it("[domains C12] a late baseline snapshot cannot put the window back on an older config", async () => {
  const old = Promise.withResolvers<ReturnType<typeof snapshot>>();
  const active = { revision: 7, domains: ["wikimedia.org"] };
  const ipc = installIpc({ answers: { get_snapshot: () => old.promise, get_domains: () => ready(active) } });
  render(<Settings initialView="domains" />);
  await waitFor(() => expect(ipc.calls("get_snapshot")).toHaveLength(1));
  ipc.emit("snapshot", { ...managed(active), domainsScope: 2 });
  await screen.findByText("wikimedia.org");
  await act(async () => old.resolve(managed()));
  expect(screen.getByRole("list", { name: "Domains that use home internet" })).toBeTruthy();
  expect(ipc.calls("get_domains")).toHaveLength(1);
});

it("[domains C12] tab reentry keeps old rows historical until a fresh read confirms them", async () => {
  const onReturn = Promise.withResolvers<DomainView>();
  let lists = 0;
  const ipc = installIpc({ snapshot: managed(), answers: {
    get_domains: () => ++lists === 1 ? ready() : onReturn.promise,
  } });
  render(<Settings initialView="domains" />);
  await waitFor(() => expect(field().readOnly).toBe(false));
  fireEvent.click(screen.getByRole("tab", { name: "General" }));
  fireEvent.click(screen.getByRole("tab", { name: "Domains" }));
  expect(ipc.calls("get_domains")).toHaveLength(2);
  expect(screen.getByRole("list", { name: "Last verified domains" })).toBeTruthy();
  expect(screen.queryByRole("list", { name: "Domains that use home internet" })).toBeNull();
  expect(field().readOnly).toBe(true);
  await act(async () => onReturn.resolve(ready()));
  expect(screen.getByRole("list", { name: "Domains that use home internet" })).toBeTruthy();
  expect(field().readOnly).toBe(false);
});

it("[domains C12] confirms against the displayed scope, not an equal-revision replacement seen only by native", async () => {
  let nativeScope = 1;
  const check = (args: unknown) => {
    if ((args as { scope: number }).scope !== nativeScope) throw { code: "conflict" };
    return ready();
  };
  const ipc = installIpc({ snapshot: managed(), answers: { get_domains: check, edit_domain: check } });
  render(<Settings initialView="domains" />);
  await waitFor(() => expect(field().readOnly).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "Remove www.example.com" }));
  const confirmation = screen.getByRole("group", { name: "Remove www.example.com?" });
  nativeScope = 2; // Status and the list have identical revisions and domains; the snapshot has not arrived.
  fireEvent.click(within(confirmation).getByRole("button", { name: "Remove" }));
  await screen.findByText("The managed revision changed or another operation is pending.");
  expect(ipc.calls("edit_domain")).toEqual([{ scope: 1, operation: "remove", host: "www.example.com", expectedRevision: 7 }]);
  ipc.emit("snapshot", { ...managed(), domainsScope: 2 });
  await waitFor(() => expect(field().readOnly).toBe(false));
  expect(ipc.calls("get_domains").at(-1)).toEqual({ scope: 2 });
  expect(screen.queryByRole("group", { name: "Remove www.example.com?" })).toBeNull();
  expect(ipc.calls("edit_domain")).toHaveLength(1);
});
