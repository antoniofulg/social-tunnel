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
    let sawSnapshot = false;
    const snapshotListener = onSnapshot((next) => {
      if (!live) return;
      sawSnapshot = true;
      setSnapshot(next);
      onSnapshotEvent(next);
    });
    const viewListener = onView((view) => live && onViewRequest(view));
    // The listener must be registered before asking for the baseline. A newer event wins.
    void snapshotListener.then(async () => {
      if (!live) return;
      const first = await getSnapshot();
      if (!live || sawSnapshot) return;
      setSnapshot(first);
      if (first) onSnapshotEvent(first);
    }).catch(() => undefined);
    return () => {
      live = false;
      for (const listener of [snapshotListener, viewListener]) void listener.then((unlisten) => unlisten(), () => undefined);
    };
  }, [onSnapshotEvent, onViewRequest]);

  return snapshot;
}
