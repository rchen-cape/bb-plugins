import type { Destination, DocSummary, DocTarget, LineRange, LineSelection, RememberAlias, TagSuggestion } from "../contract";
import { DEFAULT_HEADING, NEW_DOC_HEADING, RELATED_HEADING } from "../lib/wiki";
import { normalizeTag, slugify } from "../lib/slug";

export function selectionToSet(selection: LineSelection, lineCount: number): Set<number> {
  const lines = new Set<number>();
  if (selection === "all") {
    for (let index = 0; index < lineCount; index += 1) lines.add(index);
    return lines;
  }
  for (const range of selection) {
    for (let index = range.start; index <= Math.min(range.end, lineCount - 1); index += 1) lines.add(index);
  }
  return lines;
}

export function setToSelection(lines: ReadonlySet<number>, lineCount: number): LineSelection | null {
  const sorted = [...lines].filter((index) => index >= 0 && index < lineCount).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === lineCount) return "all";
  const ranges: LineRange[] = [];
  for (const index of sorted) {
    const last = ranges.at(-1);
    if (last !== undefined && last.end === index - 1) last.end = index;
    else ranges.push({ start: index, end: index });
  }
  return ranges;
}

export function isLineSelected(selection: LineSelection, index: number): boolean {
  return selection === "all" || selection.some((range) => index >= range.start && index <= range.end);
}

export function toggleLine(selection: LineSelection, index: number, lineCount: number): LineSelection | null {
  const lines = selectionToSet(selection, lineCount);
  if (lines.has(index)) lines.delete(index);
  else lines.add(index);
  return setToSelection(lines, lineCount);
}

export function selectLineRange(selection: LineSelection, from: number, to: number, lineCount: number): LineSelection | null {
  const lines = selectionToSet(selection, lineCount);
  const [start, end] = from <= to ? [from, to] : [to, from];
  for (let index = start; index <= end; index += 1) lines.add(index);
  return setToSelection(lines, lineCount);
}

function rangeText(range: LineRange): string {
  return range.start === range.end ? `${range.start + 1}` : `${range.start + 1}–${range.end + 1}`;
}

export function selectionLabel(selection: LineSelection, lineCount: number): string {
  const normalized = setToSelection(selectionToSet(selection, lineCount), lineCount);
  if (normalized === "all" || normalized === null) return "all lines";
  const single = normalized.length === 1 && normalized[0]?.start === normalized[0]?.end;
  return `${single ? "line" : "lines"} ${normalized.map(rangeText).join(", ")}`;
}

export function nextDestinationId(destinations: readonly Destination[]): string {
  const taken = new Set(destinations.map((destination) => destination.id));
  for (let index = destinations.length + 1; ; index += 1) {
    const id = `dest_${index}`;
    if (!taken.has(id)) return id;
  }
}

export function defaultHeadingFor(target: DocTarget): string {
  return target.kind === "new" ? NEW_DOC_HEADING : DEFAULT_HEADING;
}

export function createDestination(destinations: readonly Destination[], target: DocTarget): Destination {
  return {
    id: nextDestinationId(destinations),
    include: true,
    target,
    heading: defaultHeadingFor(target),
    lineRanges: "all",
    role: "content",
    reason: "",
  };
}

export function sameTarget(a: DocTarget, b: DocTarget): boolean {
  if (a.kind === "existing" && b.kind === "existing") return a.slug === b.slug;
  if (a.kind === "new" && b.kind === "new") return a.title.trim().toLowerCase() === b.title.trim().toLowerCase();
  return false;
}

export function retarget(destination: Destination, target: DocTarget): Destination {
  const keepsHeading = destination.heading !== defaultHeadingFor(destination.target);
  return { ...destination, target, heading: keepsHeading ? destination.heading : defaultHeadingFor(target) };
}

export function updateDestination(destinations: readonly Destination[], id: string, patch: Partial<Omit<Destination, "id">>): Destination[] {
  return destinations.map((destination) => (destination.id === id ? { ...destination, ...patch } : destination));
}

export function removeDestination(destinations: readonly Destination[], id: string): Destination[] {
  return destinations.filter((destination) => destination.id !== id);
}

export function targetTitle(target: DocTarget, docs: ReadonlyMap<string, DocSummary>): string {
  return target.kind === "new" ? target.title : (docs.get(target.slug)?.title ?? target.slug);
}

export function targetHeadings(target: DocTarget, docs: ReadonlyMap<string, DocSummary>): readonly string[] {
  return target.kind === "existing" ? (docs.get(target.slug)?.headings ?? []) : [];
}

export function headingOptions(headings: readonly string[], current: string, role: Destination["role"], target: DocTarget): string[] {
  const options: string[] = [];
  const seen = new Set<string>();
  const currentKey = current.trim().toLowerCase();
  const add = (heading: string) => {
    const key = heading.trim().toLowerCase();
    if (key === "" || seen.has(key)) return;
    seen.add(key);
    options.push(key === currentKey ? current.trim() : heading.trim());
  };
  if (target.kind === "new") add(NEW_DOC_HEADING);
  headings.forEach(add);
  add(DEFAULT_HEADING);
  if (role === "link") add(RELATED_HEADING);
  add(current);
  return options;
}

export function matchesTag(target: DocTarget, tag: string): boolean {
  if (target.kind !== "new") return false;
  const normalized = normalizeTag(tag);
  return slugify(target.title) === normalized || normalizeTag(target.title) === normalized || target.aliases.some((alias) => normalizeTag(alias) === normalized);
}

export interface CardDraft {
  destinations: Destination[];
  rememberAliases: RememberAlias[];
}

export function acceptTagSuggestion(draft: CardDraft, suggestion: Pick<TagSuggestion, "tag" | "slug">): CardDraft {
  const target: DocTarget = { kind: "existing", slug: suggestion.slug };
  let switched = false;
  const destinations = draft.destinations.map((destination) => {
    if (!matchesTag(destination.target, suggestion.tag)) return destination;
    switched = true;
    return { ...retarget(destination, target), include: true };
  });
  const alreadyTargeted = destinations.some((destination) => sameTarget(destination.target, target));
  const next = switched || alreadyTargeted ? destinations : [...destinations, createDestination(destinations, target)];
  const rememberAliases = [
    ...draft.rememberAliases.filter((alias) => alias.tag !== suggestion.tag),
    { tag: suggestion.tag, slug: suggestion.slug },
  ];
  return { destinations: next, rememberAliases };
}

export interface SuggestionGroup {
  tag: string;
  best: TagSuggestion;
  others: TagSuggestion[];
}

export function pendingSuggestions(
  suggestions: readonly TagSuggestion[],
  remembered: readonly RememberAlias[],
  dismissed: ReadonlySet<string>,
): SuggestionGroup[] {
  const done = new Set([...remembered.map((alias) => alias.tag), ...dismissed]);
  const groups = new Map<string, TagSuggestion[]>();
  for (const suggestion of suggestions) {
    if (done.has(suggestion.tag)) continue;
    groups.set(suggestion.tag, [...(groups.get(suggestion.tag) ?? []), suggestion]);
  }
  return [...groups].flatMap(([tag, items]) => {
    const [best, ...others] = [...items].sort((a, b) => b.score - a.score);
    return best === undefined ? [] : [{ tag, best, others }];
  });
}

export function includedDestinations(destinations: readonly Destination[]): Destination[] {
  return destinations.filter((destination) => destination.include);
}

export function hasContentToAdd(destinations: readonly Destination[]): boolean {
  return destinations.some((destination) => destination.role === "content" && (destination.written === true || destination.include));
}
