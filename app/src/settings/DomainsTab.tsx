import type { Snapshot } from "../types";

const heading = (n: number) => (n === 1 ? "1 domain uses home internet" : `${n} domains use home internet`);

// Read-only: editing the allowlist is out of scope for v0.2.
export function DomainsTab({ snapshot }: { snapshot: Snapshot | null }) {
  const list = snapshot?.status?.allowlist ?? [];
  if (list.length === 0) return <p className="m-0 text-text-2">No domains to show.</p>;
  return (
    <div>
      <h2 className="m-0 mb-2 text-[15px] font-semibold">{heading(list.length)}</h2>
      <ul aria-label="Domains that use home internet" className="m-0 list-none rounded-box bg-tile p-0 shadow-[inset_0_0_0_.5px_var(--hairline)]">
        {list.map((domain) => (
          <li key={domain} className="flex min-h-8 items-center border-t-[.5px] border-hairline px-[11px] py-[3px] first:border-t-0">
            <code className="font-mono text-[11.5px] break-all select-text">{domain}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}
