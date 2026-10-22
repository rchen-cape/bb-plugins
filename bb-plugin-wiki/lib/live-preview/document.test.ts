import { describe, expect, it } from "vitest";
import { EditorState, Transaction } from "@codemirror/state";
import {
  contentVersion,
  externalChange,
  minimalChange,
  openDocument,
  saveDocument,
} from "./document.js";

function roundTrip(content: string): string {
  const opened = openDocument(content);
  return saveDocument(
    EditorState.create({ doc: opened.text }).doc,
    opened.format,
  );
}

describe("openDocument and saveDocument", () => {
  it("round-trips LF files byte for byte", () => {
    const content = "# Title\n\nbody\n";
    expect(openDocument(content).format).toEqual({
      lineSeparator: "\n",
      bom: false,
    });
    expect(roundTrip(content)).toBe(content);
  });

  it("round-trips CRLF files byte for byte", () => {
    const content = "# Title\r\n\r\nbody\r\nlast";
    const opened = openDocument(content);
    expect(opened.format).toEqual({ lineSeparator: "\r\n", bom: false });
    expect(opened.text).toBe("# Title\n\nbody\nlast");
    expect(roundTrip(content)).toBe(content);
  });

  it("round-trips CR-only files byte for byte", () => {
    const content = "a\rb\r\rc\r";
    const opened = openDocument(content);
    expect(opened.format).toEqual({ lineSeparator: "\r", bom: false });
    expect(opened.text).toBe("a\nb\n\nc\n");
    expect(roundTrip(content)).toBe(content);
    expect(openDocument("a\r\nb\rc\r\n").format.lineSeparator).toBe("\r\n");
  });

  it("strips and restores a BOM", () => {
    const content = "﻿---\ntitle: X\n---\r\n";
    const lf = "﻿a\nb\n";
    expect(openDocument(lf).text).toBe("a\nb\n");
    expect(openDocument(lf).format.bom).toBe(true);
    expect(roundTrip(lf)).toBe(lf);
    const crlf = "﻿a\r\nb\r\n";
    expect(roundTrip(crlf)).toBe(crlf);
    expect(openDocument(content).text.startsWith("---")).toBe(true);
  });

  it("normalizes mixed endings to the majority", () => {
    expect(openDocument("a\r\nb\r\nc\nd").format.lineSeparator).toBe("\r\n");
    expect(roundTrip("a\r\nb\r\nc\nd")).toBe("a\r\nb\r\nc\r\nd");
    expect(openDocument("a\nb\nc\r\nd").format.lineSeparator).toBe("\n");
    expect(roundTrip("a\nb\nc\r\nd")).toBe("a\nb\nc\nd");
    expect(openDocument("a\r\nb\n").format.lineSeparator).toBe("\n");
    expect(openDocument("a\rb").text).toBe("a\nb");
  });

  it("handles empty content", () => {
    expect(roundTrip("")).toBe("");
    expect(roundTrip("﻿")).toBe("﻿");
  });
});

describe("contentVersion", () => {
  it("is stable and distinguishes content", () => {
    expect(contentVersion("hello")).toBe(contentVersion("hello"));
    expect(contentVersion("hello")).not.toBe(contentVersion("hellp"));
    expect(contentVersion("")).toBe(contentVersion(""));
    expect(Number.isSafeInteger(contentVersion("some longer text é中"))).toBe(
      true,
    );
  });

  it("returns to the saved id after undoing back to the saved text", () => {
    const saved = "line one\nline two";
    const id = contentVersion(saved);
    const edited = `${saved}!`;
    expect(contentVersion(edited)).not.toBe(id);
    expect(contentVersion(edited.slice(0, -1))).toBe(id);
  });
});

describe("minimalChange", () => {
  it("returns null for identical text", () => {
    expect(minimalChange("same", "same")).toBeNull();
  });

  it("finds the changed middle", () => {
    expect(minimalChange("hello world", "hello brave world")).toEqual({
      from: 6,
      to: 6,
      insert: "brave ",
    });
    expect(minimalChange("abcdef", "abXYef")).toEqual({
      from: 2,
      to: 4,
      insert: "XY",
    });
    expect(minimalChange("abc", "")).toEqual({ from: 0, to: 3, insert: "" });
    expect(minimalChange("", "abc")).toEqual({ from: 0, to: 0, insert: "abc" });
  });

  it("does not let prefix and suffix overlap on repeated text", () => {
    const change = minimalChange("aaa", "aaaa");
    expect(change).not.toBeNull();
    if (change === null) return;
    expect(
      "aaa".slice(0, change.from) + change.insert + "aaa".slice(change.to),
    ).toBe("aaaa");
  });

  it("does not split surrogate pairs", () => {
    const oldText = "x\u{1F600}y";
    const newText = "x\u{1F601}y";
    const change = minimalChange(oldText, newText);
    expect(change).toEqual({ from: 1, to: 3, insert: "\u{1F601}" });
  });

  it("applies cleanly to an editor state", () => {
    const oldText = "# A\n\none\ntwo\n";
    const newText = "# A\n\none\n2\ntwo\n";
    const change = minimalChange(oldText, newText);
    if (change === null) throw new Error("expected a change");
    const state = EditorState.create({
      doc: oldText,
      selection: { anchor: 2 },
    });
    const next = state.update({
      changes: change,
      annotations: [
        externalChange.of(true),
        Transaction.addToHistory.of(false),
      ],
    });
    expect(next.state.doc.toString()).toBe(newText);
    expect(next.state.selection.main.head).toBe(2);
    expect(next.annotation(externalChange)).toBe(true);
  });
});
