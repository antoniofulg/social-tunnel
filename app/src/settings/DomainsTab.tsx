import { useEffect, useLayoutEffect, useRef, useState, type SubmitEvent } from "react";
import { editDomain, getDomains, retryDomainEdit } from "../ipc";
import type { DomainEdit, DomainRevision, DomainView, Snapshot } from "../types";
import { Button } from "./Button";

const RETRY_INTERVAL_MS = 2500;
const RETRY_ATTEMPTS = 4;
const UNKNOWN: DomainView = { state: "activation_unknown", active: null, pending: null };
const SETUP: DomainView = { state: "setup_required", active: null, pending: null };
const ERRORS = {
  invalid_domain: "Use a public DNS hostname without a scheme, port, path, or wildcard.",
  duplicate_domain: "That hostname is already selected.",
  domain_not_found: "That hostname is not a selected entry.",
  invalid_revision: "The verified revision is unavailable. Refresh before editing.",
  unknown_operation: "The authority has no record of that operation.",
  operation_cancelled: "The authority cancelled that operation.",
  internal: "Managed domains could not be read.",
  not_ready: "The managed tunnel and browser have not verified the same revision.",
  conflict: "The managed revision changed or another operation is pending.",
  unavailable: "The managed authority is unavailable.",
  recovery_required: "The server administrator must reconcile this enrollment.",
} as const;
type ErrorCode = keyof typeof ERRORS;
type DomainFault = { code: ErrorCode; field: boolean };
type Confirmation = { host: string; revision: number };

function fault(reason: unknown, field: boolean): DomainFault {
  const code = typeof reason === "object" && reason !== null && "code" in reason ? reason.code : null;
  return { code: typeof code === "string" && Object.hasOwn(ERRORS, code) ? code as ErrorCode : "unavailable", field };
}

function status(view: DomainView, working: "read" | "edit" | null): string {
  if (working === "edit" && !view.pending) return "Submitting the domain change…";
  if (view.state === "recovery_required") return "Domain changes are paused. The server administrator needs to reconcile the policy.";
  if (view.state === "setup_required") return "Automatic domain updates aren't set up.";
  if (view.state === "activation_unknown") return "Couldn't confirm the new routing.";
  if (view.state === "applied") return "Applied to new connections in the enrolled browser.";
  if (view.state === "pending") return "Waiting for the tunnel and enrolled browser to confirm the change.";
  return working === "read" ? "Checking domain routing…" : "Selected domains use your home internet in the enrolled browser.";
}

export function DomainsTab({ snapshot, visible = true }: { snapshot: Snapshot | null; visible?: boolean }) {
  const [view, setView] = useState<DomainView | null>(null);
  const latestView = useRef<DomainView | null>(null);
  const [lastVerified, setLastVerified] = useState<DomainRevision | null>(null);
  const [input, setInput] = useState("");
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState<DomainFault | null>(null);
  const [working, setWorking] = useState<"read" | "edit" | null>(null);
  const [attempts, setAttempts] = useState(RETRY_ATTEMPTS);
  const instance = useRef(0);
  const inFlight = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement | null>(null);
  const queuedRead = useRef(false);
  const native = snapshot?.status?.managedDomains;
  const revision = native?.active?.revision;
  const nativeState = native?.state;
  const readable = snapshot !== null && !snapshot.statusUnreadable;
  const config = snapshot?.configPath;
  const usable = readable && !!config;
  const recovering = nativeState === "recovery_required";
  const activity = useRef({ visible, usable, recovering });
  const evidence = useRef(0);

  function publish(next: DomainView) {
    if (next.pending && next.pending.operationId !== latestView.current?.pending?.operationId) setAttempts(RETRY_ATTEMPTS);
    latestView.current = next;
    setView(next);
  }

  useLayoutEffect(() => () => {
    instance.current++;
    inFlight.current = false;
    queuedRead.current = false;
  }, []);

  useLayoutEffect(() => {
    activity.current = { visible, usable, recovering };
    if (!visible || !usable) {
      queuedRead.current = false;
      setConfirmation(null);
    }
  }, [visible, usable, recovering]);

  useLayoutEffect(() => {
    evidence.current++;
    if (latestView.current?.active) {
      publish({ ...UNKNOWN, pending: latestView.current.pending });
    }
  }, [visible, usable, nativeState, revision]);

  // Read on entry or when native evidence changes. Hidden tabs never start a call.
  useEffect(() => {
    if (!visible || !usable) return;
    if (inFlight.current) { queuedRead.current = true; return; }
    void refresh(pendingId());
  }, [visible, usable, nativeState, revision]);

  const current = view ?? (readable && !native ? SETUP : UNKNOWN);
  const pending = current.pending;
  const canRetry = pending !== null && current.state !== "setup_required" && current.state !== "recovery_required";
  const operationId = canRetry ? pending.operationId : null;

  useEffect(() => {
    if (!visible || !usable || !operationId || working || attempts === 0 || nativeState === "recovery_required") return;
    const timer = window.setTimeout(() => {
      setAttempts((n) => n - 1);
      void refresh(operationId);
    }, RETRY_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [visible, usable, operationId, working, attempts, nativeState]);

  useEffect(() => {
    if (confirmation) confirmRef.current?.querySelector("button")?.focus();
  }, [confirmation]);

  const verified = readable && native?.active && current.active && native.active.revision === current.active.revision &&
    native.active.domains.length === current.active.domains.length && native.active.domains.every((host, i) => host === current.active?.domains[i]) &&
    (current.state === "ready" || current.state === "applied") ? current.active : null;
  useLayoutEffect(() => {
    if (verified) setLastVerified(verified);
  }, [verified]);
  const editable = visible && verified !== null && !pending && working === null;
  const activeConfirmation = confirmation && verified?.revision === confirmation.revision &&
    verified.domains.includes(confirmation.host) ? confirmation : null;
  const parent = activeConfirmation && verified?.domains.find((host) => activeConfirmation.host.endsWith(`.${host}`));
  const configured = current.state === "setup_required" ? snapshot?.status?.allowlist ?? [] : [];
  const rows = verified?.domains ?? (current.state === "setup_required" ? configured : lastVerified?.domains) ?? [];
  const listLabel = verified ? "Domains that use home internet" : current.state === "setup_required" ? "Configured domains (not verified)" : "Last verified domains";
  const statusView = nativeState === "recovery_required" ? { ...UNKNOWN, state: "recovery_required" as const }
    : !verified && (current.state === "ready" || current.state === "applied") ? UNKNOWN : current;

  function pendingId() {
    const saved = latestView.current;
    return !activity.current.recovering && saved?.state !== "recovery_required" ? saved?.pending?.operationId : undefined;
  }

  async function refresh(id?: string, clearError = false) {
    if (inFlight.current || !activity.current.visible || !activity.current.usable) return;
    if (id !== undefined && activity.current.recovering) return;
    inFlight.current = true;
    const owner = instance.current;
    const started = evidence.current;
    setWorking("read");
    try {
      const next = await (id === undefined ? getDomains() : retryDomainEdit(id));
      if (instance.current !== owner) return;
      const ambiguous = next.pending ? id !== undefined && next.pending.operationId !== id :
        next.state === "activation_unknown" || next.state === "recovery_required" || (id !== undefined && next.state === "setup_required");
      const pending = ambiguous ? latestView.current?.pending ?? null : next.pending;
      const fresh = started === evidence.current && activity.current.usable && activity.current.visible;
      publish(fresh && !(ambiguous && (next.state === "setup_required" || next.pending !== null))
        ? { ...next, pending } : { ...UNKNOWN, pending });
      if (fresh && next.state === "applied" && !ambiguous) setInput("");
      if (next.state === "applied" || clearError) setError(null);
    } catch (reason) {
      if (instance.current !== owner) return;
      const e = fault(reason, false);
      setError((previous) => previous?.field ? previous : e);
      publish({ ...UNKNOWN,
        state: e.code === "recovery_required" ? "recovery_required" : "activation_unknown",
        pending: e.code === "operation_cancelled" || e.code === "unknown_operation" ? null : latestView.current?.pending ?? null,
      });
    } finally {
      release(owner);
    }
  }

  async function edit(operation: DomainEdit["operation"], host: string, expectedRevision: number) {
    if (!editable || inFlight.current) return;
    inFlight.current = true;
    const owner = instance.current;
    const started = evidence.current;
    setWorking("edit");
    setError(null);
    setConfirmation(null);
    let recheck = false;
    try {
      const next = await editDomain({ operation, host, expectedRevision });
      if (instance.current !== owner) return;
      const fresh = started === evidence.current && activity.current.usable && activity.current.visible;
      publish(fresh ? next : { ...UNKNOWN, pending: next.pending });
      if (fresh && next.state === "applied") setInput("");
      if (next.pending && fresh) queuedRead.current = false;
    } catch (reason) {
      if (instance.current !== owner) return;
      const e = fault(reason, operation === "add");
      setError(e);
      if (e.code === "recovery_required") publish({ ...UNKNOWN, state: "recovery_required" });
      else if (e.code === "conflict" || e.code === "not_ready" || e.code === "unavailable") { publish(UNKNOWN); recheck = true; }
      if (activity.current.visible && activity.current.usable) {
        if (operation === "add") inputRef.current?.focus();
        else opener.current?.focus();
      }
    } finally {
      release(owner, recheck);
    }
  }

  function release(owner: number, recheck = false) {
    if (instance.current !== owner) return;
    inFlight.current = false;
    setWorking(null);
    const read = recheck || queuedRead.current;
    queuedRead.current = false;
    if (read) void refresh(pendingId());
  }

  function add(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editable && verified && input && !activeConfirmation) void edit("add", input, verified.revision);
  }

  function cancelConfirmation() {
    setConfirmation(null);
    opener.current?.focus();
  }

  return (
    <div className="pt-1" hidden={!visible}>
      {current.state !== "setup_required" && snapshot?.status?.managedDomains && (
        <form onSubmit={add} className="mb-2.5 grid gap-[5px]">
          <label htmlFor="managed-domain" className="font-medium">Add domain</label>
          <div className="flex gap-2">
            <input id="managed-domain" ref={inputRef} value={input} onChange={(event) => { setInput(event.target.value); if (error?.field) setError(null); }}
              readOnly={!editable || !!activeConfirmation} maxLength={254} inputMode="url" autoComplete="off" autoCapitalize="none" spellCheck={false}
              placeholder="example.com" aria-invalid={error?.field || undefined}
              aria-describedby={error?.field ? "managed-domain-hint managed-domain-error" : "managed-domain-hint"}
              className="h-7 min-w-0 flex-1 rounded-control border border-field-border bg-field px-2 text-text placeholder:text-text-3 read-only:bg-well aria-invalid:border-down" />
            <Button type="submit" disabled={!editable || !input || !!activeConfirmation}>Add</Button>
          </div>
          <p id="managed-domain-hint" className="m-0 text-xs text-text-2">Public hostname only, not a URL.</p>
          {error?.field && <p id="managed-domain-error" role="alert" className="m-0 text-xs text-down">{ERRORS[error.code]}</p>}
        </form>
      )}
      {rows.length > 0 && <>
        {!verified && <h2 className="m-0 mb-1.5 text-[13px] font-semibold">{listLabel}</h2>}
        <ul aria-label={listLabel} className="m-0 mb-3 flex list-none flex-wrap gap-1.5 p-0">
          {rows.map((host, index) => (
            <li key={`${host}:${index}`} className="inline-flex min-h-7 min-w-0 max-w-full items-center gap-0.5 rounded-full bg-tile py-px pr-0.5 pl-[11px] shadow-[inset_0_0_0_.5px_var(--hairline)]">
              <code className="min-w-0 break-all font-mono text-[11.5px] select-text">{host}</code>
              {verified && <button type="button" aria-label={`Remove ${host}`} aria-disabled={!editable || !!activeConfirmation || undefined}
                onClick={(event) => {
                  if (!editable || activeConfirmation) return;
                  opener.current = event.currentTarget;
                  setError(null);
                  setConfirmation({ host, revision: verified.revision });
                }}
                className="grid size-6 shrink-0 place-items-center rounded-full text-text-2 hover:bg-hover aria-disabled:cursor-default aria-disabled:text-text-3">
                <svg viewBox="0 0 10 10" aria-hidden="true" className="size-2.5">
                  <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>}
            </li>
          ))}
        </ul>
      </>}
      {verified && rows.length === 0 && <p className="m-0 mb-3 text-text-2">No domains use the tunnel.</p>}
      {activeConfirmation && (
        <div ref={confirmRef} role="group" aria-labelledby="domain-remove-title" onKeyDown={(event) => {
          if (event.key === "Escape") { event.stopPropagation(); cancelConfirmation(); }
        }} className="mb-3 rounded-box bg-warn-bg px-3 py-2.5">
          <p id="domain-remove-title" className="m-0 break-all font-semibold">Remove {activeConfirmation.host}?</p>
          <p className="mt-1 mb-0 text-xs text-text-2">
            {parent ? <>After removal, the enrolled browser will still select the tunnel because <code className="break-all">{parent}</code> matches this domain. The home proxy may still block the connection.</>
              : "Once applied, new connections to this domain may go directly from the server."}
          </p>
          <div className="mt-2 flex justify-end gap-2">
            <Button small onClick={cancelConfirmation}>Cancel</Button>
            <Button small disabled={!editable} onClick={() => void edit("remove", activeConfirmation.host, activeConfirmation.revision)}>Remove</Button>
          </div>
        </div>
      )}
      {error && !error.field && <p role="alert" className="mt-1 mb-2 text-xs text-down">{ERRORS[error.code]}</p>}
      <div role="status" className="text-xs text-text-2">
        <p className="m-0">{!view && (snapshot === null || (native && working === "read")) ? "Checking domain routing…"
          : !readable ? "Domain routing is unavailable." : status(statusView, working)}</p>
        {pending?.host && <p className="mt-1 mb-0 break-all">{pending.operation === "add" ? "Adding" : "Removing"} <code>{pending.host}</code>.</p>}
        {pending?.pendingMayGoDirect && <p className="mt-1 mb-0">Until applied, this domain may still go directly from the server.</p>}
      </div>
      {nativeState !== "recovery_required" && (canRetry || (statusView.state === "activation_unknown" && !pending && readable && native)) && (
        <div className="mt-2">
          <Button small disabled={!usable || working !== null} onClick={() => void refresh(operationId ?? undefined, true)}>
            {canRetry ? "Retry" : "Refresh"}
          </Button>
        </div>
      )}
    </div>
  );
}
