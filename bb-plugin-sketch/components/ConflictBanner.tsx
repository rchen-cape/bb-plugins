import { useSyncExternalStore } from "react";
import { Island, keepRootFocus } from "./bits";
import type { SketchSession } from "./session";

const LINK_CLASS = "cursor-pointer font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function ConflictBanner({ session, onReload, onKeepMine }: { session: SketchSession; onReload: () => void; onKeepMine: () => void }) {
  const status = useSyncExternalStore(session.status.subscribe, () => session.status.get().status, () => session.status.get().status);
  if (status.kind !== "conflict") return null;
  return (
    <Island role="alert" className="pointer-events-auto flex items-center gap-1.5 px-3 py-1.5 text-sm text-muted-foreground">
      Changed somewhere else.
      <button type="button" className={LINK_CLASS} onMouseDown={keepRootFocus} onClick={onReload}>
        Reload
      </button>
      ·
      <button type="button" className={LINK_CLASS} onMouseDown={keepRootFocus} onClick={onKeepMine}>
        Keep mine
      </button>
    </Island>
  );
}
