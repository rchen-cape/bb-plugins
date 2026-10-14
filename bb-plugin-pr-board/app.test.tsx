// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { Board, BoardCard, PullDetail, ReviewState } from "./contract";
import { commentCount } from "./components/Comments";

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
    unansweredComments: 0,
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
    card({ number: 3, title: "Under review", column: "reviewing", humanComments: 2, unansweredComments: 1, agent: { threadId: "thr_3", running: false, findings: 4 } }),
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
  conversation: [],
  awaitingReply: [],
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
  addressAgent: { threadId: null, running: false },
  suggestions: [],
};

const NEW_FILE = "package main\n\nfunc a() int { return b() }\nfunc b() int { return 1 }\n";
const OLD_FILE = "package main\n\nfunc a() {}\n";

function workspaceRpc(state: ReviewState, extra: Record<string, (input: unknown) => unknown> = {}) {
  return {
    pull: () => DETAIL,
    reviewState: () => state,
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
    expect(slot.getByTitle("Comments waiting for your reply").textContent).toBe("1");

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
  it("lists files and findings and loads both sides of the diff without opening the review thread tab", async () => {
    const slot = renderSlot(
      boardPanel(),
      { subPath: "pr/acme/app/7" },
      { rpc: workspaceRpc(STATE) },
    );
    expect(await slot.findByText("Add thing")).toBeTruthy();
    expect(slot.getByText("Files 1/2")).toBeTruthy();
    expect(slot.getByText("agent working")).toBeTruthy();
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "fileAt")).toHaveLength(2));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "openReview")).toBe(false);
    expect(slot.inspection.experimental_fixedTabOpenCalls).toHaveLength(0);

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

  it("starts no review thread on open and starts one from Run review", async () => {
    const slot = renderSlot(
      boardPanel(),
      { subPath: "pr/acme/app/7" },
      {
        rpc: workspaceRpc(
          { ...STATE, agent: { threadId: null, running: false, findings: 0 } },
          { runReview: () => ({ threadId: "thr_7", delivery: "queued" }) },
        ),
      },
    );
    expect(await slot.findByText("Add thing")).toBeTruthy();
    const button = slot.getByRole("button", { name: "Run review" });
    await waitFor(() => expect(button.getAttribute("title")).toContain("Start a review thread"));
    expect(slot.inspection.rpcCalls.some((call) => call.method === "openReview" || call.method === "runReview")).toBe(false);
    fireEvent.click(button);
    await waitFor(() => expect(slot.inspection.rpcCalls.filter((call) => call.method === "runReview")).toHaveLength(1));
  });
});

describe("comments", () => {
  const person = (login: string) => ({ login, avatarUrl: null });
  const COMMENTED: PullDetail = {
    ...DETAIL,
    number: 9,
    threads: [
      {
        id: "PRRT_1",
        path: "cmd/main.go",
        side: "additions",
        line: 4,
        startLine: null,
        isResolved: false,
        isOutdated: false,
        comments: [{ id: "c1", databaseId: 11, author: person("carol"), isBot: false, body: "Rename b", createdAt: "2026-10-01T00:00:00Z", url: "u" }],
      },
    ],
    conversation: [{ id: "IC_1", kind: "comment", author: person("dave"), isBot: false, body: "Please add docs", createdAt: "2026-10-02T00:00:00Z", url: "u" }],
  };
  const SUGGESTED: ReviewState = {
    ...STATE,
    addressAgent: { threadId: "thr_address", running: false },
    suggestions: [
      {
        id: "s1",
        commentId: "PRRT_1",
        summary: "Rename b to c",
        reply: "Renamed it.",
        replyState: "open",
        edits: [{ path: "cmd/main.go", find: "func b() int { return 1 }", replace: "func c() int { return 1 }" }],
        changeState: "open",
      },
      {
        id: "s2",
        commentId: "IC_1",
        summary: "Document the thing",
        reply: null,
        replyState: "open",
        edits: [
          { path: "docs/readme.md", find: "hi", replace: "hi\nmore" },
          { path: "docs/usage.md", find: "", replace: "Usage\n" },
        ],
        changeState: "open",
      },
    ],
  };

  it("shows comments with suggestions, uses a suggested reply, accepts a change, and re-runs the address thread", async () => {
    const after = NEW_FILE.replace("func b() int { return 1 }", "func c() int { return 1 }");
    const slot = renderSlot(
      boardPanel(),
      { subPath: "pr/acme/app/9" },
      {
        rpc: workspaceRpc(SUGGESTED, {
          pull: () => COMMENTED,
          suggestionFiles: (input) =>
            (input as { id: string }).id === "s1"
              ? { files: [{ path: "cmd/main.go", before: NEW_FILE, after }], error: null }
              : { files: [{ path: "docs/readme.md", before: "hi\n", after: "hi\nmore\n" }, { path: "docs/usage.md", before: null, after: "Usage\n" }], error: null },
          applySuggestion: () => ({}),
          setSuggestionState: () => ({}),
          reply: () => ({}),
          addressComments: () => ({ threadId: "thr_address", created: false, delivery: "queued" }),
        }),
      },
    );
    fireEvent.click(await slot.findByRole("tab", { name: "Comments 2" }));
    expect(await slot.findByText("Rename b to c")).toBeTruthy();
    expect(slot.getByText("3 open suggestions. Accepted changes go to the address thread's worktree until you click Submit Address.")).toBeTruthy();

    const calls = (method: string) => slot.inspection.rpcCalls.filter((call) => call.method === method).map((call) => call.input);
    const single = slot.getByRole("button", { name: /^cmd\/main\.go\s*\+/ });
    expect(single.getAttribute("aria-expanded")).toBe("true");
    await waitFor(() => expect(calls("suggestionFiles")).toEqual([{ id: "s1" }]));
    const readme = slot.getByRole("button", { name: /^docs\/readme\.md\s*\+/ });
    expect(readme.getAttribute("aria-expanded")).toBe("false");
    expect(readme.textContent).toContain("+1 −0");
    fireEvent.click(readme);
    await waitFor(() => expect(calls("suggestionFiles")).toEqual([{ id: "s1" }, { id: "s2" }]));
    expect(slot.getByRole("button", { name: /^docs\/usage\.md\s*\+/ }).textContent).toContain("+1 −0");

    fireEvent.click(slot.getByRole("button", { name: "Use reply" }));
    expect((slot.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe("Renamed it.");
    expect(calls("setSuggestionState")).toEqual([]);
    fireEvent.change(slot.getByRole("textbox", { name: "Reply" }), { target: { value: "Renamed it to c." } });

    fireEvent.click(slot.getByRole("button", { name: "View in diff" }));
    expect(slot.getByRole("tab", { name: /^Files/ }).getAttribute("aria-selected")).toBe("true");
    fireEvent.click(slot.getByRole("button", { name: "Go back" }));
    expect(slot.getByRole("tab", { name: /^Comments/ }).getAttribute("aria-selected")).toBe("true");
    expect((slot.getByRole("textbox", { name: "Reply" }) as HTMLTextAreaElement).value).toBe("Renamed it to c.");
    fireEvent.click(slot.getByRole("button", { name: "Reply" }));
    await waitFor(() => expect(calls("reply")).toEqual([{ repo: "acme/app", number: 9, commentId: 11, body: "Renamed it to c." }]));
    await waitFor(() => expect(calls("setSuggestionState")).toEqual([{ id: "s1", part: "reply", state: "used" }]));

    fireEvent.click(slot.getAllByRole("button", { name: "Accept change" })[0]!);
    await waitFor(() => expect(calls("applySuggestion")).toEqual([{ id: "s1" }]));

    fireEvent.click(slot.getByRole("button", { name: "Address comments" }));
    await waitFor(() => expect(calls("addressComments")).toEqual([{ repo: "acme/app", number: 9 }]));
  });

  it("stacks the review and address buttons and confirms Submit Address before sending it", async () => {
    const slot = renderSlot(
      boardPanel(),
      { subPath: "pr/acme/app/10" },
      { rpc: workspaceRpc(SUGGESTED, { pull: () => ({ ...COMMENTED, number: 10 }), submitAddress: () => ({ threadId: "thr_address", delivery: "queued" }) }) },
    );
    expect(await slot.findByText("Add thing")).toBeTruthy();
    const buttons = ["Run review", "Submit review", "Address comments", "Submit Address"].map((name) => slot.getByRole("button", { name: new RegExp(`^${name}`) }));
    expect([...(buttons[0]?.parentElement?.children ?? [])]).toEqual(buttons);
    expect(buttons[0]?.parentElement?.className).toContain("grid-cols-2");
    await waitFor(() => expect(buttons[3]?.hasAttribute("disabled")).toBe(false));
    fireEvent.click(buttons[3]!);
    const dialog = await slot.findByRole("dialog");
    expect(dialog.textContent).toContain("it may fix it with edits that don't change behavior");
    expect(dialog.textContent).toContain("If a check still fails or needs a logic change, it stops without committing or pushing.");
    expect(dialog.textContent).toContain("Every commit is signed with your git signing key");
    expect(slot.inspection.rpcCalls.some((call) => call.method === "submitAddress")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Submit Address" }));
    await waitFor(() =>
      expect(slot.inspection.rpcCalls.filter((call) => call.method === "submitAddress").map((call) => call.input)).toEqual([{ repo: "acme/app", number: 10 }]),
    );
  });
});

describe("commentCount", () => {
  it("leaves out bot conversation comments, code comments a bot started, resolved ones, and my own", () => {
    const comment = (login: string, isBot: boolean) => ({
      id: login,
      databaseId: 1,
      author: { login, avatarUrl: null },
      isBot,
      body: "x",
      createdAt: "2026-10-01T00:00:00Z",
      url: "u",
    });
    const thread = (id: string, comments: ReturnType<typeof comment>[], isResolved = false) => ({
      id,
      path: "a.go",
      side: "additions" as const,
      line: 1,
      startLine: null,
      isResolved,
      isOutdated: false,
      comments,
    });
    const conversation = (login: string, isBot: boolean) => ({ ...comment(login, isBot), kind: "comment" as const });
    expect(
      commentCount({
        viewer: "me",
        threads: [
          thread("human", [comment("carol", false)]),
          thread("bot", [comment("copilot-pull-request-reviewer", true), comment("me", false)]),
          thread("resolved", [comment("carol", false)], true),
        ],
        conversation: [conversation("dave", false), conversation("vercel", true), conversation("me", false)],
      }),
    ).toBe(2);
  });
});

describe("thread tabs", () => {
  function fixedTab(id: string) {
    const tab = boardPanel().fixedTabs?.find((candidate) => candidate.id === id);
    if (tab === undefined) throw new Error(`no ${id} tab`);
    return tab;
  }

  it("adds an Address thread tab beside the Review thread tab that shows the PR's address thread", async () => {
    expect(boardPanel().fixedTabs?.map((tab) => tab.title)).toEqual(["Review thread", "Address thread"]);
    const empty = renderSlot(fixedTab("address-thread"), { subPath: "pr/acme/app/11" }, { rpc: { reviewState: () => STATE } });
    expect(await empty.findByText("No address thread yet. Click Address comments on the PR page to start one.")).toBeTruthy();
    cleanup();

    const started = renderSlot(
      fixedTab("address-thread"),
      { subPath: "pr/acme/app/12" },
      { rpc: { reviewState: () => ({ ...STATE, addressAgent: { threadId: "thr_address", running: true } }) } },
    );
    await waitFor(() => expect(started.inspection.rpcCalls.some((call) => call.method === "reviewState")).toBe(true));
    await waitFor(() => expect(started.queryByText(/Loading the address thread|No address thread yet/)).toBeNull());
  });
});
