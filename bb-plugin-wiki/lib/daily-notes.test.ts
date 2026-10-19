import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  extractNotesSection,
  formatNoteDateShort,
  hashUnitText,
  isIngestibleNoteDate,
  isSkippedNotesDirectory,
  isTagLine,
  isValidTimeZone,
  normalizeWhitespace,
  parseDailyNoteName,
  parseNoteUnits,
  parseSectionUnits,
  todayInZone,
  type NoteUnit,
} from "./daily-notes";

const NO_TAGS: ReadonlySet<string> = new Set();

function note(...body: string[]): string {
  return ["### TODO", "- #LATER Ship the widget", "    1. #DONE Draft it", "", "### NOTES", ...body, "", "### NEXT TODOS", "- Tomorrow"].join("\n");
}

function units(content: string, knownTags: ReadonlySet<string> = NO_TAGS): NoteUnit[] {
  return parseNoteUnits(content, { knownTags });
}

function section(lines: string[], knownTags: ReadonlySet<string> = NO_TAGS): NoteUnit[] {
  return parseSectionUnits(lines, { knownTags });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

describe("parseDailyNoteName", () => {
  it("reads two-digit and one-digit months as 20YY dates", () => {
    expect(parseDailyNoteName("10-14-26.md")).toBe("2026-10-14");
    expect(parseDailyNoteName("8-18-26.md")).toBe("2026-08-18");
    expect(parseDailyNoteName("09-01-26.md")).toBe("2026-09-01");
    expect(parseDailyNoteName("1-01-00.md")).toBe("2000-01-01");
  });

  it("uses the basename of a path", () => {
    expect(parseDailyNoteName("Time/oct2026/10-14-26.md")).toBe("2026-10-14");
    expect(parseDailyNoteName("/Users/me/Notes/Time/sept2026/9-30-26.md")).toBe("2026-09-30");
  });

  it("accepts leap days only in leap years", () => {
    expect(parseDailyNoteName("2-29-28.md")).toBe("2028-02-29");
    expect(parseDailyNoteName("2-29-26.md")).toBeNull();
  });

  it.each([
    "13-01-26.md",
    "0-10-26.md",
    "00-10-26.md",
    "10-00-26.md",
    "10-32-26.md",
    "4-31-26.md",
    "2-30-26.md",
    "10-4-26.md",
    "010-14-26.md",
    "10-14-2026.md",
    "10-14-26.txt",
    "10-14-26.MD",
    "10-14-26.md.bak",
    "x10-14-26.md",
    "10_14_26.md",
    "notes.md",
    "",
  ])("rejects %j", (name) => {
    expect(parseDailyNoteName(name)).toBeNull();
  });
});

describe("formatNoteDateShort", () => {
  it("formats ISO dates as MM-DD-YY", () => {
    expect(formatNoteDateShort("2026-10-14")).toBe("10-14-26");
    expect(formatNoteDateShort("2026-09-03")).toBe("09-03-26");
    expect(formatNoteDateShort("2100-01-02")).toBe("01-02-00");
  });

  it("round-trips with parseDailyNoteName", () => {
    expect(formatNoteDateShort(parseDailyNoteName("8-05-26.md") ?? "")).toBe("08-05-26");
  });

  it("returns input that is not an ISO date unchanged", () => {
    expect(formatNoteDateShort("10-14-26")).toBe("10-14-26");
    expect(formatNoteDateShort("2026-10-14T00:00:00Z")).toBe("2026-10-14T00:00:00Z");
    expect(formatNoteDateShort("")).toBe("");
  });
});

describe("isSkippedNotesDirectory and isIngestibleNoteDate", () => {
  it("skips dot-folders and node_modules only", () => {
    expect(isSkippedNotesDirectory(".git")).toBe(true);
    expect(isSkippedNotesDirectory(".obsidian")).toBe(true);
    expect(isSkippedNotesDirectory("node_modules")).toBe(true);
    expect(isSkippedNotesDirectory("oct2026")).toBe(false);
    expect(isSkippedNotesDirectory("photos")).toBe(false);
  });

  it("never ingests today or future notes", () => {
    expect(isIngestibleNoteDate("2026-10-14", "2026-10-15")).toBe(true);
    expect(isIngestibleNoteDate("2025-12-31", "2026-01-01")).toBe(true);
    expect(isIngestibleNoteDate("2026-10-15", "2026-10-15")).toBe(false);
    expect(isIngestibleNoteDate("2026-10-16", "2026-10-15")).toBe(false);
  });
});

describe("todayInZone", () => {
  const lateUtc = new Date("2026-10-15T03:30:00Z");
  const eveningUtc = new Date("2026-10-14T23:30:00Z");

  it("uses the calendar date in the given zone", () => {
    expect(todayInZone("UTC", lateUtc)).toBe("2026-10-15");
    expect(todayInZone("America/Los_Angeles", lateUtc)).toBe("2026-10-14");
    expect(todayInZone("America/New_York", eveningUtc)).toBe("2026-10-14");
    expect(todayInZone("Asia/Tokyo", eveningUtc)).toBe("2026-10-15");
    expect(todayInZone("Pacific/Kiritimati", new Date("2026-12-31T10:00:00Z"))).toBe("2027-01-01");
  });

  it("handles DST transitions", () => {
    expect(todayInZone("America/New_York", new Date("2026-03-08T04:30:00Z"))).toBe("2026-03-07");
    expect(todayInZone("America/New_York", new Date("2026-03-08T07:30:00Z"))).toBe("2026-03-08");
    expect(todayInZone("America/New_York", new Date("2026-11-01T04:30:00Z"))).toBe("2026-11-01");
  });

  it("falls back to the system zone for empty or invalid zones", () => {
    const system = todayInZone(Intl.DateTimeFormat().resolvedOptions().timeZone, lateUtc);
    expect(todayInZone("", lateUtc)).toBe(system);
    expect(todayInZone("   ", lateUtc)).toBe(system);
    expect(todayInZone("Not/AZone", lateUtc)).toBe(system);
  });

  it("trims the zone name", () => {
    expect(todayInZone(" Asia/Tokyo ", eveningUtc)).toBe("2026-10-15");
  });

  it("validates zone names", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus")).toBe(false);
  });
});

describe("isTagLine", () => {
  it("reads one or more @tags", () => {
    expect(isTagLine("@unified-notification")).toEqual(["unified-notification"]);
    expect(isTagLine("@unified-notification ")).toEqual(["unified-notification"]);
    expect(isTagLine("  @alpha   @Beta-Two\t@gamma3")).toEqual(["alpha", "beta-two", "gamma3"]);
    expect(isTagLine("@Dc-08-2026")).toEqual(["dc-08-2026"]);
    expect(isTagLine("@2fa")).toEqual(["2fa"]);
  });

  it("dedupes and normalizes", () => {
    expect(isTagLine("@Spam @spam @SPAM")).toEqual(["spam"]);
    expect(isTagLine("@trailing-")).toEqual(["trailing"]);
  });

  it.each([
    "",
    "   ",
    "@",
    "@-leading",
    "@under_score",
    "@George: said hi",
    "- @George: said hi",
    "@alpha beta",
    "alpha @beta",
    "email me@host.test",
    "@alpha,@beta",
    "#hashtag",
    "> @alpha",
  ])("rejects %j", (line) => {
    expect(isTagLine(line)).toBeNull();
  });
});

describe("extractNotesSection", () => {
  it("returns the body between NOTES and the next heading of the same level", () => {
    expect(extractNotesSection(note("- one", "- two"))).toEqual(["- one", "- two", ""]);
  });

  it("accepts trailing spaces, other levels, and any case", () => {
    expect(extractNotesSection("### NOTES \n- a\n### TODO\n- b")).toEqual(["- a"]);
    expect(extractNotesSection("## Notes\n- a")).toEqual(["- a"]);
    expect(extractNotesSection("# notes\t\n- a")).toEqual(["- a"]);
    expect(extractNotesSection("### NOTES:\n- a")).toEqual(["- a"]);
    expect(extractNotesSection("### Notes: \n- a")).toEqual(["- a"]);
    expect(extractNotesSection("### Notes :\n- a")).toEqual(["- a"]);
    expect(extractNotesSection("### notes\t:\t\n- a")).toEqual(["- a"]);
  });

  it("returns null when there is no NOTES heading", () => {
    expect(extractNotesSection("### TODO\n- a")).toBeNull();
    expect(extractNotesSection("")).toBeNull();
    expect(extractNotesSection("### NOTES: extra\n- a")).toBeNull();
    expect(extractNotesSection("### NOTES::\n- a")).toBeNull();
    expect(extractNotesSection("### NOTES : :\n- a")).toBeNull();
    expect(extractNotesSection("###NOTES\n- a")).toBeNull();
    expect(extractNotesSection("### MEETING NOTES\n- a")).toBeNull();
    expect(extractNotesSection("####### NOTES\n- a")).toBeNull();
    expect(extractNotesSection(" ### NOTES\n- a")).toBeNull();
  });

  it("ends at a higher-level heading but not a lower one", () => {
    expect(extractNotesSection("### NOTES\n- a\n#### Detail\n- b\n## Week\n- c")).toEqual(["- a", "#### Detail", "- b"]);
  });

  it("runs to the end of the file", () => {
    expect(extractNotesSection("### TODO\n- x\n### NOTES\n- a\n\n- b\n")).toEqual(["- a", "", "- b", ""]);
  });

  it("returns an empty body for an empty section", () => {
    expect(extractNotesSection("### NOTES\n### NEXT TODOS\n- a")).toEqual([]);
  });

  it("ignores headings inside code fences", () => {
    const content = [
      "### TODO",
      "```md",
      "### NOTES",
      "```",
      "### NOTES",
      "- run it",
      "```zsh",
      "# comment",
      "### NEXT TODOS",
      "```",
      "- after",
      "### NEXT TODOS",
      "- later",
    ].join("\n");
    expect(extractNotesSection(content)).toEqual(["- run it", "```zsh", "# comment", "### NEXT TODOS", "```", "- after"]);
  });

  it("does not end at a # line nested under a bullet", () => {
    const content = "### NOTES\n- ran:\n  # set the env\n  export X=1\n- after\n   ## nested too\n- last\n### TODO\n- t";
    expect(extractNotesSection(content)).toEqual([
      "- ran:",
      "  # set the env",
      "  export X=1",
      "- after",
      "   ## nested too",
      "- last",
    ]);
    expect(units(content).map((unit) => unit.lines[0])).toEqual(["- ran:", "- after", "- last"]);
  });

  it("still ends at a heading indented by one space", () => {
    expect(extractNotesSection("### NOTES\n- a\n ## Week\n- b")).toEqual(["- a"]);
  });

  it("does not treat #word list content as a heading", () => {
    expect(extractNotesSection("### NOTES\n#LATER not a heading\n- a")).toEqual(["#LATER not a heading", "- a"]);
  });

  it("uses the first NOTES heading", () => {
    expect(extractNotesSection("### NOTES\n- a\n### NOTES\n- b")).toEqual(["- a"]);
  });

  it("handles CRLF and a byte order mark", () => {
    expect(extractNotesSection("\uFEFF### NOTES\r\n- a\r\n\r\n- b\r\n### TODO\r\n- c")).toEqual(["- a", "", "- b"]);
  });
});

describe("parseNoteUnits blocks and tags", () => {
  const sample = note(
    "- Untagged first idea",
    "    - with a nested child",
    "",
    "@widget-launch",
    "- Schema tests",
    "    - Definition: rules live on the struct",
    "    - One limitation: some rules stay explicit",
    "- Rate limiter",
    "    - Two kinds of bucket",
    "        1. Per-host bucket",
    "        2. Global bucket",
    "    - Each push needs a token from both",
    "",
    "- Untagged after a blank line",
  );

  it("splits a realistic note into units", () => {
    const parsed = units(sample);
    expect(parsed.map((unit) => unit.lines[0])).toEqual([
      "- Untagged first idea",
      "- Schema tests",
      "- Rate limiter",
      "- Untagged after a blank line",
    ]);
    expect(parsed.map((unit) => unit.index)).toEqual([0, 1, 2, 3]);
  });

  it("applies a block's tag line to every unit in the block only", () => {
    expect(units(sample).map((unit) => unit.blockTags)).toEqual([[], ["widget-launch"], ["widget-launch"], []]);
  });

  it("keeps nested children and numbered sub-items with their parent", () => {
    const rateLimiter = units(sample)[2];
    expect(rateLimiter?.lines).toEqual([
      "- Rate limiter",
      "    - Two kinds of bucket",
      "        1. Per-host bucket",
      "        2. Global bucket",
      "    - Each push needs a token from both",
    ]);
    expect(rateLimiter?.text).toBe(rateLimiter?.lines.join("\n"));
  });

  it("never includes the tag line in a unit", () => {
    expect(units(sample).some((unit) => unit.text.includes("@widget-launch"))).toBe(false);
  });

  it("ignores everything outside the NOTES section", () => {
    expect(units(sample).some((unit) => unit.text.includes("#LATER") || unit.text.includes("Tomorrow"))).toBe(false);
  });

  it("returns no units without a NOTES section", () => {
    expect(units("### TODO\n- a\n- b")).toEqual([]);
  });

  it("returns no units for a block with only a tag line", () => {
    expect(section(["@lonely", "", "@other"])).toEqual([]);
  });

  it("continues a block across a blank line followed by an indented line", () => {
    const parsed = section(["@alpha", "- parent", "    - child one", "", "    - child two", "", "", "  - child three", "- sibling"]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.lines).toEqual(["- parent", "    - child one", "", "    - child two", "", "", "  - child three"]);
    expect(parsed[1]?.blockTags).toEqual(["alpha"]);
  });

  it("treats whitespace-only lines as blank", () => {
    const parsed = section(["@alpha", "- one", " \t ", "- two"]);
    expect(parsed.map((unit) => unit.blockTags)).toEqual([["alpha"], []]);
  });

  it("treats two-space indents as nested", () => {
    expect(section(["- parent", "  - nested", "  - nested again"])[0]?.lines).toHaveLength(3);
  });

  it("starts a new tag context at a tag line in the middle of a block", () => {
    const parsed = section(["@alpha", "- first", "@beta", "> quote after the tag", "- second"]);
    expect(parsed.map((unit) => [unit.text, unit.blockTags])).toEqual([
      ["- first", ["alpha"]],
      ["> quote after the tag", ["beta"]],
      ["- second", ["beta"]],
    ]);
  });

  it("merges consecutive tag lines", () => {
    expect(section(["@alpha", "@beta @alpha", "- item"])[0]?.blockTags).toEqual(["alpha", "beta"]);
  });

  it("treats an indented @tag line under a bullet as content", () => {
    const parsed = section(["@alpha", "- item", "    @beta"]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.lines).toEqual(["- item", "    @beta"]);
    expect(parsed[0]?.blockTags).toEqual(["alpha"]);
  });

  it("accepts an indented tag line at the start of a block", () => {
    expect(section(["  @alpha", "- item"])[0]?.blockTags).toEqual(["alpha"]);
  });

  it("treats a person mention line as content, not a tag line", () => {
    const parsed = section(["@alpha", "- @Sam: Should we import that table?"]);
    expect(parsed[0]?.blockTags).toEqual(["alpha"]);
    expect(parsed[0]?.inlineTags).toEqual([]);
  });

  it("recognizes every list marker at indent 0", () => {
    const parsed = section(["- dash", "* star", "+ plus", "1. one", "2) two", " - one space"]);
    expect(parsed.map((unit) => unit.text)).toEqual(["- dash", "* star", "+ plus", "1. one", "2) two", " - one space"]);
  });

  it("drops empty list items and keeps numbering of real units contiguous", () => {
    const parsed = section(["- first", "-", "- ", "3.", "* \t", "- last"]);
    expect(parsed.map((unit) => [unit.index, unit.text])).toEqual([
      [0, "- first"],
      [1, "- last"],
    ]);
  });

  it("keeps an empty bullet that has nested content", () => {
    expect(section(["-", "    - nested detail"])[0]?.lines).toEqual(["-", "    - nested detail"]);
  });

  it("does not treat emphasis or rules as list items", () => {
    const parsed = section(["- item", "**bold continuation**", "---", "+1 from me"]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.lines).toHaveLength(4);
  });
});

describe("parseNoteUnits continuations", () => {
  it("attaches indent-0 quotes to the previous bullet", () => {
    const parsed = section([
      "@alpha",
      "- Kickoff notes:",
      "    - Source of truth is tough",
      "> FADE PROJECT: not needed",
      "- Next bullet",
      "> READY FOR DEPLOY",
    ]);
    expect(parsed.map((unit) => unit.lines)).toEqual([
      ["- Kickoff notes:", "    - Source of truth is tough", "> FADE PROJECT: not needed"],
      ["- Next bullet", "> READY FOR DEPLOY"],
    ]);
  });

  it("makes a leading quote its own paragraph unit", () => {
    const parsed = section(["> DEPLOY TO DEV", "- Waiting on the green check", "> DONE"]);
    expect(parsed.map((unit) => unit.lines)).toEqual([["> DEPLOY TO DEV"], ["- Waiting on the green check", "> DONE"]]);
  });

  it("groups indent-0 plain lines into a paragraph unit", () => {
    const parsed = section(["First plain line", "second plain line", "- a bullet", "plain continuation"]);
    expect(parsed.map((unit) => unit.lines)).toEqual([
      ["First plain line", "second plain line"],
      ["- a bullet", "plain continuation"],
    ]);
  });

  it("makes an indented line with no previous unit its own unit", () => {
    expect(section(["    indented start", "- bullet"]).map((unit) => unit.text)).toEqual(["    indented start", "- bullet"]);
  });

  it("attaches indent-0 fenced code, including blank lines, to the previous bullet", () => {
    const parsed = section([
      "@alpha",
      "- commands ran:",
      "```zsh",
      "  export TAG=demo",
      "",
      "  tool generate --tag=\"$TAG\" \\",
      "    --days=3",
      "```",
      "```python",
      "import json",
      "",
      "",
      "print(json.dumps({}))",
      "```",
      "",
      "- next unit",
    ]);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]?.lines).toHaveLength(13);
    expect(parsed[0]?.lines.at(-1)).toBe("```");
    expect(parsed[1]?.blockTags).toEqual([]);
  });

  it("keeps blank lines inside a fence nested in a list item", () => {
    const parsed = section([
      "- Double checking:",
      "    - They ran:",
      "        ```bash",
      "        tool generate --days=1",
      "",
      "        tool ingest --file=out.jsonl",
      "        ```",
      "- Checking correctness",
      "    ```sql",
      "    SELECT 1;",
      "",
      "    ```",
    ]);
    expect(parsed.map((unit) => unit.lines.length)).toEqual([7, 5]);
  });

  it("does not split on headings or list markers inside a fence", () => {
    const parsed = section(["- run:", "```", "# not a heading", "- not a unit", "@not-a-tag", "```", "- real unit"]);
    expect(parsed.map((unit) => unit.lines[0])).toEqual(["- run:", "- real unit"]);
    expect(parsed[0]?.blockTags).toEqual([]);
  });

  it("supports tilde fences and longer closing fences", () => {
    const parsed = section(["- a", "~~~", "```", "", "~~~~", "- b"]);
    expect(parsed.map((unit) => unit.lines)).toEqual([["- a", "~~~", "```", "", "~~~~"], ["- b"]]);
  });

  it("treats a fence opened on a list item line as code", () => {
    const parsed = section(["- ```bash", "  echo one", "", "  echo two", "  ```", "- b"]);
    expect(parsed.map((unit) => unit.lines[0])).toEqual(["- ```bash", "- b"]);
  });

  it("is not fooled by inline triple backticks", () => {
    const parsed = section(["```inline``` code", "", "- next"]);
    expect(parsed.map((unit) => unit.text)).toEqual(["```inline``` code", "- next"]);
  });

  it("does not open a fence whose info string holds a line separator", () => {
    const parsed = section(["```js\u2028x", "- b", "```"]);
    expect(parsed.map((unit) => unit.text)).toEqual(["```js\u2028x", "- b\n```"]);
  });

  it("lets an unclosed fence run to the end of the section", () => {
    const parsed = section(["- a", "```", "", "- inside", "", "@inside"]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.lines).toEqual(["- a", "```", "", "- inside", "", "@inside"]);
  });

  it("keeps a fenced block at the start of a block as its own unit", () => {
    const parsed = section(["```", "code", "", "more", "```", "- after"]);
    expect(parsed.map((unit) => unit.lines)).toEqual([["```", "code", "", "more", "```"], ["- after"]]);
  });

  it("keeps an unfenced diagram with its bullet", () => {
    const parsed = section(["@alpha", "- Flow:", "[ User ]", "   │", "   ▼ Input endpoint", "[ Push Server ]", "- Summary"]);
    expect(parsed.map((unit) => unit.lines.length)).toEqual([5, 1]);
  });

  it("trims trailing whitespace but keeps indentation", () => {
    const parsed = section(["- item   ", "    - child\t", "```", "\t", "  code  ", "```"]);
    expect(parsed[0]?.lines).toEqual(["- item", "    - child", "```", "", "  code", "```"]);
  });

  it("handles tab indentation", () => {
    const parsed = section(["- item", "\t- tab child", "", "\t- after blank"]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.lines).toHaveLength(4);
  });

  it("parses CRLF notes", () => {
    const parsed = units("### NOTES\r\n@alpha\r\n- one\r\n    - child\r\n\r\n- two\r\n");
    expect(parsed.map((unit) => [unit.lines, unit.blockTags])).toEqual([
      [["- one", "    - child"], ["alpha"]],
      [["- two"], []],
    ]);
  });
});

describe("parseNoteUnits inline tags and skip", () => {
  const known: ReadonlySet<string> = new Set(["widget-launch", "Spam", "@Rate-Limits"]);

  it("finds only inline tags that exactly match known tags or aliases", () => {
    const parsed = section(["- Ask @George and @widget-launch-v2 about @widget-launch, then @spam: and @rate-limits."], known);
    expect(parsed[0]?.inlineTags).toEqual(["widget-launch", "spam", "rate-limits"]);
  });

  it("matches inline tags case-insensitively", () => {
    expect(section(["- see @Widget-Launch"], known)[0]?.inlineTags).toEqual(["widget-launch"]);
  });

  it("ignores emails, URLs and inline code", () => {
    const parsed = section(
      ["- mail ops@spam or https://host/@spam/path, `@widget-launch` too", "```", "@spam", "```", "@@spam"],
      known,
    );
    expect(parsed[0]?.inlineTags).toEqual([]);
  });

  it("ignores tags inside inline code of any backtick length", () => {
    expect(section(["- ``@spam`` and ``` `@widget-launch` ``` but @rate-limits"], known)[0]?.inlineTags).toEqual(["rate-limits"]);
  });

  it("combines block and inline tags without duplicates", () => {
    const parsed = section(["@widget-launch", "- also @spam and @widget-launch"], known);
    expect(parsed[0]?.blockTags).toEqual(["widget-launch"]);
    expect(parsed[0]?.inlineTags).toEqual(["spam", "widget-launch"]);
    expect(parsed[0]?.tags).toEqual(["widget-launch", "spam"]);
  });

  it("finds inline tags in nested lines and quotes", () => {
    expect(section(["- parent", "    - ask about @spam", "> and @rate-limits"], known)[0]?.inlineTags).toEqual(["spam", "rate-limits"]);
  });

  it("skips units in a block tagged @skip", () => {
    const parsed = section(["@skip", "- private", "- also private", "", "- public"]);
    expect(parsed.map((unit) => unit.skip)).toEqual([true, true, false]);
    expect(parsed[0]?.tags).toEqual(["skip"]);
  });

  it("skips a unit with an inline @skip even when skip is not a known tag", () => {
    const parsed = section(["- keep this out @skip", "- keep this"]);
    expect(parsed.map((unit) => [unit.skip, unit.inlineTags])).toEqual([
      [true, ["skip"]],
      [false, []],
    ]);
  });

  it("does not skip for @skip inside code", () => {
    expect(section(["- run `@skip` flag"])[0]?.skip).toBe(false);
  });

  it("skips with @skip alongside other block tags", () => {
    expect(section(["@alpha @skip", "- item"])[0]?.skip).toBe(true);
  });
});

describe("parseNoteUnits links and images", () => {
  it("extracts [[links]] with headings and labels", () => {
    const parsed = section([
      "- See [[Rate limits#Global token]] and [[Widget launch|the launch]]",
      "    - Also [[rate limits # global token]] and [[  Spaced  ]] and [[Docs#]]",
    ]);
    expect(parsed[0]?.explicitLinks).toEqual([
      { target: "Rate limits", heading: "Global token" },
      { target: "Widget launch", heading: null },
      { target: "Spaced", heading: null },
      { target: "Docs", heading: null },
    ]);
  });

  it("reads a table-escaped label pipe", () => {
    expect(section(["| [[Rate limits\\|limits]] | [[Docs#Setup\\|setup]] |"])[0]?.explicitLinks).toEqual([
      { target: "Rate limits", heading: null },
      { target: "Docs", heading: "Setup" },
    ]);
  });

  it("ignores embeds, markdown links in brackets, empty targets and code", () => {
    const parsed = section([
      "- Approve [[LINK](https://github.com/org/repo/pull/1)] and ![[diagram.png]]",
      "- [[#Only heading]] [[ ]] `[[In code]]`",
      "```",
      "[[In fence]]",
      "```",
    ]);
    expect(parsed.map((unit) => unit.explicitLinks)).toEqual([[], []]);
  });

  it("extracts image paths", () => {
    const parsed = section([
      "- proof: ![proof](./photos/proof.png)",
      "    ![photo](../../Projects/demo/photos/a.png)",
      "> My table looks like ![photo](../photos/b.png \"Table\") here",
      "- ![spaced](<my photo.png>) ![web](https://cdn.host.test/x.png) ![data](data:image/png;base64,AAAA)",
      "- ![dup](./photos/proof.png) ![abs](/Users/me/Notes/photos/c.png)",
    ]);
    expect(parsed.map((unit) => unit.images)).toEqual([
      ["./photos/proof.png", "../../Projects/demo/photos/a.png", "../photos/b.png"],
      ["my photo.png"],
      ["./photos/proof.png", "/Users/me/Notes/photos/c.png"],
    ]);
  });

  it("keeps balanced parentheses in image paths", () => {
    const parsed = section(["- ![a](photo(1).png) ![b](<copy (2).png>) ![c](d(e).png \"Title\") ![bad](x(.png)"]);
    expect(parsed[0]?.images).toEqual(["photo(1).png", "copy (2).png", "d(e).png"]);
  });

  it("reads every title style, targets split across lines, and needs a non-empty target", () => {
    const parsed = section(["- ![a](x.png 'T') ![b](y.png (T)) ![c](", "  z.png", ") ![e](f.png", "\"T\")"]);
    expect(parsed[0]?.images).toEqual(["x.png", "y.png", "z.png", "f.png"]);
    expect(section(["- ![![a](x.png)](y.png) ![](<>) ![]()"])[0]?.images).toEqual(["x.png"]);
  });

  it("dedupes images within a unit and ignores images in code", () => {
    const parsed = section(["- ![a](x.png) ![b](x.png) `![c](y.png)`", "```", "![d](z.png)", "```"]);
    expect(parsed[0]?.images).toEqual(["x.png"]);
  });
});

describe("unit hashes", () => {
  it("hashes the whitespace-normalized text with sha256", () => {
    const unit = section(["- item", "    - child"])[0];
    expect(unit?.hash).toBe(sha256("- item\n- child"));
    expect(unit?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across indentation, trailing spaces and blank runs", () => {
    const a = section(["- item", "    - child", "", "", "", "    - more"])[0];
    const b = section(["- item  ", "  - child", "", "  - more"])[0];
    expect(a?.hash).toBe(b?.hash);
    expect(a?.text).not.toBe(b?.text);
  });

  it("differs when the words differ", () => {
    expect(section(["- item one"])[0]?.hash).not.toBe(section(["- item two"])[0]?.hash);
  });

  it("does not depend on tags or position", () => {
    const tagged = section(["@alpha", "- same text"])[0];
    const later = section(["- other", "", "- same text"])[1];
    expect(tagged?.hash).toBe(later?.hash);
  });

  it("normalizes whitespace", () => {
    expect(normalizeWhitespace("\n\n  a  \n\n\n\t b\n \n")).toBe("a\n\nb");
    expect(normalizeWhitespace("a\r\n\r\n\r\nb")).toBe("a\n\nb");
    expect(normalizeWhitespace("   ")).toBe("");
    expect(hashUnitText("  a\n\n\nb ")).toBe(sha256("a\n\nb"));
  });
});
