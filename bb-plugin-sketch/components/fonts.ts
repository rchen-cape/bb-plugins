import { EXCALIFONT_FACES, EXCALIFONT_FAMILY } from "../lib/excalifont.js";
import { FONT_FAMILIES } from "../lib/sketch.js";
import { fontString } from "../lib/text.js";

let loading: Promise<void> | null = null;

function canRegister(): boolean {
  return typeof FontFace === "function" && typeof document !== "undefined" && document.fonts !== undefined;
}

async function register(): Promise<void> {
  if (!canRegister()) return;
  for (const face of EXCALIFONT_FACES) {
    const font = new FontFace(EXCALIFONT_FAMILY, `url(data:font/woff2;base64,${face.woff2Base64}) format("woff2")`, {
      unicodeRange: face.unicodeRange,
      display: "block",
    });
    document.fonts.add(font);
  }
  await document.fonts.load(fontString(20, FONT_FAMILIES.hand));
}

export function loadSketchFonts(): Promise<void> {
  loading ??= register().catch(() => undefined);
  return loading;
}
