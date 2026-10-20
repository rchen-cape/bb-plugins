import { useEffect } from "react";
import { toast } from "sonner";
import { LIMITS } from "../lib/sketch.js";
import { errorMessage } from "./bits";
import type { SketchRpc } from "./hooks";
import type { CreatedFile, SketchSession } from "./session";

export const RESCUE_SUFFIX = " (my edits)";

export function rescueTitle(title: string): string {
  const room = LIMITS.title - RESCUE_SUFFIX.length;
  const clipped = title.length <= room ? title : title.slice(0, room);
  const last = clipped.charCodeAt(clipped.length - 1);
  const whole = last >= 0xd800 && last <= 0xdbff ? clipped.slice(0, -1) : clipped;
  return `${whole.trimEnd()}${RESCUE_SUFFIX}`;
}

export function createRescueCopy(rpc: { readonly current: SketchRpc }, title: { readonly current: string }) {
  return async (content: string): Promise<CreatedFile> => {
    const created = await rpc.current.call("create", { title: rescueTitle(title.current), content });
    return { id: created.id, title: created.title, sha256: created.sha256 };
  };
}

export function useRescueOnLeave(session: SketchSession, rpc: { readonly current: SketchRpc }, title: { readonly current: string }): void {
  useEffect(() => {
    const copy = createRescueCopy(rpc, title);
    const rescue = () => {
      const from = title.current;
      session
        .rescue(async (content) => {
          const created = await copy(content);
          toast.success(`Saved your unsaved edits to “${from}” as “${created.title}”.`);
        })
        .catch((cause: unknown) => toast.error(`Couldn't save your edits to “${from}”: ${errorMessage(cause)}`));
    };
    window.addEventListener("pagehide", rescue);
    return () => {
      window.removeEventListener("pagehide", rescue);
      rescue();
    };
  }, [session, rpc, title]);
}
