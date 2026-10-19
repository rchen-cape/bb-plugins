import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useBbNavigate } from "@get-bb/plugin-sdk/app";
import type { DocHit, SearchResult, SectionHit } from "../contract";
import { LIMITS, WIKI_PANEL } from "../lib/wiki";
import { cn } from "../lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Icon } from "./ui/icon";
import { EmptyState, Highlighted, Kbd, TypeBadge } from "./bits";
import { useWikiSearch } from "./hooks";
import { docSubPath } from "./nav";

const RESULT_LIMIT = 20;

type QuickItem = { kind: "doc"; hit: DocHit } | { kind: "section"; hit: SectionHit };

function itemsOf(result: SearchResult | null): QuickItem[] {
  if (result === null) return [];
  return [
    ...result.docs.map((hit): QuickItem => ({ kind: "doc", hit })),
    ...result.sections.map((hit): QuickItem => ({ kind: "section", hit })),
  ];
}

function subPathOf(item: QuickItem): string {
  return item.kind === "doc" ? docSubPath(item.hit.slug) : docSubPath(item.hit.slug, item.hit.anchor);
}

function itemKey(item: QuickItem): string {
  return item.kind === "doc" ? `doc:${item.hit.slug}` : `section:${item.hit.slug}#${item.hit.anchor}`;
}

function ResultOption({
  id,
  active,
  onHover,
  onChoose,
  children,
}: {
  id: string;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (active) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [active]);
  return (
    <li
      ref={ref}
      id={id}
      role="option"
      aria-selected={active}
      onMouseMove={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={cn("cursor-pointer rounded-md px-3 py-2", active && "bg-state-hover")}
    >
      {children}
    </li>
  );
}

function DocRow({ hit }: { hit: DocHit }) {
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{hit.title}</span>
      <span className="shrink-0 text-xs text-muted-foreground">@{hit.tag}</span>
      <TypeBadge type={hit.type} />
    </div>
  );
}

function SectionRow({ hit }: { hit: SectionHit }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-sm text-foreground">
        <span className="font-medium">{hit.title}</span>
        {hit.headingPath === "" ? null : <span className="text-muted-foreground"> › {hit.headingPath}</span>}
      </p>
      {hit.snippet === "" ? null : (
        <p className="mt-0.5 line-clamp-2 break-words text-xs text-muted-foreground">
          <Highlighted text={hit.snippet} />
        </p>
      )}
    </div>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <li role="presentation" className="px-3 pb-1 pt-2 text-xs font-medium text-muted-foreground">
      {children}
    </li>
  );
}

function QuickSearchBody({ onOpen }: { onOpen: (subPath: string) => void }) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const { result, error } = useWikiSearch(query, null, RESULT_LIMIT);
  const [active, setActive] = useState(0);
  const items = itemsOf(result);
  const docCount = result?.docs.length ?? 0;
  const searching = query.trim() !== "";
  const itemsKey = items.map(itemKey).join("\n");
  useEffect(() => setActive(0), [itemsKey]);

  const open = (index: number) => {
    const item = items[index];
    if (item !== undefined) onOpen(subPathOf(item));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + items.length) % items.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      open(active);
    }
  };

  const option = (item: QuickItem, index: number) => (
    <ResultOption
      key={itemKey(item)}
      id={`${listId}-${index}`}
      active={index === active}
      onHover={() => setActive(index)}
      onChoose={() => open(index)}
    >
      {item.kind === "doc" ? <DocRow hit={item.hit} /> : <SectionRow hit={item.hit} />}
    </ResultOption>
  );

  return (
    <div className="flex max-h-[min(32rem,70dvh)] min-h-0 flex-col">
      <div className="relative border-b border-border">
        <Icon name="Search" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          autoFocus
          type="search"
          value={query}
          maxLength={LIMITS.query}
          placeholder="Search the Wiki…"
          aria-label="Search the Wiki"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={items.length === 0 ? undefined : `${listId}-${active}`}
          className="h-12 w-full bg-transparent pl-9 pr-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {error !== null ? (
          <p role="alert" className="p-3 text-sm text-destructive">
            {error}
          </p>
        ) : result === null ? (
          <p className="p-3 text-sm text-muted-foreground">Loading…</p>
        ) : items.length === 0 ? (
          <EmptyState
            title={searching ? "No matches" : "The Wiki is empty"}
            description={searching ? "Try fewer words, a doc's @tag, or an alias." : "Add something from a chat message, or create a doc."}
          />
        ) : (
          <ul id={listId} role="listbox" aria-label="Wiki results">
            {docCount > 0 ? <GroupLabel>{searching ? "Docs" : "Recently updated"}</GroupLabel> : null}
            {items.slice(0, docCount).map((item, index) => option(item, index))}
            {items.length > docCount ? <GroupLabel>Sections</GroupLabel> : null}
            {items.slice(docCount).map((item, index) => option(item, docCount + index))}
          </ul>
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
        </span>
        <span>
          <Kbd>Enter</Kbd> to open
        </span>
        <span>
          <Kbd>Esc</Kbd> to close
        </span>
      </div>
    </div>
  );
}

export function QuickSearch({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useBbNavigate();
  if (!open) return null;
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent hideCloseButton className="top-[15%] max-w-xl translate-y-0 gap-0 overflow-hidden p-0">
        <DialogTitle className="sr-only">Search the Wiki</DialogTitle>
        <DialogDescription className="sr-only">Type to search docs and sections. Enter opens the selected result.</DialogDescription>
        <QuickSearchBody
          onOpen={(subPath) => {
            navigate.toPluginPanel(WIKI_PANEL, { subPath });
            onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}
