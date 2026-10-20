import { canRedo, canUndo } from "../lib/history.js";
import { Island, keepRootFocus } from "./bits";
import { useController, useEditor } from "./editor-context";
import { MinusIcon, PlusIcon, RedoIcon, UndoIcon } from "./icons";
import { mod } from "./menu";
import { ToolButton } from "./ToolButton";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";
import { resetZoom, zoomStep } from "./view-actions";

export function ZoomControls() {
  const controller = useController();
  const zoom = useEditor((state) => state.view.zoom);
  const history = useEditor((state) => state.history);
  const busy = useEditor((state) => state.editing !== null || state.gestureActive);
  return (
    <div className="flex items-center gap-2">
      <Island role="group" aria-label="Zoom" className="flex items-center gap-0.5 p-1">
        <ToolButton side="top" label="Zoom out" tooltip="Zoom out · ⇧-" onClick={() => zoomStep(controller, -1)}>
          <MinusIcon />
        </ToolButton>
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={`Zoom ${Math.round(zoom * 100)}%, reset to 100%`}
              onMouseDown={keepRootFocus}
              onClick={() => resetZoom(controller)}
              className="h-8 min-w-14 cursor-pointer rounded-md px-1.5 text-xs tabular-nums text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            >
              {Math.round(zoom * 100)}%
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">Reset to 100% · ⇧0</TooltipContent>
        </Tooltip>
        <ToolButton side="top" label="Zoom in" tooltip="Zoom in · ⇧=" onClick={() => zoomStep(controller, 1)}>
          <PlusIcon />
        </ToolButton>
      </Island>
      <Island role="group" aria-label="History" className="flex items-center gap-0.5 p-1">
        <ToolButton side="top" label="Undo" tooltip={`Undo · ${mod("Z")}`} disabled={busy || !canUndo(history)} onClick={() => controller.undo()}>
          <UndoIcon />
        </ToolButton>
        <ToolButton side="top" label="Redo" tooltip={`Redo · ${mod("Z", true)}`} disabled={busy || !canRedo(history)} onClick={() => controller.redo()}>
          <RedoIcon />
        </ToolButton>
      </Island>
    </div>
  );
}
