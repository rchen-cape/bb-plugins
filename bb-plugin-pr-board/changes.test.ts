import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addressCounts, localCommits, locateFiles, parseLog, parseStatus, readAddressChanges, readDiff } from "./changes";
import { fakeRepo } from "./changes.fixture";
import { runCommand } from "./github";
import type { CommentFix } from "./store";

const START = "1".repeat(40);

function fix(overrides: Partial<CommentFix> = {}): CommentFix {
  return { id: "f1", commentId: "PRRT_1", source: "suggestion", suggestionId: "s1", files: ["a.go"], baseHead: START, summary: "Rename", createdAt: 1, ...overrides };
}

describe("parseStatus", () => {
  it("reads -z porcelain entries, including renames and untracked files", () => {
    expect(parseStatus(" M a.go\0R  new.go\0old.go\0?? docs/new file.md\0D  gone.go\0A  added.go\0MM both.go\0")).toEqual([
      { path: "a.go", previousPath: null, status: "M" },
      { path: "new.go", previousPath: "old.go", status: "R" },
      { path: "docs/new file.md", previousPath: null, status: "U" },
      { path: "gone.go", previousPath: null, status: "D" },
      { path: "added.go", previousPath: null, status: "A" },
      { path: "both.go", previousPath: null, status: "M" },
    ]);
    expect(parseStatus("")).toEqual([]);
  });
});

describe("parseLog", () => {
  it("reads commits with their name-status files, renames, and commits without files", () => {
    const output = `\u001e${"a".repeat(40)}\u001faaaaaaa\u001fRename b\n\nM\ta.go\nR087\told.go\tnew.go\nC100\tx.go\ty.go\n\u001e${"b".repeat(40)}\u001fbbbbbbb\u001fMerge main\n`;
    expect(parseLog(output)).toEqual([
      {
        sha: "a".repeat(40),
        shortSha: "aaaaaaa",
        subject: "Rename b",
        files: [
          { path: "a.go", previousPath: null, status: "M" },
          { path: "new.go", previousPath: "old.go", status: "R" },
          { path: "y.go", previousPath: "x.go", status: "A" },
        ],
      },
      { sha: "b".repeat(40), shortSha: "bbbbbbb", subject: "Merge main", files: [] },
    ]);
  });
});

describe("localCommits", () => {
  it("keeps commits made in the worktree and leaves out checkouts, pulls, and merges", () => {
    const reflog = ["a\u001fcommit: Rename", "b\u001fcommit (amend): Rename", "c\u001fcherry-pick: Fix", "d\u001fpull --ff-only: Fast-forward", "e\u001fcheckout: moving from x to y", "f\u001fmerge origin/thing: Merge made by the 'ort' strategy."].join("\n");
    expect([...localCommits(reflog)]).toEqual(["a", "b", "c"]);
  });
});

describe("readAddressChanges", () => {
  it("follows a fix from undone to uncommitted, committed, and pushed, and leaves out commits made elsewhere", async () => {
    const repo = fakeRepo(START);
    const read = () => readAddressChanges(repo.git, [fix()], START);
    expect((await read()).comments).toEqual([{ commentId: "PRRT_1", state: "none", files: ["a.go"], sha: null, sources: ["suggestion"] }]);

    repo.state.status = " M a.go\0?? notes.md\0";
    const dirty = await read();
    expect(dirty.uncommitted).toEqual([
      { path: "a.go", previousPath: null, status: "M", commentIds: ["PRRT_1"] },
      { path: "notes.md", previousPath: null, status: "U", commentIds: [] },
    ]);
    expect(dirty.comments[0]?.state).toBe("uncommitted");
    expect(addressCounts(dirty)).toEqual({ uncommitted: 2, unpushed: 0, pushed: 0 });

    repo.state.status = "?? notes.md\0";
    repo.commit("Teammate change", ["M\tb.go"], false);
    const sha = repo.commit("Rename b to c", ["M\ta.go"]);
    const committed = await read();
    expect(committed.unpushed).toEqual([
      { sha, shortSha: sha.slice(0, 7), subject: "Rename b to c", files: [{ path: "a.go", previousPath: null, status: "M" }], commentIds: ["PRRT_1"] },
    ]);
    expect(committed.comments[0]).toMatchObject({ state: "committed", sha });

    repo.push();
    const pushed = await read();
    expect(pushed.unpushed).toEqual([]);
    expect(pushed.pushed.map((commit) => commit.sha)).toEqual([sha]);
    expect(pushed.comments[0]).toMatchObject({ state: "pushed", sha });
    expect(addressCounts(pushed)).toEqual({ uncommitted: 1, unpushed: 0, pushed: 1 });
  });

  it("keeps an earlier fix committed when a later fix to the same file is uncommitted", async () => {
    const repo = fakeRepo(START);
    const sha = repo.commit("Rename", ["M\ta.go"]);
    repo.state.status = " M a.go\0";
    const changes = await readAddressChanges(repo.git, [fix(), fix({ id: "f2", commentId: "IC_1", source: "thread", suggestionId: null, baseHead: sha })], START);
    expect(changes.comments).toEqual([
      { commentId: "PRRT_1", state: "committed", files: ["a.go"], sha, sources: ["suggestion"] },
      { commentId: "IC_1", state: "uncommitted", files: ["a.go"], sha: null, sources: ["thread"] },
    ]);
    expect(changes.uncommitted[0]?.commentIds).toEqual(["IC_1"]);
    expect(changes.unpushed[0]?.commentIds).toEqual(["PRRT_1"]);
  });

  it("counts every commit as not pushed without an upstream, and starts from the first fix without a recorded start", async () => {
    const repo = fakeRepo(START);
    repo.state.upstream = null;
    repo.commit("Rename", ["M\ta.go"]);
    const changes = await readAddressChanges(repo.git, [fix()], null);
    expect(changes.upstream).toBeNull();
    expect(changes.unpushed).toHaveLength(1);
    expect(changes.comments[0]?.state).toBe("committed");
  });

  it("reports nothing when the worktree has no changes and no fixes", async () => {
    const changes = await readAddressChanges(fakeRepo(START).git, [], null);
    expect(changes).toMatchObject({ available: true, head: START, uncommitted: [], unpushed: [], pushed: [], comments: [] });
  });
});

describe("locateFiles", () => {
  it("finds files changed in the worktree or in a commit, and the oldest commit that holds them", async () => {
    const repo = fakeRepo(START);
    const first = repo.commit("One", ["M\ta.go"]);
    repo.commit("Two", ["M\tb.go"]);
    repo.state.status = " M c.go\0";
    const changes = await readAddressChanges(repo.git, [], START);
    expect(locateFiles(changes, ["a.go", "b.go", "c.go", "d.go"])).toEqual({ missing: ["d.go"], oldestCommit: first });
    expect(locateFiles(changes, ["c.go"])).toEqual({ missing: [], oldestCommit: null });
  });
});

describe("readDiff", () => {
  it("diffs only listed files and commits, and accepts git's exit code 1 for an untracked file", async () => {
    const repo = fakeRepo(START);
    const sha = repo.commit("Rename", ["R100\told.go\tnew.go"]);
    repo.state.status = " M a.go\0?? new.md\0";
    const changes = await readAddressChanges(repo.git, [], START);
    await expect(readDiff(repo.git, changes, "secret.txt", null)).rejects.toThrow("no uncommitted change");
    await expect(readDiff(repo.git, changes, "a.go", "9".repeat(40))).rejects.toThrow("not one of the address thread's commits");
    await expect(readDiff(repo.git, changes, "a.go", sha)).rejects.toThrow("not changed in commit");

    await readDiff(repo.git, changes, "new.md", null);
    expect(repo.calls.at(-1)).toEqual({ args: ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-index", "--", "/dev/null", "new.md"], okExitCodes: [1] });
    await readDiff(repo.git, changes, "a.go", null);
    expect(repo.calls.at(-1)?.args).toEqual(["-c", "core.quotePath=false", "diff", "--no-ext-diff", "-M", "HEAD", "--", "a.go"]);
    await readDiff(repo.git, changes, "new.go", sha);
    expect(repo.calls.at(-1)?.args).toEqual(["-c", "core.quotePath=false", "show", "--no-ext-diff", "-M", "--format=", sha, "--", "old.go", "new.go"]);
  });
});

describe("readAddressChanges with git", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pr-board-git-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("reads a real worktree's status, commits, upstream, and diffs", async () => {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const run = (cwd: string, args: readonly string[], okExitCodes?: readonly number[]) =>
      runCommand("git", args, { cwd, timeoutMs: 30_000, ...(okExitCodes === undefined ? {} : { okExitCodes }) });
    const commit = (message: string) =>
      run(work, ["-c", "user.name=PR Board", "-c", "user.email=pr-board@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", message]);
    await run(root, ["init", "-q", "--bare", remote]);
    await run(root, ["init", "-q", "-b", "main", work]);
    await writeFile(join(work, "a.go"), "package a\n\nfunc b() {}\n");
    await writeFile(join(work, "old.go"), "package a\n\nconst x = 1\n");
    await run(work, ["add", "."]);
    await commit("Start");
    await run(work, ["remote", "add", "origin", remote]);
    await run(work, ["push", "-q", "-u", "origin", "main"]);
    const start = (await run(work, ["rev-parse", "HEAD"])).trim();
    const git = (args: readonly string[], okExitCodes?: readonly number[]) => run(work, args, okExitCodes);
    const read = () => readAddressChanges(git, [fix({ baseHead: start })], start);

    await writeFile(join(work, "a.go"), "package a\n\nfunc c() {}\n");
    await writeFile(join(work, "new file.md"), "hi\n");
    await run(work, ["mv", "old.go", "renamed.go"]);
    const dirty = await read();
    expect([...dirty.uncommitted].sort((left, right) => left.path.localeCompare(right.path))).toEqual([
      { path: "a.go", previousPath: null, status: "M", commentIds: ["PRRT_1"] },
      { path: "new file.md", previousPath: null, status: "U", commentIds: [] },
      { path: "renamed.go", previousPath: "old.go", status: "R", commentIds: [] },
    ]);
    expect(dirty.upstream).toBe(start);
    expect(await readDiff(git, dirty, "new file.md", null)).toContain("+hi");
    expect(await readDiff(git, dirty, "a.go", null)).toContain("+func c() {}");

    await run(work, ["add", "a.go"]);
    await commit("Rename b to c");
    const sha = (await run(work, ["rev-parse", "HEAD"])).trim();
    const committed = await read();
    expect(committed.unpushed).toEqual([
      {
        sha,
        shortSha: expect.stringMatching(/^[0-9a-f]{7,}$/),
        subject: "Rename b to c",
        files: [
          { path: "a.go", previousPath: null, status: "M" },
          { path: "renamed.go", previousPath: "old.go", status: "R" },
        ],
        commentIds: ["PRRT_1"],
      },
    ]);
    expect(committed.comments[0]).toMatchObject({ state: "committed", sha });
    expect(await readDiff(git, committed, "a.go", sha)).toContain("+func c() {}");

    await run(work, ["push", "-q"]);
    const pushed = await read();
    expect(pushed.unpushed).toEqual([]);
    expect(pushed.pushed.map((entry) => entry.sha)).toEqual([sha]);
    expect(pushed.comments[0]).toMatchObject({ state: "pushed", sha });
  });
});

describe("readAddressChanges when the remote-tracking ref is stale", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "pr-board-stale-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("counts a commit as pushed once GitHub's PR head includes it, even if origin/<branch> was not updated", async () => {
    const remote = join(root, "remote.git");
    const work = join(root, "work");
    const run = (cwd: string, args: readonly string[]) => runCommand("git", args, { cwd, timeoutMs: 30_000 });
    const commit = (message: string) =>
      run(work, ["-c", "user.name=PR Board", "-c", "user.email=pr-board@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", message]);
    await run(root, ["init", "-q", "--bare", remote]);
    await run(root, ["init", "-q", "-b", "feature", work]);
    await commit("Start");
    await run(work, ["remote", "add", "origin", remote]);
    await run(work, ["push", "-q", "-u", "origin", "feature"]);
    await run(work, ["checkout", "-q", "-b", "address/pr-1", "--track", "origin/feature"]);
    const start = (await run(work, ["rev-parse", "HEAD"])).trim();
    await writeFile(join(work, "a.go"), "package a\n");
    await run(work, ["add", "a.go"]);
    await commit("Fix");
    const sha = (await run(work, ["rev-parse", "HEAD"])).trim();
    await run(work, ["push", "-q", remote, "HEAD:feature"]);
    const git = (args: readonly string[]) => run(work, args);

    expect((await run(work, ["rev-parse", "@{u}"])).trim()).toBe(start);
    expect((await readAddressChanges(git, [], start)).unpushed.map((entry) => entry.sha)).toEqual([sha]);
    const fixed = await readAddressChanges(git, [], start, sha);
    expect(fixed.unpushed).toEqual([]);
    expect(fixed.pushed.map((entry) => entry.sha)).toEqual([sha]);
    expect((await readAddressChanges(git, [], start, "f".repeat(40))).unpushed.map((entry) => entry.sha)).toEqual([sha]);
  });
});
