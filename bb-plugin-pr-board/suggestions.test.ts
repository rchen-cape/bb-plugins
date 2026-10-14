import { link, mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PullDetail } from "./contract";
import { SUGGESTIONS_TOOL, addressMessage, addressPrompt, addressableIds, applyEdit, previewEdits, writePreviews } from "./suggestions";

function detail(overrides: Partial<PullDetail> = {}): PullDetail {
  const person = (login: string) => ({ login, avatarUrl: null });
  return {
    repo: "acme/app",
    number: 7,
    nodeId: "PR_1",
    title: "Add thing",
    body: "",
    url: "https://github.com/acme/app/pull/7",
    state: "OPEN",
    isDraft: false,
    isCrossRepository: false,
    author: person("me"),
    headRefName: "thing",
    baseRefName: "main",
    headSha: "1".repeat(40),
    mergeBaseSha: "3".repeat(40),
    additions: 1,
    deletions: 0,
    viewer: "me",
    files: [],
    threads: [
      {
        id: "PRRT_open",
        path: "a.go",
        side: "additions",
        line: 4,
        startLine: 2,
        isResolved: false,
        isOutdated: false,
        comments: [{ id: "c1", databaseId: 1, author: person("alice"), isBot: false, body: "Rename this", createdAt: "2026-10-01T00:00:00Z", url: "u" }],
      },
      {
        id: "PRRT_done",
        path: "b.go",
        side: "additions",
        line: 1,
        startLine: null,
        isResolved: true,
        isOutdated: false,
        comments: [{ id: "c2", databaseId: 2, author: person("bob"), isBot: false, body: "Fixed?", createdAt: "2026-10-01T00:00:00Z", url: "u" }],
      },
    ],
    conversation: [
      { id: "IC_alice", kind: "comment", author: person("alice"), isBot: false, body: "Add tests", createdAt: "2026-10-02T00:00:00Z", url: "u" },
      { id: "IC_me", kind: "comment", author: person("me"), isBot: false, body: "Will do", createdAt: "2026-10-03T00:00:00Z", url: "u" },
    ],
    ...overrides,
  };
}

describe("applyEdit", () => {
  it("replaces the one place the text appears, keeping $ patterns literal", () => {
    expect(applyEdit("a\nold()\nb\n", { path: "x", find: "old()", replace: "new($&)" })).toBe("a\nnew($&)\nb\n");
  });

  it("creates a file only from an empty find on a missing file", () => {
    expect(applyEdit(null, { path: "x", find: "", replace: "hello\n" })).toBe("hello\n");
    expect(() => applyEdit("there", { path: "x", find: "", replace: "hello" })).toThrow("already exists");
    expect(() => applyEdit(null, { path: "x", find: "a", replace: "b" })).toThrow("does not exist");
  });

  it("refuses text that is missing or appears more than once, overlapping included", () => {
    expect(() => applyEdit("abc", { path: "x", find: "zz", replace: "y" })).toThrow("not found");
    expect(() => applyEdit("a a", { path: "x", find: "a", replace: "b" })).toThrow("more than one place");
    expect(() => applyEdit("aaa", { path: "x", find: "aa", replace: "b" })).toThrow("more than one place");
  });
});

describe("worktree files", () => {
  let root: string;
  let outside: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pr-board-worktree-"));
    outside = await mkdtemp(join(tmpdir(), "pr-board-outside-"));
    await writeFile(join(root, "a.go"), "package a\n\nfunc A() {}\n");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  it("previews several edits to one file and a new file, then writes them", async () => {
    const files = await previewEdits(root, [
      { path: "a.go", find: "func A() {}", replace: "func A() int { return 1 }" },
      { path: "a.go", find: "package a", replace: "package b" },
      { path: "pkg/new.go", find: "", replace: "package pkg\n" },
    ]);
    expect(files).toEqual([
      { path: "a.go", before: "package a\n\nfunc A() {}\n", after: "package b\n\nfunc A() int { return 1 }\n" },
      { path: "pkg/new.go", before: null, after: "package pkg\n" },
    ]);
    await writePreviews(root, files);
    expect(await readFile(join(root, "a.go"), "utf8")).toBe("package b\n\nfunc A() int { return 1 }\n");
    expect(await readFile(join(root, "pkg/new.go"), "utf8")).toBe("package pkg\n");
  });

  it("refuses paths that leave the worktree, including through a symlink", async () => {
    await expect(previewEdits(root, [{ path: "../x", find: "", replace: "x" }])).rejects.toThrow("repository-relative");
    await expect(previewEdits(root, [{ path: "/etc/hosts", find: "", replace: "x" }])).rejects.toThrow("repository-relative");
    await mkdir(join(outside, "dir"));
    await symlink(join(outside, "dir"), join(root, "link"));
    await expect(previewEdits(root, [{ path: "link/x.go", find: "", replace: "x" }])).rejects.toThrow("outside the worktree");
    await writeFile(join(outside, "target.go"), "secret\n");
    await symlink(join(outside, "target.go"), join(root, "file.go"));
    await expect(previewEdits(root, [{ path: "file.go", find: "secret", replace: "x" }])).rejects.toThrow("symbolic link");
    await expect(writePreviews(root, [{ path: "file.go", before: null, after: "x" }])).rejects.toThrow("symbolic link");
    expect(await readFile(join(outside, "target.go"), "utf8")).toBe("secret\n");

    await symlink(join(outside, "created.sh"), join(root, "dangling.sh"));
    await expect(previewEdits(root, [{ path: "dangling.sh", find: "", replace: "echo hi\n" }])).rejects.toThrow("symbolic link");
    await link(join(outside, "target.go"), join(root, "hard.go"));
    await expect(previewEdits(root, [{ path: "hard.go", find: "secret", replace: "x" }])).rejects.toThrow("hard link");
    await expect(stat(join(outside, "created.sh"))).rejects.toThrow();
  });

  it("keeps a changed file's permissions and leaves no temporary files", async () => {
    await writeFile(join(root, "run.sh"), "echo a\n", { mode: 0o755 });
    await writePreviews(root, await previewEdits(root, [{ path: "run.sh", find: "echo a", replace: "echo b" }]));
    expect(await readFile(join(root, "run.sh"), "utf8")).toBe("echo b\n");
    expect((await stat(join(root, "run.sh"))).mode & 0o777).toBe(0o755);
    expect((await readdir(root)).filter((name) => name.includes(".pr-board-"))).toEqual([]);
  });

  it("matches LF edits against CRLF files and refuses files that are not UTF-8", async () => {
    await writeFile(join(root, "win.go"), "a\r\nold\r\nb\r\n");
    expect(await previewEdits(root, [{ path: "win.go", find: "a\nold", replace: "a\nnew\nmore" }])).toEqual([
      { path: "win.go", before: "a\r\nold\r\nb\r\n", after: "a\r\nnew\r\nmore\r\nb\r\n" },
    ]);
    await writeFile(join(root, "latin.txt"), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    await expect(previewEdits(root, [{ path: "latin.txt", find: "caf", replace: "x" }])).rejects.toThrow("not UTF-8");
  });
});

describe("address prompts", () => {
  it("lists unresolved code comments and the conversation with ids, and only accepts others' comments", () => {
    const pull = detail();
    const prompt = addressPrompt(pull);
    expect(prompt).toContain("[PRRT_open] a.go lines 2-4");
    expect(prompt).toContain("@alice: Rename this");
    expect(prompt).not.toContain("PRRT_done");
    expect(prompt).toContain("[IC_me] @me (you): Will do");
    expect(prompt).toContain("Do not read or change files yet");
    expect(addressMessage(pull, false)).toContain(SUGGESTIONS_TOOL);
    expect(addressMessage(pull, false)).not.toContain("[PRRT_open]");
    expect(addressMessage(pull, true)).toContain("[PRRT_open]");
    expect([...addressableIds(pull)]).toEqual(["PRRT_open", "IC_alice"]);
  });
});
