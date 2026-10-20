import * as ContextMenu from "@radix-ui/react-context-menu";
import { useState, type MouseEvent, type ReactElement, type RefObject } from "react";
import { experimental_copyToClipboard } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { canGroup, canUngroup, normalizeSelection, selectedElements, type ZOrderMove } from "../lib/actions.js";
import { frameContains, selectionFrame } from "../lib/bounds.js";
import { pickTarget } from "../lib/hit.js";
import type { Point } from "../lib/math.js";
import { SELECTION_PADDING } from "../lib/resize.js";
import { screenToScene } from "../lib/viewport.js";
import { usePortalScopeProps } from "../lib/portal-scope";
import { errorMessage } from "./bits";
import { useController, useEditor, useEditorUi } from "./editor-context";
import { alt, LAYER_KEYS, MENU_CONTENT_CLASS, MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS, MenuShortcut, mod } from "./menu";
import {
  copyText,
  cutSelected,
  deleteSelected,
  duplicateSelected,
  groupSelected,
  pasteInto,
  reorderSelected,
  selectEverything,
  ungroupSelected,
} from "./scene-actions";
import type { EditorController } from "./controller";
import { finishEditing } from "./editing";
import { CheckIcon } from "./icons";

const LAYER_ITEMS: readonly { move: ZOrderMove; label: string }[] = [
  { move: "front", label: "Bring to front" },
  { move: "forward", label: "Bring forward" },
  { move: "backward", label: "Send backward" },
  { move: "back", label: "Send to back" },
];

function selectAtPoint(controller: EditorController, point: Point): void {
  const { elements, selectedIds, view } = controller.state;
  const hit = pickTarget(elements, point, view.zoom);
  if (hit !== null) {
    if (!selectedIds.has(hit)) controller.select([hit]);
    return;
  }
  const frame = selectionFrame(selectedElements(elements, selectedIds));
  if (frame !== null && frameContains(frame, point, SELECTION_PADDING / view.zoom)) return;
  controller.clearSelection();
}

async function writeClipboard(text: string | null): Promise<void> {
  if (text === null) return;
  const written = await experimental_copyToClipboard({ text });
  if (!written) throw new Error("bb couldn't write to the clipboard.");
}

async function pasteFromClipboard(controller: EditorController, at: Point): Promise<void> {
  if (typeof navigator.clipboard?.readText !== "function") throw new Error(`Press ${mod("V")} to paste.`);
  const text = await navigator.clipboard.readText();
  if (!pasteInto(controller, text, at)) toast.message("There is nothing to paste.");
}

function report(task: () => Promise<void>): void {
  task().catch((cause: unknown) => toast.error(errorMessage(cause)));
}

function Item({ label, keys, onSelect, disabled }: { label: string; keys?: string; onSelect: () => void; disabled?: boolean }) {
  return (
    <ContextMenu.Item className={MENU_ITEM_CLASS} disabled={disabled} onSelect={onSelect}>
      {label}
      {keys === undefined ? null : <MenuShortcut>{keys}</MenuShortcut>}
    </ContextMenu.Item>
  );
}

function Separator() {
  return <ContextMenu.Separator className={MENU_SEPARATOR_CLASS} />;
}

function SelectionItems({ at }: { at: Point }) {
  const controller = useController();
  const ui = useEditorUi();
  const elements = useEditor((state) => state.elements);
  const selectedIds = useEditor((state) => state.selectedIds);
  return (
    <>
      <Item label="Cut" keys={mod("X")} onSelect={() => report(() => writeClipboard(cutSelected(controller)))} />
      <Item label="Copy" keys={mod("C")} onSelect={() => report(() => writeClipboard(copyText(controller)))} />
      <Item label="Paste" keys={mod("V")} onSelect={() => report(() => pasteFromClipboard(controller, at))} />
      <Item label="Duplicate" keys={mod("D")} onSelect={() => duplicateSelected(controller)} />
      <Item label="Delete" keys="⌫" onSelect={() => deleteSelected(controller)} />
      <Separator />
      <Item label="Send to Wiki…" keys={mod("S", true)} onSelect={ui.send} />
      <Item label="Copy as PNG" keys={alt("C")} onSelect={ui.copyPng} />
      <Separator />
      {LAYER_ITEMS.map((item) => (
        <Item key={item.move} label={item.label} keys={LAYER_KEYS[item.move]} onSelect={() => reorderSelected(controller, item.move)} />
      ))}
      {canGroup(elements, selectedIds) || canUngroup(elements, selectedIds) ? <Separator /> : null}
      {canGroup(elements, selectedIds) ? <Item label="Group" keys={mod("G")} onSelect={() => groupSelected(controller)} /> : null}
      {canUngroup(elements, selectedIds) ? <Item label="Ungroup" keys={mod("G", true)} onSelect={() => ungroupSelected(controller)} /> : null}
    </>
  );
}

function CanvasItems({ at }: { at: Point }) {
  const controller = useController();
  const grid = useEditor((state) => state.grid);
  return (
    <>
      <Item label="Paste" keys={mod("V")} onSelect={() => report(() => pasteFromClipboard(controller, at))} />
      <Item label="Select all" keys={mod("A")} onSelect={() => selectEverything(controller)} />
      <Separator />
      <ContextMenu.CheckboxItem className={MENU_ITEM_CLASS} checked={grid} onCheckedChange={() => controller.toggleGrid()}>
        Show grid
        <ContextMenu.ItemIndicator className="flex items-center">
          <CheckIcon className="size-3.5" />
        </ContextMenu.ItemIndicator>
        <MenuShortcut>{mod("'")}</MenuShortcut>
      </ContextMenu.CheckboxItem>
    </>
  );
}

export function CanvasContextMenu({ canvasRef, children }: { canvasRef: RefObject<HTMLDivElement | null>; children: ReactElement }) {
  const controller = useController();
  const ui = useEditorUi();
  const portalProps = usePortalScopeProps();
  const [at, setAt] = useState<Point>({ x: 0, y: 0 });
  const restoreAfterClose = (event: Event) => {
    event.preventDefault();
    ui.restoreFocus();
  };
  const [hasSelection, setHasSelection] = useState(false);

  const onContextMenu = (event: MouseEvent<HTMLDivElement>) => {
    const element = canvasRef.current;
    if (element === null || controller.hasGesture()) return;
    finishEditing(controller);
    const rect = element.getBoundingClientRect();
    const point = screenToScene(controller.state.view, { x: event.clientX - rect.left, y: event.clientY - rect.top });
    selectAtPoint(controller, point);
    controller.pointerScene = point;
    setAt(point);
    setHasSelection(normalizeSelection(controller.state.elements, controller.state.selectedIds).size > 0);
  };

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild onContextMenu={onContextMenu}>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content {...portalProps} className={MENU_CONTENT_CLASS} aria-label="Canvas actions" onCloseAutoFocus={restoreAfterClose}>
          {hasSelection ? <SelectionItems at={at} /> : <CanvasItems at={at} />}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
