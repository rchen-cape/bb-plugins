import {
  StateField,
  type EditorState,
  type Extension,
  type StateCommand,
} from "@codemirror/state";
import {
  showTooltip,
  type EditorView,
  type Tooltip,
  type TooltipView,
  type ViewUpdate,
} from "@codemirror/view";
import {
  insertLink,
  linkActive,
  markActive,
  toggleMark,
  type MarkKind,
} from "./commands.js";
import { isInsideCode } from "./decorations.js";
import { previewValue } from "./state.js";

export type ToolbarKind = MarkKind | "link";

export interface ToolbarButtonSpec {
  readonly kind: ToolbarKind;
  readonly label: string;
  readonly shortcut: { readonly mac: string; readonly other: string };
  readonly icon: readonly IconPart[];
}

type IconPart =
  | { readonly tag: "path"; readonly d: string }
  | {
      readonly tag: "line";
      readonly x1: number;
      readonly y1: number;
      readonly x2: number;
      readonly y2: number;
    }
  | { readonly tag: "polyline"; readonly points: string };

export const TOOLBAR_BUTTONS: readonly ToolbarButtonSpec[] = [
  {
    kind: "highlight",
    label: "Highlight",
    shortcut: { mac: "⌘⇧H", other: "Ctrl+Shift+H" },
    icon: [
      { tag: "path", d: "m9 11-6 6v3h9l3-3" },
      {
        tag: "path",
        d: "m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4",
      },
    ],
  },
  {
    kind: "bold",
    label: "Bold",
    shortcut: { mac: "⌘B", other: "Ctrl+B" },
    icon: [
      {
        tag: "path",
        d: "M6 12h9a4 4 0 0 1 0 8H7a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h7a4 4 0 0 1 0 8",
      },
    ],
  },
  {
    kind: "italic",
    label: "Italic",
    shortcut: { mac: "⌘I", other: "Ctrl+I" },
    icon: [
      { tag: "line", x1: 19, y1: 4, x2: 10, y2: 4 },
      { tag: "line", x1: 14, y1: 20, x2: 5, y2: 20 },
      { tag: "line", x1: 15, y1: 4, x2: 9, y2: 20 },
    ],
  },
  {
    kind: "strike",
    label: "Strikethrough",
    shortcut: { mac: "⌘⇧S", other: "Ctrl+Shift+S" },
    icon: [
      { tag: "path", d: "M16 4H9a3 3 0 0 0-2.83 4" },
      { tag: "path", d: "M14 12a4 4 0 0 1 0 8H6" },
      { tag: "line", x1: 4, y1: 12, x2: 20, y2: 12 },
    ],
  },
  {
    kind: "code",
    label: "Code",
    shortcut: { mac: "⌘E", other: "Ctrl+E" },
    icon: [
      { tag: "polyline", points: "16 18 22 12 16 6" },
      { tag: "polyline", points: "8 6 2 12 8 18" },
    ],
  },
  {
    kind: "link",
    label: "Link",
    shortcut: { mac: "⌘K", other: "Ctrl+K" },
    icon: [
      {
        tag: "path",
        d: "M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71",
      },
      {
        tag: "path",
        d: "M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71",
      },
    ],
  },
];

const SVG_NS = "http://www.w3.org/2000/svg";

function iconElement(parts: readonly IconPart[]): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  for (const part of parts) {
    const element = document.createElementNS(SVG_NS, part.tag);
    switch (part.tag) {
      case "path":
        element.setAttribute("d", part.d);
        break;
      case "line":
        element.setAttribute("x1", String(part.x1));
        element.setAttribute("y1", String(part.y1));
        element.setAttribute("x2", String(part.x2));
        element.setAttribute("y2", String(part.y2));
        break;
      case "polyline":
        element.setAttribute("points", part.points);
        break;
    }
    svg.append(element);
  }
  return svg;
}

function onMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

export function toolbarCommand(kind: ToolbarKind): StateCommand {
  return kind === "link" ? insertLink : toggleMark(kind);
}

export function toolbarPressed(state: EditorState, kind: ToolbarKind): boolean {
  return kind === "link" ? linkActive(state) : markActive(state, kind);
}

class ToolbarView implements TooltipView {
  readonly dom: HTMLElement;
  private readonly buttons: {
    readonly kind: ToolbarKind;
    readonly element: HTMLButtonElement;
  }[] = [];

  constructor(private readonly view: EditorView) {
    const mac = onMac();
    this.dom = document.createElement("div");
    this.dom.className = "cm-lp-toolbar";
    this.dom.setAttribute("role", "toolbar");
    this.dom.setAttribute("aria-label", "Formatting");
    this.dom.addEventListener("mousedown", (event) => {
      event.preventDefault();
    });
    for (const spec of TOOLBAR_BUTTONS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className =
        spec.kind === "highlight"
          ? "cm-lp-toolbar-button cm-lp-toolbar-highlight"
          : "cm-lp-toolbar-button";
      button.setAttribute("aria-label", spec.label);
      button.title = `${spec.label} (${mac ? spec.shortcut.mac : spec.shortcut.other})`;
      button.dataset.kind = spec.kind;
      button.append(iconElement(spec.icon));
      if (spec.kind === "highlight") {
        const swatch = document.createElement("span");
        swatch.className = "cm-lp-toolbar-swatch";
        swatch.setAttribute("aria-hidden", "true");
        button.append(swatch);
      }
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        toolbarCommand(spec.kind)(this.view);
        this.view.focus();
      });
      this.dom.append(button);
      this.buttons.push({ kind: spec.kind, element: button });
      if (spec.kind === "highlight") {
        const divider = document.createElement("span");
        divider.className = "cm-lp-toolbar-divider";
        divider.setAttribute("aria-hidden", "true");
        this.dom.append(divider);
      }
    }
    this.refresh(view.state);
  }

  private refresh(state: EditorState): void {
    for (const button of this.buttons) {
      const pressed = toolbarPressed(state, button.kind) ? "true" : "false";
      if (button.element.getAttribute("aria-pressed") !== pressed)
        button.element.setAttribute("aria-pressed", pressed);
    }
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet) this.refresh(update.state);
  }
}

function createToolbarView(view: EditorView): TooltipView {
  return new ToolbarView(view);
}

export function toolbarVisible(state: EditorState): boolean {
  const main = state.selection.main;
  if (main.empty) return false;
  const value = previewValue(state);
  if (!value.focused || value.pointerSelecting) return false;
  return !isInsideCode(state, main.from) && !isInsideCode(state, main.to);
}

function toolbarTooltip(
  state: EditorState,
  previous: Tooltip | null,
): Tooltip | null {
  if (!toolbarVisible(state)) return null;
  const main = state.selection.main;
  if (
    previous !== null &&
    previous.pos === main.from &&
    previous.end === main.to
  )
    return previous;
  return {
    pos: main.from,
    end: main.to,
    above: true,
    strictSide: false,
    arrow: false,
    create: createToolbarView,
  };
}

const toolbarField = StateField.define<Tooltip | null>({
  create: (state) => toolbarTooltip(state, null),
  update: (value, tr) =>
    tr.docChanged || tr.selection !== undefined || tr.effects.length > 0
      ? toolbarTooltip(tr.state, value)
      : value,
  provide: (field) => showTooltip.from(field),
});

export function formattingToolbar(): Extension {
  return toolbarField;
}
