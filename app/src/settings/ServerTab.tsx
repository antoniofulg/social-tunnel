import type { Snapshot } from "../types";
import { FixBlock } from "./FixBlock";
import { KeyValueList, Mono } from "./KeyValueList";
import { Note } from "./Note";

// Shows the pinned fingerprint and the key file's path, never the key file's content: the app
// reads no file (plan criterion 65).
export function ServerTab({ snapshot }: { snapshot: Snapshot | null }) {
  const status = snapshot?.status ?? null;
  const signIn = snapshot?.doctor?.hops.find((h) => h.hop === "ssh_auth" && !h.ok && !h.skipped);
  return (
    <div>
      <KeyValueList
        items={[
          ["Server", <Mono key="host">{status?.server.host ?? null}</Mono>],
          ["SSH port", <Mono key="port">{status?.server.port ?? null}</Mono>],
          ["Tunnel user", <Mono key="user">{status?.server.user ?? null}</Mono>],
          ["Server key", <Mono key="hostKey">{status?.server.hostKey ?? null}</Mono>],
          ["Key file", <Mono key="keyPath">{status?.keyPath ?? null}</Mono>],
          ["Tunnel port", <Mono key="remotePort">{status?.remotePort ?? null}</Mono>],
        ]}
      />
      {signIn && snapshot?.doctor && <FixBlock key={snapshot.doctor.startedAt} hop={signIn} tone={snapshot.doctor.exit === 13 ? "down" : "warn"} />}
      <Note />
    </div>
  );
}
