import type { ReactNode } from "react";
import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";
import type { CardRule } from "../contract";
import { DOC_TYPE_LABELS, MARK_END, MARK_START, type DocType } from "../lib/wiki";

const TYPE_TONES: Record<DocType, string> = {
  project: "border-surface-selected-border text-foreground",
  topic: "border-border text-muted-foreground",
  process: "border-border text-muted-foreground",
  service: "border-border text-foreground",
};

export function TypeBadge({ type, className }: { type: DocType; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded border px-1.5 py-px text-xs leading-4", TYPE_TONES[type], className)}>
      {DOC_TYPE_LABELS[type].one}
    </span>
  );
}

const RULE_LABELS: Record<CardRule, { label: string; title: string }> = {
  "explicit-link": { label: "explicit [[link]]", title: "The note links to this doc with [[…]], so no AI was used." },
  tag: { label: "tag", title: "An @tag in the note matches this doc's tag or alias." },
  agent: { label: "Claude Code", title: "Claude Code chose the destinations and lines. The text is still your own words." },
  none: { label: "no rule", title: "No link or known tag matched. Pick a destination yourself." },
};

export function RuleBadge({ rule, className }: { rule: CardRule; className?: string }) {
  const { label, title } = RULE_LABELS[rule];
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded-full border px-2 py-px text-xs leading-4",
        rule === "none" ? "border-dashed border-border text-muted-foreground" : "border-border text-foreground",
        className,
      )}
    >
      {rule === "agent" ? <Icon name="Bot" className="size-3" /> : null}
      {label}
    </span>
  );
}

export function Highlighted({ text }: { text: string }) {
  const parts = text.split(MARK_START);
  return (
    <>
      {parts[0]}
      {parts.slice(1).map((part, index) => {
        const [marked = "", rest = ""] = part.split(MARK_END);
        return (
          <span key={index}>
            <mark className="rounded-sm bg-foreground/15 px-0.5 text-foreground">{marked}</mark>
            {rest}
          </span>
        );
      })}
    </>
  );
}

interface EmptyStateProps {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ title, description, action, className }: EmptyStateProps) {
  return (
    <div role="status" className={cn("rounded-lg border border-dashed border-border px-4 py-6 text-center", className)}>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description === undefined ? null : <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      {action === undefined ? null : <div className="mt-3 flex flex-wrap justify-center gap-2">{action}</div>}
    </div>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("inline-flex h-5 min-w-5 items-center justify-center rounded border border-border px-1 font-mono text-xs leading-none text-muted-foreground", className)}>
      {children}
    </kbd>
  );
}

export function TagChip({ tag, active = false, className }: { tag: string; active?: boolean; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 max-w-full items-center rounded-full border px-1.5 font-mono text-xs leading-none",
        active ? "border-foreground/40 bg-foreground/10 text-foreground" : "border-border text-muted-foreground",
        className,
      )}
    >
      <span className="truncate">@{tag}</span>
    </span>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return <Icon name="Spinner" className={cn("size-3.5 shrink-0 animate-spin text-muted-foreground", className)} aria-label={label} />;
}

export function SectionLabel({ children, count, className }: { children: ReactNode; count?: number; className?: string }) {
  return (
    <p className={cn("flex items-center gap-1.5 px-3 pb-1 pt-3 text-xs font-medium text-muted-foreground", className)}>
      <span>{children}</span>
      {count === undefined ? null : <span className="tabular-nums opacity-70">{count}</span>}
    </p>
  );
}

export function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("text-sm text-destructive", className)}>
      {children}
    </p>
  );
}

export const WIKI_ICON = "WikiBookOpen";

export function WikiBookOpenIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 7v14" />
      <path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z" />
    </svg>
  );
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function startOfDay(time: number): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function calendarDate(date: Date, now: number): string {
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
}

function formatDay(match: RegExpExecArray, now: number): string {
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const days = Math.round((date.getTime() - startOfDay(now)) / 86_400_000);
  if (Math.abs(days) <= 1) return relative.format(days, "day");
  return calendarDate(date, now);
}

export function formatDate(iso: string, now = Date.now()): string {
  const day = DATE_ONLY.exec(iso);
  if (day !== null) return formatDay(day, now);
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const minutes = Math.round((date.getTime() - now) / 60_000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return relative.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return relative.format(days, "day");
  return calendarDate(date, now);
}

const TYPING_SELECTOR = [
  "input:not([type='checkbox']):not([type='radio']):not([type='button'])",
  "textarea",
  "select",
  "[contenteditable]:not([contenteditable='false'])",
  "[role='dialog']",
  "[role='menu']",
  "[role='listbox']",
  "[role='combobox']",
].join(", ");

export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(TYPING_SELECTOR) !== null;
}
