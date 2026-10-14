import type { NodeKind, NodeState } from "../src/model";

export const STATE_TEXT_CLASS: Record<NodeState, string> = {
  blocked: "text-subtle-foreground",
  ready: "text-timeline-accent",
  in_progress: "text-warning-text",
  completed: "text-success-text",
  stale: "text-destructive-text",
};

export const STATE_DOT_CLASS: Record<NodeState, string> = {
  blocked: "bg-subtle-foreground",
  ready: "bg-timeline-accent",
  in_progress: "bg-warning",
  completed: "bg-success",
  stale: "bg-destructive",
};

export const STATE_CARD_CLASS: Record<NodeState, string> = {
  blocked: "border-border bg-muted/40",
  ready: "border-timeline-accent bg-card",
  in_progress: "border-warning bg-warning/10",
  completed: "border-success/50 bg-card",
  stale: "border-destructive bg-destructive/10",
};

export const KIND_CHIP_CLASS: Record<NodeKind, string> = {
  agent: "text-pr-merged",
  markdown: "text-subtle-foreground",
};

export const KIND_LABELS: Record<NodeKind, string> = {
  agent: "Agent",
  markdown: "Note",
};

export function stateChipClass(state: NodeState): string {
  return `inline-flex shrink-0 items-center gap-1.5 text-2xs font-medium uppercase tracking-wide ${STATE_TEXT_CLASS[state]}`;
}

export function kindChipClass(kind: NodeKind): string {
  return `shrink-0 text-2xs font-medium uppercase tracking-wide ${KIND_CHIP_CLASS[kind]}`;
}
