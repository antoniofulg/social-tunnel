// Concept A's server summary: labels right-aligned, values left, monospace for hosts, ports,
// fingerprints and paths.
import type { ReactNode } from "react";

export function KeyValueList({ items }: { items: readonly (readonly [string, ReactNode])[] }) {
  return (
    <dl className="m-0 grid grid-cols-[92px_1fr] gap-x-3 gap-y-[5px]">
      {items.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-right text-text-2">{label}</dt>
          <dd className="m-0 min-w-0">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A value drawn in the mono face; `null` reads as an em dash. */
export function Mono({ children }: { children: ReactNode }) {
  if (children === null || children === undefined) return <span className="text-text-3">—</span>;
  return <code className="font-mono text-[11.5px] leading-[1.4] break-all">{children}</code>;
}
