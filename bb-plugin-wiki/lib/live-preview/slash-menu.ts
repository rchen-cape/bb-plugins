import {
  pickedCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
} from "@codemirror/autocomplete";
import {
  ChangeSet,
  EditorSelection,
  type EditorState,
  type TransactionSpec,
} from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { insertTableSpec, setBlockSpec, type BlockKind } from "./commands.js";
import { isInsideCode } from "./decorations.js";

export type SlashAction = BlockKind | "table";

export interface SlashCommand {
  readonly label: string;
  readonly action: SlashAction;
  readonly aliases: readonly string[];
  readonly detail?: string;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { label: "Text", action: "paragraph", aliases: ["paragraph", "plain", "p"] },
  { label: "Heading 1", action: "h1", aliases: ["h1", "title"], detail: "#" },
  {
    label: "Heading 2",
    action: "h2",
    aliases: ["h2", "subtitle"],
    detail: "##",
  },
  { label: "Heading 3", action: "h3", aliases: ["h3"], detail: "###" },
  {
    label: "Bulleted list",
    action: "bullet",
    aliases: ["ul", "bullet", "unordered"],
    detail: "-",
  },
  {
    label: "Numbered list",
    action: "ordered",
    aliases: ["ol", "ordered", "number"],
    detail: "1.",
  },
  {
    label: "To-do list",
    action: "task",
    aliases: ["todo", "checkbox", "task", "check"],
    detail: "[ ]",
  },
  {
    label: "Quote",
    action: "quote",
    aliases: ["blockquote", "citation"],
    detail: ">",
  },
  {
    label: "Code block",
    action: "code",
    aliases: ["codeblock", "code", "fence", "pre"],
    detail: "```",
  },
  {
    label: "Divider",
    action: "divider",
    aliases: ["hr", "rule", "separator", "line"],
    detail: "---",
  },
  { label: "Table", action: "table", aliases: ["grid", "columns"] },
];

const SLASH_PATTERN = /^(\s*)\/([a-z0-9 ]*)$/i;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

export function slashCommandMatches(
  command: SlashCommand,
  query: string,
): boolean {
  const wanted = words(query);
  if (wanted.length === 0) return true;
  const available = [
    ...words(command.label),
    ...command.aliases.flatMap(words),
  ];
  const joined = words(command.label).join("");
  return wanted.every(
    (word) =>
      available.some((candidate) => candidate.startsWith(word)) ||
      joined.startsWith(wanted.join("")),
  );
}

export function filterSlashCommands(query: string): SlashCommand[] {
  return SLASH_COMMANDS.filter((command) =>
    slashCommandMatches(command, query),
  );
}

export function slashQueryAt(
  state: EditorState,
  pos: number,
): { from: number; query: string } | null {
  const line = state.doc.lineAt(pos);
  const before = state.doc.sliceString(line.from, pos);
  const match = SLASH_PATTERN.exec(before);
  if (match === null) return null;
  if (isInsideCode(state, pos)) return null;
  const indent = match[1] ?? "";
  return { from: line.from + indent.length, query: match[2] ?? "" };
}

export function slashApplySpec(
  state: EditorState,
  action: SlashAction,
  from: number,
  to: number,
): TransactionSpec {
  const removal = ChangeSet.of([{ from, to }], state.doc.length);
  const afterRemoval = state.update({
    changes: removal,
    selection: EditorSelection.cursor(removal.mapPos(from, -1)),
  }).state;
  const block =
    action === "table"
      ? insertTableSpec(afterRemoval)
      : setBlockSpec(afterRemoval, action);
  return {
    changes: removal.compose(block.changes),
    selection: block.selection,
    scrollIntoView: true,
  };
}

function toCompletion(command: SlashCommand): Completion {
  return {
    label: command.label,
    ...(command.detail === undefined ? {} : { detail: command.detail }),
    type: "text",
    apply: (
      view: EditorView,
      completion: Completion,
      from: number,
      to: number,
    ) => {
      const spec = slashApplySpec(view.state, command.action, from, to);
      view.dispatch({
        ...spec,
        annotations: pickedCompletion.of(completion),
        userEvent: "input.complete",
      });
    },
  };
}

export const slashCommandSource: CompletionSource = (
  context: CompletionContext,
): CompletionResult | null => {
  const found = slashQueryAt(context.state, context.pos);
  if (found === null) return null;
  const options = filterSlashCommands(found.query).map(toCompletion);
  if (options.length === 0) return null;
  return { from: found.from, to: context.pos, options, filter: false };
};
