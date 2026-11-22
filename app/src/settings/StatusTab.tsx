import type { Snapshot } from "../types";
import { Button } from "./Button";
import { HopList } from "./HopList";
import { Stat } from "./Stat";

interface Props {
  snapshot: Snapshot | null;
  busy: boolean;
  onCheck: () => void;
}

export function StatusTab({ snapshot, busy, onCheck }: Props) {
  const unreadable = snapshot?.statusUnreadable === true;
  return (
    <div className="grid gap-3">
      {unreadable ? (
        <div role="alert" className="flex items-center gap-[9px] rounded-box bg-down-bg px-3 py-2.5 shadow-[inset_0_0_0_.5px_var(--hairline)]">
          <Stat tone="down" />
          <span>Can't read the tunnel status.</span>
        </div>
      ) : snapshot?.doctor ? (
        <HopList doctor={snapshot.doctor} />
      ) : (
        snapshot && <p className="m-0 text-text-2">No check has run yet.</p>
      )}
      <div className="flex justify-end">
        <Button disabled={snapshot === null || busy} onClick={onCheck}>
          {busy ? "Checking…" : "Check Again"}
        </Button>
      </div>
    </div>
  );
}
