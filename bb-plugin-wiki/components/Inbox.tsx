import { useCallback, useEffect, useMemo, useState } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";
import type { Card, DocSummary, IngestResult, WikiStatus } from "../contract";
import { WIKI_PANEL } from "../lib/wiki";
import { EmptyState, ErrorText, Kbd, RuleBadge, Spinner, TagChip, formatDate } from "./bits";
import { CardView } from "./CardView";
import { noteDateLabel } from "./doc-render";
import { errorMessage, useInbox, useWikiRpc } from "./hooks";
import { inboxSubPath } from "./nav";
import { restoredCards } from "./requests";

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function ingestSummary(result: IngestResult): string {
  if (result.cardsCreated === 0) return `No new notes to review (${plural(result.notesScanned, "note", "notes")} checked).`;
  const routing = result.jobIds.length > 0 ? " Claude Code is suggesting where they go." : "";
  return `${plural(result.cardsCreated, "new card", "new cards")} from ${plural(result.notesScanned, "note", "notes")}.${routing}`;
}

export function useIngestNow() {
  const rpc = useWikiRpc();
  const navigate = useBbNavigate();
  const [running, setRunning] = useState(false);
  const run = useCallback(async () => {
    setRunning(true);
    const id = toast.loading("Reading your daily notes…");
    try {
      const result = await rpc.call("ingestNow", { since: null, useAgent: null });
      const review = { label: "Review", onClick: () => navigate.toPluginPanel(WIKI_PANEL, { subPath: inboxSubPath() }) };
      toast.success(ingestSummary(result), result.cardsCreated > 0 ? { id, action: review } : { id });
    } catch (cause) {
      toast.error(errorMessage(cause), { id });
    } finally {
      setRunning(false);
    }
  }, [rpc, navigate]);
  return { run, running };
}

export function cardSourceLabel(card: Card): string {
  if (card.source.kind === "agent") return card.source.threadTitle ?? "Agent";
  if (card.source.origin === "file") return card.source.notePath.slice(card.source.notePath.lastIndexOf("/") + 1);
  return noteDateLabel(card.source.noteDate);
}

export function cardFirstLine(card: Card): string {
  const line = card.lines.find((candidate) => candidate.trim() !== "") ?? card.text;
  return line.replace(/^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, "").trim();
}

function CardRow({ card, selected, onSelect }: { card: Card; selected: boolean; onSelect: () => void }) {
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "block w-full cursor-pointer px-3 py-2.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-state-active hover:bg-state-active",
        )}
      >
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {card.source.kind === "agent" ? <Icon name="Bot" className="size-3.5" /> : null}
          <span className="min-w-0 truncate">{cardSourceLabel(card)}</span>
          <span className="flex-1" />
          {card.status === "routing" ? <Spinner label="Routing" /> : <RuleBadge rule={card.rule} />}
        </div>
        <p className="mt-1 line-clamp-2 break-words text-sm text-foreground">{cardFirstLine(card)}</p>
        {card.tags.length === 0 ? null : (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {card.tags.slice(0, 4).map((tag) => (
              <TagChip key={tag} tag={tag} />
            ))}
          </div>
        )}
      </button>
    </li>
  );
}

function AllCaughtUp({ status }: { status: WikiStatus | undefined }) {
  const ingest = useIngestNow();
  const last = status?.lastIngestDate ?? null;
  return (
    <div className="mx-auto w-full max-w-xl px-4 py-10">
      <EmptyState
        title="All caught up"
        description={last === null ? "Your daily notes haven't been read yet." : `Daily notes were last read ${formatDate(last)}.`}
        action={
          <Button size="sm" disabled={ingest.running} onClick={() => void ingest.run()}>
            {ingest.running ? <Spinner className="text-background" /> : <Icon name="Download" />}
            Run ingest now
          </Button>
        }
      />
    </div>
  );
}

interface InboxProps {
  cardId: string | null;
  docs: readonly DocSummary[];
  status: WikiStatus | undefined;
  onBack?: () => void;
}

export function Inbox({ cardId, docs, status, onBack }: InboxProps) {
  const navigate = useBbNavigate();
  const { cards, error } = useInbox("open");
  const ingest = useIngestNow();
  const [resolved, setResolved] = useState<ReadonlySet<string>>(() => new Set());
  const open = useMemo(() => cards?.filter((card) => !resolved.has(card.id)), [cards, resolved]);

  useEffect(() => {
    if (cards === undefined) return;
    const present = new Set(cards.map((entry) => entry.id));
    setResolved((current) => {
      const kept = [...current].filter((id) => present.has(id));
      return kept.length === current.size ? current : new Set(kept);
    });
  }, [cards]);

  useEffect(
    () =>
      restoredCards.subscribe((id) =>
        setResolved((current) => {
          if (!current.has(id)) return current;
          const next = new Set(current);
          next.delete(id);
          return next;
        }),
      ),
    [],
  );
  const index = open === undefined ? -1 : Math.max(0, open.findIndex((card) => card.id === cardId));
  const card = open?.[index] ?? null;

  const select = (id: string | null, replace: boolean) =>
    navigate.toPluginPanel(WIKI_PANEL, replace ? { subPath: inboxSubPath(id), replace } : { subPath: inboxSubPath(id) });
  const step = (offset: number) => {
    const target = open?.[index + offset];
    return target === undefined ? null : () => select(target.id, true);
  };
  const onResolved = (done: Card) => {
    const list = open ?? [];
    const at = list.findIndex((candidate) => candidate.id === done.id);
    const next = list[at + 1] ?? list[at - 1] ?? null;
    setResolved((current) => new Set(current).add(done.id));
    select(next?.id ?? null, true);
  };

  let body;
  if (open === undefined) {
    body = error === null ? <p className="p-4 text-sm text-muted-foreground">Loading…</p> : <ErrorText className="p-4">{error}</ErrorText>;
  } else if (card === null) {
    body = <AllCaughtUp status={status} />;
  } else {
    body = (
      <div className="flex min-h-0 flex-1">
        <ul aria-label="Open cards" className="hidden w-64 shrink-0 divide-y divide-border overflow-y-auto border-r border-border xl:block">
          {open.map((candidate) => (
            <CardRow key={candidate.id} card={candidate} selected={candidate.id === card.id} onSelect={() => select(candidate.id, false)} />
          ))}
        </ul>
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          <CardView
            key={card.id}
            card={card}
            docs={docs}
            position={{ index, total: open.length }}
            onPrev={step(-1)}
            onNext={step(1)}
            onResolved={onResolved}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        {onBack === undefined ? null : (
          <Button variant="ghost" size="icon" className="-ml-2 size-8" aria-label="Back to the Wiki" onClick={onBack}>
            <Icon name="ArrowLeft" />
          </Button>
        )}
        <h1 className="text-sm font-semibold text-foreground">Inbox</h1>
        {open === undefined ? null : <span className="text-xs tabular-nums text-muted-foreground">{open.length} open</span>}
        <span className="flex-1" />
        {card === null ? null : (
          <span className="hidden items-center gap-1 text-xs text-muted-foreground md:inline-flex">
            <Kbd>A</Kbd> accept <Kbd>S</Kbd> skip <Kbd>J</Kbd>
            <Kbd>K</Kbd> next / previous
          </span>
        )}
        <Button size="sm" variant="ghost" disabled={ingest.running} onClick={() => void ingest.run()}>
          {ingest.running ? <Spinner /> : <Icon name="Download" />}
          Run ingest now
        </Button>
      </header>
      {body}
    </div>
  );
}
