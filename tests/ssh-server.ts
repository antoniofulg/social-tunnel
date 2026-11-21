import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { Server, utils, type Connection } from "ssh2";
import { keyPair, until, writeConfig } from "./helpers";

export interface ServerOptions {
  publicKey: string;
  port?: number;
  // Reuse a host key, so a restarted server keeps its identity.
  host?: { private: string; public: string };
  authorize?: boolean;
  // Which remote-forward ports the server grants. Default: any.
  forward?: (port: number) => boolean;
  // Really open the forwarded port and pass its connections down the tunnel.
  open?: boolean;
  // Runs commands sent to a shell session (with or without a terminal).
  shell?: boolean;
  pty?: boolean;
  exec?: boolean;
  // Grants shell and exec requests but runs only its own command, like `command="/bin/false"`.
  forced?: boolean;
  sftp?: boolean;
  localForward?: boolean;
  banner?: string;
}

export interface TestServer {
  port: number;
  hostKey: string;
  host: { private: string; public: string };
  // Authentication methods the server was asked for, in order.
  auth: string[];
  requests: { name: string; bindAddr?: string; bindPort?: number }[];
  clients: Connection[];
  options: ServerOptions;
  dropAll: () => void;
  stopReading: () => void;
  // Announces a forwarded connection for the given bind address; resolves true when the client accepts it.
  announce: (bindAddr: string, bindPort: number) => Promise<boolean>;
  close: () => Promise<void>;
}

// An in-process SSH server: test harness only. It never leaves 127.0.0.1.
export async function startServer(options: ServerOptions): Promise<TestServer> {
  const host = options.host ?? keyPair();
  const hostBlob = (utils.parseKey(host.public) as { getPublicSSH(): Buffer }).getPublicSSH();
  const allowed = utils.parseKey(options.publicKey) as {
    type: string;
    getPublicSSH(): Buffer;
    verify(blob: Buffer, signature: Buffer, hashAlgo?: string): boolean;
  };
  const allowedBlob = allowed.getPublicSSH();
  const listeners = new Map<number, net.Server>();

  const t: TestServer = {
    port: 0,
    host,
    hostKey: "SHA256:" + createHash("sha256").update(hostBlob).digest("base64").replace(/=+$/, ""),
    auth: [],
    requests: [],
    clients: [],
    options,
    dropAll: () => t.clients.forEach((c) => c.end()),
    stopReading: () => t.clients.forEach((c) => (c as unknown as { _sock: net.Socket })._sock.pause()),
    announce: (bindAddr, bindPort) =>
      new Promise((resolve) => {
        t.clients.at(-1)!.forwardOut(bindAddr, bindPort, "127.0.0.1", 50000, (err, channel) => {
          channel?.destroy();
          resolve(!err);
        });
      }),
    close: async () => {
      for (const l of listeners.values()) l.close();
      t.clients.forEach((c) => (c as unknown as { _sock: net.Socket })._sock.destroy());
      await new Promise((resolve) => server.close(resolve));
    },
  };

  const server = new Server({ hostKeys: [host.private], banner: options.banner }, (client) => {
    t.clients.push(client);
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      t.auth.push(ctx.method);
      const ok =
        ctx.method === "publickey" &&
        options.authorize !== false &&
        ctx.key.algo === allowed.type &&
        ctx.key.data.length === allowedBlob.length &&
        timingSafeEqual(ctx.key.data, allowedBlob) &&
        (!ctx.signature || allowed.verify(ctx.blob!, ctx.signature, ctx.hashAlgo) === true);
      if (ok) ctx.accept();
      else ctx.reject(["publickey"]);
    });
    client.on("ready", () => {
      client.on("request", (accept, reject, name, info) => {
        t.requests.push({ name, bindAddr: info.bindAddr, bindPort: info.bindPort });
        if (name === "tcpip-forward") {
          if (options.forward && !options.forward(info.bindPort)) return reject?.();
          if (!options.open) return accept?.();
          const listener = net.createServer((socket) => {
            client.forwardOut(info.bindAddr, info.bindPort, "127.0.0.1", socket.remotePort ?? 0, (err, channel) => {
              if (err) return socket.destroy();
              socket.pipe(channel).pipe(socket);
            });
          });
          listeners.set(info.bindPort, listener);
          listener.listen(info.bindPort, "127.0.0.1", () => accept?.());
        } else if (name === "cancel-tcpip-forward") {
          listeners.get(info.bindPort)?.close();
          listeners.delete(info.bindPort);
          accept?.();
        } else reject?.();
      });
      client.on("session", (accept, reject) => {
        if (!options.shell && !options.sftp && !options.exec && !options.forced) return reject();
        const session = accept();
        // What a real shell prints for doctor's probe command; only a server that runs it answers so.
        const evaluate = (text: string) => (text.includes("echo social-tunnel-$((6*7))") ? "social-tunnel-42\n" : "");
        // A forced command: the request is granted, the server's own command runs and exits.
        const forcedCommand = (channel: { exit(code: number): void; end(): void }) => {
          channel.exit(1);
          channel.end();
        };
        session.on("pty", (ok, no) => (options.pty ? ok?.() : no?.()));
        session.on("shell", (ok, no) => {
          if (options.forced) return forcedCommand(ok());
          if (!options.shell) return no?.();
          const channel = ok();
          channel.on("data", (chunk: Buffer) => channel.write(evaluate(chunk.toString())));
        });
        session.on("exec", (ok, no, info) => {
          if (options.forced) return forcedCommand(ok());
          if (!options.exec) return no?.();
          const channel = ok();
          channel.write(evaluate(info.command));
          channel.exit(0);
          channel.end();
        });
        session.on("sftp", (ok, no) => (options.sftp ? ok() : no?.()));
      });
      client.on("tcpip", (accept, reject) => (options.localForward ? accept().end() : reject()));
    });
  });
  await new Promise<void>((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
  t.port = (server.address() as net.AddressInfo).port;
  return t;
}

export async function freePort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as net.AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

// A server plus a config that points at it with the right key and host key pin.
export async function setup(server: Omit<ServerOptions, "publicKey"> = {}, edit: (config: Record<string, any>) => void = () => {}) {
  const files = writeConfig();
  const ssh = await startServer({ ...server, publicKey: files.publicKey });
  const remotePort = await freePort();
  const config = JSON.parse(readFileSync(files.path, "utf8"));
  config.server = { host: "127.0.0.1", port: ssh.port, user: "tunnel", hostKey: ssh.hostKey };
  config.remotePort = remotePort;
  edit(config);
  writeFileSync(files.path, JSON.stringify(config));
  return { ...files, ssh, remotePort, config };
}

export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

// Waits until state.json holds `state`, and returns it.
export async function stateIs(path: string, state: string, ms = 10000): Promise<any> {
  let last: any;
  await until(
    () => {
      try {
        last = readJson(path);
      } catch {
        return false;
      }
      return last.state === state;
    },
    ms,
    `state ${state} (last: ${JSON.stringify(last)})`,
  );
  return last;
}
