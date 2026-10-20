import { describe, expect, it } from "vitest";
import { emptyScene } from "../lib/scene";
import { LIMITS } from "../lib/sketch";
import { isOpenDoc, renameDoc, type PageState } from "./page-state";
import { parseChange } from "./remote-changes";
import { rescueTitle, RESCUE_SUFFIX } from "./rescue";
import { unreadableNotice } from "./unreadable";

describe("unreadable element notices", () => {
  it("stays quiet when everything was read", () => {
    expect(unreadableNotice("Plan", { dropped: 0, placeholders: 0 })).toBeNull();
  });

  it("says what was kept and what was skipped", () => {
    expect(unreadableNotice("Plan", { dropped: 0, placeholders: 1 })).toBe("1 element in “Plan” couldn't be read. Sketch keeps it as a placeholder.");
    expect(unreadableNotice("Plan", { dropped: 2, placeholders: 0 })).toBe(
      "2 elements in “Plan” couldn't be read. They were skipped and will be left out when Sketch saves.",
    );
    expect(unreadableNotice("Plan", { dropped: 1, placeholders: 2 })).toBe(
      "3 elements in “Plan” couldn't be read. 2 are kept as placeholders; 1 was skipped and will be left out when Sketch saves.",
    );
  });
});

describe("rescue titles", () => {
  it("adds the suffix and stays within the title limit", () => {
    expect(rescueTitle("Plan")).toBe("Plan (my edits)");
    const long = rescueTitle("x".repeat(LIMITS.title));
    expect(long.length).toBe(LIMITS.title);
    expect(long.endsWith(RESCUE_SUFFIX)).toBe(true);
    const emoji = rescueTitle(`${"x".repeat(LIMITS.title - RESCUE_SUFFIX.length - 1)}😀`);
    expect(emoji).toBe(`${"x".repeat(LIMITS.title - RESCUE_SUFFIX.length - 1)}${RESCUE_SUFFIX}`);
  });
});

describe("sketch change payloads", () => {
  it("reads renames and tolerates old or broken payloads", () => {
    expect(parseChange({ id: "Plan", renamedTo: "Flow" })).toEqual({ id: "Plan", renamedTo: "Flow" });
    expect(parseChange({ id: "Plan" })).toEqual({ id: "Plan", renamedTo: null });
    expect(parseChange({ id: 3, renamedTo: "" })).toEqual({ id: null, renamedTo: null });
    expect(parseChange("nope")).toEqual({ id: null, renamedTo: null });
  });
});

describe("page state", () => {
  it("renames only the doc with the given key", () => {
    const page: PageState = { kind: "open", doc: { key: "doc-a", id: null, title: "Untitled", sha256: null, scene: emptyScene() } };
    expect(isOpenDoc(page, "doc-a")).toBe(true);
    expect(isOpenDoc(page, "doc-b")).toBe(false);
    expect(renameDoc(page, "doc-b", "B", "B")).toBe(page);
    expect(renameDoc(page, "doc-a", "A", "A")).toMatchObject({ doc: { key: "doc-a", id: "A", title: "A" } });
  });
});
