import { withTimeout } from "./proxy";
import { ConnectError, connectSsh, type SshTarget } from "./tunnel";
import type { ProxyPreimage, ProxyPublicationReceipt } from "./domain-publisher";

import { DOMAIN_COMMANDS, DOMAIN_REQUEST_LIMIT, DOMAIN_RESPONSE_LIMIT, type DomainVerb } from "./domain-protocol";
export { DOMAIN_COMMANDS, type DomainVerb } from "./domain-protocol";
export type DomainRole = "editor" | "proxy";
export type WireError = "unavailable" | "unsupported" | "unauthorized" | "not_ready" | "fenced" | "limit" | "conflict" |
  "invalid_request" | "invalid_domain" | "duplicate_domain" | "domain_not_found" | "unknown_operation" | "receipt_mismatch" |
  "recovery_required" | "operation_cancelled" | "superseded";
export type WireResult<T = unknown> = { ok: true; value: T } | { ok: false; code: WireError };
export interface ProposalBody { version: 1; operationId: string; expectedRevision: number; host: string }
export interface DomainAttestation extends ProxyPreimage { enrollment: string; epoch: number; host: string }
export interface DomainClient {
  inspect(): Promise<WireResult>;
  reconcile(id: string): Promise<WireResult>;
  propose(kind: "add" | "remove", body: ProposalBody): Promise<WireResult>;
  begin(id: string): Promise<WireResult>;
  receipt(receipt: ProxyPublicationReceipt): Promise<WireResult>;
  attest(attestation: DomainAttestation): Promise<WireResult>;
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const errors = {
  unavailable: true, unsupported: true, unauthorized: true, not_ready: true, fenced: true, limit: true, conflict: true,
  invalid_request: true, invalid_domain: true, duplicate_domain: true, domain_not_found: true, unknown_operation: true,
  receipt_mismatch: true, recovery_required: true, operation_cancelled: true, superseded: true,
} satisfies Record<WireError, true>;
const unavailable = { ok: false, code: "unavailable" } as const;

export function domainRoleClient(role: DomainRole, target: SshTarget, timeoutMs = 4000, currentSelection?: () => boolean): DomainClient {
  const changed = { ok: false, code: "conflict" } as const;
  async function request(verb: DomainVerb, message?: unknown): Promise<WireResult> {
    const edit = verb === "add" || verb === "remove" || verb === "reconcile";
    if (verb !== "inspect" && edit !== (role === "editor")) {
      return { ok: false, code: "unauthorized" };
    }
    if (currentSelection?.() === false) return changed;
    const body = message === undefined ? "" : JSON.stringify(message);
    if (Buffer.byteLength(body) > DOMAIN_REQUEST_LIMIT) return { ok: false, code: "limit" };
    const end = performance.now() + timeoutMs;
    try {
      const client = await withTimeout(connectSsh(target, { readyTimeoutMs: timeoutMs }), timeoutMs, (late) => late.destroy());
      try {
        if (currentSelection?.() === false) return changed;
        const remaining = end - performance.now();
        if (remaining <= 0) return unavailable;
        const result = Promise.withResolvers<WireResult>();
        let stopped = false;
        const timer = setTimeout(() => {
          stopped = true;
          result.resolve(unavailable);
          client.destroy();
        }, remaining);
        client.once("close", () => result.resolve(unavailable));
        client.exec(DOMAIN_COMMANDS[verb], (err, channel) => {
          if (err) return result.resolve(unavailable);
          if (stopped) return channel.destroy();
          if (currentSelection?.() === false) {
            result.resolve(changed);
            channel.destroy();
            return;
          }
          let bytes = 0;
          let stderr = false;
          const chunks: Buffer[] = [];
          const count = (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > DOMAIN_RESPONSE_LIMIT) {
              result.resolve(unavailable);
              channel.destroy();
              client.destroy();
            }
          };
          channel.on("data", (chunk: Buffer) => { count(chunk); if (bytes <= DOMAIN_RESPONSE_LIMIT) chunks.push(chunk); });
          channel.stderr.on("data", (chunk: Buffer) => { stderr = true; count(chunk); });
          channel.on("error", () => result.resolve(unavailable));
          channel.once("close", (code: number | undefined) => {
            if (stderr || bytes > DOMAIN_RESPONSE_LIMIT) return result.resolve(unavailable);
            if (code !== 0) return result.resolve(unavailable);
            try {
              const raw: unknown = JSON.parse(utf8.decode(Buffer.concat(chunks)));
              if (!raw || typeof raw !== "object" || Array.isArray(raw)) return result.resolve(unavailable);
              const reply = raw as Record<string, unknown>;
              if (reply.ok === true && Object.hasOwn(reply, "value")) result.resolve({ ok: true, value: reply.value });
              else if (reply.ok === false && typeof reply.code === "string" && Object.hasOwn(errors, reply.code)) result.resolve({ ok: false, code: reply.code as WireError });
              else result.resolve(unavailable);
            } catch { result.resolve(unavailable); }
          });
          channel.end(body);
        });
        try { return await result.promise; } finally { clearTimeout(timer); }
      } finally { client.destroy(); }
    } catch (err) {
      if (err instanceof ConnectError && err.kind === "auth_failed") return { ok: false, code: "unauthorized" };
      return unavailable;
    }
  }
  return { inspect: () => request("inspect"), propose: request, begin: (id) => request("begin", id),
    reconcile: (id) => request("reconcile", id),
    receipt: (proof) => request("receipt", proof), attest: (proof) => request("attest", proof) };
}

export const domainUInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export const domainTag = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(value);
export const domainDigest = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
export const operationIdFormat = (id: unknown): id is string => typeof id === "string" && /^\d{1,16}\.\d{1,16}\.[0-9a-f]{32}$/.test(id);
export const proofHost = (host: unknown): host is string => typeof host === "string" && /^[0-9a-f]{32}\.(?:live|e\d{1,16}\.r\d{1,16})\.pac\.invalid$/.test(host);
export function wireObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
