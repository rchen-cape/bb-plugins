---
name: sketch
description: List, read, create, export, and send the user's Sketch whiteboards (Excalidraw .excalidraw files) with the bb sketch CLI. Use when the user mentions Sketch, a sketch or whiteboard by name, an .excalidraw file, or asks to turn a diagram into a sketch, export one as SVG or PNG, or put one in the Wiki.
---

# Sketch

Sketch is the user's whiteboard page in the bb sidebar. Each sketch is one
Excalidraw file, `<name>.excalidraw`, in the Sketch folder (`~/Sketches` by
default; `bb sketch status` prints it). A sketch's name is its file name
without the extension. Files open on excalidraw.com too.

## Finding and reading sketches

```
bb sketch list [--json]
bb sketch show <sketch> [--json]
bb sketch status [--json]
```

`<sketch>` is the exact name, the name in any case, or a unique prefix.
`show` prints the `.excalidraw` JSON. Read the `text` of text elements to
learn what a sketch says; shapes, arrows, and pen strokes carry positions and
styles only.

## Making a sketch

Write a complete Excalidraw file, then create the sketch from it:

1. Write JSON like
   `{"type":"excalidraw","version":2,"elements":[...],"appState":{},"files":{}}`
   to a file. Use Excalidraw's element types `rectangle`, `ellipse`,
   `diamond`, `arrow`, `line`, and `text`. Every element needs:
   - a unique `id`, and numbers for `x` and `y` (the top-left corner);
   - `width` and `height`.

   Per type, add:
   - arrows and lines: `points`, at least two `[x, y]` pairs relative to
     `x`/`y`, like `[[0,0],[160,0]]`. Arrows take `"endArrowhead": "arrow"`
     (the default when left out) or `null` for no head, and
     `"startArrowhead"` (default `null`). Other heads are `"triangle"`,
     `"circle"`, `"diamond"`, and `"bar"`.
   - text: `text` (use `\n` for line breaks), and optionally `fontSize`
     (default 20) and `textAlign` (`"left"`, `"center"`, `"right"`).

   Any element can set `strokeColor` and `backgroundColor` (CSS hex like
   `"#1971c2"`, or `"transparent"`), `fillStyle` (`"solid"`, `"hachure"`,
   `"cross-hatch"`), `strokeWidth` (1, 2, or 4), and `strokeStyle`
   (`"solid"`, `"dashed"`, `"dotted"`).
2. Run `bb sketch new "<title>" --file <path>`, or pipe the JSON with
   `bb sketch new "<title>" --content-stdin`. A taken title gets " 2", " 3",
   and so on; the command prints the name it used.
3. Read the output. "Skipped N elements" means those elements had no unique
   `id` or no numeric `x`/`y`. "Kept N elements … as placeholders" means a
   required field such as `points` or `text` was missing or wrong. Fix the
   JSON and create the sketch again.
4. Tell the user the sketch's name so they can open it on the Sketch page.

Paths are absolute, `~/`, or relative to the current folder. Without `--file`
or `--content`, `new` makes an empty sketch. Sketch refuses files that are not
Excalidraw JSON and changes nothing. With `--json`, `new` also reports
`skipped` and `placeholders` counts.

Do not edit files in the Sketch folder directly; use the CLI.

## Exporting

```
bb sketch export <sketch> [--format excalidraw|svg|png] [--out <path>] [--json]
```

`excalidraw` and `svg` print to stdout unless `--out` is given. The format
follows the `--out` extension when `--format` is left out. `png` needs
`--out`, and uses the image Sketch drew the last time the sketch was open in
bb. If that image is missing or older than the file, the command says
"Open “<name>” in bb once so Sketch can draw its image."; ask the user to open
it, then run the command again.

## Sending to the Wiki

```
bb sketch send <sketch> --inbox [--caption <text>] [--note <markdown>]
bb sketch send <sketch> --doc <doc> [--heading <heading>] [--caption <text>] [--note <markdown>]
```

This sends the whole sketch as a PNG, so it needs the same up-to-date image as
`export --format png`. `--inbox` files a card in the Wiki inbox for the user to
review. `<doc>` is a Wiki slug, title, alias, or `@tag` (`"Title#Heading"`
also picks the heading; the default heading is `Unsorted`). From inside a
thread, `--doc` files an inbox card that proposes that doc and heading;
nothing is written to the doc until the user accepts the card. Cards sent
from a thread are marked as sent by an agent, and only the user can accept
them (`bb wiki accept` from a thread refuses). The caption defaults to the
sketch's text.

If `bb sketch status` says the Wiki is ready "doc only" (with `--json`,
`wiki.inbox` is `false`), the running Wiki can't take inbox cards. Then
`--inbox`, and `--doc` from inside a thread, stop before sending with code
`wiki_no_inbox`; ask the user to update the Wiki plugin.

If a send says the Wiki didn't answer in time, the image may still arrive.
Check the doc or the inbox (`bb wiki inbox`) before sending it again.

## Changing sketches

```
bb sketch rename <sketch> <title>
bb sketch duplicate <sketch>
bb sketch delete <sketch>
```

Names are unique without regard to case. Delete removes the file for good, so
rename or delete a sketch only when the user asks. A sketch open in bb follows
a rename made here.
