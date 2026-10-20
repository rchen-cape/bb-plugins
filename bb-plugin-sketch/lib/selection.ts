import { elementMap } from "./elements.js";
import type { SketchElement, TextElement } from "./scene.js";

export const CAPTION_LIMIT = 200;

type ById = ReadonlyMap<string, SketchElement>;

export function outermostGroupId(element: SketchElement): string | null {
  return element.groupIds[element.groupIds.length - 1] ?? null;
}

export function labelContainer(element: SketchElement, byId: ById): SketchElement | null {
  if (element.type !== "text" || element.containerId === null) return null;
  const container = byId.get(element.containerId);
  return container === undefined || container.isDeleted ? null : container;
}

export function isAttachedLabel(element: SketchElement, byId: ById): boolean {
  return labelContainer(element, byId) !== null;
}

export function labelOf(container: SketchElement, elements: readonly SketchElement[]): TextElement | null {
  for (const element of elements) {
    if (element.type === "text" && element.containerId === container.id && !element.isDeleted) return element;
  }
  return null;
}

export function labelIndex(elements: readonly SketchElement[]): Map<string, TextElement> {
  const index = new Map<string, TextElement>();
  for (const element of elements) {
    if (element.type !== "text" || element.containerId === null || element.isDeleted) continue;
    if (!index.has(element.containerId)) index.set(element.containerId, element);
  }
  return index;
}

function unitKey(element: SketchElement): string {
  const group = outermostGroupId(element);
  return group === null ? `e:${element.id}` : `g:${group}`;
}

function selectionKeys(elements: readonly SketchElement[], ids: Iterable<string>): Set<string> {
  const byId = elementMap(elements);
  const keys = new Set<string>();
  for (const id of ids) {
    const element = byId.get(id);
    if (element === undefined || element.isDeleted) continue;
    keys.add(unitKey(labelContainer(element, byId) ?? element));
  }
  return keys;
}

export function normalizeSelection(elements: readonly SketchElement[], ids: Iterable<string>): Set<string> {
  const keys = selectionKeys(elements, ids);
  if (keys.size === 0) return new Set();
  const byId = elementMap(elements);
  return new Set(
    elements
      .filter((element) => !element.isDeleted && !isAttachedLabel(element, byId) && keys.has(unitKey(element)))
      .map((element) => element.id),
  );
}

export function withLabels(elements: readonly SketchElement[], ids: ReadonlySet<string>): Set<string> {
  const result = new Set(ids);
  for (const element of elements) {
    if (element.type === "text" && element.containerId !== null && ids.has(element.containerId)) result.add(element.id);
  }
  return result;
}

export function selectedElements(elements: readonly SketchElement[], ids: ReadonlySet<string>): SketchElement[] {
  return elements.filter((element) => ids.has(element.id) && !element.isDeleted);
}

export function exportElements(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>): SketchElement[] {
  const normalized = normalizeSelection(elements, selectedIds);
  if (normalized.size === 0) return elements.filter((element) => !element.isDeleted);
  return selectedElements(elements, withLabels(elements, normalized));
}

export function selectAll(elements: readonly SketchElement[]): Set<string> {
  const byId = elementMap(elements);
  return new Set(
    elements.filter((element) => !element.isDeleted && !isAttachedLabel(element, byId)).map((element) => element.id),
  );
}

export function toggleSelection(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>, id: string): Set<string> {
  const unit = normalizeSelection(elements, [id]);
  const current = normalizeSelection(elements, selectedIds);
  const removing = [...unit].every((unitId) => current.has(unitId));
  if (removing) return new Set([...current].filter((existing) => !unit.has(existing)));
  return new Set([...current, ...unit]);
}

export function selectionUnitCount(elements: readonly SketchElement[], ids: Iterable<string>): number {
  return selectionKeys(elements, ids).size;
}

export function canGroup(elements: readonly SketchElement[], ids: ReadonlySet<string>): boolean {
  return selectionUnitCount(elements, ids) >= 2;
}

export function canUngroup(elements: readonly SketchElement[], ids: ReadonlySet<string>): boolean {
  return [...normalizeSelection(elements, ids)].some((id) => {
    const element = elements.find((candidate) => candidate.id === id);
    return element !== undefined && element.groupIds.length > 0;
  });
}

function truncate(text: string, limit: number): string {
  const chars = [...text];
  return chars.length <= limit ? text : chars.slice(0, limit).join("").trimEnd();
}

export function captionFor(elements: readonly SketchElement[], limit: number = CAPTION_LIMIT): string {
  const parts = elements
    .filter((element): element is TextElement => element.type === "text" && !element.isDeleted)
    .map((element) => element.originalText.replace(/\s+/g, " ").trim())
    .filter((part) => part !== "");
  return truncate(parts.join(" · "), limit);
}
