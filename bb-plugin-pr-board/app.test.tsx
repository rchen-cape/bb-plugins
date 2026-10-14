// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Board, BoardCard, PullDetail, ReviewState } from "./contract";

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const stored = new Map<string, string>();
Object.defineProperty(window, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => void stored.set(key, value),
    removeItem: (key: string) => void stored.delete(key),
    clear: () => stored.clear(),
  },
});

const app = await loadPluginApp(() => import("./app"));

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  window.localStorage.clear();
  vi.restoreAllMocks();
});
const HEAD = "1".repeat(40);
const MERGE_BASE = "3".repeat(40);

function card(overrides: Partial<BoardCard>): BoardCard {
  return {
    repo: "acme/app",
    number: 1,
    title: "Change",
    url: "https://github.com/acme/app/pull/1",
    column: "open",
    author: { login: "alice", avatarUrl: null },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    headRefName: "feature",
    baseRefName: "main",
    additions: 3,
    deletions: 1,
    changedFiles: 1,
    checks: "success",
    reviewers: [],
    humanComments: 0,
    unresolvedThreads: 0,
    isAuthor: false,
    isMentioned: false,
    isRequested: false,
    isAwaitingReply: false,
    agent: { threadId: null, running: false, findings: 0 },
    ...overrides,
  };
}

const BOARD: Board = {
  viewer: "me",
  repos: ["acme/app"],
  fetchedAt: "2026-10-02T00:00:00Z",
  errors: [],
  cards: [
    card({ number: 1, title: "Draft work", column: "draft" }),
    card({ number: 2, title: "Needs eyes", column: "open", isMentioned: true }),
    card({ number: 3, title: "Under review", column: "reviewing", humanComments: 2, agent: { threadId: "thr_3", running: false, findings: 4 } }),
    card({ number: 4, title: "Approved one", column: "ready", isAuthor: true }),
  ],
};

const PATCH = "@@ -1,3 +1,4 @@\n package main\n \n-func a() {}\n+func a() int { return b() }\n+func b() int { return 1 }";

const DETAIL: PullDetail = {
  repo: "acme/app",
  number: 7,
  nodeId: "PR_node",
  title: "Add thing",
  body: "Adds **the** thing.",
  url: "https://github.com/acme/app/pull/7",
  state: "OPEN",
  isDraft: false,
  isCrossRepository: false,
  author: { login: "alice", avatarUrl: null },
  headRefName: "thing",
  baseRefName: "main",
  headSha: HEAD,
  mergeBaseSha: MERGE_BASE,
  additions: 2,
  deletions: 1,
  viewer: "me",
  files: [
    { path: "cmd/main.go", previousPath: null, status: "modified", additions: 2, deletions: 1, patch: PATCH, viewed: false },
    { path: "docs/readme.md", previousPath: null, status: "added", additions: 1, deletions: 0, patch: "@@ -0,0 +1 @@\n+hi", viewed: true },
  ],
  threads: [],
};

const STATE: ReviewState = {
  agent: { threadId: "thr_7", running: true, findings: 1 },
  findings: [
    {
      id: "f1",
      path: "cmd/main.go",
      side: "additions",
      startLine: 3,
      endLine: 4,
      severity: "major",
      title: "Inline b into a",
      body: "b is a pass-through.",
      headSha: HEAD,
      dismissed: false,
    },
  ],
  drafts: [{ id: "d1", path: "cmd/main.go", side: "additions", startLine: 4, endLine: 4, body: "Pending note" }],
};

const NEW_FILE = "package main\n\nfunc a() int { return b() }\nfunc b() int { return 1 }\n";
const OLD_FILE = "package main\n\nfunc a() {}\n";

function workspaceRpc(state: ReviewState, extra: Record<string, (input: unknown) => unknown> = {}) {
  return {
    pull: () => DETAIL,
    reviewState: () => state,
    openReview: () => ({ threadId: "thr_7", created: false }),
    fileAt: (input: unknown) => ({ content: (input as { sha: string }).sha === HEAD ? NEW_FILE : OLD_FILE, unavailable: null }),
    ...extra,
  };
}

function boardPanel() {
  const panel = app.navPanels.find((registration) => registration.id === "board");
  if (panel === undefined) throw new Error("no board panel");
  return panel;
}

describe("board", () => {
  it("shows the four columns and opens a PR's review page on click", async () => {
    const slot = renderSlot(boardPanel(), { subPath: "" }, { rpc: { board: () => BOARD } });
    for (const title of ["Draft", "Open", "Reviewing", "Ready"]) expect(await slot.findByRole("region", { name: title })).toBeTruthy();
    expect(slot.getByText("4 findings")).toBeTruthy();

    fireEvent.click(slot.getByRole("button", { name: "Mentioned" }));
    expect(slot.queryByText("Draft work")).toBeNull();
    expect(slot.getByText("Needs eyes")).toBeTruthy();

    fireEvent.click(slot.getByText("Needs eyes"));
    expect(slot.inspection.navigateCalls).toContainEqual(
      expect.objectContaining({ method: "toPluginPanel", path: "board", options: { subPath: "pr/acme/app/2" } }),
    );
  });

  it("shows the last board at once on return and updates it in the background", async () => {
    const first = renderSlot(boardPanel(), { subPath: "" }, { rpc: { board: () => BOARD } });
    await first.findByText("Needs eyes");
    first.lifecycle.unmount();

    const slot = renderSlot(boardPanel(), { subPath: "" }, { rpc: { board: () => new Promise(() => {}) } });
    expect(slot.getByText("Needs eyes")).toBeTruthy();
    expect(slot.queryByText("Loading open pull requests…")).toBeNull();
    expect(slot.getByRole("status").textContent).toContain("Updating");
  });

  it("lays the columns out as rows and remembers the choice", async () => {
    const slot = renderSlot(boardPanel(), { subPath: "" }, { rpc: { board: () => BOARD } });
    await slot.findByText("Needs eyes");
    fireEvent.click(slot.getByRole("button", { name: "Rows" }));
    const open = slot.getByRole("region", { name: "Open" });
    expect(open.querySelector("ul")?.className).toContain("grid");
    expect(window.localStorage.getItem("pr-board:board-layout")).toBe('"rows"');
  });

  it("hides, unhides, and shrinks pull requests, and collapses a column", async () => {
    const slot = renderSlot(boardPanel(), { subPath: "" }, { rpc: { board: () => BOARD } });
    await slot.findByText("Needs eyes");

    fireEvent.click(slot.getByRole("button", { name: "Hide #2" }));
    expect(slot.queryByText("Needs eyes")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "1 hidden" }));
    expect(slot.getByText("Needs eyes")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Unhide #2" }));
    expect(slot.queryByRole("button", { name: "1 hidden" })).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Shrink #3" }));
    expect(slot.getByRole("button", { name: "Expand #3" })).toBeTruthy();
    expect(slot.getByText("Under review").className).toContain("truncate");

    fireEvent.click(slot.getByRole("button", { name: /^Draft/ }));
    expect(slot.queryByText("Draft work")).toBeNull();
    expect(JSON.parse(window.localStorage.getItem("pr-board:collapsed-columns") ?? "[]")).toEqual(["draft"]);
  });
});

describe("review workspace", () => {
  it("opens the review thread, lists files and findings, and loads both sides of the diff", async () => {
    const slot = renderSlot(
      boardPanel(),
      { subPath: "pr/acme/app/7" },
      { rpc: workspaceRpc(STATE) },
    );
    expect(await slot.findByText("Add thing")).toBeTruthy();
    expect(slot.getByText("Files 1/2")).toBeTruthy();
    expect(slot.getByText("agent working")).toBeTruthy();
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "fileAt")).toHaveLength(2));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "openReview")).toBe(true);
    expect(slot.inspection.experimental_fixedTabOpenCalls).toHaveLength(1);

    await waitFor(() => {
      const root = document.querySelector("diffs-container")?.shadowRoot;
      expect(root?.querySelector('[data-additions] [data-line="4"]')).toBeTruthy();
      const css = [...(root?.querySelectorAll("style") ?? [])].map((style) => style.textContent).join("\n");
      expect(css).toContain('[data-additions] [data-line="3"]');
      expect(css).toContain("#f59e0b");
    });
    expect(slot.getAllByText("Inline b into a")).toHaveLength(1);
    expect(slot.getByText("Pending note")).toBeTruthy();

    fireEvent.click(slot.getByRole("tab", { name: "Findings 1" }));
    expect(slot.getAllByText("Inline b into a")).toHaveLength(2);

    fireEvent.click(slot.getByRole("button", { name: /Submit review/ }));
    expect(await slot.findByText("1 pending comment will be posted with this review.")).toBeTruthy();
  });

  it("looks up the definition of a ⌘-clicked symbol at its position in the new file", async () => {
    const slot = renderSlot(
      boardPanel(),
      { subPath: "pr/acme/app/7" },
      {
        rpc: workspaceRpc({ ...STATE, findings: [], drafts: [] }, {
          definition: () => ({
            symbol: "b",
            source: "gopls",
            definitions: [{ path: "cmd/main.go", line: 4, preview: "func b() int { return 1 }", external: false }],
            message: null,
          }),
        }),
      },
    );
    await slot.findByText("Add thing");
    const token = await waitFor(() => {
      const root = document.querySelector("diffs-container")?.shadowRoot;
      const line = root?.querySelector('[data-additions] [data-line="3"]');
      const match = [...(line?.querySelectorAll<HTMLElement>("[data-char]") ?? [])].find((element) => element.textContent === "b");
      if (match === undefined) throw new Error("token not rendered yet");
      return match;
    });
    token.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, metaKey: true, ctrlKey: true }));
    await waitFor(() => expect(slot.inspection.rpcCalls.some((call) => call.method === "definition")).toBe(true));
    const call = slot.inspection.rpcCalls.find((entry) => entry.method === "definition");
    expect(call?.input).toEqual({
      repo: "acme/app",
      number: 7,
      sha: HEAD,
      path: "cmd/main.go",
      line: 3,
      character: Number(token.dataset.char),
      symbol: "b",
    });
  });

  it("turns a finding into a pending review comment on its lines", async () => {
    const saved: unknown[] = [];
    const slot = renderSlot(
      boardPanel(),
      { subPath: "pr/acme/app/7" },
      {
        rpc: workspaceRpc({ ...STATE, drafts: [] }, {
          saveDraft: (input) => {
            saved.push(input);
            return { id: "d2", path: "cmd/main.go", side: "additions", startLine: 3, endLine: 4, body: (input as { body: string }).body };
          },
        }),
      },
    );
    fireEvent.click(await slot.findByRole("button", { name: "Comment" }));
    const editor = (await slot.findByRole("textbox", { name: "Comment" })) as HTMLTextAreaElement;
    expect(editor.value).toBe("**Inline b into a**\n\nb is a pass-through.");
    fireEvent.click(slot.getByRole("button", { name: "Suggest change" }));
    expect(editor.value).toContain("```suggestion\nfunc a() int { return b() }\nfunc b() int { return 1 }\n```");
    fireEvent.click(slot.getByRole("button", { name: "Add to review" }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ repo: "acme/app", number: 7, id: null, path: "cmd/main.go", side: "additions", startLine: 3, endLine: 4 });
  });

  it("stacks the file list above a unified diff when the page is narrow", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 700, 900));
    const slot = renderSlot(boardPanel(), { subPath: "pr/acme/app/7" }, { rpc: workspaceRpc(STATE) });
    await slot.findByText("Add thing");
    expect(slot.queryByRole("region", { name: "Files and findings" })).toBeNull();
    await waitFor(() => expect(document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-unified]")).toBeTruthy());

    fireEvent.click(slot.getByRole("button", { name: "Toggle the file list" }));
    expect(slot.getByRole("region", { name: "Files and findings" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Split diff" }));
    await waitFor(() => expect(document.querySelector("diffs-container")?.shadowRoot?.querySelector("[data-additions]")).toBeTruthy());
  });
});
