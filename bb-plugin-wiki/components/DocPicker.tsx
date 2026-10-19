import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { DocSummary, DocTarget, SearchResult } from "../contract";
import { DEFAULT_DOC_TYPE, DOC_TYPES, DOC_TYPE_LABELS, LIMITS, type DocType } from "../lib/wiki";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import { TypeBadge } from "./bits";
import { useDocs, useWikiSearch } from "./hooks";

const RECENT_LIMIT = 50;
const SEARCH_LIMIT = 20;

interface DocOption {
  slug: string;
  title: string;
  type: DocType;
  detail: string;
}

export interface DocPickerProps {
  value: DocTarget | null;
  onChange: (target: DocTarget) => void;
  allowNew?: boolean;
  autoFocus?: boolean;
  className?: string;
  label?: string;
}

export function targetTitle(target: DocTarget, docs: readonly DocSummary[] | undefined): string {
  if (target.kind === "new") return target.title;
  return docs?.find((doc) => doc.slug === target.slug)?.title ?? target.slug;
}

export function targetType(value: DocTarget | null, docs: readonly DocSummary[] | undefined): DocType | null {
  if (value === null) return null;
  if (value.kind === "new") return value.type;
  return docs?.find((doc) => doc.slug === value.slug)?.type ?? null;
}

function triggerLabel(value: DocTarget | null, docs: readonly DocSummary[] | undefined): string {
  if (value === null) return "Choose a doc…";
  return value.kind === "new" ? `New: ${value.title}` : targetTitle(value, docs);
}

function docOption(doc: DocSummary): DocOption {
  return { slug: doc.slug, title: doc.title, type: doc.type, detail: [`@${doc.tag}`, ...doc.aliases].join(" · ") };
}

function recentOptions(docs: readonly DocSummary[] | undefined): DocOption[] {
  return [...(docs ?? [])]
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, RECENT_LIMIT)
    .map(docOption);
}

function searchOptions(result: SearchResult | null): DocOption[] {
  if (result === null) return [];
  const options = result.docs.map(docOption);
  const seen = new Set(options.map((option) => option.slug));
  for (const section of result.sections) {
    if (seen.has(section.slug)) continue;
    seen.add(section.slug);
    options.push({ slug: section.slug, title: section.title, type: section.type, detail: section.headingPath });
  }
  return options;
}

function useRovingRadio<Value>(values: readonly Value[], value: Value, onChange: (value: Value) => void) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (values.indexOf(value) + step + values.length) % values.length;
    const nextValue = values[next];
    if (nextValue === undefined) return;
    onChange(nextValue);
    refs.current[next]?.focus();
  };
  return { refs, onKeyDown };
}

export function TypePicker({ value, onChange, label = "Type" }: { value: DocType; onChange: (type: DocType) => void; label?: string }) {
  const { refs, onKeyDown } = useRovingRadio(DOC_TYPES, value, onChange);
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-1">
      {DOC_TYPES.map((type, index) => (
        <button
          key={type}
          ref={(element) => {
            refs.current[index] = element;
          }}
          type="button"
          role="radio"
          aria-checked={value === type}
          aria-label={DOC_TYPE_LABELS[type].one}
          tabIndex={value === type ? 0 : -1}
          onClick={() => onChange(type)}
          onKeyDown={onKeyDown}
          className={cn(
            "inline-flex cursor-pointer items-center rounded-md p-1 transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === type ? "bg-state-active" : "opacity-60 hover:bg-state-hover hover:opacity-100",
          )}
        >
          <TypeBadge type={type} />
        </button>
      ))}
    </div>
  );
}

export function NewDocFields({
  title,
  type,
  onChange,
  onSubmit,
  autoFocus = false,
}: {
  title: string;
  type: DocType;
  onChange: (next: { title: string; type: DocType }) => void;
  onSubmit?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="grid gap-2">
      <Input
        value={title}
        maxLength={LIMITS.title}
        autoFocus={autoFocus}
        placeholder="New doc title"
        aria-label="New doc title"
        onChange={(event) => onChange({ title: event.target.value, type })}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.metaKey || event.ctrlKey || onSubmit === undefined) return;
          event.preventDefault();
          onSubmit();
        }}
      />
      <TypePicker value={type} onChange={(next) => onChange({ title, type: next })} label="New doc type" />
    </div>
  );
}

function NewDocForm({ initialTitle, onBack, onPick }: { initialTitle: string; onBack: () => void; onPick: (target: DocTarget) => void }) {
  const [draft, setDraft] = useState<{ title: string; type: DocType }>({ title: initialTitle, type: DEFAULT_DOC_TYPE });
  const title = draft.title.trim();
  const submit = () => {
    if (title !== "") onPick({ kind: "new", title, type: draft.type, aliases: [] });
  };
  return (
    <div className="grid gap-3 p-3">
      <NewDocFields title={draft.title} type={draft.type} onChange={setDraft} onSubmit={submit} autoFocus />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          Back
        </Button>
        <Button type="button" size="sm" disabled={title === ""} onClick={submit}>
          Use new doc
        </Button>
      </div>
    </div>
  );
}

interface OptionRowProps {
  id: string;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onChoose: () => void;
  children: ReactNode;
}

function OptionRow({ id, active, selected, onHover, onChoose, children }: OptionRowProps) {
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
      className={cn("flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm", active && "bg-state-hover")}
    >
      <Icon name="Check" className={cn("size-3.5 shrink-0", selected ? "text-foreground" : "invisible")} />
      {children}
    </li>
  );
}

function DocPickerPanel({
  value,
  docs,
  allowNew,
  onPick,
}: {
  value: DocTarget | null;
  docs: readonly DocSummary[] | undefined;
  allowNew: boolean;
  onPick: (target: DocTarget) => void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState(0);
  const { result } = useWikiSearch(query, null, SEARCH_LIMIT);
  const searching = query.trim() !== "";
  const options = searching ? searchOptions(result) : recentOptions(docs);
  const rowCount = options.length + (allowNew ? 1 : 0);
  const optionsKey = options.map((option) => option.slug).join("\n");
  useEffect(() => setActive(0), [optionsKey]);

  if (creating) return <NewDocForm initialTitle={query.trim()} onBack={() => setCreating(false)} onPick={onPick} />;

  const choose = (index: number) => {
    const option = options[index];
    if (option !== undefined) onPick({ kind: "existing", slug: option.slug });
    else if (allowNew && index === options.length) setCreating(true);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (rowCount === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + rowCount) % rowCount);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="flex max-h-80 flex-col">
      <div className="border-b border-border p-2">
        <Input
          autoFocus
          type="search"
          value={query}
          maxLength={LIMITS.query}
          placeholder="Search docs…"
          aria-label="Search docs"
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={rowCount === 0 ? undefined : `${listId}-${active}`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul id={listId} role="listbox" aria-label="Docs" className="min-h-0 flex-1 overflow-y-auto py-1">
        {options.map((option, index) => (
          <OptionRow
            key={option.slug}
            id={`${listId}-${index}`}
            active={index === active}
            selected={value?.kind === "existing" && value.slug === option.slug}
            onHover={() => setActive(index)}
            onChoose={() => choose(index)}
          >
            <span className="min-w-0 flex-1">
              <span className="block truncate text-foreground">{option.title}</span>
              {option.detail === "" ? null : <span className="block truncate text-xs text-muted-foreground">{option.detail}</span>}
            </span>
            <TypeBadge type={option.type} />
          </OptionRow>
        ))}
        {options.length === 0 ? (
          <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
            {searching ? (result === null ? "Searching…" : "No docs match.") : docs === undefined ? "Loading…" : "No docs yet."}
          </li>
        ) : null}
        {allowNew ? (
          <OptionRow
            id={`${listId}-${options.length}`}
            active={active === options.length}
            selected={value?.kind === "new"}
            onHover={() => setActive(options.length)}
            onChoose={() => choose(options.length)}
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-foreground">
              <Icon name="Plus" className="size-3.5" />
              <span className="truncate">{searching ? `New doc “${query.trim()}”…` : "New doc…"}</span>
            </span>
          </OptionRow>
        ) : null}
      </ul>
    </div>
  );
}

export function DocPicker({ value, onChange, allowNew = false, autoFocus = false, className, label = "Doc" }: DocPickerProps) {
  const [open, setOpen] = useState(autoFocus);
  const { docs } = useDocs();
  const valueType = targetType(value, docs);
  return (
    <Popover open={open} onOpenChange={setOpen} modal>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${label}: ${triggerLabel(value, docs)}`}
          className={cn(
            "inline-flex h-8 min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground transition-colors hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            value === null && "text-muted-foreground",
            className,
          )}
        >
          {value?.kind === "new" ? <Icon name="Plus" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
          <span className="truncate">{triggerLabel(value, docs)}</span>
          {valueType === null ? null : <TypeBadge type={valueType} />}
          <Icon name="ChevronDown" className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80 p-0" mobileTitle="Choose a doc">
        <DocPickerPanel
          value={value}
          docs={docs}
          allowNew={allowNew}
          onPick={(target) => {
            onChange(target);
            setOpen(false);
          }}
        />
      </PopoverContent>
    </Popover>
  );
}
