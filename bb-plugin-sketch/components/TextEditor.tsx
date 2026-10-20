import { useLayoutEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";
import { paint } from "../lib/colors.js";
import type { SketchElement, TextElement } from "../lib/scene.js";
import { fontStack, lineHeightPx } from "../lib/text.js";
import { useController, useEditor, useTheme } from "./editor-context";
import { finishEditing, updateEditing } from "./editing";
import { textBox } from "./text-box";
import { isModEnter } from "./ui/shortcut";

const INDENT = "    ";
const IME_KEY_CODE = 229;

function isComposing(event: Pick<KeyboardEvent, "keyCode" | "nativeEvent">): boolean {
  return event.nativeEvent.isComposing || event.keyCode === IME_KEY_CODE;
}

function editedText(elements: readonly SketchElement[], id: string): TextElement | null {
  const found = elements.find((element) => element.id === id);
  return found?.type === "text" ? found : null;
}

function TextArea({ text, value }: { text: TextElement; value: string }) {
  const controller = useController();
  const elements = useEditor((state) => state.elements);
  const view = useEditor((state) => state.view);
  const theme = useTheme();
  const ref = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return;
    node.focus({ preventScroll: true });
    node.setSelectionRange(node.value.length, node.value.length);
  }, []);

  const box = textBox(text, elements, view);
  const fontSize = text.fontSize * view.zoom;
  const style: CSSProperties = {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
    fontFamily: fontStack(text.fontFamily),
    fontSize: `${fontSize}px`,
    lineHeight: `${lineHeightPx(fontSize, text.lineHeight)}px`,
    color: paint(text.strokeColor, theme),
    opacity: text.opacity / 100,
    textAlign: text.textAlign,
    whiteSpace: box.wrap ? "pre-wrap" : "pre",
    overflowWrap: box.wrap ? "break-word" : "normal",
    transform: box.angle === 0 ? undefined : `rotate(${box.angle}rad)`,
    transformOrigin: "center",
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isComposing(event)) return;
    if (event.key === "Escape" || isModEnter(event)) {
      event.preventDefault();
      event.stopPropagation();
      const root = event.currentTarget.closest<HTMLElement>("[data-sketch-root]");
      finishEditing(controller);
      root?.focus({ preventScroll: true });
      return;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      const node = event.currentTarget;
      node.setRangeText(INDENT, node.selectionStart, node.selectionEnd, "end");
      updateEditing(controller, node.value);
    }
  };

  return (
    <textarea
      ref={ref}
      value={value}
      aria-label={text.containerId === null ? "Text" : "Label"}
      spellCheck={false}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      wrap={box.wrap ? "soft" : "off"}
      data-sketch-text-editor=""
      className="absolute z-10 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 outline-none"
      style={style}
      onChange={(event) => updateEditing(controller, event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={() => finishEditing(controller)}
      onPointerDown={(event) => event.stopPropagation()}
    />
  );
}

export function TextEditor() {
  const editing = useEditor((state) => state.editing);
  const elements = useEditor((state) => state.elements);
  if (editing === null) return null;
  const text = editedText(elements, editing.textId) ?? editedText(editing.snapshot, editing.textId);
  if (text === null) return null;
  return <TextArea key={editing.textId} text={text} value={editing.value} />;
}
