import { absolutePoints, elementCenter, rectangleRadius } from "./bounds.js";
import { elementMap, updateElement, withAbsolutePoints } from "./elements.js";
import { signedDistance } from "./hit.js";
import { addPoints, clamp, rotateVector, scalePoint, subtractPoints, type Point } from "./math.js";
import {
  isLinear,
  isShape,
  type Binding,
  type BoundElement,
  type LinearElement,
  type ShapeElement,
  type SketchElement,
  type TextElement,
} from "./scene.js";

export const BINDING_GAP = 4;
export const BINDING_DISTANCE = 16;
const MAX_GAP = 64;

export type LinearEnd = "start" | "end";
export const LINEAR_ENDS: readonly LinearEnd[] = ["start", "end"];
export type BindTarget = ShapeElement | TextElement;
export type ElementLookup = (id: string) => SketchElement | undefined;

export function isBindTarget(element: SketchElement | undefined): element is BindTarget {
  if (element === undefined || element.isDeleted) return false;
  return isShape(element) || (element.type === "text" && element.containerId === null);
}

export function canBind(element: SketchElement | undefined): element is LinearElement {
  return element !== undefined && isLinear(element) && element.elbowed !== true;
}

export function bindingOf(element: LinearElement, end: LinearEnd): Binding | null {
  return end === "start" ? element.startBinding : element.endBinding;
}

export function boundTargetIds(element: LinearElement): string[] {
  return [element.startBinding?.elementId, element.endBinding?.elementId].filter((id): id is string => id !== undefined);
}

export function findBindTarget(
  elements: readonly SketchElement[],
  p: Point,
  zoom: number,
  exclude: ReadonlySet<string> = new Set(),
): BindTarget | null {
  const threshold = BINDING_DISTANCE / zoom;
  let best: { element: BindTarget; area: number } | null = null;
  for (const element of elements) {
    if (!isBindTarget(element) || exclude.has(element.id)) continue;
    if (signedDistance(element, p) > threshold) continue;
    const area = Math.abs(element.width * element.height);
    if (best === null || area <= best.area) best = { element, area };
  }
  return best?.element ?? null;
}

function safeRatio(numerator: number, denominator: number): number {
  if (denominator === 0) return numerator === 0 ? 0 : Infinity;
  return numerator / denominator;
}

function roundedCornerDistance(u: Point, t: number, hw: number, hh: number, radius: number): number {
  const r = Math.min(radius, hw, hh);
  if (r <= 0) return t;
  const hit = scalePoint(u, t);
  if (Math.abs(hit.x) <= hw - r || Math.abs(hit.y) <= hh - r) return t;
  const cx = Math.sign(u.x) * (hw - r);
  const cy = Math.sign(u.y) * (hh - r);
  const b = u.x * cx + u.y * cy;
  const disc = b * b - (cx * cx + cy * cy - r * r);
  return disc < 0 ? t : b + Math.sqrt(disc);
}

function boundaryDistance(target: BindTarget, u: Point): number {
  const hw = Math.abs(target.width) / 2;
  const hh = Math.abs(target.height) / 2;
  if (target.type === "ellipse") {
    const k = Math.hypot(safeRatio(u.x, hw), safeRatio(u.y, hh));
    return k === 0 || !Number.isFinite(k) ? 0 : 1 / k;
  }
  if (target.type === "diamond") {
    const k = safeRatio(Math.abs(u.x), hw) + safeRatio(Math.abs(u.y), hh);
    return k === 0 || !Number.isFinite(k) ? 0 : 1 / k;
  }
  const t = Math.min(safeRatio(hw, Math.abs(u.x)), safeRatio(hh, Math.abs(u.y)));
  const finite = Number.isFinite(t) ? t : 0;
  if (target.type !== "rectangle") return finite;
  return roundedCornerDistance(u, finite, hw, hh, rectangleRadius(target));
}

export function outlinePoint(target: BindTarget, toward: Point, gap: number = BINDING_GAP, fallback?: Point): Point {
  const center = elementCenter(target);
  let v = rotateVector(subtractPoints(toward, center), -target.angle);
  if (Math.hypot(v.x, v.y) < 1e-6 && fallback !== undefined) {
    v = rotateVector(subtractPoints(fallback, center), -target.angle);
  }
  const length = Math.hypot(v.x, v.y);
  const u = length < 1e-6 ? { x: 1, y: 0 } : scalePoint(v, 1 / length);
  const local = scalePoint(u, boundaryDistance(target, u) + gap);
  return addPoints(center, rotateVector(local, target.angle));
}

function gapOf(binding: Binding): number {
  return Number.isFinite(binding.gap) ? clamp(binding.gap, 0, MAX_GAP) : BINDING_GAP;
}

function targetOf(binding: Binding | null, lookup: ElementLookup): BindTarget | null {
  if (binding === null) return null;
  const target = lookup(binding.elementId);
  return isBindTarget(target) ? target : null;
}

export function recomputeLinear(element: LinearElement, lookup: ElementLookup): LinearElement {
  if (element.elbowed === true) return element;
  const start = targetOf(element.startBinding, lookup);
  const end = targetOf(element.endBinding, lookup);
  if (start === null && end === null) return element;
  const abs = absolutePoints(element);
  const n = abs.length;
  const first = abs[0];
  const last = abs[n - 1];
  const afterFirst = abs[1];
  const beforeLast = abs[n - 2];
  if (first === undefined || last === undefined || afterFirst === undefined || beforeLast === undefined) return element;
  const next = [...abs];
  if (start !== null && element.startBinding !== null) {
    const ref = n === 2 && end !== null ? elementCenter(end) : afterFirst;
    next[0] = outlinePoint(start, ref, gapOf(element.startBinding), first);
  }
  if (end !== null && element.endBinding !== null) {
    const ref = n === 2 && start !== null ? elementCenter(start) : beforeLast;
    next[n - 1] = outlinePoint(end, ref, gapOf(element.endBinding), last);
  }
  return withAbsolutePoints(element, next);
}

export function addBoundElement(target: SketchElement, entry: BoundElement): SketchElement {
  if (target.type === "unsupported") return target;
  const list = target.boundElements ?? [];
  if (list.some((existing) => existing.id === entry.id)) return target;
  return updateElement<SketchElement>(target, { boundElements: [...list, entry] });
}

export function removeBoundElement(target: SketchElement, id: string): SketchElement {
  if (target.type === "unsupported" || target.boundElements === null) return target;
  const list = target.boundElements.filter((entry) => entry.id !== id);
  if (list.length === target.boundElements.length) return target;
  return updateElement<SketchElement>(target, { boundElements: list.length === 0 ? null : list });
}

type Overlay = {
  readonly base: ReadonlyMap<string, SketchElement>;
  readonly changes: Map<string, SketchElement>;
};

function overlayOf(elements: readonly SketchElement[]): Overlay {
  return { base: elementMap(elements), changes: new Map() };
}

function read(overlay: Overlay, id: string): SketchElement | undefined {
  return overlay.changes.get(id) ?? overlay.base.get(id);
}

function write(overlay: Overlay, element: SketchElement): void {
  if (read(overlay, element.id) !== element) overlay.changes.set(element.id, element);
}

function lookupOf(overlay: Overlay): ElementLookup {
  return (id) => read(overlay, id);
}

export function applyOverlay(elements: readonly SketchElement[], changes: ReadonlyMap<string, SketchElement>): readonly SketchElement[] {
  if (changes.size === 0) return elements;
  return elements.map((element) => changes.get(element.id) ?? element);
}

function withBinding(element: LinearElement, end: LinearEnd, binding: Binding | null): LinearElement {
  if (bindingOf(element, end) === binding) return element;
  return updateElement(element, end === "start" ? { startBinding: binding } : { endBinding: binding });
}

function otherEnd(end: LinearEnd): LinearEnd {
  return end === "start" ? "end" : "start";
}

function detachEnd(overlay: Overlay, element: LinearElement, end: LinearEnd): LinearElement {
  const binding = bindingOf(element, end);
  if (binding === null) return element;
  const next = withBinding(element, end, null);
  const target = read(overlay, binding.elementId);
  const stillBound = bindingOf(next, otherEnd(end))?.elementId === binding.elementId;
  if (target !== undefined && !stillBound) write(overlay, removeBoundElement(target, element.id));
  return next;
}

function attachEnd(overlay: Overlay, element: LinearElement, end: LinearEnd, target: BindTarget): LinearElement {
  const next = withBinding(element, end, { elementId: target.id, focus: 0, gap: BINDING_GAP });
  write(overlay, addBoundElement(target, { id: element.id, type: "arrow" }));
  return next;
}

export function bindEnd(
  elements: readonly SketchElement[],
  linearId: string,
  end: LinearEnd,
  targetId: string | null,
): readonly SketchElement[] {
  const overlay = overlayOf(elements);
  const element = read(overlay, linearId);
  if (!canBind(element)) return elements;
  const target = targetId === null ? undefined : read(overlay, targetId);
  const current = bindingOf(element, end)?.elementId ?? null;
  let next = element;
  if (current !== (isBindTarget(target) ? target.id : null)) {
    next = detachEnd(overlay, next, end);
    if (isBindTarget(target)) next = attachEnd(overlay, next, end, target);
  }
  write(overlay, next);
  write(overlay, recomputeLinear(next, lookupOf(overlay)));
  return applyOverlay(elements, overlay.changes);
}

export function updateBoundArrows(elements: readonly SketchElement[], changedIds: ReadonlySet<string>): readonly SketchElement[] {
  if (changedIds.size === 0) return elements;
  const overlay = overlayOf(elements);
  for (const element of elements) {
    if (!canBind(element) || changedIds.has(element.id)) continue;
    if (!boundTargetIds(element).some((id) => changedIds.has(id))) continue;
    write(overlay, recomputeLinear(element, lookupOf(overlay)));
  }
  return applyOverlay(elements, overlay.changes);
}

export type TransformKind = "move" | "resize";

function syncTransformedLinear(overlay: Overlay, element: LinearElement, transformed: ReadonlySet<string>, kind: TransformKind): void {
  let next = element;
  for (const end of LINEAR_ENDS) {
    const binding = bindingOf(next, end);
    if (binding !== null && !transformed.has(binding.elementId)) next = detachEnd(overlay, next, end);
  }
  if (kind === "resize") next = recomputeLinear(next, lookupOf(overlay));
  write(overlay, next);
}

export function syncBindings(
  elements: readonly SketchElement[],
  transformedIds: ReadonlySet<string>,
  kind: TransformKind,
): readonly SketchElement[] {
  if (transformedIds.size === 0) return elements;
  const overlay = overlayOf(elements);
  for (const element of elements) {
    if (!canBind(element)) continue;
    const latest = read(overlay, element.id);
    if (!canBind(latest)) continue;
    if (transformedIds.has(latest.id)) {
      if (latest.startBinding !== null || latest.endBinding !== null) {
        syncTransformedLinear(overlay, latest, transformedIds, kind);
      }
      continue;
    }
    if (boundTargetIds(latest).some((id) => transformedIds.has(id))) {
      write(overlay, recomputeLinear(latest, lookupOf(overlay)));
    }
  }
  return applyOverlay(elements, overlay.changes);
}

type IsGone = (id: string) => boolean;

function prunedBinding(binding: Binding | null, gone: IsGone): Binding | null {
  return binding !== null && gone(binding.elementId) ? null : binding;
}

function pruneElement(element: SketchElement, gone: IsGone): SketchElement {
  if (element.type === "unsupported") return element;
  let next: SketchElement = element;
  if (element.boundElements !== null && element.boundElements.some((entry) => gone(entry.id))) {
    const kept = element.boundElements.filter((entry) => !gone(entry.id));
    next = updateElement<SketchElement>(next, { boundElements: kept.length === 0 ? null : kept });
  }
  if (next.type === "arrow" || next.type === "line") {
    const startBinding = prunedBinding(next.startBinding, gone);
    const endBinding = prunedBinding(next.endBinding, gone);
    if (startBinding !== next.startBinding || endBinding !== next.endBinding) {
      next = updateElement(next, { startBinding, endBinding });
    }
  }
  if (next.type === "text" && next.containerId !== null && gone(next.containerId)) {
    next = updateElement(next, { containerId: null });
  }
  return next;
}

function pruneWith(elements: readonly SketchElement[], gone: IsGone): readonly SketchElement[] {
  let changed = false;
  const next = elements.map((element) => {
    const pruned = pruneElement(element, gone);
    if (pruned !== element) changed = true;
    return pruned;
  });
  return changed ? next : elements;
}

export function removeReferences(elements: readonly SketchElement[], removedIds: ReadonlySet<string>): readonly SketchElement[] {
  if (removedIds.size === 0) return elements;
  return pruneWith(elements, (id) => removedIds.has(id));
}

export function pruneDanglingReferences(elements: readonly SketchElement[]): readonly SketchElement[] {
  const ids = new Set(elements.filter((element) => !element.isDeleted).map((element) => element.id));
  return pruneWith(elements, (id) => !ids.has(id));
}
