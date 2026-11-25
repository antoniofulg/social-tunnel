export type ChromeObserverFailure = "cdp_timeout" | "cdp_invalid_frame" | "cdp_pipe_lost";
export const OBSERVER_RESTART_EXIT = 75;
const PROOF_GRACE_MS = 60_000;

type Health = { responsive: boolean; routed: boolean; browser: boolean };

export function createDomainRecovery(report: (reason: string) => void, now = () => performance.now()) {
  let fault: { owner: number | null; reachable: boolean; since: number; reported: boolean } | undefined;
  return (health: Health | null, owner: number | null, chromeFailure?: ChromeObserverFailure): string | undefined => {
    if (!health || (owner !== null && health.browser)) {
      fault = undefined;
      return;
    }
    const reachable = owner !== null && health.responsive;
    const reason = owner === null ? "forward_missing" : !reachable ? "forward_unreachable"
      : chromeFailure ?? (health.routed ? "browser_proof_stale" : "forward_receipt_unproven");
    const at = now();
    if (!fault || fault.owner !== owner || fault.reachable !== reachable) fault = { owner, reachable, since: at, reported: false };
    if (!(reachable && chromeFailure) && at - fault.since < PROOF_GRACE_MS) return;
    if (reachable) return reason;
    if (!fault.reported) {
      fault.reported = true;
      report(reason);
    }
  };
}
