// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpcContract, type WikiSuggestion } from "../contract";
import { inputsOf, openSketch, type Handlers } from "./editor-test-support";

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), message: vi.fn(), loading: vi.fn(() => "t"), dismiss: vi.fn() }),
}));

vi.mock("./export-png", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./export-png")>();
  return { ...actual, renderPng: vi.fn(async () => ({ blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), width: 10, height: 10 })) };
});

const ALPHA: WikiSuggestion = { slug: "alpha", title: "Alpha project", heading: "Diagrams", reason: "about the plan" };
const BETA: WikiSuggestion = { slug: "beta", title: "Beta topic", heading: null, reason: "mentions gRPC" };

function suggestByNote(): Partial<Handlers> {
  return {
    wikiSuggest: (input) => ({ suggestions: rpcContract.wikiSuggest.input.parse(input).text.includes("gRPC") ? [BETA, ALPHA] : [ALPHA, BETA] }),
  };
}

async function openDialog(overrides: Partial<Handlers> = {}) {
  const page = await openSketch(overrides);
  page.root.focus();
  fireEvent.keyDown(page.root, { key: "s", code: "KeyS", metaKey: true, shiftKey: true });
  const dialog = await page.slot.findByRole("dialog", { name: "Send to Wiki" });
  await within(dialog).findByText(/PNG · 10 × 10 px/);
  return { ...page, dialog };
}

function headingSelect(dialog: HTMLElement): HTMLSelectElement {
  const select = within(dialog).getByRole("combobox", { name: "Heading" });
  if (!(select instanceof HTMLSelectElement)) throw new Error("no heading select");
  return select;
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("sketch:view:v1:Plan", JSON.stringify({ scrollX: 0, scrollY: 0, zoom: 1 }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("choosing a doc", () => {
  it("keeps the first best match and the chosen heading while suggestions change", async () => {
    const { slot, dialog } = await openDialog(suggestByNote());
    fireEvent.click(within(dialog).getByRole("radio", { name: "Doc" }));
    await within(dialog).findByRole("button", { name: "Add to Alpha project" });
    expect(headingSelect(dialog).value).toBe("Diagrams");
    fireEvent.change(headingSelect(dialog), { target: { value: "Unsorted" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Add a note/ }), { target: { value: "Go gRPC protobuf" } });
    await waitFor(() => expect(within(dialog).getAllByRole("option")[0]?.textContent).toContain("Best match: Beta topic"), { timeout: 2000 });
    expect(within(dialog).getByRole("button", { name: "Add to Alpha project" })).toBeTruthy();
    expect(headingSelect(dialog).value).toBe("Unsorted");
    await act(async () => {
      fireEvent.keyDown(dialog, { key: "Enter", metaKey: true });
    });
    await waitFor(() => expect(inputsOf(slot.inspection.rpcCalls, "sendToWiki")).toHaveLength(1));
    expect(rpcContract.sendToWiki.input.parse(inputsOf(slot.inspection.rpcCalls, "sendToWiki")[0]).destination).toEqual({ kind: "doc", slug: "alpha", heading: "Unsorted" });
  });

  it("only reorders the list after the user picks a doc", async () => {
    const { dialog } = await openDialog(suggestByNote());
    fireEvent.click(within(dialog).getByRole("radio", { name: "Doc" }));
    fireEvent.click(await within(dialog).findByRole("option", { name: /Beta topic/ }));
    expect(within(dialog).getByRole("button", { name: "Add to Beta topic" })).toBeTruthy();
    fireEvent.change(within(dialog).getByRole("textbox", { name: /Caption/ }), { target: { value: "Plan" } });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(within(dialog).getByRole("button", { name: "Add to Beta topic" })).toBeTruthy();
  });

  it("puts the cursor in the doc search when Doc is clicked", async () => {
    const { dialog } = await openDialog(suggestByNote());
    fireEvent.click(within(dialog).getByRole("radio", { name: "Doc" }));
    await within(dialog).findByRole("button", { name: "Add to Alpha project" });
    expect(document.activeElement).toBe(within(dialog).getByRole("combobox", { name: "Search Wiki docs" }));
  });

  it("puts the cursor in the doc search when Doc is clicked while already chosen", async () => {
    const docs = [{ slug: "alpha", title: "Alpha project", type: "project", aliases: [], tag: "", headings: ["Diagrams"] }];
    const { dialog } = await openDialog({ wikiDocs: () => ({ wiki: { available: true, inbox: false }, docs }) });
    const doc = within(dialog).getByRole("radio", { name: "Doc" });
    await waitFor(() => expect(doc.getAttribute("aria-checked")).toBe("true"));
    const search = await within(dialog).findByRole("combobox", { name: "Search Wiki docs" });
    doc.focus();
    fireEvent.click(doc);
    expect(document.activeElement).toBe(search);
  });

  it("keeps arrow keys on the Where options", async () => {
    const { dialog } = await openDialog(suggestByNote());
    const inbox = within(dialog).getByRole("radio", { name: "Inbox" });
    inbox.focus();
    fireEvent.keyDown(inbox, { key: "ArrowRight" });
    const doc = within(dialog).getByRole("radio", { name: "Doc" });
    expect(doc.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(doc);
  });
});

describe("Wiki states", () => {
  it("explains a turned-off Wiki in Doc mode instead of listing no docs", async () => {
    const { dialog } = await openDialog({ wikiDocs: () => ({ wiki: { available: false, reason: "The Wiki plugin is turned off." }, docs: [] }) });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Doc" }));
    expect(await within(dialog).findByText(/The Wiki plugin is turned off\./)).toBeTruthy();
    expect(within(dialog).queryByText("Your Wiki has no docs yet.")).toBeNull();
    expect(within(dialog).queryByRole("combobox", { name: "Search Wiki docs" })).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Add to doc" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows why the Wiki couldn't be reached instead of loading forever", async () => {
    const { dialog } = await openDialog({
      wikiDocs: () => {
        throw new Error("docs failed");
      },
    });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Doc" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Couldn't reach the Wiki");
    expect(within(dialog).queryByText("Loading Wiki docs…")).toBeNull();
  });

  it("says when the Wiki has no docs", async () => {
    const { dialog } = await openDialog({ wikiDocs: () => ({ wiki: { available: true, inbox: true }, docs: [] }) });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Doc" }));
    expect(await within(dialog).findByText("Your Wiki has no docs yet.")).toBeTruthy();
  });

  it("turns Inbox off for a Wiki without inbox cards and opens on Doc", async () => {
    localStorage.setItem("sketch:wiki:v1", JSON.stringify({ kind: "inbox", slug: null, heading: null }));
    const { dialog } = await openDialog({ wikiDocs: () => ({ wiki: { available: true, inbox: false }, docs: [] }) });
    const inbox = within(dialog).getByRole("radio", { name: "Inbox" });
    await waitFor(() => expect(inbox.hasAttribute("disabled")).toBe(true));
    expect(within(dialog).getByRole("radio", { name: "Doc" }).getAttribute("aria-checked")).toBe("true");
    const hint = within(dialog).getByText("This Wiki version can't take inbox cards. Update the Wiki plugin, or pick a doc.");
    expect(inbox.getAttribute("aria-describedby")).toBe(hint.id);
    expect(within(dialog).queryByRole("button", { name: "Send to inbox" })).toBeNull();
  });
});

describe("sending", () => {
  it("keeps the dialog until the request settles and shows a late error", async () => {
    let fail: (error: Error) => void = () => undefined;
    const { slot, dialog } = await openDialog({ sendToWiki: () => new Promise((_, reject) => (fail = reject)) });
    const send = within(dialog).getByRole("button", { name: "Send to inbox" });
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    fireEvent.click(send);
    await within(dialog).findByRole("button", { name: "Sending…" });
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).queryByRole("button", { name: "Close" })).toBeNull();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(slot.getByRole("dialog", { name: "Send to Wiki" })).toBe(dialog);
    await act(async () => fail(new Error("The Wiki didn't answer in time.")));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("The Wiki didn't answer in time.");
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(false);
  });

  it("keeps the footer outside the scrolling body", async () => {
    const { dialog } = await openDialog();
    const body = dialog.querySelector("[data-send-body]");
    expect(body?.classList.contains("overflow-y-auto")).toBe(true);
    expect(dialog.classList.contains("overflow-hidden")).toBe(true);
    expect(dialog.classList.contains("max-h-[90dvh]")).toBe(true);
    const primary = within(dialog).getByRole("button", { name: "Send to inbox" });
    expect(primary.closest("[data-send-body]")).toBeNull();
    expect(body?.contains(within(dialog).getByRole("textbox", { name: /Caption/ }))).toBe(true);
  });

  it("returns focus to the sketch after Cancel or a send", async () => {
    const { slot, dialog, root } = await openDialog();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(root));
    fireEvent.keyDown(root, { key: "s", code: "KeyS", metaKey: true, shiftKey: true });
    const again = await slot.findByRole("dialog", { name: "Send to Wiki" });
    const send = within(again).getByRole("button", { name: "Send to inbox" });
    await waitFor(() => expect(send.hasAttribute("disabled")).toBe(false));
    await act(async () => {
      fireEvent.click(send);
    });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(root));
  });
});
