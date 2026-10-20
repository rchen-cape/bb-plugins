import { useSyncExternalStore } from "react";
import { Island, keepRootFocus } from "./bits";
import type { SketchSession } from "./session";

const LINK_CLASS = "cursor-pointer font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

export function MissingBanner({ session, title, onSaveAsNew }: { session: SketchSession; title: string; onSaveAsNew: () => void }) {
  const status = useSyncExternalStore(session.status.subscribe, () => session.status.get().status, () => session.status.get().status);
  if (status.kind !== "missing") return null;
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-16 z-20 flex justify-center md:bottom-3 md:left-auto md:justify-end">
      <Island role="alert" className="pointer-events-auto flex max-w-md flex-wrap items-center gap-x-1.5 px-3 py-1.5 text-sm text-muted-foreground">
        “{title}” isn't in your sketch folder anymore. It was renamed, moved, or deleted outside this page.
        <button type="button" className={LINK_CLASS} onMouseDown={keepRootFocus} onClick={onSaveAsNew}>
          Save as a new sketch
        </button>
      </Island>
    </div>
  );
}
