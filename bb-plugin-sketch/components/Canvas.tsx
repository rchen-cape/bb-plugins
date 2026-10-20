import { useEffect, useMemo, useRef, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import type { Point } from "../lib/math.js";
import { screenToScene } from "../lib/viewport.js";
import { CanvasContextMenu } from "./CanvasContextMenu";
import type { EditorController } from "./controller";
import { useController, useEditor } from "./editor-context";
import type { EditorState } from "./editor-state";
import { editAt } from "./editing";
import { MIDDLE_BUTTON } from "./gestures/start";
import { PointerRouter } from "./gestures/router";
import { OverlayLayer } from "./OverlayLayer";
import { SceneLayer } from "./SceneLayer";
import { TextEditor } from "./TextEditor";
import { isTypingTarget } from "./bits";
import { isDrawingTool } from "./tools";
import { useCanvasWheel } from "./use-wheel";

const RIGHT_BUTTON = 2;

function useCanvasSize(ref: RefObject<HTMLElement | null>, controller: EditorController): void {
  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      controller.setSize({
        width: rect.width || element.clientWidth || window.innerWidth,
        height: rect.height || element.clientHeight || window.innerHeight,
      });
    };
    measure();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, controller]);
}

function cursorFor(state: Pick<EditorState, "tool" | "spaceHeld" | "panning" | "hoverCursor">): string {
  if (state.panning) return "grabbing";
  if (state.spaceHeld || state.tool === "hand") return "grab";
  if (state.tool === "eraser") return "none";
  if (state.tool === "text") return "text";
  if (isDrawingTool(state.tool)) return "crosshair";
  return state.hoverCursor ?? "default";
}

function capture(element: HTMLElement, pointerId: number): void {
  if (typeof element.setPointerCapture !== "function") return;
  try {
    element.setPointerCapture(pointerId);
  } catch {
    return;
  }
}

function localPoint(element: HTMLElement, event: { clientX: number; clientY: number }): Point {
  const rect = element.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

export function Canvas({ onFocusRoot }: { onFocusRoot: () => void }) {
  const controller = useController();
  const ref = useRef<HTMLDivElement>(null);
  const router = useMemo(
    () =>
      new PointerRouter(controller, () => {
        const rect = ref.current?.getBoundingClientRect();
        return { x: rect?.left ?? 0, y: rect?.top ?? 0 };
      }),
    [controller],
  );
  useEffect(() => () => router.dispose(), [router]);
  useCanvasSize(ref, controller);
  useCanvasWheel(ref, controller);

  const tool = useEditor((state) => state.tool);
  const spaceHeld = useEditor((state) => state.spaceHeld);
  const panning = useEditor((state) => state.panning);
  const hoverCursor = useEditor((state) => state.hoverCursor);
  const cursor = cursorFor({ tool, spaceHeld, panning, hoverCursor });

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button === RIGHT_BUTTON || isTypingTarget(event.target)) return;
    if (event.button === 0 || event.button === MIDDLE_BUTTON) event.preventDefault();
    onFocusRoot();
    if (router.down(event.nativeEvent)) capture(event.currentTarget, event.pointerId);
  };

  const onDoubleClick = (event: MouseEvent<HTMLDivElement>) => {
    const element = ref.current;
    const state = controller.state;
    if (element === null || state.tool !== "select" || state.editing !== null || isTypingTarget(event.target)) return;
    editAt(controller, screenToScene(state.view, localPoint(element, event)));
  };

  return (
    <CanvasContextMenu canvasRef={ref}>
      <div
        ref={ref}
        role="application"
        aria-label="Sketch canvas"
        aria-roledescription="whiteboard"
        className="absolute inset-0 touch-none select-none overflow-hidden overscroll-none bg-background outline-none"
        style={{ cursor }}
        onPointerDown={onPointerDown}
        onPointerMove={(event) => router.move(event.nativeEvent)}
        onPointerUp={(event) => router.up(event.nativeEvent)}
        onPointerCancel={(event) => router.cancel(event.nativeEvent)}
        onPointerLeave={() => router.leave()}
        onDoubleClick={onDoubleClick}
      >
        <SceneLayer />
        <OverlayLayer />
        <TextEditor />
      </div>
    </CanvasContextMenu>
  );
}
