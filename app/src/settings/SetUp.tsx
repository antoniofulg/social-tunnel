// The README quick-start as a read-only view. Nothing here writes a config or runs a command.
import type { ReactNode } from "react";
import type { Snapshot } from "../types";
import { failedHop } from "../route";
import { Button } from "./Button";
import { FixBlock } from "./FixBlock";
import { Note } from "./Note";

function Command({ children }: { children: string }) {
  return (
    <pre className="m-0 mt-2 overflow-x-auto rounded-box bg-well px-[9px] py-1.5 font-mono text-[11.5px] leading-[1.4] whitespace-pre-wrap break-all select-text">
      {children}
    </pre>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li>
      <h3 className="m-0 text-[13px] font-semibold">{title}</h3>
      <div className="mt-0.5 text-xs text-text-2">{children}</div>
    </li>
  );
}

interface Props {
  snapshot: Snapshot | null;
  busy: boolean;
  onCheck: () => void;
}

export function SetUp({ snapshot, busy, onCheck }: Props) {
  const configPath = snapshot?.configPath ?? null;
  const failed = snapshot?.doctor ? failedHop(snapshot.doctor) : undefined;
  return (
    <div>
      <h2 className="m-0 text-[15px] font-semibold">Set Up</h2>
      <ol className="mt-3.5 mb-0 grid list-none gap-3.5 p-0">
        <Step title="1. Create a dedicated key on this Mac">
          Use a key only for this.
          <Command>{'ssh-keygen -t ed25519 -N "" -C social-tunnel -f ~/.ssh/social_tunnel\nchmod 600 ~/.ssh/social_tunnel'}</Command>
        </Step>
        <Step title="2. Prepare the server (once, as root)">
          Create a user with no shell, then limit its key to one remote listen. The README has every line.
          <Command>{"useradd --create-home --shell /usr/sbin/nologin sotunnel"}</Command>
        </Step>
        <Step title="3. Write the config on this Mac">
          {configPath ? (
            <>
              Create <code className="font-mono text-[11.5px] break-all select-text">{configPath}</code> as a JSON object with version, server, remotePort, keyPath and domains.
            </>
          ) : (
            "Create the config file as a JSON object with version, server, remotePort, keyPath and domains."
          )}
        </Step>
        <Step title="4. Check every hop">
          The first broken hop comes with a fix.
          <div className="mt-2 flex justify-end">
            <Button disabled={snapshot === null || busy} onClick={onCheck}>
              {busy ? "Checking…" : "Check Again"}
            </Button>
          </div>
          {failed && snapshot?.doctor && <FixBlock key={snapshot.doctor.startedAt} hop={failed} tone="down" />}
        </Step>
      </ol>
      <Note />
    </div>
  );
}
