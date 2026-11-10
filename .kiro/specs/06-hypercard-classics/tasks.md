# Implementation Plan

Tasks are in priority order (design §Overview, "Delivery order"): the list can be cut after any task and every finished feature works on its own. Each feature task removes only its own items from `ReservedCommand`, updates the spec 05 tests that list reserved items or the menu layout, and ends with its part of the headless Chrome check of design §Testing Strategy (tooling, colour check at k = 1 and k = 2 with `--disable-lcd-text`, auto-saved stack checked with the repository's `validateStack` through Vite's `runnerImport`; throw-away script outside the repository).

- [x] 1. Make the specification document changes
  - `hexcard_design_spec.md` §2.1: the `iconId` and `customIcons` comments; the same comments in `src/core/schema.ts` (design §Document changes, item 1)
  - `hexcard_design_spec.md` §5.6: the button-icon bullet; §8: the `06-hypercard-classics/` entry (items 2 and 3)
  - Spec 03 `design.md` §3: the icon line points to this spec (item 4)
  - Spec 05 `requirements.md` Requirements 1.5 and 2.2: the spec 06 notes (item 5)
  - `.kiro/steering/structure.md`: the spec list, every new module with `[06]`, and `06` on every changed module (item 6)
  - No other document outside this spec changes; no application code changes except the two comments in `schema.ts`
  - _Requirements: 14.1, 14.2, 14.3, 14.4, 14.5, 14.6, 14.7_

- [x] 2. Implement Import Image
  - `src/engine/graphics/imageImport.ts`: types, limits and messages, `readImageHeader` (PNG, GIF, BMP, JPEG, WebP), `withinImportLimits`, `importRect`, `createImportImageCommand` (a `PaintStrokeCommand` labelled `Import Image` on the edit target), `importImageFile`, `importDroppedImage` (design §imageImport.ts)
  - `atkinsonDither.ts`: optional `limits` on `decodeImageBlobToRgba`, throwing `RangeError` before any canvas is allocated
  - `fileCommands.ts`: `FileBrowserAccess.pickImage` and `FileCommands.pickImageFile`
  - `menuCommands.ts`: `file.importImage` becomes a real item, enabled only while a paint tool is active, handler `files.pickImageFile` then `images.importFile`
  - `CardViewport.tsx`: `onDragOver` / `onDrop` on the viewport wrapper calling `onDropImage`; `System7Shell.tsx`: the window `dragover` / `drop` guard for files; `App.tsx` and `main.tsx`: the `images` wiring
  - Unit tests in `src/engine/graphics/__tests__/imageImport.test.ts` (headers, truncated and zero sizes, type, size and pixel limits, pixel mapping on both layers, margin untouched, no-op import, drop without a paint tool) and for the menu item, the file picker and the drop routing
  - fast-check Property 4 in `src/engine/graphics/__tests__/imageImport.property.test.ts`: import, then Undo restores the layer's `rleData` exactly, then Redo gives the same `rleData`, on both edit layers
  - Headless Chrome: File > New Stack, Pencil; File > Import Image with a generated PNG (`Page.setInterceptFileChooserDialog`, `DOM.setFileInputFiles`); Undo; drop the PNG (`Input.dispatchDragEvent`), Undo; Browse tool and drop: the alert, no change, page URL unchanged; Edit Background and import: background bitmap changed; screenshot and colour-check every step
  - _Requirements: 1.1, 1.3, 1.10, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.10, 6.11, 12.1, 12.4, 12.5, 13.1, 13.2, 15.1, 15.2, 15.4_

- [x] 3. Implement button icons

  - [x] 3.1 Icon data, validation, rendering and built-in icons
    - `src/core/icons.ts`: constants, `isIconData`, `isIconName`, `encodeIcon`, `decodeIcon`, `iconFromRows`, `BLANK_ICON`, `freeIconName`, `iconNameError` and every icon command factory with exact apply / revert (design §icons.ts)
    - `stackValidator.ts`: icon name and icon data schemas for `customIcons`, and `checkIconReferences` for dangling `iconId`s
    - `partRenderer.ts`: icon layout, set and clear bits, clipping, hilite inversion and dimming in `drawPushButton`; no icon for `checkBox` / `radioButton`; decode cache of 256 entries (design §Rendering)
    - `src/presets/builtInIcons.ts`: at least 12 icons named `hex-...`, drawn pixel by pixel as 32 rows of `#` and `.`; nothing traced, copied or adapted from Apple's HyperCard icons or any other icon set; the task report says how the art was made
    - Unit tests: `icons.test.ts` (known images, rejected strings, names, `freeIconName`, every command's apply, revert and re-apply, rename and delete rewriting `iconId` on card and background buttons with key order kept), validator tests (each rule and its error path; presets and starter stack still pass), `partRenderer.test.ts` (layout with and without `showName`, small buttons, opaque and transparent faces, hilite, disabled, checkable styles, frames of buttons without `iconId` unchanged), `builtInIcons.test.ts`
    - fast-check Properties 1 and 2 in `src/core/__tests__/icons.property.test.ts`
    - Headless Chrome (after `npm run build`, so the player includes the renderer change): open a generated `.hexstack` file whose button uses an icon through File > Open Stack File; screenshot the card; Export Standalone HTML into a temp directory, open it with `Network.emulateNetworkConditions` offline, screenshot it, confirm the icon pixels are drawn and no request was made; open a stack with malformed icon data and one with a dangling `iconId`: "This stack is damaged" for both; colour-check every screenshot
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 11.1, 11.2, 11.3, 11.4, 12.1, 13.1, 15.1, 15.2, 15.4_

  - [x] 3.2 Icon Editor
    - `src/ui/IconEditor.tsx`: the window, list, editing grid, buttons, enabled states, store sync and `initialIconChoice` (design §IconEditor.tsx)
    - `src/engine/graphics/fatBits.ts`: create the module with `drawFatCell` only, which the grid uses (design §fatBits.ts); task 5 adds the rest
    - `src/core/icons.ts`: remove the `first` parameter from `createCopyIconCommand` and `freeIconName`; Duplicate always numbers the copy (design §icons.ts); update `icons.test.ts`
    - `ObjectInspector.tsx`: `{ kind: "iconEditor" }` and `openIconEditor()`; `App.tsx` renders the window; `menuCommands.ts`: `edit.iconEditor` becomes a real item, always enabled
    - `system7.css`: `.s7-icon-editor*` rules (1-bit rules of steering `tech.md`)
    - Unit tests in `IconEditor.test.ts` (labels in printable ASCII, enabled states with and without a selected button and for built-in icons, initial choice, the choice after Undo and Delete, Duplicate of a built-in icon whose name is free gives "<name> 2", Use for Button with a built-in icon whose name is already a stack icon adds "<name> 2" and sets it) and for the menu item
    - Headless Chrome: New Button; Edit > Icon Editor; select `hex-star`, **Use for Button**; screenshot the window and the card; Undo, Redo; edit a pixel; New, Duplicate, Rename (through the `ask` dialog), Delete; Export Standalone HTML, open it offline and confirm the icon is drawn, no request was made and the screenshot has two colours; colour-check every screenshot
    - _Requirements: 1.1, 1.3, 1.10, 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 11.3, 12.1, 12.4, 12.5, 13.1, 13.2, 13.3, 15.1, 15.4_

- [x] 4. Implement the Message Box and Find

  - [x] 4.1 Message Box window and running lines
    - `vm.ts`: `MESSAGE_BOX_HANDLER`, `MessageBoxProgram`, `runMessageBoxLine` with the `messageBox` frame flag (globals for every variable, errors at line 1) (design §vm.ts addition)
    - `src/core/messageBox.ts`: `classifyMessageBoxLine` (empty, statement, expression, error, column mapping, `pass` / `exit <handler>` rejected), `messageBoxValueText` and the runner for statements and expressions; a line whose first word is `find` is left to task 4.2 and is an ordinary expression error until then
    - `src/ui/MessageBox.tsx`: `createMessageBox` and `MessageBoxWindow` (floating, draggable, Return, Escape, focus requests); `CardViewport.tsx`: focus out of the Message Box on a card press; `ObjectInspector.tsx`: no **Script** button for `Message Box` errors; `App.tsx`, `main.tsx`: wiring; `system7.css`: `.s7-message-box*`
    - `menuCommands.ts` and `System7Shell.tsx`: `go.messageBox` becomes a real item; the `platforms` field of `SHORTCUTS`, `platform` passed to `shortcutCommand`, `handleShortcutKey` and `shellShortcutKey`; Ctrl+M on every platform except macOS, with no label, mapping or `preventDefault` on macOS
    - Unit tests: `messageBox.test.ts` (classification, runner with a recording bus and host, current card at dispatch start, the "line changed" rule, globals across lines and handlers), `vm.test.ts` (error location, nested handler locations, shared gas), `MessageBox.test.ts`, `ObjectInspector.test.ts`, `menuCommands.test.ts` (labels and mapping per platform, no collision with `RESERVED_BROWSER_SHORTCUTS`, the coverage test counting Message Box changes as observable), and the spec 05 Requirement 16.5 test extended to the Message Box input and Ctrl+M
    - Headless Chrome: New Field; Ctrl+M opens the Message Box; `put "brass lamp" into card field 1` (field text changed); `3 * 4` shows `12`; `foo bar baz` shows the alert; close and reopen keeps the line; shortcut check for Ctrl+M (item ran, default prevented); with macOS emulated, Cmd+M neither handled nor prevented and no `Ctrl+M` label; colour-check every screenshot
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 1.6, 1.7, 1.9, 1.10, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 12.3, 12.4, 13.1, 13.2, 13.3, 15.1, 15.3, 15.4_

  - [x] 4.2 Find
    - `src/core/find.ts`: `isWordStart`, `matchStarts`, `searchableFields`, `findNext` (design §find.ts)
    - `store.ts`: `found` UI state, `setFound` and its clearing invariant; `found: null` in every `HexRuntimeState` literal (including `StackGraphModal.staticGoTarget` and tests)
    - `messageBox.ts`: the `find` and `findUsage` kinds and the Find dispatch (`click` sound and `Not found.` when nothing matches)
    - `bitmapCanvas.ts` and `partRenderer.ts`: `found` in `ComposeOptions` / `PartDrawContext` and the inverted outline per line; `CardViewport.tsx`: pass `found`, scroll a `scrolling` field to the match
    - `menuCommands.ts`: `go.find` becomes a real item opening the Message Box with `find ""` and the caret between the quotes; Cmd/Ctrl+F on every platform
    - Unit tests: `find.test.ts` (word starts incl. Unicode and surrogate pairs, case folding, order, wrap-around, `dontSearch`, hidden fields, shared and unshared background text), `store.test.ts` (`setFound` validation and clearing), `messageBox.test.ts` (find lines, usage alert, empty text, Find dispatch), `partRenderer.test.ts` (box on one and two lines, scrolled fields), `menuCommands.test.ts` (`Cmd+F` / `Ctrl+F`, coverage test), and the spec 05 Requirement 16.5 test extended to Cmd/Ctrl+F
    - fast-check Property 3 in `src/core/__tests__/find.property.test.ts`, through a real store, history and bus
    - Headless Chrome: build the stack of task 4.1's check (New Field, `put "brass lamp" into card field 1` from the Message Box), New Card; Ctrl+F, type `lamp`, Return: card 1 is current and the box is drawn; edit the field: the box disappears; `find "zzz"`: `Not found.`, current card unchanged; shortcut check for Ctrl+F; with macOS emulated, Cmd+F handled and prevented; colour-check every screenshot
    - _Requirements: 1.1, 1.3, 1.4, 1.6, 1.7, 1.10, 3.1, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 12.2, 12.4, 13.1, 15.1, 15.2, 15.3, 15.4_

- [x] 5. Implement FatBits
  - `src/engine/graphics/fatBits.ts`: constants, `clampFatBitsView`, `insetRect`, `inInset`, `fatBitsCardPoint` and `renderFatBits`, next to the `drawFatCell` of task 3.2, which `renderFatBits` uses (design §fatBits.ts)
  - `store.ts`: `fatBits` UI state, `setFatBits` and its clearing invariant; `fatBits: null` in every `HexRuntimeState` literal; `createUiStoreView` exposes `setFatBits`
  - `CardViewport.tsx`: FatBits drawing after composition (paint previews included), pointer mapping, presses in the inset ignored, arrow keys and Escape (design §Rendering); `main.tsx`: `eraserSize: 1` while FatBits is on
  - `menuCommands.ts` and `System7Shell.tsx`: Paint > FatBits after a separator, checked while on, enabled with the Pencil or the Eraser, toggling `setFatBits`
  - Unit tests: `fatBits.test.ts` (cells, inset at both corners, bottom partial row, mapping and clamping, states 1 and 2 only), `store.test.ts` (`setFatBits` validation, cleared on tool change and stack load, kept across card and edit-layer changes), `CardViewport.test.ts` (mapping, keys, focus in a text input), `menuCommands.test.ts` and `System7Shell.test.ts` (Paint menu, enabling, check mark)
  - Headless Chrome: Pencil, Paint > FatBits; click three cells; Arrow Right and Arrow Down; Eraser on one cell; Escape; strokes present in the auto-saved card bitmap; Undo removes them one stroke at a time; Browse turns FatBits off; colour-check every screenshot
  - _Requirements: 1.2, 1.3, 1.10, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 7.8, 7.9, 7.10, 12.2, 13.1, 15.1, 15.4_

- [x] 6. Implement Recent
  - `src/core/recentCards.ts`: `createRecentCards` and `goToRecentCard` (design §recentCards.ts)
  - `StackGraphModal.tsx`: export `ThumbnailCanvas`; `src/ui/RecentCards.tsx`: `RecentWindow` (four miniatures per row, current card marked, button per miniature); `system7.css`: `.s7-recent*`
  - `ObjectInspector.tsx`: `{ kind: "recent" }` and `openRecent()`; `App.tsx` and `main.tsx`: wiring
  - `menuCommands.ts` and `System7Shell.tsx`: `go.recent` becomes a real item with Cmd/Ctrl+R; `isReloadShortcut` and the capture-phase reload guard
  - Unit tests: `recentCards.test.ts` (order, no duplicates, limit 12, every way a card becomes current, reset on stack load, deleted cards left out, `goToRecentCard`), `RecentCards.test.ts`, `menuCommands.test.ts` (`Cmd+R` / `Ctrl+R`, `isReloadShortcut`, coverage test), `System7Shell.test.ts` (guard registered in the capture phase), and the spec 05 Requirement 16.5 test extended to Cmd/Ctrl+R
  - Headless Chrome: visit three cards; Ctrl+R opens Recent; screenshot; click the oldest miniature: that card is current; Ctrl+R with the focus in the Message Box: no reload (a marker on `window` survives) and no Recent window; Ctrl+R with a dialog open: no reload; shortcut check for Ctrl+R; with macOS emulated, Cmd+R handled and prevented; colour-check every screenshot
  - _Requirements: 1.1, 1.3, 1.4, 1.6, 1.7, 1.8, 1.9, 1.10, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 12.3, 12.4, 13.1, 13.2, 15.1, 15.3, 15.4_

- [ ] 7. Run the whole headless Chrome check
  - `npm run build`, a fresh browser profile, every step of Requirement 15.4 in one run at k = 1 and at k = 2, as listed in design §Testing Strategy (Message Box, Find, Recent, Import Image, FatBits, Icon Editor, standalone HTML offline, shortcuts on Linux and with macOS emulated)
  - Screenshot every step and every new window; confirm every screenshot contains only `#000000` and `#FFFFFF` and that the auto-saved stack passes `validateStack` and matches each step
  - The report lists the steps, the screenshot files and the colour counts
  - _Requirements: 13.1, 15.4_
