import type { Point } from "../../lib/math.js";

export type PointerSample = { readonly screen: Point; readonly scene: Point; readonly pressure: number };

export type PointerInput = PointerSample & {
  readonly shift: boolean;
  readonly alt: boolean;
  readonly mod: boolean;
  readonly pointerType: string;
  readonly samples: readonly PointerSample[];
};

export interface Gesture {
  move(input: PointerInput): void;
  end(input: PointerInput): void;
  cancel(): void;
}

export const TOUCH_SLOP = 16;
