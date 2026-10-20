import { useEffect } from "react";
import { gridEnabled } from "../lib/scene.js";
import { createCanvasMeasure } from "../lib/text.js";
import type { EditorController } from "./controller";
import { blobToBase64, renderPng } from "./export-png";
import { loadSketchFonts } from "./fonts";
import type { SketchRpc } from "./hooks";
import { SketchSession } from "./session";
import { writeStyle, writeView } from "./storage";
import type { OpenDoc, PageActions } from "./workspace-types";

const VIEW_SAVE_MS = 300;

export function createSession(rpc: { readonly current: SketchRpc }, doc: OpenDoc, page: { readonly current: PageActions }): SketchSession {
  return new SketchSession(
    {
      save: (input) => rpc.current.call("save", input),
      create: (content) => rpc.current.call("create", { title: null, content }),
      savePreview: async ({ id, sha256, elements }) => {
        const image = await renderPng(elements);
        await rpc.current.call("savePreview", { id, sha256, png: await blobToBase64(image.blob) });
      },
      onCreated: ({ id, title }) => page.current.identify(id, title),
    },
    {
      id: doc.id,
      sha256: doc.sha256,
      appState: doc.scene.appState,
      files: doc.scene.files,
      draft: { elements: doc.scene.elements, grid: gridEnabled(doc.scene.appState) },
    },
  );
}

export function useEditorPersistence(controller: EditorController, session: SketchSession): void {
  useEffect(() => {
    const sync = () => {
      const state = controller.state;
      session.update({ elements: state.history.present.elements, grid: state.grid });
    };
    const unsubscribe = controller.store.subscribe(sync);
    const onVisibility = () => {
      if (document.visibilityState === "hidden") void session.flush();
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (session.id !== null) session.schedulePreview();
    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", onVisibility);
      void session.flush();
      session.dispose();
    };
  }, [controller, session]);
}

export function useViewAndStyle(controller: EditorController, session: SketchSession): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let { view, style } = controller.state;
    const unsubscribe = controller.store.subscribe(() => {
      const state = controller.state;
      if (state.style !== style) {
        style = state.style;
        writeStyle(style);
      }
      if (state.view === view) return;
      view = state.view;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        if (session.id !== null) writeView(session.id, view);
      }, VIEW_SAVE_MS);
    });
    return () => {
      unsubscribe();
      if (timer !== null) clearTimeout(timer);
      if (session.id !== null) writeView(session.id, controller.state.view);
    };
  }, [controller, session]);
}

export function useFonts(controller: EditorController): void {
  useEffect(() => {
    let alive = true;
    void loadSketchFonts().then(() => {
      if (alive) controller.setMeasure(createCanvasMeasure());
    });
    return () => {
      alive = false;
    };
  }, [controller]);
}
