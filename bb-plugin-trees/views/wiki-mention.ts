import { wikiLinkText, type WikiDocRef } from "../src/wiki-links";

export const MENTION_MENU_LIMIT = 8;

// An @ at the start of a line or after a space, up to the caret.
const AT_QUERY = /(?:^|\s)@([^\s@[\]]*)$/u;

export interface MentionQuery {
  /** Where the @ sits, which is where the link replaces it from. */
  start: number;
  query: string;
}

export function findMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const match = AT_QUERY.exec(text.slice(lineStart, caret));
  if (match === null) return null;
  const query = match[1] ?? "";
  return { start: caret - query.length - 1, query };
}

function wordKey(text: string): string {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "")
    .join("-");
}

function startsAtWord(name: string, needle: string): boolean {
  return name.startsWith(needle) || name.includes(`-${needle}`);
}

function matchRank(doc: WikiDocRef, needle: string): number | null {
  if (needle === "") return 3;
  const names = [doc.slug, doc.tag, ...doc.aliases].map((name) =>
    name.toLowerCase(),
  );
  const title = wordKey(doc.title);
  if (names.includes(needle) || title === needle) return 0;
  if (names.some((name) => name.startsWith(needle)) || title.startsWith(needle))
    return 1;
  if ([...names, title].some((name) => startsAtWord(name, needle))) return 2;
  return doc.title.toLowerCase().includes(needle) ? 3 : null;
}

/** Docs for the @ menu: exact names first, then prefixes, then word starts. */
export function matchWikiDocs(
  docs: readonly WikiDocRef[],
  query: string,
  limit: number = MENTION_MENU_LIMIT,
): WikiDocRef[] {
  const needle = wordKey(query);
  return docs
    .flatMap((doc) => {
      const rank = matchRank(doc, needle);
      return rank === null ? [] : [{ doc, rank }];
    })
    .sort(
      (left, right) =>
        left.rank - right.rank || left.doc.title.localeCompare(right.doc.title),
    )
    .slice(0, limit)
    .map(({ doc }) => doc);
}

/** The text with the @query replaced by the doc's link, and the new caret. */
export function insertWikiLink(args: {
  text: string;
  caret: number;
  mention: MentionQuery;
  slug: string;
}): { text: string; caret: number } {
  const link = `${wikiLinkText(args.slug)} `;
  const before = args.text.slice(0, args.mention.start);
  const after = args.text.slice(args.caret).replace(/^ /u, "");
  return { text: `${before}${link}${after}`, caret: before.length + link.length };
}
