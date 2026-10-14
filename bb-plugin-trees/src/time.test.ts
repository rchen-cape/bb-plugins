import { describe, expect, it } from "vitest";
import { formatRelativeTime } from "./time";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");

function ago(ms: number): string {
  return formatRelativeTime({ timestamp: NOW - ms, now: NOW });
}

describe("formatRelativeTime", () => {
  it("collapses anything under a minute", () => {
    expect(ago(0)).toBe("just now");
    expect(ago(59_000)).toBe("just now");
  });

  it("counts whole minutes and hours", () => {
    expect(ago(60_000)).toBe("1m ago");
    expect(ago(59 * 60_000)).toBe("59m ago");
    expect(ago(60 * 60_000)).toBe("1h ago");
    expect(ago(23 * 60 * 60_000)).toBe("23h ago");
  });

  it("names yesterday rather than counting a single day", () => {
    expect(ago(24 * 60 * 60_000)).toBe("yesterday");
    expect(ago(2 * 24 * 60 * 60_000)).toBe("2d ago");
  });

  it("switches to weeks, then to a calendar date", () => {
    expect(ago(7 * 24 * 60 * 60_000)).toBe("1w ago");
    expect(ago(4 * 7 * 24 * 60 * 60_000)).toBe("4w ago");
    expect(ago(6 * 7 * 24 * 60 * 60_000)).not.toContain("ago");
  });

  it("does not read as the future when clocks disagree", () => {
    expect(formatRelativeTime({ timestamp: NOW + 5_000, now: NOW })).toBe(
      "just now",
    );
  });
});
