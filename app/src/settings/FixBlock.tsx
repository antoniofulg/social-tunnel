// A failed hop's detail and full fix with `Copy Fix`. Text only: nothing here sets markup.
import { useState } from "react";
import { copyFix } from "../ipc";
import { HOP_NAMES, type Tone } from "../route";
import type { Hop } from "../types";
import { Button } from "./Button";
import { Stat } from "./Stat";

const TINT: Partial<Record<Tone, string>> = { warn: "bg-warn-bg", down: "bg-down-bg" };

export function FixBlock({ hop, tone }: { hop: Hop; tone: "warn" | "down" }) {
  const [copy, setCopy] = useState<"idle" | "copied" | "failed">("idle");

  function onCopy() {
    copyFix(hop.hop).then(
      () => setCopy("copied"),
      () => setCopy("failed"),
    );
  }

  return (
    <div className={`mt-2 grid grid-cols-[16px_1fr] gap-x-[9px] rounded-box px-3 py-2.5 shadow-[inset_0_0_0_.5px_var(--hairline)] ${TINT[tone]}`}>
      <span className="mt-px">
        <Stat tone={tone} />
      </span>
      <div className="min-w-0 select-text">
        <p className="m-0 break-words">
          <strong>{HOP_NAMES[hop.hop] ?? hop.hop}:</strong> {hop.detail}
        </p>
        {hop.fix !== "" && (
          <>
            <p className="mt-0.5 mb-0 break-words whitespace-pre-wrap text-text-2">{hop.fix}</p>
            <div className="mt-2 flex items-center gap-2 select-none">
              <Button small onClick={onCopy}>
                Copy Fix
              </Button>
              <span role="status" className="text-xs text-text-2">
                {copy === "copied" && "Copied."}
                {copy === "failed" && "Nothing was copied."}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
