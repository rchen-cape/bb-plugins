import { useEffect, useState } from "react";
import { experimental_useCodeTheme } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import type { SketchSummary } from "../contract";
import { gridEnabled } from "../lib/scene.js";
import { EditorController } from "./controller";
import { Editor } from "./Editor";
import { useLatest, useSketchRpc } from "./hooks";
import { MissingBanner } from "./MissingBanner";
import { useRemoteChanges } from "./remote-changes";
import { createRescueCopy, useRescueOnLeave } from "./rescue";
import type { SketchSession } from "./session";
import { readStyle, readView } from "./storage";
import { useWorkspaceActions } from "./workspace-actions";
import { createSession, useEditorPersistence, useFonts, useViewAndStyle } from "./workspace-effects";
import type { OpenDoc, PageActions } from "./workspace-types";

export type { OpenDoc, PageActions } from "./workspace-types";

export type WorkspacePage = PageActions & { readonly track: (session: SketchSession) => () => void };

export function Workspace({ doc, sketches, listError, page }: {
  doc: OpenDoc;
  sketches: readonly SketchSummary[] | undefined;
  listError: string | null;
  page: WorkspacePage;
}) {
  const rpc = useLatest(useSketchRpc());
  const pageRef = useLatest(page);
  const titleRef = useLatest(doc.title);
  const theme = experimental_useCodeTheme().mode;
  const [controller] = useState(
    () =>
      new EditorController({
        elements: doc.scene.elements,
        view: doc.id === null ? null : readView(doc.id),
        style: readStyle(),
        grid: gridEnabled(doc.scene.appState),
      }),
  );
  const [session] = useState(() => createSession(rpc, doc, pageRef));
  useEditorPersistence(controller, session);
  useViewAndStyle(controller, session);
  useFonts(controller);
  useRescueOnLeave(session, rpc, titleRef);
  useEffect(() => pageRef.current.track(session), [pageRef, session]);
  const refetch = useRemoteChanges(controller, session, pageRef);
  const actions = useWorkspaceActions(controller, session, doc, page, refetch);
  const saveAsNew = () => {
    const copy = createRescueCopy(rpc, titleRef);
    void session.saveAsNew(async (content) => {
      const created = await copy(content);
      toast.success(`Saved as “${created.title}”`);
      return created;
    });
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <Editor
        controller={controller}
        session={session}
        theme={theme}
        title={doc.title}
        currentId={doc.id}
        sketches={sketches}
        listError={listError}
        actions={actions}
      />
      <MissingBanner session={session} title={doc.title} onSaveAsNew={saveAsNew} />
    </div>
  );
}
