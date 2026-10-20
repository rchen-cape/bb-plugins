import { useEffect, type RefObject } from "react";
import { isTypingTarget } from "./bits";
import type { EditorController } from "./controller";
import { copyText, cutSelected, pasteInto } from "./scene-actions";

function inScope(root: HTMLElement | null, controller: EditorController): boolean {
  const active = document.activeElement;
  if (root === null || active === null || !root.contains(active)) return false;
  return !isTypingTarget(active) && controller.state.editing === null && !controller.hasGesture();
}

export function useClipboardEvents(root: RefObject<HTMLElement | null>, controller: EditorController): void {
  useEffect(() => {
    const write = (event: ClipboardEvent, text: string | null) => {
      if (text === null || event.clipboardData === null) return;
      event.clipboardData.setData("text/plain", text);
      event.preventDefault();
    };
    const onCopy = (event: ClipboardEvent) => {
      if (inScope(root.current, controller)) write(event, copyText(controller));
    };
    const onCut = (event: ClipboardEvent) => {
      if (!inScope(root.current, controller) || event.clipboardData === null) return;
      write(event, cutSelected(controller));
    };
    const onPaste = (event: ClipboardEvent) => {
      if (!inScope(root.current, controller)) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text === "") return;
      event.preventDefault();
      pasteInto(controller, text);
    };
    document.addEventListener("copy", onCopy);
    document.addEventListener("cut", onCut);
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("copy", onCopy);
      document.removeEventListener("cut", onCut);
      document.removeEventListener("paste", onPaste);
    };
  }, [root, controller]);
}
