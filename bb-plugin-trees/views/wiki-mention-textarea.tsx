import {
  forwardRef,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type KeyboardEvent,
} from "react";
import { Textarea } from "../components/ui/textarea";
import { cn } from "../lib/utils";
import type { WikiDocRef } from "../src/wiki-links";
import {
  findMentionQuery,
  insertWikiLink,
  matchWikiDocs,
  type MentionQuery,
} from "./wiki-mention";

// The styles that decide where text wraps, copied onto the measuring copy.
const MIRRORED_STYLES = [
  "boxSizing",
  "width",
  "borderTopWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingLeft",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "lineHeight",
  "letterSpacing",
  "tabSize",
] as const;

/*
 * Where the caret sits inside the textarea, so the menu opens under the @
 * rather than under the whole box. A textarea cannot say, so an invisible
 * copy of its text up to the caret is laid out the same way and measured.
 */
function caretPosition(
  textarea: HTMLTextAreaElement,
  index: number,
): { top: number; left: number } {
  const style = window.getComputedStyle(textarea);
  const mirror = document.createElement("div");
  for (const key of MIRRORED_STYLES) mirror.style[key] = style[key];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.textContent = textarea.value.slice(0, index);
  const marker = document.createElement("span");
  marker.textContent = "​";
  mirror.append(marker);
  document.body.append(mirror);
  const lineHeight =
    Number.parseFloat(style.lineHeight) ||
    Number.parseFloat(style.fontSize) * 1.4 ||
    16;
  const position = {
    top: marker.offsetTop - textarea.scrollTop + lineHeight,
    left: Math.min(marker.offsetLeft, Math.max(0, textarea.clientWidth - 240)),
  };
  mirror.remove();
  return position;
}

export type WikiMentionTextareaProps = Omit<
  ComponentProps<"textarea">,
  "value" | "onChange"
> & {
  value: string;
  onValueChange: (value: string) => void;
  /** Docs the @ menu offers; with none, the textarea behaves as plain. */
  wikiDocs: readonly WikiDocRef[];
  wrapperClassName?: string;
};

/**
 * A textarea whose @ opens a menu of Wiki docs. Picking one replaces the
 * @query with the doc's [[slug]] link.
 */
export const WikiMentionTextarea = forwardRef<
  HTMLTextAreaElement,
  WikiMentionTextareaProps
>(function WikiMentionTextarea(
  {
    value,
    onValueChange,
    wikiDocs,
    wrapperClassName,
    onKeyDown,
    onBlur,
    onSelect,
    ...props
  },
  forwardedRef,
) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useImperativeHandle(
    forwardedRef,
    () => textareaRef.current as HTMLTextAreaElement,
  );
  const listId = useId();
  const [caret, setCaret] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pendingCaret = useRef<number | null>(null);

  const found: MentionQuery | null =
    caret === null || wikiDocs.length === 0
      ? null
      : findMentionQuery(value, caret);
  const mention = found !== null && found.start !== dismissedAt ? found : null;
  const matches = mention === null ? [] : matchWikiDocs(wikiDocs, mention.query);
  const open = mention !== null && matches.length > 0;
  const activeIndex = Math.min(active, Math.max(0, matches.length - 1));
  const position =
    open && textareaRef.current !== null
      ? caretPosition(textareaRef.current, mention.start)
      : null;

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    const next = pendingCaret.current;
    if (textarea === null || next === null) return;
    pendingCaret.current = null;
    textarea.focus();
    textarea.setSelectionRange(next, next);
    setCaret(next);
  }, [value]);

  function trackCaret(textarea: HTMLTextAreaElement): void {
    setCaret(
      textarea.selectionStart === textarea.selectionEnd
        ? textarea.selectionStart
        : null,
    );
  }

  function pick(doc: WikiDocRef): void {
    if (mention === null || caret === null) return;
    const next = insertWikiLink({ text: value, caret, mention, slug: doc.slug });
    pendingCaret.current = next.caret;
    setActive(0);
    onValueChange(next.text);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActive((activeIndex + step + matches.length) % matches.length);
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        const doc = matches[activeIndex];
        if (doc !== undefined) {
          event.preventDefault();
          pick(doc);
          return;
        }
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(mention.start);
        return;
      }
    }
    onKeyDown?.(event);
  }

  return (
    <div className={cn("relative", wrapperClassName)}>
      <Textarea
        {...props}
        ref={textareaRef}
        value={value}
        role={wikiDocs.length > 0 ? "combobox" : undefined}
        aria-autocomplete={wikiDocs.length > 0 ? "list" : undefined}
        aria-expanded={wikiDocs.length > 0 ? open : undefined}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={
          open ? `${listId}-${String(activeIndex)}` : undefined
        }
        onChange={(event) => {
          const textarea = event.target;
          trackCaret(textarea);
          setActive(0);
          // Escape closes the menu for one @; once that @ is gone, it resets.
          if (
            findMentionQuery(textarea.value, textarea.selectionStart) === null
          )
            setDismissedAt(null);
          onValueChange(textarea.value);
        }}
        onSelect={(event) => {
          trackCaret(event.currentTarget);
          onSelect?.(event);
        }}
        onKeyDown={handleKeyDown}
        onBlur={(event) => {
          setCaret(null);
          onBlur?.(event);
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Wiki docs"
          className="absolute z-20 max-h-64 w-60 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
          style={{ top: position?.top ?? 0, left: position?.left ?? 0 }}
        >
          {matches.map((doc, index) => (
            <li
              key={doc.slug}
              id={`${listId}-${String(index)}`}
              role="option"
              aria-selected={index === activeIndex}
              className={cn(
                "flex cursor-pointer flex-col rounded-sm px-2 py-1 text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
              // Keeps the textarea focused, so the pick lands at its caret.
              onMouseDown={(event) => event.preventDefault()}
              onMouseEnter={() => setActive(index)}
              onClick={() => pick(doc)}
            >
              <span className="truncate">{doc.title}</span>
              <span className="truncate text-xs text-muted-foreground">
                {doc.type === "" ? doc.slug : `${doc.type} · ${doc.slug}`}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
});
