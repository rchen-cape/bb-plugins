import {
  type EditorSelection,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { EditorView, ViewPlugin, type PluginValue } from "@codemirror/view";

export interface PreviewFreeze {
  readonly focused: boolean;
  readonly selection: EditorSelection;
}

export interface PreviewStateValue {
  readonly focused: boolean;
  readonly pointerSelecting: boolean;
  readonly frozen: PreviewFreeze | null;
}

export const setPreviewFocus = StateEffect.define<boolean>();
export const setPointerSelecting = StateEffect.define<boolean>();

const initialValue: PreviewStateValue = {
  focused: false,
  pointerSelecting: false,
  frozen: null,
};

export const previewStateField = StateField.define<PreviewStateValue>({
  create: () => initialValue,
  update(value, tr) {
    let next = value;
    for (const effect of tr.effects) {
      if (effect.is(setPreviewFocus)) {
        next = effect.value
          ? { ...next, focused: true }
          : { focused: false, pointerSelecting: false, frozen: null };
      } else if (effect.is(setPointerSelecting)) {
        next = effect.value
          ? {
              ...next,
              pointerSelecting: true,
              frozen: next.frozen ?? {
                focused: next.focused,
                selection: tr.startState.selection,
              },
            }
          : { ...next, pointerSelecting: false, frozen: null };
      }
    }
    if (next.frozen !== null && tr.docChanged) {
      next = {
        ...next,
        frozen: {
          focused: next.frozen.focused,
          selection: next.frozen.selection.map(tr.changes),
        },
      };
    }
    return next;
  },
});

const RELEASE_EVENTS = ["mouseup", "dragend", "drop"] as const;

class PointerTracker implements PluginValue {
  private readonly document: Document;
  private listening = false;

  constructor(private readonly view: EditorView) {
    this.document = view.dom.ownerDocument;
  }

  private readonly release = (): void => {
    this.stopListening();
    if (
      this.view.state.field(previewStateField, false)?.pointerSelecting === true
    ) {
      this.view.dispatch({ effects: setPointerSelecting.of(false) });
    }
  };

  private readonly move = (event: MouseEvent): void => {
    if (event.buttons === 0) this.release();
  };

  start(): void {
    if (!this.listening) {
      for (const type of RELEASE_EVENTS)
        this.document.addEventListener(type, this.release, true);
      this.document.addEventListener("mousemove", this.move, true);
      this.document.defaultView?.addEventListener("blur", this.release);
      this.listening = true;
    }
    this.view.dispatch({ effects: setPointerSelecting.of(true) });
  }

  private stopListening(): void {
    if (this.listening) {
      for (const type of RELEASE_EVENTS)
        this.document.removeEventListener(type, this.release, true);
      this.document.removeEventListener("mousemove", this.move, true);
      this.document.defaultView?.removeEventListener("blur", this.release);
      this.listening = false;
    }
  }

  destroy(): void {
    this.stopListening();
  }
}

const pointerTracker = ViewPlugin.fromClass(PointerTracker, {
  eventHandlers: {
    mousedown(event, view) {
      if (event.button !== 0) return false;
      const target = event.target;
      if (!(target instanceof Node) || !view.contentDOM.contains(target))
        return false;
      this.start();
      return false;
    },
  },
});

export const previewState: Extension = [
  previewStateField,
  EditorView.focusChangeEffect.of((_state, focusing) =>
    setPreviewFocus.of(focusing),
  ),
  pointerTracker,
];

export function previewValue(state: EditorState): PreviewStateValue {
  return state.field(previewStateField, false) ?? initialValue;
}

export function revealEnabled(state: EditorState): boolean {
  const value = previewValue(state);
  return value.frozen === null ? value.focused : value.frozen.focused;
}

export function revealSelection(state: EditorState): EditorSelection {
  return previewValue(state).frozen?.selection ?? state.selection;
}

export function selectionTouches(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  for (const range of revealSelection(state).ranges) {
    if (range.from <= to && range.to >= from) return true;
  }
  return false;
}

export function isRevealed(
  state: EditorState,
  from: number,
  to: number,
): boolean {
  return revealEnabled(state) && selectionTouches(state, from, to);
}
