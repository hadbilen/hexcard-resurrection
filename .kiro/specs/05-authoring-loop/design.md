# Technical Design Document: Authoring Loop — Menus, Cards, Backgrounds & Parts

## 1. Scope & Shared Contracts
New modules:
- `src/core/authoringCommands.ts`: pure TypeScript. The six structural `HexCommand` factories, default names, id generation, the blank stack of File > New Stack and the Delete Card rule. No React, no DOM, no `src/engine/` import.
- `src/ui/menuCommands.ts`: React-free. The menu layout, enabling rules, menu handlers, shortcut table, platform labels and the key-to-command mapping. It replaces `buildMenus` and the `ForwardedCommand` path of `System7Shell.tsx`.

Changed modules (§3): `store.ts`, `history.ts`, `messageBus.ts` (spec 01); `System7Shell.tsx`, `CardViewport.tsx`, `App.tsx`, `StackGraphModal.tsx`, `fileCommands.ts`, `system7.css`, `main.tsx` (spec 04).

Canonical contracts used without restating them: schema §2.1, message path §3, supported messages §3.1 (`newCard`, `deleteCard`), concurrency model §3.2 (one dispatch at a time, nested lifecycle messages, abort, and rule 10 for menu commands as queued dispatches). Spec 01 design §3–§5 (store, history, bus) and spec 04 design §1 and §5 (UI store view, stack loader) stay valid; this design only extends them.

## 2. Architecture

~~~text
 menu click / shortcut ──► System7Shell ──► menuCommands.runMenuCommand(command)
                                               │ enabled? (enabling rule on the live snapshot)
                                               ▼
                                      menu handler (createMenuHandlers)
       ┌───────────────┬──────────────────────┼───────────────────────┬─────────────────────┐
       ▼               ▼                      ▼                       ▼                     ▼
 history.execute   bus.runCommand        windows.openInspector   fileCommands          store.setTool /
 (New Button,      (New Card, New Bkgnd,  (Object/Card/Bkgnd/     (New Stack via        setEditLayer /
  New Field,        Delete Card, Go)       Stack Info, Conjure)    replaceStackFrom,     setSelectedPart
  Delete Part,          │                                          Open/Save/Share/
  Undo/Redo, Theme)     ▼                                          Export)
                   one command dispatch: deleteCard? → closeCard → [closeBackground]
                   → commit = history.execute(structural command) → [newCard]
                   → [openBackground] → openCard
~~~

- Commands that send messages (New Card, New Background, Delete Card, Go items) run as one **command dispatch** in the message bus queue. Commands that send no messages (New Button, New Field, Delete Part, Undo, Redo, Info items) run synchronously in the menu handler.
- Every structural command is built from the live snapshot when it runs (for queued commands: when the command dispatch starts), so ids and positions are computed against the stack it will change.

## 3. Changes to Existing Modules

### 3.1 `store.ts` (spec 01)
~~~typescript
export interface HexRuntimeState {
  stack: HexStack;
  currentCardId: HexID;
  editLayer: HexLayer;
  tool: AuthoringTool;
  selectedPartId: HexID | null;            // spec 05: UI state, never saved, never undoable
}

export interface HexStore {
  // ... unchanged members ...
  /** Spec 05. `next` as before; `currentCardId`, when given, becomes the current card (it must exist in `next`). */
  applyAuthoring(next: HexStack, currentCardId?: HexID): void;
  /**
   * Spec 05 (Requirement 10.1). `null` clears the selection. Otherwise the part must be a part of the
   * active part tool's type (`button` / `field`) on the edit target, else HexMutationError.
   */
  setSelectedPart(partId: HexID | null): void;
}
~~~
- Selection invariant, enforced in `publish` for every state change: `selectedPartId` becomes `null` when the tool, the current card or the edit layer differs from the previous state, after `replaceStack`, and whenever it no longer names a part of the active part tool's type on the edit target (Requirement 10.2). `setSelectedPart` is the only way to set it.
- `applyAuthoring(next, currentCardId)`: with `currentCardId` given, that card becomes current (a missing id throws `HexMutationError` before anything is published). Without it, the existing fallback for a removed current card stays.
- The literal `HexRuntimeState` in `StackGraphModal.staticGoTarget` gains `selectedPartId: null`.
- `createUiStoreView` (`App.tsx`) adds `setSelectedPart` to the narrowed view; `applyAuthoring` and `replaceStack` stay out of it (spec 04 Requirement 2.6).

### 3.2 `history.ts` (spec 01)
~~~typescript
export interface HexCommand {
  label: string;
  apply(stack: HexStack): HexStack;
  revert(stack: HexStack): HexStack;
  /**
   * Spec 05 (Requirements 13.2, 13.3). Read right after `apply` / `revert`; the returned card becomes
   * current in the same `store.applyAuthoring` call. Commands without it leave the current card alone.
   */
  currentCardAfter?(step: "apply" | "revert"): HexID | undefined;
}
~~~
`execute`, `undo` and `redo` pass `command.currentCardAfter?.(step)` to `store.applyAuthoring(next, cardId)`. Nothing else changes: the ring buffer, the labels and "a command that changes nothing is not recorded".

### 3.3 `messageBus.ts` (spec 01)
~~~typescript
export interface MessageBus {
  // ... unchanged members ...
  /**
   * Spec 05 (design spec §3.2 rule 10). Queues `task` as one top-level dispatch with its own DispatchContext,
   * in FIFO order with posted messages (a discrete entry for the overflow rule of §3.2 rule 3). Script errors are reported
   * through `onError` with the message `{ name: label, params: [], targetId: <current card> }`;
   * aborts are not reported.
   */
  runCommand(label: string, task: (ctx: DispatchContext) => Promise<void>): void;
  /**
   * Spec 05. A structural card change inside a dispatch (New Card, New Background, Delete Card):
   * 1. `closeCard` to the current card, then `closeBackground` if `backgroundId` differs from its background;
   * 2. if the dispatch was aborted, throw HexAbortError; if the current card changed meanwhile, return
   *    without calling `commit`;
   * 3. `commit()`: exactly one `history.execute`, whose command makes `cardId` current (throws if it did not);
   * 4. `newCard` to `cardId` when `isNew`, `openBackground` if the background changed, `openCard`.
   * All messages are nested dispatches sharing `ctx` (§3.2 rule 5). The departing card is pushed onto
   * the back history by the existing store subscriber.
   */
  changeCardBy(ctx: DispatchContext, change: { cardId: HexID; backgroundId: HexID; isNew: boolean; commit: () => void }): Promise<void>;
}
~~~
- The queue holds `HexMessage | CommandEntry`. Coalescing applies to messages only; `isSkippedOpenMessage`, `isSuppressedClick` and the disabled-target rule ignore command entries. `abort()` drops queued command entries with the messages and aborts a running command dispatch (spec 01 Requirement 3.7).
- `changeCard` (used by `go`, the arrow keys and the Go menu) is unchanged.

### 3.4 `System7Shell.tsx`, `system7.css` (spec 04)
- `buildMenus`, `ForwardedCommand`, `ShellCommand` and `MenuState` move to `menuCommands.ts`; the shell renders `buildMenus(context, platform)` and runs items with `runMenuCommand`. The `onCommand` prop is replaced by `handlers: ShellMenuHandlers` (every handler except `paint.togglePalette`, which the shell adds because the palette's visibility is its existing React state), `backHistory: () => readonly HexID[]` and `platform: Platform`.
- The Cmd/Ctrl+B listener becomes one window `keydown` listener that calls `shortcutCommand(event, context)` (§6.3). `shortcutCommand` ignores events whose target is a text input, and the listener does nothing while a modal dialog or studio window is open (the studio window already stops key propagation) (Requirement 16). This changes one behaviour of today's shell: Cmd/Ctrl+B no longer toggles Edit Background while an unlocked card field is being edited.
- `MenuDropdown` draws a disabled item with the dim overlay of §7. `.s7-menu-item:disabled` loses `text-decoration: line-through`; it keeps the dark text colour (the overlay does the dimming) and gets `position: relative` for the overlay.
- Menu tests in `System7Shell.test.ts` that assert the old layout (for example the exact Edit menu entries) are updated to the layout of §6.1.
- `createThemeCommand` moves to `menuCommands.ts` with `buildMenus`; the copy in `System7Shell.tsx` is removed, and every importer (including `src/storage/__tests__/stackLoader.test.ts` and `src/ui/__tests__/System7Shell.test.ts`) imports it from `menuCommands.ts`.
- `fileCommands.ts` (spec 04): `FileCommands.run` and its `ForwardedCommand` import are removed, because the menu handlers call `openStackFile`, `saveStackFile`, `copyShareLink`, `exportStandaloneHtml` and `replaceStackFrom` directly (§6.2). The tests of `run` in `fileCommands.test.ts` are removed; the other file-command tests stay.

### 3.5 `CardViewport.tsx`, `App.tsx`, `main.tsx` (spec 04)
- `CardViewport` reads `state.selectedPartId` and calls `store.setSelectedPart` instead of its local `useState`; its tool-change clearing is removed (the store does it). Press, move and resize behaviour is unchanged.
- `App` passes `handlers`, `backHistory` and `platform` to the shell. The `go.stackGraph` and `file.openShowcase` special cases move into `createMenuHandlers`.
- `main.tsx` creates the handlers with `createMenuHandlers` (§6.2) from the narrowed store view, history, bus, studio windows, file commands and modal manager, detects the platform once with `detectPlatform(navigator)`, and passes the bus to `App` with `runCommand`, `changeCard`, `changeCardBy`, `sendNested` and `backHistory` in addition to `post` and `abort`.

## 4. Structural Commands (`src/core/authoringCommands.ts`)

~~~typescript
export type IdPrefix = "stk_" | "bkg_" | "crd_" | "prt_";
export type RandomSource = () => number;                  // [0, 1); Math.random in production

/** Every id of the stack: stack, backgrounds, cards and parts. */
export function collectIds(stack: HexStack): Set<HexID>;
/** `prefix` + 10 base-36 characters, drawn again until it is not in `taken` (Requirement 8.3). */
export function createId(prefix: IdPrefix, taken: ReadonlySet<HexID>, random?: RandomSource): HexID;
/** "Card N" / "Background N", lowest free N >= 1, case-insensitive (Requirement 8.1). */
export function numberedName(base: "Card" | "Background", taken: Iterable<string>): string;
/** "New Button", then "New Button 2", ... case-insensitive (Requirement 8.2). */
export function partName(base: "New Button" | "New Field", taken: Iterable<string>): string;

/** File > New Stack (Requirements 3.2, 3.3). */
export function createBlankStack(options?: { now?: Date; random?: RandomSource }): HexStack;

/**
 * Requirement 6.1: more than one card, the card's cantDelete is false, and the card is not the only
 * card of a background whose cantDelete is true.
 */
export function canDeleteCard(stack: HexStack, cardId: HexID): boolean;

export interface CardChangeCommand extends HexCommand {
  readonly cardId: HexID;          // the card that is current after apply
  readonly backgroundId: HexID;    // its background
}
export function createNewCardCommand(stack: HexStack, currentCardId: HexID, random?: RandomSource): CardChangeCommand;
export function createNewBackgroundCommand(stack: HexStack, currentCardId: HexID, random?: RandomSource): CardChangeCommand;
/** Throws HexMutationError unless canDeleteCard. `cardId` / `backgroundId` name the destination card. */
export function createDeleteCardCommand(stack: HexStack, cardId: HexID): CardChangeCommand & { readonly removesBackground: boolean };

export interface NewPartCommand extends HexCommand { readonly partId: HexID; readonly partType: PartType; readonly layer: HexLayer }
export function createNewPartCommand(state: Pick<HexRuntimeState, "stack" | "currentCardId" | "editLayer">, type: PartType, random?: RandomSource): NewPartCommand;
export function createDeletePartCommand(state: Pick<HexRuntimeState, "stack" | "currentCardId" | "editLayer">, partId: HexID): HexCommand;

export const NEW_BUTTON_RECT: HexRect = { x: 196, y: 159, width: 120, height: 24 };
export const NEW_FIELD_RECT: HexRect = { x: 176, y: 147, width: 160, height: 48 };
~~~

| Command | `apply` | `revert` | `currentCardAfter` apply / revert |
|---|---|---|---|
| New Card | insert the card right after the card `currentCardId` (looked up by id) | remove the card by id | new card / `currentCardId` |
| New Background | append the background; insert its card after `currentCardId` | remove both by id | new card / `currentCardId` |
| Delete Card | record the card, its index and, when no other card uses its background (Requirement 6.3), the background and its index; remove them | re-insert at the recorded indexes | destination / deleted card |
| New Button / New Field | append the part to the edit target's `parts` | remove the part by id | `currentCardId` / `currentCardId` |
| Delete Part | record the part, its index and, for a background field, every card's `bgFieldContents` entry for it; remove them | re-insert the part at its index and restore the entries | `currentCardId` / `currentCardId` |

- Ids and names are fixed when the factory runs, so Redo recreates identical objects (Requirement 8.4). Removed objects are recorded by `apply` from the stack it receives, so runtime changes made by script handlers before the commit (for example a `deleteCard` handler writing a field) are part of what Undo restores.
- Delete Card's destination is the card after the deleted one, or the one before it when the deleted card is last. `removesBackground` is true when no other card uses the background; `canDeleteCard` has then already checked that the background's `cantDelete` is false, so a background with `cantDelete` is never left without cards.
- Untouched objects keep their identity (structural sharing); the store freezes the new ones (spec 01 design §3).
- Every result is a valid schema 2.0.0 stack; `apply` on a stack where its precondition fails (for example a missing card id) throws `HexMutationError`, so the history does not record it.

## 5. Command Dispatches and Message Order

| Command | Messages, all nested in one command dispatch |
|---|---|
| New Card | `closeCard`(A) → commit → `newCard`(N) → `openCard`(N) |
| New Background | `closeCard`(A) → `closeBackground`(A) → commit → `newCard`(N) → `openBackground`(N) → `openCard`(N) |
| Delete Card | `deleteCard`(D) → `closeCard`(D) → [`closeBackground`(D)] → commit → [`openBackground`(E)] → `openCard`(E) |
| Go First / Prev / Next / Last / Back | as `go` (spec 01 Requirement 2.4) through `bus.changeCard` |

A = departing card, N = new card, D = deleted card, E = destination card. Brackets: only when the background changes. Background messages target the card, as `changeCard` does today.

~~~typescript
// New Card (New Background is the same with createNewBackgroundCommand)
bus.runCommand("New Card", async (ctx) => {
  if (!stillEnabled("objects.newCard")) return notAvailable("New Card");          // Requirement 1.6
  const { stack, currentCardId } = store.getSnapshot();
  const command = createNewCardCommand(stack, currentCardId);
  await bus.changeCardBy(ctx, { cardId: command.cardId, backgroundId: command.backgroundId, isNew: true,
                                commit: () => history.execute(command) });
});

// Delete Card
bus.runCommand("Delete Card", async (ctx) => {
  if (!stillEnabled("objects.deleteCard")) return notAvailable("Delete Card");
  const cardId = store.getSnapshot().currentCardId;
  await bus.sendNested({ name: "deleteCard", params: [], targetId: cardId }, ctx);
  if (store.getSnapshot().currentCardId !== cardId) return;                      // Requirement 6.4
  const command = createDeleteCardCommand(store.getSnapshot().stack, cardId);
  await bus.changeCardBy(ctx, { cardId: command.cardId, backgroundId: command.backgroundId, isNew: false,
                                commit: () => history.execute(command) });
});

// Go Next (First, Prev, Last alike; Back passes { type: "relative", dir: "back" })
bus.runCommand("Go Next", async (ctx) => {
  if (!stillEnabled("go.next")) return notAvailable("Next");
  await bus.changeCard(resolveRelativeCard(store.getSnapshot(), "next"), ctx);   // Requirement 11.5
});
~~~

- A script error or an abort stops the dispatch where it happens (spec 02 Requirement 4.4, spec 01 Requirement 3.7). Before the commit the stack is unchanged (Requirements 4.3, 5.3, 6.4); after it, the change stays and the remaining messages are not sent. The error dialogs of spec 04 Requirements 3.3 and 3.4 are shown as for any dispatch.
- Messages are delivered in every tool. The bus does not check the tool when it delivers (only `idle` is Browse-only), so card scripts run when the Go menu is used with an authoring tool, as in HyperCard.
- Undo and Redo never go through the bus: they call `history.undo` / `history.redo` directly, so they send no message (Requirement 13.4).

## 6. Menus (`src/ui/menuCommands.ts`)

### 6.1 Layout, enabling rules and handlers
`R` marks a reserved item: always disabled, no shortcut label, no handler. `S` = the selected part. Labels are printable ASCII (Requirement 1.7). The Label column is the exact label: items that open a window or dialog end with ASCII `...` (Requirement 1.8); Save Stack File, Export Standalone HTML and Copy Share Link complete their command directly (a download, or a copy followed by a confirmation), and Show / Hide Tools Palette toggles a palette, so these have none. Shortcut labels follow §6.3.

| Menu | Label (command) | Shortcut | Enabled when | Menu handler |
|---|---|---|---|---|
| Hex | `About HexCard...` (`hex.about`) | | always | `modals.alert` (as today) |
| Hex | `ClassicPaper` ... `MidnightHex` (`theme:<name>`), checked = current | | always | `history.execute(createThemeCommand(name))` |
| File | `New Stack` (`file.newStack`) | | always | `files.replaceStackFrom(() => createBlankStack())`, then `store.setTool("browse")` if the load succeeded |
| File | `Open Showcase Stack...` (`file.openShowcase`) | | always | `windows.openShowcaseChooser()` |
| File | `Open Stack File...` / `Save Stack File` (`file.openStackFile` / `file.saveStackFile`) | | always | `files.openStackFile()` / `files.saveStackFile()` |
| File | `Import Image...` (`file.importImage`) R | | never | |
| File | `Copy Share Link` / `Export Standalone HTML` (`file.copyShareLink` / `file.exportHtml`) | | always | `files.copyShareLink()` / `files.exportStandaloneHtml()` |
| Edit | `Undo` / `Undo <label>` (`edit.undo`) | modifier + Z | `history.canUndo()` | `history.undo()` |
| Edit | `Redo` / `Redo <label>` (`edit.redo`) | modifier + Shift + Z | `history.canRedo()` | `history.redo()` |
| Edit | `Edit Background` (`edit.background`), checked in background mode | modifier + B | always | `store.setEditLayer(toggle)` |
| Edit | `Icon Editor...` (`edit.iconEditor`) R | | never | |
| Go | `Back` (`go.back`) | | a back-history entry names a card of the stack other than the current one | command dispatch `changeCard({ type: "relative", dir: "back" })` |
| Go | `Recent...` (`go.recent`) R | | never | |
| Go | `First` / `Prev` / `Next` / `Last` (`go.first` / `go.previous` / `go.next` / `go.last`) | | First: not on the first card; Last: not on the last card; Prev, Next: more than one card | command dispatch `changeCard(resolveRelativeCard(...))` |
| Go | `Find...` (`go.find`) R, `Message Box...` (`go.messageBox`) R | | never | |
| Go | `Stack Graph...` (`go.stackGraph`) | | always | `windows.openStackGraph()` |
| Tools | 12 tools (`tool:<id>`), checked = current | | always | `store.setTool(id)` |
| Objects | `Object Info...` (`objects.objectInfo`) | | S exists | `windows.openInspector(S)` |
| Objects | `Card Info...` / `Background Info...` / `Stack Info...` (`objects.cardInfo` / `objects.backgroundInfo` / `objects.stackInfo`) | | always | `windows.openInspector(current card / its background / stack id)` |
| Objects | `New Button` / `New Field` (`objects.newButton` / `objects.newField`) | | always | `history.execute(createNewPartCommand(...))`, `store.setTool("button" / "field")`, `store.setSelectedPart(partId)` |
| Objects | `Delete Part` (`objects.deletePart`) | Delete, Backspace (no label) | S exists | `history.execute(createDeletePartCommand(state, S))` |
| Objects | `New Card` / `Delete Card` / `New Background` (`objects.newCard` / `objects.deleteCard` / `objects.newBackground`) | | always / `canDeleteCard` / always | command dispatches of §5 |
| Paint | `Show Tools Palette` / `Hide Tools Palette` (`paint.togglePalette`) | | always | shell-owned palette toggle |
| AI Conjure | `Conjure Script...` (`ai.conjure`) | | always | `windows.openInspector(S ?? current card, "spellcaster")` |
| AI Conjure | `Conjure Stack...` (`ai.conjureStack`) R, `Oracle Settings...` (`ai.oracleSettings`) R | | never | |

Separators: Hex: after About. File: after Open Showcase Stack, after Save Stack File, after Import Image. Edit: after Redo, after Edit Background. Go: after Recent, after Last, after Message Box. Objects: after Stack Info, after Delete Part. AI Conjure: after Conjure Script.

Oracle Settings belongs to spec 04 task 5.2; that task turns it from reserved into a real item.

### 6.2 API
~~~typescript
export type ReservedCommand = "file.importImage" | "edit.iconEditor" | "go.recent" | "go.find" | "go.messageBox" | "ai.conjureStack" | "ai.oracleSettings";
export type MenuCommand = /* every command of §6.1 */;
export type Platform = "mac" | "other";

export interface MenuContext {
  state: HexRuntimeState;
  history: Pick<HexHistory, "canUndo" | "canRedo" | "undoLabel" | "redoLabel">;
  backHistory: readonly HexID[];
  paletteVisible: boolean;
}

export function detectPlatform(nav?: { platform?: string; userAgentData?: { platform?: string } }): Platform;
export function shortcutLabel(shortcut: { key: "B" | "Z"; shift: boolean }, platform: Platform): string; // "Cmd+B", "Ctrl+Shift+Z"
export function isEnabled(command: MenuCommand, context: MenuContext): boolean;
export function buildMenus(context: MenuContext, platform: Platform): MenuModel[]; // labels, checks, disabled flags, shortcut labels
export type MenuHandlers = Record<Exclude<MenuCommand, ReservedCommand>, () => void>;
export type ShellMenuHandlers = Omit<MenuHandlers, "paint.togglePalette">;
export function createMenuHandlers(deps: MenuHandlerDeps): ShellMenuHandlers;
/** Runs the handler only when the item is enabled; returns whether it ran. */
export function runMenuCommand(command: MenuCommand, context: MenuContext, handlers: MenuHandlers): boolean;
/** §6.3: true when the event target is a text input (Requirement 16). */
export function isTextInputTarget(target: EventTarget | null): boolean;
/** §6.3: the command a key press maps to, with `preventDefault` advice; undefined for text-input targets. */
export function shortcutCommand(event: KeyLike, context: MenuContext): { command: MenuCommand; preventDefault: boolean } | undefined;
~~~
`MenuHandlerDeps` holds the narrowed store view, the history, the bus (`runCommand`, `changeCard`, `changeCardBy`, `sendNested`), the studio windows, the file commands (`replaceStackFrom`, `openStackFile`, `saveStackFile`, `copyShareLink`, `exportStandaloneHtml`), the modal manager (`alert`) and an optional `RandomSource`. `MenuHandlers` is a `Record` over every non-reserved command, so a missing handler is a type error; the test of Requirement 15.3 checks the same at run time.

### 6.3 Shortcuts and platform
- Table (Requirement 2.2): modifier + `B` (Edit Background), modifier + `Z` (Undo), modifier + Shift + `Z` (Redo). A press matches when `metaKey || ctrlKey` is set, `altKey` is not, `event.code` is `KeyB` or `KeyZ` (`code`, so the shortcut sits on the same physical key on every layout), and `shiftKey` is set for Redo only.
- Text inputs first (Requirement 16): `isTextInputTarget` is true when `target.closest("input, textarea, select, [contenteditable]")` finds an element (the same test as `CardViewport`'s `isTextEntryTarget`). That covers the hidden card textarea while an unlocked field is edited, the inspector's text boxes, the script editor, the Spellcaster prompt and the `ask` dialog's text box. For such targets `shortcutCommand` returns `undefined`, so no handler runs and the browser's text editing (native undo and redo, Delete, Backspace) is not prevented.
- Outside text inputs, `shortcutCommand` returns `preventDefault: true` for every table match, enabled or not (Requirement 2.4).
- Delete / Backspace without modifiers map to `objects.deletePart` with `preventDefault: true` only when `objects.deletePart` is enabled; otherwise `undefined`, so Browse-mode `keyDown` forwarding in `CardViewport` is untouched (Requirement 2.5).
- The Left and Right arrow keys are not in the table: Browse-mode `keyDown` forwarding and the spec 01 built-in go to the previous or next card as today (Requirement 2.6).
- While a modal dialog or studio window is open the shell's listener does nothing (Requirement 16.3); the abort shortcut stays in `CardViewport`'s own `keydown` listener, which this spec does not change, so it keeps working in every focus state (Requirement 16.4).
- Reserved combinations (Requirement 2.1) are listed in `RESERVED_BROWSER_SHORTCUTS`; a test asserts that no table entry collides with them.
- `detectPlatform` prefers `navigator.userAgentData.platform`, falls back to `navigator.platform`, and returns `"mac"` when the value starts with `Mac` (case-insensitive). It runs once in `main.tsx`.

## 7. Dimmed Menu Items
A disabled item gets one overlay element over its check, label and shortcut cells:
~~~html
<svg class="s7-dim" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true" focusable="false">
  <defs><pattern id="{id}" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="scale({k})">
    <path d="M0 0h1v1H0zM1 1h1v1H1z" fill="var(--light-bit)" /></pattern></defs>
  <rect width="100%" height="100%" fill="url(#{id})" />
</svg>
~~~
Every second 1x pixel of the item, in a checkerboard, is painted light, so text and check mark keep only half of their dark pixels. The item box is already on the k-pixel grid (menu metrics are multiples of `--px`), so the pattern stays aligned. No opacity, no grey and no strike-through are used (steering tech.md, 1-Bit Fidelity Rule 6). Disabled items do not invert on hover.

## 8. Error Handling
- Delete Card when `canDeleteCard` fails at run time, or any Go / New Card / New Background whose rule fails when its dispatch starts: alert "<item label> is not available now." (Requirement 1.6), stack unchanged.
- `setSelectedPart` with an invalid id and `applyAuthoring` with a missing current card throw `HexMutationError`; both are programming errors, never user-visible states.
- File > New Stack: a rejected load shows the loader's "This stack is damaged" alert and keeps the current stack (it cannot happen for the blank stack, but the path is the same as every load).

## 9. Testing
- `src/core/__tests__/authoringCommands.test.ts`: every factory's apply, revert and re-apply; default names (gaps, case-insensitive collisions, both layers); ids (prefixes, collision retry with a scripted `RandomSource`); `createBlankStack` passes `validateStack`; Delete Card destination at the first, middle and last position; background removal with the last card of a background; `canDeleteCard` false for the last card of a background with `cantDelete`, for a card with `cantDelete` and for the only card; background field deletion cleans and restores `bgFieldContents`; z-order after create, delete and undo.
- `src/core/__tests__/authoringCommands.property.test.ts` (Requirement 15.2): fast-check over initial stacks (the starter stack, each showcase stack, generated stacks with 1–4 cards on 1–3 backgrounds, some with `cantDelete`) and up to 50 actions: New Card, Delete Card, New Background, New Button, New Field, Delete Part (random part of the edit target), Toggle Edit Background, Undo, Redo, driven through a real store and history, with disabled actions skipped. Checks after each action and after full undo as in Requirement 15.2.
- `store.test.ts` / `history.test.ts`: selection rules of Requirement 10.2; `applyAuthoring` with a current card; `currentCardAfter` on execute, undo and redo; commands without it keep today's behaviour.
- `messageBus.test.ts`: `runCommand` FIFO order with posted messages and abort; `changeCardBy` message orders of §5 with a recording handler runner; stop before commit on abort, script error and a handler's `go`.
- `src/ui/__tests__/menuCommands.test.ts`: layout of §6.1; every enabling rule; the coverage test of Requirement 15.3 over fixed contexts (starter stack in Browse; one card; card with `cantDelete`; last card of a background with `cantDelete`; Button tool with a selected part; Edit Background mode; empty and non-empty back history; history with and without entries), running each enabled unchecked item against recording fakes and asserting an observable effect; every label of §6.1 exactly, including the trailing `...` rule of Requirement 1.8; shortcut labels per platform (`Cmd+Shift+Z` / `Ctrl+Shift+Z` for Redo); no digit or other shortcut beyond the table; no collision with `RESERVED_BROWSER_SHORTCUTS`; disabled shortcuts are prevented but not run; Requirement 16.5: every studio shortcut (modifier + B, + Z, + Shift + Z, Delete, Backspace) with an `input`, a `textarea` (hidden card textarea, script editor, Spellcaster prompt) and a `contenteditable` target returns `undefined`, runs no handler and leaves `preventDefault` uncalled; end-to-end message orders with a real store, history and bus; Go > Back after Delete Card skips the deleted card.
- `System7Shell.test.ts`: disabled items render the `s7-dim` overlay scaled by k; `system7.css` has no `line-through` or opacity for disabled items.
- `CardViewport.test.ts`: selection goes through `store.setSelectedPart` and follows the store.

### 9.1 Headless Chrome check (Requirement 15.4)
Same tooling as earlier UI tasks (no Playwright): `npm run build`, `npx vite preview --port <p> --strictPort` in the background, `/usr/bin/google-chrome --headless=new --remote-debugging-port=<port> --user-data-dir=<fresh temp dir>`, driven by a throw-away Node 24 script outside the repository (CDP over `WebSocket`). Menus are chosen with real `Input.dispatchMouseEvent` clicks on the menu title and item.
1. Open the studio (fresh profile: the Haunted Stack opens unchanged, so New Stack asks nothing), choose File > New Stack.
2. Objects > New Card; Objects > New Button; Objects > New Field; Go > Prev; Go > Next; Objects > Delete Part; Edit > Undo.
3. After every step: wait 600 ms (auto-save debounce), take a screenshot, read the auto-saved stack from IndexedDB with `Runtime.evaluate` and compare it with the expected cards, parts and current card (the canvas `aria-label` names the current card).
4. Also screenshot the open Objects and Go menus, so dimmed items are visible.
5. Check every PNG with Python PIL: `getcolors()` must contain only `(0, 0, 0)` and `(255, 255, 255)`. Run once at device scale factor 1 with a viewport that gives k = 1 and once with k = 2.
The task report lists the steps, the screenshot files and the colour counts.
