import { removeReferences } from "./binding.js";
import type { SketchElement } from "./scene.js";

function withAttachedLabels(elements: readonly SketchElement[], ids: ReadonlySet<string>): Set<string> {
  const doomed = new Set(ids);
  for (const element of elements) {
    if (element.type === "text" && element.containerId !== null && ids.has(element.containerId)) doomed.add(element.id);
    if (element.type !== "unsupported" && ids.has(element.id)) {
      for (const entry of element.boundElements ?? []) if (entry.type === "text") doomed.add(entry.id);
    }
  }
  return doomed;
}

export function deleteElements(elements: readonly SketchElement[], ids: Iterable<string>): readonly SketchElement[] {
  const doomed = withAttachedLabels(elements, new Set(ids));
  if (!elements.some((element) => doomed.has(element.id))) return elements;
  const remaining = elements.filter((element) => !doomed.has(element.id));
  return removeReferences(remaining, doomed);
}
