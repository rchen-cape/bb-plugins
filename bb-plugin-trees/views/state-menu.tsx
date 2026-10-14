import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "@bb/shared-ui/icon";
import { cn } from "@bb/shared-ui/lib/utils";
import type { NodeState } from "../src/model";
import { STATE_DOT_CLASS, STATE_TEXT_CLASS } from "./node-visuals";

export interface StateOption<T extends string> {
  value: T;
  label: string;
  state: NodeState;
  /** A state the graph decides. It can be current, but it cannot be chosen. */
  readOnly?: boolean;
}

export interface StateMenuProps<T extends string> {
  label: string;
  value: T;
  state: NodeState;
  options: readonly StateOption<T>[];
  disabled: boolean;
  onChange: (value: T) => void;
}

function Dot({ state }: { state: NodeState }) {
  return (
    <span
      className={cn("size-1.5 shrink-0 rounded-full", STATE_DOT_CLASS[state])}
      aria-hidden
    />
  );
}

export function StateMenu<T extends string>({
  label,
  value,
  state,
  options,
  disabled,
  onChange,
}: StateMenuProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const idPrefix = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const choosable = options.filter((option) => option.readOnly !== true);
  const current = options.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node) {
        if (root.contains(event.target)) return;
      }
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    itemRefs.current[active]?.focus();
  }, [active, open]);

  const openAt = (index: number) => {
    const start = Math.max(
      0,
      choosable.findIndex((option) => option.value === value),
    );
    setActive(index < 0 ? start : index);
    setOpen(true);
  };

  const close = (restoreFocus: boolean) => {
    setOpen(false);
    if (restoreFocus) triggerRef.current?.focus();
  };

  const choose = (next: T) => {
    close(true);
    if (next !== value) onChange(next);
  };

  const step = (delta: number) => {
    setActive((index) => {
      const next = index + delta;
      if (next < 0) return choosable.length - 1;
      if (next >= choosable.length) return 0;
      return next;
    });
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-2 pr-1.5",
          "border-border/70 hover:border-border focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:opacity-50",
          STATE_TEXT_CLASS[state],
        )}
        onClick={() => (open ? close(false) : openAt(-1))}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          openAt(-1);
        }}
      >
        <Dot state={state} />
        <span className="text-2xs font-medium uppercase tracking-wide">
          {current?.label ?? ""}
        </span>
        <Icon name="ChevronDown" className="size-3 shrink-0" aria-hidden />
      </button>

      {open ? (
        /*
         * Anchored under the pill and never above it: a native select puts the
         * chosen option back over the trigger, which on the top row of the
         * panel means the list opens upward across the header.
         */
        <div
          role="menu"
          aria-label={label}
          className="absolute left-0 top-full z-30 mt-1 min-w-36 rounded-lg border border-border bg-popover p-1 shadow-lg"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              close(true);
              return;
            }
            if (event.key === "Tab") {
              close(false);
              return;
            }
            if (event.key === "ArrowDown") {
              event.preventDefault();
              step(1);
              return;
            }
            if (event.key === "ArrowUp") {
              event.preventDefault();
              step(-1);
            }
          }}
        >
          {choosable.map((option, index) => {
            const chosen = option.value === value;
            return (
              <button
                key={option.value}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                id={`${idPrefix}-${option.value}`}
                type="button"
                role="menuitemradio"
                aria-checked={chosen}
                tabIndex={index === active ? 0 : -1}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
                  "hover:bg-state-hover focus-visible:bg-state-hover focus-visible:outline-none",
                  chosen ? "font-medium" : "text-foreground",
                )}
                onClick={() => choose(option.value)}
              >
                <Dot state={option.state} />
                <span className="min-w-0 flex-1 truncate">{option.label}</span>
                {chosen ? (
                  <Icon
                    name="Check"
                    className="size-3 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
