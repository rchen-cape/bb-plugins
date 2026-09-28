import { describe, expect, it } from "vitest";
import {
  assetFileName,
  imageMarkdown,
  imageMimeType,
  referencedImages,
  withResolvedAssetUrls,
} from "./images";

describe("image assets", () => {
  it("accepts raster images and refuses everything else", () => {
    expect(imageMimeType("shot.PNG")).toBe("image/png");
    expect(imageMimeType("shot.jpeg")).toBe("image/jpeg");
    // A vector document that can carry script, rendered in the app.
    expect(imageMimeType("logo.svg")).toBeNull();
    expect(imageMimeType("notes.md")).toBeNull();
    expect(imageMimeType("noextension")).toBeNull();
    expect(imageMimeType(".png")).toBeNull();
  });

  it("names a file by its content so the same drop stores once", () => {
    const first = assetFileName({
      fileName: "Screen Shot.png",
      contentDigest: "abcdef0123456789abcdef",
    });
    const again = assetFileName({
      fileName: "renamed-copy.png",
      contentDigest: "abcdef0123456789abcdef",
    });
    expect(first).toBe("abcdef0123456789.png");
    expect(again).toBe(first);
  });

  it("keeps the dropped name as alt text without breaking the link", () => {
    expect(
      imageMarkdown({
        originalName: "Screen [Shot].png",
        assetFile: "abc123.png",
      }),
    ).toBe("![Screen  Shot .png](assets/abc123.png)");
    expect(
      imageMarkdown({ originalName: "   ", assetFile: "abc123.png" }),
    ).toBe("![image](assets/abc123.png)");
  });

  it("finds each referenced image once, in order, with its alt text", () => {
    const markdown = [
      "# Spec",
      "![one](assets/aaa.png)",
      "![again](./assets/bbb.jpg)",
      "![dupe](assets/aaa.png)",
      "![](assets/c%20c.webp)",
    ].join("\n\n");
    expect(referencedImages(markdown)).toEqual([
      { assetFile: "aaa.png", alt: "one" },
      { assetFile: "bbb.jpg", alt: "again" },
      // No alt text in the document, so the file names itself.
      { assetFile: "c c.webp", alt: "c c.webp" },
    ]);
  });

  it("ignores references that are not images in the tree's own folder", () => {
    const markdown = [
      "![escape](assets/../../../etc/passwd)",
      "![nested](assets/sub/dir.png)",
      "![doc](assets/readme.md)",
      "![remote](https://example.com/x.png)",
      "[link](assets/aaa.png)",
    ].join("\n\n");
    expect(referencedImages(markdown)).toEqual([]);
  });

  it("rewrites references onto the serving base and leaves the rest alone", () => {
    const markdown = [
      "![one](assets/aaa.png)",
      "![remote](https://example.com/x.png)",
      "See `assets/aaa.png` on disk.",
    ].join("\n\n");
    expect(withResolvedAssetUrls(markdown, "http://127.0.0.1:1/p/abc/")).toBe(
      [
        "![one](http://127.0.0.1:1/p/abc/aaa.png)",
        "![remote](https://example.com/x.png)",
        "See `assets/aaa.png` on disk.",
      ].join("\n\n"),
    );
  });
});
