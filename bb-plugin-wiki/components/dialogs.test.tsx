// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { DocHit, DocSummary, SearchResult, SectionHit, Suggestion, UploadInfo } from "../contract";
import { fencedCode, fileAliases, fileDocBody, fileTitle } from "./AddToWikiDialog";
import { CodeFenceWithWikiButton, WIKI_CODE_LANGUAGES } from "./CodeFence";
import { uploadFiles, useFileDrop } from "./DropZone";
import { NewDocView } from "./NewDocDialog";
import { addRequests, searchRequests, type AddRequest } from "./requests";
import { WikiOverlay } from "./WikiOverlay";

afterEach(cleanup);

const DOC: DocSummary = {
  slug: "unified-notification",
  title: "Unified notification",
  type: "project",
  aliases: ["un"],
  tag: "unified-notification",
  updatedAt: "2026-10-14T10:00:00.000Z",
  headings: ["Unified notification", "Global token", "Unsorted"],
};

const OTHER_DOC: DocSummary = {
  slug: "push-tokens",
  title: "Push tokens",
  type: "topic",
  aliases: [],
  tag: "push-tokens",
  updatedAt: "2026-10-13T10:00:00.000Z",
  headings: ["Push tokens", "Rotation"],
};

const SUGGESTION: Suggestion = {
  slug: DOC.slug,
  title: DOC.title,
  type: DOC.type,
  heading: "Global token",
  score: 3,
  reason: "Shares the terms token and refresh.",
};

const IMAGE: UploadInfo = { uploadId: "upl_1a2b3c4d5e6f", name: "diagram.png", kind: "image", sizeBytes: 2048, text: null };

function rpcInputs(calls: readonly { method: string; input: unknown }[], method: string): unknown[] {
  return calls.filter((call) => call.method === method).map((call) => call.input);
}

function renderOverlay(rpc: Record<string, (input: unknown) => unknown>) {
  return renderSlot({ component: WikiOverlay }, {}, { rpc });
}

describe("uploadFiles", () => {
  it("rejects unsupported files before uploading anything", async () => {
    const fetchStub = vi.fn<typeof fetch>();
    const importUpload = vi.fn<(uploadId: string) => Promise<UploadInfo>>();
    await expect(uploadFiles([new File(["x"], "notes.pdf")], { fetch: fetchStub, importUpload })).rejects.toThrow(/notes\.pdf/);
    expect(fetchStub).not.toHaveBeenCalled();
    expect(importUpload).not.toHaveBeenCalled();
  });

  it("uploads each file with the plugin token, then imports it", async () => {
    const requests: { url: string; init: RequestInit | undefined }[] = [];
    const fetchStub: typeof fetch = async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      return url.endsWith("/token")
        ? Response.json({ ok: true, token: "tok_123" })
        : Response.json({ uploadId: IMAGE.uploadId, name: IMAGE.name, sizeBytes: 3 });
    };
    const file = new File(["png"], "diagram.png", { type: "image/png" });
    const imported: string[] = [];
    const uploads = await uploadFiles([file], {
      pluginId: "wiki",
      fetch: fetchStub,
      importUpload: async (uploadId) => {
        imported.push(uploadId);
        return IMAGE;
      },
    });
    expect(uploads).toEqual([IMAGE]);
    expect(imported).toEqual([IMAGE.uploadId]);
    expect(requests.map((request) => request.url)).toEqual(["/api/v1/plugins/wiki/token", "/api/v1/plugins/wiki/http/upload?name=diagram.png"]);
    const token = requests[0]?.init;
    expect(token?.method).toBe("POST");
    expect(new Headers(token?.headers).get("content-type")).toBe("application/json");
    expect(token?.body).toBe("{}");
    const upload = requests[1]?.init;
    expect(new Headers(upload?.headers).get("x-bb-plugin-token")).toBe("tok_123");
    expect(upload?.body).toBe(file);
  });
});

function DropTarget({ onFiles }: { onFiles: (files: File[]) => void }) {
  const { dragging, bind } = useFileDrop(onFiles);
  return (
    <div data-testid="target" data-dragging={String(dragging)} {...bind}>
      <span data-testid="child">child</span>
    </div>
  );
}

describe("useFileDrop", () => {
  it("ignores drags without files and keeps the highlight while moving over children", () => {
    const onFiles = vi.fn<(files: File[]) => void>();
    const view = render(<DropTarget onFiles={onFiles} />);
    const target = view.getByTestId("target");
    const child = view.getByTestId("child");
    const text = { dataTransfer: { types: ["text/plain"], files: [] } };
    fireEvent.dragEnter(target, text);
    fireEvent.drop(target, text);
    expect(target.dataset.dragging).toBe("false");
    expect(onFiles).not.toHaveBeenCalled();

    const file = new File(["png"], "diagram.png", { type: "image/png" });
    const files = { dataTransfer: { types: ["Files"], files: [file] } };
    fireEvent.dragEnter(target, files);
    fireEvent.dragEnter(child, files);
    fireEvent.dragLeave(child, files);
    expect(target.dataset.dragging).toBe("true");
    fireEvent.drop(target, files);
    expect(target.dataset.dragging).toBe("false");
    expect(onFiles).toHaveBeenCalledWith([file]);
  });
});

describe("AddToWikiDialog", () => {
  it("prefills a code block verbatim and adds it under the best match", async () => {
    const overlay = renderOverlay({
      suggest: () => ({ suggestions: [SUGGESTION] }),
      docs: () => [DOC, OTHER_DOC],
      addToDoc: () => ({ slug: DOC.slug, title: DOC.title }),
    });
    act(() => {
      addRequests.emit({ kind: "code", threadId: "thr_1", messageId: "msg_1", code: "const token = await refresh();\n", language: "ts" });
    });
    const text = await overlay.findByRole("textbox", { name: "Text" });
    expect(text).toHaveProperty("value", "```ts\nconst token = await refresh();\n```");
    expect(await overlay.findByRole("radio", { name: /Best match: Unified notification › Global token/ })).toHaveProperty("checked", true);
    expect(overlay.getByRole("combobox", { name: "Heading" })).toHaveProperty("value", "Global token");

    fireEvent.click(overlay.getByRole("button", { name: "Add to Wiki" }));
    await waitFor(() => expect(overlay.queryByRole("dialog")).toBeNull());
    expect(rpcInputs(overlay.inspection.rpcCalls, "addToDoc")).toEqual([
      {
        target: { kind: "existing", slug: DOC.slug },
        heading: "Global token",
        text: "```ts\nconst token = await refresh();\n```",
        media: [],
        source: { kind: "thread", threadId: "thr_1", messageId: "msg_1" },
      },
    ]);
  });

  it("disables Add when there is no text and no media", async () => {
    const overlay = renderOverlay({ suggest: () => ({ suggestions: [SUGGESTION] }), docs: () => [DOC] });
    act(() => {
      addRequests.emit({ kind: "message", threadId: "thr_1", messageId: "msg_1", messageSeq: null, text: "", fromSelection: false });
    });
    await overlay.findByRole("radio", { name: /Best match/ });
    expect(overlay.getByRole("button", { name: "Add to Wiki" })).toHaveProperty("disabled", true);
  });

  it("adds message media from the thread with the picked doc and heading", async () => {
    const overlay = renderOverlay({
      suggest: () => ({ suggestions: [] }),
      docs: () => [DOC, OTHER_DOC],
      search: () => ({ docs: [], sections: [], total: 0 }),
      messageMedia: () => ({ items: [{ path: "/tmp/shot.png", name: "shot.png", kind: "image", sizeBytes: 10 }] }),
      addToDoc: () => ({ slug: OTHER_DOC.slug, title: OTHER_DOC.title }),
    });
    act(() => {
      addRequests.emit({ kind: "message", threadId: "thr_1", messageId: "msg_1", messageSeq: 7, text: "Tokens rotate daily.", fromSelection: true });
    });
    fireEvent.click(await overlay.findByRole("checkbox", { name: /shot\.png/ }));
    fireEvent.change(overlay.getByRole("textbox", { name: "Caption for shot.png" }), { target: { value: "Rotation timeline" } });
    fireEvent.click(overlay.getByRole("radio", { name: "Pick another doc…" }));
    const search = await overlay.findByRole("combobox", { name: "Search docs" });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(await overlay.findByRole("button", { name: "Doc: Push tokens" })).toBeTruthy();
    fireEvent.change(overlay.getByRole("combobox", { name: "Heading" }), { target: { value: "Rotation" } });
    fireEvent.click(overlay.getByRole("button", { name: "Add to Wiki" }));
    await waitFor(() => expect(rpcInputs(overlay.inspection.rpcCalls, "addToDoc")).toHaveLength(1));
    expect(rpcInputs(overlay.inspection.rpcCalls, "messageMedia")).toEqual([{ threadId: "thr_1", messageSeq: 7 }]);
    expect(rpcInputs(overlay.inspection.rpcCalls, "addToDoc")).toEqual([
      {
        target: { kind: "existing", slug: OTHER_DOC.slug },
        heading: "Rotation",
        text: "Tokens rotate daily.",
        media: [{ from: { kind: "path", path: "/tmp/shot.png" }, caption: "Rotation timeline" }],
        source: { kind: "thread", threadId: "thr_1", messageId: "msg_1" },
      },
    ]);
  });

  it("fills the caption from Claude's description without adding anything", async () => {
    const overlay = renderOverlay({
      suggest: () => ({ suggestions: [SUGGESTION] }),
      docs: () => [DOC],
      describeImage: () => ({ jobId: "job_1a2b3c4d" }),
      job: () => ({ status: "done", result: "A sequence diagram of the token refresh.", error: null }),
    });
    act(() => {
      addRequests.emit({ kind: "uploads", uploads: [IMAGE] });
    });
    fireEvent.click(await overlay.findByRole("button", { name: "Describe with Claude" }));
    const caption = await overlay.findByDisplayValue("A sequence diagram of the token refresh.", undefined, { timeout: 4000 });
    expect(caption.getAttribute("aria-label")).toBe("Caption for diagram.png");
    expect(rpcInputs(overlay.inspection.rpcCalls, "describeImage")).toEqual([{ from: { kind: "upload", uploadId: IMAGE.uploadId } }]);
    expect(rpcInputs(overlay.inspection.rpcCalls, "job")).toEqual([{ jobId: "job_1a2b3c4d" }]);
    expect(rpcInputs(overlay.inspection.rpcCalls, "addToDoc")).toEqual([]);
    expect(overlay.getByRole("dialog")).toBeTruthy();
  });

  it("offers a single Markdown upload as a new doc", async () => {
    const markdown: UploadInfo = {
      uploadId: "upl_aaaaaaaaaaaa",
      name: "rotation-runbook.md",
      kind: "markdown",
      sizeBytes: 40,
      text: "# Token rotation\n\nRotate every 24 hours.\n",
    };
    const overlay = renderOverlay({
      suggest: () => ({ suggestions: [] }),
      docs: () => [],
      createDoc: () => ({ ...OTHER_DOC, slug: "token-rotation", title: "Token rotation" }),
    });
    act(() => {
      addRequests.emit({ kind: "uploads", uploads: [markdown] });
    });
    await waitFor(() => expect(overlay.getByRole("radio", { name: "New doc from this file" })).toHaveProperty("checked", true));
    fireEvent.click(overlay.getByRole("button", { name: "Create doc" }));
    await waitFor(() => expect(rpcInputs(overlay.inspection.rpcCalls, "createDoc")).toHaveLength(1));
    expect(rpcInputs(overlay.inspection.rpcCalls, "createDoc")).toEqual([
      { title: "Token rotation", type: "topic", aliases: [], body: "# Token rotation\n\nRotate every 24 hours." },
    ]);
  });
});

describe("Add to Wiki text helpers", () => {
  it("fences code with a longer fence when the code holds backticks", () => {
    expect(fencedCode("echo hi", "sh")).toBe("```sh\necho hi\n```");
    expect(fencedCode("```js\nx\n```", "md")).toBe("````md\n```js\nx\n```\n````");
  });

  it("titles a Markdown file from frontmatter, its first H1, or its name", () => {
    expect(fileTitle({ name: "a.md", text: "---\ntitle: From frontmatter\n---\n# Heading\n" })).toBe("From frontmatter");
    expect(fileTitle({ name: "a.md", text: "intro\n\n# From heading\n" })).toBe("From heading");
    expect(fileTitle({ name: "release-checklist.md", text: "no heading" })).toBe("Release checklist");
    expect(fileDocBody("---\ntitle: X\n---\n\n# X\n\n## Steps\n- one\n")).toBe("# X\n\n## Steps\n- one");
    expect(fileDocBody("# Meeting notes 10-14\n\nAgenda line\n")).toBe("# Meeting notes 10-14\n\nAgenda line");
    expect(fileDocBody("---\ntitle: Release process\n---\n# Shipping checklist v2\n- step\n")).toBe("# Shipping checklist v2\n- step");
  });

  it("keeps a file's frontmatter aliases that no other doc uses", () => {
    const text = "---\ntitle: Release process\naliases: [rp, Ship, taken]\n---\n# Release\n";
    expect(fileAliases(text, [{ ...DOC, tag: "other", aliases: ["taken"] }])).toEqual(["rp", "ship"]);
    expect(fileAliases("# No frontmatter\n", [])).toEqual([]);
  });
});

const DOC_HIT: DocHit = { ...DOC, matched: "title" };
const SECTION_HIT: SectionHit = {
  slug: DOC.slug,
  title: DOC.title,
  type: DOC.type,
  heading: "Global token",
  headingPath: "Unified notification › Global token",
  anchor: "global-token",
  snippet: "the \u0002token\u0003 refreshes hourly",
};

describe("QuickSearch", () => {
  it("opens the highlighted section with Enter and closes", async () => {
    const empty: SearchResult = { docs: [], sections: [], total: 0 };
    const found: SearchResult = { docs: [DOC_HIT], sections: [SECTION_HIT], total: 2 };
    const overlay = renderOverlay({
      search: (input) => (typeof input === "object" && input !== null && "query" in input && input.query === "token" ? found : empty),
    });
    act(() => {
      searchRequests.emit(null);
    });
    const input = await overlay.findByRole("combobox", { name: "Search the Wiki" });
    fireEvent.change(input, { target: { value: "token" } });
    expect((await overlay.findByText("token", { selector: "mark" })).tagName).toBe("MARK");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(overlay.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "wiki", options: { subPath: "doc/unified-notification#global-token" } },
    ]);
    await waitFor(() => expect(overlay.queryByRole("combobox", { name: "Search the Wiki" })).toBeNull());
  });
});

function Original() {
  return <pre>const a = 1;</pre>;
}

const FENCE = {
  code: "const a = 1;",
  language: "ts",
  status: "closed" as const,
  index: 0,
  message: { id: "msg_1", threadId: "thr_1", turnId: null, projectId: null },
  Original,
};

describe("CodeFenceWithWikiButton", () => {
  it("claims only valid languages and never inline-vis", () => {
    expect(WIKI_CODE_LANGUAGES.every((language) => /^[a-z0-9][a-z0-9+#._-]*$/.test(language))).toBe(true);
    expect(WIKI_CODE_LANGUAGES).not.toContain("inline-vis");
    expect(new Set(WIKI_CODE_LANGUAGES).size).toBe(WIKI_CODE_LANGUAGES.length);
  });

  it("emits a code add request from the button", () => {
    const received: AddRequest[] = [];
    const unsubscribe = addRequests.subscribe((request) => received.push(request));
    const fence = renderSlot({ component: CodeFenceWithWikiButton }, FENCE, { settings: { codeBlockButton: true } });
    expect(fence.getByText("const a = 1;")).toBeTruthy();
    fireEvent.click(fence.getByRole("button", { name: "Add to Wiki" }));
    unsubscribe();
    expect(received).toEqual([{ kind: "code", threadId: "thr_1", messageId: "msg_1", code: "const a = 1;", language: "ts" }]);
  });

  it("renders only the original block when the setting is off or the fence is still streaming", () => {
    const off = renderSlot({ component: CodeFenceWithWikiButton }, FENCE, { settings: { codeBlockButton: false } });
    expect(off.getByText("const a = 1;")).toBeTruthy();
    expect(off.queryByRole("button", { name: "Add to Wiki" })).toBeNull();
    cleanup();
    const streaming = renderSlot({ component: CodeFenceWithWikiButton }, { ...FENCE, status: "streaming" as const }, {});
    expect(streaming.queryByRole("button", { name: "Add to Wiki" })).toBeNull();
  });
});

describe("NewDocView", () => {
  it("offers an existing doc before creating a duplicate", async () => {
    const onDone = vi.fn<(slug: string) => void>();
    const view = renderSlot(
      { component: NewDocView },
      { onDone, onCancel: () => {} },
      {
        rpc: {
          suggest: () => ({ suggestions: [SUGGESTION] }),
          addToDoc: () => ({ slug: DOC.slug, title: DOC.title }),
        },
      },
    );
    fireEvent.change(view.getByRole("textbox", { name: "Title" }), { target: { value: "Token refresh" } });
    fireEvent.change(view.getByRole("textbox", { name: "Body" }), { target: { value: "Tokens refresh hourly." } });
    fireEvent.click(view.getByRole("button", { name: "Check for existing docs" }));
    fireEvent.click(await view.findByRole("button", { name: "Add to Unified notification under Global token" }));
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(DOC.slug));
    expect(rpcInputs(view.inspection.rpcCalls, "suggest")).toEqual([{ text: "Tokens refresh hourly.", title: "Token refresh" }]);
    expect(rpcInputs(view.inspection.rpcCalls, "addToDoc")).toEqual([
      {
        target: { kind: "existing", slug: DOC.slug },
        heading: "Global token",
        text: "Tokens refresh hourly.",
        media: [],
        source: { kind: "manual" },
      },
    ]);
  });

  it("creates the doc right away when nothing similar exists", async () => {
    const onDone = vi.fn<(slug: string) => void>();
    const view = renderSlot(
      { component: NewDocView },
      { onDone, onCancel: () => {} },
      { rpc: { suggest: () => ({ suggestions: [] }), createDoc: () => OTHER_DOC } },
    );
    fireEvent.change(view.getByRole("textbox", { name: "Title" }), { target: { value: "Push tokens" } });
    const alias = view.getByRole("textbox", { name: "Add alias" });
    fireEvent.change(alias, { target: { value: "@PT" } });
    fireEvent.keyDown(alias, { key: "Enter" });
    fireEvent.keyDown(view.getByRole("textbox", { name: "Title" }), { key: "Enter", metaKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(OTHER_DOC.slug));
    expect(rpcInputs(view.inspection.rpcCalls, "createDoc")).toEqual([{ title: "Push tokens", type: "topic", aliases: ["pt"], body: "" }]);
  });

  it("keeps an alias that is still being typed when the user presses the shortcut", async () => {
    const onDone = vi.fn<(slug: string) => void>();
    const view = renderSlot(
      { component: NewDocView },
      { onDone, onCancel: () => {} },
      { rpc: { suggest: () => ({ suggestions: [] }), createDoc: () => OTHER_DOC } },
    );
    fireEvent.change(view.getByRole("textbox", { name: "Title" }), { target: { value: "Push tokens" } });
    const alias = view.getByRole("textbox", { name: "Add alias" });
    fireEvent.change(alias, { target: { value: "pt" } });
    fireEvent.keyDown(alias, { key: "Enter", metaKey: true });
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(OTHER_DOC.slug));
    expect(rpcInputs(view.inspection.rpcCalls, "createDoc")).toEqual([{ title: "Push tokens", type: "topic", aliases: ["pt"], body: "" }]);
  });
});
