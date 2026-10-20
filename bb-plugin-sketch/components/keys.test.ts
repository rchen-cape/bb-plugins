import { describe, expect, it } from "vitest";
import { keyCommand, type KeyInput } from "./keys";

function key(input: Partial<KeyInput> & { key: string }): KeyInput {
  return { code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...input };
}

describe("keyCommand", () => {
  it("maps single letters and digits to tools", () => {
    expect(keyCommand(key({ key: "v" }))).toEqual({ kind: "tool", tool: "select" });
    expect(keyCommand(key({ key: "1" }))).toEqual({ kind: "tool", tool: "select" });
    expect(keyCommand(key({ key: "R" }))).toEqual({ kind: "tool", tool: "rectangle" });
    expect(keyCommand(key({ key: "3" }))).toEqual({ kind: "tool", tool: "diamond" });
    expect(keyCommand(key({ key: "o" }))).toEqual({ kind: "tool", tool: "ellipse" });
    expect(keyCommand(key({ key: "a" }))).toEqual({ kind: "tool", tool: "arrow" });
    expect(keyCommand(key({ key: "6" }))).toEqual({ kind: "tool", tool: "line" });
    expect(keyCommand(key({ key: "x" }))).toEqual({ kind: "tool", tool: "draw" });
    expect(keyCommand(key({ key: "p" }))).toEqual({ kind: "tool", tool: "draw" });
    expect(keyCommand(key({ key: "8" }))).toEqual({ kind: "tool", tool: "text" });
    expect(keyCommand(key({ key: "0" }))).toEqual({ kind: "tool", tool: "eraser" });
    expect(keyCommand(key({ key: "h" }))).toEqual({ kind: "tool", tool: "hand" });
    expect(keyCommand(key({ key: "q" }))).toEqual({ kind: "lock" });
    expect(keyCommand(key({ key: "z" }))).toBeNull();
  });

  it("maps editing keys", () => {
    expect(keyCommand(key({ key: "Escape" }))).toEqual({ kind: "escape" });
    expect(keyCommand(key({ key: "Backspace" }))).toEqual({ kind: "delete" });
    expect(keyCommand(key({ key: "Delete" }))).toEqual({ kind: "delete" });
    expect(keyCommand(key({ key: "Enter" }))).toEqual({ kind: "edit-text" });
    expect(keyCommand(key({ key: " " }))).toEqual({ kind: "space" });
    expect(keyCommand(key({ key: "ArrowLeft" }))).toEqual({ kind: "nudge", dx: -1, dy: 0, big: false });
    expect(keyCommand(key({ key: "ArrowDown", shiftKey: true }))).toEqual({ kind: "nudge", dx: 0, dy: 1, big: true });
  });

  it("leaves Enter, Space and arrows to focused controls", () => {
    const onControl = { onControl: true };
    expect(keyCommand(key({ key: "Enter" }), onControl)).toBeNull();
    expect(keyCommand(key({ key: " " }), onControl)).toBeNull();
    expect(keyCommand(key({ key: "ArrowUp" }), onControl)).toBeNull();
    expect(keyCommand(key({ key: "r" }), onControl)).toEqual({ kind: "tool", tool: "rectangle" });
  });

  it("maps modifier chords by physical key", () => {
    expect(keyCommand(key({ key: "a", code: "KeyA", metaKey: true }))).toEqual({ kind: "select-all" });
    expect(keyCommand(key({ key: "d", code: "KeyD", ctrlKey: true }))).toEqual({ kind: "duplicate" });
    expect(keyCommand(key({ key: "z", code: "KeyZ", metaKey: true }))).toEqual({ kind: "undo" });
    expect(keyCommand(key({ key: "z", code: "KeyZ", metaKey: true, shiftKey: true }))).toEqual({ kind: "redo" });
    expect(keyCommand(key({ key: "y", code: "KeyY", ctrlKey: true }))).toEqual({ kind: "redo" });
    expect(keyCommand(key({ key: "g", code: "KeyG", metaKey: true }))).toEqual({ kind: "group" });
    expect(keyCommand(key({ key: "g", code: "KeyG", metaKey: true, shiftKey: true }))).toEqual({ kind: "ungroup" });
    expect(keyCommand(key({ key: "'", code: "Quote", metaKey: true }))).toEqual({ kind: "grid" });
    expect(keyCommand(key({ key: "s", code: "KeyS", metaKey: true, shiftKey: true }))).toEqual({ kind: "send" });
    expect(keyCommand(key({ key: "s", code: "KeyS", metaKey: true }))).toBeNull();
    expect(keyCommand(key({ key: "c", code: "KeyC", metaKey: true }))).toBeNull();
    expect(keyCommand(key({ key: "v", code: "KeyV", metaKey: true }))).toBeNull();
  });

  it("maps layer moves on both platforms", () => {
    expect(keyCommand(key({ key: "[", code: "BracketLeft", metaKey: true }))).toEqual({ kind: "reorder", move: "backward" });
    expect(keyCommand(key({ key: "]", code: "BracketRight", metaKey: true }))).toEqual({ kind: "reorder", move: "forward" });
    expect(keyCommand(key({ key: "“", code: "BracketLeft", metaKey: true, altKey: true }))).toEqual({ kind: "reorder", move: "back" });
    expect(keyCommand(key({ key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true }))).toEqual({ kind: "reorder", move: "front" });
  });

  it("maps view and share keys", () => {
    expect(keyCommand(key({ key: "!", code: "Digit1", shiftKey: true }))).toEqual({ kind: "fit-all" });
    expect(keyCommand(key({ key: "@", code: "Digit2", shiftKey: true }))).toEqual({ kind: "fit-selection" });
    expect(keyCommand(key({ key: ")", code: "Digit0", shiftKey: true }))).toEqual({ kind: "zoom-reset" });
    expect(keyCommand(key({ key: "+", code: "Equal", shiftKey: true }))).toEqual({ kind: "zoom", direction: 1 });
    expect(keyCommand(key({ key: "_", code: "Minus", shiftKey: true }))).toEqual({ kind: "zoom", direction: -1 });
    expect(keyCommand(key({ key: "Ç", code: "KeyC", altKey: true, shiftKey: true }))).toEqual({ kind: "copy-png" });
    expect(keyCommand(key({ key: "?", code: "Slash", shiftKey: true }))).toEqual({ kind: "shortcuts" });
    expect(keyCommand(key({ key: "R", code: "KeyR", shiftKey: true }))).toBeNull();
  });
});
