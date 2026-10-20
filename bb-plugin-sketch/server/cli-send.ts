import { cliCommand, PluginCliError, type PluginCliContext, type PluginCliResult } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SendResult } from "../contract.js";
import { parseSceneFile } from "../lib/scene.js";
import { captionFor } from "../lib/selection.js";
import { LIMITS } from "../lib/sketch.js";
import { matchWikiDoc, type DocMatch } from "./cli-match.js";
import { cliThreadId, guarded, jsonOption, output, parseOrThrow, SKETCH_HINT, WIKI_HINT } from "./cli-output.js";
import { noImage, resolveSketchId, sketchPositional } from "./cli-resolve.js";
import type { SketchContext } from "./context.js";
import { WIKI_DEFAULT_HEADING, type SendTarget, type WikiDocEntry } from "./wiki.js";
import { WIKI_NO_INBOX, WIKI_NO_INBOX_THREAD } from "./wiki-errors.js";

const DOCS_HINT = "Run `bb wiki docs` to list Wiki docs.";
const DOC_INSTEAD_HINT = "Pass --doc <doc> to add it to a Wiki doc instead.";
const UPDATE_WIKI_HINT = "Ask the user to update the Wiki plugin.";

const headingSchema = z.string().trim().min(1).max(LIMITS.heading);
const captionSchema = z.string().max(LIMITS.caption);
const noteSchema = z.string().max(LIMITS.note);

interface SendOptions {
  json: boolean;
  inbox: boolean;
  doc?: string | undefined;
  heading?: string | undefined;
  caption?: string | undefined;
  note?: string | undefined;
}

interface Destination {
  target: SendTarget;
  docTitle: string | null;
  heading: string | null;
}

export function sketchCaption(content: string): string {
  try {
    return captionFor(parseSceneFile(content).scene.elements);
  } catch {
    return "";
  }
}

function pickedDoc(docs: readonly WikiDocEntry[], ref: string): DocMatch {
  const match = matchWikiDoc(docs, ref);
  if (match.kind === "one") return match.item;
  if (match.kind === "many") {
    const slugs = match.items.map((item) => item.doc.slug).join(", ");
    throw new PluginCliError(`“${ref.trim()}” matches more than one Wiki doc: ${slugs}.`, { code: "ambiguous", hint: "Pass the doc's slug." });
  }
  throw new PluginCliError(`No Wiki doc matches “${ref.trim()}”.`, { code: "not_found", hint: DOCS_HINT });
}

async function docDestination(ctx: SketchContext, ref: string, heading: string | undefined, threaded: boolean): Promise<Destination> {
  const { wiki, docs } = await ctx.wiki.docs();
  if (!wiki.available) throw new PluginCliError(wiki.reason, { code: "wiki_unavailable", hint: WIKI_HINT });
  const picked = pickedDoc(docs, ref);
  const chosen = parseOrThrow(headingSchema, heading ?? picked.heading ?? WIKI_DEFAULT_HEADING, "Pass a heading like --heading Diagrams.", "heading");
  const target: SendTarget = threaded
    ? { kind: "inbox", proposal: { slug: picked.doc.slug, heading: chosen } }
    : { kind: "doc", slug: picked.doc.slug, heading: chosen };
  return { target, docTitle: picked.doc.title, heading: chosen };
}

function sentLine(id: string, result: SendResult, destination: Destination): string {
  if (result.kind === "doc") return `Added “${id}” to ${result.title} › ${destination.heading ?? WIKI_DEFAULT_HEADING} (${result.slug}).`;
  if (destination.docTitle === null) return `Sent “${id}” to the Wiki inbox as ${result.cardId}. Review it there to pick where it goes.`;
  return `Sent “${id}” to the Wiki inbox as ${result.cardId}, proposed for ${destination.docTitle} › ${destination.heading ?? WIKI_DEFAULT_HEADING}. The user reviews it there.`;
}

async function requireInbox(ctx: SketchContext, threaded: boolean): Promise<void> {
  const wiki = await ctx.wiki.availability();
  if (!wiki.available) throw new PluginCliError(wiki.reason, { code: "wiki_unavailable", hint: WIKI_HINT });
  if (wiki.inbox) return;
  throw new PluginCliError(threaded ? WIKI_NO_INBOX_THREAD : WIKI_NO_INBOX, {
    code: "wiki_no_inbox",
    hint: threaded ? UPDATE_WIKI_HINT : DOC_INSTEAD_HINT,
  });
}

async function runSend(ctx: SketchContext, cli: PluginCliContext, options: SendOptions, ref: string): Promise<PluginCliResult> {
  const id = await resolveSketchId(ctx, ref);
  const threadId = cliThreadId(cli);
  if (options.doc === undefined || threadId !== null) await requireInbox(ctx, threadId !== null);
  const { sketch, png } = await guarded(SKETCH_HINT, () => ctx.store.freshPreview(id));
  if (png === null) throw noImage(id);
  const caption = parseOrThrow(captionSchema, options.caption ?? sketchCaption(sketch.content), "Shorten the caption.", "caption");
  const note = parseOrThrow(noteSchema, options.note ?? "", "Shorten the note.", "note");
  const destination: Destination =
    options.doc === undefined
      ? { target: { kind: "inbox", proposal: null }, docTitle: null, heading: null }
      : await docDestination(ctx, options.doc, options.heading, threadId !== null);
  const result = await guarded(WIKI_HINT, () => ctx.wiki.send({ name: id, png, caption, note, target: destination.target, threadId }));
  const value = { sketch: id, ...result, heading: destination.heading };
  return output(options.json, value, [sentLine(id, result, destination)]);
}

export function sendCommands(ctx: SketchContext) {
  return {
    send: cliCommand({
      summary: "Send a sketch's image to the Wiki inbox, or into a Wiki doc",
      description:
        "Sends the image Sketch drew the last time the sketch was open in bb. From inside a bb thread, --doc files an inbox card that proposes that doc and heading instead of writing to the doc.",
      positionals: [sketchPositional],
      options: {
        ...jsonOption,
        inbox: { type: "boolean", description: "Send it to the Wiki inbox, to review and file there" },
        doc: { type: "string", placeholder: "doc", description: 'Wiki doc slug, title, alias, or @tag; "Title#Heading" also picks the heading' },
        heading: { type: "string", placeholder: "heading", description: `Heading of --doc to add under (default ${WIKI_DEFAULT_HEADING})` },
        caption: { type: "string", placeholder: "text", description: `Image caption (max ${LIMITS.caption} characters; default: the sketch's text)` },
        note: { type: "string", placeholder: "markdown", description: `Markdown to put above the image (max ${LIMITS.note} characters)` },
      },
      constraints: [
        { kind: "exactly-one", options: ["inbox", "doc"] },
        { kind: "requires", option: "heading", needs: ["doc"] },
      ],
      run: ({ positionals, options }, cli) => runSend(ctx, cli, options, positionals.sketch.join(" ")),
    }),
  };
}
