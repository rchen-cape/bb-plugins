import { syntaxTree } from "@codemirror/language";
import type { EditorState, TransactionSpec } from "@codemirror/state";
import { WidgetType, type EditorView } from "@codemirror/view";
import {
  sameTable,
  stripInlineMarkdown,
  type TableAlign,
  type TableCell,
  type TableModel,
} from "./table.js";

const BULLETS = ["•", "◦", "▪"] as const;

export function bulletSymbol(depth: number): string {
  if (depth <= 1) return BULLETS[0];
  if (depth === 2) return BULLETS[1];
  return BULLETS[2];
}

export class BulletWidget extends WidgetType {
  constructor(readonly symbol: string) {
    super();
  }

  override eq(other: BulletWidget): boolean {
    return other.symbol === this.symbol;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-bullet";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.symbol;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export function taskToggle(
  state: EditorState,
  pos: number,
): TransactionSpec | null {
  const line = state.doc.lineAt(pos);
  const markers: number[] = [];
  syntaxTree(state).iterate({
    from: line.from,
    to: line.to,
    enter(node) {
      if (markers.length > 0) return false;
      if (node.name === "TaskMarker") {
        markers.push(node.from);
        return false;
      }
      return undefined;
    },
  });
  const found = markers[0];
  if (found === undefined) return null;
  const at = found + 1;
  const current = state.doc.sliceString(at, at + 1);
  return {
    changes: { from: at, to: at + 1, insert: current === " " ? "x" : " " },
    userEvent: "input.toggle",
  };
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-checkbox-wrap";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "cm-lp-checkbox";
    input.tabIndex = -1;
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "Completed task" : "Task");
    input.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    input.addEventListener("click", () => {
      const spec = taskToggle(view.state, view.posAtDOM(wrap));
      if (spec === null) {
        input.checked = this.checked;
        return;
      }
      view.dispatch(spec);
    });
    wrap.append(input);
    return wrap;
  }

  override updateDOM(dom: HTMLElement): boolean {
    const input = dom.querySelector("input");
    if (input === null) return false;
    input.checked = this.checked;
    input.setAttribute("aria-label", this.checked ? "Completed task" : "Task");
    return true;
  }

  override ignoreEvent(event: Event): boolean {
    return (
      event.type === "mousedown" ||
      event.type === "click" ||
      event.type === "mouseup"
    );
  }
}

export class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-hr";
    span.setAttribute("role", "separator");
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export class CodeLabelWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  override eq(other: CodeLabelWidget): boolean {
    return other.label === this.label;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-code-label";
    span.textContent = this.label;
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "m4v", "ogv"]);

export function isVideoSource(src: string): boolean {
  const path = src.split(/[?#]/)[0] ?? "";
  const dot = path.lastIndexOf(".");
  return dot >= 0 && VIDEO_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly url: string,
    readonly alt: string,
    readonly video: boolean,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      other.url === this.url &&
      other.alt === this.alt &&
      other.video === this.video
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("span");
    wrap.className = "cm-lp-media";
    if (this.video) {
      const video = document.createElement("video");
      video.className = "cm-lp-image";
      video.controls = true;
      video.preload = "metadata";
      video.src = this.url;
      video.setAttribute("aria-label", this.alt);
      video.addEventListener("loadedmetadata", () => view.requestMeasure());
      wrap.append(video);
    } else {
      const image = document.createElement("img");
      image.className = "cm-lp-image";
      image.src = this.url;
      image.alt = this.alt;
      image.loading = "lazy";
      image.addEventListener("load", () => view.requestMeasure());
      wrap.append(image);
    }
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

function alignStyle(align: TableAlign): string {
  return align === null ? "" : align;
}

function cellElement(
  tag: "th" | "td",
  cell: TableCell,
  align: TableAlign,
): HTMLTableCellElement {
  const element = document.createElement(tag);
  element.textContent = stripInlineMarkdown(cell.text);
  element.dataset.lpOffset = String(cell.to);
  const textAlign = alignStyle(align);
  if (textAlign !== "") element.style.textAlign = textAlign;
  return element;
}

export class TableWidget extends WidgetType {
  constructor(readonly model: TableModel) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return sameTable(other.model, this.model);
  }

  override get estimatedHeight(): number {
    return (this.model.rows.length + 1) * 33 + 16;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-table-wrap";
    const table = document.createElement("table");
    table.className = "cm-lp-table";
    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    this.model.header.forEach((cell, index) => {
      headRow.append(cellElement("th", cell, this.model.align[index] ?? null));
    });
    head.append(headRow);
    table.append(head);
    if (this.model.rows.length > 0) {
      const body = document.createElement("tbody");
      for (const row of this.model.rows) {
        const tr = document.createElement("tr");
        row.forEach((cell, index) => {
          tr.append(cellElement("td", cell, this.model.align[index] ?? null));
        });
        body.append(tr);
      }
      table.append(body);
    }
    wrap.append(table);
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      const cell = target.closest("[data-lp-offset]");
      if (!(cell instanceof HTMLElement)) return;
      event.preventDefault();
      const offset = Number(cell.dataset.lpOffset);
      const start = view.posAtDOM(wrap);
      const anchor = Math.min(
        view.state.doc.length,
        start + (Number.isFinite(offset) ? offset : 0),
      );
      view.dispatch({ selection: { anchor }, userEvent: "select.pointer" });
      view.focus();
    });
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export class FrontmatterWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  override eq(other: FrontmatterWidget): boolean {
    return other.label === this.label;
  }

  override get estimatedHeight(): number {
    return 24;
  }

  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-lp-frontmatter";
    wrap.textContent = this.label;
    wrap.setAttribute("role", "button");
    wrap.setAttribute("aria-label", `Show ${this.label.toLowerCase()}`);
    wrap.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const start = view.posAtDOM(wrap);
      const anchor = Math.min(view.state.doc.length, start + 4);
      view.dispatch({ selection: { anchor }, userEvent: "select.pointer" });
      view.focus();
    });
    return wrap;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

export class HintWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  override eq(other: HintWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-hint";
    span.setAttribute("aria-hidden", "true");
    span.textContent = this.text;
    return span;
  }
}

export class HiddenBlockWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  override get estimatedHeight(): number {
    return 0;
  }

  toDOM(): HTMLElement {
    const element = document.createElement("div");
    element.className = "cm-lp-hidden-block";
    return element;
  }
}

export class IndentWidget extends WidgetType {
  constructor(readonly level: number) {
    super();
  }

  override eq(other: IndentWidget): boolean {
    return other.level === this.level;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "cm-lp-indent";
    span.style.width = `${this.level * 1.5}em`;
    span.setAttribute("aria-hidden", "true");
    return span;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}
