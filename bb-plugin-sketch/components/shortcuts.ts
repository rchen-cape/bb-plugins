import { alt, LAYER_KEYS, mod } from "./menu";
import { keyList, LOCK_KEY, TOOL_INFO, TOOLS } from "./tools";

export type ShortcutGroup = { readonly title: string; readonly rows: readonly (readonly [string, string])[] };

export function shortcutGroups(): ShortcutGroup[] {
  return [
    {
      title: "Tools",
      rows: [
        ...TOOLS.map((tool): [string, string] => [TOOL_INFO[tool].label, keyList(TOOL_INFO[tool].keys)]),
        ["Keep the tool after drawing", LOCK_KEY],
        ["Pan", "Space (hold) or middle drag"],
      ],
    },
    {
      title: "Edit",
      rows: [
        ["Edit text or label", "Enter or double-click"],
        ["Delete", "Delete or ⌫"],
        ["Select all", mod("A")],
        ["Duplicate", mod("D")],
        ["Copy, cut, paste", `${mod("C")}, ${mod("X")}, ${mod("V")}`],
        ["Undo, redo", `${mod("Z")}, ${mod("Z", true)}`],
        ["Group, ungroup", `${mod("G")}, ${mod("G", true)}`],
        ["Backward, forward", `${LAYER_KEYS.backward}, ${LAYER_KEYS.forward}`],
        ["To back, to front", `${LAYER_KEYS.back}, ${LAYER_KEYS.front}`],
        ["Nudge", "Arrows, ⇧ Arrows"],
        ["Cancel, deselect", "Esc"],
      ],
    },
    {
      title: "View",
      rows: [
        ["Fit all, fit selection", "⇧1, ⇧2"],
        ["Zoom to 100%", "⇧0"],
        ["Zoom in, out", `⇧=, ⇧-, ${mod("")} wheel or pinch`],
        ["Pan", "Wheel, ⇧ wheel"],
        ["Show grid", mod("'")],
      ],
    },
    {
      title: "Share",
      rows: [
        ["Send to Wiki", mod("S", true)],
        ["Copy as PNG", alt("C")],
        ["Keyboard shortcuts", "?"],
      ],
    },
  ];
}
