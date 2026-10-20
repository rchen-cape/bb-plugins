import type { ZOrderMove } from "../lib/actions.js";
import { toolForKey, type ToolId } from "./tools";

export type KeyCommand =
  | { readonly kind: "tool"; readonly tool: ToolId }
  | { readonly kind: "lock" }
  | { readonly kind: "escape" }
  | { readonly kind: "delete" }
  | { readonly kind: "edit-text" }
  | { readonly kind: "select-all" }
  | { readonly kind: "duplicate" }
  | { readonly kind: "undo" }
  | { readonly kind: "redo" }
  | { readonly kind: "group" }
  | { readonly kind: "ungroup" }
  | { readonly kind: "reorder"; readonly move: ZOrderMove }
  | { readonly kind: "nudge"; readonly dx: number; readonly dy: number; readonly big: boolean }
  | { readonly kind: "fit-all" }
  | { readonly kind: "fit-selection" }
  | { readonly kind: "zoom-reset" }
  | { readonly kind: "zoom"; readonly direction: 1 | -1 }
  | { readonly kind: "grid" }
  | { readonly kind: "copy-png" }
  | { readonly kind: "send" }
  | { readonly kind: "shortcuts" }
  | { readonly kind: "space" };

export type KeyInput = {
  readonly key: string;
  readonly code: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
};

export type KeyContext = { readonly onControl: boolean };

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

function bracket(input: KeyInput): ZOrderMove | null {
  const deep = input.altKey || input.shiftKey;
  if (input.code === "BracketLeft") return deep ? "back" : "backward";
  if (input.code === "BracketRight") return deep ? "front" : "forward";
  return null;
}

function modCommand(input: KeyInput): KeyCommand | null {
  const move = bracket(input);
  if (move !== null) return { kind: "reorder", move };
  if (input.altKey) return null;
  switch (input.code) {
    case "KeyA":
      return input.shiftKey ? null : { kind: "select-all" };
    case "KeyD":
      return input.shiftKey ? null : { kind: "duplicate" };
    case "KeyZ":
      return { kind: input.shiftKey ? "redo" : "undo" };
    case "KeyY":
      return input.ctrlKey && !input.shiftKey ? { kind: "redo" } : null;
    case "KeyG":
      return { kind: input.shiftKey ? "ungroup" : "group" };
    case "Quote":
      return input.shiftKey ? null : { kind: "grid" };
    case "KeyS":
      return input.shiftKey ? { kind: "send" } : null;
    default:
      return null;
  }
}

function shiftCommand(input: KeyInput, context: KeyContext): KeyCommand | null {
  switch (input.code) {
    case "Digit1":
      return { kind: "fit-all" };
    case "Digit2":
      return { kind: "fit-selection" };
    case "Digit0":
      return { kind: "zoom-reset" };
    case "Equal":
      return { kind: "zoom", direction: 1 };
    case "Minus":
      return { kind: "zoom", direction: -1 };
  }
  if (input.key === "?") return { kind: "shortcuts" };
  const arrow = ARROWS[input.key];
  if (arrow !== undefined && !context.onControl) return { kind: "nudge", dx: arrow[0], dy: arrow[1], big: true };
  return null;
}

function plainCommand(input: KeyInput, context: KeyContext): KeyCommand | null {
  switch (input.key) {
    case "Escape":
      return { kind: "escape" };
    case "Delete":
    case "Backspace":
      return { kind: "delete" };
    case "Enter":
      return context.onControl ? null : { kind: "edit-text" };
    case " ":
      return context.onControl ? null : { kind: "space" };
    case "?":
      return { kind: "shortcuts" };
    case "+":
      return { kind: "zoom", direction: 1 };
  }
  const arrow = ARROWS[input.key];
  if (arrow !== undefined) return context.onControl ? null : { kind: "nudge", dx: arrow[0], dy: arrow[1], big: false };
  if (input.key.toLowerCase() === "q") return { kind: "lock" };
  const tool = input.key.length === 1 ? toolForKey(input.key) : null;
  return tool === null ? null : { kind: "tool", tool };
}

export function keyCommand(input: KeyInput, context: KeyContext = { onControl: false }): KeyCommand | null {
  if (input.metaKey || input.ctrlKey) return modCommand(input);
  if (input.altKey) return input.shiftKey && input.code === "KeyC" ? { kind: "copy-png" } : null;
  if (input.shiftKey) return shiftCommand(input, context);
  return plainCommand(input, context);
}
