export const WIKI_PANEL = "wiki";
export const CHANGED_CHANNEL = "wiki-changed";
export const INBOX_CHANNEL = "wiki-inbox";
export const MARK_START = "\u0002";
export const MARK_END = "\u0003";

export const DOC_TYPES = ["topic", "project", "process", "service"] as const;
export type DocType = (typeof DOC_TYPES)[number];
export const DEFAULT_DOC_TYPE: DocType = "topic";

export const DOC_TYPE_LABELS: Record<DocType, { one: string; many: string }> = {
  project: { one: "Project", many: "Projects" },
  topic: { one: "Topic", many: "Topics" },
  process: { one: "Process", many: "Processes" },
  service: { one: "Service", many: "Services" },
};

export const DEFAULT_HEADING = "Unsorted";
export const NEW_DOC_HEADING = "Notes";
export const RELATED_HEADING = "Related";

export const WIKI_META_DIR = ".wiki";
export const TAGS_FILE = ".wiki/tags.json";
export const ASSETS_DIR = "assets";

export const LIMITS = {
  title: 200,
  alias: 80,
  aliases: 20,
  heading: 200,
  slug: 300,
  path: 4096,
  query: 500,
  results: 200,
  docHits: 8,
  suggestions: 5,
  tagSuggestions: 3,
  text: 500_000,
  content: 5_000_000,
  caption: 2_000,
  reason: 500,
  lines: 5_000,
  tags: 50,
  destinations: 20,
  media: 20,
  unitsPerJob: 60,
  catalogDocs: 300,
  excerpt: 160,
  uploadBytes: 1024 ** 3,
  uploadWarnBytes: 200 * 1024 ** 2,
} as const;

export const ROUTING_TIMEOUT_MS = 15 * 60_000;

export const MEDIA_KINDS = ["image", "video", "markdown", "text"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

const MEDIA_TYPES: Record<string, { kind: MediaKind; contentType: string }> = {
  ".png": { kind: "image", contentType: "image/png" },
  ".jpg": { kind: "image", contentType: "image/jpeg" },
  ".jpeg": { kind: "image", contentType: "image/jpeg" },
  ".gif": { kind: "image", contentType: "image/gif" },
  ".webp": { kind: "image", contentType: "image/webp" },
  ".mp4": { kind: "video", contentType: "video/mp4" },
  ".mov": { kind: "video", contentType: "video/quicktime" },
  ".webm": { kind: "video", contentType: "video/webm" },
  ".md": { kind: "markdown", contentType: "text/markdown; charset=utf-8" },
  ".txt": { kind: "text", contentType: "text/plain; charset=utf-8" },
};

export const MEDIA_EXTENSIONS: readonly string[] = Object.keys(MEDIA_TYPES);

function extensionOf(name: string): string {
  const match = /\.[A-Za-z0-9]+$/.exec(name);
  return match === null ? "" : match[0].toLowerCase();
}

export function mediaKindOf(name: string): MediaKind | null {
  return MEDIA_TYPES[extensionOf(name)]?.kind ?? null;
}

export function contentTypeOf(name: string): string | null {
  return MEDIA_TYPES[extensionOf(name)]?.contentType ?? null;
}

export function isDocType(value: unknown): value is DocType {
  return typeof value === "string" && (DOC_TYPES as readonly string[]).includes(value);
}

export function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;
}
