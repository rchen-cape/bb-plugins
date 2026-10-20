import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";
import type { Card, CardSource } from "../contract";
import { uploadIcon, uploadOrigin } from "../lib/card-media";
import { noteDateLabel } from "./doc-render";

const CHIP_CLASS = "inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-px text-xs text-foreground";

function AgentPill({ label }: { label: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md bg-surface-attention px-1.5 py-px text-xs text-warning-text">
      <Icon name="Bot" className="size-3.5" />
      {label}
    </span>
  );
}

function UploadChip({ source }: { source: Extract<CardSource, { kind: "upload" }> }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5">
      <span title={source.name} className={cn(CHIP_CLASS, "min-w-0 max-w-full")}>
        <Icon name={uploadIcon(source.pluginId)} className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {uploadOrigin(source.pluginId)}
          <span className="text-muted-foreground"> · {source.name}</span>
        </span>
      </span>
      {source.threadId === null ? null : <AgentPill label="Sent by an agent" />}
    </span>
  );
}

function AgentChip({ source }: { source: Extract<CardSource, { kind: "agent" }> }) {
  const navigate = useBbNavigate();
  return (
    <span className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => navigate.toThread(source.threadId)}
        className="inline-flex max-w-64 cursor-pointer items-center gap-1 rounded-md border border-border px-1.5 py-px text-xs text-foreground hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name="MessageSquare" className="size-3.5 text-muted-foreground" />
        <span className="truncate">{source.threadTitle ?? "Thread"}</span>
      </button>
      <AgentPill label="Written by an agent" />
    </span>
  );
}

export function SourceChip({ card }: { card: Card }) {
  const { source } = card;
  if (source.kind === "agent") return <AgentChip source={source} />;
  if (source.kind === "upload") return <UploadChip source={source} />;
  if (source.origin === "file") {
    return (
      <span title={source.notePath} className={cn(CHIP_CLASS, "max-w-full")}>
        <Icon name="FileText" className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">
          {source.notePath}
          {source.section === undefined ? null : <span className="text-muted-foreground"> › {source.section}</span>}
        </span>
      </span>
    );
  }
  return (
    <span title={source.notePath} className={CHIP_CLASS}>
      <Icon name="Calendar" className="size-3.5 text-muted-foreground" />
      {noteDateLabel(source.noteDate)} notes
    </span>
  );
}
