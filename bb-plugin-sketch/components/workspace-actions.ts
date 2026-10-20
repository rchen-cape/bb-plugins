import { toast } from "sonner";
import { errorMessage } from "./bits";
import type { EditorController } from "./controller";
import type { WorkspaceActions } from "./Editor";
import { runExport } from "./exporting";
import { useSketchRpc } from "./hooks";
import type { SketchSession } from "./session";
import type { ExportKind } from "./SketchMenu";
import { moveView, removeView } from "./storage";
import type { OpenDoc, PageActions } from "./workspace-types";

export function useWorkspaceActions(
  controller: EditorController,
  session: SketchSession,
  doc: OpenDoc,
  page: PageActions,
  refetch: (force: boolean) => Promise<void>,
): WorkspaceActions {
  const rpc = useSketchRpc();
  const requireId = (): string => {
    if (session.id === null) throw new Error("Draw something first so the sketch is saved.");
    return session.id;
  };
  return {
    open: page.open,
    create: page.create,
    importFile: page.importFile,
    exportAs: (kind: ExportKind) => runExport(controller, kind, { title: doc.title, ...session.meta() }),
    duplicate: () => {
      const run = async () => {
        await session.flush();
        const copy = await rpc.call("duplicate", { id: requireId() });
        toast.success(`Made “${copy.title}”`);
        page.open(copy.id);
      };
      run().catch((cause: unknown) => toast.error(`Couldn't duplicate: ${errorMessage(cause)}`));
    },
    rename: async (title: string) => {
      await session.flush();
      const from = requireId();
      const renamed = await rpc.call("rename", { id: from, title });
      moveView(from, renamed.id);
      session.renamed(renamed.id);
      page.identify(renamed.id, renamed.title);
    },
    remove: async () => {
      const id = requireId();
      session.discard();
      try {
        await rpc.call("delete", { id });
      } catch (cause) {
        session.resume();
        throw cause;
      }
      removeView(id);
      toast.success(`Deleted “${doc.title}”`);
      page.deleted(id);
    },
    retry: () => void session.flush(),
    reload: () => {
      refetch(true).catch((cause: unknown) => toast.error(`Couldn't reload: ${errorMessage(cause)}`));
    },
    keepMine: () => void session.keepMine(),
  };
}
