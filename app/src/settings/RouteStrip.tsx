// Concept B's route: four stops, a mark, a name and a word each, joined by a line that is solid up
// to the stops reached and dotted beyond.
import { STOP_NAMES, TONE, type Word } from "../route";
import { Stat } from "./Stat";

const SEGMENT = {
  solid: "before:h-0.5 before:bg-ok",
  dotted: "before:h-0 before:border-t-2 before:border-dotted before:border-skip",
  busy: "route-busy",
} as const;

function segment(index: number, word: Word) {
  if (index === 0) return "before:hidden";
  if (word === "Checking…") return SEGMENT.busy;
  return word === "OK" || word === "Refused" ? SEGMENT.solid : SEGMENT.dotted;
}

export function RouteStrip({ words }: { words: readonly Word[] }) {
  return (
    <ol aria-label="Checks, from this Mac outward" className="m-0 grid list-none grid-cols-4 p-0">
      {STOP_NAMES.map((name, i) => (
        <li
          key={name}
          className={`relative grid justify-items-center gap-0.5 text-center text-[11px] leading-[1.3] before:absolute before:top-[7px] before:right-[calc(50%+12px)] before:w-[calc(100%-24px)] before:rounded-sm ${segment(i, words[i])}`}
        >
          <Stat tone={TONE[words[i]]} />
          <span className="mt-[3px] font-medium">{name}</span>
          <span className="text-text-2">{words[i]}</span>
        </li>
      ))}
    </ol>
  );
}
