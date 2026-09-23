import { describe, expect, it } from "vitest";
import {
  artifactFileName,
  expandHomePath,
  isMarkdownStub,
  markdownStub,
  projectDirectory,
  resolveRootDirectory,
  slugify,
} from "./paths";

describe("slugify", () => {
  it("collapses punctuation and spacing into single separators", () => {
    expect(slugify("Write Auth Requirements!")).toBe("write_auth_requirements");
  });

  it("strips accents rather than dropping the whole word", () => {
    expect(slugify("Café résumé")).toBe("cafe_resume");
  });

  it("never returns an empty or separator-only name", () => {
    expect(slugify("***")).toBe("untitled");
    expect(slugify("")).toBe("untitled");
    expect(slugify("  -- ")).toBe("untitled");
  });

  it("truncates without leaving a trailing separator", () => {
    const slug = slugify(`${"word ".repeat(20)}`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("_")).toBe(false);
  });
});

describe("artifactFileName", () => {
  it("zero-pads the ordinal so files sort in dependency order", () => {
    expect(artifactFileName({ ordinal: 1, title: "User research" })).toBe(
      "01_user_research.md",
    );
    expect(artifactFileName({ ordinal: 12, title: "Tech spec" })).toBe(
      "12_tech_spec.md",
    );
  });
});

describe("isMarkdownStub", () => {
  it("treats the generated stub as unwritten", () => {
    expect(isMarkdownStub(markdownStub("User research"))).toBe(true);
  });

  it("treats an empty file as unwritten", () => {
    expect(isMarkdownStub("")).toBe(true);
    expect(isMarkdownStub("\n\n  \n")).toBe(true);
  });

  it("treats a renamed heading with no body as unwritten", () => {
    expect(isMarkdownStub("# Something else entirely\n\n")).toBe(true);
  });

  it("treats any body under the heading as written", () => {
    expect(isMarkdownStub("# User research\n\nUsers need OAuth2.\n")).toBe(
      false,
    );
  });

  it("treats a file with a body but no heading as written", () => {
    expect(isMarkdownStub("Users need OAuth2.\n")).toBe(false);
  });
});

describe("path resolution", () => {
  it("expands a leading tilde against the supplied home directory", () => {
    expect(expandHomePath("~/Trees", "/Users/me")).toBe("/Users/me/Trees");
    expect(expandHomePath("~", "/Users/me")).toBe("/Users/me");
  });

  it("leaves a path that only contains a tilde mid-string alone", () => {
    expect(expandHomePath("/tmp/a~b", "/Users/me")).toBe("/tmp/a~b");
  });

  it("refuses a relative root so files never land beside the server", () => {
    expect(() =>
      resolveRootDirectory({ rawPath: "Trees", homeDirectory: "/Users/me" }),
    ).toThrow(/absolute path/u);
  });

  it("refuses an empty root", () => {
    expect(() =>
      resolveRootDirectory({ rawPath: "   ", homeDirectory: "/Users/me" }),
    ).toThrow(/required/u);
  });

  it("normalizes a resolved root", () => {
    expect(
      resolveRootDirectory({
        rawPath: "~/Trees/../Trees/",
        homeDirectory: "/Users/me",
      }),
    ).toBe("/Users/me/Trees");
  });

  it("puts each project in its own slugged subdirectory", () => {
    expect(
      projectDirectory({
        rootDirectory: "/Users/me/Trees",
        name: "Build Auth Feature",
      }),
    ).toBe("/Users/me/Trees/build_auth_feature");
  });
});
