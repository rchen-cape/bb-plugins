import { useEffect, useId, useRef, useState, type KeyboardEvent, type Ref } from "react";
import type { WikiDoc, WikiSuggestion } from "../contract";
import { LIMITS } from "../lib/sketch.js";
import { cn } from "../lib/utils";
import { Field } from "./ui/field";
import { CheckIcon } from "./icons";
import { Input } from "./ui/input";
import type { DocChoice } from "./wiki-destination";
import { docOptions, headingOptions, type DocOption } from "./wiki-docs";

export const NEW_HEADING = "\u0000new-heading";

export type HeadingValue = { readonly value: string; readonly custom: string };

function OptionRow({ id, option, active, selected, onHover, onChoose }: {
  id: string;
  option: DocOption;
  active: boolean;
  selected: boolean;
  onHover: () => void;
  onChoose: () => void;
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
      aria-selected={selected}
      onMouseMove={onHover}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={cn("flex cursor-pointer items-start gap-2 px-2.5 py-1.5 text-sm", active && "bg-state-hover")}
    >
      <CheckIcon className={cn("mt-0.5 size-3.5 shrink-0", selected ? "text-foreground" : "invisible")} />
      <span className="min-w-0 flex-1">
        <span className="block truncate">
          {option.best ? <span className="text-muted-foreground">Best match: </span> : null}
          <span className="text-foreground">{option.title}</span>
          {option.heading === null ? null : <span className="text-muted-foreground"> › {option.heading}</span>}
        </span>
        {option.detail === "" ? null : <span className="block truncate text-xs text-muted-foreground">{option.detail}</span>}
      </span>
    </li>
  );
}

function emptyText(docs: readonly WikiDoc[] | undefined, query: string): string {
  if (docs === undefined) return "Loading Wiki docs…";
  if (query.trim() !== "") return "No docs match.";
  return "Your Wiki has no docs yet.";
}

export function DocSearch({ docs, suggestions, value, onChange, autoFocus, inputRef }: {
  docs: readonly WikiDoc[] | undefined;
  suggestions: readonly WikiSuggestion[];
  value: DocChoice | null;
  onChange: (choice: DocChoice) => void;
  autoFocus: boolean;
  inputRef?: Ref<HTMLInputElement>;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const options = docOptions(docs ?? [], suggestions, query);
  const optionsKey = options.map((option) => option.key).join("\n");
  useEffect(() => setActive(0), [optionsKey]);

  const choose = (index: number) => {
    const option = options[index];
    if (option !== undefined) onChange({ slug: option.slug, title: option.title, heading: option.heading });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + options.length) % options.length);
    } else if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      choose(active);
    }
  };

  return (
    <div className="grid gap-1.5">
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        type="search"
        value={query}
        maxLength={LIMITS.query}
        placeholder="Search docs by title, alias or tag…"
        aria-label="Search Wiki docs"
        role="combobox"
        aria-expanded
        aria-controls={listId}
        aria-activedescendant={options.length === 0 ? undefined : `${listId}-${active}`}
        className="h-8 text-sm"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <ul id={listId} role="listbox" aria-label="Wiki docs" className="max-h-32 overflow-y-auto rounded-md border border-border py-1">
        {options.map((option, index) => (
          <OptionRow
            key={option.key}
            id={`${listId}-${index}`}
            option={option}
            active={index === active}
            selected={value?.slug === option.slug}
            onHover={() => setActive(index)}
            onChoose={() => choose(index)}
          />
        ))}
        {options.length === 0 ? (
          <li role="presentation" className="px-3 py-2 text-xs text-muted-foreground">
            {emptyText(docs, query)}
          </li>
        ) : null}
      </ul>
    </div>
  );
}

export function HeadingPicker({ doc, preferred, value, onChange }: {
  doc: WikiDoc | undefined;
  preferred: string | null;
  value: HeadingValue;
  onChange: (next: HeadingValue) => void;
}) {
  const options = headingOptions(doc, preferred);
  return (
    <div className="grid gap-2">
      <Field label="Heading">
        <select
          value={value.value}
          onChange={(event) => onChange({ value: event.target.value, custom: value.custom })}
          className="h-8 w-full cursor-pointer rounded-md border border-input bg-background px-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          {options.map((heading) => (
            <option key={heading} value={heading}>
              {heading}
            </option>
          ))}
          <option value={NEW_HEADING}>New heading…</option>
        </select>
      </Field>
      {value.value === NEW_HEADING ? (
        <Input
          autoFocus
          value={value.custom}
          maxLength={LIMITS.heading}
          placeholder="New heading name"
          aria-label="New heading name"
          className="h-8 text-sm"
          onChange={(event) => onChange({ value: value.value, custom: event.target.value })}
        />
      ) : null}
    </div>
  );
}

export function headingText(value: HeadingValue): string {
  return value.value === NEW_HEADING ? value.custom.trim() : value.value;
}
