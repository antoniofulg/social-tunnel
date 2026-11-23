import type { DomainAttestation, WireResult } from "./domain-wire";

export function createProofOutbox(send: (proof: DomainAttestation) => Promise<WireResult>, now = () => performance.now()) {
  const queue: DomainAttestation[] = [];
  const accepted = new Map<string, number>();
  let sending: string | undefined;
  let pending: Promise<void> | undefined;
  function drain() {
    if (pending || !queue.length) return;
    pending = (async () => {
      while (queue.length) {
        const proof = queue.shift()!;
        sending = proof.host;
        try {
          if ((await send(proof)).ok) {
            // Chrome may retry CONNECT with the exact same one-use witness name.
            if (accepted.size >= 16) accepted.delete(accepted.keys().next().value!);
            accepted.set(proof.host, now() + 10000);
          }
        } catch { /* Missing affirmative proof fails closed at the authority. */ }
        finally { sending = undefined; }
      }
    })().finally(() => { pending = undefined; drain(); });
  }
  return {
    observe(proof: DomainAttestation) {
      if (sending === proof.host || queue.some(({ host }) => host === proof.host) ||
          (accepted.get(proof.host) ?? 0) > now()) return;
      if (queue.length >= 3) return;
      queue.push(proof);
      drain();
    },
    clear() { queue.length = 0; },
    settled: () => pending,
  };
}
