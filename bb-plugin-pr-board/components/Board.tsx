import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { UPDATES_CHANNEL } from "../channel";
import type { BoardCard, Checks, Column, ReviewerState, rpcContract } from "../contract";
import { BOARD_PANEL, workspacePath } from "../routes";
import { cn } from "../lib/utils";
import { Avatar, relativeTime } from "./bits";
import { useCached, useNow } from "./cache";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { usePreference, useStoredSet, type StoredSet } from "./use-preference";

const COLUMNS: ReadonlyArray<{ id: Column; title: string; hint: string }> = [
  { id: "draft", title: "Draft", hint: "Draft pull requests" },
  { id: "open", title: "Open", hint: "Ready for review, no human comments yet" },
  { id: "reviewing", title: "Reviewing", hint: "Commented on by someone other than the author, a bot, or Copilot" },
  { id: "ready", title: "Ready", hint: "Approved" },
];

type Scope = "all" | "mine" | "requested" | "mentioned" | "awaiting";
type Layout = "columns" | "rows";

const SCOPES: ReadonlyArray<{ id: Scope; label: string }> = [
  { id: "all", label: "All" },
  { id: "mine", label: "Mine" },
  { id: "requested", label: "Requested" },
  { id: "mentioned", label: "Mentioned" },
  { id: "awaiting", label: "Awaiting reply" },
];
const SCOPE_IDS = SCOPES.map((scope) => scope.id);
const LAYOUTS: ReadonlyArray<{ id: Layout; label: string; icon: string }> = [
  { id: "columns", label: "Columns", icon: "Columns2" },
  { id: "rows", label: "Rows", icon: "Rows2" },
];
const LAYOUT_IDS = LAYOUTS.map((layout) => layout.id);

const REFRESH_MS = 60_000;

const CHECK_STYLES: Record<Checks, { className: string; label: string } | null> = {
  success: { className: "bg-emerald-500", label: "Checks passed" },
  failure: { className: "bg-red-500", label: "Checks failed" },
  pending: { className: "bg-amber-400 animate-pulse", label: "Checks running" },
  none: null,
};

const REVIEWER_RING: Record<ReviewerState, string> = {
  approved: "ring-emerald-500",
  "changes-requested": "ring-red-500",
  commented: "ring-sky-500",
  requested: "ring-border opacity-60",
};

const scrollPositions = new Map<Layout, { top: number; left: number }>();

function cardKey(card: Pick<BoardCard, "repo" | "number">): string {
  return `${card.repo}#${card.number}`;
}

function prefersRows(): boolean {
  return window.matchMedia?.("(orientation: portrait)").matches === true;
}

function matches(card: BoardCard, query: string, scope: Scope): boolean {
  if (scope === "mine" && !card.isAuthor) return false;
  if (scope === "requested" && !card.isRequested) return false;
  if (scope === "mentioned" && !card.isMentioned) return false;
  if (scope === "awaiting" && !card.isAwaitingReply) return false;
  if (query.length === 0) return true;
  const haystack = `${cardKey(card)} ${card.title} ${card.author.login} ${card.headRefName}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((term) => haystack.includes(term));
}

function AgentBadge({ card }: { card: BoardCard }) {
  if (card.agent.threadId === null) return null;
  if (card.agent.running) {
    return (
      <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-sky-600 dark:text-sky-400">
        <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />
        Agent working
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 text-[11px]",
        card.agent.findings > 0 ? "text-amber-600 dark:text-amber-400" : "text-muted-foreground",
      )}
    >
      <Icon name="Bot" className="size-3" aria-hidden />
      {card.agent.findings > 0 ? `${card.agent.findings} findings` : "Reviewed"}
    </span>
  );
}

function ChecksDot({ checks }: { checks: Checks }) {
  const style = CHECK_STYLES[checks];
  if (style === null) return null;
  return <span className={cn("size-2 shrink-0 rounded-full", style.className)} title={style.label} aria-label={style.label} />;
}

function CardAction({ label, icon, onClick }: { label: string; icon: string; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className="rounded-md p-1 text-muted-foreground outline-none hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
    >
      <Icon name={icon} className="size-3.5" />
    </button>
  );
}

function PullCard({
  card,
  showRepo,
  compact,
  hidden,
  onOpen,
  onToggleCompact,
  onToggleHidden,
}: {
  card: BoardCard;
  showRepo: boolean;
  compact: boolean;
  hidden: boolean;
  onOpen(card: BoardCard): void;
  onToggleCompact(): void;
  onToggleHidden(): void;
}) {
  const navigate = useBbNavigate();
  const number = `${showRepo ? card.repo.slice(card.repo.indexOf("/") + 1) : ""}#${card.number}`;
  return (
    <li className={cn("group relative", hidden && "opacity-50")}>
      <button
        type="button"
        onClick={() => onOpen(card)}
        className={cn(
          "block w-full rounded-lg border border-border bg-card text-left text-sm shadow-xs outline-none transition-colors hover:border-foreground/20 hover:bg-state-hover focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "px-2.5 py-1.5 pr-20" : "space-y-2 p-3",
        )}
      >
        {compact ? (
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <ChecksDot checks={card.checks} />
            <span className="shrink-0 tabular-nums text-muted-foreground">{number}</span>
            <span className="min-w-0 flex-1 truncate font-medium" title={card.title}>
              {card.title}
            </span>
            <Avatar person={card.author} />
            <AgentBadge card={card} />
          </span>
        ) : (
          <>
            <span className="block pr-16">
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <ChecksDot checks={card.checks} />
                <span className="tabular-nums">{number}</span>
                <span aria-hidden>·</span>
                <span title={new Date(card.updatedAt).toLocaleString()}>{relativeTime(card.updatedAt)}</span>
              </span>
              <span className="mt-0.5 line-clamp-2 font-medium leading-snug">{card.title}</span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-flex min-w-0 items-center gap-1">
                <Avatar person={card.author} />
                <span className="truncate">{card.author.login}</span>
              </span>
              <span className="ml-auto shrink-0 tabular-nums">
                <span className="text-emerald-600 dark:text-emerald-400">+{card.additions}</span>{" "}
                <span className="text-red-600 dark:text-red-400">−{card.deletions}</span>
              </span>
            </span>
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {card.reviewers.length === 0 ? null : (
                <span className="flex -space-x-1">
                  {card.reviewers.slice(0, 5).map((reviewer) => (
                    <Avatar
                      key={reviewer.login}
                      person={reviewer}
                      className={cn("ring-2 ring-offset-1 ring-offset-card", REVIEWER_RING[reviewer.state])}
                      title={`${reviewer.login}: ${reviewer.state.replace("-", " ")}`}
                    />
                  ))}
                </span>
              )}
              {card.humanComments > 0 ? (
                <span className="inline-flex items-center gap-0.5" title="Comments and reviews from people">
                  <Icon name="MessageSquare" className="size-3" aria-hidden />
                  {card.humanComments}
                </span>
              ) : null}
              {card.unresolvedThreads > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-amber-600 dark:text-amber-400" title="Unresolved review threads">
                  <Icon name="AlertCircle" className="size-3" aria-hidden />
                  {card.unresolvedThreads}
                </span>
              ) : null}
              {card.unansweredComments > 0 ? (
                <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400" title="Comments waiting for your reply">
                  <Icon name="AlertTriangle" className="size-3" aria-hidden />
                  {card.unansweredComments}
                </span>
              ) : null}
              <span className="ml-auto">
                <AgentBadge card={card} />
              </span>
            </span>
          </>
        )}
      </button>
      <div
        className={cn(
          "absolute right-1.5 flex items-center rounded-md bg-card opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
          compact ? "top-1/2 -translate-y-1/2" : "top-1.5",
        )}
      >
        <CardAction label={compact ? `Expand #${card.number}` : `Shrink #${card.number}`} icon={compact ? "Maximize2" : "Minimize2"} onClick={onToggleCompact} />
        <CardAction label={hidden ? `Unhide #${card.number}` : `Hide #${card.number}`} icon={hidden ? "Eye" : "EyeOff"} onClick={onToggleHidden} />
        <CardAction
          label={`Open #${card.number} on GitHub`}
          icon="ExternalLink"
          onClick={() => {
            if (!navigate.openUrl(card.url)) window.open(card.url, "_blank", "noopener");
          }}
        />
      </div>
    </li>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ id: T; label: string; icon?: string }>;
  onChange(value: T): void;
}) {
  return (
    <div className="flex rounded-md border border-border p-0.5" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          aria-pressed={value === option.id}
          onClick={() => onChange(option.id)}
          title={option.label}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground"
        >
          {option.icon === undefined ? null : <Icon name={option.icon} className="size-3.5" aria-hidden />}
          {option.label}
        </button>
      ))}
    </div>
  );
}

function Section({
  title,
  hint,
  count,
  layout,
  collapsed,
  onToggle,
  children,
}: {
  title: string;
  hint: string;
  count: number;
  layout: Layout;
  collapsed: boolean;
  onToggle(): void;
  children: ReactNode;
}) {
  const rail = layout === "columns" && collapsed;
  return (
    <section
      aria-label={title}
      className={cn(
        "rounded-xl bg-muted/40 p-2",
        layout === "columns" && "flex min-h-0 flex-col",
        layout === "columns" && (collapsed ? "w-11 flex-none" : "w-72 min-w-64 flex-1"),
      )}
    >
      <h2 className="mb-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!collapsed}
          title={hint}
          className={cn(
            "flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm font-semibold outline-none hover:bg-state-hover focus-visible:ring-1 focus-visible:ring-ring",
            rail && "flex-col",
          )}
        >
          <Icon name={collapsed ? "ChevronRight" : "ChevronDown"} className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className={cn(rail && "[writing-mode:vertical-rl]")}>{title}</span>
          <span className="rounded-full bg-background px-1.5 text-xs font-normal tabular-nums text-muted-foreground">{count}</span>
        </button>
      </h2>
      {collapsed ? null : children}
    </section>
  );
}

function UpdatedIndicator({ fetchedAt, refreshing, error, onRetry }: { fetchedAt: string; refreshing: boolean; error: string | null; onRetry(): void }) {
  const now = useNow(15_000);
  if (refreshing) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" role="status">
        <Icon name="ArrowReloadHorizontal" className="size-3 animate-spin" aria-hidden />
        Updating…
      </span>
    );
  }
  if (error !== null) {
    return (
      <button type="button" className="text-xs text-destructive underline-offset-2 hover:underline" title={error} onClick={onRetry}>
        Update failed · retry
      </button>
    );
  }
  return (
    <span className="text-xs text-muted-foreground" title={new Date(fetchedAt).toLocaleString()}>
      Updated {relativeTime(fetchedAt, now)}
    </span>
  );
}

function useScrollMemory(layout: Layout) {
  const scroller = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const saved = scrollPositions.get(layout);
    if (saved !== undefined && scroller.current !== null) {
      scroller.current.scrollTop = saved.top;
      scroller.current.scrollLeft = saved.left;
    }
  }, [layout]);
  const onScroll = () => {
    if (scroller.current !== null) scrollPositions.set(layout, { top: scroller.current.scrollTop, left: scroller.current.scrollLeft });
  };
  return { scroller, onScroll };
}

function CardList({
  cards,
  layout,
  showRepo,
  compact,
  hidden,
  onOpen,
}: {
  cards: readonly BoardCard[];
  layout: Layout;
  showRepo: boolean;
  compact: StoredSet;
  hidden: StoredSet;
  onOpen(card: BoardCard): void;
}) {
  return (
    <ul
      className={cn(
        "px-0.5 pb-1",
        layout === "columns" ? "min-h-0 flex-1 space-y-2 overflow-y-auto" : "grid grid-cols-[repeat(auto-fill,minmax(17rem,1fr))] gap-2",
      )}
    >
      {cards.map((card) => (
        <PullCard
          key={cardKey(card)}
          card={card}
          showRepo={showRepo}
          compact={compact.has(cardKey(card))}
          hidden={hidden.has(cardKey(card))}
          onOpen={onOpen}
          onToggleCompact={() => compact.toggle(cardKey(card))}
          onToggleHidden={() => hidden.toggle(cardKey(card))}
        />
      ))}
      {cards.length === 0 ? <li className="col-span-full px-1.5 py-4 text-center text-xs text-muted-foreground">Nothing here</li> : null}
    </ul>
  );
}

export function BoardView() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const force = useRef(false);
  const board = useCached(
    "board",
    () => {
      const refresh = force.current;
      force.current = false;
      return rpc.call("board", { refresh });
    },
    { persist: true },
  );
  useRealtime(UPDATES_CHANNEL, board.reload);
  useEffect(() => {
    const timer = setInterval(board.reload, REFRESH_MS);
    return () => clearInterval(timer);
  }, [board.reload]);

  const [layout, setLayout] = usePreference<Layout>("board-layout", prefersRows() ? "rows" : "columns", LAYOUT_IDS);
  const [scope, setScope] = usePreference<Scope>("board-scope", "all", SCOPE_IDS);
  const [query, setQuery] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const hidden = useStoredSet("hidden-prs");
  const compact = useStoredSet("compact-prs");
  const collapsedSections = useStoredSet("collapsed-columns");
  const { scroller, onScroll } = useScrollMemory(layout);

  const refresh = () => {
    force.current = true;
    board.reload();
  };
  const open = (card: BoardCard) => navigate.toPluginPanel(BOARD_PANEL, { subPath: workspacePath(card) });

  const { sections, hiddenCount } = useMemo(() => {
    const visible = (board.value?.cards ?? []).filter((card) => matches(card, query.trim(), scope));
    const count = visible.filter((card) => hidden.has(cardKey(card))).length;
    const shown = showHidden ? visible : visible.filter((card) => !hidden.has(cardKey(card)));
    return {
      hiddenCount: count,
      sections: COLUMNS.map((column) => ({ ...column, cards: shown.filter((card) => card.column === column.id) })),
    };
  }, [board.value, hidden, query, scope, showHidden]);

  if (board.value === null) {
    return board.error === null ? (
      <p className="p-5 text-sm text-muted-foreground">Loading open pull requests…</p>
    ) : (
      <div className="space-y-3 p-5 text-sm">
        <p className="text-destructive">{board.error}</p>
        <Button size="sm" variant="outline" onClick={board.reload}>
          Retry
        </Button>
      </div>
    );
  }

  const { repos, errors, fetchedAt, viewer } = board.value;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 md:px-5">
        <div className="relative w-64 max-w-full">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter by title, author, branch, #"
            aria-label="Filter pull requests"
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Segmented label="Scope" value={scope} options={SCOPES} onChange={setScope} />
        <Segmented label="Layout" value={layout} options={LAYOUTS} onChange={setLayout} />
        {hiddenCount > 0 ? (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs"
            aria-pressed={showHidden}
            title={showHidden ? "Stop showing hidden pull requests" : "Show hidden pull requests"}
            onClick={() => setShowHidden(!showHidden)}
          >
            <Icon name={showHidden ? "Eye" : "EyeOff"} className="size-3.5" />
            {hiddenCount} hidden
          </Button>
        ) : null}
        <span className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:inline">
            {repos.length === 0 ? "All repositories" : repos.join(", ")} as {viewer}
          </span>
          <UpdatedIndicator fetchedAt={fetchedAt} refreshing={board.refreshing} error={board.error} onRetry={refresh} />
          <Button size="sm" variant="outline" onClick={refresh} disabled={board.refreshing}>
            <Icon name="ArrowReloadHorizontal" className="size-3.5" />
            Refresh
          </Button>
        </span>
      </div>
      {errors.map((error) => (
        <p key={error.search} className="shrink-0 px-5 pt-2 text-sm text-destructive">
          {error.search}: {error.message}
        </p>
      ))}
      <div
        ref={scroller}
        onScroll={onScroll}
        className={cn("min-h-0 flex-1 p-4 md:p-5", layout === "columns" ? "flex gap-3 overflow-x-auto" : "space-y-3 overflow-y-auto")}
      >
        {sections.map((section) => (
          <Section
            key={section.id}
            title={section.title}
            hint={section.hint}
            count={section.cards.length}
            layout={layout}
            collapsed={collapsedSections.has(section.id)}
            onToggle={() => collapsedSections.toggle(section.id)}
          >
            <CardList cards={section.cards} layout={layout} showRepo={repos.length !== 1} compact={compact} hidden={hidden} onOpen={open} />
          </Section>
        ))}
      </div>
    </div>
  );
}
