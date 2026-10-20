import { nameKey } from "./names.js";
import type { WikiDocEntry } from "./wiki.js";

export type Match<T> = { kind: "one"; item: T } | { kind: "many"; items: T[] } | { kind: "none" };

export interface DocMatch {
  doc: WikiDocEntry;
  heading: string | null;
}

function pick<T>(items: readonly T[]): Match<T> | null {
  const [first] = items;
  if (first === undefined) return null;
  return items.length === 1 ? { kind: "one", item: first } : { kind: "many", items: [...items] };
}

export function matchSketch(ids: readonly string[], ref: string): Match<string> {
  const wanted = ref.trim();
  const key = nameKey(wanted);
  if (key === "") return { kind: "none" };
  return (
    pick(ids.filter((id) => id === wanted)) ??
    pick(ids.filter((id) => nameKey(id) === key)) ??
    pick(ids.filter((id) => nameKey(id).startsWith(key))) ?? { kind: "none" }
  );
}

function directDoc(docs: readonly WikiDocEntry[], ref: string): Match<WikiDocEntry> | null {
  const key = nameKey(ref);
  const tag = nameKey(ref.replace(/^@/, ""));
  return (
    pick(docs.filter((doc) => doc.slug === ref)) ??
    pick(docs.filter((doc) => nameKey(doc.title) === key)) ??
    pick(docs.filter((doc) => doc.aliases.some((alias) => nameKey(alias) === key))) ??
    pick(docs.filter((doc) => doc.tag !== "" && nameKey(doc.tag) === tag))
  );
}

function withHeading(match: Match<WikiDocEntry>, heading: string | null): Match<DocMatch> {
  if (match.kind === "one") return { kind: "one", item: { doc: match.item, heading } };
  if (match.kind === "many") return { kind: "many", items: match.items.map((doc) => ({ doc, heading })) };
  return match;
}

export function matchWikiDoc(docs: readonly WikiDocEntry[], ref: string): Match<DocMatch> {
  const wanted = ref.trim();
  if (wanted === "") return { kind: "none" };
  const direct = directDoc(docs, wanted);
  if (direct !== null) return withHeading(direct, null);
  const split = wanted.lastIndexOf("#");
  if (split <= 0) return { kind: "none" };
  const heading = wanted.slice(split + 1).trim();
  const withRef = directDoc(docs, wanted.slice(0, split).trim());
  return withRef === null ? { kind: "none" } : withHeading(withRef, heading === "" ? null : heading);
}
