import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { toast } from "sonner";
import type { SketchSummary } from "../contract";
import type { Theme } from "../lib/colors.js";
import { Canvas } from "./Canvas";
import { isControlTarget, isTypingTarget } from "./bits";
import { runCommand, type EditorUi } from "./commands";
import { ConflictBanner } from "./ConflictBanner";
import type { EditorController } from "./controller";
import { EditorProvider, useEditor } from "./editor-context";
import { copyAsPng } from "./exporting";
import { keyCommand } from "./keys";
import { PropertiesPanel } from "./PropertiesPanel";
import { exportTargets, hasSelection } from "./scene-actions";
import type { SketchSession } from "./session";
import { SendToWikiDialog, type SendTarget } from "./SendToWikiDialog";
import { DeleteDialog, RenameDialog, ShortcutsDialog } from "./SketchDialogs";
import { MenuIsland, SaveState, SketchMenu, type SketchMenuActions } from "./SketchMenu";
import { TopBar } from "./TopBar";
import { TooltipProvider } from "./ui/tooltip";
import { useClipboardEvents } from "./use-clipboard";
import { useRootFocus } from "./use-root-focus";
import { ZoomControls } from "./ZoomControls";

export type WorkspaceActions = Omit<SketchMenuActions, "rename" | "remove" | "shortcuts"> & {
  readonly rename: (title: string) => Promise<void>;
  readonly remove: () => Promise<void>;
  readonly retry: () => void;
  readonly reload: () => void;
  readonly keepMine: () => void;
};

export type EditorProps = {
  readonly controller: EditorController;
  readonly session: SketchSession;
  readonly theme: Theme;
  readonly title: string;
  readonly currentId: string | null;
  readonly sketches: readonly SketchSummary[] | undefined;
  readonly listError: string | null;
  readonly actions: WorkspaceActions;
};

type OpenDialog = { readonly kind: "send"; readonly target: SendTarget } | { readonly kind: "rename" | "delete" | "shortcuts" } | null;

function EmptyHint() {
  const empty = useEditor((state) => state.elements.length === 0 && state.editing === null && !state.gestureActive);
  if (!empty) return null;
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 flex items-center justify-center p-6">
      <p className="text-center text-sm text-muted-foreground opacity-70">Pick a tool, or press R, O, A, T to start</p>
    </div>
  );
}

function useWikiLink() {
  const ref = useRef<HTMLAnchorElement>(null);
  const open = (href: string) => {
    const anchor = ref.current;
    if (anchor === null) return;
    anchor.setAttribute("href", href);
    anchor.click();
  };
  return { ref, open };
}

export function Editor({ controller, session, theme, title, currentId, sketches, listError, actions }: EditorProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [dialog, setDialog] = useState<OpenDialog>(null);
  const wikiLink = useWikiLink();
  const restoreFocus = useRootFocus(rootRef);
  useClipboardEvents(rootRef, controller);
  useEffect(() => {
    if (!isTypingTarget(document.activeElement)) rootRef.current?.focus({ preventScroll: true });
  }, []);

  const ui = useMemo<EditorUi>(
    () => ({
      send: () => {
        const elements = exportTargets(controller);
        if (elements.length === 0) {
          toast.message("Draw something first.");
          return;
        }
        controller.cancelGesture();
        setDialog({ kind: "send", target: { elements, title, selection: hasSelection(controller) } });
      },
      shortcuts: () => setDialog({ kind: "shortcuts" }),
      copyPng: () => copyAsPng(controller),
      restoreFocus,
    }),
    [controller, title, restoreFocus],
  );

  const menuActions: SketchMenuActions = {
    ...actions,
    rename: () => setDialog({ kind: "rename" }),
    remove: () => setDialog({ kind: "delete" }),
    shortcuts: ui.shortcuts,
  };

  const owns = (target: EventTarget) => target instanceof Node && rootRef.current !== null && rootRef.current.contains(target);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || !owns(event.target) || isTypingTarget(event.target)) return;
    const command = keyCommand(event, { onControl: isControlTarget(event.target) });
    if (command === null) return;
    event.preventDefault();
    event.stopPropagation();
    runCommand(controller, command, ui);
  };

  const onKeyUp = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === " " && controller.state.spaceHeld) controller.setSpaceHeld(false);
  };

  const close = () => {
    setDialog(null);
    restoreFocus();
  };

  return (
    <EditorProvider controller={controller} theme={theme} ui={ui}>
      <TooltipProvider delayDuration={500} skipDelayDuration={200}>
        <div
          ref={rootRef}
          tabIndex={0}
          data-sketch-root=""
          aria-label={`Sketch ${title}`}
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-background outline-none"
          onKeyDown={onKeyDown}
          onKeyUp={onKeyUp}
          onBlur={() => controller.setSpaceHeld(false)}
        >
          <Canvas onFocusRoot={() => rootRef.current?.focus({ preventScroll: true })} />
          <EmptyHint />
          <div className="pointer-events-none absolute inset-3 z-10 flex flex-col gap-2">
            <TopBar
              menu={
                <MenuIsland>
                  <SketchMenu title={title} currentId={currentId} sketches={sketches} listError={listError} actions={menuActions} />
                  <SaveState session={session} onRetry={actions.retry} />
                </MenuIsland>
              }
            />
            <div className="flex min-h-0 flex-1 items-start gap-2">
              <PropertiesPanel />
              <div className="flex min-w-0 flex-1 justify-center">
                <ConflictBanner session={session} onReload={actions.reload} onKeepMine={actions.keepMine} />
              </div>
            </div>
            <div className="pointer-events-auto flex self-start">
              <ZoomControls />
            </div>
          </div>
          <a ref={wikiLink.ref} hidden aria-hidden="true" tabIndex={-1} data-sketch-wiki-link="" />
          {dialog?.kind === "send" ? <SendToWikiDialog target={dialog.target} onClose={close} openWiki={wikiLink.open} /> : null}
          {dialog?.kind === "rename" ? <RenameDialog title={title} onRename={actions.rename} onClose={close} /> : null}
          {dialog?.kind === "delete" ? <DeleteDialog title={title} onDelete={actions.remove} onClose={close} /> : null}
          {dialog?.kind === "shortcuts" ? <ShortcutsDialog onClose={close} /> : null}
        </div>
      </TooltipProvider>
    </EditorProvider>
  );
}
