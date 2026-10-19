import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { useIsCompactViewport } from "./ui/hooks/use-compact-viewport";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import { usePortalScopeProps } from "../lib/portal-scope";
import type { DocSummary, SearchResult, WikiStatus } from "../contract";
import { DOC_TYPE_LABELS, DOC_TYPES, LIMITS, WIKI_PANEL, type DocType } from "../lib/wiki";
import { EmptyState, ErrorText, Highlighted, Kbd, SectionLabel, TagChip, TypeBadge, formatDate, isTypingTarget } from "./bits";
import { DocActionsProvider, DocContextMenu } from "./DocActions";
import { DocView } from "./DocView";
import { DropOverlay, useDropToWiki, useFileDrop } from "./DropZone";
import { errorMessage, useDocs, useWikiRpc, useWikiSearch, useWikiStatus } from "./hooks";
import { Inbox, useIngestNow } from "./Inbox";
import { KeyScopeProvider, useKeyScope, useKeyScopeRoot } from "./key-scope";
import { docSubPath, inboxSubPath, parseRoute, type WikiRoute } from "./nav";
import { NewDocView } from "./NewDocDialog";

const SEARCH_LIMIT = 40;
const SEARCH_PAGE_LIMIT = 100;
const RECENT_LIMIT = 10;

type OpenTarget = { slug: string; anchor: string | null };

type ResultItem =
  | { key: string; kind: "doc"; slug: string; anchor: null; title: string; type: DocType; tags: string[]; detail: string }
  | { key: string; kind: "section"; slug: string; anchor: string; title: string; type: DocType; headingPath: string; snippet: string };

interface ResultGroup {
  label: string;
  count: number;
  items: ResultItem[];
}

function docItem(doc: DocSummary, detail: string): ResultItem {
  return { key: `doc:${doc.slug}`, kind: "doc", slug: doc.slug, anchor: null, title: doc.title, type: doc.type, tags: tagLine(doc), detail };
}

function tagLine(doc: DocSummary): string[] {
  return [...new Set([doc.tag, ...doc.aliases])];
}

function groupsByType(docs: readonly DocSummary[]): ResultGroup[] {
  return DOC_TYPES.map((type) => {
    const ofType = docs.filter((doc) => doc.type === type).sort((a, b) => a.title.localeCompare(b.title));
    return { label: DOC_TYPE_LABELS[type].many, count: ofType.length, items: ofType.map((doc) => docItem(doc, formatDate(doc.updatedAt))) };
  }).filter((group) => group.count > 0);
}

function groupsFromSearch(result: SearchResult): ResultGroup[] {
  const docs = result.docs.map((hit) => docItem(hit, ""));
  const sections = result.sections.map(
    (hit): ResultItem => ({
      key: `section:${hit.slug}#${hit.anchor}`,
      kind: "section",
      slug: hit.slug,
      anchor: hit.anchor,
      title: hit.title,
      type: hit.type,
      headingPath: hit.headingPath,
      snippet: hit.snippet,
    }),
  );
  return [
    { label: "Docs", count: docs.length, items: docs },
    { label: "Sections", count: sections.length, items: sections },
  ].filter((group) => group.count > 0);
}

function useSlashFocus(target: RefObject<HTMLInputElement | null>) {
  const inScope = useKeyScope();
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || !inScope(event)) return;
      event.preventDefault();
      target.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [target, inScope]);
}

function ResultRow({ item, selected, active, onOpen }: { item: ResultItem; selected: boolean; active: boolean; onOpen: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <li>
      <DocContextMenu doc={{ slug: item.slug, title: item.title }}>
      <button
        ref={ref}
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          "block w-full cursor-pointer px-3 py-2 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring",
          selected && "bg-state-active hover:bg-state-active",
          active && "ring-1 ring-inset ring-ring",
        )}
      >
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {item.title}
            {item.kind === "section" && item.headingPath !== "" ? <span className="font-normal text-muted-foreground"> › {item.headingPath}</span> : null}
          </span>
          {item.kind === "section" ? <TypeBadge type={item.type} /> : null}
        </div>
        {item.kind === "section" ? (
          item.snippet === "" ? null : (
            <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
              <Highlighted text={item.snippet} />
            </p>
          )
        ) : (
          <>
            {item.tags.length === 0 ? null : (
              <span className="mt-1 flex flex-wrap gap-1" title={item.tags.map((tag) => `@${tag}`).join(" ")}>
                {item.tags.map((tag, index) => (
                  <TagChip key={tag} tag={tag} active={index === 0} className="max-w-44" />
                ))}
              </span>
            )}
            {item.detail === "" ? null : <p className="mt-0.5 truncate text-xs text-muted-foreground">{item.detail}</p>}
          </>
        )}
      </button>
      </DocContextMenu>
    </li>
  );
}

interface ResultGroupsProps {
  id?: string;
  groups: ResultGroup[];
  active: number;
  selected: OpenTarget | null;
  onOpen: (target: OpenTarget) => void;
}

function ResultGroups({ id, groups, active, selected, onOpen }: ResultGroupsProps) {
  let index = -1;
  return (
    <div id={id} className="pb-2">
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label}>
          <SectionLabel count={group.count}>{group.label}</SectionLabel>
          <ul>
            {group.items.map((item) => {
              index += 1;
              return (
                <ResultRow
                  key={item.key}
                  item={item}
                  active={index === active}
                  selected={selected !== null && selected.slug === item.slug && (item.kind === "doc" || selected.anchor === item.anchor)}
                  onOpen={() => onOpen({ slug: item.slug, anchor: item.anchor })}
                />
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function useResultGroups(query: string, docs: readonly DocSummary[] | undefined, limit: number) {
  const { result, error } = useWikiSearch(query, null, limit);
  const searching = query.trim() !== "";
  const groups = useMemo(() => {
    if (searching) return result === null ? null : groupsFromSearch(result);
    return docs === undefined ? null : groupsByType(docs);
  }, [searching, result, docs]);
  return { groups, error: searching ? error : null, searching };
}

function WikiMenu() {
  const rpc = useWikiRpc();
  const portalProps = usePortalScopeProps();
  const ingest = useIngestNow();
  const reindex = async () => {
    const id = toast.loading("Reindexing the Wiki…");
    try {
      const { docCount } = await rpc.call("reindex", {});
      toast.success(docCount === 1 ? "Reindexed 1 doc" : `Reindexed ${docCount} docs`, { id });
    } catch (cause) {
      toast.error(errorMessage(cause), { id });
    }
  };
  const item = "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-state-hover";
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" className="size-8 shrink-0" aria-label="More Wiki actions">
          <Icon name="MoreHorizontal" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          {...portalProps}
          align="end"
          sideOffset={4}
          className="z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          <DropdownMenu.Item className={item} disabled={ingest.running} onSelect={() => void ingest.run()}>
            <Icon name="Download" className="size-4" />
            Run ingest now
          </DropdownMenu.Item>
          <DropdownMenu.Item className={item} onSelect={() => void reindex()}>
            <Icon name="RotateCcw" className="size-4" />
            Reindex
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

interface BrowserProps {
  query: string;
  onQueryChange: (query: string) => void;
  docs: readonly DocSummary[] | undefined;
  docsError: string | null;
  status: WikiStatus | undefined;
  statusError: string | null;
  route: WikiRoute;
  onOpen: (target: OpenTarget) => void;
  onOpenInbox: () => void;
  onNewDoc: () => void;
}

function Browser({ query, onQueryChange, docs, docsError, status, statusError, route, onOpen, onOpenInbox, onNewDoc }: BrowserProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(-1);
  const { groups, error, searching } = useResultGroups(query, docs, SEARCH_LIMIT);
  const items = useMemo(() => groups?.flatMap((group) => group.items) ?? [], [groups]);
  useSlashFocus(searchRef);
  useEffect(() => setActive(-1), [items]);

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => Math.max(0, Math.min(items.length - 1, current + step)));
    } else if (event.key === "Enter") {
      const item = items[Math.max(active, 0)];
      if (item !== undefined) onOpen({ slug: item.slug, anchor: item.anchor });
    } else if (event.key === "Escape") {
      if (query === "") {
        searchRef.current?.blur();
        return;
      }
      event.stopPropagation();
      onQueryChange("");
    }
  };

  const selected = route.kind === "doc" ? { slug: route.slug, anchor: route.anchor } : null;
  const inboxCount = status?.inboxCount ?? null;
  const loadError = error ?? (searching ? null : docsError);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-2 border-b border-border p-3">
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-current={route.kind === "inbox" ? "page" : undefined}
            onClick={onOpenInbox}
            className={cn(
              "flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-sm transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
              route.kind === "inbox" && "bg-state-active hover:bg-state-active",
            )}
          >
            <Icon name="Mail" className="size-4 text-muted-foreground" />
            <span className="font-medium text-foreground">Inbox</span>
            {inboxCount === null ? null : (
              <span className={cn("tabular-nums", inboxCount > 0 ? "text-foreground" : "text-muted-foreground")}>({inboxCount})</span>
            )}
          </button>
          <Button variant="ghost" size="sm" className="h-8 shrink-0 px-2" onClick={onNewDoc}>
            <Icon name="Plus" />
            New doc
          </Button>
          <WikiMenu />
        </div>
        <div className="relative">
          <Icon name="Search" className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            maxLength={LIMITS.query}
            placeholder="Search the Wiki…  ( / )"
            aria-label="Search the Wiki"
            aria-controls="wiki-results"
            className="pl-8"
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={onSearchKeyDown}
          />
        </div>
        {statusError === null ? null : <ErrorText>{statusError}</ErrorText>}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <p className="sr-only" aria-live="polite">
          {searching && groups !== null ? (items.length === 1 ? "1 result" : `${items.length} results`) : ""}
        </p>
        {loadError !== null ? (
          <ErrorText className="p-3">{loadError}</ErrorText>
        ) : groups === null ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : groups.length === 0 ? (
          <div className="p-3">
            {searching ? (
              <EmptyState title="Nothing matches" description={`No docs or sections mention “${query.trim()}”.`} />
            ) : (
              <EmptyState
                title="No docs yet"
                description="Create one, drop files here, or add notes from a thread."
                action={
                  <Button size="sm" onClick={onNewDoc}>
                    New doc
                  </Button>
                }
              />
            )}
          </div>
        ) : (
          <ResultGroups id="wiki-results" groups={groups} active={active} selected={selected} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

function SearchPane({ query, docs, onOpen }: { query: string; docs: readonly DocSummary[] | undefined; onOpen: (target: OpenTarget) => void }) {
  const { groups, error } = useResultGroups(query, docs, SEARCH_PAGE_LIMIT);
  return (
    <div className="mx-auto w-full max-w-3xl px-4 pb-8 pt-4 md:px-6">
      <h1 className="text-base font-semibold text-foreground">{query.trim() === "" ? "All docs" : `Results for “${query.trim()}”`}</h1>
      {error !== null ? (
        <ErrorText className="mt-3">{error}</ErrorText>
      ) : groups === null ? (
        <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
      ) : groups.length === 0 ? (
        <EmptyState className="mt-4" title="Nothing matches" />
      ) : (
        <ResultGroups groups={groups} active={-1} selected={null} onOpen={onOpen} />
      )}
    </div>
  );
}

function InboxBanner({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-raised px-4 py-3">
      <Icon name="Mail" className="size-4 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-sm text-foreground">
        {count === 1 ? "1 note is waiting for review." : `${count} notes are waiting for review.`}
        <span className="text-muted-foreground"> Nothing is added until you accept it.</span>
      </p>
      <Button size="sm" onClick={onOpen}>
        Review inbox
      </Button>
    </div>
  );
}

function Tip({ children }: { children: ReactNode }) {
  return <li className="flex items-center gap-2">{children}</li>;
}

interface HomeProps {
  docs: readonly DocSummary[] | undefined;
  status: WikiStatus | undefined;
  onOpen: (target: OpenTarget) => void;
  onOpenInbox: () => void;
  onNewDoc: () => void;
}

function Home({ docs, status, onOpen, onOpenInbox, onNewDoc }: HomeProps) {
  const recent = useMemo(() => [...(docs ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, RECENT_LIMIT), [docs]);
  const inboxCount = status?.inboxCount ?? 0;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 pb-8 pt-4 md:px-6">
      {inboxCount > 0 ? <InboxBanner count={inboxCount} onOpen={onOpenInbox} /> : null}
      <section aria-labelledby="wiki-recent">
        <h1 id="wiki-recent" className="text-base font-semibold text-foreground">
          Recently updated
        </h1>
        {docs === undefined ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading…</p>
        ) : recent.length === 0 ? (
          <EmptyState
            className="mt-3"
            title="Your Wiki is empty"
            description="Docs are Markdown files in your Wiki folder. Start one here, or let the daily ingest suggest where your notes belong."
            action={<Button onClick={onNewDoc}>New doc</Button>}
          />
        ) : (
          <ul className="mt-2 divide-y divide-border rounded-lg border border-border">
            {recent.map((doc) => (
              <li key={doc.slug}>
                <DocContextMenu doc={doc}>
                  <button
                    type="button"
                    onClick={() => onOpen({ slug: doc.slug, anchor: null })}
                    className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{doc.title}</span>
                    <TypeBadge type={doc.type} />
                    <span className="w-20 shrink-0 text-right text-xs text-muted-foreground">{formatDate(doc.updatedAt)}</span>
                  </button>
                </DocContextMenu>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ul className="space-y-2 text-sm text-muted-foreground">
        <Tip>
          <Kbd>/</Kbd> searches titles, @tags, aliases and every section.
        </Tip>
        <Tip>
          <Kbd>⌘⇧K</Kbd> opens Wiki search from anywhere in bb.
        </Tip>
        <Tip>
          <Icon name="Paperclip" className="size-4" /> Drop images, videos or Markdown files on this page to add them.
        </Tip>
        {status?.lastIngestDate ? (
          <Tip>
            <Icon name="Clock" className="size-4" /> Daily notes were last read {formatDate(status.lastIngestDate)}.
          </Tip>
        ) : null}
      </ul>
    </div>
  );
}

function BackButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button variant="ghost" size="sm" className="-ml-2 text-muted-foreground" onClick={onClick}>
      <Icon name="ArrowLeft" />
      {children}
    </Button>
  );
}

export function WikiPage({ subPath }: PluginNavPanelProps) {
  const route = parseRoute(subPath);
  const navigate = useBbNavigate();
  const compact = useIsCompactViewport();
  const { docs, error: docsError } = useDocs();
  const { status, error: statusError } = useWikiStatus();
  const routeQuery = route.kind === "search" ? route.query : null;
  const [query, setQuery] = useState(routeQuery ?? "");
  const dropToWiki = useDropToWiki();
  const drop = useFileDrop((files) => void dropToWiki(files));
  const root = useRef<HTMLDivElement>(null);
  const inScope = useKeyScopeRoot(root);

  useEffect(() => {
    if (routeQuery !== null && routeQuery !== "") setQuery(routeQuery);
  }, [routeQuery]);

  const go = (next: string, replace = false) => navigate.toPluginPanel(WIKI_PANEL, replace ? { subPath: next, replace } : { subPath: next });
  const openDoc = (target: OpenTarget) => go(docSubPath(target.slug, target.anchor));
  const openInbox = () => go(inboxSubPath());
  const newDoc = () => go("new");
  const home = () => go("");

  const browser = (
    <Browser
      query={query}
      onQueryChange={setQuery}
      docs={docs}
      docsError={docsError}
      status={status}
      statusError={statusError}
      route={route}
      onOpen={openDoc}
      onOpenInbox={openInbox}
      onNewDoc={newDoc}
    />
  );
  const back = compact ? home : undefined;

  let main: ReactNode;
  switch (route.kind) {
    case "doc":
      main = (
        <DocView key={route.slug} slug={route.slug} anchor={route.anchor} docs={docs ?? (docsError === null ? undefined : [])} wikiDirectory={status?.wikiDirectory ?? null} onBack={back} />
      );
      break;
    case "inbox":
      main = (
        <>
          {compact && statusError !== null ? <ErrorText className="px-4 pt-3">{statusError}</ErrorText> : null}
          <Inbox cardId={route.cardId} docs={docs ?? []} status={status} onBack={back} />
        </>
      );
      break;
    case "new":
      main = (
        <div className="mx-auto w-full max-w-3xl px-4 pb-8 pt-3 md:px-6 md:pt-4">
          {back === undefined ? null : <BackButton onClick={back}>Wiki</BackButton>}
          <NewDocView onDone={(slug) => go(docSubPath(slug), true)} onCancel={home} />
        </div>
      );
      break;
    case "search":
      main = <SearchPane query={query} docs={docs} onOpen={openDoc} />;
      break;
    case "home":
      main = <Home docs={docs} status={status} onOpen={openDoc} onOpenInbox={openInbox} onNewDoc={newDoc} />;
      break;
  }

  if (compact) {
    const showBrowser = route.kind === "home" || route.kind === "search";
    return (
      <DocActionsProvider currentSlug={route.kind === "doc" ? route.slug : null}>
      <KeyScopeProvider check={inScope}>
        <div ref={root} className="relative h-full min-h-0 overflow-y-auto" {...drop.bind}>
          {showBrowser ? browser : main}
          <DropOverlay dragging={drop.dragging} />
        </div>
      </KeyScopeProvider>
      </DocActionsProvider>
    );
  }
  return (
    <DocActionsProvider currentSlug={route.kind === "doc" ? route.slug : null}>
    <KeyScopeProvider check={inScope}>
      <div ref={root} className="relative flex h-full min-h-0" {...drop.bind}>
        <aside className="flex w-80 shrink-0 flex-col border-r border-border xl:w-96">{browser}</aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{main}</main>
        <DropOverlay dragging={drop.dragging} />
      </div>
    </KeyScopeProvider>
    </DocActionsProvider>
  );
}
