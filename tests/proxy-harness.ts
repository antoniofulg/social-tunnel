import { Duplex } from "node:stream";
import { createProxy, type ProxyOptions } from "../src/proxy";
import { until } from "./helpers";

// Two connected in-memory streams: what one side writes, the other reads.
export function pair(): [Duplex, Duplex] {
  const ends: Duplex[] = [];
  const make = (peer: number) =>
    new Duplex({
      read() {},
      write(chunk, _encoding, done) {
        ends[peer]!.push(chunk);
        done();
      },
      final(done) {
        ends[peer]!.push(null);
        done();
      },
      destroy(err, done) {
        setImmediate(() => ends[peer]!.destroy());
        done(err);
      },
    });
  ends.push(make(1), make(0));
  return [ends[0]!, ends[1]!];
}

export const PUBLIC = "157.240.1.1";

// A proxy whose only resolver and dialer are counting fakes: nothing here can reach a network.
export function harness(options: Partial<ProxyOptions> = {}, answers: Record<string, string[]> = {}) {
  const lookups: string[] = [];
  const dials: { address: string; port: number; remote: Duplex; received: () => Buffer }[] = [];
  const logs: { status: number; host?: string }[] = [];
  const handle = createProxy({
    domains: ["instagram.com"],
    interfaces: () => ({}),
    resolve: async (host) => {
      lookups.push(host);
      return answers[host] ?? [PUBLIC];
    },
    dial: async (address, port) => {
      const [near, remote] = pair();
      const chunks: Buffer[] = [];
      remote.on("data", (c) => chunks.push(c));
      dials.push({ address, port, remote, received: () => Buffer.concat(chunks) });
      return near;
    },
    log: (entry) => logs.push(entry),
    ...options,
  });

  // Opens one forwarded channel and sends `bytes` in a single write.
  const open = (bytes: string | Buffer) => {
    const [client, server] = pair();
    const chunks: Buffer[] = [];
    let ended = false;
    client.on("data", (c) => chunks.push(c));
    client.on("end", () => (ended = true));
    client.on("close", () => (ended = true));
    handle(server);
    if (bytes.length > 0) client.write(bytes);
    const text = () => Buffer.concat(chunks).toString("latin1");
    return {
      client,
      text,
      ended: () => ended,
      // Resolves with everything the proxy sent once it closed the channel.
      closed: async () => {
        await until(() => ended, 5000, "proxy to close the channel");
        return text();
      },
      // Resolves with the response head once it is complete.
      head: async () => {
        await until(() => text().includes("\r\n\r\n") || ended, 5000, "response head");
        return text();
      },
    };
  };

  const connect = (target: string) => open(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const status = async (target: string) => (await connect(target).closed()).split("\r\n")[0];

  return { handle, open, connect, status, lookups, dials, logs };
}

export const OK = "HTTP/1.1 200 Connection Established";
