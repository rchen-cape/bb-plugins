import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils";
import { Icon } from "./ui/icon";

export const ISLAND_CLASS = "rounded-lg border border-border bg-popover/95 shadow-md backdrop-blur";

export function Island({ className, children, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn(ISLAND_CLASS, className)} {...props}>
      {children}
    </div>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded border border-border px-1 font-mono text-xs leading-none text-muted-foreground",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({ className, label }: { className?: string; label?: string }) {
  return <Icon name="Spinner" className={cn("size-3.5 shrink-0 animate-spin text-muted-foreground", className)} aria-label={label} />;
}

export function ErrorText({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p role="alert" className={cn("text-sm text-destructive", className)}>
      {children}
    </p>
  );
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const TYPING_SELECTOR = [
  "input:not([type='checkbox']):not([type='radio']):not([type='button']):not([type='range']):not([type='color'])",
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

const CONTROL_SELECTOR = "button, a[href], input, select, textarea, [role='button'], [role='menuitem'], [role='radio'], [role='option'], [role='slider']";

export function isControlTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest(CONTROL_SELECTOR) !== null;
}

export const SKETCH_ROOT_SELECTOR = "[data-sketch-root]";

export function keepRootFocus(event: MouseEvent<HTMLElement>): void {
  if (event.defaultPrevented) return;
  event.preventDefault();
  const root = event.currentTarget.closest<HTMLElement>(SKETCH_ROOT_SELECTOR);
  if (root !== null && root.ownerDocument.activeElement !== root) root.focus({ preventScroll: true });
}
