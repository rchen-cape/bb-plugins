import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { experimental_Diff as Diff, experimental_usePluginId, useBbNavigate } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";
import { cn } from "../lib/utils";
import type { Card, CardPreview, Destination, DocSummary, DocTarget, TagSuggestion } from "../contract";
import { parseCardMediaLine, type CardMediaLine } from "../lib/card-media";
import { DEFAULT_HEADING, LIMITS, WIKI_PANEL } from "../lib/wiki";
import { slugify } from "../lib/slug";
import { ErrorText, Kbd, RuleBadge, Spinner, TagChip, formatDate, isTypingTarget } from "./bits";
import {
  acceptTagSuggestion,
  createDestination,
  hasContentToAdd,
  headingOptions,
  includedDestinations,
  isLineSelected,
  pendingSuggestions,
  removeDestination,
  retarget,
  selectLineRange,
  selectionLabel,
  targetHeadings,
  targetTitle,
  toggleLine,
  updateDestination,
  type CardDraft,
  type SuggestionGroup,
} from "./card-edit";
import { DocPicker } from "./DocPicker";
import { cardMediaUrl, errorMessage, useWikiRpc } from "./hooks";
import { useKeyScope } from "./key-scope";
import { docSubPath, inboxSubPath } from "./nav";
import { restoredCards } from "./requests";
import { SourceChip } from "./SourceChip";

const SAVE_DELAY_MS = 300;
const NO_CONTENT = "Turn on a destination that receives the text.";
const NEW_HEADING = "\u0000new-heading";

type DocIndex = ReadonlyMap<string, DocSummary>;

function draftOf(card: Card): CardDraft {
  return { destinations: card.destinations, rememberAliases: card.rememberAliases };
}

function useCardDraft(card: Card) {
  const rpc = useWikiRpc();
  const [draft, setDraft] = useState<CardDraft>(() => draftOf(card));
  const [savedCount, setSavedCount] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  const latest = useRef(draft);
  const dirty = useRef(false);
  const pending = useRef(0);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const saveLatest = useCallback(async (): Promise<boolean> => {
    if (!dirty.current) return true;
    dirty.current = false;
    const { destinations, rememberAliases } = latest.current;
    try {
      await rpc.call("updateCard", { id: card.id, destinations, rememberAliases });
      setSaveError(null);
      setSavedCount((count) => count + 1);
      return true;
    } catch (cause) {
      dirty.current = true;
      setSaveError(errorMessage(cause));
      return false;
    }
  }, [rpc, card.id]);

  const flush = useCallback((): Promise<boolean> => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    pending.current += 1;
    const saved = queue.current.then(saveLatest).finally(() => {
      pending.current -= 1;
    });
    queue.current = saved;
    return saved;
  }, [saveLatest]);

  const update = useCallback(
    (next: CardDraft) => {
      latest.current = next;
      dirty.current = true;
      setDraft(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY_MS);
    },
    [flush],
  );

  useEffect(() => {
    if (timer.current !== null || dirty.current || pending.current > 0) return;
    const next = draftOf(card);
    latest.current = next;
    setDraft(next);
  }, [card.updatedAt, card.status]);

  useEffect(
    () => () => {
      if (timer.current !== null || dirty.current) void flush();
    },
    [flush],
  );

  const discard = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    dirty.current = false;
  }, []);

  return { draft, update, flush, discard, savedCount, saveError };
}

interface PreviewState {
  previews: CardPreview[] | null;
  missingImages: string[];
  error: string | null;
}

function usePreview(cardId: string, open: boolean, version: string, flush: () => Promise<boolean>) {
  const rpc = useWikiRpc();
  const [state, setState] = useState<PreviewState>({ previews: null, missingImages: [], error: null });
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void flush()
      .then((saved) => {
        if (!saved) throw new Error("Couldn't save your latest edits, so this preview is out of date.");
        return rpc.call("previewCard", { id: cardId });
      })
      .then(
        ({ previews, missingImages }) => {
          if (!cancelled) setState({ previews, missingImages, error: null });
        },
        (cause: unknown) => {
          if (!cancelled) setState((current) => ({ ...current, error: errorMessage(cause) }));
        },
      );
    return () => {
      cancelled = true;
    };
  }, [rpc, cardId, open, version, flush]);
  return state;
}

interface CardLinesProps {
  cardId: string;
  lines: readonly string[];
  active: Destination | null;
  onLineClick: (index: number, extend: boolean) => void;
}

function LineImage({ image }: { image: CardMediaLine }) {
  const pluginId = experimental_usePluginId();
  return (
    <span className="flex flex-col items-start gap-1 py-1 font-sans">
      <img
        src={cardMediaUrl(pluginId, image.path)}
        alt={image.caption === "" ? "Image" : image.caption}
        loading="lazy"
        draggable={false}
        className="max-h-48 max-w-full rounded-md border border-border bg-background object-contain"
      />
      {image.caption === "" ? null : <span className="text-muted-foreground">{image.caption}</span>}
    </span>
  );
}

function LineContent({ cardId, line }: { cardId: string; line: string }) {
  const image = parseCardMediaLine(line, cardId);
  if (image !== null) return <LineImage image={image} />;
  return <>{line === "" ? " " : line}</>;
}

function CardLines({ cardId, lines, active, onLineClick }: CardLinesProps) {
  return (
    <ol aria-label="Note lines" className="overflow-x-auto rounded-md border border-border bg-surface-recessed py-1 font-mono text-xs leading-5">
      {lines.map((line, index) => {
        const included = active !== null && isLineSelected(active.lineRanges, index);
        return (
          <li
            key={index}
            onClick={active === null ? undefined : (event) => onLineClick(index, event.shiftKey)}
            className={cn("flex", active !== null && "cursor-pointer select-none", active !== null && (included ? "bg-surface-selected" : "opacity-50"))}
          >
            {active === null ? (
              <span className="w-10 shrink-0 select-none pr-3 text-right text-muted-foreground">{index + 1}</span>
            ) : (
              <button
                type="button"
                aria-pressed={included}
                aria-label={`Line ${index + 1}`}
                className="w-10 shrink-0 cursor-pointer select-none pr-3 text-right text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
              >
                {index + 1}
              </button>
            )}
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words pr-3 text-foreground">
              <LineContent cardId={cardId} line={line} />
            </span>
          </li>
        );
      })}
    </ol>
  );
}

const SELECT_CLASS =
  "h-8 max-w-56 cursor-pointer truncate rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

interface HeadingSelectProps {
  value: string;
  options: readonly string[];
  disabled: boolean;
  label: string;
  onChange: (heading: string) => void;
}

function HeadingSelect({ value, options, disabled, label, onChange }: HeadingSelectProps) {
  const [custom, setCustom] = useState(false);
  const [text, setText] = useState("");
  const commit = () => {
    setCustom(false);
    if (text.trim() !== "") onChange(text.trim());
    setText("");
  };
  if (custom) {
    const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
      } else if (event.key === "Escape") {
        event.stopPropagation();
        setCustom(false);
        setText("");
      }
    };
    return (
      <Input
        autoFocus
        value={text}
        maxLength={LIMITS.heading}
        placeholder="New heading"
        aria-label={`New heading for ${label}`}
        className="h-8 w-44 text-sm"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={onKeyDown}
        onBlur={commit}
      />
    );
  }
  return (
    <select
      value={value}
      disabled={disabled}
      aria-label={`Heading in ${label}`}
      className={SELECT_CLASS}
      onChange={(event) => {
        if (event.target.value === NEW_HEADING) setCustom(true);
        else onChange(event.target.value);
      }}
    >
      {options.map((option) => (
        <option key={option} value={option}>
          {option === DEFAULT_HEADING ? "Unsorted (below the line)" : option}
        </option>
      ))}
      <option value={NEW_HEADING}>New heading…</option>
    </select>
  );
}

interface DestinationRowProps {
  destination: Destination;
  docs: DocIndex;
  lineCount: number;
  active: boolean;
  disabled: boolean;
  onChange: (next: Destination) => void;
  onRemove: () => void;
  onToggleActive: () => void;
}

function DestinationRow({ destination, docs, lineCount, active, disabled, onChange, onRemove, onToggleActive }: DestinationRowProps) {
  const title = targetTitle(destination.target, docs);
  const options = headingOptions(targetHeadings(destination.target, docs), destination.heading, destination.role, destination.target);
  const isLink = destination.role === "link";
  return (
    <li className={cn("rounded-md border px-3 py-2", active ? "border-ring" : "border-border", !destination.include && "bg-surface-recessed")}>
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={destination.include}
          disabled={disabled}
          aria-label={`Include ${title}`}
          className="size-4 shrink-0 cursor-pointer accent-foreground disabled:cursor-not-allowed"
          onChange={(event) => onChange({ ...destination, include: event.target.checked })}
        />
        <fieldset disabled={disabled} className={cn("min-w-48 flex-1", !destination.include && "opacity-60")}>
          <DocPicker
            value={destination.target}
            allowNew
            label="Destination doc"
            className="w-full"
            onChange={(target) => onChange(retarget(destination, target))}
          />
        </fieldset>
        <HeadingSelect value={destination.heading} options={options} disabled={disabled} label={title} onChange={(heading) => onChange({ ...destination, heading })} />
        {isLink ? (
          <span
            title="Adds a link line like “- See [[Doc]] (from 10-14-26)” instead of copying the text"
            className="inline-flex h-6 items-center gap-1 rounded-full border border-border px-2 text-xs text-muted-foreground"
          >
            <Icon name="Link" className="size-3" />
            link line
          </span>
        ) : (
          <button
            type="button"
            aria-pressed={active}
            disabled={disabled}
            title={active ? "Click line numbers to choose lines. Shift-click selects a range." : "Choose which lines go here"}
            onClick={onToggleActive}
            className={cn(
              "inline-flex h-6 cursor-pointer items-center gap-1 rounded-full border px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
              active ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-muted-foreground hover:bg-state-hover hover:text-foreground",
            )}
          >
            {selectionLabel(destination.lineRanges, lineCount)}
          </button>
        )}
        <Button variant="ghost" size="icon" className="size-7 shrink-0" disabled={disabled} aria-label={`Remove ${title}`} onClick={onRemove}>
          <Icon name="X" />
        </Button>
      </div>
      {destination.reason === "" ? null : <p className="mt-1 pl-6 text-xs text-muted-foreground">{destination.reason}</p>}
    </li>
  );
}

function AddDestination({ disabled, onAdd }: { disabled: boolean; onAdd: (target: DocTarget) => void }) {
  const [adding, setAdding] = useState(false);
  if (!adding) {
    return (
      <Button variant="ghost" size="sm" className="self-start text-muted-foreground" disabled={disabled} onClick={() => setAdding(true)}>
        <Icon name="Plus" />
        Add destination
      </Button>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <div className="min-w-48 flex-1">
        <DocPicker
          value={null}
          allowNew
          autoFocus
          label="New destination"
          className="w-full"
          onChange={(target) => {
            setAdding(false);
            onAdd(target);
          }}
        />
      </div>
      <Button variant="ghost" size="sm" onClick={() => setAdding(false)}>
        Cancel
      </Button>
    </div>
  );
}

interface DidYouMeanProps {
  groups: readonly SuggestionGroup[];
  disabled: boolean;
  onAccept: (suggestion: TagSuggestion) => void;
  onDismiss: (tag: string) => void;
}

function DidYouMean({ groups, disabled, onAccept, onDismiss }: DidYouMeanProps) {
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {groups.map(({ tag, best, others }) => (
        <div key={tag} className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-attention px-3 py-2 text-sm">
          <p className="min-w-0 flex-1 text-foreground">
            <code className="font-mono">@{tag}</code> isn't a Wiki doc yet. Did you mean <strong className="font-medium">{best.title}</strong>?
            {others.length === 0 ? null : (
              <span className="text-muted-foreground">
                {" "}
                Or{" "}
                {others.map((other, index) => (
                  <span key={other.slug}>
                    {index === 0 ? "" : ", "}
                    <button
                      type="button"
                      disabled={disabled}
                      className="cursor-pointer rounded-sm underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed"
                      onClick={() => onAccept(other)}
                    >
                      {other.title}
                    </button>
                  </span>
                ))}
                ?
              </span>
            )}
          </p>
          <Button size="sm" variant="outline" disabled={disabled} onClick={() => onAccept(best)}>
            Yes, remember @{tag}
          </Button>
          <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onDismiss(tag)}>
            No
          </Button>
        </div>
      ))}
    </div>
  );
}

function RememberedAliases({ draft, docs, disabled, onForget }: { draft: CardDraft; docs: DocIndex; disabled: boolean; onForget: (tag: string) => void }) {
  if (draft.rememberAliases.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-1.5 text-xs text-muted-foreground">
      {draft.rememberAliases.map((alias) => (
        <li key={alias.tag} className="inline-flex items-center gap-1 rounded-full border border-border py-px pl-2 pr-1">
          On accept, @{alias.tag} becomes an alias of {docs.get(alias.slug)?.title ?? alias.slug}
          <button
            type="button"
            disabled={disabled}
            aria-label={`Don't remember @${alias.tag}`}
            className="cursor-pointer rounded-full p-0.5 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed"
            onClick={() => onForget(alias.tag)}
          >
            <Icon name="X" className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function previewPath(preview: CardPreview): string {
  return `${preview.slug ?? slugify(preview.title)}.md`;
}

function MissingImage({ target, uploaded }: { target: string; uploaded: boolean }) {
  if (uploaded) {
    return (
      <p className="text-sm text-muted-foreground">
        Image missing from the Wiki's data folder: <code className="font-mono">{target}</code>. Accepting will fail; skip this card and send the image again.
      </p>
    );
  }
  return (
    <p className="text-sm text-muted-foreground">
      Image not found in the notes folder: <code className="font-mono">{target}</code>; it will be kept as written.
    </p>
  );
}

interface PreviewSectionProps {
  cardId: string;
  uploaded: boolean;
  version: string;
  flush: () => Promise<boolean>;
}

function PreviewSection({ cardId, uploaded, version, flush }: PreviewSectionProps) {
  const [open, setOpen] = useState(false);
  const { previews, missingImages, error } = usePreview(cardId, open, version, flush);
  return (
    <section className="flex flex-col gap-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`preview-${cardId}`}
        onClick={() => setOpen(!open)}
        className="inline-flex cursor-pointer items-center gap-1 self-start rounded-md text-sm font-medium text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Icon name={open ? "ChevronDown" : "ChevronRight"} className="size-4 text-muted-foreground" />
        Preview change
      </button>
      {!open ? null : (
        <div id={`preview-${cardId}`} className="flex flex-col gap-3">
          {error !== null ? <ErrorText>{error}</ErrorText> : null}
          {missingImages.map((target) => (
            <MissingImage key={target} target={target} uploaded={uploaded} />
          ))}
          {previews === null ? (
            error === null ? (
              <p className="text-sm text-muted-foreground">Building preview…</p>
            ) : null
          ) : previews.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing will be written. {NO_CONTENT}</p>
          ) : (
            previews.map((preview) => (
              <div key={preview.destinationId} className="overflow-hidden rounded-md border border-border">
                <p className="border-b border-border bg-surface-raised px-3 py-1.5 text-xs font-medium text-foreground">
                  {preview.slug === null ? `New doc: ${preview.title}` : preview.title}
                </p>
                <Diff patch={preview.patch} path={previewPath(preview)} showLineNumbers={false} />
              </div>
            ))
          )}
        </div>
      )}
    </section>
  );
}

function acceptBlocker(card: Card, draft: CardDraft): string | null {
  if (card.status === "routing") return "Claude Code is still choosing destinations.";
  if (card.status !== "pending") return "This card was already handled.";
  if (!hasContentToAdd(draft.destinations)) return NO_CONTENT;
  return null;
}

function targetSlug(target: DocTarget | undefined): string | null {
  return target?.kind === "existing" ? target.slug : null;
}

function acceptedToast(card: Card, before: readonly Destination[], docs: DocIndex) {
  const named = new Map(before.map((destination) => [destination.id, targetTitle(destination.target, docs)]));
  const titleOf = (destination: Destination) => {
    const slug = targetSlug(destination.target);
    const known = slug === null ? undefined : docs.get(slug)?.title;
    return known ?? named.get(destination.id) ?? targetTitle(destination.target, docs);
  };
  const included = includedDestinations(card.destinations);
  const titles = included.map(titleOf);
  const opened = included.find((destination) => destination.role === "content" && targetSlug(destination.target) !== null) ?? included.find((destination) => targetSlug(destination.target) !== null);
  return { message: titles.length === 0 ? "Added to the Wiki" : `Added to ${titles.join(", ")}`, slug: targetSlug(opened?.target) };
}

interface CardViewProps {
  card: Card;
  docs: readonly DocSummary[];
  position: { index: number; total: number };
  onPrev: (() => void) | null;
  onNext: (() => void) | null;
  onResolved: (card: Card) => void;
}

export function CardView({ card, docs, position, onPrev, onNext, onResolved }: CardViewProps) {
  const rpc = useWikiRpc();
  const navigate = useBbNavigate();
  const docIndex = useMemo<DocIndex>(() => new Map(docs.map((doc) => [doc.slug, doc])), [docs]);
  const { draft, update, flush, discard, savedCount, saveError } = useCardDraft(card);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState<"accept" | "skip" | null>(null);
  const anchorLine = useRef<number | null>(null);
  const inScope = useKeyScope();
  const routing = card.status === "routing";
  const editable = !routing && busy === null;
  const active = draft.destinations.find((destination) => destination.id === activeId && destination.role === "content") ?? null;
  const suggestions = pendingSuggestions(card.tagSuggestions, draft.rememberAliases, dismissed);
  const blocker = acceptBlocker(card, draft);

  const setDestinations = (destinations: Destination[]) => update({ ...draft, destinations });

  const onLineClick = (index: number, extend: boolean) => {
    if (active === null || !editable) return;
    const from = anchorLine.current;
    const selection =
      extend && from !== null ? selectLineRange(active.lineRanges, from, index, card.lines.length) : toggleLine(active.lineRanges, index, card.lines.length);
    anchorLine.current = index;
    if (selection === null) {
      toast("Keep at least one line, or turn this destination off.");
      return;
    }
    setDestinations(updateDestination(draft.destinations, active.id, { lineRanges: selection }));
  };

  const accept = useCallback(async () => {
    if (busy !== null || blocker !== null) return;
    setBusy("accept");
    try {
      if (!(await flush())) throw new Error("Couldn't save your edits to this card. Try again.");
      const accepted = await rpc.call("acceptCard", { id: card.id });
      const { message, slug } = acceptedToast(accepted, draft.destinations, docIndex);
      const openDoc = { label: "Open", onClick: () => navigate.toPluginPanel(WIKI_PANEL, { subPath: docSubPath(slug ?? "") }) };
      toast.success(message, slug === null ? undefined : { action: openDoc });
      onResolved(accepted);
    } catch (cause) {
      toast.error(errorMessage(cause));
      setBusy(null);
    }
  }, [busy, blocker, flush, rpc, card.id, draft.destinations, docIndex, navigate, onResolved]);

  const skip = useCallback(async () => {
    if (busy !== null) return;
    setBusy("skip");
    discard();
    try {
      await flush();
      const skipped = await rpc.call("skipCard", { id: card.id });
      const undo = async () => {
        try {
          await rpc.call("restoreCard", { id: skipped.id });
          restoredCards.emit(skipped.id);
          navigate.toPluginPanel(WIKI_PANEL, { subPath: inboxSubPath(skipped.id) });
          toast.success("Restored to the inbox.");
        } catch (cause) {
          toast.error(errorMessage(cause));
        }
      };
      toast("Skipped. This note won't come back.", { action: { label: "Undo", onClick: () => void undo() } });
      onResolved(skipped);
    } catch (cause) {
      toast.error(errorMessage(cause));
      setBusy(null);
    }
  }, [busy, discard, flush, rpc, card.id, navigate, onResolved]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target) || !inScope(event)) return;
      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      if (key === "Escape" && activeId !== null) {
        event.preventDefault();
        setActiveId(null);
        return;
      }
      const decide = key === "a" ? accept : key === "s" ? skip : null;
      const move = key === "j" || key === "ArrowDown" ? onNext : key === "k" || key === "ArrowUp" ? onPrev : null;
      const action = event.repeat ? move : (decide ?? move);
      if (action === null) return;
      event.preventDefault();
      void action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [accept, skip, onNext, onPrev, activeId, inScope]);

  const acceptSuggestion = (suggestion: TagSuggestion) => update(acceptTagSuggestion(draft, suggestion));
  const forgetAlias = (tag: string) => update({ ...draft, rememberAliases: draft.rememberAliases.filter((alias) => alias.tag !== tag) });

  return (
    <article className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 pt-4 md:px-6" aria-label="Inbox card">
      <header className="flex flex-wrap items-center gap-2">
        <SourceChip card={card} />
        {routing ? (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <Spinner />
            Claude Code is choosing destinations…
          </span>
        ) : null}
        <span className="text-xs text-muted-foreground" title={new Date(card.createdAt).toLocaleString()}>
          {formatDate(card.createdAt)}
        </span>
        <span className="flex-1" />
        <span className="text-xs tabular-nums text-muted-foreground">
          {position.index + 1} of {position.total}
        </span>
        <Button variant="ghost" size="icon" className="size-7" disabled={onPrev === null} aria-label="Previous card (K)" onClick={() => onPrev?.()}>
          <Icon name="ChevronUp" />
        </Button>
        <Button variant="ghost" size="icon" className="size-7" disabled={onNext === null} aria-label="Next card (J)" onClick={() => onNext?.()}>
          <Icon name="ChevronDown" />
        </Button>
      </header>

      <CardLines cardId={card.id} lines={card.lines} active={editable ? active : null} onLineClick={onLineClick} />
      {active !== null && editable ? (
        <p className="-mt-2 text-xs text-muted-foreground">
          Click line numbers to choose what goes to <span className="text-foreground">{targetTitle(active.target, docIndex)}</span>. Shift-click selects a
          range. <Kbd>Esc</Kbd> when done.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
        <span>Decided by</span>
        <RuleBadge rule={card.rule} />
        {card.rule === "tag" ? card.tags.map((tag) => <TagChip key={tag} tag={tag} />) : null}
        {card.reason === "" ? null : <span className="min-w-0 basis-full text-foreground sm:basis-auto">{card.reason}</span>}
      </div>

      <DidYouMean groups={suggestions} disabled={!editable} onAccept={acceptSuggestion} onDismiss={(tag) => setDismissed(new Set(dismissed).add(tag))} />

      <section aria-label="Destinations" className="flex flex-col gap-2">
        <h2 className="text-xs font-medium text-muted-foreground">Destinations</h2>
        {draft.destinations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No destination yet. Add one to file this note.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {draft.destinations.map((destination) => (
              <DestinationRow
                key={destination.id}
                destination={destination}
                docs={docIndex}
                lineCount={card.lines.length}
                active={destination.id === activeId}
                disabled={!editable || destination.written === true}
                onChange={(next) => setDestinations(draft.destinations.map((candidate) => (candidate.id === next.id ? next : candidate)))}
                onRemove={() => {
                  if (destination.id === activeId) setActiveId(null);
                  setDestinations(removeDestination(draft.destinations, destination.id));
                }}
                onToggleActive={() => {
                  anchorLine.current = null;
                  setActiveId(destination.id === activeId ? null : destination.id);
                }}
              />
            ))}
          </ul>
        )}
        <AddDestination disabled={!editable || draft.destinations.length >= LIMITS.destinations} onAdd={(target) => setDestinations([...draft.destinations, createDestination(draft.destinations, target)])} />
        <RememberedAliases draft={draft} docs={docIndex} disabled={!editable} onForget={forgetAlias} />
        {saveError === null ? null : <ErrorText>Couldn't save this change: {saveError}</ErrorText>}
      </section>

      <PreviewSection cardId={card.id} uploaded={card.source.kind === "upload"} version={`${card.updatedAt}:${savedCount}`} flush={flush} />

      <footer className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-2 border-t border-border bg-background px-4 py-3 md:-mx-6 md:px-6">
        <Button disabled={blocker !== null || busy !== null} aria-describedby={blocker === null ? undefined : `blocker-${card.id}`} onClick={() => void accept()}>
          {busy === "accept" ? <Spinner className="text-background" /> : <Icon name="Check" />}
          Accept
          <Kbd className="border-background/30 text-background/70">A</Kbd>
        </Button>
        <Button variant="outline" disabled={busy !== null} onClick={() => void skip()}>
          Skip
          <Kbd>S</Kbd>
        </Button>
        {blocker === null ? null : (
          <span id={`blocker-${card.id}`} className="text-xs text-muted-foreground">
            {blocker}
          </span>
        )}
      </footer>
    </article>
  );
}
