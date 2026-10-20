import { deleteElements } from "./delete.js";
import { cloneElements, elementMap, updateElement } from "./elements.js";
import { moveElementsBy } from "./gestures.js";
import type { Point } from "./math.js";
import { newElementId, type SketchElement } from "./scene.js";
import {
  isAttachedLabel,
  labelContainer,
  normalizeSelection,
  outermostGroupId,
  selectionUnitCount,
  withLabels,
} from "./selection.js";

export { deleteElements } from "./delete.js";
export { beginTextEdit, commitText, ensureLabel, fitLabel, relayoutLabels } from "./labels.js";
export {
  canGroup,
  canUngroup,
  captionFor,
  exportElements,
  normalizeSelection,
  selectAll,
  selectedElements,
  toggleSelection,
  withLabels,
} from "./selection.js";
export {
  applyStyle,
  normalizeArrowhead,
  selectionStyle,
  selectionStyleFields,
  styleFieldsFor,
  STYLE_FIELDS,
  type StyleField,
  type StylePatch,
  type StyleValue,
  type StyleValues,
} from "./style.js";

export type SceneState = {
  readonly elements: readonly SketchElement[];
  readonly selectedIds: ReadonlySet<string>;
};

export type ZOrderMove = "backward" | "forward" | "back" | "front";

export const DUPLICATE_OFFSET: Point = { x: 10, y: 10 };

export function deleteSelection(state: SceneState): SceneState {
  const ids = withLabels(state.elements, normalizeSelection(state.elements, state.selectedIds));
  if (ids.size === 0) return state;
  return { elements: deleteElements(state.elements, ids), selectedIds: new Set() };
}

function lastIndexOf(elements: readonly SketchElement[], ids: ReadonlySet<string>): number {
  let last = -1;
  elements.forEach((element, index) => {
    if (ids.has(element.id)) last = index;
  });
  return last;
}

export function duplicateSelection(state: SceneState, offset: Point = DUPLICATE_OFFSET): SceneState {
  const normalized = normalizeSelection(state.elements, state.selectedIds);
  if (normalized.size === 0) return state;
  const ids = withLabels(state.elements, normalized);
  const source = state.elements.filter((element) => ids.has(element.id));
  const { elements: copies, idMap } = cloneElements(source);
  const placed = copies.map((element) => ({ ...element, x: element.x + offset.x, y: element.y + offset.y }));
  const last = lastIndexOf(state.elements, ids);
  const elements = [...state.elements.slice(0, last + 1), ...placed, ...state.elements.slice(last + 1)];
  const selectedIds = new Set([...normalized].flatMap((id) => {
    const copy = idMap.get(id);
    return copy === undefined ? [] : [copy];
  }));
  return { elements, selectedIds };
}

type Unit = { readonly key: string; readonly members: readonly SketchElement[] };

function unitKeyOf(element: SketchElement, byId: ReadonlyMap<string, SketchElement>): string {
  const owner = labelContainer(element, byId) ?? element;
  const group = outermostGroupId(owner);
  return group === null ? `e:${owner.id}` : `g:${group}`;
}

function orderedMembers(members: readonly SketchElement[], byId: ReadonlyMap<string, SketchElement>): SketchElement[] {
  const labels = members.filter((element) => isAttachedLabel(element, byId));
  const result: SketchElement[] = [];
  for (const element of members) {
    if (labels.includes(element)) continue;
    result.push(element);
    result.push(...labels.filter((label) => label.type === "text" && label.containerId === element.id));
  }
  return [...result, ...labels.filter((label) => !result.includes(label))];
}

function unitsOf(elements: readonly SketchElement[]): Unit[] {
  const byId = elementMap(elements);
  const groups = new Map<string, SketchElement[]>();
  for (const element of elements) {
    const key = unitKeyOf(element, byId);
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [element]);
    else list.push(element);
  }
  return [...groups].map(([key, members]) => ({ key, members: orderedMembers(members, byId) }));
}

function swapForward(units: Unit[], selected: ReadonlySet<string>): boolean {
  let changed = false;
  for (let i = units.length - 2; i >= 0; i -= 1) {
    const current = units[i];
    const above = units[i + 1];
    if (current === undefined || above === undefined) continue;
    if (selected.has(current.key) && !selected.has(above.key)) {
      units[i] = above;
      units[i + 1] = current;
      changed = true;
    }
  }
  return changed;
}

function swapBackward(units: Unit[], selected: ReadonlySet<string>): boolean {
  let changed = false;
  for (let i = 1; i < units.length; i += 1) {
    const current = units[i];
    const below = units[i - 1];
    if (current === undefined || below === undefined) continue;
    if (selected.has(current.key) && !selected.has(below.key)) {
      units[i] = below;
      units[i - 1] = current;
      changed = true;
    }
  }
  return changed;
}

function sameOrder(a: readonly SketchElement[], b: readonly SketchElement[]): boolean {
  return a.length === b.length && a.every((element, index) => element === b[index]);
}

export function reorderSelection(
  elements: readonly SketchElement[],
  selectedIds: ReadonlySet<string>,
  move: ZOrderMove,
): readonly SketchElement[] {
  const normalized = normalizeSelection(elements, selectedIds);
  if (normalized.size === 0) return elements;
  const byId = elementMap(elements);
  const units = unitsOf(elements);
  const selectedKeys = new Set(
    [...normalized].flatMap((id) => {
      const element = byId.get(id);
      return element === undefined ? [] : [unitKeyOf(element, byId)];
    }),
  );
  const isSelected = (unit: Unit): boolean => selectedKeys.has(unit.key);
  let ordered: Unit[];
  if (move === "front") ordered = [...units.filter((unit) => !isSelected(unit)), ...units.filter(isSelected)];
  else if (move === "back") ordered = [...units.filter(isSelected), ...units.filter((unit) => !isSelected(unit))];
  else {
    ordered = [...units];
    const changed = move === "forward" ? swapForward(ordered, selectedKeys) : swapBackward(ordered, selectedKeys);
    if (!changed) return elements;
  }
  const next = ordered.flatMap((unit) => unit.members);
  return sameOrder(next, elements) ? elements : next;
}

export function groupSelection(state: SceneState): SceneState {
  const normalized = normalizeSelection(state.elements, state.selectedIds);
  if (selectionUnitCount(state.elements, normalized) < 2) return state;
  const members = withLabels(state.elements, normalized);
  const groupId = newElementId();
  const tagged = state.elements.map((element) =>
    members.has(element.id) ? updateElement<SketchElement>(element, { groupIds: [...element.groupIds, groupId] }) : element,
  );
  const last = lastIndexOf(tagged, members);
  const before = tagged.slice(0, last + 1).filter((element) => !members.has(element.id));
  const grouped = tagged.filter((element) => members.has(element.id));
  const after = tagged.slice(last + 1);
  const elements = [...before, ...grouped, ...after];
  return { elements, selectedIds: normalizeSelection(elements, normalized) };
}

export function ungroupSelection(state: SceneState): SceneState {
  const normalized = normalizeSelection(state.elements, state.selectedIds);
  const members = withLabels(state.elements, normalized);
  const groups = new Set(
    state.elements.flatMap((element) => {
      const group = normalized.has(element.id) ? outermostGroupId(element) : null;
      return group === null ? [] : [group];
    }),
  );
  if (groups.size === 0) return state;
  const elements = state.elements.map((element) => {
    const group = outermostGroupId(element);
    if (!members.has(element.id) || group === null || !groups.has(group)) return element;
    return updateElement<SketchElement>(element, { groupIds: element.groupIds.slice(0, -1) });
  });
  return { elements, selectedIds: normalizeSelection(elements, normalized) };
}

export function nudgeSelection(elements: readonly SketchElement[], selectedIds: ReadonlySet<string>, delta: Point): readonly SketchElement[] {
  return moveElementsBy(elements, withLabels(elements, normalizeSelection(elements, selectedIds)), delta);
}

export function eraseElements(elements: readonly SketchElement[], ids: Iterable<string>): readonly SketchElement[] {
  const byId = elementMap(elements);
  const owners = [...ids].flatMap((id) => {
    const element = byId.get(id);
    if (element === undefined) return [];
    return [(labelContainer(element, byId) ?? element).id];
  });
  return deleteElements(elements, owners);
}
