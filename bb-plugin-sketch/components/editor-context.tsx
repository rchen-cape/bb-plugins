import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { Theme } from "../lib/colors.js";
import type { EditorUi } from "./commands";
import type { EditorController } from "./controller";
import type { EditorState } from "./editor-state";

const ControllerContext = createContext<EditorController | null>(null);
const ThemeContext = createContext<Theme>("light");
const UiContext = createContext<EditorUi>({ send: () => undefined, shortcuts: () => undefined, copyPng: () => undefined, restoreFocus: () => undefined });

export function EditorProvider({
  controller,
  theme,
  ui,
  children,
}: {
  controller: EditorController;
  theme: Theme;
  ui: EditorUi;
  children: ReactNode;
}) {
  return (
    <ControllerContext.Provider value={controller}>
      <ThemeContext.Provider value={theme}>
        <UiContext.Provider value={ui}>{children}</UiContext.Provider>
      </ThemeContext.Provider>
    </ControllerContext.Provider>
  );
}

export function useController(): EditorController {
  const controller = useContext(ControllerContext);
  if (controller === null) throw new Error("The sketch editor is not mounted.");
  return controller;
}

export function useEditor<T>(selector: (state: EditorState) => T): T {
  const controller = useController();
  const read = () => selector(controller.store.get());
  return useSyncExternalStore(controller.store.subscribe, read, read);
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}

export function useEditorUi(): EditorUi {
  return useContext(UiContext);
}
