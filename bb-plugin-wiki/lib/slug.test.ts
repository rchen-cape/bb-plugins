import { describe, expect, it } from "vitest";
import {
  basenameOfSlug,
  isSafeSlug,
  normalizeTag,
  normalizeTags,
  slugify,
  tagForSlug,
  titleFromTag,
  uniqueSlug,
  wordsFromName,
} from "./slug";
import { LIMITS } from "./wiki";

describe("slugify", () => {
  it("kebab-cases plain titles", () => {
    expect(slugify("Adding config catalog")).toBe("adding-config-catalog");
    expect(slugify("v2.0 release")).toBe("v2-0-release");
  });

  it("strips accents, apostrophes, and surrounding punctuation", () => {
    expect(slugify("  Café — Déjà vu!  ")).toBe("cafe-deja-vu");
    expect(slugify("It's Rachel’s doc")).toBe("its-rachels-doc");
    expect(slugify("--Leading and trailing--")).toBe("leading-and-trailing");
  });

  it("decomposes compatibility characters", () => {
    expect(slugify("ﬁle ①")).toBe("file-1");
  });

  it("collapses runs of symbols into one hyphen", () => {
    expect(slugify("C++ & C#")).toBe("c-c");
    expect(slugify("a___b...c")).toBe("a-b-c");
  });

  it("falls back to untitled when nothing usable is left", () => {
    expect(slugify("")).toBe("untitled");
    expect(slugify("!!!")).toBe("untitled");
    expect(slugify("日本語")).toBe("untitled");
  });

  it("clips long slugs to 80 characters without a trailing hyphen", () => {
    expect(slugify("a".repeat(100))).toBe("a".repeat(80));
    expect(slugify(`${"a".repeat(79)} b`)).toBe("a".repeat(79));
  });
});

describe("normalizeTag", () => {
  it("drops leading @ signs and kebab-cases", () => {
    expect(normalizeTag("@Unified-Notification")).toBe("unified-notification");
    expect(normalizeTag("  @@cc ")).toBe("cc");
    expect(normalizeTag("Config Catalog")).toBe("config-catalog");
    expect(normalizeTag("--x--")).toBe("x");
  });

  it("returns an empty string for tags with no usable characters", () => {
    expect(normalizeTag("@")).toBe("");
    expect(normalizeTag("   ")).toBe("");
    expect(normalizeTag("日本")).toBe("");
  });

  it("keeps an @ that is not leading out of the tag", () => {
    expect(normalizeTag("team@work")).toBe("team-work");
  });

  it("clips to the alias limit", () => {
    expect(normalizeTag("a".repeat(90))).toHaveLength(LIMITS.alias);
  });
});

describe("normalizeTags", () => {
  it("normalizes, drops empties, and dedupes in first-seen order", () => {
    expect(normalizeTags(["@CC", "cc", " ", "@", "Config Catalog", "config-catalog"])).toEqual(["cc", "config-catalog"]);
  });

  it("accepts any iterable", () => {
    expect(normalizeTags(new Set(["B", "a"]))).toEqual(["b", "a"]);
  });
});

describe("uniqueSlug", () => {
  it("returns the base when it is free", () => {
    expect(uniqueSlug("doc", () => false)).toBe("doc");
  });

  it("adds the first free numeric suffix starting at 2", () => {
    const taken = new Set(["doc", "doc-2"]);
    expect(uniqueSlug("doc", (candidate) => taken.has(candidate))).toBe("doc-3");
  });

  it("does not skip to a suffix when only a suffixed slug is taken", () => {
    const taken = new Set(["doc-2"]);
    expect(uniqueSlug("doc", (candidate) => taken.has(candidate))).toBe("doc");
  });

  it("asks about candidates in order", () => {
    const asked: string[] = [];
    uniqueSlug("doc", (candidate) => {
      asked.push(candidate);
      return asked.length < 3;
    });
    expect(asked).toEqual(["doc", "doc-2", "doc-3"]);
  });
});

describe("isSafeSlug", () => {
  it("accepts root and nested slugs", () => {
    expect(isSafeSlug("doc")).toBe(true);
    expect(isSafeSlug("projects/unified-push")).toBe(true);
    expect(isSafeSlug("a/b/c")).toBe(true);
    expect(isSafeSlug("x".repeat(LIMITS.slug))).toBe(true);
  });

  it("rejects empty, absolute, and malformed paths", () => {
    expect(isSafeSlug("")).toBe(false);
    expect(isSafeSlug("/abs")).toBe(false);
    expect(isSafeSlug("a/")).toBe(false);
    expect(isSafeSlug("a//b")).toBe(false);
  });

  it("rejects traversal and dot segments", () => {
    expect(isSafeSlug("..")).toBe(false);
    expect(isSafeSlug("../x")).toBe(false);
    expect(isSafeSlug("a/../b")).toBe(false);
    expect(isSafeSlug("a/./b")).toBe(false);
    expect(isSafeSlug(".hidden")).toBe(false);
    expect(isSafeSlug("a/.git")).toBe(false);
  });

  it("rejects backslashes, NUL bytes, and overlong slugs", () => {
    expect(isSafeSlug("a\\b")).toBe(false);
    expect(isSafeSlug("..\\x")).toBe(false);
    expect(isSafeSlug("a\0b")).toBe(false);
    expect(isSafeSlug("x".repeat(LIMITS.slug + 1))).toBe(false);
  });
});

describe("names and tags", () => {
  it("turns file names into capitalized words", () => {
    expect(wordsFromName("adding-config_catalog")).toBe("Adding config catalog");
    expect(wordsFromName("10-14-26")).toBe("10 14 26");
    expect(wordsFromName("--")).toBe("Untitled");
  });

  it("titles a tag", () => {
    expect(titleFromTag("@unified-push")).toBe("Unified push");
    expect(titleFromTag("@")).toBe("Untitled");
  });

  it("derives a doc tag from the slug basename", () => {
    expect(tagForSlug("projects/Unified Push")).toBe("unified-push");
    expect(tagForSlug("doc")).toBe("doc");
    expect(basenameOfSlug("a/b/c")).toBe("c");
    expect(basenameOfSlug("c")).toBe("c");
  });
});
