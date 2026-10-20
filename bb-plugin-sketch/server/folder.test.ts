import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCliPath, type CliMachine } from "./cli-files";
import { displayFolder, ensureFolder, isInside, isSketchFolderSetting, resolveRoot, resolveSketchRoot } from "./folder";
import { tempDir } from "./test-support";

const HOME = "/Users/ada";

describe("the Sketch folder setting", () => {
  it("accepts absolute folders and ~/ folders", () => {
    expect(resolveSketchRoot("~/Sketches", HOME)).toBe("/Users/ada/Sketches");
    expect(resolveSketchRoot("  ~/Notes/Sketches/  ", HOME)).toBe("/Users/ada/Notes/Sketches");
    expect(resolveSketchRoot("/Volumes/Work/Sketches", HOME)).toBe("/Volumes/Work/Sketches");
    expect(resolveRoot("~", HOME)).toBe(HOME);
  });

  it("refuses relative folders, the home folder, and anything above it", () => {
    for (const raw of ["Sketches", "./Sketches", "", "~", "~/", "/Users/ada", "/Users", "/", "/users/ADA"]) {
      expect(isSketchFolderSetting(raw, HOME)).toBe(false);
    }
    expect(() => resolveSketchRoot("/Users", HOME)).toThrow("The Sketch folder can't be /Users, because it holds your home folder.");
    expect(() => resolveSketchRoot("Sketches", HOME)).toThrow('Use an absolute folder path or one starting with "~/", not "Sketches".');
  });

  it("shows folders inside home with ~", () => {
    expect(displayFolder("/Users/ada/Sketches", HOME)).toBe("~/Sketches");
    expect(displayFolder("/Users/adam/Sketches", HOME)).toBe("/Users/adam/Sketches");
    expect(displayFolder("/tmp/x", HOME)).toBe("/tmp/x");
    expect(isInside("/Users/Ada", "/users/ada/x", true)).toBe(true);
    expect(isInside("/Users/Ada", "/users/ada/x", false)).toBe(false);
  });

  it("creates the folder, and refuses a file in its place", async () => {
    const base = await tempDir("sketch-folder-");
    const folder = path.join(base, "a", "b");
    await ensureFolder(folder);
    await writeFile(path.join(base, "file"), "x");
    await expect(ensureFolder(path.join(base, "file"))).rejects.toThrow("isn't a folder");
    await mkdir(path.join(base, "c"));
    await ensureFolder(path.join(base, "c"));
  });
});

describe("CLI paths", () => {
  const server: CliMachine = { kind: "server" };
  const remote: CliMachine = { kind: "remote", hostId: "host_2" };

  it("resolves absolute, ~/ and relative paths on this machine", () => {
    expect(resolveCliPath("/tmp/a.svg", undefined, server, HOME)).toBe("/tmp/a.svg");
    expect(resolveCliPath("~/Desktop/a.png", undefined, server, HOME)).toBe("/Users/ada/Desktop/a.png");
    expect(resolveCliPath("out/../a.svg", "/work", server, HOME)).toBe("/work/a.svg");
    expect(() => resolveCliPath("a.svg", undefined, server, HOME)).toThrow("is relative");
    expect(() => resolveCliPath("  ", "/work", server, HOME)).toThrow("The path is empty.");
  });

  it("never expands ~ for another machine", () => {
    expect(resolveCliPath("/srv/a.svg", "/home/dev", remote, HOME)).toBe("/srv/a.svg");
    expect(resolveCliPath("a.svg", "/home/dev", remote, HOME)).toBe("/home/dev/a.svg");
    expect(resolveCliPath("a.svg", "C:\\Users\\dev", remote, HOME)).toBe("C:\\Users\\dev\\a.svg");
    expect(() => resolveCliPath("~/a.svg", "/home/dev", remote, HOME)).toThrow("~/ can't be expanded");
  });
});
