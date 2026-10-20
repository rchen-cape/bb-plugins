import type { ReactNode } from "react";
import { ROUGHNESS_PICKS, type Arrowhead, type EdgeStyle } from "../lib/elements.js";
import type { FillStyle, StrokeStyle, TextAlign } from "../lib/scene.js";
import { FONT_FAMILIES, FONT_SIZES, STROKE_WIDTHS } from "../lib/sketch.js";
import { fontStack } from "../lib/text.js";

export type StyleOption<T> = { readonly value: T; readonly label: string; readonly icon: ReactNode };

function Swatch({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="size-4" aria-hidden="true">
      {children}
    </svg>
  );
}

export const FILL_OPTIONS: readonly StyleOption<FillStyle>[] = [
  {
    value: "hachure",
    label: "Hachure",
    icon: (
      <Swatch>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M4 12 12 4M4 20 20 4M12 20l8-8" strokeWidth={1.5} />
      </Swatch>
    ),
  },
  {
    value: "cross-hatch",
    label: "Cross-hatch",
    icon: (
      <Swatch>
        <rect x="4" y="4" width="16" height="16" rx="2" />
        <path d="M4 12 12 4M4 20 20 4M12 20l8-8M12 4l8 8M4 4l16 16M4 12l8 8" strokeWidth={1.25} />
      </Swatch>
    ),
  },
  {
    value: "solid",
    label: "Solid",
    icon: (
      <Swatch>
        <rect x="4" y="4" width="16" height="16" rx="2" fill="currentColor" />
      </Swatch>
    ),
  },
];

export const STROKE_WIDTH_OPTIONS: readonly StyleOption<number>[] = STROKE_WIDTHS.map((width, index) => ({
  value: width,
  label: ["Thin", "Bold", "Extra bold"][index] ?? `${width}`,
  icon: (
    <Swatch>
      <path d="M4 12h16" strokeWidth={[1.25, 2.5, 4][index] ?? width} />
    </Swatch>
  ),
}));

export const STROKE_STYLE_OPTIONS: readonly StyleOption<StrokeStyle>[] = [
  { value: "solid", label: "Solid", icon: <Swatch><path d="M4 12h16" /></Swatch> },
  { value: "dashed", label: "Dashed", icon: <Swatch><path d="M4 12h16" strokeDasharray="4 3" strokeLinecap="butt" /></Swatch> },
  { value: "dotted", label: "Dotted", icon: <Swatch><path d="M4 12h16" strokeDasharray="0.5 3.5" /></Swatch> },
];

const ROUGHNESS_PATHS = ["M4 16 20 8", "M4 16c3-1 4-4 7-5s5-1 9-3", "M4 16c2 0 2-4 4-4s2 3 4 3 2-5 4-5 2 2 4 1"];
const ROUGHNESS_LABELS = ["Architect", "Artist", "Cartoonist"];

export const ROUGHNESS_OPTIONS: readonly StyleOption<number>[] = ROUGHNESS_PICKS.map((value, index) => ({
  value,
  label: ROUGHNESS_LABELS[index] ?? `${value}`,
  icon: (
    <Swatch>
      <path d={ROUGHNESS_PATHS[index] ?? ""} />
    </Swatch>
  ),
}));

export const EDGE_OPTIONS: readonly StyleOption<EdgeStyle>[] = [
  { value: "sharp", label: "Sharp", icon: <Swatch><path d="M5 19V5h14" /></Swatch> },
  { value: "round", label: "Round", icon: <Swatch><path d="M5 19v-7a7 7 0 0 1 7-7h7" /></Swatch> },
];

function arrowheadGlyph(head: Arrowhead | null): ReactNode {
  switch (head) {
    case null:
      return null;
    case "arrow":
      return <path d="m14 7 6 5-6 5" />;
    case "triangle":
      return <path d="m14 7 6 5-6 5z" fill="currentColor" />;
    case "bar":
      return <path d="M20 6v12" />;
    case "circle":
      return <circle cx="17" cy="12" r="3" fill="currentColor" />;
    case "diamond":
      return <path d="m20 12-3.5-3.5L13 12l3.5 3.5z" fill="currentColor" />;
  }
}

const ARROWHEAD_LABELS: readonly { value: Arrowhead | null; label: string }[] = [
  { value: null, label: "None" },
  { value: "arrow", label: "Arrow" },
  { value: "triangle", label: "Triangle" },
  { value: "bar", label: "Bar" },
  { value: "circle", label: "Circle" },
  { value: "diamond", label: "Diamond" },
];

export function arrowheadOptions(side: "start" | "end"): readonly StyleOption<Arrowhead | null>[] {
  return ARROWHEAD_LABELS.map(({ value, label }) => ({
    value,
    label,
    icon: (
      <Swatch>
        <g transform={side === "start" ? "matrix(-1 0 0 1 24 0)" : undefined}>
          <path d={value === null || value === "bar" ? "M4 12h16" : "M4 12h13"} />
          {arrowheadGlyph(value)}
        </g>
      </Swatch>
    ),
  }));
}

const SIZE_LABELS = ["S", "M", "L", "XL"];
const SIZE_NAMES = ["Small", "Medium", "Large", "Extra large"];

export const FONT_SIZE_OPTIONS: readonly StyleOption<number>[] = FONT_SIZES.map((size, index) => ({
  value: size,
  label: SIZE_NAMES[index] ?? `${size}`,
  icon: <span className="text-xs font-medium leading-none">{SIZE_LABELS[index] ?? size}</span>,
}));

export const FONT_FAMILY_OPTIONS: readonly StyleOption<number>[] = [
  { value: FONT_FAMILIES.hand, label: "Hand-drawn", icon: <span className="text-sm leading-none" style={{ fontFamily: fontStack(FONT_FAMILIES.hand) }}>Aa</span> },
  { value: FONT_FAMILIES.normal, label: "Normal", icon: <span className="text-sm leading-none" style={{ fontFamily: fontStack(FONT_FAMILIES.normal) }}>Aa</span> },
  { value: FONT_FAMILIES.code, label: "Code", icon: <span className="text-xs leading-none" style={{ fontFamily: fontStack(FONT_FAMILIES.code) }}>{"</>"}</span> },
];

export const TEXT_ALIGN_OPTIONS: readonly StyleOption<TextAlign>[] = [
  { value: "left", label: "Left", icon: <Swatch><path d="M15 12H3M17 18H3M21 6H3" /></Swatch> },
  { value: "center", label: "Center", icon: <Swatch><path d="M17 12H7M19 18H5M21 6H3" /></Swatch> },
  { value: "right", label: "Right", icon: <Swatch><path d="M21 12H9M21 18H7M21 6H3" /></Swatch> },
];
