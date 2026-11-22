// Concept A's doctor list: every hop in doctor's order with its word and detail; the failed hop
// carries its full fix.
import { HOP_NAMES, TONE, type Tone, type Word } from "../route";
import type { Doctor, Hop } from "../types";
import { FixBlock } from "./FixBlock";
import { Stat } from "./Stat";

function row(hop: Hop, exit: number): { word: Word; tone: Tone } {
  if (hop.ok) return { word: "OK", tone: "ok" };
  if (hop.skipped) return { word: "Skipped", tone: "off" };
  // A refused port or a refused domain is the allowlist and the server working, not the Mac failing.
  return { word: "Failed", tone: exit === 11 || exit === 12 ? "warn" : TONE.Failed };
}

export function HopList({ doctor }: { doctor: Doctor }) {
  return (
    <ul aria-label="Doctor checks" className="m-0 list-none rounded-box bg-tile p-0 shadow-[inset_0_0_0_.5px_var(--hairline)]">
      {doctor.hops.map((hop) => {
        const { word, tone } = row(hop, doctor.exit);
        const failed = !hop.ok && !hop.skipped;
        return (
          <li key={hop.hop} className="border-t-[.5px] border-hairline px-[11px] py-1.5 first:border-t-0">
            <div className="flex min-h-[26px] items-start gap-2 pt-[5px]">
              <span className="mt-0.5">
                <Stat tone={tone} />
              </span>
              <div className="min-w-0 flex-1">
                <span>{HOP_NAMES[hop.hop] ?? hop.hop}</span>
                {hop.ok && <p className="m-0 break-words text-xs text-text-2 select-text">{hop.detail}</p>}
              </div>
              <span className="text-text-2">{word}</span>
            </div>
            {failed && <FixBlock key={doctor.startedAt} hop={hop} tone={tone === "warn" ? "warn" : "down"} />}
          </li>
        );
      })}
    </ul>
  );
}
