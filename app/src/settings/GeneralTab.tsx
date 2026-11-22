import { useState } from "react";
import { setOpenAtLogin } from "../ipc";
import type { Snapshot } from "../types";

export function GeneralTab({ snapshot }: { snapshot: Snapshot | null }) {
  // The value read back from the last call counts only while the snapshot still says what it said then.
  const [readBack, setReadBack] = useState<{ base: boolean; value: boolean } | null>(null);
  const [failed, setFailed] = useState(false);
  const base = snapshot?.openAtLogin ?? false;
  const checked = readBack && readBack.base === base ? readBack.value : base;

  function onChange() {
    setFailed(false);
    setOpenAtLogin(!checked).then(
      (value) => setReadBack({ base, value }),
      () => setFailed(true),
    );
  }

  return (
    <div>
      <label className="flex min-h-6 w-fit items-center gap-[7px]">
        <input type="checkbox" checked={checked} disabled={snapshot === null} onChange={onChange} className="m-0 size-[15px] accent-accent" />
        Open at login
      </label>
      {failed && (
        <p role="alert" className="mt-2 mb-0 text-xs text-down">
          Couldn't change Open at login.
        </p>
      )}
    </div>
  );
}
