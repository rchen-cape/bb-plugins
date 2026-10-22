import { describe, expect, it } from "vitest";
import { fileTitle, titleGuess } from "../components/AddToWikiDialog";
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { htmlMediaLine, leadingTitleSpan } from "../components/doc-render";
import { WikiLinkSyntax, buildWikiInline, wikiContext } from "../components/wiki-editor";
import { markdownLanguageWith } from "./live-preview/index.js";
import { withoutTitleLine } from "../server/rpc";
import { parseNoteUnits, parseSectionUnits } from "./daily-notes";
import { bestTitleMatches, matchTag } from "./fuzzy";
import {
  addAlias,
  dedent,
  extractImageTargets,
  extractWikiLinks,
  insertUnderHeading,
  listHeadings,
  parseDoc,
  parseSourceMarkers,
  rewriteImageTargets,
  splitSections,
  stripSourceMarkers,
  trimLineEnds,
} from "./markdown-doc";

const SIZE = 200_000;
const BUDGET_MS = 150;
const spaces = " ".repeat(SIZE);
const tabs = "\t".repeat(SIZE);

function repeatTo(unit: string): string {
  return unit.repeat(Math.ceil(SIZE / unit.length));
}

function backtickLadder(): string {
  const runs: string[] = [];
  for (let length = 1, size = 0; size < SIZE; length += 1) {
    runs.push("`".repeat(length));
    size += length + 1;
  }
  return runs.join("a");
}

const NO_TAGS = { knownTags: new Set<string>() };
const WIKI_CONTEXT = { pluginId: "wiki", slug: "a", title: "a", resolve: () => null };

function editorState(doc: string) {
  const state = EditorState.create({ doc, extensions: [markdownLanguageWith([WikiLinkSyntax]), wikiContext.of(WIKI_CONTEXT)] });
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return buildWikiInline(state, [{ from: 0, to: state.doc.length }]);
}

const cases: Array<[string, () => unknown]> = [
  ["heading with a long run of trailing spaces", () => splitSections(`# a${spaces}x`)],
  ["heading with a long run of tabs before a hash", () => listHeadings(`## a${tabs}#x`)],
  ["heading made of space-hash pairs", () => splitSections(`# a${repeatTo(" #")}x`)],
  ["heading made only of hashes", () => splitSections(`# ${"#".repeat(SIZE)} `)],
  ["insertUnderHeading past a long heading", () => insertUnderHeading(`# a${spaces}x\n`, "Notes", "b")],
  ["parseDoc title from a long heading", () => parseDoc(`# a${spaces}x`, "a")],
  ["anchor for a heading of unclosed brackets", () => splitSections(`# ${"[".repeat(SIZE)}`)],
  ["anchor for a heading of unclosed links", () => splitSections(`# ${repeatTo("[a](")}`)],
  ["anchor for a heading of unclosed wiki links", () => splitSections(`# ${repeatTo("[[a|")}`)],
  ["fence run before a line separator", () => splitSections(`${"`".repeat(SIZE)}\u2028x`)],
  ["fence run before a carriage return", () => extractWikiLinks(`${"~".repeat(SIZE)}\rx`)],
  ["many unclosed HTML comments", () => extractWikiLinks(repeatTo("<!--"))],
  ["inline code runs of every length", () => extractWikiLinks(backtickLadder())],
  ["one unclosed backtick before a long line", () => extractWikiLinks(`\`${spaces}[[a]]`)],
  ["many unclosed wiki links", () => extractWikiLinks(repeatTo("[["))],
  ["many unclosed images", () => extractImageTargets(repeatTo("!["))],
  ["image target before a long run of spaces", () => extractImageTargets(`![a](b${spaces}x`)],
  ["rewriting images separated by long runs of spaces", () => rewriteImageTargets(repeatTo(`![a](b.png)${" ".repeat(1_000)}`), () => "c.png")],
  ["addAlias with spaces inside a flow value", () => addAlias(`---\naliases: [a,${spaces}b]\n---\n`, "c")],
  ["addAlias after a block list with trailing spaces", () => addAlias(`---\naliases:\n  - a${spaces}\ntitle: x\n---\n`, "c")],
  ["stripSourceMarkers with many unclosed openers", () => stripSourceMarkers(repeatTo("<!-- wiki:source "))],
  ["stripSourceMarkers with many closers after one opener", () => stripSourceMarkers(`<!-- wiki:source ${repeatTo("--> ")}x`)],
  ["stripSourceMarkers with a long run of spaces", () => stripSourceMarkers(`${spaces}x`)],
  ["stripSourceMarkers with a cut-off tail after spaces", () => stripSourceMarkers(`a${spaces}<!-- x`)],
  ["stripSourceMarkers with a cut-off tail of many openers", () => stripSourceMarkers(`${repeatTo("<!--")}…`)],
  ["stripSourceMarkers with a cut-off head of many attributes", () => stripSourceMarkers(`…a"${repeatTo(" b")}-->`)],
  ["parseSourceMarkers with many closers", () => parseSourceMarkers(`<!-- wiki:source ${repeatTo("--> ")}x`)],
  ["parseSourceMarkers with many unclosed attributes", () => parseSourceMarkers(`<!-- wiki:source ${repeatTo('a="')} -->`)],
  ["dedent of long indents", () => dedent([`${spaces}x`, `${tabs}y`])],
  ["trimLineEnds with long runs of spaces inside lines", () => trimLineEnds(repeatTo(`a${" ".repeat(1_000)}b \n`))],
  ["trimLineEnds with one long run before text", () => trimLineEnds(`${spaces}x\r\n${tabs}`)],
  ["fileTitle from a heading with trailing spaces", () => fileTitle({ name: "a.md", text: `# a${spaces}x` })],
  ["fileTitle from a heading of space-hash pairs", () => fileTitle({ name: "a.md", text: `# a${repeatTo(" #")}x` })],
  ["fileTitle from a frontmatter title with spaces", () => fileTitle({ name: "a.md", text: `---\ntitle: a${spaces}x\n---\n` })],
  ["fileTitle from a frontmatter title of space-quote pairs", () => fileTitle({ name: "a.md", text: `---\ntitle: a${repeatTo(" '")}x\n---\n` })],
  ["fileTitle from a name with many dots", () => fileTitle({ name: repeatTo(".a"), text: "" })],
  ["matchTag with long tags", () => matchTag("a".repeat(SIZE), [{ slug: "a", title: "a".repeat(SIZE), tag: "a".repeat(SIZE), aliases: ["a".repeat(SIZE)] }])],
  ["bestTitleMatches with long titles", () => bestTitleMatches(repeatTo("ab-"), [{ slug: "a", title: repeatTo("ab "), tag: "a", aliases: [] }])],
  ["daily notes with many unclosed images", () => parseSectionUnits([repeatTo("![")], NO_TAGS)],
  ["daily notes with many images sharing one angle target", () => parseSectionUnits([repeatTo("![](<")], NO_TAGS)],
  ["daily notes with many unclosed image titles", () => parseSectionUnits([repeatTo("![](a (")], NO_TAGS)],
  ["daily notes fence run before a line separator", () => parseSectionUnits([`${"`".repeat(SIZE)}\u2028x`], NO_TAGS)],
  ["daily notes with one long backtick run", () => parseSectionUnits([`a ${"`".repeat(SIZE)}`], NO_TAGS)],
  ["daily notes inline code runs of every length", () => parseSectionUnits([`a ${backtickLadder().split("a").reverse().join("a")}`], NO_TAGS)],
  ["daily notes NOTES heading with trailing spaces", () => parseNoteUnits(`# NOTES${spaces}x`, NO_TAGS)],
  ["wiki editor with many unclosed wiki links", () => editorState(repeatTo("[[").slice(0, SIZE / 4))],
  ["wiki editor with many unclosed embeds", () => editorState(repeatTo("![[a").slice(0, SIZE / 4))],
  ["media line with many tags missing src", () => htmlMediaLine(repeatTo("<img "))],
  ["media line with many unclosed src values", () => htmlMediaLine(repeatTo('<img src="'))],
  ["title heading with trailing spaces", () => leadingTitleSpan((index) => (index === 0 ? `# a${spaces}x` : null), "a")],
  ["titleGuess from a heading with trailing spaces", () => titleGuess(`# a${spaces}x`)],
  ["titleGuess from a heading of space-hash pairs", () => titleGuess(`### a${repeatTo(" #")}x`)],
  ["withoutTitleLine with a long first line", () => withoutTitleLine(`# a${spaces}x\nb`, "a")],
];

describe("linear time on adversarial input", () => {
  for (const [name, run] of cases) {
    it(name, () => {
      const start = performance.now();
      run();
      expect(performance.now() - start).toBeLessThan(BUDGET_MS);
    });
  }
});
