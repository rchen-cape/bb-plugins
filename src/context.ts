import type { ContextMode, Handoff, NodeKind } from "./model.js";

export interface SourceImage {
  /** What the document calls it, which is its alt text. */
  name: string;
  /** Its place in the prompt's attachment list, marked in the text. */
  number: number;
  absolutePath: string;
}

export interface ContextSource {
  nodeId: string;
  title: string;
  artifactFile: string;
  summary: string;
  artifact: string;
  handoff: Handoff;
  /** Only ever filled for a source whose whole document goes down. */
  images: readonly SourceImage[];
}

export interface AssembleContextArgs {
  nodeTitle: string;
  nodeKind: NodeKind;
  artifactFile: string;
  mode: ContextMode;
  customBrief: string;
  instruction: string;
  sources: readonly ContextSource[];
}

const NO_SUMMARY = "_No summary was recorded for this task._";
const NO_ARTIFACT = "_This task has no saved output._";

function sourceSection(source: ContextSource): string {
  if (source.handoff === "full") {
    const body = source.artifact.trim();
    return [
      `### Context from ${source.title} (${source.artifactFile}, full output)`,
      body.length > 0 ? body : NO_ARTIFACT,
      /*
       * The pictures arrive as attachments, and the document above has a
       * numbered marker where each one sat, so the two can be lined up.
       */
      ...(source.images.length > 0
        ? [
            `The images attached to this message are the ones ${source.artifactFile} refers to: ${source.images
              .map((image) => `${image.number}, ${image.name}`)
              .join("; ")}. Each is marked in place above.`,
          ]
        : []),
    ].join("\n\n");
  }
  const body = source.summary.trim();
  return [
    `### Context from ${source.title} (summary)`,
    body.length > 0 ? body : NO_SUMMARY,
  ].join("\n\n");
}

export function assembleContext(args: AssembleContextArgs): string {
  const blocks: string[] = [`# ${args.nodeTitle}`];

  if (args.mode === "custom") {
    const brief = args.customBrief.trim();
    if (brief.length > 0) {
      blocks.push(
        ["## What this task needs from upstream", brief].join("\n\n"),
      );
    }
  }

  if (args.sources.length === 0) {
    blocks.push(
      ["## Upstream context", "_This task has no upstream dependencies._"].join(
        "\n\n",
      ),
    );
  } else {
    blocks.push("## Upstream context");
    for (const source of args.sources) {
      blocks.push(sourceSection(source));
    }
  }

  const instruction = args.instruction.trim();
  blocks.push(
    [
      "## Task",
      instruction.length > 0
        ? instruction
        : "_No instruction was written for this task yet._",
    ].join("\n\n"),
  );

  if (args.nodeKind === "agent") {
    blocks.push(
      [
        "## Deliverable",
        `Work in this thread as long as you need. When the work is finished, post the deliverable itself as your final message — Trees saves that message verbatim to \`${args.artifactFile}\` and passes it to the tasks that depend on this one. Do not end with a status report about the work; end with the work.`,
      ].join("\n\n"),
    );
  }

  return `${blocks.join("\n\n")}\n`;
}

/*
 * A thread that is already running has read its context once. This arrives in
 * the middle of that conversation, so it says what it is before it says it,
 * and says which of the two the agent should believe.
 */
export function additionalContextPrompt(args: { context: string }): string {
  return [
    "Here is additional context to help you ground your answer. It comes from the tasks this one depends on, and replaces the context you were given earlier.",
    "",
    args.context,
  ].join("\n");
}

export const SUMMARY_WORD_LIMIT = 200;

export function summaryRequestPrompt(args: { title: string }): string {
  return [
    `Write the summary spec for "${args.title}".`,
    "",
    `Downstream tasks in this project receive only this summary, not the full output. In at most ${SUMMARY_WORD_LIMIT} words, record the decisions, constraints, names, and interfaces a later task would be wrong without. Leave out process narration, restated requirements, and anything a reader could regenerate from the decisions you list.`,
    "",
    "Reply with the summary text and nothing else — no preamble, no heading, no code fence.",
  ].join("\n");
}

export function markdownSummaryPrompt(args: {
  title: string;
  artifact: string;
}): string {
  return [
    `Summarize the document below, which is the finished output of a task called "${args.title}".`,
    "",
    `Downstream tasks receive only your summary, not this document. In at most ${SUMMARY_WORD_LIMIT} words, record the decisions, constraints, names, and interfaces a later task would be wrong without.`,
    "",
    "Reply with the summary text and nothing else — no preamble, no heading, no code fence.",
    "",
    "---",
    "",
    args.artifact,
  ].join("\n");
}
