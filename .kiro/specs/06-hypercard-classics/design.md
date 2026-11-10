# Design Document

## Overview
**HyperCard Classics — Message Box, Find, Recent, Import Image, FatBits & Icons.**

This design implements `requirements.md` of this spec. It turns five reserved menu items into real items, adds Paint > FatBits, and renders and edits 32x32 button icons. It adds no persisted field (Requirement 12.1).

Canonical contracts used without restating them: schema `hexcard_design_spec.md` §2.1, message path §3, concurrency model §3.2 (rule 10: command dispatches), grammar §4.1, VM semantics §4.3, codec §5.4, composition §5.6. Spec 01 design §3–§5, spec 03 design §2–§6, spec 04 design §1–§6 and spec 05 design §3–§7 stay valid; this design only extends them.

The shortcut findings (browser sources and the headless Chrome probe) are in the Introduction of `requirements.md`; this design applies them in §"Menus and shortcuts".

**Delivery order.** The tasks follow the user's priority, so the list can be cut after any task and every finished feature works on its own:
1. document changes (Requirement 14);
2. Import Image;
3. icon data and validation, icon rendering, built-in icons, Icon Editor;
4. Message Box and Find;
5. FatBits;
6. Recent;
7. the whole headless Chrome check (Requirement 15.4) once more.

Each feature task removes only its own items from `ReservedCommand`, adds only its own shortcuts and store fields, and ends with its part of the headless Chrome check. The sections below say which feature each change belongs to.

## Architecture

~~~text
 menu click / shortcut ──► System7Shell ──► menuCommands.runMenuCommand ──► menu handler
      │ (capture listener: reload guard, Requirement 1.8)                       │
      ▼                                                                         ▼
 ┌──────────────────┬────────────────────┬──────────────────┬──────────────────┬───────────────────┐
 │ file.importImage │ go.messageBox /    │ go.recent        │ edit.iconEditor  │ paint.fatBits     │
 │ files.pickImage  │ go.find            │ windows.         │ windows.         │ store.setFatBits  │
 │ → imageImport    │ messageBox.show    │ openRecent       │ openIconEditor   │                   │
 └────────┬─────────┴─────────┬──────────┴────────┬─────────┴────────┬─────────┴─────────┬─────────┘
          ▼                   ▼                   ▼                  ▼                   ▼
   history.execute     MessageBoxWindow     RecentWindow        IconEditor          CardViewport
   (Import Image)      Return → runner      click → bus.        icon commands →     FatBits view,
                       │                    runCommand          history.execute     pointer mapping,
                       ▼                    ("Go Recent")                           arrows, Escape
              bus.runCommand("Message Box" | "Find")
                 ├─ vm.runMessageBoxLine (statement / expression, globals)
                 └─ find.findNext → bus.changeCard → store.setFound

 store snapshot ─► CardViewport.draw: composeFrame(…, { found }) ─► [renderFatBits] ─► canvas
                   (partRenderer: icons, found box)
~~~

State placement (Requirement 12):

| State | Owner | Saved | Undoable |
|---|---|---|---|
| `customIcons`, `iconId`, bitmaps | the stack in `store.ts` | yes | yes (`history.execute`) |
| found text, FatBits view | `HexRuntimeState` in `store.ts` (UI state) | no | no |
| Message Box open state, line, position | `MessageBoxController` (`src/ui/MessageBox.tsx`) | no | no |
| Recent list | `RecentCards` (`src/core/recentCards.ts`), a store subscriber like the bus's back history | no | no |
| runtime globals used by Message Box variables | the message bus's globals map (spec 02 design §4) | no | no |

Concurrency (design spec §3.2):
- A Message Box statement or expression, a find command and a Recent click run as command dispatches (`bus.runCommand`), which rule 10 already covers for Go menu commands. They queue in FIFO order with posted messages, share one gas budget with their nested dispatches, and Cmd/Ctrl+. aborts them.
- Import Image, icon commands, FatBits changes and opening windows send no message and run at once, outside the queue (rule 10, last sentence).

## Components and Interfaces

### New modules

#### `src/core/icons.ts` (feature 3; pure, Node-testable)
~~~typescript
export const ICON_SIZE = 32;
export const ICON_PIXELS = 1024;          // 32 x 32
export const ICON_BYTES = 128;            // 32 rows x 4 bytes
export const ICON_DATA_LENGTH = 172;      // padded standard Base64 of 128 bytes
/** Requirement 8.1: 171 Base64 characters, the last with its 2 unused bits zero, then one "=". */
export const ICON_DATA_PATTERN = /^[A-Za-z0-9+/]{170}[AEIMQUYcgkosw048]=$/;
export const ICON_NAME_MAX = 32;

export function isIconData(value: string): boolean;               // ICON_DATA_PATTERN.test(value)
/** Requirement 8.2: 1-32 chars of U+0020-U+007E, no leading/trailing space, not "__proto__". */
export function isIconName(name: string): boolean;
/** `pixels`: 1024 entries, row-major from the top-left, 1 = dark, 0 = clear. Throws on other lengths or values. */
export function encodeIcon(pixels: Uint8Array): string;
/** Inverse of encodeIcon. Throws on a value that is not icon data. */
export function decodeIcon(data: string): Uint8Array;
/** 32 rows of 32 characters, "#" = dark, "." = clear (built-in icon art). Throws on any other shape. */
export function iconFromRows(rows: readonly string[]): string;
export const BLANK_ICON: string;                                    // 171 "A" + "="
/** `base` if free, else `${base} N` with the lowest free N >= 2, base shortened to fit 32 chars; case-insensitive. */
export function freeIconName(base: string, taken: Iterable<string>): string;
/** Why `name` cannot become a stack icon name (Requirement 10.6), or undefined. `except` is the icon being renamed. */
export function iconNameError(stack: HexStack, name: string, except?: string): string | undefined;

/** Every icon command. `name` is the stack icon to select after apply. */
export interface IconCommand extends HexCommand { readonly name?: string }
export function createNewIconCommand(stack: HexStack): IconCommand;                                   // "New Icon"
export function createCopyIconCommand(stack: HexStack, base: string, data: string,
  label: "Duplicate Icon" | "Add Icon"): IconCommand;                                                  // Requirements 10.5, 10.8
export function createRenameIconCommand(stack: HexStack, from: string, to: string): IconCommand;       // "Rename Icon"
export function createDeleteIconCommand(stack: HexStack, name: string): IconCommand;                   // "Delete Icon"
export function createEditIconCommand(name: string, before: string, after: string): IconCommand;       // "Edit Icon"
/** "Set Icon" (iconId, copying `add` into customIcons first when given) or "Remove Icon" (iconId undefined). */
export function createButtonIconCommand(stack: HexStack, partId: HexID, iconId: string | undefined,
  add?: { name: string; data: string }): IconCommand;
~~~
- `"Duplicate Icon"` always numbers the copy (the base counts as taken, Requirement 10.5); `"Add Icon"` keeps the base when it is free (Requirement 10.8); both number from 2 with `freeIconName`.
- Base64 uses `btoa` / `atob`, as `rleCodec.ts` does; both exist in Node 16+ and in browsers.
- Names and ids are fixed when a factory runs, so Redo recreates the same names (as spec 05 Requirement 8.4 does for structural commands).
- `apply` throws `HexMutationError` when its precondition fails on the stack it receives (a missing icon, a taken name, an `Edit Icon` whose `before` no longer matches), so the history does not record it.
- Every `apply` records what it replaces, and `revert` puts back exactly those objects:
  - the previous `customIcons` object;
  - the previous version of every button it changed (located by id; card parts and background parts alike).
- Rename and Delete rebuild `customIcons` in the same key order, without the removed key. `iconId` is removed as a key, never set to `undefined`, so the stack stays valid under the strict Zod schema.
- Lookups use `Object.hasOwn(stack.customIcons, name)`, never `in` or plain indexing, so names like `constructor` cannot reach `Object.prototype`.

#### `src/core/find.ts` (feature 4; pure)
~~~typescript
export interface FindMatch { cardId: HexID; layer: HexLayer; partId: HexID; start: number; end: number }
/** Requirement 4.5: index 0, or the code point before `index` is not \p{L} or \p{N}. */
export function isWordStart(text: string, index: number): boolean;
/** Start indexes of every match of `needle` in `text` (Requirement 4.5); [] for an empty needle. */
export function matchStarts(text: string, needle: string): number[];
/** Requirement 4.4: the searchable fields of one card in search order, with their text. */
export function searchableFields(stack: HexStack, card: HexCard): { layer: HexLayer; part: HexFieldPart; text: string }[];
/** Requirement 4.6: the next match after `found` (or from the start of the current card), wrapping; null if none. */
export function findNext(stack: HexStack, currentCardId: HexID, found: FoundText | null, needle: string): FindMatch | null;
~~~
- Comparison: `text.slice(i, i + needle.length).toLowerCase() === needle.toLowerCase()` at every word start `i`. `toLowerCase` is locale-independent, and the indexes always refer to the original text.
- Order key `(card index, field order, start)`. With a found text the search starts strictly after the found text's key; without one it starts at `(current card index, 0, 0)` inclusive. When nothing follows the start, the first match of the whole stack is used (wrap-around, Requirement 4.6). A found text whose field is no longer searchable counts as no found text.
- Matches may overlap (`aa` in `aaa` only matches at word starts, so at most one per word).

#### `src/core/messageBox.ts` (feature 4; pure, Node-testable with a fake bus and host)
~~~typescript
export type MessageBoxLine =
  | { kind: "empty" }                                         // blank, or only a -- comment
  | { kind: "find"; text: string }
  | { kind: "findUsage" }                                     // first word "find", wrong form
  | { kind: "statement"; statement: HexStatementNode }
  | { kind: "expression"; expression: HexExprNode }
  | { kind: "error"; message: string; column: number };

export const FIND_USAGE = 'Type find "text", for example find "lamp".';
export const NOT_FOUND = "Not found.";
export const HANDLER_ONLY = "pass and exit work only inside a handler.";
export const COMMAND_WORDS: ReadonlySet<string>;              // Requirement 3.5, lowercase

export function classifyMessageBoxLine(line: string): MessageBoxLine;
/** Requirement 3.4: toText (vm.ts), every "\r\n", "\r" or "\n" replaced by one space. */
export function messageBoxValueText(value: HexValue): string;

export interface MessageBoxIO {
  line(): string;                                             // the line now
  setLine(line: string): void;
  alert(message: string, details?: readonly string[]): void;
}
export interface MessageBoxRunnerDeps {
  store: Pick<HexStore, "getSnapshot" | "setFound">;
  bus: Pick<MessageBus, "runCommand" | "changeCard">;
  host: HexHost;                                              // the VM host the bus uses
  io: MessageBoxIO;
}
/** Requirement 3: what Return in the Message Box does with `line` (the untrimmed text box value). */
export function createMessageBoxRunner(deps: MessageBoxRunnerDeps): (line: string) => void;
~~~
`classifyMessageBoxLine(raw)`:
1. `line = raw.trim()`; `""` → `empty`.
2. If the first word (`/^[A-Za-z][A-Za-z0-9_]*/`, lowercased) is `find`: `/^find\s+"([^"]*)"\s*$/i` gives `find` with the captured text; otherwise `findUsage` (Requirement 4.2).
3. Statement attempt: `parseHexTalk("on hexmessagebox\n" + line + "\nend hexmessagebox")`.
   - No errors and an empty body → `empty` (a comment-only line).
   - No errors and exactly one statement → `statement`, unless it is `PassEvent` or `ExitHandler`, which become `error` with `HANDLER_ONLY` at column 1 (they would otherwise name the internal wrapper).
4. Expression attempt: `parseHexTalk("on hexmessagebox\nget " + line + "\nend hexmessagebox")`. No errors and exactly one `GetValue` statement → `expression` (its `value`).
5. Otherwise `error`. It uses the statement attempt's first error when the first word is in `COMMAND_WORDS`, else the expression attempt's first error. Columns are mapped into the line:
   - an error on wrapper line 2 keeps its column, minus 4 for the `get ` prefix;
   - an error on line 3 (a missing `end`) is reported at `line.length + 1`;
   - an error on line 1 is reported at column 1.

The parser, grammar, reserved words and AST stay unchanged (Requirement 3.10); the wrapper is ordinary HexTalk.

The runner:

| Kind | Action |
|---|---|
| `empty`, or `find` with `text === ""` | nothing |
| `findUsage` | `io.alert(FIND_USAGE)` |
| `error` | `io.alert(message, [\`Column ${column}\`])` |
| `statement` | `bus.runCommand("Message Box", (ctx) => runMessageBoxLine({ kind: "statement", statement }, currentCardId(), ctx, host))` |
| `expression` | `bus.runCommand("Message Box", async (ctx) => { const value = await runMessageBoxLine({ kind: "expression", expression }, currentCardId(), ctx, host); if (io.line() === raw) io.setLine(messageBoxValueText(value!)); })` |
| `find` | the Find dispatch below |

`currentCardId()` reads `store.getSnapshot().currentCardId` inside the task, so the line runs against the card that is current when the dispatch starts (Requirement 3.2).

~~~typescript
bus.runCommand("Find", async (ctx) => {
  const state = store.getSnapshot();
  const match = findNext(state.stack, state.currentCardId, state.found, text);
  if (!match) {
    host.playSound("click", 120, "");                         // one click (spec 04 synth, empty notes = one hit)
    store.setFound(null);
    if (io.line() === raw) io.setLine(NOT_FOUND);
    return;
  }
  const matchedText = readFieldText(state.stack, match.cardId, match.layer, match.partId);
  if (match.cardId !== state.currentCardId) await bus.changeCard(match.cardId, ctx);   // Requirement 4.7
  const now = store.getSnapshot();
  if (now.currentCardId !== match.cardId) return;              // an openCard handler went elsewhere
  if (readFieldText(now.stack, match.cardId, match.layer, match.partId) !== matchedText) return;
  store.setFound({ ...match, text: matchedText });             // Requirement 4.8
});
~~~

#### `src/core/recentCards.ts` (feature 6; pure)
~~~typescript
export const RECENT_LIMIT = 12;
export interface RecentCards {
  /** Requirement 5.1, 5.2: newest first, current card first, only cards of the current stack. */
  list(): readonly HexID[];
  dispose(): void;
}
export function createRecentCards(store: Pick<HexStore, "subscribe" | "getSnapshot" | "onReplaceStack">, limit?: number): RecentCards;
/** Requirement 5.5: closes nothing itself; queues "Go Recent" unless `cardId` is current. */
export function goToRecentCard(store: Pick<HexStore, "getSnapshot">, bus: Pick<MessageBus, "runCommand" | "changeCard">, cardId: HexID): void;
~~~
- It starts as `[currentCardId]`. A store subscriber moves the new current card to the front whenever `currentCardId` changes, which covers every way a card becomes current.
- `onReplaceStack` resets the list to the new current card.
- `list()` filters out ids that are not cards of the current snapshot.
- `goToRecentCard` runs `bus.runCommand("Go Recent", async (ctx) => { if (exists(cardId)) await bus.changeCard(cardId, ctx); })`.

#### `src/engine/graphics/imageImport.ts` (feature 2; pure except the injected decoder)
~~~typescript
export const IMAGE_IMPORT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"] as const;
export type ImageImportType = (typeof IMAGE_IMPORT_TYPES)[number];
export const IMAGE_IMPORT_ACCEPT: string;                    // IMAGE_IMPORT_TYPES.join(",")
export const IMAGE_IMPORT_MAX_BYTES = 16_777_216;            // 16 MiB
export const IMAGE_IMPORT_MAX_SIDE = 8_192;
export const IMAGE_IMPORT_MAX_PIXELS = 16_777_216;
export const IMPORT_MESSAGES: {
  type: "HexCard can import PNG, JPEG, GIF, WebP and BMP images.";
  size: "This image file is larger than 16 MB.";
  dimensions: "This image is larger than 8192 x 8192 pixels or 16 megapixels.";
  unreadable: "This image could not be read.";
  needsPaintTool: "Choose a paint tool to import an image.";
};

/** What a File from the picker or a drop offers; Node tests pass plain objects. */
export interface ImageFileLike { type: string; size: number; arrayBuffer(): Promise<ArrayBuffer> }
/** Requirement 6.5: format and size from the header bytes, or null when no supported header is found. */
export function readImageHeader(bytes: Uint8Array): { type: ImageImportType; width: number; height: number } | null;
export function withinImportLimits(width: number, height: number): boolean;
/** The aspect-fit rectangle `importImageToBitmap` fills: fitSize(width, height), centred with floor offsets. */
export function importRect(width: number, height: number): HexRect;
/** Requirement 6.8, 6.9: the "Import Image" PaintStrokeCommand for the edit target, or null if no pixel changes. */
export function createImportImageCommand(state: HexRuntimeState, imported: Uint8Array, rect: HexRect,
  codec?: BitmapCodec): PaintStrokeCommand | null;

export interface ImageImportDeps {
  store: Pick<HexStore, "getSnapshot">;
  history: Pick<HexHistory, "execute">;
  alert: (message: string) => void;
  /** Default: decodeImageBlobToRgba with the import limits (spec 03, browser only). */
  decode?: (blob: Blob, limits: { maxSide: number; maxPixels: number }) => Promise<RgbaImage>;
}
/** Requirements 6.4-6.10. Resolves true when a command was executed. */
export function importImageFile(file: ImageFileLike, deps: ImageImportDeps): Promise<boolean>;
/** Requirements 6.2, 6.3: the paint-tool check of a drop, then importImageFile. */
export function importDroppedImage(file: ImageFileLike, deps: ImageImportDeps): Promise<boolean>;
~~~
`importImageFile` steps, stopping at the first failure with its alert and no stack change:
1. `file.type` must be in `IMAGE_IMPORT_TYPES` (`type`), and `file.size <= IMAGE_IMPORT_MAX_BYTES` (`size`).
2. `bytes = new Uint8Array(await file.arrayBuffer())`. `readImageHeader(bytes)` must find a supported header (`unreadable`), and its size must pass `withinImportLimits` (`dimensions`). The header's own type is used from here on, so a renamed file is decoded by what it contains.
3. `rgba = await decode(new Blob([bytes], { type }), limits)`. A `RangeError` gives `dimensions`; any other error gives `unreadable`. The decoder works on the bytes in memory: no URL, no `<img>`, no `fetch` (Requirement 6.6).
4. `imported = importImageToBitmap(rgba)` (spec 03), then `rect = importRect(rgba.width, rgba.height)`.
5. `createImportImageCommand(store.getSnapshot(), imported, rect)`. A non-null command goes to `history.execute`.

Header formats read by `readImageHeader`, by signature:

| Format | Signature | Width, height |
|---|---|---|
| PNG | `89 50 4E 47 0D 0A 1A 0A`, then the `IHDR` chunk | big-endian u32 at bytes 16 and 20 |
| GIF | `GIF87a` / `GIF89a` | little-endian u16 at 6 and 8 (logical screen) |
| BMP | `BM` | DIB header size at 14 (LE u32): 12 → LE u16 at 18 and 20; otherwise LE i32 at 18 and 22, height taken as its absolute value |
| JPEG | `FF D8` | walk the segments (`FF xx` + big-endian length; `D0`-`D9` and `01` have no length) to the first SOF marker `C0`-`CF` other than `C4`, `C8`, `CC`; height u16 at +5, width at +7 |
| WebP | `RIFF` .... `WEBP` | chunk at 12: `VP8 ` → LE u16 at 26 and 28, each `& 0x3FFF`; `VP8L` → 14-bit fields packed from byte 21, each + 1; `VP8X` → LE u24 at 24 and 27, each + 1 |

A width or height of 0, a truncated header or an unknown signature gives null.

`createImportImageCommand(state, imported, rect)`:
- The target is `resolveEditTarget(state)`, read when the pixels are written (Requirement 6.8).
- It decodes the target layer (empty fill 0 for card layers, 1 for backgrounds, as `PaintStrokeCommand` does), then copies `before` = the layer's `rect` and `after` = `imported`'s `rect`.
- `imported` holds only states 1 and 2 inside `rect` (`importImageToBitmap`), so light pixels stay opaque on the card layer and no state 0 is written. Pixels outside `rect` are not part of the command.
- It returns `new PaintStrokeCommand({ layer, layerOwnerId, rect, before, after }, codec, "Import Image")`, or null when `before` equals `after`.

`importDroppedImage` alerts `needsPaintTool` unless `isPaintTool(store.getSnapshot().tool)`.

#### `src/engine/graphics/fatBits.ts` (feature 5; pure)
~~~typescript
export interface FatBitsView { x: number; y: number }                 // the origin, in card pixels
export const FATBITS_CELL = 8;
export const FATBITS_COLUMNS = 64;                                    // 512 / 8
export const FATBITS_ROWS = 43;                                       // ceil(342 / 8); the last row shows 6 of 8 lines
export const FATBITS_MAX = { x: 448, y: 299 } as const;               // 512 - 64, 342 - 43
export const FATBITS_START: FatBitsView = { x: 224, y: 149 };         // Requirement 7.1
export const FATBITS_PAN_STEP = 8;
export const INSET_SIZE = { width: 68, height: 47 } as const;         // 64 x 43 + 1-px frame + 1-px margin on each side

export function clampFatBitsView(view: FatBitsView): FatBitsView;     // integers clamped to 0..448, 0..299
/** Requirement 7.3: top-right while x < 9 and y < 6, else top-left. */
export function insetRect(view: FatBitsView): HexRect;
export function inInset(view: FatBitsView, x: number, y: number): boolean;
/** Requirement 7.5: the card pixel shown by the cell under frame point (x, y), clamped to the card. */
export function fatBitsCardPoint(view: FatBitsView, x: number, y: number): { x: number; y: number };
/** Requirements 7.2-7.4: a new 512x342 frame (states 1/2) showing `frame` zoomed, with the inset. */
export function renderFatBits(frame: Uint8Array, view: FatBitsView): Uint8Array;
/** One FatBits cell drawn into `out` at (ox, oy); also used by the Icon Editor grid. */
export function drawFatCell(out: Uint8Array, outWidth: number, ox: number, oy: number, dark: boolean): void;
~~~
- A cell for a dark pixel fills the cell's top-left 7 x 7 with state 2 and leaves its right column and bottom row at state 1. A cell for a light pixel is all state 1.
- The inset is drawn at `insetRect(view)` in three rings: the outer ring (the 1-pixel margin) is light, the next ring is the dark frame, and the 64 x 43 card pixels from the origin are copied at actual size inside.
- Every pixel is 1 or 2, so `frameToImageData` maps them to the theme's two colours (Requirement 7.4).
- Why the inset moves (Requirement 7.3): at the top-left it covers cells 0–8 x 0–5. A card pixel in the region x 0–8, y 0–5 could then never leave the inset, because the origin cannot go below 0. While the origin is in x < 9 and y < 6 the inset therefore sits at the top-right, where it covers cells whose card pixels can be uncovered by panning right.

#### `src/presets/builtInIcons.ts` (feature 3; data)
~~~typescript
export interface BuiltInIcon { readonly name: `hex-${string}`; readonly data: string }
/** Requirement 11: at least 12 icons, each made with iconFromRows from 32 rows of "#" and ".". */
export const BUILT_IN_ICONS: readonly BuiltInIcon[];
~~~
The set: `hex-arrow-left`, `hex-arrow-right`, `hex-arrow-up`, `hex-arrow-down`, `hex-house`, `hex-star`, `hex-heart`, `hex-note`, `hex-question`, `hex-skull`, `hex-sun`, `hex-key`. The implementer draws each one pixel by pixel as 32 rows of `#` and `.` in the source. No Apple artwork may be traced, copied or adapted, and none may be imported from another icon set (Requirement 11.1). A test checks Requirements 11.2–11.4 (names, valid data, not blank, distinct bits). Originality cannot be tested; the task report states how the art was made.

#### `src/ui/MessageBox.tsx` (feature 4)
~~~typescript
export type MessageBoxSelection = "end" | "all" | { start: number; end: number };
export interface MessageBoxSnapshot {
  open: boolean;
  line: string;
  /** Viewport pixels of the window's top-left corner; null until first placed (Requirement 2.6). */
  position: Point | null;
  /** A new id on every focus request; the window focuses its text box and applies `select`. */
  focus: { id: number; select: MessageBoxSelection } | null;
}
export interface MessageBoxController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MessageBoxSnapshot;
  isOpen(): boolean;
  /** Opens if closed, replaces the line when `line` is given, and requests the focus (Requirements 2.1, 2.2, 4.1). */
  show(request?: { line?: string; select?: MessageBoxSelection }): void;
  close(): void;
  setLine(line: string): void;
  setPosition(position: Point): void;
}
export function createMessageBox(): MessageBoxController;
export const MESSAGE_BOX_WIDTH = 448;                       // 1x, frame included
export const MESSAGE_BOX_HEIGHT = 41;                       // 12 title + 1 line + 28 body
export interface MessageBoxWindowProps { controller: MessageBoxController; onReturn: (line: string) => void; scale: number }
export function MessageBoxWindow(props: MessageBoxWindowProps): ReactElement | null;
~~~
- **Window.** A floating window drawn with the Tools palette's chrome: `.s7-palette`, a 12 px dark title bar with a close box (`.s7-close-box`), no title text, and `aria-label="Message Box"` on the window.
- **Size and position.** `MESSAGE_BOX_WIDTH x MESSAGE_BOX_HEIGHT` times k. The first position is `{ x: 16k, y: innerHeight - (41 + 16)k }`, clamped by `clampPaletteOrigin`. The title bar drags it with `beginPointerDrag`, as `FloatingTools` does (Requirement 2.6). It sits at z-index 30 next to the palette and below the studio window backdrop (90), so a studio window covers it.
- **Text box.** One `<input type="text" class="s7-input s7-message-box-input" aria-label="Message Box" spellcheck="false">`. An HTML one-line text box already strips pasted line breaks (Requirement 2.7). The value is `snapshot.line`, and `onChange` calls `setLine`.
- **Keys.** `onKeyDown`: Enter → `preventDefault`, `onReturn(event.currentTarget.value)`; Escape → `preventDefault`, `close()` (Requirement 2.3). Every other key keeps its default meaning. The input is a text input under spec 05 Requirement 16, because `isTextInputTarget` matches `input`.
- **Focus.** An effect on `focus.id` focuses the input and sets its selection: `end` puts the caret at `line.length`, `all` selects `0..line.length`, and an explicit range is used as given. `find ""` gives the range 6..6 (Requirement 4.1).
- It is not a studio window: `windows.isOpen()` ignores it, so menus, shortcuts outside the input and `idle` keep working (Requirement 2.5).

#### `src/ui/RecentCards.tsx` (feature 6)
~~~typescript
export interface RecentWindowProps {
  store: Pick<UiStore, "subscribe" | "getSnapshot">;
  recent: () => readonly HexID[];
  onChoose: (cardId: HexID) => void;
  onClose: () => void;
  rasterizePart?: PartRasterizer;
}
export const RECENT_COLUMNS = 4;
export function RecentWindow(props: RecentWindowProps): ReactElement;
~~~
- A `System7Window` titled `Recent` (a studio window, so spec 05 Requirement 16.3 applies) with a CSS grid of four columns.
- Each entry is a `<button type="button" class="s7-recent-card">` with the reused `ThumbnailCanvas` showing `createCardThumbnail(stack, id, rasterizePart)`, and the card's name (or `Card N`) in a 16 px label, inverted for the current card (as `.s7-graph-node-current`). The button has an `aria-label` with the card's name and `aria-current` on the current card. Thumbnails are memoised on `[stack, ids]`.
- At 1x four miniatures (4 x 130 + gaps) are wider than the smallest desktop. The window keeps the `.s7-window` maximum size and its body scrolls, as the Stack Graph's does.
- A click, or Return or Space on the focused button (native button behaviour), calls `onChoose(id)`. App closes the window and calls `goToRecentCard` (Requirement 5.5).

#### `src/ui/IconEditor.tsx` (feature 3)
~~~typescript
export interface IconEditorProps {
  store: Pick<UiStore, "subscribe" | "getSnapshot">;
  history: Pick<HexHistory, "execute" | "undo" | "canUndo">;
  modals: Pick<ModalManager, "ask" | "alert">;
  onClose: () => void;
}
export type IconChoice = { kind: "stack"; name: string } | { kind: "builtIn"; name: string };
/** Requirement 10.2. */
export function initialIconChoice(state: HexRuntimeState): IconChoice;
export function IconEditor(props: IconEditorProps): ReactElement;
~~~
Layout at 1x, in a `System7Window` titled `Icon Editor` of 472 x 320 (fits the smallest desktop; see `INSPECTOR_WIDTH`):
- left: a 176 px wide list box (`role="listbox"`, scrolls):
  - the stack icons in `customIcons` key order;
  - a `HexCard icons` heading;
  - the built-in icons.
  Each row is a 32 x 32 1-bit preview canvas and the name, and the selected row is inverted.
- below the list: the buttons at their natural widths, wrapping into rows: **New**, **Duplicate**, **Rename...**, **Delete**, **Add to Stack**, **Use for Button**, **No Icon**, **Undo**.
- right: the 256 x 256 editing grid, one `<canvas width=256 height=256>` filled with `drawFatCell` (FatBits cells, Requirement 10.1). Below it: the selected icon's name, with `(built-in)` for built-in icons.

Behaviour:
- **Editing (Requirement 10.3).** A press on the grid computes the cell from the pointer (`floor(offset / (8k))`) and the paint value from the opposite of that pixel. A local working copy is shown live, and the pointer is captured. On release, if the working copy differs, `history.execute(createEditIconCommand(name, before, encodeIcon(working)))`. Built-in icons ignore presses.
- **Buttons (Requirements 10.4–10.9, 10.11, 10.12).**
  - **New** runs `createNewIconCommand`.
  - **Duplicate** runs `createCopyIconCommand(stack, name, data, "Duplicate Icon")`.
  - **Rename...** runs `modals.ask("Icon name:", name)`. An empty answer (Cancel) does nothing. An invalid name or a case-insensitive clash shows the alert from `iconNameError`. Otherwise it runs `createRenameIconCommand`.
  - **Delete** runs `createDeleteIconCommand`.
  - **Add to Stack** runs `createCopyIconCommand(stack, builtIn.name, builtIn.data, "Add Icon")`.
  - **Use for Button** runs `createButtonIconCommand(stack, selectedPartId, name, add?)`. For a built-in icon, `add = { name: freeIconName(builtIn.name, Object.keys(stack.customIcons)), data: builtIn.data }` and `iconId = add.name` (Requirement 10.9).
  - **No Icon** runs `createButtonIconCommand(stack, selectedPartId, undefined)`.
  - **Undo** runs `history.undo()`.
  - Enabled states follow Requirements 10.9 and 10.12. "A button is selected" means `selectedPartId` names a button part (the store only allows that with the Button tool).
- **Store sync (Requirement 10.10).** The component reads the stack with `useSyncExternalStore`. After a command, the choice becomes the command's `name` when it has one. When the chosen stack icon disappears (Undo, Delete), the choice falls back to `initialIconChoice`.

### Changes to existing modules

| Module (owner) | Feature | Change |
|---|---|---|
| `src/core/schema.ts` (01) | 1 | Comments only: `customIcons` and `iconId` (Requirement 14.2). |
| `src/core/stackValidator.ts` (01) | 3 | `customIcons: z.record(iconNameSchema, iconDataSchema)` using `isIconName` / `ICON_DATA_PATTERN`; new structural check `checkIconReferences` after `checkUniqueIds`: every button `iconId` must satisfy `Object.hasOwn(stack.customIcons, iconId)`, error `backgrounds[i].parts[j].iconId: no icon named "<id>" in customIcons` (or `cards[i]...`). |
| `src/core/store.ts` (01, 05) | 4, 5 | `found` and `fatBits` UI state with `setFound` / `setFatBits` and their invariants (§Data Models). Every `HexRuntimeState` literal gains `found: null, fatBits: null`. |
| `src/core/vm.ts` (02) | 4 | `MESSAGE_BOX_HANDLER`, `MessageBoxProgram`, `runMessageBoxLine` (below). `Frame` gains `messageBox: boolean`. |
| `src/engine/graphics/bitmapCanvas.ts` (03) | 4 | `ComposeOptions.found?: { partId; start; end }`; `PartDrawContext.found?: { start; end }`, set only for that part. |
| `src/engine/graphics/partRenderer.ts` (03) | 3, 4 | Icons in `drawPushButton` (§Rendering); the found box in `drawField`. |
| `src/engine/graphics/atkinsonDither.ts` (03) | 2 | `decodeImageBlobToRgba(blob, limits?: { maxSide: number; maxPixels: number })`: after `createImageBitmap`, a bitmap over the limits is closed and a `RangeError` is thrown before any canvas is allocated. Without `limits`, behaviour is unchanged. |
| `src/ui/menuCommands.ts` (05) | 2–6 | §Menus and shortcuts. |
| `src/ui/System7Shell.tsx` (04, 05) | 2, 4–6 | The Paint menu gets FatBits (5); `shellShortcutKey` and the listener pass `platform` (4); a capture-phase reload guard (6); a window `dragover` / `drop` guard for files (2). |
| `src/ui/ObjectInspector.tsx` (04) | 3, 4, 6 | `StudioWindow` gains `{ kind: "iconEditor" }` (3) and `{ kind: "recent" }` (6), and `StudioWindows` gains `openIconEditor()` and `openRecent()`. `createScriptErrorReporter` gives no **Script** button when `error.handler === MESSAGE_BOX_HANDLER` (4, Requirement 3.9). |
| `src/ui/StackGraphModal.tsx` (04) | 6 | Export `ThumbnailCanvas`; the `HexRuntimeState` literal of `staticGoTarget` gains the new fields (4, 5). |
| `src/ui/CardViewport.tsx` (04, 05) | 2, 4, 5 | Drop handling (2); `found` in `composeFrame` options, scroll-to-match, focus out of the Message Box on a card press (4); FatBits drawing, pointer mapping and keys (5). |
| `src/ui/App.tsx` (04, 05) | 2–6 | Renders `IconEditor`, `MessageBoxWindow` and `RecentWindow`; passes `onDropImage`; `createUiStoreView` adds `setFatBits` (5). New props: `messageBox`, `onMessageBoxReturn`, `recent`, `onDropImage`. |
| `src/ui/fileCommands.ts` (04) | 2 | `FileBrowserAccess.pickImage(accept): Promise<ImageFileLike \| undefined>` (same file input as `pickFile`); `FileCommands.pickImageFile()`. |
| `src/ui/system7.css` (04) | 3, 4, 6 | `.s7-message-box*`, `.s7-recent*`, `.s7-icon-editor*` (§Rendering). |
| `src/main.tsx` (04, 05) | 2–6 | Wiring (below). |

`src/player/main.ts` needs no source change. It rasterizes parts with `createPartRasterizer`, so icons appear in exported stacks once the player bundle is rebuilt (`npm run build`, Requirement 9.7).

#### `vm.ts` addition (feature 4)
~~~typescript
/** Requirement 3.9: the handler of errors raised by a Message Box line itself. Has a space, so no parsed handler can have it. */
export const MESSAGE_BOX_HANDLER = "Message Box";
export type MessageBoxProgram =
  | { kind: "statement"; statement: HexStatementNode }
  | { kind: "expression"; expression: HexExprNode };
/**
 * Spec 06 Requirements 3.2-3.7. Runs one Message Box statement, or evaluates one expression, as `me`
 * inside `ctx` (the command dispatch): every variable, `it` included, is the global of that name in
 * `ctx.globals`. Resolves to the expression's value, or undefined for a statement. Errors raised in the
 * line itself are located as { objectId: me, handler: MESSAGE_BOX_HANDLER, line: 1 }; errors located by
 * a nested handler keep their location. `exit repeat` / `next repeat` outside a loop throw as in runHandler.
 */
export async function runMessageBoxLine(program: MessageBoxProgram, me: HexID, ctx: DispatchContext, host: HexHost): Promise<HexValue | undefined>;
~~~
The synthetic frame has `handler = { eventName: MESSAGE_BOX_HANDLER, params: [], body: [] }`, `messageBox = true` and `line = 1`. In that frame:
- `scopeOf` returns `ctx.globals` (Requirement 3.7);
- `enter` does not overwrite `line`;
- errors go through `locateError`.

`runHandler` sets `messageBox = false`, so handlers behave exactly as before.

#### Store addition (features 4 and 5)
~~~typescript
export interface FoundText { cardId: HexID; layer: HexLayer; partId: HexID; start: number; end: number; text: string }
export interface HexRuntimeState {
  // ... unchanged members ...
  found: FoundText | null;          // spec 06 Requirements 4.8, 4.9 (feature 4)
  fatBits: FatBitsView | null;      // spec 06 Requirement 7 (feature 5); FatBitsView from fatBits.ts is a plain {x, y}
}
export interface HexStore {
  // ... unchanged members ...
  /** null clears. Else cardId must be current, the field visible on that layer, text === its text, 0 <= start < end <= text.length; else HexMutationError. */
  setFound(found: FoundText | null): void;
  /** null turns FatBits off. Else the tool must be pencil or eraser and x, y integers in 0..448 / 0..299; else HexMutationError. */
  setFatBits(view: FatBitsView | null): void;
}
~~~
`store.ts` declares its own `{ x: number; y: number }` type, so `src/core/` does not import `src/engine/` (spec 01 design §4).

`publish` enforces two invariants on every state, as it does for the selection:
- `found` becomes null after `replaceStack`, when `currentCardId` changes, when the field is gone or hidden, or when `readFieldText(next.stack, cardId, layer, partId) !== found.text` (Requirement 4.9).
- `fatBits` becomes null after `replaceStack` and whenever the tool is neither `pencil` nor `eraser` (Requirement 7.8).

#### `main.tsx` wiring
- (2) `images = { importFile: (file) => importImageFile(file, { store, history, alert }), dropFile: (file) => importDroppedImage(file, deps) }`. The menu handler of `file.importImage` uses `files.pickImageFile()` then `images.importFile`, and App passes `onDropImage = images.dropFile` to `CardViewport`.
- (4) `messageBox = createMessageBox()`. `runLine = createMessageBoxRunner({ store, bus, host, io: { line: () => messageBox.getSnapshot().line, setLine: messageBox.setLine, alert: (m, d) => void modals.alert(m, { details: d }) } })`. Both go to App and to the menu handlers.
- (5) The paint controller's `getSettings` returns `{ pattern: PATTERNS[patternIndex], ...(store.getSnapshot().fatBits ? { eraserSize: 1 } : {}) }` (Requirement 7.6). The paint controller is unchanged.
- (6) `recent = createRecentCards(store)`; App renders `RecentWindow` with `recent.list` and `onChoose = (id) => { windows.close(); goToRecentCard(store, bus, id); }`.

### Menus and shortcuts (`menuCommands.ts`)

Layout changes (the rest of spec 05 design §6.1 stays):

| Menu | Label (command) | Shortcut | Enabled when | Menu handler | Feature |
|---|---|---|---|---|---|
| File | `Import Image...` (`file.importImage`) | | a paint tool is active (`isPaintTool`) | `files.pickImageFile().then((f) => f && images.importFile(f))` | 2 |
| Edit | `Icon Editor...` (`edit.iconEditor`) | | always | `windows.openIconEditor()` | 3 |
| Go | `Message Box...` (`go.messageBox`) | Ctrl+M, except macOS | always | `messageBox.show({ select: messageBox.isOpen() ? "all" : "end" })` | 4 |
| Go | `Find...` (`go.find`) | modifier + F | always | `messageBox.show({ line: 'find ""', select: { start: 6, end: 6 } })` | 4 |
| Paint | `FatBits` (`paint.fatBits`), checked while `fatBits !== null`, after a separator | | tool is `pencil` or `eraser` | `store.setFatBits(state.fatBits ? null : FATBITS_START)` | 5 |
| Go | `Recent...` (`go.recent`) | modifier + R | always | `windows.openRecent()` | 6 |

- `ReservedCommand` shrinks with each feature. After task 6 it is `"ai.conjureStack" | "ai.oracleSettings"`.
- `MenuHandlerDeps` gains:
  - `images` (2);
  - `messageBox: Pick<MessageBoxController, "show" | "isOpen">` (4);
  - `windows.openIconEditor` (3) and `windows.openRecent` (6);
  - `files.pickImageFile` (2);
  - `store.setFatBits` (5).
- The spec 05 coverage test (Requirement 15.3) treats a change of the Message Box snapshot, `found` or `fatBits` as an observable effect (Requirement 1.10).

Shortcuts (Requirements 1.4–1.9):
~~~typescript
export interface Shortcut { key: "B" | "Z" | "M" | "F" | "R"; shift: boolean }
export const SHORTCUTS: readonly { command: MenuCommand; shortcut: Shortcut; platforms?: readonly Platform[] }[] = [
  // spec 05: edit.background B, edit.undo Z, edit.redo Shift+Z (every platform)
  { command: "go.messageBox", shortcut: { key: "M", shift: false }, platforms: ["other"] },   // feature 4
  { command: "go.find", shortcut: { key: "F", shift: false } },                               // feature 4
  { command: "go.recent", shortcut: { key: "R", shift: false } },                             // feature 6
];
export function shortcutCommand(event: KeyLike, context: MenuContext, platform: Platform): { command; preventDefault } | undefined;
export function handleShortcutKey(event, context, handlers, platform): MenuCommand | undefined;
/** Requirement 1.8: Cmd/Ctrl+R without Shift or Alt. */
export function isReloadShortcut(event: Pick<KeyLike, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): boolean;
~~~
- Matching stays as in spec 05 design §6.3: `metaKey || ctrlKey`, no `altKey`, `event.code` (`KeyM`, `KeyF`, `KeyR`), and Shift only where the table says.
- An entry whose `platforms` excludes the current platform is skipped entirely: no label, no mapping and no `preventDefault`. On macOS Cmd+M and Ctrl+M therefore reach the browser (Requirement 1.5).
- `buildMenus` shows a shortcut label only for the platform's entries (`Ctrl+M`, `Cmd+F` / `Ctrl+F`, `Cmd+R` / `Ctrl+R`).
- Text inputs and open dialogs or windows behave as in spec 05 (`isTextInputTarget`, `shellShortcutKey`'s `blocked`).
- **Reload guard (feature 6).** `System7Shell` adds `window.addEventListener("keydown", guard, { capture: true })` with `guard = (e) => { if (isReloadShortcut(e)) e.preventDefault(); }`.
  - The capture phase runs before `System7Window`'s `stopPropagation` and before text inputs, so Cmd/Ctrl+R never reloads.
  - The bubbling listener still runs Go > Recent only when spec 05 Requirements 2.4 and 16 allow it.
  - F5 and Cmd/Ctrl+Shift+R still reload.
- A test checks that no entry collides with `RESERVED_BROWSER_SHORTCUTS` (Requirement 1.9).

### Rendering

**Icons in `drawPushButton` (feature 3, Requirement 9).** The button is drawn in this order: the shape, then the icon and the title (`showName` and a non-empty title), then the hilite inversion. Its existing inside box `box` gives `insideW = box.x1 - box.x0` and `insideH = box.y1 - box.y0`, and `lineHeight` is 16 for System 12.
~~~text
withTitle = showName && title !== ""
blockH    = 32 + (withTitle ? lineHeight : 0)
iconX     = x + box.x0 + floor((insideW - 32) / 2)
iconY     = y + box.y0 + max(0, floor((insideH - blockH) / 2))
titleRect = { x: x + box.x0, y: iconY + 32, width: insideW, height: lineHeight }   (centred, as today)
~~~
- The icon is looked up with `Object.hasOwn(ctx.stack.customIcons, iconId)` and decoded with `decodeIcon`. A module-level cache keyed by the data string holds at most 256 entries and is cleared when full.
- Set bits are written as state 2 through the same `allow` function as the title: only `INSIDE` pixels, and through `dimmedInk` when the button is disabled (Requirements 9.2–9.4). Clear bits write nothing.
- `invertInside` then inverts the icon with the face.
- `drawCheckable` ignores `iconId` (Requirement 9.5). Without an `iconId` the code path is the current one, so existing frames are unchanged (Requirement 9.6). A test compares frames of every style before and after.

**Found box in `drawField` (feature 4, Requirement 4.8).**
- After the text and before the editing caret, when `ctx.found` is set and a layout exists, the per-line segments of `[start, end)` are computed exactly as `drawEditing` computes a selection (`caretLine`, `xAtIndex`).
- For each segment from `x0` to `x1` on a line with top `top`, the 1-pixel outline from `(x0 - 1, top)` to `(x1, top + lineHeight - 1)` is inverted, clipped to the part rect.
- Inversion keeps it visible on dark and light pixels and uses only states 1 and 2.

**CardViewport (features 2, 4, 5).**
- `draw()` passes `found` when `snapshot.found` is set. When `snapshot.fatBits` is set it replaces the composed frame with `renderFatBits(frame, snapshot.fatBits)` before `frameToImageData`. Paint previews are composed first, so strokes show live in the cells and the inset (Requirement 7.9).
- Visual effects keep playing on full frames; the next `draw()` shows the FatBits view again.
- **Scroll to the match (Requirement 4.10).** When `found` changes to a `scrolling` field, a layout effect finds the line of `found.start` with `layoutFieldText`. If that line is outside the visible lines, the field's entry in `scrollOffsets` becomes `min(maxScroll, lineIndex * lineHeight)`, and a redraw is requested.
- **Pointer in FatBits (Requirement 7.5).** With the Pencil or the Eraser and `fatBits` set, a press inside `inInset` starts nothing. Otherwise every press, move and release point is mapped with `fatBitsCardPoint` before `painter.begin`, `move` and `end`.
- **Keys in FatBits (Requirements 7.7, 7.8).** In the existing window `keydown` listener, before the Browse-only checks: if `fatBits` is set, no modifier is held, `!isModalOpen()` and `!isTextEntryTarget(target)`:
  - arrow keys run `setFatBits(clampFatBitsView(origin ± 8))` with `preventDefault`;
  - Escape runs `setFatBits(null)` with `preventDefault`.
- **Message Box focus (Requirement 2.8).** On a card press, if `document.activeElement` is a text input other than the viewport's hidden textarea, it is blurred before the press is handled. The canvas's `onMouseDown` `preventDefault` would otherwise keep the focus in the Message Box.
- **Drops (Requirements 6.2, 6.3).** On the viewport wrapper:
  - `onDragOver`, when `dataTransfer.types` includes `Files`: `preventDefault()` and `dropEffect = "copy"`.
  - `onDrop`: `preventDefault()`; with no modal or window open, `onDropImage(files[0])`.
  - The shell's window guard prevents `dragover` and `drop` of files everywhere else (with `dropEffect = "none"`), when they are not already prevented.

**CSS (`system7.css`, features 3, 4, 6).**
- The Message Box reuses `.s7-palette`, `.s7-palette-title`, `.s7-close-box` and `.s7-input`, with `.s7-message-box` (width `calc(448 * var(--px))`) and `.s7-message-box-body` (padding `calc(4 * var(--px))`).
- `.s7-recent-grid` is `display: grid` with `grid-template-columns: repeat(4, calc(130 * var(--px)))` and a `calc(4 * var(--px))` gap. `.s7-recent-card` has a 1 px solid frame like `.s7-graph-node`, and its current label is inverted.
- `.s7-icon-editor`, `.s7-icon-list` (`overflow: auto`, scrollbar colours as `.s7-window-body`) and `.s7-icon-grid` (canvas with `image-rendering: pixelated` and a 1 px solid frame).
- Only 1 px / 2 px solid borders, hard-offset shadows and the theme variables are used. There is no `border-radius`, gradient, opacity, blur or dashed or dotted line, and `::selection` and `caret-color` come from the existing `.s7-shell` rules (Requirement 13).

### Document changes (Requirement 14, task 1)
1. `hexcard_design_spec.md` §2.1:
   - `iconId?: string; // names a key of the stack's customIcons (spec 06)`
   - `customIcons: Record<string, string>; // icon name -> 32x32 1-bit icon: 128 bytes (32 rows x 4 bytes, row-major, MSB = leftmost pixel, 1 = dark) as padded standard Base64, 172 chars (spec 06)`
   - The same two comments in `src/core/schema.ts`.
2. `hexcard_design_spec.md` §5.6: the bullet "Button icons (`iconId`, `customIcons`) are kept in the schema for forward compatibility but are not rendered in schema 2.0.0." becomes:

   > **Button icons:** a button whose `iconId` names a `customIcons` entry draws the 32x32 icon centred horizontally in its inside area, with the title line directly below it when `showName` is true (icon and title centred vertically as one block); set bits draw dark, clear bits leave the button face; highlighting inverts the icon and a disabled button dims it; `checkBox` and `radioButton` buttons draw no icon. See `.kiro/specs/06-hypercard-classics/design.md`.
3. `hexcard_design_spec.md` §8: `05-authoring-loop/` becomes `├──`, followed by `└── 06-hypercard-classics/       # find.ts, messageBox.ts, recentCards.ts, icons.ts, fatBits.ts, imageImport.ts: Message Box, Find, Recent, Import Image, FatBits, icons`.
4. Spec 03 `design.md` §3: the line "Button icons (`iconId`, `customIcons`) are kept in the schema for forward compatibility but are not rendered in schema 2.0.0." becomes "Button icons are rendered as `.kiro/specs/06-hypercard-classics/design.md` describes (spec 06)."
5. Spec 05 `requirements.md`:
   - Requirement 1.5 gets the note "(Spec 06 turns File > Import Image, Edit > Icon Editor, Go > Recent, Go > Find and Go > Message Box into real items; Conjure Stack and Oracle Settings stay reserved.)"
   - Requirement 2.2 gets the note "(Spec 06 adds platform modifier + F for Go > Find, + R for Go > Recent and, except on macOS, + M for Go > Message Box.)"
6. `.kiro/steering/structure.md`:
   - `06-hypercard-classics` in the specs line;
   - new entries `src/core/find.ts`, `messageBox.ts`, `recentCards.ts`, `icons.ts`, `src/engine/graphics/fatBits.ts`, `imageImport.ts`, `src/presets/builtInIcons.ts`, `src/ui/MessageBox.tsx`, `RecentCards.tsx`, `IconEditor.tsx`, each with a one-line purpose and `[06]`;
   - `06` added to `schema.ts`, `stackValidator.ts`, `store.ts`, `vm.ts`, `bitmapCanvas.ts`, `partRenderer.ts`, `atkinsonDither.ts`, `menuCommands.ts`, the `[04, 05]` UI line (which gains `ObjectInspector.tsx`), and `main.tsx`.

## Data Models

**Icon data (Requirement 8.1).**
- 1024 pixels, row-major from the top-left. Byte `b = (y * 32 + x) >> 3` holds pixel `(x, y)` in bit `7 - (x & 7)`, and 1 means dark.
- The 128 bytes are encoded with standard Base64 and padding. 128 = 42 * 3 + 2, so the text is 42 full groups (168 characters), then 3 characters for the last two bytes and one `=`: 172 characters in all.
- The 171st character carries the last 4 data bits and 2 zero bits, so it is one of `AEIMQUYcgkosw048`.
- Example: the blank icon is 171 `A` followed by `=`. An icon with only the top-left pixel dark starts with `g` (byte `0x80` → `100000|00...`), followed by 170 `A` and `=`.

**Icon name (Requirement 8.2).** `/^[\x21-\x7e](?:[\x20-\x7e]{0,30}[\x21-\x7e])?$/`, and not `__proto__`. Names are case-sensitive keys. The Icon Editor refuses to create a name that equals another one ignoring case; the validator does not check that.

**Found text.** `FoundText` (store, above). `text` is the field's text when the match was made, so the store can tell when it changes.

**FatBits view.** `{ x, y }`, integers, 0 ≤ x ≤ 448, 0 ≤ y ≤ 299.

**Message Box.** `MessageBoxSnapshot` (above), in memory only.

**Recent list.** Up to 12 `HexID`s, newest first, in memory only.

**Import limits.** 16,777,216 bytes, 8,192 pixels per side, 16,777,216 pixels.

## Correctness Properties

Each property is a fast-check test (Requirement 15.2) and holds for every generated input.

**Property 1: Icon data round trip.** For every `Uint8Array` `P` of 1024 values in {0, 1}: `isIconData(encodeIcon(P))`, `encodeIcon(P).length === 172` and `decodeIcon(encodeIcon(P))` equals `P`. For every icon data string `S`, `encodeIcon(decodeIcon(S)) === S`. _Validates: Requirements 8.1, 8.5._

**Property 2: Validator accepts exactly icon data.** For every string `V` (generated near the format: random lengths 168–176, random alphabets including `-_` and `=` in other positions, random last characters), a valid stack with `customIcons: { a: V }` passes `validateStack` exactly when `ICON_DATA_PATTERN.test(V)`, and every `encodeIcon` output passes. A button `iconId` that is not a key of `customIcons` is always rejected. _Validates: Requirements 8.3, 15.2._

**Property 3: Find respects the search rules and cycles.** For random stacks (1–6 cards on 1–3 backgrounds; card and background fields with random `visible`, `sharedText`, `content` and `bgFieldContents` drawn from a small word list; random `dontSearch`), a random needle and a random start card, repeated find commands run through a real store, history and bus with a recording handler runner:
- never make a card with `dontSearch` current;
- never set a found text in a field with `visible` false;
- produce the matches of a brute-force reference search in its order (Requirement 4.6), and after the last match produce the first again;
- produce `Not found.` exactly when the reference has no match.
_Validates: Requirements 4.4–4.7, 4.11._

**Property 4: Import Image undo restores the layer.** For random stacks, either edit layer, a random existing layer (random `rleData` from random pixels, or `""`) and a random RGBA image (1–64 pixels per side, any aspect ratio), `createImportImageCommand` run through `history.execute`:
- changes no pixel outside `importRect`;
- leaves only states 1 and 2 inside it;
- when undone, restores the target layer's `rleData` string exactly and every other layer untouched;
- when redone, yields the same `rleData` as the first apply.
_Validates: Requirements 6.7–6.9._

## Error Handling

| Situation | Behaviour |
|---|---|
| Message Box line is neither a statement nor an expression | Alert with the parser message, detail `Column N`; the line is kept; nothing runs. |
| `pass` / `exit <handler>` in the Message Box | Alert `pass and exit work only inside a handler.` |
| Malformed find command | Alert `Type find "text", for example find "lamp".` |
| Script error or gas limit in a line | The spec 04 dialogs; handler `Message Box`; no **Script** button for errors in the line itself (Requirement 3.9). |
| No match | One `click`, line `Not found.`, found text cleared. |
| Import: wrong type, too large, bad header, over the limits, decode failure | The alerts of Requirement 6.10; stack and history unchanged. |
| Drop without a paint tool | Alert `Choose a paint tool to import an image.`; the browser does not open the file. |
| Icon rename to an invalid or taken name | Alert `Icon names have 1 to 32 letters, digits, spaces or ASCII punctuation, without spaces at the ends.` or `An icon named "<name>" already exists.`; nothing changes. |
| A stack with malformed icon data, a bad icon name or a dangling `iconId` | Rejected whole by `validateStack` with the path; spec 04's "This stack is damaged" alert. |
| `setFound` / `setFatBits` / icon command precondition failures | `HexMutationError`: programming errors, never user-visible states; icon commands are then not recorded. |

## Testing Strategy

Unit tests (Requirement 15.1):
- `src/core/__tests__/icons.test.ts`:
  - encode and decode of known images: blank, the top-left pixel, the top row and the last pixel;
  - non-canonical, short, long, URL-safe and unpadded strings rejected;
  - names, including `__proto__`, 32 and 33 characters, and leading and trailing spaces;
  - `freeIconName`;
  - every icon command's apply, revert and re-apply, including rename and delete rewriting `iconId` on card and background buttons and keeping key order, and `createButtonIconCommand` with a built-in copy.
- `src/core/__tests__/icons.property.test.ts`: Properties 1 and 2.
- `stackValidator.test.ts`: the icon rules and their error paths; the existing presets and the starter stack still pass.
- `src/presets/__tests__/builtInIcons.test.ts`: Requirement 11.2–11.4.
- `partRenderer.test.ts`:
  - icon layout with and without `showName`, and in small buttons (clipping);
  - set and clear bits on opaque and transparent buttons;
  - hilite and disabled;
  - no icon on `checkBox` and `radioButton`;
  - frames of buttons without `iconId` identical to the current renderer's;
  - the found box on one and two lines, and in scrolled fields.
- `src/core/__tests__/find.test.ts`:
  - word starts, including Unicode letters and digits and surrogate pairs;
  - case folding;
  - search order and wrap-around;
  - `dontSearch` and hidden fields;
  - shared and unshared background text.
- `src/core/__tests__/find.property.test.ts`: Property 3.
- `src/core/__tests__/messageBox.test.ts`:
  - classification of every kind, column mapping and comment-only lines;
  - the runner with a recording bus and host: statements against the current card at dispatch start, expression display and the "line changed" rule, globals across lines and handlers;
  - Find dispatch, `Not found.` and the click sound.
- `vm.test.ts`: `runMessageBoxLine` errors are located as `Message Box` line 1; nested handler errors keep their location; the gas limit is shared with nested dispatches.
- `ObjectInspector.test.ts`: no **Script** button for `Message Box` errors.
- `store.test.ts`:
  - `setFound` validation and its clearing rules (card change, text change, hidden field, replaced stack);
  - `setFatBits` validation and its clearing rules (tool change, replaced stack), kept across card and edit-layer changes.
- `src/core/__tests__/recentCards.test.ts`:
  - order, no duplicates and the limit of 12;
  - every way a card becomes current;
  - reset on replace, deleted cards left out;
  - `goToRecentCard` (current card, missing card, queued dispatch).
- `src/engine/graphics/__tests__/imageImport.test.ts`:
  - headers of each format (hand-built byte arrays), truncated and zero sizes, limits;
  - the type and size checks;
  - pixel mapping on both layers;
  - the margin left untouched;
  - the `Import Image` label and the no-op case;
  - `importDroppedImage` without a paint tool.
- `src/engine/graphics/__tests__/imageImport.property.test.ts`: Property 4.
- `src/engine/graphics/__tests__/fatBits.test.ts`:
  - cell drawing;
  - the inset at both corners and its frame;
  - the bottom partial row;
  - pointer mapping and clamping;
  - a frame of only states 1 and 2.
- `menuCommands.test.ts`:
  - the new layout, enabling rules, checked FatBits and labels per platform;
  - no `Ctrl+M` / `Cmd+M` label or mapping on macOS;
  - `isReloadShortcut`;
  - no collision with `RESERVED_BROWSER_SHORTCUTS`;
  - the spec 05 coverage test with the new observable effects;
  - the spec 05 Requirement 16.5 test extended to the Message Box input and the M, F and R shortcuts (Requirement 15.3).
- `System7Shell.test.ts`: the Paint menu, the reload guard registered in the capture phase, the drop guard.
- `CardViewport.test.ts`: drop routing, FatBits pointer mapping and keys, found passed to `composeFrame`.
- `MessageBox.test.ts`, `RecentCards.test.ts` and `IconEditor.test.ts` (`renderToStaticMarkup` plus the React-free controller): the controller's show, close, line and focus requests; rendered labels in printable ASCII; four miniatures per row with the current card marked; Icon Editor enabled states.

Headless Chrome (Requirement 15.4):
- **Tooling.** As spec 05 design §9.1:
  - `npm run build` (which also builds the player for the export step);
  - `npx vite preview --port <p> --strictPort` in the background;
  - `/usr/bin/google-chrome --headless=new --remote-debugging-port=<port> --user-data-dir=<fresh temp dir> --disable-lcd-text`;
  - a throw-away Node 24 CDP script outside the repository.
- **Input.** Menus are chosen with real `Input.dispatchMouseEvent` clicks and keys with `Input.dispatchKeyEvent`.
- **After every step.** Wait 600 ms, take a screenshot, read the auto-saved stack from IndexedDB, run the repository's `validateStack` on it and compare the fields the step changed, and check the current card through the canvas `aria-label`. The script loads `src/core/stackValidator.ts` with Vite's `runnerImport`, run from the repository root, as the `build:preset-art` script does (checked: plain `node` refuses the `.ts` file, `runnerImport` loads it).
- **Colour check.** Python PIL `getcolors()` must give only `(0, 0, 0)` and `(255, 255, 255)`, at k = 1 and k = 2.
- **Shortcut check.** A last `window` `keydown` listener added through `Runtime.evaluate` records `defaultPrevented` after HexCard's listeners. macOS is emulated with `Emulation.setUserAgentOverride` (`platform: "MacIntel"`, `userAgentMetadata.platform: "macOS"`) before navigation. As the requirements say, this checks HexCard's side only.

Each feature task ends with its part:
- **Import Image (task 2):**
  1. File > New Stack; choose the Pencil.
  2. File > Import Image through `Page.setInterceptFileChooserDialog` and `DOM.setFileInputFiles` with a PNG generated by the script.
  3. Edit > Undo.
  4. Drop the same PNG with `Input.dispatchDragEvent` (`files`), then Undo.
  5. Choose Browse and drop again: the alert, no change, no navigation (the page URL is unchanged).
  6. Edit Background; import; check that the background bitmap changed.
- **Icons (task 3):**
  1. New Button; Edit > Icon Editor; select `hex-star` and click **Use for Button**.
  2. Screenshot the Icon Editor and the card; Undo and Redo.
  3. Edit a pixel; New, Duplicate, Rename (through the `ask` dialog), Delete.
  4. File > Export Standalone HTML with `Browser.setDownloadBehavior` into a temp directory.
  5. Open the downloaded file in a new tab with `Network.emulateNetworkConditions` (`offline: true`), screenshot it, confirm that the icon pixels are drawn, that no network request was made (`Network.requestWillBeSent`) and that the screenshot has only two colours.
- **Message Box and Find (task 4):**
  1. New Field; Ctrl+M; `put "brass lamp" into card field 1`; `3 * 4` → `12`; `foo bar baz` → alert.
  2. New Card; Ctrl+F; type `lamp`, Return: card 1 current with the box drawn.
  3. `find "zzz"` → `Not found.`.
  4. Shortcut check for Ctrl+M and Ctrl+F; with macOS emulated, Cmd+F handled and prevented, Cmd+M neither.
- **FatBits (task 5):**
  1. Choose the Pencil; Paint > FatBits; click three cells.
  2. Arrow Right and Arrow Down; Eraser on one cell; Escape.
  3. Check the strokes in the auto-saved card bitmap; Undo restores them one at a time.
- **Recent (task 6):**
  1. Visit three cards; Ctrl+R opens Recent; screenshot.
  2. Click the oldest miniature: that card becomes current.
  3. Ctrl+R with the focus in the Message Box: no reload (a marker set on `window` survives) and no Recent window.
  4. With macOS emulated, Cmd+R.
- **Final task (7):** every step above in one run on a fresh profile, at k = 1 and k = 2, with every screenshot colour-checked.

Each report lists the steps, the screenshot files and the colour counts.
