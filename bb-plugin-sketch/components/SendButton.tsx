import { Island, keepRootFocus } from "./bits";
import { useEditor, useEditorUi } from "./editor-context";
import { SendIcon } from "./icons";
import { mod } from "./menu";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

export function SendButton() {
  const ui = useEditorUi();
  const empty = useEditor((state) => state.elements.length === 0);
  const selection = useEditor((state) => state.selectedIds.size > 0);
  const what = selection ? "Send the selection to your Wiki" : "Send the whole sketch to your Wiki";
  return (
    <Island className="p-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type="button" size="sm" disabled={empty} onMouseDown={keepRootFocus} onClick={ui.send} aria-label="Send to Wiki" className="h-8 shrink-0 gap-1.5 px-3">
            <SendIcon className="size-3.5" />
            <span data-send-label="" className="hidden @md:inline">
              Send to Wiki
            </span>
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {what} · {mod("S", true)}
        </TooltipContent>
      </Tooltip>
    </Island>
  );
}
