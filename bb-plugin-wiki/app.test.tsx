// @vitest-environment jsdom
import { createElement } from "react";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot, type RenderedSlot, type RpcCall } from "@get-bb/plugin-sdk/testing/app";
import type { PluginBrowserBbSdk, PluginCommandContext, PluginMessageActionContext } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";
import { z } from "zod";
import { rpcContract, type Card, type CardSource, type Destination, type DocDetail, type DocSummary, type SearchResult, type WikiStatus } from "./contract";
import { addRequests, searchRequests, type AddRequest } from "./components/requests";
import { setPreviewFocus } from "./lib/live-preview/index.js";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    success: vi.fn(),
    message: vi.fn(),
    loading: vi.fn(() => "toast-1"),
    dismiss: vi.fn(),
  }),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const commandsSchema = z.object({
  commandPaletteActions: z.array(
    z.object({
      id: z.string(),
      defaultShortcut: z.unknown(),
      run: z.custom<(context: PluginCommandContext) => unknown>((value) => typeof value === "function"),
    }),
  ),
});

type Host = Awaited<ReturnType<PluginBrowserBbSdk["hosts"]["list"]>>[number];

const COMMAND_CONTEXT: PluginCommandContext = { threadId: null, projectId: null, openPanel: () => false };

function summary(slug: string, title: string, type: DocSummary["type"], extra: Partial<DocSummary> = {}): DocSummary {
  return { slug, title, type, aliases: [], tag: slug, updatedAt: "2026-10-14T10:00:00.000Z", headings: [title], ...extra };
}

const DOCS: DocSummary[] = [
  summary("alpha", "Alpha project", "project", { headings: ["Alpha project", "Related"] }),
  summary("beta", "Beta topic", "topic", { aliases: ["bt"], headings: ["Beta topic", "Setup"] }),
  summary("delta", "Delta topic", "topic"),
  summary("gamma", "Gamma process", "process"),
];

const STATUS: WikiStatus = {
  wikiDirectory: "/Users/me/Wiki",
  notesDirectory: "/Users/me/Notes",
  docCount: DOCS.length,
  inboxCount: 2,
  lastIngestDate: "2026-10-14",
  routingAgent: true,
  gitHistory: true,
  tagsFile: "/Users/me/Wiki/.wiki/tags.json",
};

const NO_RESULTS: SearchResult = { docs: [], sections: [], total: 0 };

function destination(patch: Partial<Destination> = {}): Destination {
  return { id: "dest_1", include: true, target: { kind: "existing", slug: "alpha" }, heading: "Unsorted", lineRanges: "all", role: "content", reason: "", ...patch };
}

const NOTES_SOURCE: CardSource = { kind: "notes", notePath: "Time/oct2026/10-14-26.md", noteDate: "2026-10-14", unitHash: "h1" };

function card(id: string, firstLine: string): Card {
  return {
    id,
    status: "pending",
    source: NOTES_SOURCE,
    text: `- ${firstLine}\n  - every 30 days`,
    lines: [`- ${firstLine}`, "  - every 30 days"],
    tags: ["alpha"],
    rule: "tag",
    reason: "Tagged @alpha.",
    destinations: [destination()],
    tagSuggestions: [],
    rememberAliases: [],
    createdAt: "2026-10-15T07:00:00.000Z",
    updatedAt: "2026-10-15T07:00:00.000Z",
  };
}

const MESSAGE: PluginMessageActionContext["message"] = { id: "msg_1", threadId: "thr_1", role: "assistant", text: "  Rotate the token monthly.  ", sourceSeqEnd: 4, experimental_messageSeq: 7 };

function messageContext(patch: Partial<PluginMessageActionContext> = {}): PluginMessageActionContext {
  return { threadId: "thr_1", message: MESSAGE, openPanel: () => false, composer: null, ...patch };
}

function inputsOf(calls: readonly RpcCall[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.input);
}

async function load() {
  return loadPluginApp(() => import("./app"));
}

async function loadWithCommands() {
  const app = await load();
  return { app, commands: commandsSchema.parse(app).commandPaletteActions };
}

describe("Wiki app registrations", () => {
  it("registers its page, icon, overlays, message action, code fence renderer and commands", async () => {
    const { app, commands } = await loadWithCommands();
    expect(app.navPanels.map(({ id, title, path, icon }) => ({ id, title, path, icon }))).toEqual([
      { id: "wiki", title: "Wiki", path: "wiki", icon: "WikiBookOpen" },
    ]);
    expect(app.icons.map((icon) => icon.name)).toEqual(["WikiBookOpen"]);
    expect(app.appOverlays.map((overlay) => overlay.id)).toEqual(["wiki-overlay", "wiki-nav"]);
    expect(app.messageActions.map(({ id, title }) => ({ id, title }))).toEqual([{ id: "add", title: "Add to Wiki" }]);
    expect(app.codeFenceRenderers.map((renderer) => renderer.id)).toEqual(["wiki-code"]);
    expect(app.codeFenceRenderers[0]?.languages).toEqual(expect.arrayContaining(["ts", "typescript", "javascript", "markdown", "md", "powershell"]));
    expect(app.codeFenceRenderers[0]?.languages).not.toContain("inline-vis");
    expect(commands.map((command) => command.id)).toEqual(["search", "open", "inbox"]);
    expect(commands[0]?.defaultShortcut).toMatchObject({ key: "k", mod: true, shift: true });
  });

  it("sends a message, or just the selected text, to the add dialog", async () => {
    const app = await load();
    const received: AddRequest[] = [];
    const unsubscribe = addRequests.subscribe((request) => received.push(request));
    const action = app.messageActions[0]!;
    await act(async () => {
      await action.run(messageContext());
      await action.run(messageContext({ selectedText: " the token " }));
    });
    unsubscribe();
    expect(received).toEqual([
      { kind: "message", threadId: "thr_1", messageId: "msg_1", messageSeq: 7, text: "Rotate the token monthly.", fromSelection: false },
      { kind: "message", threadId: "thr_1", messageId: "msg_1", messageSeq: 7, text: "the token", fromSelection: true },
    ]);
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("toasts when a message is empty or the overlay is not mounted yet", async () => {
    const app = await load();
    const action = app.messageActions[0]!;
    const received: AddRequest[] = [];
    const unsubscribe = addRequests.subscribe((request) => received.push(request));
    await action.run(messageContext({ message: { ...MESSAGE, text: "   " } }));
    unsubscribe();
    expect(received).toEqual([]);
    expect(toast.error).toHaveBeenCalledWith("This message has no text to add.");
    await action.run(messageContext());
    expect(toast.error).toHaveBeenLastCalledWith("The Wiki is still loading. Try again in a moment.");
  });

  it("runs the search, open and inbox commands", async () => {
    const { app, commands } = await loadWithCommands();
    const searches: null[] = [];
    const unsubscribe = searchRequests.subscribe((value) => searches.push(value));
    const bridge = renderSlot(app.appOverlays.find((overlay) => overlay.id === "wiki-nav")!, {});
    await act(async () => {
      for (const command of commands) await command.run(COMMAND_CONTEXT);
    });
    unsubscribe();
    expect(searches).toEqual([null]);
    expect(bridge.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "wiki" },
      { method: "toPluginPanel", path: "wiki", options: { subPath: "inbox" } },
    ]);
  });
});

describe("WikiPage", () => {
  it("lists docs grouped by type with counts and opens one", async () => {
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { docs: () => DOCS, status: () => STATUS, search: () => NO_RESULTS } });
    const topics = await slot.findByRole("region", { name: "Topics" });
    expect(within(topics).getByText("2")).toBeTruthy();
    expect(within(topics).getAllByRole("button").map((button) => button.textContent)).toEqual([
      expect.stringContaining("Beta topic"),
      expect.stringContaining("Delta topic"),
    ]);
    expect(within(await slot.findByRole("region", { name: "Projects" })).getByText("Alpha project")).toBeTruthy();
    expect(within(topics).getByText("@beta")).toBeTruthy();
    expect(within(topics).getByText("@bt")).toBeTruthy();
    expect(within(topics).getByText("@delta")).toBeTruthy();
    expect(within(await slot.findByRole("region", { name: "Processes" })).getByText("Gamma process")).toBeTruthy();
    expect(await slot.findByText("(2)")).toBeTruthy();
    expect(await slot.findByText("2 notes are waiting for review.")).toBeTruthy();
    fireEvent.click(within(topics).getByText("Beta topic"));
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "wiki", options: { subPath: "doc/beta" } }]);
  });

  it("shows why the Wiki status failed while the doc list still loads", async () => {
    const app = await load();
    const overlap = "The Wiki folder and the notes folder overlap. Choose separate folders in the Wiki settings.";
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: {
        docs: () => DOCS,
        search: () => NO_RESULTS,
        status: () => {
          throw new Error(overlap);
        },
      },
    });
    expect(await slot.findByRole("region", { name: "Topics" })).toBeTruthy();
    expect((await slot.findByText(overlap)).getAttribute("role")).toBe("alert");
  });

  it("searches sections with highlights and opens the active result with the keyboard", async () => {
    const app = await load();
    const result: SearchResult = {
      docs: [{ ...DOCS[1]!, matched: "alias" }],
      sections: [
        { slug: "beta", title: "Beta topic", type: "topic", heading: "Setup", headingPath: "Setup", anchor: "setup", snippet: "rotate the \u0002token\u0003 monthly" },
      ],
      total: 2,
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, {
      rpc: { docs: () => DOCS, status: () => STATUS, search: (input: unknown) => (rpcContract.search.input.parse(input).query === "" ? NO_RESULTS : result) },
    });
    const input = await slot.findByRole("searchbox", { name: "Search the Wiki" });
    fireEvent.change(input, { target: { value: "token" } });
    expect((await slot.findByText("token", { selector: "mark" })).tagName).toBe("MARK");
    expect(within(await slot.findByRole("region", { name: "Docs" })).getByText("@bt")).toBeTruthy();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "wiki", options: { subPath: "doc/beta#setup" } }]);
  });
});

describe("Inbox", () => {
  it("saves line edits before accepting, then moves to the next card", async () => {
    const app = await load();
    const first = card("card_00000001", "Rotate the global token");
    const second = card("card_00000002", "Write the onboarding checklist");
    const pick = (input: unknown) => (rpcContract.acceptCard.input.parse(input).id === first.id ? first : second);
    const slot = renderSlot(app.navPanels[0]!, { subPath: "inbox" }, {
      rpc: {
        docs: () => DOCS,
        status: () => STATUS,
        search: () => NO_RESULTS,
        inbox: () => [first, second],
        updateCard: (input: unknown) => ({ ...first, destinations: rpcContract.updateCard.input.parse(input).destinations }),
        acceptCard: (input: unknown) => ({ ...pick(input), status: "accepted" }),
        skipCard: (input: unknown) => ({ ...pick(input), status: "skipped" }),
        previewCard: () => ({ previews: [], missingImages: [] }),
      },
    });
    const lines = await slot.findByRole("list", { name: "Note lines" });
    expect(within(lines).getByText("- Rotate the global token")).toBeTruthy();
    expect(slot.getByText("1 of 2")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "all lines" }));
    fireEvent.click(within(lines).getByRole("button", { name: "Line 2" }));
    expect(slot.getByRole("button", { name: "line 1" })).toBeTruthy();
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: /^Accept/ }));
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "acceptCard")).toEqual([{ id: first.id }]));
    const methods = slot.inspection.rpcCalls.map((call) => call.method).filter((method) => method === "updateCard" || method === "acceptCard");
    expect(methods).toEqual(["updateCard", "acceptCard"]);
    expect(inputsOf(slot.inspection.rpcCalls, "updateCard")).toEqual([
      { id: first.id, destinations: [destination({ lineRanges: [{ start: 0, end: 0 }] })], rememberAliases: [] },
    ]);
    expect(slot.inspection.navigateCalls).toEqual([{ method: "toPluginPanel", path: "wiki", options: { subPath: "inbox/card_00000002", replace: true } }]);
    expect(toast.success).toHaveBeenCalledWith("Added to Alpha project", expect.objectContaining({ action: expect.objectContaining({ label: "Open" }) }));

    expect(await within(await slot.findByRole("list", { name: "Note lines" })).findByText("- Write the onboarding checklist")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "s" });
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "skipCard")).toEqual([{ id: second.id }]));
    await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "wiki", options: { subPath: "inbox", replace: true } }));
    expect(await slot.findByText("All caught up")).toBeTruthy();
  });

  function renderInbox(only: Card, updateCard: (input: unknown) => unknown) {
    return load().then((app) =>
      renderSlot(app.navPanels[0]!, { subPath: "inbox" }, {
        rpc: {
          docs: () => DOCS,
          status: () => STATUS,
          search: () => NO_RESULTS,
          inbox: () => [only],
          updateCard,
          acceptCard: () => ({ ...only, status: "accepted" }),
          skipCard: () => ({ ...only, status: "skipped" }),
          previewCard: () => ({ previews: [], missingImages: [] }),
        },
      }),
    );
  }

  function decisions(calls: readonly RpcCall[]): string[] {
    return calls.map((call) => call.method).filter((method) => method === "updateCard" || method === "acceptCard" || method === "skipCard");
  }

  it("retries a failed save before accepting, so the server never accepts stale destinations", async () => {
    const only = card("card_00000004", "Rotate the global token");
    let failures = 1;
    const slot = await renderInbox(only, (input) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error("database is locked");
      }
      return { ...only, destinations: rpcContract.updateCard.input.parse(input).destinations };
    });
    const lines = await slot.findByRole("list", { name: "Note lines" });
    fireEvent.click(slot.getByRole("button", { name: "all lines" }));
    fireEvent.click(within(lines).getByRole("button", { name: "Line 2" }));
    expect(await slot.findByText(/Couldn't save this change: database is locked/, undefined, { timeout: 3000 })).toBeTruthy();
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: /^Accept/ }));
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "acceptCard")).toEqual([{ id: only.id }]));
    expect(decisions(slot.inspection.rpcCalls)).toEqual(["updateCard", "updateCard", "acceptCard"]);
    expect(inputsOf(slot.inspection.rpcCalls, "updateCard").at(-1)).toEqual({
      id: only.id,
      destinations: [destination({ lineRanges: [{ start: 0, end: 0 }] })],
      rememberAliases: [],
    });
  });

  it("opens the doc an accept created from the toast", async () => {
    const fresh = { ...card("card_00000007", "Rotate the global token"), destinations: [destination({ target: { kind: "new", title: "Token rotation", type: "process", aliases: [] }, heading: "Notes" })] };
    const app = await load();
    const slot = renderSlot(app.navPanels[0]!, { subPath: "inbox" }, {
      rpc: {
        docs: () => DOCS,
        status: () => STATUS,
        search: () => NO_RESULTS,
        inbox: () => [fresh],
        acceptCard: () => ({ ...fresh, status: "accepted", destinations: [destination({ target: { kind: "existing", slug: "token-rotation" }, heading: "Notes" })] }),
        previewCard: () => ({ previews: [], missingImages: [] }),
      },
    });
    await slot.findByRole("list", { name: "Note lines" });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: /^Accept/ }));
    });
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [message, options] = vi.mocked(toast.success).mock.calls[0] ?? [];
    expect(message).toBe("Added to Token rotation");
    const { action } = z.object({ action: z.object({ label: z.literal("Open"), onClick: z.custom<() => void>((value) => typeof value === "function") }) }).parse(options);
    act(() => action.onClick());
    expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "wiki", options: { subPath: "doc/token-rotation" } });
  });

  it("shows a preview error instead of a stale diff when the latest edit can't be saved", async () => {
    const only = card("card_00000008", "Rotate the global token");
    const slot = await renderInbox(only, () => {
      throw new Error("database is locked");
    });
    const lines = await slot.findByRole("list", { name: "Note lines" });
    fireEvent.click(slot.getByRole("button", { name: "all lines" }));
    fireEvent.click(within(lines).getByRole("button", { name: "Line 2" }));
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Preview change" }));
    });
    expect(await slot.findByText("Couldn't save your latest edits, so this preview is out of date.")).toBeTruthy();
    expect(inputsOf(slot.inspection.rpcCalls, "previewCard")).toEqual([]);
  });

  it("does not accept when the edits still can't be saved", async () => {
    const only = card("card_00000005", "Rotate the global token");
    const slot = await renderInbox(only, () => {
      throw new Error("Unknown doc");
    });
    const lines = await slot.findByRole("list", { name: "Note lines" });
    fireEvent.click(slot.getByRole("button", { name: "all lines" }));
    fireEvent.click(within(lines).getByRole("button", { name: "Line 2" }));
    expect(await slot.findByText(/Couldn't save this change: Unknown doc/, undefined, { timeout: 3000 })).toBeTruthy();
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: /^Accept/ }));
    });
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Couldn't save your edits to this card. Try again."));
    expect(decisions(slot.inspection.rpcCalls)).toEqual(["updateCard", "updateCard"]);
  });

  it("ignores a held-down A and keys pressed while focus is outside the Wiki page", async () => {
    const only = card("card_00000006", "Rotate the global token");
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    const slot = await renderInbox(only, (input) => ({ ...only, destinations: rpcContract.updateCard.input.parse(input).destinations }));
    const lines = await slot.findByRole("list", { name: "Note lines" });
    await act(async () => {
      fireEvent.keyDown(window, { key: "a", repeat: true });
      fireEvent.keyDown(outside, { key: "s" });
      fireEvent.pointerDown(outside);
      fireEvent.keyDown(document.body, { key: "a" });
    });
    expect(decisions(slot.inspection.rpcCalls)).toEqual([]);
    fireEvent.pointerDown(lines);
    await act(async () => {
      fireEvent.keyDown(document.body, { key: "a" });
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "acceptCard")).toEqual([{ id: only.id }]));
    outside.remove();
  });

  it("remembers a did-you-mean alias and switches the provisional doc", async () => {
    const app = await load();
    const unknown: Card = {
      ...card("card_00000003", "Ship the bt checklist"),
      tags: ["bt2"],
      rule: "none",
      destinations: [destination({ include: false, heading: "Notes", target: { kind: "new", title: "Bt2", type: "project", aliases: [] } })],
      tagSuggestions: [{ tag: "bt2", slug: "beta", title: "Beta topic", score: 0.8 }],
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: `inbox/${unknown.id}` }, {
      rpc: {
        docs: () => DOCS,
        status: () => STATUS,
        search: () => NO_RESULTS,
        inbox: () => [unknown],
        updateCard: (input: unknown) => ({ ...unknown, destinations: rpcContract.updateCard.input.parse(input).destinations }),
        previewCard: () => ({ previews: [], missingImages: [] }),
      },
    });
    expect(await slot.findByText("Beta topic", { selector: "strong" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Yes, remember @bt2" }));
    expect(slot.getByRole("checkbox", { name: "Include Beta topic" })).toHaveProperty("checked", true);
    await waitFor(() =>
      expect(inputsOf(slot.inspection.rpcCalls, "updateCard")).toEqual([
        {
          id: unknown.id,
          destinations: [destination({ include: true, heading: "Unsorted", target: { kind: "existing", slug: "beta" } })],
          rememberAliases: [{ tag: "bt2", slug: "beta" }],
        },
      ]),
    );
  });
});

describe("upload cards", () => {
  const ID = "card_00000009";
  const IMAGE = `card-media/${ID}/roadmap.png`;

  function uploadCard(lines: string[], threadId: string | null = null): Card {
    return {
      ...card(ID, "unused"),
      source: { kind: "upload", name: "Roadmap.png", pluginId: "sketch", threadId },
      text: lines.join("\n"),
      lines,
      tags: [],
      rule: "picked",
      reason: "Sent from Sketch; review before adding.",
    };
  }

  async function renderUpload(only: Card) {
    const app = await load();
    return renderSlot(app.navPanels[0]!, { subPath: "inbox" }, {
      pluginId: "wiki",
      rpc: {
        docs: () => DOCS,
        status: () => STATUS,
        search: () => NO_RESULTS,
        inbox: () => [only],
        previewCard: () => ({ previews: [], missingImages: [IMAGE] }),
      },
    });
  }

  it("shows where the card came from, its image as a thumbnail, and its name in the list", async () => {
    const slot = await renderUpload(uploadCard([`![Q3 plan](${IMAGE})`]));
    const lines = await slot.findByRole("list", { name: "Note lines" });
    const image = within(lines).getByRole("img", { name: "Q3 plan" });
    expect(image.getAttribute("src")).toBe(`/api/v1/plugins/wiki/http/card-media?path=${encodeURIComponent(IMAGE)}`);
    expect(within(lines).queryByText(/card-media/)).toBeNull();
    const article = slot.getByRole("article", { name: "Inbox card" });
    expect(within(article).getByText("From Sketch")).toBeTruthy();
    expect(within(article).getByText("· Roadmap.png")).toBeTruthy();
    expect(slot.queryByText("Written by an agent")).toBeNull();
    expect(slot.queryByText("Sent by an agent")).toBeNull();
    const badge = within(article).getByText("picked when sent");
    expect(badge.getAttribute("title")).toBe("The doc was picked when this was sent, not matched from a [[link]] or @tag. Check it before adding.");
    expect(within(article).queryByText("explicit [[link]]")).toBeNull();
    const row = within(slot.getByRole("list", { name: "Open cards" })).getByRole("button");
    expect(row.textContent).toContain("From Sketch");
    expect(row.textContent).toContain("picked when sent");
    expect(row.textContent).toContain("Roadmap.png");
    expect(row.textContent).not.toContain("![");
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Preview change" }));
    });
    expect(await slot.findByText(/Image missing from the Wiki's data folder/)).toBeTruthy();
  });

  it("lists a card with a note by its first line of text", async () => {
    const slot = await renderUpload(uploadCard(["Q3 roadmap draft", "", `![](${IMAGE})`]));
    const row = within(await slot.findByRole("list", { name: "Open cards" })).getByRole("button");
    expect(row.textContent).toContain("Q3 roadmap draft");
    expect(row.textContent).not.toContain("Roadmap.png");
    const lines = slot.getByRole("list", { name: "Note lines" });
    expect(within(lines).getByText("Q3 roadmap draft")).toBeTruthy();
    expect(within(lines).getByRole("img", { name: "Image" }).getAttribute("src")).toContain("card-media");
  });

  it("marks a card an agent sent from a thread", async () => {
    const slot = await renderUpload(uploadCard([`![Q3 plan](${IMAGE})`], "thr_agent"));
    const article = await slot.findByRole("article", { name: "Inbox card" });
    expect(within(article).getByText("Sent by an agent")).toBeTruthy();
    expect(within(article).getByText("From Sketch")).toBeTruthy();
    expect(within(article).queryByText("Written by an agent")).toBeNull();
  });
});

describe("DocView", () => {
  const DETAIL: DocDetail = {
    ...DOCS[0]!,
    content: "---\ntitle: Alpha project\n---\n\n# Alpha project\n\nSee [[Beta topic#Setup]] and [[Nowhere]].\n",
    sha256: "sha-1",
    backlinks: [{ slug: "gamma", title: "Gamma process", heading: "Steps" }],
  };

  function renderDoc(rpc: Record<string, (input: unknown) => unknown> = {}, subPath = "doc/alpha") {
    return load().then((app) => {
      const slot = renderSlot(app.navPanels[0]!, { subPath }, {
        pluginId: "wiki",
        rpc: { docs: () => DOCS, status: () => STATUS, search: () => NO_RESULTS, doc: () => DETAIL, ...rpc },
      });
      return { app, slot };
    });
  }

  async function editorIn(slot: RenderedSlot, title = "Alpha project"): Promise<EditorView> {
    const content = await slot.findByRole("textbox", { name: `Text of ${title}` });
    const view = EditorView.findFromDOM(content);
    if (view === null) throw new Error("no editor");
    return view;
  }

  function append(view: EditorView, text: string): void {
    const end = view.state.doc.length;
    act(() => {
      view.dispatch({ changes: { from: end, insert: text }, selection: { anchor: end + text.length }, userEvent: "input.type" });
    });
  }

  function click(element: Element): void {
    fireEvent.mouseDown(element, { button: 0 });
    fireEvent.mouseUp(element, { button: 0 });
  }

  async function pressSave(view: EditorView): Promise<void> {
    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: "s", ctrlKey: true });
    });
  }

  it("renders [[links]] and source markers as chips and navigates on click", async () => {
    const content = `${DETAIL.content}\n<!-- wiki:source thread="thr_9" title="Debug push" added="2026-10-15" -->\nA fact.\n`;
    const { slot } = await renderDoc({ doc: () => ({ ...DETAIL, content }) });
    const view = await editorIn(slot);
    expect(view.contentDOM.textContent).not.toContain("title: Alpha project");
    expect(view.contentDOM.textContent).not.toContain("[[");
    expect(slot.getByText("Nowhere").getAttribute("title")).toBe("No Wiki doc named “Nowhere” yet");

    click(slot.getByRole("link", { name: "Beta topic › Setup" }));
    click(slot.getByRole("link", { name: "“Debug push”" }));
    fireEvent.click(within(slot.getByRole("navigation", { name: "Linked from" })).getByRole("button", { name: /Gamma process/ }));
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "wiki", options: { subPath: "doc/beta#setup" } },
      { method: "toThread", threadId: "thr_9" },
      { method: "toPluginPanel", path: "wiki", options: { subPath: "doc/gamma" } },
    ]);

    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Copy link" }));
    });
    expect(slot.inspection.experimental_clipboardWrites).toEqual([{ text: "[[Alpha project]]" }]);
  });

  it("shows source markers as a small faint label with the date it was added", async () => {
    const content = `${DETAIL.content}\n<!-- wiki:source notes="Time/oct2026/10-14-26.md" date="2026-10-14" added="2026-10-15" -->\n- first\n`;
    const { slot } = await renderDoc({ doc: () => ({ ...DETAIL, content }) });
    await editorIn(slot);
    const marker = slot.getByText("from 10-14-26 notes");
    expect(marker.className).toBe("cm-wiki-source");
    expect(marker.getAttribute("title")).toBe("Added 2026-10-15");
    expect(marker.closest(".cm-line")?.classList.contains("cm-lp-source-line")).toBe(true);
  });

  it("autosaves after typing pauses and saves at once on ⌘S, with a quiet status and no toast", async () => {
    const saves: unknown[] = [];
    const { slot } = await renderDoc({
      saveDoc: (input: unknown) => {
        saves.push(input);
        return { outcome: "written", sha256: `sha-${saves.length + 1}` };
      },
    });
    const view = await editorIn(slot);
    append(view, "More.\n");
    expect(await slot.findByText("· Unsaved changes")).toBeTruthy();
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: 3000 });
    expect(saves[0]).toEqual({ slug: "alpha", content: `${DETAIL.content}More.\n`, expectedSha256: "sha-1" });
    expect(await slot.findByText("· Saved")).toBeTruthy();

    append(view, "Again.\n");
    await pressSave(view);
    await waitFor(() => expect(saves).toHaveLength(2));
    expect(saves[1]).toEqual({ slug: "alpha", content: `${DETAIL.content}More.\nAgain.\n`, expectedSha256: "sha-2" });
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("saves edits and overwrites with the latest on-disk version after a conflict", async () => {
    let disk = "sha-1";
    const saves: unknown[] = [];
    const { slot } = await renderDoc({
      doc: () => ({ ...DETAIL, sha256: disk }),
      saveDoc: (input: unknown) => {
        saves.push(input);
        return saves.length === 1 ? { outcome: "conflict" } : { outcome: "written", sha256: "sha-3" };
      },
    });
    const view = await editorIn(slot);
    append(view, "New text\n");
    await pressSave(view);
    expect(await slot.findByText(/Changed on disk/)).toBeTruthy();
    disk = "sha-2";
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Overwrite" }));
    });
    await waitFor(() => expect(saves).toHaveLength(2));
    const content = `${DETAIL.content}New text\n`;
    expect(saves).toEqual([
      { slug: "alpha", content, expectedSha256: "sha-1" },
      { slug: "alpha", content, expectedSha256: "sha-2" },
    ]);
    await waitFor(() => expect(slot.queryByText(/Changed on disk/)).toBeNull());
  });

  it("asks before replacing unsaved edits with a change made on disk, and reloads it", async () => {
    let current = DETAIL;
    const saveDoc = vi.fn(() => ({ outcome: "written", sha256: "sha-mine" }));
    const { slot } = await renderDoc({ doc: () => current, saveDoc });
    const view = await editorIn(slot);
    append(view, "Mine\n");
    current = { ...DETAIL, content: `${DETAIL.content}Theirs\n`, sha256: "sha-theirs" };
    await slot.behavior.emitRealtime("wiki-changed", {});
    expect(await slot.findByText(/Changed on disk/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Reload" }));
    });
    await waitFor(() => expect(view.state.doc.toString()).toBe(`${DETAIL.content}Theirs\n`));
    expect(slot.queryByText(/Changed on disk/)).toBeNull();
    expect(saveDoc).not.toHaveBeenCalled();
  });

  it("applies a change made on disk to a clean doc in place, without saving it back", async () => {
    let current = DETAIL;
    const saveDoc = vi.fn(() => ({ outcome: "written", sha256: "sha-mine" }));
    const { slot } = await renderDoc({ doc: () => current, saveDoc });
    const view = await editorIn(slot);
    current = { ...DETAIL, content: `${DETAIL.content}Three.\n`, sha256: "sha-2" };
    await slot.behavior.emitRealtime("wiki-changed", {});
    await waitFor(() => expect(view.state.doc.toString()).toContain("Three."));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(saveDoc).not.toHaveBeenCalled();
    expect(slot.queryByText(/Changed on disk/)).toBeNull();
  });

  it("applies an outside revert to an earlier version instead of taking it for its own save", async () => {
    let current = DETAIL;
    const saves: unknown[] = [];
    const mine = { ...DETAIL, content: `${DETAIL.content}Mine\n`, sha256: "sha-2" };
    const { slot } = await renderDoc({
      doc: () => current,
      saveDoc: (input: unknown) => {
        saves.push(input);
        return { outcome: "written", sha256: "sha-2" };
      },
    });
    const view = await editorIn(slot);
    append(view, "Mine\n");
    await pressSave(view);
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(await slot.findByText("· Saved")).toBeTruthy();
    current = mine;
    await slot.behavior.emitRealtime("wiki-changed", {});
    current = DETAIL;
    await slot.behavior.emitRealtime("wiki-changed", {});
    await waitFor(() => expect(view.state.doc.toString()).toBe(DETAIL.content));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
    });
    expect(saves).toHaveLength(1);
    expect(slot.queryByText(/Changed on disk/)).toBeNull();
  });

  it("ignores a read of an earlier version that started before its own save landed", async () => {
    const replies: DocDetail[] = [];
    let current = DETAIL;
    const { slot } = await renderDoc({
      doc: () => replies.shift() ?? current,
      saveDoc: () => ({ outcome: "written", sha256: "sha-2" }),
    });
    const view = await editorIn(slot);
    append(view, "Mine\n");
    await pressSave(view);
    expect(await slot.findByText("· Saved")).toBeTruthy();
    current = { ...DETAIL, content: `${DETAIL.content}Mine\n`, sha256: "sha-2" };
    const before = inputsOf(slot.inspection.rpcCalls, "doc").length;
    replies.push(DETAIL);
    await slot.behavior.emitRealtime("wiki-changed", {});
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "doc")).toHaveLength(before + 2));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(view.state.doc.toString()).toBe(`${DETAIL.content}Mine\n`);
    expect(slot.getByText("· Saved")).toBeTruthy();
  });

  it("deletes a doc whose edits can't be saved, and drops the edits", async () => {
    const { slot } = await renderDoc({
      saveDoc: () => ({ outcome: "conflict" }),
      deleteDoc: () => ({ slug: "alpha", title: "Alpha project" }),
    });
    const view = await editorIn(slot);
    append(view, "Mine\n");
    await pressSave(view);
    expect(await slot.findByText(/Changed on disk/)).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Delete" }));
    const dialog = await slot.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "deleteDoc")).toEqual([{ slug: "alpha" }]));
    expect(toast.success).toHaveBeenCalledWith("Deleted Alpha project and its unsaved edits");
    await waitFor(() => expect(slot.queryByRole("textbox", { name: "Text of Alpha project" })).toBeNull());
    expect(toast.error).not.toHaveBeenCalled();
  });

  it("keeps unsaved edits when the file is deleted on disk, and recreates it on overwrite", async () => {
    let deleted = false;
    const saves: unknown[] = [];
    const { slot } = await renderDoc({
      doc: () => (deleted ? null : DETAIL),
      saveDoc: (input: unknown) => {
        saves.push(input);
        return { outcome: "written", sha256: "sha-new" };
      },
    });
    const view = await editorIn(slot);
    append(view, "Mine\n");
    deleted = true;
    await slot.behavior.emitRealtime("wiki-changed", {});
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "doc")).toHaveLength(2));
    expect(await slot.findByText(/Deleted on disk/)).toBeTruthy();
    expect(view.state.doc.toString()).toBe(`${DETAIL.content}Mine\n`);
    await pressSave(view);
    expect(saves).toEqual([]);
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Overwrite" }));
    });
    await waitFor(() => expect(saves).toHaveLength(1));
    expect(saves).toEqual([{ slug: "alpha", content: `${DETAIL.content}Mine\n`, expectedSha256: null }]);
    await waitFor(() => expect(slot.queryByText(/Deleted on disk/)).toBeNull());
  });

  it("shows that a clean doc is gone when its file is deleted on disk", async () => {
    let deleted = false;
    const { slot } = await renderDoc({ doc: () => (deleted ? null : DETAIL) });
    await editorIn(slot);
    deleted = true;
    await slot.behavior.emitRealtime("wiki-changed", {});
    expect(await slot.findByText("This doc isn't in the Wiki")).toBeTruthy();
    expect(slot.queryByRole("textbox", { name: "Text of Alpha project" })).toBeNull();
  });

  it("shows the title once and a hint for a doc that only has its title", async () => {
    const { slot } = await renderDoc({ doc: () => ({ ...DETAIL, content: "---\ntitle: Alpha project\ntype: project\naliases: []\n---\n\n# Alpha project\n" }) });
    const view = await editorIn(slot);
    expect(slot.getAllByRole("heading", { name: "Alpha project" })).toHaveLength(1);
    expect(view.contentDOM.textContent).toBe("Start writing…");
  });

  it("switches to the Markdown source and back", async () => {
    const { slot } = await renderDoc();
    const view = await editorIn(slot);
    const toggle = slot.getByRole("button", { name: "Markdown" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(view.contentDOM.textContent).toContain("title: Alpha project");
    expect(view.contentDOM.textContent).toContain("[[Beta topic#Setup]]");
    expect(view.dom.classList.contains("cm-wiki-raw")).toBe(true);
    fireEvent.click(toggle);
    expect(view.contentDOM.textContent).not.toContain("title: Alpha project");
    expect(slot.getByRole("link", { name: "Beta topic › Setup" })).toBeTruthy();
  });

  it("highlights the selection with ⌘⇧H and renders ==text== as a highlight", async () => {
    const { slot } = await renderDoc({ doc: () => ({ ...DETAIL, content: "# Alpha project\n\nRotate the token monthly.\n" }) });
    const view = await editorIn(slot);
    const from = view.state.doc.toString().indexOf("token");
    act(() => {
      view.dispatch({ selection: { anchor: from, head: from + "token".length }, effects: setPreviewFocus.of(true) });
    });
    await act(async () => {
      fireEvent.keyDown(view.contentDOM, { key: "H", code: "KeyH", keyCode: 72, ctrlKey: true, shiftKey: true });
    });
    expect(view.state.doc.toString()).toBe("# Alpha project\n\nRotate the ==token== monthly.\n");
    act(() => {
      view.dispatch({ effects: setPreviewFocus.of(false) });
    });
    const highlighted = [...view.contentDOM.querySelectorAll(".cm-lp-highlight")].map((element) => element.textContent).join("");
    expect(highlighted).toBe("token");
  });

  it("highlights from the selection toolbar", async () => {
    const { slot } = await renderDoc({ doc: () => ({ ...DETAIL, content: "# Alpha project\n\nRotate the token monthly.\n" }) });
    const view = await editorIn(slot);
    const from = view.state.doc.toString().indexOf("monthly");
    act(() => {
      view.dispatch({ selection: { anchor: from, head: from + "monthly".length }, effects: setPreviewFocus.of(true) });
    });
    const highlight = view.dom.querySelector('.cm-lp-toolbar button[aria-label="Highlight"]');
    if (highlight === null) throw new Error("no toolbar");
    act(() => {
      fireEvent.mouseDown(highlight);
      fireEvent.click(highlight);
    });
    expect(view.state.doc.toString()).toBe("# Alpha project\n\nRotate the token ==monthly==.\n");
  });

  it("scrolls the editor to the copy of a repeated heading that the anchor names, once", async () => {
    const scroll = vi.spyOn(EditorView, "scrollIntoView");
    try {
      let content = "---\ntitle: Alpha project\n---\n\n# Alpha project\n\n## Setup\n\nOne.\n\n```\n## Setup\n```\n\n## Setup\n\nTwo.\n\n## Intro\n";
      const { app, slot } = await renderDoc({ doc: () => ({ ...DETAIL, content, sha256: `sha-${content.length}` }) }, "doc/alpha%23setup-1");
      const view = await editorIn(slot);
      await waitFor(() => expect(scroll).toHaveBeenCalledWith(content.indexOf("## Setup\n\nTwo"), { y: "start" }));
      expect(scroll).toHaveBeenCalledTimes(1);

      content = `${content}\nThree.\n`;
      await slot.behavior.emitRealtime("wiki-changed", {});
      await waitFor(() => expect(view.state.doc.toString()).toContain("Three."));
      expect(scroll).toHaveBeenCalledTimes(1);

      slot.lifecycle.rerender(createElement(app.navPanels[0]!.component, { subPath: "doc/alpha%23intro" }));
      await waitFor(() => expect(scroll).toHaveBeenCalledTimes(2));
      expect(scroll).toHaveBeenLastCalledWith(content.indexOf("## Intro"), { y: "start" });
    } finally {
      scroll.mockRestore();
    }
  });

  it("saves pending edits before renaming the open doc", async () => {
    const calls: string[] = [];
    const { slot } = await renderDoc({
      saveDoc: () => {
        calls.push("saveDoc");
        return { outcome: "written", sha256: "sha-2" };
      },
      renameDoc: () => {
        calls.push("renameDoc");
        return { ...DOCS[0]!, slug: "alpha-two", title: "Alpha two" };
      },
    });
    const view = await editorIn(slot);
    append(view, "Unsaved\n");
    fireEvent.click(slot.getByRole("button", { name: "Rename" }));
    fireEvent.change(await slot.findByRole("textbox", { name: "New title" }), { target: { value: "Alpha two" } });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Rename" }));
    });
    await waitFor(() => expect(calls).toEqual(["saveDoc", "renameDoc"]));
  });

  it("opens the doc's file on the server's machine", async () => {
    const app = await load();
    const host: Host = {
      createdAt: 1,
      id: "host_server",
      lastRejectedProtocolVersion: null,
      lastSeenAt: 1,
      lifecycle: { message: null, pendingLog: "", phase: "active", suspendedAt: null, teardown: null },
      machineProviderId: null,
      maxPermissionMode: "full",
      name: "This Mac",
      status: "connected",
      type: "persistent",
      updatedAt: 1,
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "doc/alpha" }, {
      pluginId: "wiki",
      rpc: { docs: () => DOCS, status: () => STATUS, search: () => NO_RESULTS, doc: () => DETAIL },
      sdk: { hosts: { list: async () => [host] } },
      openFileExternally: () => true,
    });
    const openFile = await slot.findByRole("button", { name: "Open file" });
    await act(async () => {
      fireEvent.click(openFile);
    });
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toEqual([
        { method: "experimental_openFileExternally", options: { target: { kind: "host", hostId: "host_server", path: "/Users/me/Wiki/alpha.md" }, location: null } },
      ]),
    );
    expect(toast.error).not.toHaveBeenCalled();
  });
});

describe("doc actions", () => {
  it("deletes a doc from its right-click menu after confirming", async () => {
    const app = await load();
    const deleteDoc = vi.fn(() => ({ slug: "beta", title: "Beta topic" }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { docs: () => DOCS, status: () => STATUS, search: () => NO_RESULTS, deleteDoc } });
    const topics = await slot.findByRole("region", { name: "Topics" });
    fireEvent.contextMenu(within(topics).getByText("Beta topic"));
    fireEvent.click(await slot.findByRole("menuitem", { name: /Delete/ }));
    const dialog = await slot.findByRole("dialog");
    expect(within(dialog).getByText("Delete “Beta topic”?")).toBeTruthy();
    expect(deleteDoc).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    });
    await waitFor(() => expect(deleteDoc).toHaveBeenCalledWith({ slug: "beta" }));
    expect(toast.success).toHaveBeenCalledWith("Deleted Beta topic");
  });

  it("renames the open doc from its header and follows it to the new address", async () => {
    const app = await load();
    const detail: DocDetail = { ...DOCS[1]!, content: "---\ntitle: Beta topic\n---\n\n# Beta topic\n\nBody.\n", sha256: "abc", backlinks: [] };
    const renameDoc = vi.fn(() => ({ ...DOCS[1]!, slug: "gamma-ray", title: "Gamma ray" }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "doc/beta" }, {
      rpc: { docs: () => DOCS, status: () => STATUS, search: () => NO_RESULTS, doc: () => detail, renameDoc },
    });
    fireEvent.click(await slot.findByRole("button", { name: "Rename" }));
    const input = await slot.findByRole("textbox", { name: "New title" });
    fireEvent.change(input, { target: { value: "Gamma ray" } });
    await act(async () => {
      fireEvent.click(slot.getByRole("button", { name: "Rename" }));
    });
    await waitFor(() => expect(renameDoc).toHaveBeenCalledWith({ slug: "beta", title: "Gamma ray" }));
    await waitFor(() =>
      expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "wiki", options: { subPath: "doc/gamma-ray", replace: true } }),
    );
  });
});

describe("doc types", () => {
  it("groups the sidebar as Topics, Projects, Processes, Services", async () => {
    const app = await load();
    const docs = [...DOCS, summary("notif", "Notification service", "service")];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "" }, { rpc: { docs: () => docs, status: () => STATUS, search: () => NO_RESULTS } });
    expect(within(await slot.findByRole("region", { name: "Services" })).getByText("Notification service")).toBeTruthy();
    const order = slot.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(order.filter((name) => ["Topics", "Projects", "Processes", "Services"].includes(name ?? ""))).toEqual(["Topics", "Projects", "Processes", "Services"]);
  });
});

describe("skip undo", () => {
  it("offers Undo on the skip toast, which restores the card and reopens it", async () => {
    const app = await load();
    const only = card("card_00000009", "Rotate the global token");
    const restoreCard = vi.fn(() => ({ ...only, status: "pending" }));
    const slot = renderSlot(app.navPanels[0]!, { subPath: "inbox" }, {
      rpc: {
        docs: () => DOCS,
        status: () => STATUS,
        search: () => NO_RESULTS,
        inbox: () => [only],
        updateCard: () => only,
        skipCard: () => ({ ...only, status: "skipped" }),
        restoreCard,
        previewCard: () => ({ previews: [], missingImages: [] }),
      },
    });
    await slot.findByRole("list", { name: "Note lines" });
    await act(async () => {
      fireEvent.keyDown(window, { key: "s" });
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Skipped. This note won't come back.", expect.objectContaining({ action: expect.objectContaining({ label: "Undo" }) })));
    const options = z.object({ action: z.object({ onClick: z.custom<() => void>((value) => typeof value === "function") }) }).parse(vi.mocked(toast).mock.calls.at(-1)?.[1]);
    await act(async () => {
      options.action.onClick();
    });
    await waitFor(() => expect(restoreCard).toHaveBeenCalledWith({ id: only.id }));
    await waitFor(() => expect(slot.inspection.navigateCalls).toContainEqual({ method: "toPluginPanel", path: "wiki", options: { subPath: `inbox/${only.id}` } }));
    expect(toast.success).toHaveBeenCalledWith("Restored to the inbox.");
  });
});

describe("skip undo order", () => {
  it("brings the card back to its original place and shows it", async () => {
    const app = await load();
    const cards = [card("card_0000000a", "First note"), card("card_0000000b", "Middle note"), card("card_0000000c", "Last note")];
    const slot = renderSlot(app.navPanels[0]!, { subPath: "inbox/card_0000000b" }, {
      rpc: {
        docs: () => DOCS,
        status: () => STATUS,
        search: () => NO_RESULTS,
        inbox: () => cards,
        updateCard: (input: unknown) => cards.find((entry) => entry.id === rpcContract.updateCard.input.parse(input).id),
        skipCard: () => ({ ...cards[1]!, status: "skipped" }),
        restoreCard: () => ({ ...cards[1]!, status: "pending" }),
        previewCard: () => ({ previews: [], missingImages: [] }),
      },
    });
    expect(await within(await slot.findByRole("list", { name: "Note lines" })).findByText("- Middle note")).toBeTruthy();
    expect(slot.getByText("2 of 3")).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: "s" });
    });
    await waitFor(() => expect(toast).toHaveBeenCalledWith("Skipped. This note won't come back.", expect.anything()));
    const options = z.object({ action: z.object({ onClick: z.custom<() => void>((value) => typeof value === "function") }) }).parse(vi.mocked(toast).mock.calls.at(-1)?.[1]);
    await act(async () => {
      options.action.onClick();
    });
    await waitFor(() => expect(slot.inspection.navigateCalls.at(-1)).toEqual({ method: "toPluginPanel", path: "wiki", options: { subPath: "inbox/card_0000000b" } }));
    const rows = within(slot.getByRole("list", { name: "Open cards" })).getAllByRole("button").map((row) => row.textContent ?? "");
    expect(rows.map((text) => ["First", "Middle", "Last"].find((word) => text.includes(word)))).toEqual(["First", "Middle", "Last"]);
  });
});

describe("destination types", () => {
  it("shows each destination's doc type and labels Unsorted as below the line", async () => {
    const app = await load();
    const only: Card = {
      ...card("card_0000000d", "Rotate the global token"),
      destinations: [
        destination(),
        destination({ id: "dest_2", target: { kind: "new", title: "Notification service", type: "service", aliases: [] } }),
      ],
    };
    const slot = renderSlot(app.navPanels[0]!, { subPath: "inbox" }, {
      rpc: { docs: () => DOCS, status: () => STATUS, search: () => NO_RESULTS, inbox: () => [only], updateCard: () => only, previewCard: () => ({ previews: [], missingImages: [] }) },
    });
    const existing = await slot.findByRole("button", { name: "Destination doc: Alpha project" });
    expect(within(existing).getByText("Project")).toBeTruthy();
    const created = slot.getByRole("button", { name: "Destination doc: New: Notification service" });
    expect(within(created).getByText("Service")).toBeTruthy();
    expect(slot.getAllByRole("option", { name: "Unsorted (below the line)" }).length).toBeGreaterThan(0);
  });
});
