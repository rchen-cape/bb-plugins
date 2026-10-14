import { describe, expect, it } from "vitest";
import {
  assetFileName,
  imageMarkdown,
  imageMimeType,
  referencedImages,
  withImageMarkers,
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

  /*
   * A relative reference renders as a broken image in a chat message, and the
   * pictures arrive as attachments, so the text marks where each one was.
   */
  it("marks each image in place and numbers it for the attachment list", () => {
    const marked = withImageMarkers(
      [
        "# Spec",
        "The flow:",
        "![the login screen](assets/aaa.png)",
        "Then:",
        "![the error state](./assets/bbb.jpg)",
        "The first one again:",
        "![whatever](assets/aaa.png)",
      ].join("\n\n"),
      0,
    );
    expect(marked.text).toBe(
      [
        "# Spec",
        "The flow:",
        "_[Image 1: the login screen]_",
        "Then:",
        "_[Image 2: the error state]_",
        "The first one again:",
        // The same file is one attachment, so it keeps its own number.
        "_[Image 1: the login screen]_",
      ].join("\n\n"),
    );
    expect(marked.images).toEqual([
      { assetFile: "aaa.png", alt: "the login screen", number: 1 },
      { assetFile: "bbb.jpg", alt: "the error state", number: 2 },
    ]);
  });

  it("numbers from where the last document left off", () => {
    const marked = withImageMarkers("![shot](assets/ccc.png)", 3);
    expect(marked.text).toBe("_[Image 4: shot]_");
    expect(marked.images[0]?.number).toBe(4);
  });

  it("leaves a reference it will not attach as it found it", () => {
    const markdown = "![doc](assets/readme.md) ![out](assets/sub/x.png)";
    expect(withImageMarkers(markdown, 0)).toEqual({
      text: markdown,
      images: [],
    });
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
