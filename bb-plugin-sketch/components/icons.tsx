import type { ReactNode } from "react";
import type { ToolId } from "./tools";

type GlyphProps = { className?: string };

function Glyph({ className, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? "size-4"}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function SketchIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M15.5 3.5a2.12 2.12 0 0 1 3 3L8.5 16.5 4 18l1.5-4.5z" />
      <path d="m13.5 5.5 3 3" />
      <path d="M3 21c1.5-1.33 3-1.33 4.5 0s3 1.33 4.5 0 3-1.33 4.5 0 3 1.33 4.5 0" />
    </Glyph>
  );
}

export function HandIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
      <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
    </Glyph>
  );
}

export function SelectIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.95l-6.13 1.58a2 2 0 0 0-1.43 1.43l-1.58 6.13a.5.5 0 0 1-.95.06z" />
    </Glyph>
  );
}

export function RectangleIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <rect width="18" height="18" x="3" y="3" rx="2" />
    </Glyph>
  );
}

export function DiamondIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M2.7 10.3a2.41 2.41 0 0 0 0 3.41l7.59 7.59a2.41 2.41 0 0 0 3.41 0l7.59-7.59a2.41 2.41 0 0 0 0-3.41L13.7 2.71a2.41 2.41 0 0 0-3.41 0z" />
    </Glyph>
  );
}

export function EllipseIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="9" />
    </Glyph>
  );
}

export function ArrowIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M5 19 19 5" />
      <path d="M9 5h10v10" />
    </Glyph>
  );
}

export function LineIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M5 19 19 5" />
    </Glyph>
  );
}

export function DrawIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M21.17 6.81a1 1 0 0 0-3.98-3.98L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" />
      <path d="m15 5 4 4" />
    </Glyph>
  );
}

export function TextIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M12 4v16" />
      <path d="M4 7V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v2" />
      <path d="M9 20h6" />
    </Glyph>
  );
}

export function EraserIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21" />
      <path d="M22 21H7" />
      <path d="m5 11 9 9" />
    </Glyph>
  );
}

export function LockIcon({ className, open }: GlyphProps & { open: boolean }) {
  return (
    <Glyph className={className}>
      <rect width="18" height="11" x="3" y="11" rx="2" />
      <path d={open ? "M7 11V7a5 5 0 0 1 9.9-1" : "M7 11V7a5 5 0 0 1 10 0v4"} />
    </Glyph>
  );
}

export function SendIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M14.54 21.69a.5.5 0 0 0 .94-.03l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.02.94l7.93 3.18a2 2 0 0 1 1.11 1.11z" />
      <path d="m21.85 2.15-10.94 10.94" />
    </Glyph>
  );
}

export function UndoIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </Glyph>
  );
}

export function RedoIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </Glyph>
  );
}

export function PlusIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M5 12h14" />
      <path d="M12 5v14" />
    </Glyph>
  );
}

export function MinusIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M5 12h14" />
    </Glyph>
  );
}

export function ChevronDownIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="m6 9 6 6 6-6" />
    </Glyph>
  );
}

export function ToFrontIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M5 3h14" />
      <path d="m18 13-6-6-6 6" />
      <path d="M12 7v14" />
    </Glyph>
  );
}

export function ForwardIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </Glyph>
  );
}

export function BackwardIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M12 5v14" />
      <path d="m19 12-7 7-7-7" />
    </Glyph>
  );
}

export function ToBackIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M12 17V3" />
      <path d="m6 11 6 6 6-6" />
      <path d="M19 21H5" />
    </Glyph>
  );
}

export function DuplicateIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <rect width="14" height="14" x="8" y="8" rx="2" />
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
    </Glyph>
  );
}

export function TrashIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2" />
    </Glyph>
  );
}

export function StyleIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M12 22a1 1 0 0 1 0-20 10 9 0 0 1 10 9 5 5 0 0 1-5 5h-2.25a1.75 1.75 0 0 0-1.4 2.8l.3.4a1.75 1.75 0 0 1-1.4 2.8z" />
      <circle cx="13.5" cy="6.5" r="0.5" fill="currentColor" />
      <circle cx="17.5" cy="10.5" r="0.5" fill="currentColor" />
      <circle cx="6.5" cy="12.5" r="0.5" fill="currentColor" />
      <circle cx="8.5" cy="7.5" r="0.5" fill="currentColor" />
    </Glyph>
  );
}

export function ToolIcon({ tool, className }: { tool: ToolId; className?: string }) {
  switch (tool) {
    case "hand":
      return <HandIcon className={className} />;
    case "select":
      return <SelectIcon className={className} />;
    case "rectangle":
      return <RectangleIcon className={className} />;
    case "diamond":
      return <DiamondIcon className={className} />;
    case "ellipse":
      return <EllipseIcon className={className} />;
    case "arrow":
      return <ArrowIcon className={className} />;
    case "line":
      return <LineIcon className={className} />;
    case "draw":
      return <DrawIcon className={className} />;
    case "text":
      return <TextIcon className={className} />;
    case "eraser":
      return <EraserIcon className={className} />;
  }
}

export function CheckIcon({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M20 6 9 17l-5-5" />
    </Glyph>
  );
}
