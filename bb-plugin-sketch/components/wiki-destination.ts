import type { WikiAvailability, WikiDestination, WikiDoc, WikiSuggestion } from "../contract";
import type { WikiChoice } from "./storage";
import { DEFAULT_HEADING } from "./wiki-docs";

export type Kind = WikiChoice["kind"];
export type DocChoice = { readonly slug: string; readonly title: string; readonly heading: string | null };

export type WikiStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "ready"; readonly inbox: boolean; readonly docs: readonly WikiDoc[] };

export type WikiDocsLoad = {
  readonly value: { readonly wiki: WikiAvailability; readonly docs: readonly WikiDoc[] } | undefined;
  readonly error: string | null;
};

export function wikiStatus(load: WikiDocsLoad): WikiStatus {
  if (load.value === undefined) return load.error === null ? { kind: "loading" } : { kind: "failed", message: load.error };
  const { wiki, docs } = load.value;
  return wiki.available ? { kind: "ready", inbox: wiki.inbox, docs } : { kind: "unavailable", reason: wiki.reason };
}

export function inboxBlocked(status: WikiStatus): boolean {
  return status.kind === "ready" && !status.inbox;
}

export function effectiveKind(kind: Kind, status: WikiStatus): Kind {
  return inboxBlocked(status) ? "doc" : kind;
}

export function storedChoice(docs: readonly WikiDoc[], stored: WikiChoice): DocChoice | null {
  const doc = stored.slug === null ? undefined : docs.find((candidate) => candidate.slug === stored.slug);
  return doc === undefined ? null : { slug: doc.slug, title: doc.title, heading: stored.heading };
}

export function suggestedChoice(suggestions: readonly WikiSuggestion[]): DocChoice | null {
  const [top] = suggestions;
  return top === undefined ? null : { slug: top.slug, title: top.title, heading: top.heading };
}

export type InitialChoiceInput = {
  readonly docs: readonly WikiDoc[] | undefined;
  readonly docsSettled: boolean;
  readonly stored: WikiChoice;
  readonly suggestions: { readonly list: readonly WikiSuggestion[]; readonly settled: boolean };
};

export function initialChoice({ docs, docsSettled, stored, suggestions }: InitialChoiceInput): DocChoice | null | undefined {
  if (!docsSettled) return undefined;
  const remembered = storedChoice(docs ?? [], stored);
  if (remembered !== null) return remembered;
  return suggestions.settled ? suggestedChoice(suggestions.list) : undefined;
}

export function defaultHeading(choice: DocChoice | null): string {
  return choice?.heading ?? DEFAULT_HEADING;
}

export function destinationFor(kind: Kind, choice: DocChoice | null, heading: string): WikiDestination | null {
  if (kind === "inbox") return { kind: "inbox" };
  return choice === null || heading === "" ? null : { kind: "doc", slug: choice.slug, heading };
}

export function sendLabel(kind: Kind, choice: DocChoice | null, busy: boolean): string {
  if (busy) return "Sending…";
  if (kind === "inbox") return "Send to inbox";
  return choice === null ? "Add to doc" : `Add to ${choice.title}`;
}

export function rememberedChoice(destination: WikiDestination, stored: WikiChoice): WikiChoice {
  return destination.kind === "doc" ? { kind: "doc", slug: destination.slug, heading: destination.heading } : { ...stored, kind: "inbox" };
}

export function suggestText(caption: string, note: string): string {
  return [caption, note].filter((part) => part.trim() !== "").join("\n\n");
}
