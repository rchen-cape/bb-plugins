import { Island } from "./bits";
import { useController, useEditor } from "./editor-context";
import { LockIcon, ToolIcon } from "./icons";
import { ToolButton } from "./ToolButton";
import { LOCK_KEY, TOOL_INFO, TOOLS, toolTitle } from "./tools";

export function Toolbar() {
  const controller = useController();
  const tool = useEditor((state) => state.tool);
  const locked = useEditor((state) => state.locked);
  return (
    <Island role="toolbar" aria-label="Tools" aria-orientation="horizontal" className="flex max-w-full items-center gap-0.5 overflow-x-auto p-1">
      <ToolButton
        label="Keep tool after drawing"
        tooltip={`Keep the tool after drawing · ${LOCK_KEY}`}
        hint={LOCK_KEY}
        pressed={locked}
        onClick={() => controller.toggleLock()}
      >
        <LockIcon open={!locked} />
      </ToolButton>
      <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" />
      {TOOLS.map((id) => (
        <ToolButton
          key={id}
          label={TOOL_INFO[id].label}
          tooltip={toolTitle(id)}
          hint={TOOL_INFO[id].hint}
          aria-keyshortcuts={TOOL_INFO[id].keys.join(" ")}
          pressed={tool === id}
          onClick={() => controller.setTool(id)}
        >
          <ToolIcon tool={id} />
        </ToolButton>
      ))}
    </Island>
  );
}
