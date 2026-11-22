// Small status marks from docs/design/_src/lib.mjs `stat()`: a glyph for every tone, so colour is
// never the only signal.
import type { Tone } from "../route";

const COLOR: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  down: "text-down",
  busy: "text-busy",
  off: "text-skip",
};

const SHAPE: Record<Tone, React.ReactNode> = {
  ok: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M4.9 8.3l2.1 2.1 4.2-4.6" fill="none" stroke="var(--stat-ink)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  down: (
    <>
      <circle cx="8" cy="8" r="7" fill="currentColor" />
      <path d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8" fill="none" stroke="var(--stat-ink)" strokeWidth="1.7" strokeLinecap="round" />
    </>
  ),
  warn: (
    <>
      <path
        d="M8 1.4c.52 0 1 .28 1.26.74l5.5 9.7c.54.96-.15 2.16-1.26 2.16h-11c-1.1 0-1.8-1.2-1.26-2.16l5.5-9.7c.26-.46.74-.74 1.26-.74z"
        fill="currentColor"
      />
      <path d="M8 5.4v3.7" fill="none" stroke="var(--stat-ink)" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="8" cy="11.6" r=".95" fill="var(--stat-ink)" />
    </>
  ),
  busy: <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.7" strokeDasharray="26 11.7" strokeLinecap="round" />,
  off: <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 3.08" />,
};

export function Stat({ tone }: { tone: Tone }) {
  const spin = tone === "busy" ? " motion-safe:animate-[spin_1.1s_linear_infinite]" : "";
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={`block size-4 flex-none ${COLOR[tone]}${spin}`}>
      {SHAPE[tone]}
    </svg>
  );
}
