import { describe, expect, it } from "vitest";
import { chunkMarkdownFile, coveredLines } from "./file-chunks";

function lines(count: number, prefix = "- item"): string[] {
  return Array.from({ length: count }, (_, index) => `${prefix} ${index}`);
}

describe("chunkMarkdownFile", () => {
  it("makes one chunk per heading section, keeps the heading path, and drops heading lines", () => {
    const content = ["---", "title: Go", "---", "# Go", "intro line", "", "## Build", "- go build ./...", "", "### Flags", "- -race", ""].join("\n");
    const chunks = chunkMarkdownFile(content);
    expect(chunks.map((chunk) => [chunk.headingPath.join(" > "), chunk.lines])).toEqual([
      ["Go", ["intro line"]],
      ["Go > Build", ["- go build ./..."]],
      ["Go > Build > Flags", ["- -race"]],
    ]);
    expect(coveredLines(content, chunks)).toEqual({ missing: [], duplicated: [] });
  });

  it("keeps text before the first heading as its own chunk with no heading path", () => {
    const chunks = chunkMarkdownFile("first\nsecond\n\n# Later\nbody\n");
    expect(chunks[0]).toMatchObject({ headingPath: [], lines: ["first", "second"] });
  });

  it("never treats a # line inside a code fence as a heading, including fences under bullets", () => {
    const content = ["## Run", "- Do this:", "    ```zsh", "    # not a heading", "", "    echo hi", "    ```", "- after", ""].join("\n");
    const chunks = chunkMarkdownFile(content);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.lines).toContain("    # not a heading");
    expect(coveredLines(content, chunks).missing).toEqual([]);
  });

  it("splits long sections only at top-level blocks and never inside a fence or table", () => {
    const fence = ["```", ...lines(30, "code"), "```"];
    const table = ["| a | b |", "| - | - |", ...lines(10, "| x |")];
    const content = ["## Big", ...lines(25), "", ...fence, "", ...table, "", ...lines(20, "- more")].join("\n");
    const chunks = chunkMarkdownFile(content, 40);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = chunk.lines.filter((line) => line.startsWith("```")).length;
      expect(fences % 2).toBe(0);
      const tableRows = chunk.lines.filter((line) => line.startsWith("|")).length;
      expect([0, table.length]).toContain(tableRows);
    }
    expect(coveredLines(content, chunks)).toEqual({ missing: [], duplicated: [] });
  });

  it("keeps a bullet with its nested children together when splitting", () => {
    const content = ["## List", ...Array.from({ length: 30 }, (_, index) => [`- parent ${index}`, `  - child ${index}`]).flat()].join("\n");
    const chunks = chunkMarkdownFile(content, 40);
    for (const chunk of chunks) {
      expect(chunk.lines[0]?.startsWith("- parent")).toBe(true);
      expect(chunk.lines.at(-1)?.startsWith("  - child")).toBe(true);
    }
    expect(coveredLines(content, chunks)).toEqual({ missing: [], duplicated: [] });
  });

  it("copies lines verbatim apart from trailing whitespace and ignores empty sections", () => {
    const chunks = chunkMarkdownFile("# A\n\n## B\n  - keep   indent  \n\t| tab |\n");
    expect(chunks).toEqual([{ headingPath: ["A", "B"], lines: ["  - keep   indent", "\t| tab |"], text: "  - keep   indent\n\t| tab |", startLine: 3 }]);
  });

  it("handles CRLF files", () => {
    const content = "# A\r\none\r\n\r\n# B\r\ntwo\r\n";
    expect(chunkMarkdownFile(content).map((chunk) => chunk.lines)).toEqual([["one"], ["two"]]);
  });
});
