import { HighlightStyle } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { markdownScope, scopedHighlighting } from "./code-languages.js";
import { highlightTag } from "./syntax.js";

export const markdownHighlightStyle: HighlightStyle = HighlightStyle.define([
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "600" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
  { tag: highlightTag, class: "cm-lp-highlight" },
  {
    tag: [
      tags.processingInstruction,
      tags.labelName,
      tags.contentSeparator,
      tags.escape,
    ],
    color: "var(--subtle-foreground)",
  },
  { tag: [tags.url, tags.meta], color: "var(--muted-foreground)" },
  { tag: tags.comment, color: "var(--subtle-foreground)" },
]);

export interface LivePreviewThemeOptions {
  fontSize?: string;
  scroll?: "page" | "self";
  maxWidth?: string | null;
}

const SHADOW = "var(--shadow-lg)";
const LINK_UNDERLINE = "color-mix(in oklab, currentColor 35%, transparent)";
const INNER_RADIUS = "calc(var(--radius) - 2px)";

export function livePreviewTheme(
  options: LivePreviewThemeOptions = {},
): Extension {
  const fontSize = options.fontSize ?? "var(--text-base)";
  const page = (options.scroll ?? "self") === "page";
  const maxWidth = options.maxWidth === undefined ? "46rem" : options.maxWidth;
  const contentWidth: Record<string, string> =
    page || maxWidth === null
      ? {}
      : {
          maxWidth: `calc(${maxWidth} + 5rem)`,
          marginLeft: "auto",
          marginRight: "auto",
          width: "100%",
        };
  return [
    EditorView.theme({
      "&": {
        color: "var(--foreground)",
        backgroundColor: "transparent",
        fontSize,
        ...(page ? { height: "auto" } : { height: "100%" }),
      },
      "&.cm-focused": { outline: "none" },
      ".cm-scroller": {
        fontFamily: "var(--font-sans)",
        lineHeight: "1.7",
        ...(page ? { overflow: "visible" } : { overflow: "auto" }),
      },
      ".cm-content": {
        caretColor: "var(--foreground)",
        padding: page ? "0.25rem 0 3rem" : "2.5rem 2.5rem 40vh",
        ...contentWidth,
      },
      ".cm-line": { padding: "0 2px" },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--foreground)",
        borderLeftWidth: "1.5px",
      },
      "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
        {
          backgroundColor: "var(--surface-selected)",
        },
      ".cm-selectionBackground": {
        backgroundColor:
          "color-mix(in oklab, var(--surface-selected) 60%, transparent)",
      },
      ".cm-content ::selection": { backgroundColor: "var(--surface-selected)" },
      ".cm-gutters": {
        backgroundColor: "transparent",
        border: "none",
        color: "var(--subtle-foreground)",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "transparent",
        color: "var(--muted-foreground)",
      },
      ".cm-lp-heading": { color: "var(--foreground)", lineHeight: "1.35" },
      ".cm-lp-h1": {
        fontSize: "1.75em",
        fontWeight: "700",
        paddingTop: "0.6em",
        paddingBottom: "0.1em",
      },
      ".cm-lp-h2": {
        fontSize: "1.4em",
        fontWeight: "650",
        paddingTop: "0.6em",
        paddingBottom: "0.05em",
      },
      ".cm-lp-h3": {
        fontSize: "1.2em",
        fontWeight: "600",
        paddingTop: "0.6em",
      },
      ".cm-lp-h4": {
        fontSize: "1.05em",
        fontWeight: "600",
        paddingTop: "0.3em",
      },
      ".cm-lp-h5": {
        fontSize: "1em",
        fontWeight: "600",
        color: "var(--muted-foreground)",
      },
      ".cm-lp-h6": {
        fontSize: "0.9em",
        fontWeight: "600",
        color: "var(--muted-foreground)",
        textTransform: "uppercase",
        letterSpacing: "0.03em",
      },
      ".cm-lp-setext-mark": {
        fontSize: "var(--text-xs)",
        color: "var(--subtle-foreground)",
        lineHeight: "1.2",
      },
      ".cm-lp-highlight": {
        backgroundColor:
          "color-mix(in oklab, var(--attention) 38%, transparent)",
        borderRadius: "0.2em",
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
        padding: "0 0.1em",
      },
      ".cm-lp-inline-code": {
        fontFamily: "var(--font-mono)",
        fontSize: "0.85em",
        backgroundColor: "var(--muted)",
        borderRadius: "0.3em",
        padding: "0.1em 0.3em",
      },
      ".cm-lp-link, .cm-lp-url": {
        textDecorationLine: "underline",
        textDecorationColor: LINK_UNDERLINE,
        textUnderlineOffset: "2px",
        cursor: "pointer",
      },
      ".cm-lp-link:hover, .cm-lp-url:hover": {
        textDecorationColor: "currentColor",
      },
      ".cm-lp-url": { overflowWrap: "anywhere" },
      ".cm-lp-codeblock": {
        fontFamily: "var(--font-mono)",
        fontSize: "0.85em",
        lineHeight: "1.6",
        backgroundColor: "var(--surface-recessed)",
        paddingLeft: "1em",
        paddingRight: "1em",
      },
      ".cm-lp-codeblock-first": {
        borderTopLeftRadius: "var(--radius)",
        borderTopRightRadius: "var(--radius)",
        paddingTop: "0.35em",
      },
      ".cm-lp-codeblock-last": {
        borderBottomLeftRadius: "var(--radius)",
        borderBottomRightRadius: "var(--radius)",
        paddingBottom: "0.35em",
      },
      ".cm-lp-code-label": {
        display: "inline-block",
        width: "100%",
        textAlign: "right",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-2xs)",
        lineHeight: "1.4",
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        color: "var(--muted-foreground)",
        verticalAlign: "top",
      },
      ".cm-lp-quote": {
        borderLeft: "2px solid var(--border)",
        paddingLeft: "1em",
        color: "var(--muted-foreground)",
      },
      ".cm-lp-quote-nested": {
        paddingLeft: "2em",
        backgroundImage: "linear-gradient(var(--border), var(--border))",
        backgroundSize: "2px 100%",
        backgroundPosition: "1em 0",
        backgroundRepeat: "no-repeat",
      },
      ".cm-lp-indent": { display: "inline-block" },
      ".cm-lp-bullet": {
        display: "inline-block",
        width: "1.1em",
        textAlign: "center",
        color: "var(--muted-foreground)",
      },
      ".cm-lp-list-mark": { color: "var(--muted-foreground)" },
      ".cm-lp-checkbox-wrap": {
        display: "inline-block",
        width: "1.4em",
        textAlign: "left",
      },
      ".cm-lp-checkbox": {
        accentColor: "var(--primary)",
        width: "0.95em",
        height: "0.95em",
        margin: "0",
        verticalAlign: "-0.1em",
        cursor: "pointer",
      },
      ".cm-lp-task-done": {
        color: "var(--muted-foreground)",
        textDecorationLine: "line-through",
      },
      ".cm-lp-hr": {
        display: "inline-block",
        width: "100%",
        height: "0",
        borderTop: "1px solid var(--border)",
        verticalAlign: "middle",
      },
      ".cm-lp-table-wrap": { overflowX: "auto", padding: "0.35em 2px" },
      ".cm-lp-table": {
        borderCollapse: "collapse",
        lineHeight: "1.5",
        fontSize: "0.95em",
      },
      ".cm-lp-table th, .cm-lp-table td": {
        border: "1px solid var(--border)",
        padding: "0.25em 0.6em",
        textAlign: "left",
        verticalAlign: "top",
        cursor: "text",
        minWidth: "3em",
      },
      ".cm-lp-table th": {
        backgroundColor: "var(--surface-recessed)",
        fontWeight: "600",
      },
      ".cm-lp-table-source": {
        fontFamily: "var(--font-mono)",
        fontSize: "0.85em",
      },
      ".cm-lp-media": {
        display: "inline-block",
        maxWidth: "100%",
        verticalAlign: "middle",
      },
      ".cm-lp-image": {
        display: "block",
        maxWidth: "100%",
        maxHeight: "max(24rem, 50vh)",
        borderRadius: "var(--radius)",
      },
      ".cm-lp-comment-line": {
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        color: "var(--subtle-foreground)",
      },
      ".cm-lp-frontmatter": {
        fontSize: "var(--text-xs)",
        lineHeight: "1.8",
        color: "var(--subtle-foreground)",
        cursor: "pointer",
        userSelect: "none",
        padding: "0 2px",
      },
      ".cm-lp-frontmatter:hover": { color: "var(--muted-foreground)" },
      ".cm-lp-frontmatter-line": {
        fontFamily: "var(--font-mono)",
        fontSize: "0.85em",
        color: "var(--muted-foreground)",
      },
      ".cm-lp-hint": {
        color: "color-mix(in oklab, var(--muted-foreground) 60%, transparent)",
        pointerEvents: "none",
        userSelect: "none",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        boxShadow: SHADOW,
      },
      ".cm-tooltip.cm-tooltip-autocomplete": {
        padding: "0.25rem",
        fontFamily: "var(--font-sans)",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        maxHeight: "20em",
        minWidth: "13em",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
        padding: "0.3rem 0.5rem",
        borderRadius: INNER_RADIUS,
        lineHeight: "1.4",
      },
      ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--state-active)",
        color: "var(--foreground)",
      },
      ".cm-completionDetail": {
        color: "var(--subtle-foreground)",
        fontStyle: "normal",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--text-xs)",
        marginLeft: "1.5em",
        float: "right",
      },
      ".cm-completionMatchedText": {
        textDecoration: "none",
        fontWeight: "600",
      },
      ".cm-tooltip.cm-lp-toolbar": {
        display: "flex",
        alignItems: "center",
        gap: "2px",
        padding: "3px",
      },
      ".cm-lp-toolbar-button": {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        position: "relative",
        width: "28px",
        height: "28px",
        padding: "0",
        border: "none",
        borderRadius: INNER_RADIUS,
        backgroundColor: "transparent",
        color: "inherit",
        cursor: "pointer",
      },
      ".cm-lp-toolbar-button:hover": { backgroundColor: "var(--state-hover)" },
      ".cm-lp-toolbar-button[aria-pressed='true']": {
        backgroundColor: "var(--state-active)",
      },
      ".cm-lp-toolbar-button:focus-visible": {
        outline: "2px solid var(--ring)",
        outlineOffset: "-2px",
      },
      ".cm-lp-toolbar-highlight svg": { marginBottom: "3px" },
      ".cm-lp-toolbar-swatch": {
        position: "absolute",
        left: "8px",
        right: "8px",
        bottom: "4px",
        height: "3px",
        borderRadius: "2px",
        backgroundColor: "var(--attention)",
      },
      ".cm-lp-toolbar-divider": {
        width: "1px",
        alignSelf: "stretch",
        margin: "3px 2px",
        backgroundColor: "var(--border)",
      },
      ".cm-panels": {
        backgroundColor: "var(--popover)",
        color: "var(--popover-foreground)",
      },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--border)" },
      ".cm-panels.cm-panels-bottom": { borderTop: "1px solid var(--border)" },
      ".cm-search": {
        fontFamily: "var(--font-sans)",
        fontSize: "var(--text-sm)",
        padding: "0.35rem 0.5rem",
      },
      ".cm-search label": {
        fontSize: "var(--text-xs)",
        color: "var(--muted-foreground)",
      },
      ".cm-textfield": {
        backgroundColor: "transparent",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        borderRadius: INNER_RADIUS,
        fontSize: "var(--text-sm)",
        padding: "0.15rem 0.4rem",
      },
      ".cm-textfield:focus": {
        outline: "2px solid var(--ring)",
        outlineOffset: "-1px",
      },
      ".cm-button": {
        backgroundImage: "none",
        backgroundColor: "var(--muted)",
        color: "var(--foreground)",
        border: "1px solid var(--border)",
        borderRadius: INNER_RADIUS,
        fontSize: "var(--text-xs)",
        padding: "0.15rem 0.5rem",
      },
      ".cm-button:active": {
        backgroundImage: "none",
        backgroundColor: "var(--state-active)",
      },
      ".cm-searchMatch": {
        backgroundColor: "var(--state-active)",
        outline: "1px solid var(--border)",
        borderRadius: "2px",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklab, var(--ring) 22%, transparent)",
        outline: "2px solid var(--ring)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--muted)",
        border: "none",
        color: "var(--muted-foreground)",
        padding: "0 0.4em",
        borderRadius: "0.3em",
      },
    }),
    scopedHighlighting(markdownHighlightStyle, markdownScope),
  ];
}
