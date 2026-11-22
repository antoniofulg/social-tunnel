// Segmented tabs. Left and Right move focus and selection, wrapping at the ends.
import { useRef, type KeyboardEvent } from "react";
import { TABS, type Tab } from "../types";

const LABEL: Record<Tab, string> = { status: "Status", server: "Server", domains: "Domains", general: "General" };

export const tabId = (tab: Tab) => `tab-${tab}`;
export const panelId = (tab: Tab) => `panel-${tab}`;

export function Tabs({ selected, onSelect }: { selected: Tab; onSelect: (tab: Tab) => void }) {
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());

  function onKeyDown(event: KeyboardEvent, tab: Tab) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length];
    onSelect(next);
    buttons.current.get(next)?.focus();
  }

  return (
    <div role="tablist" aria-label="Settings sections" className="inline-flex rounded-box bg-well p-0.5">
      {TABS.map((tab) => (
        <button
          key={tab}
          ref={(el) => {
            if (el) buttons.current.set(tab, el);
            else buttons.current.delete(tab);
          }}
          type="button"
          role="tab"
          id={tabId(tab)}
          aria-selected={tab === selected}
          aria-controls={panelId(tab)}
          tabIndex={tab === selected ? 0 : -1}
          onClick={() => onSelect(tab)}
          onKeyDown={(event) => onKeyDown(event, tab)}
          className={`h-6 rounded-control px-3.5 text-[13px] ${
            tab === selected ? "bg-btn font-medium shadow-[0_.5px_2px_rgba(0,0,0,.25)]" : ""
          }`}
        >
          {LABEL[tab]}
        </button>
      ))}
    </div>
  );
}
