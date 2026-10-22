import { describe, expect, it } from "vitest";
import { stripInlineMarkdown } from "./table.js";

describe("stripInlineMarkdown", () => {
  it("strips inline marks and links", () => {
    expect(stripInlineMarkdown("**a** *b* ==c== ~~d~~ [e](f) \\*")).toBe(
      "a b c d e *",
    );
  });

  it("keeps code span contents literal", () => {
    expect(stripInlineMarkdown("`__init__`")).toBe("__init__");
    expect(stripInlineMarkdown("`\\*` and \\*")).toBe("\\* and *");
    expect(stripInlineMarkdown("``a `b` c``")).toBe("a `b` c");
    expect(stripInlineMarkdown("[`x`](u) **`y`**")).toBe("x y");
  });
});
