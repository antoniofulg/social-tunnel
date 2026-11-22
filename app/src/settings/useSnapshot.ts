import { useEffect, useState } from "react";
import { getSnapshot, onSnapshot, onView } from "../ipc";
import type { Snapshot, View } from "../types";

/**
 * The latest snapshot (the `get_snapshot` answer, then every `snapshot` event) and the view Rust
 * asks for. `onSnapshot` and `onView` run only on events, never during render.
 */
export function useSnapshot(onSnapshotEvent: (snapshot: Snapshot) => void, onViewRequest: (view: View) => void) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let live = true;
    const unlisten: Promise<() => void>[] = [
      onSnapshot((next) => {
        if (!live) return;
        setSnapshot(next);
        onSnapshotEvent(next);
      }),
      onView((view) => live && onViewRequest(view)),
    ];
    // An event that landed first is newer than the answer.
    getSnapshot().then(
      (first) => {
        if (!live) return;
        setSnapshot((current) => current ?? first);
        if (first) onSnapshotEvent(first);
      },
      () => undefined,
    );
    return () => {
      live = false;
      for (const un of unlisten) un.then((fn) => fn());
    };
  }, [onSnapshotEvent, onViewRequest]);

  return snapshot;
}
