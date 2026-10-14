export const AUTOSAVE_DELAY_MS = 700;

/*
 * A trailing debounce alone never fires while someone keeps typing, so a long
 * uninterrupted stretch of writing would sit unsaved. This is how long the
 * first unsaved keystroke may wait before a save goes out regardless.
 */
export const AUTOSAVE_MAX_WAIT_MS = 4000;

/**
 * How long to wait before writing, given when the oldest unsaved keystroke
 * arrived. Quiet typing gets the full debounce; continuous typing gets whatever
 * is left of the maximum wait, and nothing once that is spent.
 */
export function nextAutosaveDelayMs(args: {
  firstUnsavedAt: number;
  now: number;
}): number {
  const waited = args.now - args.firstUnsavedAt;
  return Math.max(
    0,
    Math.min(AUTOSAVE_DELAY_MS, AUTOSAVE_MAX_WAIT_MS - waited),
  );
}
