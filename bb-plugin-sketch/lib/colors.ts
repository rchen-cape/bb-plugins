export type Theme = "light" | "dark";

export type Rgba = { readonly r: number; readonly g: number; readonly b: number; readonly a: number | null };

const INVERT_AMOUNT = 0.93;
const HUE_ROTATE_DEGREES = 180;
const CACHE_LIMIT = 1000;

const cache = new Map<string, string>();

function hueRotateMatrix(degrees: number): readonly (readonly [number, number, number])[] {
  const rad = (degrees * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [0.213 + cos * 0.787 - sin * 0.213, 0.715 - cos * 0.715 - sin * 0.715, 0.072 - cos * 0.072 + sin * 0.928],
    [0.213 - cos * 0.213 + sin * 0.143, 0.715 + cos * 0.285 + sin * 0.14, 0.072 - cos * 0.072 - sin * 0.283],
    [0.213 - cos * 0.213 - sin * 0.787, 0.715 - cos * 0.715 + sin * 0.715, 0.072 + cos * 0.928 + sin * 0.072],
  ];
}

const HUE_ROTATE = hueRotateMatrix(HUE_ROTATE_DEGREES);

function unit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function invert(channel: number): number {
  return unit(INVERT_AMOUNT + channel * (1 - 2 * INVERT_AMOUNT));
}

function rotateHue(rgb: readonly [number, number, number]): [number, number, number] {
  const [r, g, b] = rgb;
  const row = (index: number): number => {
    const m = HUE_ROTATE[index];
    return m === undefined ? 0 : unit(m[0] * r + m[1] * g + m[2] * b);
  };
  return [row(0), row(1), row(2)];
}

function hexByte(value: string): number {
  return Number.parseInt(value, 16);
}

function parseHex(value: string): Rgba | null {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value);
  const digits = match?.[1];
  if (digits === undefined) return null;
  const full = digits.length <= 4 ? [...digits].map((d) => d + d).join("") : digits;
  return {
    r: hexByte(full.slice(0, 2)),
    g: hexByte(full.slice(2, 4)),
    b: hexByte(full.slice(4, 6)),
    a: full.length === 8 ? hexByte(full.slice(6, 8)) : null,
  };
}

function parseRgbFunction(value: string): Rgba | null {
  const match = /^rgba?\(\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*[,\s]\s*(\d{1,3})\s*(?:[,/]\s*([\d.]+%?)\s*)?\)$/i.exec(value);
  if (match === null) return null;
  const channels = [match[1], match[2], match[3]].map((part) => Number(part));
  if (channels.some((c) => !Number.isFinite(c) || c > 255)) return null;
  const alphaText = match[4];
  const alpha = alphaText === undefined ? null : alphaText.endsWith("%") ? Number(alphaText.slice(0, -1)) / 100 : Number(alphaText);
  if (alpha !== null && !Number.isFinite(alpha)) return null;
  return {
    r: channels[0] ?? 0,
    g: channels[1] ?? 0,
    b: channels[2] ?? 0,
    a: alpha === null ? null : Math.round(unit(alpha) * 255),
  };
}

export function parseColor(value: string): Rgba | null {
  const trimmed = value.trim();
  return parseHex(trimmed) ?? parseRgbFunction(trimmed);
}

function toHex(byte: number): string {
  return Math.round(byte).toString(16).padStart(2, "0");
}

function formatColor(rgba: Rgba): string {
  const base = `#${toHex(rgba.r)}${toHex(rgba.g)}${toHex(rgba.b)}`;
  return rgba.a === null ? base : `${base}${toHex(rgba.a)}`;
}

export function isTransparent(color: string | null): boolean {
  if (color === null) return true;
  const trimmed = color.trim().toLowerCase();
  if (trimmed === "transparent" || trimmed === "none" || trimmed === "") return true;
  const parsed = parseColor(trimmed);
  return parsed !== null && parsed.a === 0;
}

function computeDarkColor(color: string): string {
  const parsed = parseColor(color);
  if (parsed === null) return color;
  const inverted: [number, number, number] = [invert(parsed.r / 255), invert(parsed.g / 255), invert(parsed.b / 255)];
  const [r, g, b] = rotateHue(inverted);
  return formatColor({ r: r * 255, g: g * 255, b: b * 255, a: parsed.a });
}

export function darkColor(color: string): string {
  if (isTransparent(color)) return color;
  const cached = cache.get(color);
  if (cached !== undefined) return cached;
  const result = computeDarkColor(color);
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(color, result);
  return result;
}

export function paint(color: string | null, theme: Theme): string {
  if (color === null || isTransparent(color)) return "none";
  return theme === "dark" ? darkColor(color) : color;
}
