import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { useEffect, useRef, useState, useSyncExternalStore, type ChangeEvent, type ReactNode, type RefObject } from "react";
import type { SketchSummary } from "../contract";
import { usePortalScopeProps } from "../lib/portal-scope";
import { Island, keepRootFocus } from "./bits";
import { useController, useEditor, useEditorUi } from "./editor-context";
import { CheckIcon, ChevronDownIcon } from "./icons";
import { MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_LABEL_CLASS, MENU_SEPARATOR_CLASS, MenuShortcut, mod } from "./menu";
import type { SaveStatus, SketchSession } from "./session";
import { Icon } from "./ui/icon";

const SAVING_DELAY_MS = 500;

export type ExportKind = "png" | "svg" | "excalidraw";

export type SketchMenuActions = {
  readonly open: (id: string) => void;
  readonly create: () => void;
  readonly rename: () => void;
  readonly duplicate: () => void;
  readonly remove: () => void;
  readonly importFile: (file: File) => void;
  readonly exportAs: (kind: ExportKind) => void;
  readonly shortcuts: () => void;
};

function Item({ icon, children, shortcut, disabled, onSelect }: { icon?: string; children: ReactNode; shortcut?: string; disabled?: boolean; onSelect: () => void }) {
  return (
    <DropdownMenu.Item className={MENU_ITEM_CLASS} disabled={disabled} onSelect={onSelect}>
      {icon === undefined ? <span className="size-4" /> : <Icon name={icon} className="size-4 text-muted-foreground" />}
      {children}
      {shortcut === undefined ? null : <MenuShortcut>{shortcut}</MenuShortcut>}
    </DropdownMenu.Item>
  );
}

function SketchList({ sketches, currentId, error, onOpen }: { sketches: readonly SketchSummary[] | undefined; currentId: string | null; error: string | null; onOpen: (id: string) => void }) {
  if (sketches === undefined) return <p className="px-2 py-1.5 text-xs text-muted-foreground">{error ?? "Loading…"}</p>;
  if (sketches.length === 0) return <p className="px-2 py-1.5 text-xs text-muted-foreground">No saved sketches yet.</p>;
  return (
    <div className="max-h-64 overflow-y-auto">
      {sketches.map((sketch) => (
        <DropdownMenu.CheckboxItem key={sketch.id} className={MENU_ITEM_CLASS} checked={sketch.id === currentId} onSelect={() => onOpen(sketch.id)}>
          <span className="flex size-4 shrink-0 items-center justify-center">
            <DropdownMenu.ItemIndicator>
              <CheckIcon className="size-3.5" />
            </DropdownMenu.ItemIndicator>
          </span>
          <span className="min-w-0 flex-1 truncate">{sketch.title}</span>
        </DropdownMenu.CheckboxItem>
      ))}
    </div>
  );
}

function ExportMenu({ hasSelection, onExport }: { hasSelection: boolean; onExport: (kind: ExportKind) => void }) {
  const portalProps = usePortalScopeProps();
  const scope = hasSelection ? " (selection)" : "";
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={MENU_ITEM_CLASS}>
        <Icon name="Download" className="size-4 text-muted-foreground" />
        Export
        <Icon name="ChevronRight" className="ml-auto size-3.5 text-muted-foreground" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent {...portalProps} sideOffset={4} className={MENU_CONTENT_CLASS}>
          <Item onSelect={() => onExport("png")}>PNG image{scope}</Item>
          <Item onSelect={() => onExport("svg")}>SVG image{scope}</Item>
          <Item onSelect={() => onExport("excalidraw")}>.excalidraw file</Item>
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

function FilePicker({ inputRef, onFile }: { inputRef: RefObject<HTMLInputElement | null>; onFile: (file: File) => void }) {
  const onChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file !== undefined) onFile(file);
  };
  return <input ref={inputRef} type="file" accept=".excalidraw,application/json" className="hidden" aria-hidden="true" tabIndex={-1} onChange={onChange} />;
}

export function SketchMenu({ title, currentId, sketches, listError, actions }: {
  title: string;
  currentId: string | null;
  sketches: readonly SketchSummary[] | undefined;
  listError: string | null;
  actions: SketchMenuActions;
}) {
  const controller = useController();
  const ui = useEditorUi();
  const grid = useEditor((state) => state.grid);
  const hasSelection = useEditor((state) => state.selectedIds.size > 0);
  const portalProps = usePortalScopeProps();
  const fileRef = useRef<HTMLInputElement>(null);
  const saved = currentId !== null;
  const restoreAfterClose = (event: Event) => {
    event.preventDefault();
    ui.restoreFocus();
  };
  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`Sketch: ${title}`}
            className="inline-flex h-8 min-w-0 max-w-64 cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-sm font-medium text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[state=open]:bg-state-active"
          >
            <span className="truncate">{title}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content {...portalProps} align="start" sideOffset={6} className={MENU_CONTENT_CLASS} onCloseAutoFocus={restoreAfterClose}>
            <DropdownMenu.Label className={MENU_LABEL_CLASS}>Sketches</DropdownMenu.Label>
            <SketchList sketches={sketches} currentId={currentId} error={listError} onOpen={actions.open} />
            <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
            <Item icon="Plus" onSelect={actions.create}>New sketch</Item>
            <Item icon="Edit" disabled={!saved} onSelect={actions.rename}>Rename…</Item>
            <Item icon="Copy" disabled={!saved} onSelect={actions.duplicate}>Duplicate</Item>
            <Item icon="Trash2" disabled={!saved} onSelect={actions.remove}>Delete…</Item>
            <Item icon="FolderOpen" onSelect={() => fileRef.current?.click()}>Open .excalidraw file…</Item>
            <ExportMenu hasSelection={hasSelection} onExport={actions.exportAs} />
            <DropdownMenu.Separator className={MENU_SEPARATOR_CLASS} />
            <DropdownMenu.CheckboxItem className={MENU_ITEM_CLASS} checked={grid} onCheckedChange={() => controller.toggleGrid()}>
              <span className="flex size-4 items-center justify-center">
                <DropdownMenu.ItemIndicator>
                  <CheckIcon className="size-3.5" />
                </DropdownMenu.ItemIndicator>
              </span>
              Show grid
              <MenuShortcut>{mod("'")}</MenuShortcut>
            </DropdownMenu.CheckboxItem>
            <Item icon="Keyboard" shortcut="?" onSelect={actions.shortcuts}>Keyboard shortcuts</Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <FilePicker inputRef={fileRef} onFile={actions.importFile} />
    </>
  );
}

function useSaveStatus(session: SketchSession): SaveStatus {
  return useSyncExternalStore(session.status.subscribe, () => session.status.get().status, () => session.status.get().status);
}

function useDelayed(active: boolean, delay: number): boolean {
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!active) {
      setShown(false);
      return;
    }
    const timer = setTimeout(() => setShown(true), delay);
    return () => clearTimeout(timer);
  }, [active, delay]);
  return shown;
}

export function SaveState({ session, onRetry }: { session: SketchSession; onRetry: () => void }) {
  const status = useSaveStatus(session);
  const saving = useDelayed(status.kind === "saving", SAVING_DELAY_MS);
  if (status.kind === "error") {
    return (
      <span role="status" title={status.message} className="flex items-center gap-1 px-1 text-xs text-destructive">
        Couldn't save ·
        <button type="button" onMouseDown={keepRootFocus} onClick={onRetry} className="cursor-pointer font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring">
          Retry
        </button>
      </span>
    );
  }
  if (saving) {
    return (
      <span role="status" className="px-1 text-xs text-muted-foreground">
        Saving…
      </span>
    );
  }
  return null;
}

export function MenuIsland({ children }: { children: ReactNode }) {
  return <Island className="flex min-w-0 items-center gap-1 p-1">{children}</Island>;
}
