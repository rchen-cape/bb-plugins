export const SKETCH_PANEL = "sketch";
export const SKETCH_ICON = "sketch-pen";
export const CHANGED_CHANNEL = "sketch-changed";
export const WIKI_PLUGIN_ID = "wiki";
export const SKETCH_EXTENSION = ".excalidraw";
export const DEFAULT_SKETCH_TITLE = "Untitled";
export const DEFAULT_SKETCH_DIRECTORY = "~/Sketches";
export const FILE_SOURCE = "bb-plugin-sketch";

export const LIMITS = {
  title: 120,
  contentChars: 10_000_000,
  pngBase64Chars: 40_000_000,
  caption: 2000,
  note: 20_000,
  heading: 200,
  slug: 300,
  query: 200,
  elements: 20_000,
} as const;

export const FONT_FAMILIES = { hand: 5, normal: 2, code: 3 } as const;
export type FontFamilyName = keyof typeof FONT_FAMILIES;

export const STROKE_PICKS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"] as const;
export const BACKGROUND_PICKS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"] as const;
export const STROKE_WIDTHS = [1, 2, 4] as const;
export const FONT_SIZES = [16, 20, 28, 36] as const;

export const DEFAULT_STYLE = {
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  roundness: "round",
  fontFamily: FONT_FAMILIES.hand,
  fontSize: 20,
  textAlign: "left",
  startArrowhead: null,
  endArrowhead: "arrow",
} as const;

export const EXPORT_BACKGROUND = "#ffffff";
export const EXPORT_PADDING = 16;
export const EXPORT_SCALE = 2;
export const LINE_HEIGHT = 1.25;
export const GRID_SIZE = 20;
