/*
 * Images a note carries. They live beside the notes, in one folder per tree,
 * and the note refers to them the ordinary Markdown way — so the file stays a
 * file, readable and editable in any editor, and a task that hands its whole
 * document down has something a model can actually be shown.
 *
 * Kept free of node imports: the panel parses the same references to draw
 * what a note holds.
 */

export const ASSETS_DIRECTORY = "assets";

/** Ten megabytes, which is a generous screenshot and a poor video. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/*
 * Raster formats only. SVG is a document that can carry script, and these
 * files are rendered in the app and handed to agents, so it stays out.
 */
export const IMAGE_MIME_TYPES: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
};

export const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES);

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 ? "" : fileName.slice(dot).toLowerCase();
}

export function imageMimeType(fileName: string): string | null {
  return IMAGE_MIME_TYPES[extensionOf(fileName)] ?? null;
}

/*
 * Named by content, so dropping the same screenshot twice stores it once and
 * the name cannot collide with another note's image or be guessed from the
 * original file name.
 */
export function assetFileName(args: {
  fileName: string;
  contentDigest: string;
}): string {
  return `${args.contentDigest.slice(0, 16)}${extensionOf(args.fileName)}`;
}

export function assetReference(assetFile: string): string {
  return `${ASSETS_DIRECTORY}/${assetFile}`;
}

/*
 * Alt text carries the name the file was dropped under: the stored name is a
 * digest, and a model reading the document deserves the human one.
 */
export function imageMarkdown(args: {
  originalName: string;
  assetFile: string;
}): string {
  const alt = args.originalName.replace(/[[\]\r\n]/gu, " ").trim();
  return `![${alt.length > 0 ? alt : "image"}](${assetReference(args.assetFile)})`;
}

const REFERENCE_PATTERN = new RegExp(
  `!\\[([^\\]]*)\\]\\(\\s*(?:\\./)?${ASSETS_DIRECTORY}/([^)\\s]+)`,
  "gu",
);

export interface ReferencedImage {
  assetFile: string;
  /** The document's own alt text, which is what to call the image. */
  alt: string;
}

/** Every asset the document points at, once each, in the order they appear. */
export function referencedImages(markdown: string): ReferencedImage[] {
  const found: ReferencedImage[] = [];
  for (const match of markdown.matchAll(REFERENCE_PATTERN)) {
    const file = match[2];
    if (file === undefined) continue;
    const decoded = decodeURIComponent(file);
    if (imageMimeType(decoded) === null) continue;
    if (decoded.includes("/") || decoded.includes("\\")) continue;
    if (found.some((image) => image.assetFile === decoded)) continue;
    const alt = (match[1] ?? "").trim();
    found.push({ assetFile: decoded, alt: alt.length > 0 ? alt : decoded });
  }
  return found;
}

/*
 * A relative reference is right in the file and wrong in a browser, which
 * would resolve it against the app's own origin. Rendering swaps in the
 * leased URL that actually serves the tree's folder.
 */
export function withResolvedAssetUrls(
  markdown: string,
  baseUrl: string,
): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return markdown.replace(
    new RegExp(
      `(!\\[[^\\]]*\\]\\(\\s*)(?:\\./)?${ASSETS_DIRECTORY}/([^)\\s]+)`,
      "gu",
    ),
    (whole, prefix: string, file: string) => {
      const decoded = decodeURIComponent(file);
      if (imageMimeType(decoded) === null) return whole;
      if (decoded.includes("/") || decoded.includes("\\")) return whole;
      return `${prefix}${base}/${encodeURIComponent(decoded)}`;
    },
  );
}
