import { describe, expect, it } from "vitest";
import {
  AUTOSAVE_DELAY_MS,
  AUTOSAVE_MAX_WAIT_MS,
  nextAutosaveDelayMs,
} from "./autosave";

describe("nextAutosaveDelayMs", () => {
  it("gives a fresh keystroke the whole debounce", () => {
    expect(nextAutosaveDelayMs({ firstUnsavedAt: 1_000, now: 1_000 })).toBe(
      AUTOSAVE_DELAY_MS,
    );
  });

  /*
   * The debounce restarts on every keystroke, so without this someone writing
   * a long paragraph without pausing would have nothing on disk the whole time.
   */
  it("shortens the wait as the oldest unsaved keystroke ages", () => {
    const firstUnsavedAt = 1_000;
    const nearly = firstUnsavedAt + AUTOSAVE_MAX_WAIT_MS - 200;
    expect(nextAutosaveDelayMs({ firstUnsavedAt, now: nearly })).toBe(200);
  });

  it("writes immediately once the maximum wait is spent", () => {
    const firstUnsavedAt = 1_000;
    for (const now of [
      firstUnsavedAt + AUTOSAVE_MAX_WAIT_MS,
      firstUnsavedAt + AUTOSAVE_MAX_WAIT_MS * 3,
    ]) {
      expect(nextAutosaveDelayMs({ firstUnsavedAt, now })).toBe(0);
    }
  });

  it("never waits longer than the debounce, whatever the clock does", () => {
    expect(nextAutosaveDelayMs({ firstUnsavedAt: 5_000, now: 1_000 })).toBe(
      AUTOSAVE_DELAY_MS,
    );
  });
});
