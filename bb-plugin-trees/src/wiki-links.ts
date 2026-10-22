/*
 * A task's text names a Wiki doc with the Wiki's own link syntax, [[target]],
 * which the @ menu inserts as [[slug]]. A target can also be a title, an
 * alias, or a tag, and may carry a #heading or a |label, as in the Wiki.
 */

export interface WikiDocRef {
  slug: string;
  title: string;
  type: string;
  tag: string;
  aliases: string[];
}

export interface LinkedWikiDoc {
  slug: string;
  title: string;
  content: string;
}

const WIKI_LINK = /(?<!!)\[\[([^[\]\n]+)\]\]/gu;
const FENCE = /^ {0,3}(`{3,}|~{3,})/u;

export function wikiLinkText(slug: string): string {
  return `[[${slug}]]`;
}

export function wikiDocFileName(slug: string): string {
  return `${slug}.md`;
}

function linkTarget(inner: string): string {
  return (inner.split("|")[0] ?? "").split("#")[0]?.trim() ?? "";
}

// Lines inside a fenced code block are code, so a [[...]] there is not a link.
function proseLines(text: string): string[] {
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of text.split("\n")) {
    const marker = FENCE.exec(line)?.[1] ?? null;
    if (fence === null && marker !== null) {
      fence = marker;
    } else if (
      fence !== null &&
      marker !== null &&
      marker[0] === fence[0] &&
      marker.length >= fence.length
    ) {
      fence = null;
    } else if (fence === null) {
      lines.push(line);
    }
  }
  return lines;
}

/** The distinct link targets in the text, in the order they first appear. */
export function wikiLinkTargets(text: string): string[] {
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const line of proseLines(text)) {
    for (const match of line.matchAll(WIKI_LINK)) {
      const target = linkTarget(match[1] ?? "");
      const key = target.toLowerCase();
      if (target === "" || seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
  }
  return targets;
}

/** The Wiki's own order: slug, then title, then alias, then tag. */
export function resolveWikiTarget(
  docs: readonly WikiDocRef[],
  target: string,
): WikiDocRef | null {
  const key = target.replace(/^@/u, "").toLowerCase();
  return (
    docs.find((doc) => doc.slug.toLowerCase() === key) ??
    docs.find((doc) => doc.title.toLowerCase() === key) ??
    docs.find((doc) =>
      doc.aliases.some((alias) => alias.toLowerCase() === key),
    ) ??
    docs.find((doc) => doc.tag.toLowerCase() === key) ??
    null
  );
}

/** Each doc the text links to once, in link order; unknown targets drop out. */
export function linkedWikiRefs(
  docs: readonly WikiDocRef[],
  text: string,
): WikiDocRef[] {
  const found = new Map<string, WikiDocRef>();
  for (const target of wikiLinkTargets(text)) {
    const doc = resolveWikiTarget(docs, target);
    if (doc !== null && !found.has(doc.slug)) found.set(doc.slug, doc);
  }
  return [...found.values()];
}

/*
 * A note that links Wiki docs carries them with it: each linked doc's
 * Markdown follows the note, so whatever reads the note downstream, whether
 * the next task or the summarizer, reads the docs too.
 */
export function withWikiDocs(
  text: string,
  docs: readonly LinkedWikiDoc[],
): string {
  if (docs.length === 0) return text;
  const sections = docs.map((doc) =>
    [
      `#### Wiki doc: ${doc.title} (${wikiDocFileName(doc.slug)})`,
      doc.content.trim(),
    ].join("\n\n"),
  );
  return [
    text.trimEnd(),
    "The Wiki docs this note links to follow, as saved in the Wiki.",
    ...sections,
  ].join("\n\n");
}

/*
 * An agent task's instruction sends its linked docs as attached files, so the
 * prompt says which attachment is which link.
 */
export function attachedWikiDocsNote(docs: readonly LinkedWikiDoc[]): string {
  const files = docs
    .map((doc) => `${wikiDocFileName(doc.slug)} (${wikiLinkText(doc.slug)})`)
    .join(", ");
  return `The Wiki docs the task links to are attached as Markdown files: ${files}.`;
}
