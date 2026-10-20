import type { WikiDoc, WikiSuggestion } from "../contract";

export const DEFAULT_HEADING = "Unsorted";

export type DocOption = {
  readonly key: string;
  readonly slug: string;
  readonly title: string;
  readonly detail: string;
  readonly heading: string | null;
  readonly best: boolean;
};

function normalize(value: string): string {
  return value.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

function words(value: string): string[] {
  return normalize(value).split(/[^\p{L}\p{N}]+/u).filter((word) => word !== "");
}

export function docScore(doc: Pick<WikiDoc, "title" | "slug" | "aliases" | "tag">, query: string): number | null {
  const q = normalize(query).replace(/^@/, "");
  if (q === "") return 0;
  const title = normalize(doc.title);
  const names = [doc.slug, doc.tag, ...doc.aliases].filter((name) => name !== "").map(normalize);
  if (title.startsWith(q)) return 0;
  if (names.some((name) => name.startsWith(q))) return 1;
  if (words(doc.title).some((word) => word.startsWith(q))) return 2;
  if (title.includes(q)) return 3;
  if (names.some((name) => name.includes(q))) return 4;
  return null;
}

export function matchDocs(docs: readonly WikiDoc[], query: string): WikiDoc[] {
  return docs
    .flatMap((doc) => {
      const score = docScore(doc, query);
      return score === null ? [] : [{ doc, score }];
    })
    .sort((a, b) => a.score - b.score || a.doc.title.localeCompare(b.doc.title))
    .map((entry) => entry.doc);
}

function detailOf(doc: WikiDoc): string {
  return [doc.tag === "" ? doc.slug : `@${doc.tag}`, ...doc.aliases].join(" · ");
}

export function docOptions(docs: readonly WikiDoc[], suggestions: readonly WikiSuggestion[], query: string): DocOption[] {
  const known = new Map(docs.map((doc) => [doc.slug, doc]));
  const suggested = suggestions.filter((suggestion) => {
    const doc = known.get(suggestion.slug);
    return docScore(doc ?? { title: suggestion.title, slug: suggestion.slug, aliases: [], tag: "" }, query) !== null;
  });
  const options: DocOption[] = suggested.map((suggestion, index) => ({
    key: `suggestion:${suggestion.slug}`,
    slug: suggestion.slug,
    title: suggestion.title,
    detail: suggestion.reason,
    heading: suggestion.heading,
    best: index === 0 && query.trim() === "",
  }));
  const taken = new Set(suggested.map((suggestion) => suggestion.slug));
  for (const doc of matchDocs(docs, query)) {
    if (taken.has(doc.slug)) continue;
    options.push({ key: `doc:${doc.slug}`, slug: doc.slug, title: doc.title, detail: detailOf(doc), heading: null, best: false });
  }
  return options;
}

export function headingOptions(doc: WikiDoc | undefined, preferred: string | null): string[] {
  const seen = new Set<string>();
  return [...(doc?.headings ?? []), ...(preferred === null ? [] : [preferred]), DEFAULT_HEADING].filter((heading) => {
    const key = heading.trim().toLowerCase();
    if (key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function wikiDocHref(slug: string): string {
  return `/plugins/wiki/wiki/doc/${slug.split("/").map(encodeURIComponent).join("/")}`;
}

export function wikiCardHref(cardId: string): string {
  return `/plugins/wiki/wiki/inbox/${encodeURIComponent(cardId)}`;
}
