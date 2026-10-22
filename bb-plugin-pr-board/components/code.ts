import { useEffect, useMemo, useRef, type RefObject } from "react";
import { DIFFS_TAG_NAME } from "@pierre/diffs";
import type { Side } from "../contract";
import type { DiffStyle } from "../highlight";

const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

export interface Identifier {
  text: string;
  offset: number;
}

function textNodeOf(element: HTMLElement): Text | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  return walker.nextNode() as Text | null;
}

export function identifierAt(tokenElement: HTMLElement, tokenText: string, clientX: number): Identifier | null {
  const candidates = [...tokenText.matchAll(IDENTIFIER)].map((match) => ({ text: match[0], offset: match.index }));
  if (candidates.length <= 1) return candidates[0] ?? null;
  const node = textNodeOf(tokenElement);
  if (node === null) return candidates[0] ?? null;
  const range = document.createRange();
  for (const candidate of candidates) {
    range.setStart(node, candidate.offset);
    range.setEnd(node, candidate.offset + candidate.text.length);
    const box = range.getBoundingClientRect();
    if (clientX >= box.left && clientX <= box.right) return candidate;
  }
  return null;
}

export function isModifierClick(event: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return navigator.platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey;
}

function lineSelector(side: Side | null, line: number, diffStyle: DiffStyle | null): string {
  if (side === null) return `[data-line="${line}"]`;
  if (diffStyle === "split") return `[data-${side}] [data-line="${line}"]`;
  const type = side === "deletions" ? '[data-line-type="change-deletion"]' : ':not([data-line-type="change-deletion"])';
  return `[data-line="${line}"]${type}`;
}

export function findLine(host: HTMLElement | null, side: Side | null, line: number, diffStyle: DiffStyle | null): HTMLElement | null {
  const root = host?.querySelector(DIFFS_TAG_NAME)?.shadowRoot;
  return root?.querySelector<HTMLElement>(lineSelector(side, line, diffStyle)) ?? null;
}

export interface LineFocus {
  side: Side | null;
  line: number;
  seq: number;
  /** `data-anchor` of the card to land on (a finding or comment) instead of the line itself. */
  anchor?: string | null;
}

const SETTLE_MS = 1500;
const ANCHOR_WAIT_FRAMES = 10;
const SCROLL_MARGIN = 12;
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

function findAnchor(host: HTMLElement | null, anchor: string): HTMLElement | null {
  return host?.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(anchor)}"]`) ?? null;
}

// Walks out through shadow roots and slots, since diff lines and cards sit inside the diff's shadow DOM.
function verticalScroller(element: HTMLElement): HTMLElement | null {
  let node: Node | null = element.assignedSlot ?? element.parentNode;
  while (node !== null) {
    if (node instanceof ShadowRoot) node = node.host;
    if (node instanceof HTMLElement && /auto|scroll/.test(getComputedStyle(node).overflowY) && node.scrollHeight > node.clientHeight) return node;
    node = node instanceof Element && node.assignedSlot !== null ? node.assignedSlot : node.parentNode;
  }
  return null;
}

/**
 * Scrolls `element` into view and keeps it there while content loading around it
 * (highlighting, Markdown, cards above it) shifts the layout, until the user scrolls or clicks.
 * Scrolls only vertically, so the code's horizontal scroll stays where it was.
 */
export function pinIntoView(element: HTMLElement, position?: "start" | "center"): () => void {
  const until = performance.now() + SETTLE_MS;
  let top: number | null = null;
  let frame = 0;
  const stop = () => {
    cancelAnimationFrame(frame);
    for (const type of USER_SCROLL_EVENTS) window.removeEventListener(type, stop, true);
  };
  const scroll = () => {
    const scroller = verticalScroller(element);
    if (scroller === null) return;
    const box = element.getBoundingClientRect();
    const view = scroller.getBoundingClientRect();
    const block = position ?? (box.height > view.height * 0.6 ? "start" : "center");
    const target = block === "start" ? view.top + SCROLL_MARGIN : view.top + (view.height - box.height) / 2;
    scroller.scrollTop += box.top - target;
  };
  const tick = () => {
    if (!element.isConnected || performance.now() > until) return stop();
    if (top === null || Math.abs(element.getBoundingClientRect().top - top) > 1) {
      scroll();
      top = element.getBoundingClientRect().top;
    }
    frame = requestAnimationFrame(tick);
  };
  for (const type of USER_SCROLL_EVENTS) window.addEventListener(type, stop, { capture: true, passive: true });
  tick();
  return stop;
}

export function useScrollToLine(
  host: RefObject<HTMLElement | null>,
  focus: LineFocus | null,
  layout: string,
  diffStyle: DiffStyle | null,
  onMissing: () => void,
): void {
  const missing = useRef(onMissing);
  missing.current = onMissing;
  useEffect(() => {
    if (focus === null) return;
    let frame = 0;
    let attempts = 0;
    let lineFound = 0;
    let unpin = () => {};
    const tick = () => {
      const line = findLine(host.current, focus.side, focus.line, diffStyle);
      if (line !== null) {
        // The card renders after its last line, sometimes a frame later; land on it when it shows up.
        const anchor = focus.anchor == null ? null : findAnchor(host.current, focus.anchor);
        if (anchor !== null || focus.anchor == null || ++lineFound >= ANCHOR_WAIT_FRAMES) {
          unpin = pinIntoView(anchor ?? line);
          return;
        }
      } else if (++attempts >= 90) {
        missing.current();
        return;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      unpin();
    };
  }, [focus, layout, diffStyle, host]);
}

function underline(element: HTMLElement, on: boolean): void {
  element.style.textDecoration = on ? "underline" : "";
  element.style.cursor = on ? "pointer" : "";
}

export function useModifierUnderline(): {
  enter(element: HTMLElement, modifier: boolean): void;
  leave(element: HTMLElement): void;
} {
  const hovered = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const sync = (event: KeyboardEvent) => {
      if (hovered.current !== null) underline(hovered.current, isModifierClick(event));
    };
    window.addEventListener("keydown", sync);
    window.addEventListener("keyup", sync);
    return () => {
      window.removeEventListener("keydown", sync);
      window.removeEventListener("keyup", sync);
    };
  }, []);
  return useMemo(
    () => ({
      enter(element: HTMLElement, modifier: boolean) {
        hovered.current = element;
        underline(element, modifier);
      },
      leave(element: HTMLElement) {
        underline(element, false);
        if (hovered.current === element) hovered.current = null;
      },
    }),
    [],
  );
}
