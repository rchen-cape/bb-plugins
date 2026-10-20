import type { ReactNode } from "react";
import { MOD_KEY_LABEL } from "./ui/shortcut";

export const MENU_CONTENT_CLASS =
  "z-50 min-w-52 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none";
export const MENU_ITEM_CLASS =
  "relative flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-state-hover";
export const MENU_LABEL_CLASS = "px-2 pb-1 pt-1.5 text-xs font-medium text-muted-foreground";
export const MENU_SEPARATOR_CLASS = "-mx-1 my-1 h-px bg-border";

export function MenuShortcut({ children }: { children: ReactNode }) {
  return <span className="ml-auto pl-4 text-xs tracking-wide text-muted-foreground">{children}</span>;
}

export function mod(key: string, shift = false): string {
  const shiftLabel = shift ? (MOD_KEY_LABEL === "⌘" ? "⇧" : "Shift+") : "";
  return MOD_KEY_LABEL === "⌘" ? `⌘${shiftLabel}${key}` : `Ctrl+${shiftLabel}${key}`;
}

export function alt(key: string): string {
  return MOD_KEY_LABEL === "⌘" ? `⌥⇧${key}` : `Alt+Shift+${key}`;
}

export const LAYER_KEYS = {
  front: MOD_KEY_LABEL === "⌘" ? "⌘⌥]" : "Ctrl+Shift+]",
  forward: mod("]"),
  backward: mod("["),
  back: MOD_KEY_LABEL === "⌘" ? "⌘⌥[" : "Ctrl+Shift+[",
} as const;
