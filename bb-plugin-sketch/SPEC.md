# Sketch: build spec

Sketch is a minimal, smooth, Excalidraw-like whiteboard on a bb sidebar page.
You draw boxes, arrows, text, and pen strokes, select any part of a sketch
(click, shift-click, or drag a box around it), and send that part to the Wiki
as a PNG: straight into a doc and heading you pick, or to the Wiki inbox as a
card you review later.

This spec is the contract between the parts. `lib/sketch.ts`, `lib/scene.ts`,
`lib/excalifont.ts` and `contract.ts` already exist; build on them and keep
them backward compatible (additive changes only).

## 0. Invariants

- No code comments (bb `AGENTS.md`), except `// @vitest-environment jsdom`
  at the top of DOM test files.
- Parse untrusted input with zod at boundaries (RPC, files, localStorage,
  clipboard, Wiki responses), then pass typed values. No `as` casts except at
  true boundaries, narrowed immediately.
- Small functions, small modules. Pure logic lives in `lib/` and is unit
  tested; components wire events to it.
- UI uses host Tailwind tokens only (`bg-background`, `bg-popover`,
  `text-foreground`, `text-muted-foreground`, `border-border`, `bg-state-hover`,
  `bg-state-active`, `ring-ring`, `stroke-primary`, ...). No `dark:` variant
  (it compiles to `prefers-color-scheme`, not bb's theme), no `oklch`/gray
  literals, no `text-[Npx]` (use `text-2xs`, `text-xs`, `text-sm`,
  `text-base`). Drawing colors are data, not UI, and are the one exception:
  element colors are hex strings from the file.
- Portaled UI (dialogs, menus, popovers, tooltips) carries
  `usePortalScopeProps()` (the vendored `components/ui` already do).
- Toasts: `import { toast } from "sonner"` (host Toaster). Never mount one.
- Everything a user can do in the UI that matters outside the page (list,
  create, rename, delete, export, send to Wiki) is also a `bb sketch` CLI
  command.
- Client-persisted data (localStorage) is versioned in its key and parsed
  with `.catch` defaults so an older or newer shape never crashes the page.

## 1. Packaging

`bb-plugin-sketch` in this repo, plugin id
`sketch`, display name **Sketch**, npm, SDK from
`vendor/get-bb-plugin-sdk-0.6.43.tgz` (never run `bb plugin types`). Runtime
deps: `roughjs`, `perfect-freehand`, `zod`, `@radix-ui/react-slot`. Shimmed
host packages (react, radix portals, sonner, clsx, tailwind-merge, cva, vaul)
are devDependencies only. `npm run check` = typecheck + vitest + build.

Add to the repo: a row in the repo `README.md`
and `{ "name": "sketch", "source": "./bb-plugin-sketch" }` in
`.bb/plugins.json`.

## 2. Settings

| Key | Default | Meaning |
| --- | --- | --- |
| `sketchDirectory` | `~/Sketches` | Folder of `.excalidraw` files. Absolute or `~/`. Can't be the home folder or contain it. Created on first write. |

Read through a zod schema with `.catch(default)`, like Wiki's
`server/context.ts`.

## 3. Storage

- Each sketch is one file `<sketchDirectory>/<name>.excalidraw`. The sketch
  id and its title are the file name without the extension (validated by
  `sketchIdSchema`). Only top-level files count; other files and dot files are
  ignored.
- The format is Excalidraw's (`lib/scene.ts`, element schemas in
  `lib/scene-elements.ts`): `serializeScene` writes it, `parseSceneFile` reads
  it leniently and returns `{ scene, dropped, placeholders }`. Unknown element
  types round-trip as `unsupported` elements (kept, drawn as dashed
  placeholders, movable and deletable). A known type that fails its schema but
  has an `id` and numeric `x`/`y` is kept the same way and written back
  unchanged (counted in `placeholders`). Elements that aren't objects with a
  string `type`, or lack an `id` or numeric `x`/`y`, or repeat an id, are
  dropped (counted in `dropped`); deleted elements are left out silently. An
  arrow with no `endArrowhead` key gets `"arrow"`. A file saved by Sketch
  opens on excalidraw.com and back.
- Writes are atomic (temp dot file in the same folder, then rename) and
  serialized per sketch. `save` is compare-and-swap on the file's sha256.
- Names are unique case-insensitively (macOS). Creating `Untitled` when it
  exists picks `Untitled 2`, `Untitled 3`, ...
- Previews: the browser renders a light-theme PNG of the whole sketch after
  edits settle and stores it with `savePreview`. They live in the plugin's
  SQLite (`bb.storage.database()`), table `previews(sketch_id PRIMARY KEY,
  sha256, png BLOB, updated_at)`, keyed to the file sha they were drawn from.
  Rename moves the row; delete drops it. The CLI uses a preview only when its
  sha matches the current file.
- A background service watches the folder (`fs.watch`, debounced 300 ms; if
  watching fails it checks every 5 s and retries the watch after 60 s) and
  publishes `CHANGED_CHANNEL` so open pages refresh when files change outside
  bb. Every server write also publishes it. Payload
  `{ id: string | null, renamedTo?: string }`: the id when one file changed,
  null when several did, and `{ id: <old>, renamedTo: <new> }` for a server
  rename (RPC or CLI). A rename outside bb looks like a delete plus a create.

## 4. RPC (`contract.ts`)

| Method | Does |
| --- | --- |
| `status` | Folder (display form with `~`), sketch count, Wiki availability: `{available: true, inbox}` or `{available: false, reason}`. |
| `list` | All sketches, newest `updatedAt` first. |
| `get` | Raw file text plus sha256, or null. |
| `create` | New file. `title` null picks a free `Untitled` name; a taken title gets ` 2`, ` 3`, ... `content` null writes `emptyScene()`. Content must parse with `parseSceneFile`. |
| `save` | Write content if `expectedSha256` matches the file (null skips the check). Returns `written` or `conflict`. |
| `rename` | Rename the file. Refuses a name another sketch has (case-insensitive), except a case-only rename of itself. |
| `duplicate` | Copy to `<name> copy`, `<name> copy 2`, ... |
| `delete` | Delete the file and its preview. |
| `savePreview` | Store a PNG for the given sha. `stored: false` when the sha no longer matches the file. PNG bytes must start with the PNG signature. |
| `wikiDocs` | Wiki availability plus all Wiki docs with their tag and headings (`wiki.docs({type:null})`). Empty list when unavailable; a failed `docs` call reports `available: false` with the reason. |
| `wikiSuggest` | Wiki's `suggest`, top 5, mapped to `{slug,title,heading,reason}`. Empty when unavailable. |
| `sendToWiki` | Delete outbox folders older than an hour, write the PNG to `<pluginDataDir>/outbox/<random>/<name>.png`, and call the Wiki. The folder is deleted once the Wiki answered (a result or a Wiki error). When the Wiki never answered (timeout, abort, network error, HTTP 408/504) it stays, because the Wiki may still read it. `inbox` calls Wiki `addCard` with `threadId: null`; `doc` calls Wiki `addToDoc` with `target {kind:"existing", slug}`. |

Server handlers wrap errors into readable messages (like Wiki's `friendly`).
Wiki failures map to: not installed → "The Wiki plugin isn't installed.",
turned off → "The Wiki plugin is turned off.", not running → "The Wiki plugin
isn't running.", `unknown_method` on `addCard` → "This Wiki version can't take
inbox cards yet. Update the Wiki plugin, or pick a doc." (from a thread: "…and
from a thread --doc files an inbox card too. Update the Wiki plugin."), a
timeout on a read → "The Wiki didn't answer in time. Try again.", a timeout on
a send → "The Wiki didn't answer in time. It may still add the image, so check
the Wiki before you send it again.", a reply that doesn't parse → "The Wiki
sent a reply Sketch doesn't understand. Update the Wiki and Sketch plugins.",
otherwise the Wiki's own error message.

## 5. Wiki integration

### Sketch side (`server/wiki.ts`)

- All Wiki contract knowledge lives here (errors in `server/wiki-errors.ts`,
  the inbox check in `server/wiki-inbox.ts`). Use
  `bb.sdk.plugins.callRpc({ pluginId: WIKI_PLUGIN_ID, method, input,
  outputSchema, signal })` with loose local zod output schemas (only fields
  used). The timeout is 15 s for `list`, `docs`, `suggest` and the inbox
  check, and 120 s for `addToDoc` and `addCard`.
- Availability: `bb.sdk.plugins.list()` says whether the Wiki is installed,
  turned on and running (`running` or `degraded`). Whether it takes inbox
  cards comes from calling `addCard` with `{}`: HTTP 400 `invalid_input`
  means yes, 404 `unknown_method` means no, and anything else counts as yes
  without being cached. The answer is cached per Wiki version, status and
  `updatedAt`; a "no" is checked again after 60 s, because a local rebuild
  keeps the version. A real `addCard` reply also updates it.
- Direct add: `addToDoc({ target: {kind:"existing", slug}, heading, text:
  note, media: [{ from: {kind:"path", path}, caption }], source: {kind:
  "upload", name: "<name>.png"} })`.
- Inbox: `addCard({ name: "<name>.png", text: note, media: [{ from:
  {kind:"path", path}, caption }], target, heading, threadId })` returns the
  card; Sketch returns `{kind:"inbox", cardId: card.id}`. `target` and
  `heading` are null, except for `bb sketch send --doc` from a thread, which
  proposes `{kind:"existing", slug}` and its heading. `threadId` is the CLI
  thread id when `bb sketch send` runs in a thread, else null (the UI always
  sends null).
- Navigation after sending: Wiki routes are `/plugins/wiki/wiki/inbox/<cardId>`
  and `/plugins/wiki/wiki/doc/<slug>`.

### Wiki side (changes in `bb-plugin-wiki`)

An RPC so other plugins can file an image for review. The Wiki's SPEC
(upload cards) is the full contract; Sketch relies on this:

```ts
cardSourceSchema: add z.object({ kind: z.literal("upload"), name: z.string(), pluginId: z.string().nullable(), threadId: z.string().min(1).nullable().default(null) })

addCard: {
  input: z.object({
    name: titleSchema,
    text: z.string().max(LIMITS.text),
    media: z.array(mediaItemSchema).max(LIMITS.media),
    target: docTargetSchema.nullable(),
    heading: headingSchema.nullable(),
    threadId: z.string().min(1).nullable(),
  }).strict(),
  output: cardSchema,
}
```

- `pluginId` comes from the handler's `experimental_caller` (`{kind:"plugin",
  pluginId}`), else null. Never from input. `threadId` comes from input and is
  required, so a Wiki with `addCard` but without `threadId` rejects Sketch's
  cards; ship the two plugins together.
- Refuses an empty card (no text and no media) and text with a
  `wiki:source` marker, like agent cards. Media must be images (png, jpg,
  jpeg, gif, webp); videos are refused with a clear message.
- Images are copied at once into `<wikiDataDir>/card-media/<cardId>/<file>`
  (not into the Wiki folder; uploads expire after 24 h but card media must
  outlive them). The card text is the trimmed text, then one
  `![caption](card-media/<cardId>/<file>)` line per image, blank-line
  separated. Captions are escaped (`\`, `[`, `]`) so any caption round-trips.
- Destinations: with a target, one included destination, rule `picked`
  (heading defaults to `Unsorted`, or `Notes` for a new doc). Without one,
  mirror what agent cards without a doc get. Status `pending`; never routed
  by Claude Code.
- Accept copies each card-media image into `assets/` exactly like notes
  images (`copyAsset`, `rewriteImageTargets`), stamps the `upload="<name>"`
  source marker, and includes the assets in the git commit. Preview shows the
  rewritten paths. Skip and Restore keep the card media; a fully committed
  accept deletes `card-media/<cardId>/`.
- A card with a `threadId` counts as sent by an agent: its reasons say so,
  the inbox shows a "Sent by an agent" pill, and `bb wiki accept` from inside
  a thread refuses it.
- A local-auth `GET /card-media?path=` route serves those images (only inside
  `card-media/`, image content types, `nosniff`).
- Inbox UI: the card's source chip reads "From Sketch" (title-case the
  plugin id; "Upload" when null) plus the name. Image lines render as a
  thumbnail under the line number. The inbox list and `bb wiki inbox` use the
  first text line, else the name, never the raw `![...]` line.
- `bb wiki inbox` labels these cards `upload: <name>`.

## 6. CLI (`bb sketch`)

| Command | Does |
| --- | --- |
| `bb sketch list` | Name, element count, updated (alias `ls`). |
| `bb sketch show <sketch>` | Print the `.excalidraw` JSON (aliases `cat`, `get`). |
| `bb sketch new [<title>] [--file <path> \| --content <json> \| --content-stdin]` | Create, optionally from Excalidraw JSON (alias `create`). Prints "Skipped N elements…" and "Kept N elements … as placeholders" when `parseSceneFile` dropped or kept any; `--json` adds `skipped` and `placeholders`. |
| `bb sketch rename <sketch> <title>` | Rename (alias `mv`). |
| `bb sketch duplicate <sketch>` | Copy (aliases `cp`, `copy`). |
| `bb sketch delete <sketch>` | Delete (aliases `rm`, `remove`). |
| `bb sketch export <sketch> [--format excalidraw\|svg\|png] [--out <path>]` | `excalidraw` and `svg` print to stdout unless `--out`; `png` needs `--out` and an up-to-date preview. Without `--format`, the `--out` extension picks it. |
| `bb sketch send <sketch> (--inbox \| --doc <doc>) [--heading <h>] [--caption <text>] [--note <text>]` | Send the whole sketch's preview PNG to the Wiki. `<doc>` matches a Wiki slug, title, alias, or `@tag`, optionally `Title#Heading`. From a thread, `--doc` files an inbox card that proposes the doc, and every card carries the thread id. |
| `bb sketch status` | Folder, count, Wiki availability ("Wiki: ready for images", or "Wiki: ready (doc only — update the Wiki plugin for inbox cards)", or the reason). |

`<sketch>` matches the exact name, then case-insensitively, then a unique
prefix. Paths are absolute, `~/`, or relative to the current folder. Every
command takes `--json`. Output stays under `PLUGIN_CLI_OUTPUT_MAX_BYTES`. A
missing or stale preview fails with "Open “<name>” in bb once so Sketch can
draw its image." When the Wiki can't take inbox cards, `send --inbox`, and
`send --doc` from a thread, fail with code `wiki_no_inbox` before sending.
Suggested commands in hints quote names for the shell (`shellArg`).

## 7. Engine (`lib/`)

Pure TypeScript, no DOM except where noted, unit tested. Suggested modules
(the engine owns the exact API; the editor builds on it):

- `elements.ts`: factories (`createShape`, `createLinear`, `createFreedraw`,
  `createText`), `updateElement(el, patch)` (bumps `version`, new
  `versionNonce`, `updated`), style application, id/seed remapping for
  duplicate and paste.
- `geometry.ts`: element bounds (rotation-aware, linear and freedraw from
  points, stroke and arrowhead slack), common bounds, point-in-element hit test
  with zoom-scaled tolerance (unfilled shapes hit near the outline only; filled
  shapes, text and unsupported inside), topmost hit, marquee containment
  (fully inside), handle hit test, resize math (8 handles, Shift keeps aspect,
  Alt from center, multi-element proportional scaling incl. points and font
  size, flipping normalized), grid snapping, viewport math
  (`screenToScene`, `sceneToScreen`, zoom at point clamped 0.1–30, fit
  bounds).
- `binding.ts`: simple arrow binding. Endpoints bind to rectangle, diamond,
  ellipse, or free text within the shape or 16/zoom px of its outline. The
  endpoint sits where the line toward the target's center meets its outline,
  `gap` 4 outside (focus always 0). Moving or resizing a bound element updates
  its arrows; moving an arrow without its targets unbinds it; deleting a target
  unbinds; duplicate/paste remaps bindings inside the copied set and drops the
  rest. `boundElements` on targets stay in sync. Field names match Excalidraw.
- `text.ts`: font stacks per family (hand → Excalifont, normal → system sans,
  code → system mono), wrapping for container labels, text layout (lines,
  width, height with `lineHeight` 1.25), label placement inside rectangle,
  diamond, ellipse (inner box), container growth when a label is taller.
  Measurement takes an injected `measure(text, font) => width` so tests run
  without canvas.
- `colors.ts`: `darkColor(hex)` port of `invert(93%) hue-rotate(180deg)`,
  cached; passes through `transparent` and unparsable values.
- `render.ts`: element → render model in local coordinates (paths with d,
  fill, stroke, width, dash, line caps; text runs), via one `rough.generator()`
  with Excalidraw's option mapping (seed, `preserveVertices` when roughness < 2,
  `disableMultiStroke` for non-solid strokes, `fillWeight = sw/2`,
  `hachureGap = sw*4`, small-shape roughness reduction, rounded-rect radius,
  ellipse `curveFitting: 1`), arrowheads (arrow, triangle, bar, dot/circle,
  diamond; unknown → arrow), and perfect-freehand for pen strokes
  (`size: sw*4.25, thinning .6, smoothing .5, streamline .5, easing sin,
  simulatePressure`). Roughness 0 draws crisp strokes. Cached by a shape key
  that ignores x/y so moving never regenerates paths. Unsupported elements →
  dashed placeholder box with the original type as a label.
- `svg-export.ts`: `sceneToSvg(elements, { padding, background, embedFont })`
  → `{ svg, width, height }`. Standalone SVG string (xmlns, explicit
  width/height, viewBox), all text escaped, no foreignObject, light colors,
  `@font-face` with the base64 Excalifont faces when `embedFont` and any text
  uses the hand font. Shares `render.ts` with the live view. Runs in Node (used
  by the CLI).
- `history.ts`: undo/redo of `{elements, selectedIds}` snapshots, 100 steps.
- `clipboard.ts`: copy payload via `serializeClipboard`; paste via
  `parseClipboard`, remapping ids, seeds and bindings and offsetting to a
  point; plain text becomes a text element.
- `actions.ts`: pure scene operations the editor calls: delete (with bound
  labels and binding cleanup), duplicate (+10 px, remap), z-order (backward,
  forward, to back, to front), group / ungroup (`groupIds`, outermost group
  selection), select all, nudge, apply style patch to a selection, selection
  expansion to groups and container labels, text commit (empty deletes).

## 8. Editor UX

The page is one full-bleed canvas (`bg-background`) with small floating
islands (`rounded-lg border border-border bg-popover/95 shadow-md
backdrop-blur`). Calm, quiet, keyboard-first.

- **Top left, sketch menu:** a button with the sketch title and a chevron.
  Menu: the sketch list (current checked, newest first), **New sketch**,
  **Rename…**, **Duplicate**, **Delete…**, **Open .excalidraw file…**,
  **Export** (PNG, SVG, .excalidraw; selection-aware for PNG/SVG),
  **Show grid**, **Keyboard shortcuts**. A quiet save state next to it:
  nothing when saved, "Saving…" after 500 ms, "Couldn't save · Retry" on
  error.
- **Top center, toolbar:** lock, then hand, select, rectangle, diamond,
  ellipse, arrow, line, draw, text, eraser. Icon buttons with a tiny key hint
  in the corner and a tooltip ("Rectangle · R or 2"). Active tool is
  `bg-state-active`. Inline SVG icons (lucide-style, 24 viewBox, stroke 2).
- **Top right:** **Send to Wiki** button. With a selection it sends the
  selection, otherwise the whole sketch. `⌘⇧S` / `Ctrl+Shift+S`.
- **Top bar layout** (`TopBar.tsx`) follows the editor pane's width
  (`@container`), not the window's. From 48rem (`@3xl`) it is three columns:
  menu, toolbar, Send to Wiki. Narrower, the menu and Send to Wiki share the
  first row and the toolbar gets its own scrolling row. Below 28rem (`@md`)
  Send to Wiki shows only its icon; the `aria-label` and tooltip stay. Only
  the islands take pointer events.
- **Left, properties:** only while something is selected or a drawing tool
  is active, and only relevant rows: stroke (5 picks + custom), background
  (5 picks), fill (hachure, cross-hatch, solid), stroke width (1, 2, 4),
  stroke style, sloppiness (0, 1, 2), edges (sharp, round), arrowheads
  (start, end), font size (S M L XL), font family (hand, normal, code), text
  align, opacity, then layer and action buttons (to back, backward, forward,
  to front, duplicate, delete, send to Wiki). Mixed values show no active
  pick. Changes apply to the selection and become the style for new elements
  (remembered in `localStorage` `sketch:style:v1`). The panel is `w-56` with
  `[scrollbar-gutter:stable]`, so a six-pick row never wraps, even with a
  scrollbar.
- **Bottom left:** zoom out, zoom % (click resets to 100%), zoom in; undo,
  redo.
- **Empty canvas:** a faint centered hint ("Pick a tool, or press R, O, A, T
  to start") that never blocks pointer events.
- **Context menu** (right click; an element under the pointer gets selected
  first): Cut, Copy, Paste, Duplicate, Delete, Send to Wiki, Copy as PNG,
  layer moves, Group / Ungroup. On empty canvas: Paste, Select all, Show grid.
- **Compact screens:** toolbar scrolls horizontally; properties collapse into
  a toggle; touch drawing and two-finger pinch/pan work.

### Tools and keys

Handled in the sketch root's React `onKeyDown` (the root has `tabIndex=0`
and takes focus on pointerdown), with `preventDefault` + `stopPropagation`
for every handled key so bb chords (`⌘D`, `⌘[`, `Esc`) don't fire. Ignore
events whose target is outside the root's DOM (portaled dialogs bubble
through React) or is a typing target.

Focus stays on the root so keys keep working:

- Island buttons (tools, style picks, zoom %, Send to Wiki, banner links,
  Retry) don't take focus on a mouse click (`keepRootFocus`: mousedown
  `preventDefault`, then focus the root). Tab still reaches them. The menu
  trigger, the color input and the opacity slider keep their own focus.
- When a dialog or menu closes, focus returns to the root on the next frame
  (`useRootFocus`), but only if focus fell to `<body>`.
- When a focused button inside the root is removed (like the panel's Delete)
  and focus fell to `<body>`, the root takes focus back. A click elsewhere,
  or focus moving to a real field, cancels this.

| Key | Does |
| --- | --- |
| V / 1 | Select |
| H | Hand (pan) |
| R / 2, D / 3, O / 4 | Rectangle, diamond, ellipse |
| A / 5, L / 6 | Arrow, line |
| P / X / 7 | Draw |
| T / 8 | Text |
| E / 0 | Eraser |
| Q | Keep the tool after drawing (lock) |
| Space (hold) | Pan |
| Esc | Cancel the gesture, finish text, clear selection, back to Select |
| Delete / Backspace | Delete |
| Enter | Edit the selected text or shape label |
| ⌘A, ⌘D | Select all, duplicate |
| ⌘C, ⌘X, ⌘V | Copy, cut, paste (Excalidraw clipboard JSON; plain text pastes as text) |
| ⌘Z, ⌘⇧Z / Ctrl+Y | Undo, redo |
| ⌘G, ⌘⇧G | Group, ungroup |
| ⌘[ / ⌘], ⌘⌥[ / ⌘⌥] | Backward / forward, to back / to front |
| Arrows, ⇧ Arrows | Nudge 1 px, 5 px (grid size when the grid is on) |
| ⇧1, ⇧2, ⇧0 | Fit all, fit selection, 100% |
| ⇧= / ⇧-, ⌘ wheel / pinch | Zoom |
| Wheel, ⇧ wheel | Pan |
| ⌘' | Grid |
| ⌥⇧C | Copy selection as PNG |
| ⌘⇧S | Send to Wiki |
| ? | Keyboard shortcuts |

Copy, cut and paste use `copy`/`cut`/`paste` events on `document`, handled
only when focus is inside the root and not typing.

### Pointer behavior

- Select tool: handles first (8 resize handles on the selection box; endpoint
  handles on a single selected arrow or line), then the topmost element (a
  selected element is grabbable anywhere inside its box), else a marquee
  (selects elements fully inside; Shift adds). Click selects, Shift-click
  toggles. Clicking a grouped element selects the outermost group. Drag past 3
  screen px moves; Shift locks the axis; Alt-drag duplicates and moves the
  copy. Clicking a label selects its container.
- Drawing tools: drag to create (Shift: square / circle / 15° arrow angles;
  grid snapping when on). Too small (under 3 px) creates nothing. The new
  element is selected and the tool returns to Select, unless locked (then
  nothing is selected and the tool stays). Arrows and lines bind and
  highlight targets while dragging endpoints.
- Text: click (text tool) or double-click empty canvas creates text there;
  Enter edits the selected text or shape label. Double-click
  (`editTargetAt`) edits what is directly under the pointer: text, or a
  shape's centered label (a label resolves to its shape). Only when nothing
  is hit does it edit the label of the smallest unfilled rectangle, diamond
  or ellipse around the point. Editing uses a borderless `<textarea>` placed
  over the element with the same font, size × zoom, line height and
  (theme-mapped) color; the element is hidden meanwhile. Esc, ⌘Enter, blur
  or clicking away commits; empty text deletes the element. During an IME
  composition (`isComposing` or keyCode 229) the textarea ignores every key,
  so Esc and ⌘Enter only reach the IME.
- Draw: pen strokes with `getCoalescedEvents`; pressure from pen input. The
  Draw tool stays active after each stroke and the stroke isn't selected.
- Eraser: elements touched by the drag fade, and are deleted on release; Esc
  cancels.
- Hand, Space-drag, middle-drag pan. Wheel pans, ⌘/Ctrl-wheel and trackpad
  pinch zoom at the cursor (non-passive wheel listener). Line and page wheel
  deltas are turned into pixels. Each zoom event scales by
  `exp(-deltaY × 0.01)` with `deltaY` capped at ±10 (about 10.5%), and the
  events in one frame together scale by at most ×1.25. Two touch pointers
  pinch-zoom and pan.
- `setPointerCapture` on drags (guarded for jsdom), `touch-action: none`,
  `user-select: none`, `overscroll-behavior: none`.

### Rendering and performance

- SVG. One scene `<svg>` with a `<g transform>` for the viewport; each element
  is a `React.memo` component keyed by id and compared by object identity. A
  second overlay `<svg>` draws selection, handles, marquee, binding highlight,
  and eraser trail in host token colors (`stroke-primary`, `fill-background`).
- Scene state lives in an external store read with `useSyncExternalStore`
  selectors; pointer moves update a preview (no history) at most once per
  animation frame; history commits on pointer up and on discrete actions.
- Dark theme (`experimental_useCodeTheme().mode`): element colors pass through
  `darkColor` at render time. Exports always use light colors on white.
- Excalifont: register both `EXCALIFONT_FACES` with `FontFace` (data URLs) at
  mount; wait for `document.fonts.load` before measuring text.

### Persistence

- Route: the panel's `subPath` is the sketch id as is (`sketchSubPath`); the
  host URL-encodes each segment, and `routeSketchId` decodes once. Empty
  keeps the open sketch, else opens the most recent one (localStorage
  `sketch:last:v1`, else newest in `list`). Only route, list, and subPath
  changes re-run that choice, not a new `useBbNavigate()` object. With no sketches, the canvas is a new unsaved sketch, created with
  `create` on the first edit (then the URL is replaced with its id). While
  that canvas has unsaved edits or a create in flight, the page doesn't
  switch to another sketch. If another sketch is on screen by the time the
  create returns, the page only reloads the list and toasts "Saved your
  drawing as “X”".
- Autosave: 700 ms debounce, 4 s max wait, flushed on sketch switch,
  `visibilitychange` hidden and unmount. Saves carry the last sha; a
  `conflict` shows a small banner: "Changed somewhere else. **Reload** ·
  **Keep mine**" (Keep mine saves with `expectedSha256: null`).
- Missing file: when a refetch, Reload, or a conflict check finds no file,
  the status becomes `missing` (no more saves). A banner says the sketch
  "isn't in your sketch folder anymore" and offers **Save as a new sketch**,
  which creates “<name> (my edits)”. Keep mine never re-creates the file.
- Leaving (unmount or `pagehide`) while the status is conflict or missing and
  there are unsaved edits creates “<name> (my edits)” (cut to the title
  limit) and toasts it, once per draft (`rescue.ts`).
- On `CHANGED_CHANNEL` or reconnect: refetch the list; refetch the open sketch
  and adopt the file if it has no unsaved edits and the sha differs from ours.
  `{ id, renamedTo }` for the open sketch moves its saved view, renames the
  session, and replaces the URL.
- When a sketch opens or a remote change is adopted and `parseSceneFile`
  dropped or kept elements, a toast says how many couldn't be read
  (`unreadable.ts`).
- Viewport per sketch in `sketch:view:v1:<id>` (scroll and zoom). First open
  fits the content.
- Preview: 3 s after the last successful save (idle callback when available),
  render a whole-sketch PNG and call `savePreview` with that save's sha.

### Send to Wiki dialog

- Content: the selection, or everything when nothing is selected.
- Shows the PNG preview exactly as sent (white background, 16 px padding,
  2× scale, light colors, embedded font), its size, a **Caption** field (prefilled
  from the selected text and labels joined by " · ", max 200 characters), and
  **Add a note** (optional Markdown above the image).
- Layout: the dialog is at most `90dvh`, with a header, a body that scrolls
  on its own (`[data-send-body]`; preview box `max-h-32`, image `max-h-28`,
  doc list `max-h-32`), and a footer that always shows.
- **Where:** a two-option control, **Inbox** ("Review it in the Wiki inbox
  and pick where it goes there") or **Doc**. Clicking Doc focuses the doc
  search, even when Doc is already chosen; arrow keys move between the
  options and keep focus there. Doc shows a search field over
  all Wiki docs (title, slug, alias, tag; prefix and contains matches;
  ↑/↓/Enter), with `wikiSuggest` best matches first ("Best match: Doc ›
  Heading"), then a heading select (the doc's headings + `Unsorted`, default
  the chosen doc's heading or `Unsorted`, plus **New heading…**).
- The doc is chosen once (`initialChoice`): after the docs load, the
  remembered doc wins, else the first suggestion once suggestions first
  arrive, and only if the user hasn't picked a doc or changed the heading.
  Later suggestions (the caption and note feed `wikiSuggest`) only reorder
  the list.
- When the Wiki is ready but can't take inbox cards (`inbox: false`), Inbox
  is disabled with the hint "This Wiki version can't take inbox cards.
  Update the Wiki plugin, or pick a doc." (`aria-describedby`), and Doc is
  used even if Inbox was remembered.
- Wiki state notice, right under Where: "Checking the Wiki…" while loading
  (Inbox), "Couldn't reach the Wiki: …" when `wikiDocs` fails, or the reason
  plus "Sending is turned off until it is." when the Wiki is unavailable. In
  the last two cases the doc search and heading are hidden and sending is
  off. "Loading Wiki docs…" shows in the doc list only while loading.
- Footer: "⌘ Enter to send", **Cancel**, primary **Send to inbox** or
  **Add to <doc>**; "Sending…" while busy; errors inline (`role="alert"`).
- While sending, Cancel is disabled, the close button is hidden, and Esc and
  outside clicks are ignored. If the dialog is gone when an error arrives
  (the editor unmounted), the error shows as a toast.
- The last place sent to (kind, doc, heading) is saved in `sketch:wiki:v1`
  after a successful send.
- Closing any dialog returns focus to the sketch root.
- Success closes the dialog and toasts "Sent to your Wiki inbox" with
  **Review**, or "Added to <doc>" with **Open**. Navigation to Wiki routes
  clicks a hidden `<a href>` inside the plugin root (bb routes anchors inside
  plugin slots in-app).

### Export helpers (browser)

`components/export-png.ts`: `sceneToSvg` → `Blob` → `<img>` decode (wait for
the embedded font, one frame) → canvas at scale (capped so w·h·s² ≤
16,777,216) → `toBlob("image/png")`. Download via an object-URL anchor. Copy
as PNG via `navigator.clipboard.write` with a readable error fallback.

## 9. Tests

- `lib/*.test.ts`: parse/serialize round trip (incl. unsupported elements and
  appState/files passthrough), hit tests, marquee, resize math, binding
  updates, history, clipboard remap, text layout, darkColor, svg export
  (escaping, font embedding, bounds).
- `server.test.ts` (`createFakePluginHost`, real temp folders): CRUD, CAS
  conflict, case-insensitive names, Untitled numbering, rename/duplicate/
  delete, previews and staleness, CLI commands, Wiki adapter with stubbed
  `plugins.callRpc` / `plugins.list` (inbox, doc, unavailable, old Wiki), temp
  file cleanup.
- `app.test.tsx` (jsdom): registrations, the page renders with RPC stubs,
  tool keys, creating a rectangle with pointer events, selection, the send
  dialog flow (inbox and doc) calling `sendToWiki`.

## 10. Docs

`README.md` (Install, Draw, Select, Send to Wiki, Keys, Settings, CLI, Where
the files live, Not in this version, Develop, Layout), `PLUGIN_OVERVIEW.md`,
`skills/sketch/SKILL.md` (CLI use for agents). Plain, short, second person.

## 11. Not in this version

Rotation handles (stored angles still render), curved, elbow and multi-point
arrow editing, arrow labels, images, frames, libraries, collaboration, laser,
lasso, mermaid import, agent tools that draw.
