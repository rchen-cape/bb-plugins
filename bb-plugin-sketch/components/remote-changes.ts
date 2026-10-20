import { useCallback, useEffect } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod";
import type { SketchDetail } from "../contract";
import { gridEnabled, parseSceneFile } from "../lib/scene.js";
import { CHANGED_CHANNEL } from "../lib/sketch.js";
import { errorMessage } from "./bits";
import type { EditorController } from "./controller";
import { useReconnect, useSketchRpc } from "./hooks";
import type { SketchSession } from "./session";
import { moveView } from "./storage";
import { unreadableNotice } from "./unreadable";
import type { PageActions } from "./workspace-types";

const changedSchema = z
  .object({ id: z.string().nullable().catch(null), renamedTo: z.string().min(1).nullable().optional().catch(null) })
  .catch({ id: null, renamedTo: null });

export function parseChange(payload: unknown): { id: string | null; renamedTo: string | null } {
  const { id, renamedTo } = changedSchema.parse(payload);
  return { id, renamedTo: renamedTo ?? null };
}

function adopt(controller: EditorController, session: SketchSession, detail: SketchDetail): boolean {
  let parsed: ReturnType<typeof parseSceneFile>;
  try {
    parsed = parseSceneFile(detail.content);
  } catch (cause) {
    toast.error(`“${detail.title}” changed somewhere else and can't be read: ${errorMessage(cause)}`);
    return false;
  }
  const { scene } = parsed;
  const grid = gridEnabled(scene.appState);
  session.adopt({ sha256: detail.sha256, appState: scene.appState, files: scene.files, draft: { elements: scene.elements, grid } });
  controller.load(scene.elements, grid);
  const notice = unreadableNotice(detail.title, parsed);
  if (notice !== null) toast.message(notice);
  return true;
}

function useMissingCheck(session: SketchSession, exists: (id: string) => Promise<boolean>): void {
  useEffect(() => {
    const check = () => {
      const id = session.id;
      if (session.current.kind !== "conflict" || id === null) return;
      exists(id).then(
        (found) => {
          if (!found && session.id === id && session.current.kind === "conflict") session.markMissing();
        },
        () => undefined,
      );
    };
    return session.status.subscribe(check);
  }, [session, exists]);
}

export function useRemoteChanges(controller: EditorController, session: SketchSession, page: { readonly current: PageActions }) {
  const rpc = useSketchRpc();
  const exists = useCallback(async (id: string) => (await rpc.call("get", { id })) !== null, [rpc]);
  useMissingCheck(session, exists);
  const refetch = useCallback(
    async (force: boolean) => {
      const id = session.id;
      if (id === null) return;
      if (!force && (controller.busy || session.hasUnsavedChanges() || session.stuck)) return;
      const detail = await rpc.call("get", { id });
      if (session.id !== id) return;
      if (detail === null) {
        session.markMissing();
        return;
      }
      if (force || (!controller.busy && session.canAdopt(detail.sha256))) adopt(controller, session, detail);
    },
    [rpc, controller, session],
  );
  const follow = useCallback(
    (from: string, to: string) => {
      moveView(from, to);
      session.renamed(to);
      page.current.identify(to, to);
    },
    [session, page],
  );
  const onChanged = useCallback(
    (payload: unknown) => {
      const { id, renamedTo } = parseChange(payload);
      if (id !== null && id === session.id && renamedTo !== null) {
        follow(id, renamedTo);
        return;
      }
      if (id === null || id === session.id) refetch(false).catch(() => undefined);
    },
    [refetch, follow, session],
  );
  useRealtime(CHANGED_CHANNEL, onChanged);
  useReconnect(() => {
    refetch(false).catch(() => undefined);
  });
  return refetch;
}
