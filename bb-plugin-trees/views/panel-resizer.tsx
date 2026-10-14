import { useCallback, useRef } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";

export const MIN_PANEL_PERCENT = 20;
export const MAX_PANEL_PERCENT = 80;
export const DEFAULT_PANEL_PERCENT = 34;
const PANEL_WIDTH_STORAGE_KEY = "trees:detail-panel-percent";
const PANEL_WIDTH_VARIABLE = "--trees-panel-width";

export function clampPanelPercent(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_PANEL_PERCENT;
  return Math.min(MAX_PANEL_PERCENT, Math.max(MIN_PANEL_PERCENT, value));
}

export function readStoredPanelPercent(): number {
  try {
    const raw = window.localStorage.getItem(PANEL_WIDTH_STORAGE_KEY);
    if (raw === null) return DEFAULT_PANEL_PERCENT;
    return clampPanelPercent(Number.parseFloat(raw));
  } catch {
    return DEFAULT_PANEL_PERCENT;
  }
}

export function storePanelPercent(percent: number): void {
  try {
    window.localStorage.setItem(PANEL_WIDTH_STORAGE_KEY, String(percent));
  } catch {
    return;
  }
}

export function panelWidthStyle(percent: number): CSSProperties {
  return { [PANEL_WIDTH_VARIABLE]: `${percent}%` } as CSSProperties;
}

export interface PanelResizerProps {
  containerRef: { current: HTMLElement | null };
  percent: number;
  onResize: (percent: number) => void;
  onCommit: (percent: number) => void;
}

export function PanelResizer({
  containerRef,
  percent,
  onResize,
  onCommit,
}: PanelResizerProps) {
  const draggingRef = useRef(false);
  const latestRef = useRef(percent);
  latestRef.current = percent;

  const percentFromEvent = useCallback(
    (clientX: number): number | null => {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect === undefined || rect.width === 0) return null;
      return clampPanelPercent(((rect.right - clientX) / rect.width) * 100);
    },
    [containerRef],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      draggingRef.current = true;
      const target = event.currentTarget;
      if (typeof target.setPointerCapture === "function") {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          draggingRef.current = true;
        }
      }
    },
    [],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      const next = percentFromEvent(event.clientX);
      if (next !== null) onResize(next);
    },
    [onResize, percentFromEvent],
  );

  const endDrag = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    onCommit(latestRef.current);
  }, [onCommit]);

  const nudge = useCallback(
    (delta: number) => {
      const next = clampPanelPercent(latestRef.current + delta);
      onResize(next);
      onCommit(next);
    },
    [onCommit, onResize],
  );

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the task panel"
      aria-valuenow={Math.round(percent)}
      aria-valuemin={MIN_PANEL_PERCENT}
      aria-valuemax={MAX_PANEL_PERCENT}
      tabIndex={0}
      className="hidden w-1 shrink-0 cursor-col-resize bg-transparent transition-colors hover:bg-ring/40 focus-visible:bg-ring/40 focus-visible:outline-none md:block"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          nudge(2);
          return;
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          nudge(-2);
        }
      }}
    />
  );
}
