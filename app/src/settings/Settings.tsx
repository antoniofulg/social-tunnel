import { useCallback, useState } from "react";
import { isView, runCheck } from "../ipc";
import { STOP_NAMES, stopWords, type Word } from "../route";
import { TABS, type Snapshot, type Tab, type View } from "../types";
import { DomainsTab } from "./DomainsTab";
import { GeneralTab } from "./GeneralTab";
import { RouteStrip } from "./RouteStrip";
import { ServerTab } from "./ServerTab";
import { SetUp } from "./SetUp";
import { StatusTab } from "./StatusTab";
import { Tabs, panelId, tabId } from "./Tabs";
import { useSnapshot } from "./useSnapshot";

/** `#server` and friends: a freshly built window learns its view from the URL. */
function viewFromHash(): View | null {
  const name = window.location.hash.slice(1);
  return isView(name) ? name : null;
}

const allWords = (word: Word): Word[] => STOP_NAMES.map(() => word);

export function Settings({ initialView = null }: { initialView?: View | null }) {
  const [requested, setRequested] = useState<View | null>(() => initialView ?? viewFromHash());
  const [pending, setPending] = useState(false);

  // A readable status ends the Set Up view (AC 69).
  const onSnapshot = useCallback(
    (next: Snapshot) => setRequested((view) => (view === "setup" && next.status ? "status" : view)),
    [],
  );
  const snapshot = useSnapshot(onSnapshot, setRequested);

  const view: View = requested ?? (snapshot?.trayState === "notSetUp" ? "setup" : "status");
  const busy = pending || snapshot?.checking === true;

  function onCheck() {
    if (busy) return;
    setPending(true);
    runCheck()
      .catch(() => undefined)
      .finally(() => setPending(false));
  }

  const surface = snapshot?.reduceTransparency ? "solid" : "glass";

  const words = snapshot === null || busy ? allWords("Checking…") : stopWords(snapshot.doctor, snapshot.statusUnreadable);
  const allOk = !busy && snapshot?.doctor != null && !snapshot.statusUnreadable && snapshot.doctor.hops.length > 0 && snapshot.doctor.hops.every((h) => h.ok);
  const tab: Tab = TABS.includes(view as Tab) ? (view as Tab) : "status";
  const setup = view === "setup";

  return (
    <div className={setup ? "surface h-screen overflow-y-auto overscroll-none px-[22px] py-4" : "surface flex h-screen flex-col"} data-surface={surface}>
      {setup ? <SetUp snapshot={snapshot} busy={busy} onCheck={onCheck} /> : (
        <>
          <header className="border-b-[.5px] border-hairline px-[22px] pt-3 pb-3">
            <RouteStrip words={words} />
            <p className="m-0 mt-2.5 h-4 text-center text-xs text-text-2">{allOk && "All checks OK."}</p>
          </header>
          <div className="flex justify-center px-[22px] py-3">
            <Tabs selected={tab} onSelect={setRequested} />
          </div>
        </>
      )}
      <main
        role="tabpanel"
        id={panelId(tab)}
        aria-labelledby={tabId(tab)}
        hidden={setup}
        className="min-h-0 flex-1 overflow-y-auto overscroll-none px-[22px] pb-[18px]"
      >
        {!setup && tab === "status" && <StatusTab snapshot={snapshot} busy={busy} onCheck={onCheck} />}
        {!setup && tab === "server" && <ServerTab snapshot={snapshot} />}
        <DomainsTab key={snapshot?.domainsScope ?? 0} snapshot={snapshot} visible={!setup && tab === "domains"} />
        {!setup && tab === "general" && <GeneralTab snapshot={snapshot} />}
      </main>
    </div>
  );
}
