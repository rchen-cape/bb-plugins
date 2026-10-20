import type { SketchDetail } from "../contract";
import { emptyScene, parseSceneFile } from "../lib/scene.js";
import { DEFAULT_SKETCH_TITLE, LIMITS } from "../lib/sketch.js";
import { errorMessage } from "./bits";
import { unreadableNotice } from "./unreadable";
import type { OpenDoc } from "./workspace-types";

export type PageState =
  | { readonly kind: "loading" }
  | { readonly kind: "open"; readonly doc: OpenDoc }
  | { readonly kind: "broken"; readonly title: string; readonly message: string };

let nextKey = 0;

function docKey(): string {
  nextKey += 1;
  return `doc-${nextKey}`;
}

export function newDoc(): OpenDoc {
  return { key: docKey(), id: null, title: DEFAULT_SKETCH_TITLE, sha256: null, scene: emptyScene() };
}

export function openDetail(detail: SketchDetail): { state: PageState; notice: string | null } {
  try {
    const parsed = parseSceneFile(detail.content);
    const doc = { key: docKey(), id: detail.id, title: detail.title, sha256: detail.sha256, scene: parsed.scene };
    return { state: { kind: "open", doc }, notice: unreadableNotice(detail.title, parsed) };
  } catch (cause) {
    return { state: { kind: "broken", title: detail.title, message: errorMessage(cause) }, notice: null };
  }
}

export function isOpenDoc(page: PageState, key: string): boolean {
  return page.kind === "open" && page.doc.key === key;
}

export function renameDoc(page: PageState, key: string, id: string, title: string): PageState {
  return page.kind === "open" && page.doc.key === key ? { kind: "open", doc: { ...page.doc, id, title } } : page;
}

export async function readSceneFile(file: File): Promise<string> {
  const text = await file.text();
  if (text.length > LIMITS.contentChars) throw new Error("This file is too large to open.");
  parseSceneFile(text);
  return text;
}
