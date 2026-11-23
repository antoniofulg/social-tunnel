import { chmodSync, chownSync, lstatSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { protectedDirectory } from "../src/domain-policy";
import type { PublisherPrincipal } from "../src/domain-publisher";

const REQUEST_LIMIT = 4096;
const RESPONSE_LIMIT = 96 * 1024;
const SESSION_MS = 3000;
const CAP = 4;
const REQUESTS_PER_MINUTE = 64;
const REPLY_BUSY = Buffer.from('{"ok":false,"code":"limit"}\n');
const ACCEPTED = Buffer.from("+");

type RemoteIdentity = Extract<PublisherPrincipal, { role: "editor" | "proxy" }>;
export type RemoteOperation = "inspect" | "add" | "remove" | "begin" | "receipt";
export const domainCommands = Object.freeze({
  inspect: "domains-v1 inspect", add: "domains-v1 add", remove: "domains-v1 remove",
  begin: "domains-v1 begin", receipt: "domains-v1 receipt",
} satisfies Record<RemoteOperation, string>);
const verbs: readonly RemoteOperation[] = ["inspect", "add", "remove", "begin", "receipt"];

export interface RoleIngress {
  readonly directory: string;
  readonly group: number;
  readonly identity: RemoteIdentity;
}

type Binding = {
  readonly identity: RemoteIdentity;
  readonly group: number;
  readonly server: Server;
  readonly ready: Promise<void>;
  readonly sockets: Set<Socket>;
  stopped?: Promise<void>;
};

export function createDomainIngress(dispatch: (identity: RemoteIdentity, verb: RemoteOperation, body: Buffer) => unknown) {
  const bindings = new Set<Binding>();
  const sockets = new Set<Socket>();
  let window = performance.now();
  let requests = 0;
  let firstEpoch = 0;
  let closing = false;

  function serve(socket: Socket, binding: Binding) {
    const { identity } = binding;
    if (closing || binding.stopped || identity.epoch < firstEpoch) return socket.destroy();
    binding.sockets.add(socket);
    socket.on("error", () => socket.destroy());
    const deadline = setTimeout(() => socket.destroy(), SESSION_MS);
    socket.once("close", () => {
      clearTimeout(deadline);
      binding.sockets.delete(socket);
      sockets.delete(socket);
    });
    const now = performance.now();
    if (now - window >= 60000) { window = now; requests = 0; }
    if (requests >= REQUESTS_PER_MINUTE) return socket.end(REPLY_BUSY);
    requests++;
    if (sockets.size >= CAP) return socket.end(REPLY_BUSY);
    sockets.add(socket);

    // Reserve a shared slot before reading any verb or payload, across both role endpoints.
    const chunks: Buffer[] = [];
    let bytes = 0;
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > REQUEST_LIMIT + 1) socket.destroy();
      else chunks.push(chunk);
    });
    socket.once("end", () => {
      if (socket.destroyed || binding.stopped) return;
      const input = Buffer.concat(chunks, bytes);
      const verb = verbs[input[0]!];
      const valid = verb && (verb === "inspect" ? bytes === 1 : bytes > 1);
      const allowed = verb === "inspect" || (identity.role === "editor" ? verb === "add" || verb === "remove" : verb === "begin" || verb === "receipt");
      let response: string;
      try {
        response = JSON.stringify(valid && allowed ? dispatch(identity, verb, input.subarray(1)) : { ok: false, code: "unauthorized" }) + "\n";
      } catch { response = '{"ok":false,"code":"unavailable"}\n'; }
      socket.end(Buffer.byteLength(response) <= RESPONSE_LIMIT ? response : REPLY_BUSY);
    });
    socket.write(ACCEPTED);
  }

  async function bind(role: RoleIngress): Promise<void> {
    const dir = protectedDirectory(role.directory);
    if (closing || role.identity.epoch < firstEpoch || [...bindings].some((bound) => bound.group === role.group) ||
        dir.uid !== 0 || dir.gid !== role.group || (dir.mode & 0o777) !== 0o710 || role.group === 0) {
      throw new Error("unsafe domain role directory");
    }
    // A root-owned group-traversable directory plus a role-group-only socket is the
    // OS authentication boundary. The role's UID/group and path are provisioned, never input.
    const path = join(role.directory, "authority.sock");
    if (Buffer.byteLength(path) >= 104 || lstatSync(path, { throwIfNoEntry: false })) throw new Error("unsafe domain role socket");
    const identity = Object.freeze({ ...role.identity });
    const server = createServer({ allowHalfOpen: true }, (socket) => serve(socket, binding));
    const ready = Promise.withResolvers<void>();
    const binding: Binding = { identity, group: role.group, server, ready: ready.promise, sockets: new Set() };
    bindings.add(binding);
    server.once("error", ready.reject);
    try { server.listen(path, ready.resolve); } catch (error) { ready.reject(error); }
    try {
      await binding.ready;
      if (closing || binding.stopped) throw new Error("domain role was retired before bind completed");
      chownSync(path, 0, role.group);
      chmodSync(path, 0o660);
    } catch (error) {
      await stop(binding);
      throw error;
    }
  }

  function stop(binding: Binding): Promise<void> {
    if (binding.stopped) return binding.stopped;
    const closed = Promise.withResolvers<void>();
    binding.stopped = closed.promise;
    for (const socket of binding.sockets) {
      sockets.delete(socket);
      socket.destroy();
    }
    // The binding is registered before listen(). Even an unresolved listen is drained.
    const finished = () => { bindings.delete(binding); closed.resolve(); };
    void binding.ready.then(() => binding.server.close(finished), finished);
    return closed.promise;
  }

  async function retireBefore(epoch: number) {
    if (epoch <= firstEpoch) return;
    firstEpoch = epoch;
    window = performance.now();
    requests = 0;
    await Promise.all([...bindings].filter((bound) => bound.identity.epoch < epoch).map(stop));
  }

  async function close() {
    closing = true;
    await Promise.all([...bindings].map(stop));
  }

  return { bind, retireBefore, close };
}

// Runs as the authenticated sshd role, not as root. No request fields configure the
// destination or select a role; only the root-owned forced argv names the socket.
export async function forwardDomainCommand(
  path: string, command: string | undefined, stdin: AsyncIterable<Uint8Array>, emit: (data: Buffer) => Promise<void>,
): Promise<boolean> {
  const index = verbs.findIndex((verb) => domainCommands[verb] === command);
  if (index < 0) return false;
  const socket = createConnection({ path, allowHalfOpen: true });
  const done = Promise.withResolvers<boolean>();
  const deadline = setTimeout(() => { socket.destroy(); done.resolve(false); }, SESSION_MS);
  const response: Buffer[] = [];
  let bytes = 0;
  let admitted = false;
  socket.once("error", () => done.resolve(false));
  socket.once("close", () => done.resolve(false));
  socket.once("end", () => {
    void emit(Buffer.concat(response, bytes)).then(() => done.resolve(true), () => done.resolve(false));
  });
  socket.on("data", (first: Buffer) => {
    let chunk = first;
    if (!admitted && bytes === 0 && chunk[0] === ACCEPTED[0]) {
      admitted = true;
      chunk = chunk.subarray(1);
      void (async () => {
        try {
          socket.write(Buffer.of(index));
          if (index !== 0) {
            let length = 0;
            for await (const input of stdin) {
              length += input.byteLength;
              if (length > REQUEST_LIMIT || socket.destroyed) return socket.destroy();
              socket.write(input);
            }
          }
          socket.end();
        } catch { socket.destroy(); }
      })();
    }
    bytes += chunk.length;
    if (bytes > RESPONSE_LIMIT) socket.destroy();
    else response.push(chunk);
  });
  try { return await done.promise; } finally { clearTimeout(deadline); socket.destroy(); }
}
