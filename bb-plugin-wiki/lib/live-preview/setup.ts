import { history } from "@codemirror/commands";
import { pasteURLAsLink } from "@codemirror/lang-markdown";
import { indentUnit } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  keymap,
} from "@codemirror/view";
import type { MarkdownExtension } from "@lezer/markdown";
import { editingKeymap, livePreviewKeymap } from "./commands.js";
import { previewState } from "./state.js";
import { markdownLanguageWith } from "./syntax.js";

export interface EditorBasicsOptions {
  ariaLabel: string;
  markdownExtensions?: readonly MarkdownExtension[];
  lineWrapping?: boolean;
}

export function editorBasics(options: EditorBasicsOptions): Extension {
  return [
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentUnit.of("  "),
    markdownLanguageWith(options.markdownExtensions ?? []),
    keymap.of([...livePreviewKeymap, ...editingKeymap()]),
    pasteURLAsLink,
    options.lineWrapping === false ? [] : EditorView.lineWrapping,
    EditorView.contentAttributes.of({
      "aria-label": options.ariaLabel,
      spellcheck: "true",
    }),
    EditorView.clickAddsSelectionRange.of((event) => event.altKey),
    previewState,
  ];
}
