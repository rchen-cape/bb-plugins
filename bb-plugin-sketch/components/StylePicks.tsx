import { useEffect, useRef, type ReactNode } from "react";
import { isTransparent, paint, parseColor, type Theme } from "../lib/colors.js";
import { cn } from "../lib/utils";
import { keepRootFocus } from "./bits";
import type { StyleOption } from "./style-options";

const PICK_CLASS =
  "inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-state-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring aria-pressed:bg-state-active aria-pressed:text-foreground";

export function Row({ label, aside, children }: { label: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <div role="group" aria-label={label} className="grid gap-1">
      <span className="flex items-center justify-between text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
        {aside === undefined ? null : <span className="normal-case tracking-normal tabular-nums">{aside}</span>}
      </span>
      <div className="flex flex-wrap items-center gap-0.5">{children}</div>
    </div>
  );
}

export function Picks<T>({
  label,
  options,
  value,
  onPick,
}: {
  label: string;
  options: readonly StyleOption<T>[];
  value: T | undefined;
  onPick: (value: T) => void;
}) {
  return (
    <Row label={label}>
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          title={option.label}
          aria-label={option.label}
          aria-pressed={value !== undefined && option.value === value}
          className={PICK_CLASS}
          onMouseDown={keepRootFocus}
          onClick={() => onPick(option.value)}
        >
          {option.icon}
        </button>
      ))}
    </Row>
  );
}

function ColorChip({ color, theme }: { color: string; theme: Theme }) {
  if (isTransparent(color)) {
    return (
      <span className="relative size-4 overflow-hidden rounded-sm border border-border" aria-hidden="true">
        <span className="absolute left-1/2 top-[-25%] h-[150%] w-px rotate-45 bg-destructive" />
      </span>
    );
  }
  return <span className="size-4 rounded-sm border border-border" style={{ backgroundColor: paint(color, theme) }} aria-hidden="true" />;
}

function hexOf(color: string | undefined): string {
  const parsed = color === undefined ? null : parseColor(color);
  if (parsed === null) return "#000000";
  const hex = (n: number) => Math.round(n).toString(16).padStart(2, "0");
  return `#${hex(parsed.r)}${hex(parsed.g)}${hex(parsed.b)}`;
}

function CustomColor({ label, value, active, theme, onInput, onCommit }: {
  label: string;
  value: string | undefined;
  active: boolean;
  theme: Theme;
  onInput: (color: string) => void;
  onCommit: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const commit = useRef(onCommit);
  commit.current = onCommit;
  useEffect(() => {
    const input = ref.current;
    if (input === null) return;
    const onChange = () => commit.current();
    input.addEventListener("change", onChange);
    return () => input.removeEventListener("change", onChange);
  }, []);
  return (
    <label title={label} className={cn(PICK_CLASS, "relative", active && "bg-state-active text-foreground")}>
      {active && value !== undefined ? (
        <ColorChip color={value} theme={theme} />
      ) : (
        <span className="size-4 rounded-sm border border-dashed border-muted-foreground" aria-hidden="true" />
      )}
      <input
        ref={ref}
        type="color"
        aria-label={label}
        value={hexOf(value)}
        onChange={(event) => onInput(event.target.value)}
        className="absolute inset-0 size-full cursor-pointer opacity-0"
      />
    </label>
  );
}

export function ColorPicks({
  label,
  picks,
  value,
  theme,
  custom,
  onPick,
  onCommit,
}: {
  label: string;
  picks: readonly string[];
  value: string | undefined;
  theme: Theme;
  custom: boolean;
  onPick: (color: string, transient: boolean) => void;
  onCommit: () => void;
}) {
  const known = value !== undefined && picks.some((pick) => pick.toLowerCase() === value.toLowerCase());
  return (
    <Row label={label}>
      {picks.map((pick) => (
        <button
          key={pick}
          type="button"
          title={pick === "transparent" ? "Transparent" : pick}
          aria-label={pick === "transparent" ? "Transparent" : pick}
          aria-pressed={value !== undefined && pick.toLowerCase() === value.toLowerCase()}
          className={PICK_CLASS}
          onMouseDown={keepRootFocus}
          onClick={() => onPick(pick, false)}
        >
          <ColorChip color={pick} theme={theme} />
        </button>
      ))}
      {custom ? (
        <CustomColor
          label={`Custom ${label.toLowerCase()} color`}
          value={value}
          active={value !== undefined && !known}
          theme={theme}
          onInput={(color) => onPick(color, true)}
          onCommit={onCommit}
        />
      ) : null}
    </Row>
  );
}

export function OpacitySlider({ value, onInput, onCommit }: { value: number | undefined; onInput: (value: number) => void; onCommit: () => void }) {
  return (
    <Row label="Opacity" aside={value === undefined ? "Mixed" : `${value}%`}>
      <input
        type="range"
        min={0}
        max={100}
        step={10}
        aria-label="Opacity"
        value={value ?? 100}
        onChange={(event) => onInput(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        onBlur={onCommit}
        className="h-7 w-full cursor-pointer accent-foreground"
      />
    </Row>
  );
}
