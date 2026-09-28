import { describe, expect, it } from "vitest";
import { assembleContext, type ContextSource } from "./context";

function source(overrides: Partial<ContextSource> = {}): ContextSource {
  return {
    nodeId: "trn_1",
    title: "User research",
    artifactFile: "01_user_research.md",
    summary: "Users need OAuth2 with Google and GitHub.",
    artifact: "# User research\n\nLong findings.",
    handoff: "summary",
    images: [],
    ...overrides,
  };
}

const base = {
  nodeTitle: "Generate API design specs",
  nodeKind: "agent" as const,
  artifactFile: "02_api_design.md",
  customBrief: "",
  instruction: "Generate the OpenAPI schema for the auth routes.",
};

describe("assembleContext", () => {
  it("passes only summaries under auto-compact", () => {
    const prompt = assembleContext({
      ...base,
      mode: "auto_compact",
      sources: [source()],
    });
    expect(prompt).toContain("### Context from User research (summary)");
    expect(prompt).toContain("Users need OAuth2");
    expect(prompt).not.toContain("Long findings.");
  });

  it("passes full output, named by file, under full parents", () => {
    const prompt = assembleContext({
      ...base,
      mode: "full_parents",
      sources: [source()],
    });
    expect(prompt).toContain(
      "### Context from User research (01_user_research.md, full output)",
    );
    expect(prompt).toContain("Long findings.");
  });

  /*
   * The pictures arrive as their own prompt parts, so the text has to say
   * which is which — otherwise a document mentioning three screenshots gets
   * three unlabelled images after it.
   */
  it("names the images that travel with a document it sends", () => {
    const prompt = assembleContext({
      ...base,
      mode: "full_parents",
      sources: [
        source({
          images: [
            { name: "the login screen", absolutePath: "/t/assets/a.png" },
            { name: "the error state", absolutePath: "/t/assets/b.png" },
          ],
        }),
      ],
    });
    expect(prompt).toContain(
      "The images attached to this message are, in order, the ones 01_user_research.md refers to: the login screen, the error state.",
    );
  });

  it("says nothing about images when only the summary goes", () => {
    const prompt = assembleContext({
      ...base,
      mode: "auto_compact",
      sources: [
        source({
          images: [{ name: "the login screen", absolutePath: "/t/a.png" }],
        }),
      ],
    });
    expect(prompt).not.toContain("images attached");
  });

  it("labels each parent separately so a merge task can tell them apart", () => {
    const prompt = assembleContext({
      ...base,
      mode: "auto_compact",
      sources: [
        source({ nodeId: "trn_1", title: "User research" }),
        source({
          nodeId: "trn_2",
          title: "Spec doc",
          summary: "Endpoints are versioned under /v2.",
        }),
      ],
    });
    expect(prompt).toContain("### Context from User research (summary)");
    expect(prompt).toContain("### Context from Spec doc (summary)");
    expect(prompt.indexOf("User research")).toBeLessThan(
      prompt.indexOf("Spec doc"),
    );
  });

  it("says so rather than going silent when a parent has no summary", () => {
    const prompt = assembleContext({
      ...base,
      mode: "auto_compact",
      sources: [source({ summary: "   " })],
    });
    expect(prompt).toContain("_No summary was recorded for this task._");
  });

  it("says so rather than going silent when a parent has no output", () => {
    const prompt = assembleContext({
      ...base,
      mode: "full_parents",
      sources: [source({ artifact: "" })],
    });
    expect(prompt).toContain("_This task has no saved output._");
  });

  it("leads with the custom brief in custom mode", () => {
    const prompt = assembleContext({
      ...base,
      mode: "custom",
      customBrief: "Carry down only the chosen auth providers.",
      sources: [source()],
    });
    expect(prompt).toContain("## What this task needs from upstream");
    expect(prompt.indexOf("Carry down only")).toBeLessThan(
      prompt.indexOf("### Context from"),
    );
  });

  it("ignores the brief outside custom mode", () => {
    const prompt = assembleContext({
      ...base,
      mode: "auto_compact",
      customBrief: "Should not appear.",
      sources: [source()],
    });
    expect(prompt).not.toContain("Should not appear.");
  });

  it("states that a root task has no upstream context", () => {
    const prompt = assembleContext({
      ...base,
      mode: "auto_compact",
      sources: [],
    });
    expect(prompt).toContain("_This task has no upstream dependencies._");
  });

  it("gives an agent task the artifact contract naming its own file", () => {
    const prompt = assembleContext({
      ...base,
      mode: "auto_compact",
      sources: [],
    });
    expect(prompt).toContain("## Deliverable");
    expect(prompt).toContain("`02_api_design.md`");
  });

  it("omits the deliverable contract for a note", () => {
    const prompt = assembleContext({
      ...base,
      nodeKind: "markdown",
      mode: "auto_compact",
      sources: [],
    });
    expect(prompt).not.toContain("## Deliverable");
  });

  it("flags a missing instruction instead of shipping an empty task block", () => {
    const prompt = assembleContext({
      ...base,
      instruction: "  ",
      mode: "auto_compact",
      sources: [],
    });
    expect(prompt).toContain("_No instruction was written for this task yet._");
  });
});

describe("a parent that hands over its whole document", () => {
  /*
   * The consumer's default is summaries, but a note whose exact wording
   * matters has no summary worth sending, so the producer's choice wins.
   */
  it("sends the document even when the reader only asked for summaries", () => {
    const prompt = assembleContext({
      nodeTitle: "Generate the schema",
      nodeKind: "agent",
      artifactFile: "02_schema.md",
      mode: "auto_compact",
      customBrief: "",
      instruction: "Build it.",
      sources: [source({ handoff: "full" })],
    });
    expect(prompt).toContain("Long findings.");
    expect(prompt).toContain("full output");
    expect(prompt).not.toContain("Users need OAuth2");
  });

  it("still sends a summary for a parent that keeps to one", () => {
    const prompt = assembleContext({
      nodeTitle: "Generate the schema",
      nodeKind: "agent",
      artifactFile: "02_schema.md",
      mode: "auto_compact",
      customBrief: "",
      instruction: "Build it.",
      sources: [source({ handoff: "summary" })],
    });
    expect(prompt).toContain("Users need OAuth2");
    expect(prompt).not.toContain("Long findings.");
  });

  it("carries the document into a custom brief's selection too", () => {
    const prompt = assembleContext({
      nodeTitle: "Generate the schema",
      nodeKind: "agent",
      artifactFile: "02_schema.md",
      mode: "custom",
      customBrief: "Only the auth decisions.",
      instruction: "Build it.",
      sources: [source({ handoff: "full" })],
    });
    expect(prompt).toContain("Only the auth decisions.");
    expect(prompt).toContain("Long findings.");
  });
});
