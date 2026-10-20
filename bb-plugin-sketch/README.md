# Sketch

A quiet, hand-drawn whiteboard for diagrams, on its own page in the bb
sidebar. Draw boxes, arrows, text, and pen strokes, then select any part of a
sketch and send it to your Wiki: straight into a doc, or to the Wiki inbox to
review later.

Each sketch is an Excalidraw file (`~/Sketches/<name>.excalidraw`), so it also
opens on excalidraw.com and in other Excalidraw tools.

## Install

```sh
npm install
bb plugin install .
```

That adds the **Sketch** page to the sidebar, the `bb sketch` command, and the
`sketch` skill. Sending to the Wiki needs the [Wiki](../bb-plugin-wiki)
plugin. Inbox cards need a Wiki version that has `addCard`; with an older
Wiki you can still add images to a doc.

## Draw

Pick a tool in the toolbar at the top, or press its key. After you draw a
shape, the tool goes back to **Select**; press `Q` (the lock) to keep it.
The pen stays on after each stroke.

| Tool | Keys |
| --- | --- |
| Select | `V` or `1` |
| Hand | `H` (or hold `Space`) |
| Rectangle, diamond, ellipse | `R`/`2`, `D`/`3`, `O`/`4` |
| Arrow, line | `A`/`5`, `L`/`6` |
| Draw (pen) | `P`, `X`, or `7` |
| Text | `T` or `8` |
| Eraser | `E` or `0` |

- **Shapes.** Drag to draw. `Shift` makes a square or circle.
- **Arrows.** Drag from one shape to another and the arrow attaches. Move a
  shape and its arrows follow. `Shift` snaps to 15° steps.
- **Text.** Click with the text tool, or double-click empty canvas.
  Double-click text to edit it. Double-click a shape, or the empty middle of
  an unfilled one (or select it and press `Enter`), to write a label inside
  it. `Esc`, `⌘Enter`, or a click elsewhere finishes; empty text is removed.
- **Style.** With something selected, the panel on the left sets stroke and
  fill colors, fill style, stroke width and style, sloppiness, edges,
  arrowheads, font, and opacity. New elements use the last style you picked.
- **Move around.** Scroll to pan, `⌘`-scroll or pinch to zoom. `⇧1` fits
  everything, `⇧2` fits the selection, `⇧0` goes back to 100%.

## Select

- Click an element to select it. `Shift`-click adds or removes.
- Drag on empty canvas to draw a box. Everything fully inside it is selected.
- Drag a selection to move it (`Shift` locks the direction, `Alt` drags a
  copy). Arrow keys nudge it. Handles resize it.
- `⌘G` groups the selection so it selects and moves as one; `⌘⇧G` ungroups.
- Right-click for copy, paste, duplicate, layer order, grouping, and
  **Send to Wiki**.

## Send to Wiki

Select part of a sketch and click **Send to Wiki** (top right), or press
`⌘⇧S`. With nothing selected, the whole sketch is sent.

The dialog shows the exact image that will be sent (a PNG on white), a
**Caption** filled in from the text you selected, and an optional note. Then
pick where it goes:

- **Inbox.** The image becomes a card in the Wiki inbox, marked "From
  Sketch". Review it there like any other card, and pick its doc and heading
  when you accept it. If your Wiki is too old for inbox cards, Inbox is
  turned off and Doc is picked.
- **Doc.** Search your Wiki docs (by title, alias, or `@tag`; best matches
  come first), pick a heading, and the image is added to that doc right away.
  The doc picked when the dialog opens (the one you last sent to, else the
  best match) doesn't change while you type.

Press `⌘Enter` to send. A toast offers **Review** or **Open** to jump to the
card or the doc. The dialog remembers where you last sent to. If the Wiki is
turned off or can't be reached, the dialog says why and sending is off.

## Keys

Press `?` on the Sketch page for the full list.

| Key | Does |
| --- | --- |
| `⌘Z`, `⌘⇧Z` | Undo, redo |
| `⌘C`, `⌘X`, `⌘V` | Copy, cut, paste (Excalidraw clipboard format; pasted text becomes a text element) |
| `⌘D`, `⌘A` | Duplicate, select all |
| `Delete` | Delete |
| `⌘[`, `⌘]` | Send backward, bring forward |
| `⌘⌥[`, `⌘⌥]` | Send to back, bring to front |
| `⌘'` | Show the grid (snaps to it) |
| `⌥⇧C` | Copy the selection as a PNG |
| `⌘⇧S` | Send to Wiki |
| `Esc` | Cancel, finish text, clear the selection |

## Sketches

The menu at the top left (the sketch's name) lists your sketches and has
**New sketch**, **Rename…**, **Duplicate**, **Delete…**, **Open .excalidraw
file…**, and **Export** (PNG, SVG, or `.excalidraw`). Changes save as you
draw.

- **Changed somewhere else.** If a sketch changes outside this page while you
  have unsaved edits, a banner asks whether to **Reload** it or **Keep
  mine**.
- **Renamed.** If the open sketch is renamed in bb (`bb sketch rename` or
  another window), the page follows the new name.
- **Gone.** If its file is renamed, moved, or deleted outside bb, a banner
  offers **Save as a new sketch**, which saves your drawing as
  “<name> (my edits)”.
- **Leaving.** If you leave while either banner is up and you have unsaved
  edits, they are saved as “<name> (my edits)” too.
- **Unreadable parts.** If a file has elements Sketch can't read, a note
  says how many. Elements with broken fields are kept as placeholders and
  saved back unchanged. Elements with no id, a repeated id, or no position
  are left out when Sketch saves.

## Settings

Change them in bb's plugin settings, or with
`bb plugin config sketch set <key> <value>`.

| Key | Default | What it does |
| --- | --- | --- |
| `sketchDirectory` | `~/Sketches` | Folder of `.excalidraw` files. An absolute path or one starting with `~/`, created on first save. It can't be your home folder or hold it. |

## CLI

| Command | Does |
| --- | --- |
| `bb sketch list` | List sketches: name, element count, last change. Alias `ls`. |
| `bb sketch show <sketch>` | Print the sketch's `.excalidraw` JSON. Aliases `cat`, `get`. |
| `bb sketch new [<title>] [--file <path> \| --content <json> \| --content-stdin]` | Create a sketch, empty or from Excalidraw JSON. Says how many elements it skipped or kept as placeholders. Alias `create`. |
| `bb sketch rename <sketch> <title>` | Rename. Alias `mv`. |
| `bb sketch duplicate <sketch>` | Copy to `<name> copy`. Aliases `cp`, `copy`. |
| `bb sketch delete <sketch>` | Delete. Aliases `rm`, `remove`. |
| `bb sketch export <sketch> [--format excalidraw\|svg\|png] [--out <path>]` | Export. `excalidraw` and `svg` print to stdout without `--out`; `png` needs `--out`. |
| `bb sketch send <sketch> (--inbox \| --doc <doc>) [--heading <h>] [--caption <text>] [--note <md>]` | Send the whole sketch to the Wiki. |
| `bb sketch status` | Folder, sketch count, and whether the Wiki is ready, and whether it takes inbox cards ("doc only" when it doesn't). |

`<sketch>` is the exact name, the name in any case, or a unique prefix.
`<doc>` is a Wiki slug, title, alias, `@tag`, or `Title#Heading`. Every
command takes `--json`.

PNG export and `send` use the image Sketch draws in bb a few seconds after
each change. If a sketch changed since it was last open in bb, they ask you to
open it once.

From inside a thread, `send --doc` files an inbox card that proposes the doc
instead of writing to it. Cards sent from a thread are marked "Sent by an
agent", and only you can accept them. When the Wiki can't take inbox cards,
`send --inbox` (and `send --doc` from a thread) stops before sending. If the
Wiki doesn't answer a send within 2 minutes, the image may still arrive, so
check the Wiki before you send it again.

## Where the files live

```
~/Sketches/
├── Login flow.excalidraw     one sketch per file
└── Untitled.excalidraw
```

The files are the source of truth, and Sketch picks up changes made outside
bb. The plugin's SQLite database (`<bb data dir>/plugins/sketch/`) holds
only the latest PNG of each sketch for the CLI. Images you send are copied
into the Wiki (its `assets/` folder, or its inbox card storage). Sketch
deletes its temporary copy once the Wiki answers. If the Wiki never answers,
the copy stays so the Wiki can still read it, and the next send deletes
copies older than an hour.

## Not in this version

Rotation handles (rotated shapes from Excalidraw files still draw rotated),
curved, elbow, and multi-point arrow editing, arrow labels, images, frames,
libraries, collaboration, and agent tools that draw.

## Develop

```sh
npm install
npm run check        # typecheck, tests, build
bb plugin dev        # rebuild and reload on save
```

`@get-bb/plugin-sdk` comes from `vendor/`, the same SDK tarball the Wiki
uses. [SPEC.md](SPEC.md) is the design. The hand-drawn font is Excalifont,
under the SIL Open Font License ([assets/Excalifont-OFL.txt](assets/Excalifont-OFL.txt)).

## Layout

| Path | What it holds |
| --- | --- |
| `app.tsx` | App entry: the Sketch page and its icon. |
| `contract.ts` | RPC contract and shared zod schemas. |
| `lib/scene.ts` | Excalidraw file format: parsing, serializing, element types. |
| `lib/` | The drawing engine: geometry, hit testing, resize, arrow binding, text layout, rendering with roughjs and perfect-freehand, SVG export, history, clipboard. |
| `components/` | Editor UI: canvas, gestures, toolbar, properties, menus, autosave, Send to Wiki dialog, PNG export. |
| `server.ts`, `server/` | Sketch folder and files, previews, folder watcher, RPC, `bb sketch`, and the Wiki adapter. |
| `skills/sketch/SKILL.md` | Agent skill. |
