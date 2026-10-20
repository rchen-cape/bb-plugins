import type { SketchElement } from "../lib/scene.js";
import { EXPORT_BACKGROUND, EXPORT_PADDING, EXPORT_SCALE } from "../lib/sketch.js";
import { sceneToSvg, type SvgExport } from "../lib/svg-export.js";

export const MAX_CANVAS_PIXELS = 16_777_216;

export type PngImage = { readonly blob: Blob; readonly width: number; readonly height: number };

export function exportSvg(elements: readonly SketchElement[]): SvgExport {
  return sceneToSvg(elements, { padding: EXPORT_PADDING, background: EXPORT_BACKGROUND, embedFont: true });
}

export function pngScale(width: number, height: number, scale: number = EXPORT_SCALE): number {
  const area = Math.max(1, width * height);
  return Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / area));
}

export function pixelSize(width: number, height: number, scale: number): { width: number; height: number } {
  const factor = pngScale(width, height, scale);
  return { width: Math.max(1, Math.floor(width * factor)), height: Math.max(1, Math.floor(height * factor)) };
}

export function withPixelSize(svg: string, from: { width: number; height: number }, to: { width: number; height: number }): string {
  return svg.replace(`width="${from.width}" height="${from.height}"`, `width="${to.width}" height="${to.height}"`);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 16);
  });
}

async function loadImage(svg: string): Promise<{ image: HTMLImageElement; release: () => void }> {
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  const image = new Image();
  image.decoding = "async";
  const loaded = new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("The sketch image couldn't be drawn."));
  });
  image.src = url;
  try {
    if (typeof image.decode === "function") await image.decode();
    else await loaded;
  } catch (cause) {
    URL.revokeObjectURL(url);
    throw cause instanceof Error ? cause : new Error("The sketch image couldn't be drawn.");
  }
  return { image, release: () => URL.revokeObjectURL(url) };
}

function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob === null ? reject(new Error("The browser couldn't make a PNG.")) : resolve(blob)), "image/png");
  });
}

export async function renderPng(elements: readonly SketchElement[], scale: number = EXPORT_SCALE): Promise<PngImage> {
  const svg = exportSvg(elements);
  const size = pixelSize(svg.width, svg.height, scale);
  const { image, release } = await loadImage(withPixelSize(svg.svg, svg, size));
  try {
    await nextFrame();
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (context === null) throw new Error("This browser can't draw images.");
    context.drawImage(image, 0, 0, size.width, size.height);
    return { blob: await canvasBlob(canvas), width: size.width, height: size.height };
  } finally {
    release();
  }
}

export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

export function objectUrl(blob: Blob): string | null {
  if (typeof URL.createObjectURL !== "function") return null;
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

export function revokeUrl(url: string | null): void {
  if (url === null || typeof URL.revokeObjectURL !== "function") return;
  try {
    URL.revokeObjectURL(url);
  } catch {
    return;
  }
}

const UNSAFE_NAME = /[/\\:*?"<>|\u0000-\u001f\u007f]+/g;

export function downloadName(title: string, extension: string): string {
  const base = title.replace(UNSAFE_NAME, " ").trim().replace(/^\.+/, "");
  return `${base === "" ? "sketch" : base}.${extension}`;
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = objectUrl(blob);
  if (url === null) throw new Error("This browser can't save files.");
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => revokeUrl(url), 60_000);
}

export async function copyPngToClipboard(png: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === "undefined" || typeof navigator.clipboard?.write !== "function") {
    throw new Error("This browser can't copy images. Use Export › PNG instead.");
  }
  await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
}
