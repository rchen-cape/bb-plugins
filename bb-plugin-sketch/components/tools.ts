import type { ElementType } from "../lib/scene.js";

export const TOOLS = ["hand", "select", "rectangle", "diamond", "ellipse", "arrow", "line", "draw", "text", "eraser"] as const;
export type ToolId = (typeof TOOLS)[number];

const DRAWING_TOOLS = ["rectangle", "diamond", "ellipse", "arrow", "line", "draw", "text"] as const;
export type DrawingTool = (typeof DRAWING_TOOLS)[number];

export type ToolInfo = { readonly label: string; readonly keys: readonly string[]; readonly hint: string };

export const TOOL_INFO: Record<ToolId, ToolInfo> = {
  hand: { label: "Hand", keys: ["H"], hint: "H" },
  select: { label: "Select", keys: ["V", "1"], hint: "1" },
  rectangle: { label: "Rectangle", keys: ["R", "2"], hint: "2" },
  diamond: { label: "Diamond", keys: ["D", "3"], hint: "3" },
  ellipse: { label: "Ellipse", keys: ["O", "4"], hint: "4" },
  arrow: { label: "Arrow", keys: ["A", "5"], hint: "5" },
  line: { label: "Line", keys: ["L", "6"], hint: "6" },
  draw: { label: "Draw", keys: ["P", "X", "7"], hint: "7" },
  text: { label: "Text", keys: ["T", "8"], hint: "8" },
  eraser: { label: "Eraser", keys: ["E", "0"], hint: "0" },
};

export const LOCK_KEY = "Q";

const TOOL_BY_KEY = new Map<string, ToolId>(
  TOOLS.flatMap((tool) => TOOL_INFO[tool].keys.map((key): [string, ToolId] => [key.toLowerCase(), tool])),
);

export function toolForKey(key: string): ToolId | null {
  return TOOL_BY_KEY.get(key.toLowerCase()) ?? null;
}

export function keyList(keys: readonly string[]): string {
  if (keys.length <= 1) return keys.join("");
  return `${keys.slice(0, -1).join(", ")} or ${keys[keys.length - 1] ?? ""}`;
}

export function toolTitle(tool: ToolId): string {
  const info = TOOL_INFO[tool];
  return `${info.label} · ${keyList(info.keys)}`;
}

export function isDrawingTool(tool: ToolId): tool is DrawingTool {
  return DRAWING_TOOLS.some((candidate) => candidate === tool);
}

export function toolElementType(tool: DrawingTool): ElementType {
  return tool === "draw" ? "freedraw" : tool;
}
