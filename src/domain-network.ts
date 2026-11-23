import { Resolver } from "node:dns/promises";
import net from "node:net";
import type { Dialer } from "./proxy";

interface Query { resolve4(host: string): Promise<string[]>; resolve6(host: string): Promise<string[]>; cancel(): void }

export async function resolveManagedHost(host: string, signal: AbortSignal, query: Query = new Resolver()): Promise<string[]> {
  signal.throwIfAborted();
  const cancel = () => query.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const answers = await Promise.allSettled([query.resolve4(host), query.resolve6(host)]);
    signal.throwIfAborted();
    return answers.flatMap((answer) => answer.status === "fulfilled" ? answer.value : []);
  } finally { signal.removeEventListener("abort", cancel); }
}

export const dialManagedAddress: Dialer = async (address, port, signal) => {
  signal?.throwIfAborted();
  const socket = net.connect({ host: address, port });
  const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
  const abort = () => socket.destroy();
  signal?.addEventListener("abort", abort, { once: true });
  socket.on("error", abort);
  socket.once("close", () => {
    signal?.removeEventListener("abort", abort);
    reject(new Error("managed dial closed"));
  });
  socket.once("connect", () => {
    signal?.removeEventListener("abort", abort);
    if (!signal?.aborted) resolve(socket);
    else socket.destroy();
  });
  return promise;
};
