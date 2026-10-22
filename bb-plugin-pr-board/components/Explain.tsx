import { useState } from "react";
import type { ExplainRequest, ExplainSource } from "../contract";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

export type ExplainTarget = Omit<ExplainRequest, "question">;

const MAX_QUOTE = 20_000;

/** Marks a part of the PR page so a selection inside it names where it came from. */
export function explainSource(source: ExplainSource, label: string) {
  return { "data-explain-source": source, "data-explain-label": label };
}

function parentAcrossShadow(element: Element): Element | null {
  if (element.parentElement !== null) return element.parentElement;
  const root = element.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

function closestAcrossShadow(node: Node, selector: string): Element | null {
  let element: Element | null = node instanceof Element ? node : node.parentElement;
  if (element === null) {
    const root = node.getRootNode();
    element = root instanceof ShadowRoot ? root.host : null;
  }
  while (element !== null) {
    if (element.matches(selector)) return element;
    element = parentAcrossShadow(element);
  }
  return null;
}

/** The selection a node belongs to: the diff renders inside a shadow root, which Chromium gives its own selection. */
function selectionOf(node: Node): Selection | null {
  const root = node.getRootNode() as (ShadowRoot & { getSelection?: () => Selection | null }) | Document;
  if (root instanceof ShadowRoot && typeof root.getSelection === "function") return root.getSelection();
  return document.getSelection();
}

function codeLine(node: Node): { line: number; old: boolean } | null {
  const row = closestAcrossShadow(node, "[data-line]");
  const line = Number(row?.getAttribute("data-line"));
  if (row === null || !Number.isInteger(line) || line <= 0) return null;
  const old = row.getAttribute("data-line-type") === "change-deletion" || closestAcrossShadow(row, "[data-deletions]") !== null;
  return { line, old };
}

function lineRangeLabel(start: Node, end: Node): string {
  const first = codeLine(start);
  const last = codeLine(end);
  if (first === null) return "";
  const side = first.old ? "old" : "new";
  if (last === null || last.line === first.line) return `, ${side} line ${first.line}`;
  return `, ${side} lines ${Math.min(first.line, last.line)}–${Math.max(first.line, last.line)}`;
}

/** What the user selected at `origin`, and where on the page it is, or null when nothing is selected. */
export function selectedTarget(origin: Node): ExplainTarget | null {
  const selection = selectionOf(origin);
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const quote = selection.toString().trim();
  if (quote.length === 0) return null;
  const range = selection.getRangeAt(0);
  const marked = closestAcrossShadow(range.startContainer, "[data-explain-source]");
  const source = (marked?.getAttribute("data-explain-source") as ExplainSource | null) ?? "other";
  const label = marked?.getAttribute("data-explain-label") ?? "the PR page";
  const lines = source === "code" ? lineRangeLabel(range.startContainer, range.endContainer) : "";
  return { source, label: `${label}${lines}`, quote: quote.slice(0, MAX_QUOTE) };
}

export function ExplainBar({
  target,
  sending,
  onSend,
  onClose,
}: {
  target: ExplainTarget;
  sending: boolean;
  onSend(question: string): void;
  onClose(): void;
}) {
  const [question, setQuestion] = useState("");
  return (
    <div
      role="dialog"
      aria-label="Explain the selection"
      data-explain-bar=""
      className="absolute inset-x-3 bottom-3 z-20 mx-auto max-w-2xl rounded-lg border border-border bg-background p-2 shadow-lg"
      onKeyDown={(event) => {
        if (event.key === "Escape") onClose();
      }}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon name="Lightbulb" className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate" title={target.label}>
          {target.label}
        </span>
        <button type="button" className="rounded p-0.5 hover:bg-state-hover hover:text-foreground" aria-label="Close" title="Close (Esc)" onClick={onClose}>
          <Icon name="X" className="size-3.5" />
        </button>
      </div>
      <pre className="mt-1 max-h-16 overflow-hidden whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 font-mono text-[11px] text-foreground">
        {target.quote}
      </pre>
      <form
        className="mt-1.5 flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!sending) onSend(question);
        }}
      >
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about this (optional)"
          aria-label="Question about the selection"
          className="h-7 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring"
        />
        <Button type="submit" size="sm" className="h-7" disabled={sending}>
          {sending ? "Sending…" : "Explain"}
        </Button>
      </form>
    </div>
  );
}
