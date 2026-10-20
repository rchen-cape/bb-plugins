import type { Point } from "../../lib/math.js";
import { screenToScene } from "../../lib/viewport.js";
import type { EditorController } from "../controller";
import { hoverCursor, startGesture } from "./start";
import type { PointerInput, PointerSample } from "./types";
import { beginPinch, pinchView, type Pinch } from "./view";

type RawSample = { readonly clientX: number; readonly clientY: number; readonly pressure: number };
type RawPointer = RawSample & {
  readonly pointerId: number;
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
  readonly pointerType: string;
  readonly samples: readonly RawSample[];
};

type Frame = { cancel: () => void };

function sampleOf(event: { clientX: number; clientY: number; pressure: number }): RawSample {
  return { clientX: event.clientX, clientY: event.clientY, pressure: event.pressure };
}

function coalesced(event: PointerEvent): RawSample[] {
  if (typeof event.getCoalescedEvents !== "function") return [sampleOf(event)];
  const list = event.getCoalescedEvents().map(sampleOf);
  return list.length === 0 ? [sampleOf(event)] : list;
}

export function rawPointer(event: PointerEvent, samples: readonly RawSample[] = [sampleOf(event)]): RawPointer {
  return {
    ...sampleOf(event),
    pointerId: event.pointerId,
    shift: event.shiftKey,
    alt: event.altKey,
    mod: event.metaKey || event.ctrlKey,
    pointerType: event.pointerType === "" ? "mouse" : event.pointerType,
    samples,
  };
}

function scheduleFrame(run: () => void): Frame {
  if (typeof requestAnimationFrame === "function") {
    const id = requestAnimationFrame(run);
    return { cancel: () => cancelAnimationFrame(id) };
  }
  const id = setTimeout(run, 16);
  return { cancel: () => clearTimeout(id) };
}

export class PointerRouter {
  private readonly touches = new Map<number, Point>();
  private pinch: Pinch | null = null;
  private touchLock = false;
  private queued: RawPointer | null = null;
  private hoverQueued: RawPointer | null = null;
  private frame: Frame | null = null;

  constructor(
    private readonly controller: EditorController,
    private readonly origin: () => Point,
  ) {}

  private input(raw: RawPointer): PointerInput {
    const origin = this.origin();
    const view = this.controller.state.view;
    const toSample = (sample: RawSample): PointerSample => {
      const screen = { x: sample.clientX - origin.x, y: sample.clientY - origin.y };
      return { screen, scene: screenToScene(view, screen), pressure: sample.pressure };
    };
    const last = toSample(raw);
    const samples = raw.samples.length === 0 ? [last] : raw.samples.map(toSample);
    return { ...last, shift: raw.shift, alt: raw.alt, mod: raw.mod, pointerType: raw.pointerType, samples };
  }

  private touchPoint(event: PointerEvent): Point {
    const origin = this.origin();
    return { x: event.clientX - origin.x, y: event.clientY - origin.y };
  }

  down(event: PointerEvent): boolean {
    if (event.pointerType === "touch" && this.touchDown(event)) return true;
    if (this.controller.hasGesture() || this.touchLock) return false;
    const raw = rawPointer(event);
    const input = this.input(raw);
    this.controller.pointerScene = input.scene;
    const gesture = startGesture(this.controller, input, event.button);
    if (gesture === null) return false;
    this.controller.beginGesture(event.pointerId, gesture);
    return true;
  }

  private touchDown(event: PointerEvent): boolean {
    this.touches.set(event.pointerId, this.touchPoint(event));
    if (this.touches.size < 2) return false;
    if (this.pinch === null && this.touches.size === 2) {
      this.controller.cancelGesture();
      this.cancelFrame();
      const [a, b] = [...this.touches.values()];
      if (a !== undefined && b !== undefined) this.pinch = beginPinch(this.controller.state.view, a, b);
      this.touchLock = true;
    }
    return true;
  }

  move(event: PointerEvent): void {
    if (event.pointerType === "touch" && this.touches.has(event.pointerId)) {
      this.touches.set(event.pointerId, this.touchPoint(event));
      if (this.pinch !== null) {
        this.movePinch();
        return;
      }
    }
    if (this.controller.gestureFor(event.pointerId) !== null) {
      const samples = [...(this.queued?.samples ?? []), ...coalesced(event)];
      this.queued = rawPointer(event, samples);
      this.schedule();
      return;
    }
    if (!this.controller.hasGesture() && event.buttons === 0) {
      this.hoverQueued = rawPointer(event);
      this.schedule();
    }
  }

  private movePinch(): void {
    const pinch = this.pinch;
    const [a, b] = [...this.touches.values()];
    if (pinch === null || a === undefined || b === undefined) return;
    this.controller.setView(pinchView(pinch, a, b));
  }

  up(event: PointerEvent): void {
    if (event.pointerType === "touch") this.touchUp(event.pointerId);
    if (this.controller.gestureFor(event.pointerId) === null) return;
    this.flush();
    this.controller.endGesture(event.pointerId, this.input(rawPointer(event)));
  }

  cancel(event: PointerEvent): void {
    if (event.pointerType === "touch") this.touchUp(event.pointerId);
    if (this.controller.gestureFor(event.pointerId) === null) return;
    this.queued = null;
    this.controller.cancelGesture();
  }

  private touchUp(pointerId: number): void {
    this.touches.delete(pointerId);
    if (this.touches.size < 2) this.pinch = null;
    if (this.touches.size === 0) this.touchLock = false;
  }

  leave(): void {
    if (this.controller.hasGesture()) return;
    this.hoverQueued = null;
    this.controller.pointerScene = null;
    this.controller.store.set({ hoverCursor: null, eraserPointer: null });
  }

  private schedule(): void {
    if (this.frame !== null) return;
    this.frame = scheduleFrame(() => {
      this.frame = null;
      this.flush();
    });
  }

  private cancelFrame(): void {
    this.frame?.cancel();
    this.frame = null;
    this.queued = null;
    this.hoverQueued = null;
  }

  flush(): void {
    const queued = this.queued;
    const hover = this.hoverQueued;
    this.queued = null;
    this.hoverQueued = null;
    if (queued !== null) {
      const gesture = this.controller.gestureFor(queued.pointerId);
      const input = this.input(queued);
      this.controller.pointerScene = input.scene;
      gesture?.move(input);
    }
    if (hover !== null) this.hover(hover);
  }

  private hover(raw: RawPointer): void {
    const input = this.input(raw);
    const state = this.controller.state;
    this.controller.pointerScene = input.scene;
    this.controller.store.set({
      hoverCursor: hoverCursor(state, input.scene, input.pointerType),
      eraserPointer: state.tool === "eraser" ? input.scene : null,
    });
  }

  dispose(): void {
    this.cancelFrame();
  }
}
