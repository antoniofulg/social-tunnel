import type { DomainAttestation, WireResult } from "./domain-wire";

export function createProofOutbox(send: (proof: DomainAttestation) => Promise<WireResult>, now = () => performance.now()) {
  const queue: DomainAttestation[] = [];
  const accepted = new Map<string, number>();
  let sending: string | undefined;
  let pending: Promise<void> | undefined;
  let uncertainUntil = 0;
  // Longer than any canary lease. A missing earlier receipt must not turn into clean absence.
  const uncertain = () => { uncertainUntil = now() + 10000; };
  function drain() {
    if (pending || !queue.length) return;
    pending = (async () => {
      while (queue.length) {
        const proof = queue.shift()!;
        if (proof.host.endsWith(".barrier.pac.invalid") && now() < uncertainUntil) continue;
        sending = proof.host;
        try {
          if ((await send(proof)).ok) {
            // Chrome may retry CONNECT with the exact same one-use witness name.
            if (accepted.size >= 16) accepted.delete(accepted.keys().next().value!);
            accepted.set(proof.host, now() + 10000);
          } else uncertain();
        } catch { uncertain(); }
        finally { sending = undefined; }
      }
    })().finally(() => { pending = undefined; drain(); });
  }
  return {
    observe(proof: DomainAttestation) {
      if (sending === proof.host || queue.some(({ host }) => host === proof.host) ||
          (accepted.get(proof.host) ?? 0) > now()) return;
      if (queue.length >= 3) { uncertain(); return; }
      queue.push(proof);
      drain();
    },
    uncertain,
    clear() {
      if (pending || queue.length) uncertain();
      queue.length = 0;
    },
    settled: () => pending,
  };
}
