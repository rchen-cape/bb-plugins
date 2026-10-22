import { ensureSyntaxTree } from "@codemirror/language";
import {
  EditorSelection,
  EditorState,
  type Extension,
} from "@codemirror/state";
import {
  previewStateField,
  setPointerSelecting,
  setPreviewFocus,
} from "./state.js";
import { markdownLanguageWith } from "./syntax.js";

export type SelectionInput =
  | number
  | readonly [number, number]
  | EditorSelection;

function toSelection(input: SelectionInput): EditorSelection {
  if (typeof input === "number") return EditorSelection.single(input);
  if (input instanceof EditorSelection) return input;
  return EditorSelection.single(input[0], input[1]);
}

export function parsedState(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 10_000);
  return state.update({}).state;
}

export function markdownState(
  doc: string,
  options: {
    selection?: SelectionInput;
    focused?: boolean;
    extensions?: Extension;
  } = {},
): EditorState {
  const created = EditorState.create({
    doc,
    selection: toSelection(options.selection ?? 0),
    extensions: [
      EditorState.allowMultipleSelections.of(true),
      markdownLanguageWith([]),
      previewStateField,
      options.extensions ?? [],
    ],
  });
  const parsed = parsedState(created);
  return options.focused === false
    ? parsed
    : parsed.update({ effects: setPreviewFocus.of(true) }).state;
}

export function withSelection(
  state: EditorState,
  selection: SelectionInput,
): EditorState {
  return state.update({ selection: toSelection(selection) }).state;
}

export function withPointer(state: EditorState, down: boolean): EditorState {
  return state.update({ effects: setPointerSelecting.of(down) }).state;
}
