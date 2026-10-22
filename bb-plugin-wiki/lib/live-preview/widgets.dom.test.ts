// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { livePreview, type LivePreviewOptions } from "./decorations.js";
import { editorBasics } from "./setup.js";
import { installDomPolyfills } from "./test-dom.js";

installDomPolyfills();

const views: EditorView[] = [];

function mount(
  doc: string,
  options: LivePreviewOptions = {},
  extra: Extension = [],
): EditorView {
  const parent = document.createElement("div");
  document.body.append(parent);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        editorBasics({ ariaLabel: "Test note" }),
        livePreview(options),
        extra,
      ],
    }),
  });
  views.push(view);
  return view;
}

function mouse(type: string, init: MouseEventInit = {}): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  });
}

afterEach(() => {
  for (const view of views.splice(0)) {
    view.destroy();
    view.dom.parentElement?.remove();
  }
});

describe("CheckboxWidget", () => {
  it("renders real checkboxes and toggles the task source on click", () => {
    const view = mount("- [ ] first\n- [X] second\n");
    const boxes = view.dom.querySelectorAll<HTMLInputElement>(
      "input.cm-lp-checkbox",
    );
    expect(boxes).toHaveLength(2);
    const [first, second] = [boxes.item(0), boxes.item(1)];
    expect(first.checked).toBe(false);
    expect(second.checked).toBe(true);
    const down = mouse("mousedown");
    first.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    first.click();
    expect(view.state.doc.toString()).toBe("- [x] first\n- [X] second\n");
    expect(
      view.dom
        .querySelectorAll<HTMLInputElement>("input.cm-lp-checkbox")
        .item(0).checked,
    ).toBe(true);
    second.click();
    expect(view.state.doc.toString()).toBe("- [x] first\n- [ ] second\n");
    view.dom
      .querySelectorAll<HTMLInputElement>("input.cm-lp-checkbox")
      .item(0)
      .click();
    expect(view.state.doc.toString()).toBe("- [ ] first\n- [ ] second\n");
  });
});

describe("TableWidget", () => {
  const doc =
    "intro\n\n| Name | **Score** | Note |\n| :--- | ---: | :-: |\n| `a` | 1 | [x](y) |\n| b |\n\nend";

  it("renders a real table with stripped inline marks and alignment", () => {
    const view = mount(doc);
    const table = view.dom.querySelector("table.cm-lp-table");
    expect(table).not.toBeNull();
    const headers = [...view.dom.querySelectorAll("th")].map(
      (cell) => cell.textContent,
    );
    expect(headers).toEqual(["Name", "Score", "Note"]);
    const rows = [...view.dom.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["a", "1", "x"],
      ["b", "", ""],
    ]);
    const aligns = [...view.dom.querySelectorAll("th")].map(
      (cell) => cell.style.textAlign,
    );
    expect(aligns).toEqual(["left", "right", "center"]);
  });

  it("moves the selection into the source cell on click", () => {
    const view = mount(doc);
    const cell = [...view.dom.querySelectorAll("td")].find(
      (element) => element.textContent === "1",
    );
    if (cell === undefined) throw new Error("missing cell");
    const down = mouse("mousedown");
    cell.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    const head = view.state.selection.main.head;
    expect(view.state.doc.sliceString(head - 1, head)).toBe("1");
    expect(view.state.doc.lineAt(head).text).toBe("| `a` | 1 | [x](y) |");
  });
});

describe("links", () => {
  it("opens rendered links on a plain click and any link on Mod-click", () => {
    const openLink = vi.fn<(href: string) => void>();
    const view = mount("see [docs](https://a.dev) and https://b.dev\n", {
      openLink,
    });
    const link = view.dom.querySelector(".cm-lp-link");
    if (link === null) throw new Error("missing link");
    expect(link.getAttribute("data-href")).toBe("https://a.dev");
    const down = mouse("mousedown");
    link.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(true);
    expect(openLink).not.toHaveBeenCalled();
    link.dispatchEvent(mouse("mouseup"));
    expect(openLink).toHaveBeenCalledWith("https://a.dev");
    const url = view.dom.querySelector(".cm-lp-url");
    if (url === null) throw new Error("missing url");
    url.dispatchEvent(mouse("mousedown"));
    url.dispatchEvent(mouse("mouseup"));
    expect(openLink).toHaveBeenCalledTimes(1);
    url.dispatchEvent(mouse("mousedown", { ctrlKey: true }));
    expect(openLink).toHaveBeenLastCalledWith("https://b.dev");
  });

  it("does not open a link when the press turns into a drag", () => {
    const openLink = vi.fn<(href: string) => void>();
    const view = mount("see [docs](https://a.dev) and more text\n", {
      openLink,
    });
    const link = view.dom.querySelector(".cm-lp-link");
    if (link === null) throw new Error("missing link");
    link.dispatchEvent(mouse("mousedown", { clientX: 10, clientY: 10 }));
    document.dispatchEvent(
      mouse("mousemove", { clientX: 60, clientY: 10, buttons: 1 }),
    );
    document.dispatchEvent(mouse("mouseup", { clientX: 60, clientY: 10 }));
    expect(openLink).not.toHaveBeenCalled();
  });
});

describe("other widgets", () => {
  it("renders bullets, rules, code labels and the frontmatter widget", () => {
    const view = mount(
      "---\na: 1\n---\n- one\n  - two\n\n---\n\n```js\nx\n```\n",
    );
    expect(
      [...view.dom.querySelectorAll(".cm-lp-bullet")].map(
        (bullet) => bullet.textContent,
      ),
    ).toEqual(["•", "◦"]);
    expect(view.dom.querySelectorAll(".cm-lp-hr")).toHaveLength(1);
    expect(view.dom.querySelector(".cm-lp-code-label")?.textContent).toBe("js");
    expect(view.dom.querySelector(".cm-lp-frontmatter")?.textContent).toBe(
      "Properties",
    );
    expect(view.contentDOM.getAttribute("aria-label")).toBe("Test note");
  });

  it("shows images from resolveImage", () => {
    const view = mount("![a cat](cat.png)\n\nnext", {
      resolveImage: (src) => `/files/${src}`,
    });
    const image = view.dom.querySelector<HTMLImageElement>("img.cm-lp-image");
    expect(image?.getAttribute("src")).toBe("/files/cat.png");
    expect(image?.alt).toBe("a cat");
  });
});
