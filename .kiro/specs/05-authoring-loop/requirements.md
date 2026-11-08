# Requirements Document: Authoring Loop — Menus, Cards, Backgrounds & Parts

## Introduction
Today a user can only edit the showcase stacks. There is no way to create or delete cards, backgrounds or parts, and several menu items (Go First/Prev/Next/Last, New Button, New Field, Object Info, Conjure Script) are forwarded to a handler that ignores them. This spec closes the authoring loop: after it, a user can build a stack from nothing using the menus, and every menu item either works or is shown disabled.

The spec adds no persisted fields and no state outside the spec 01 store. It reuses what exists:
- spec 01: the store and its two write paths (`store.applyRuntime`, and `store.applyAuthoring` reached only through `createHistory`), `history.execute` for every authoring change, the message bus (`post`, `changeCard`, nested lifecycle dispatch, back history of Requirement 2.7);
- spec 03: hit testing and part rendering;
- spec 04: the System 7 menus in `System7Shell.tsx`, the card viewport's selection handles, the Object Inspector (part, card, background and stack objects) and its HexAI Spellcaster tab, the stack loader (Requirement 5.5) and the unsaved-changes guard (Requirement 7.6).

Canonical contracts: schema `hexcard_design_spec.md` §2.1, message path §3, supported messages §3.1, concurrency model §3.2.

Out of scope (their menu items stay visible and disabled): Find, Recent, Message Box, Import Image, Icon Editor, Conjure Stack, and Oracle Settings (spec 04 task 5.2). Also out of scope: cut, copy and paste of cards and parts, Bring Closer / Send Farther, and the `newBackground`, `deleteBackground`, `newButton`, `newField`, `deleteButton` and `deleteField` messages, which design spec §3.1 does not list.

## Glossary
- **Menu item:** one entry of a menu in the System 7 menu bar. Separators are not menu items. This document names menu items without their trailing `...` (Requirement 1.8); for example "Objects > Card Info" is the item labelled `Card Info...`.
- **Text input:** any element that takes typed text: the hidden textarea of an unlocked card field being edited in Browse mode, the Object Inspector's text boxes, the script editor, the Spellcaster prompt, and the text box of a dialog (for example `ask`).
- **Studio shortcut:** a key press that runs a menu handler: the shortcuts of Requirement 2.2 and Delete / Backspace of Requirement 2.5.
- **Menu command:** the id of the action a menu item runs, e.g. `objects.newCard`.
- **Menu handler:** the function that performs a menu command. Not to be confused with a **script handler** (`on mouseUp ... end mouseUp`).
- **Enabled / disabled:** an enabled menu item can be chosen and runs its menu handler; a disabled one is drawn dimmed and cannot be chosen.
- **Enabling rule:** the condition under which a menu item is enabled (Requirements 3 to 12).
- **Reserved item:** a menu item whose feature belongs to a later spec. It is always disabled.
- **Observable effect:** a change of the stack, of the store's UI state (tool, edit layer, current card, selected part), of the history, of the open studio window or dialog, of the Tools palette, or the start of a file, clipboard or navigation operation.
- **Platform modifier:** the Command key on macOS, the Control key elsewhere.
- **Edit layer:** `card` or `background`, chosen by Edit Background mode (spec 01 Requirement 1.4).
- **Edit target:** the current card, or the current card's background while Edit Background mode is active.
- **Part tool:** the Button tool or the Field tool.
- **Selected part:** the part shown with selection handles while a part tool is active. Selection is UI state in the store, like the tool and the edit layer: never saved, never undoable.
- **Command dispatch:** one top-level dispatch (design spec §3.2 rule 1) that runs a menu command which sends messages. It waits for its turn in the message bus queue like a discrete message.
- **Structural command:** New Card, New Background, Delete Card, New Button, New Field or Delete Part. Each is one history command.
- **Back history:** the list of departed cards used by `go back` (spec 01 Requirement 2.7).
- **Unsaved-changes guard:** the "Save changes to a file first?" question of spec 04 Requirement 7.6.
- **Stack loader:** the one stack loading path of spec 04 Requirement 5.5.
- **Dimmed:** drawn through a 50% checkerboard of light pixels, the classic 1-bit look of unavailable text (as spec 03 Requirement 3.4 does for disabled parts).

## Requirements

### Requirement 1: Menu Contract
**User Story:** As a user, I want every menu item either to work or to look unavailable, so that I never choose a command that silently does nothing.

#### Acceptance Criteria
1. THE SYSTEM SHALL show every menu item of every menu either enabled and connected to a menu handler, or disabled.
2. WHEN the user chooses an enabled menu item, THE SYSTEM SHALL run its menu handler, and the handler SHALL produce an observable effect; the only exception is choosing an item that is already checked (the current tool or theme), which MAY leave everything unchanged.
3. WHILE a menu item is disabled, THE SYSTEM SHALL draw its label dimmed, using only the stack theme's `darkBitHex` and `lightBitHex` colours, with the checkerboard aligned to the 1x pixel grid at UI scale k, and without opacity, grey colours or strike-through; it SHALL ignore clicks on the item, keyboard activation of the item, and the item's keyboard shortcut.
4. WHEN a menu opens or a shortcut is pressed, THE SYSTEM SHALL compute each item's enabled state from the current store snapshot, the history and the message bus back history, using the enabling rules of Requirements 3 to 12.
5. THE SYSTEM SHALL show the reserved items File > Import Image, Edit > Icon Editor, Go > Recent, Go > Find, Go > Message Box, AI Conjure > Conjure Stack and AI Conjure > Oracle Settings as disabled, without a shortcut label.
6. WHEN a command dispatch starts, THE SYSTEM SHALL check the item's enabling rule again; IF the rule no longer holds, THEN THE SYSTEM SHALL leave the stack unchanged and show a System 7 alert "<item label> is not available now.", with the label written without a trailing `...`.
7. THE SYSTEM SHALL write every menu label and shortcut label in printable ASCII, which the bundled fonts cover.
8. THE SYSTEM SHALL end the label of every menu item that opens a window or dialog for further input or review with three ASCII full stops `...` (the classic Mac convention), reserved items included: About HexCard, Open Showcase Stack, Open Stack File, Import Image, Icon Editor, Recent, Find, Message Box, Stack Graph, Object Info, Card Info, Background Info, Stack Info, Conjure Script, Conjure Stack and Oracle Settings; every other item SHALL have no trailing `...`.

### Requirement 2: Keyboard Shortcuts
**User Story:** As a HyperCard user, I want the classic shortcuts where the browser allows them, so that I can work quickly without the browser stealing my keys.

#### Acceptance Criteria
1. THE SYSTEM SHALL NOT assign a shortcut that browsers reserve and pages cannot prevent: platform modifier + N, + T, + W, + Q, + Tab, + Shift+N, + Shift+T, + Shift+Tab, and Ctrl+PageUp / Ctrl+PageDown.
2. THE SYSTEM SHALL offer these shortcuts and no others for menu items: platform modifier + B for Edit > Edit Background, platform modifier + Z for Edit > Undo, and platform modifier + Shift + Z for Edit > Redo; the Go menu items SHALL have no shortcut.
3. THE SYSTEM SHALL label shortcuts in menus as `Cmd+B`, `Cmd+Z` and `Cmd+Shift+Z` on macOS and `Ctrl+B`, `Ctrl+Z` and `Ctrl+Shift+Z` on every other platform; it SHALL accept both the Command and the Control key as the modifier on every platform, as Edit Background does today.
4. WHEN a shortcut of Requirement 2.2 is pressed outside a text input (Requirement 16), THE SYSTEM SHALL prevent the browser's default action and SHALL run the same menu handler as the shortcut's menu item, only if that item is enabled.
5. WHEN the user presses Delete or Backspace without a modifier outside a text input WHILE a part is selected, THE SYSTEM SHALL run Objects > Delete Part and prevent the browser's default action; otherwise THE SYSTEM SHALL leave these keys to the existing Browse-mode handling.
6. THE SYSTEM SHALL keep the Left and Right arrow keys working as today: in Browse mode an unhandled `keyDown` with the Left or Right arrow goes to the previous or next card (spec 01 Requirement 2.5).

### Requirement 3: New Stack
**User Story:** As a creator, I want to start an empty stack, so that I can build my own application instead of editing a showcase.

#### Acceptance Criteria
1. WHEN the user chooses File > New Stack, THE SYSTEM SHALL first apply the unsaved-changes guard of spec 04 Requirement 7.6; IF the user chooses Cancel, THEN THE SYSTEM SHALL leave the current stack unchanged.
2. WHEN the guard allows the change, THE SYSTEM SHALL load through the stack loader a new stack with `schemaVersion` `"2.0.0"`, name `"Untitled"`, empty `author`, `createdAt` and `updatedAt` set to the current time, the ClassicPaper theme, no custom icons, empty scripts, one background named `"Background 1"` with an empty bitmap (`""`) and no parts, and one card named `"Card 1"` on that background with an empty bitmap, no parts, empty `bgFieldContents` and `marked`, `cantDelete` and `dontSearch` set to false.
3. THE SYSTEM SHALL give the new stack, its background and its card new ids with the prefixes `stk_`, `bkg_` and `crd_`, and the new stack SHALL pass `validateStack`.
4. WHEN the new stack has been loaded, THE SYSTEM SHALL select the Browse tool; Edit Background mode, the history and the back history are reset by the existing load path (spec 01 Requirement 2.7, spec 04 Requirement 5.5), and `openStack`, `openBackground` and `openCard` are sent (spec 01 Requirement 2.9).
5. THE SYSTEM SHALL keep File > New Stack enabled at all times.

### Requirement 4: New Card
**User Story:** As a creator, I want to add a card after the current one, so that my stack can grow card by card.

#### Acceptance Criteria
1. WHEN the user chooses Objects > New Card, THE SYSTEM SHALL insert, right after the current card, a new card on the current card's background with a default name (Requirement 8.1), an empty bitmap (`""`), no parts, empty `bgFieldContents`, `marked`, `cantDelete` and `dontSearch` set to false, and an empty script.
2. THE SYSTEM SHALL make the new card current in one command dispatch that sends, in this order, `closeCard` to the departing card and `newCard` and `openCard` to the new card, and SHALL record the departing card in the back history.
3. IF a `closeCard` script handler changes the current card, raises a script error or is aborted before the card is inserted, THEN THE SYSTEM SHALL not insert the card.
4. THE SYSTEM SHALL keep Objects > New Card enabled at all times, in Browse, in every authoring tool and in Edit Background mode.

### Requirement 5: New Background
**User Story:** As a creator, I want to start a new background, so that a group of cards can share a different layout.

#### Acceptance Criteria
1. WHEN the user chooses Objects > New Background, THE SYSTEM SHALL append to the stack's backgrounds a new background with a default name (Requirement 8.1), an empty bitmap (`""`), no parts, an empty script and `cantDelete` set to false, and SHALL insert right after the current card one new card on it, as described in Requirement 4.1.
2. THE SYSTEM SHALL make the new card current in one command dispatch that sends, in this order, `closeCard` and `closeBackground` to the departing card, then `newCard`, `openBackground` and `openCard` to the new card, and SHALL record the departing card in the back history.
3. IF a `closeCard` or `closeBackground` script handler changes the current card, raises a script error or is aborted before the background is created, THEN THE SYSTEM SHALL not create the background or the card.
4. THE SYSTEM SHALL keep Objects > New Background enabled at all times.

### Requirement 6: Delete Card
**User Story:** As a creator, I want to delete the current card, so that I can remove cards I no longer need.

#### Acceptance Criteria
1. THE SYSTEM SHALL enable Objects > Delete Card only WHILE the stack has more than one card, the current card's `cantDelete` is false, and the current card is not the only card of a background whose `cantDelete` is true (HyperCard behaviour).
2. WHEN the user chooses Objects > Delete Card, THE SYSTEM SHALL, in one command dispatch: send `deleteCard` to the current card; then send `closeCard` to it, and `closeBackground` if the destination card has a different background; remove the card; make the next card current, or the previous card if the deleted card was the last one; then send `openBackground` (only if the background changed) and `openCard` to the destination card.
3. IF the deleted card was the only card using its background, THEN THE SYSTEM SHALL remove the background in the same history command (by Requirement 6.1 that background's `cantDelete` is false).
4. IF a `deleteCard`, `closeCard` or `closeBackground` script handler changes the current card, raises a script error or is aborted before the card is removed, THEN THE SYSTEM SHALL leave the stack unchanged.
5. WHEN a card has been deleted, THE SYSTEM SHALL keep `go back` working: back history entries that name the deleted card are skipped as spec 01 Requirement 2.7 already defines.

### Requirement 7: Object Inspector Commands
**User Story:** As a creator, I want to open the properties and script of the card, background, stack or selected part from the menus, so that I do not need a double-click for every object.

#### Acceptance Criteria
1. WHEN the user chooses Objects > Card Info, Objects > Background Info or Objects > Stack Info, THE SYSTEM SHALL open the Object Inspector on its Properties tab for the current card (name, Marked, Don't Search, Can't Delete), the current card's background (name, Can't Delete) or the stack (name, author), with the HexTalk Script tab available as today.
2. THE SYSTEM SHALL keep Card Info, Background Info and Stack Info enabled at all times.
3. WHEN the user chooses Objects > Object Info, THE SYSTEM SHALL open the Object Inspector on the selected part, exactly as a double-click on that part does (spec 04 Requirement 3.1).
4. THE SYSTEM SHALL enable Objects > Object Info only WHILE a part is selected.

### Requirement 8: Default Names and Ids
**User Story:** As a creator, I want new objects to get readable, unique names and ids, so that I can refer to them in scripts right away.

#### Acceptance Criteria
1. WHEN a card or background is created, THE SYSTEM SHALL name it `"Card N"` or `"Background N"`, where N is the lowest positive integer for which no card (or background) of the stack has that name, compared case-insensitively.
2. WHEN a button or field is created, THE SYSTEM SHALL name it `"New Button"` or `"New Field"` if no part of the same type on the same layer owner (that card, or that background) has that name, compared case-insensitively; otherwise `"New Button N"` or `"New Field N"` with the lowest N >= 2 that is free.
3. WHEN an object is created, THE SYSTEM SHALL give it an id with the schema prefix of its kind (`stk_`, `bkg_`, `crd_`, `prt_`) that no other id of the stack (stack, backgrounds, cards and parts together) uses.
4. WHEN a structural command is redone, THE SYSTEM SHALL recreate its objects with the same ids and names as the first time.

### Requirement 9: New Button and New Field
**User Story:** As a creator, I want to add a button or a field with one menu choice, so that I can place controls without a drawing gesture.

#### Acceptance Criteria
1. WHEN the user chooses Objects > New Button, THE SYSTEM SHALL add, at the end of the edit target's `parts` (on top of its layer), a button with `layerScope` equal to the edit layer, rect `{ x: 196, y: 159, width: 120, height: 24 }` (120x24, centred on the 512x342 card), style `roundRect`, a default name (Requirement 8.2) used as both `name` and `title`, `showName` and `autoHilite` true, `hilite` false, `visible` and `enabled` true, no `family`, no `iconId`, and an empty script.
2. WHEN the user chooses Objects > New Field, THE SYSTEM SHALL add, at the end of the edit target's `parts`, a field with `layerScope` equal to the edit layer, rect `{ x: 176, y: 147, width: 160, height: 48 }` (160x48, centred), style `rectangle`, a default name (Requirement 8.2), empty `content`, `lockText`, `sharedText`, `dontWrap` and `showLines` false, `textAlign` `left`, `textFont` `Sans`, `textSize` 12, no `textStyle`, `visible` and `enabled` true, and an empty script; a new background field SHALL leave every card's `bgFieldContents` unchanged, so it reads as empty on every card.
3. WHEN a button (or field) has been created, THE SYSTEM SHALL select the Button (or Field) tool and make the new part the selected part, so its selection handles are shown.
4. THE SYSTEM SHALL keep Objects > New Button and Objects > New Field enabled at all times.

### Requirement 10: Part Selection and Delete Part
**User Story:** As a creator, I want to select a part and delete it, so that I can remove controls I placed by mistake.

#### Acceptance Criteria
1. WHILE the Button (or Field) tool is active, WHEN the user presses on a button (or field) of the edit target, THE SYSTEM SHALL make it the selected part and show its selection handles; WHEN the user presses where no such part is, THE SYSTEM SHALL clear the selection.
2. THE SYSTEM SHALL clear the selection WHEN the tool changes, the current card changes, the edit layer changes or a stack is loaded, and WHENEVER the selected part is no longer a part of the active part tool's type on the edit target (for example after Undo).
3. WHEN the user chooses Objects > Delete Part, THE SYSTEM SHALL remove the selected part from its layer as one history command and clear the selection; THE SYSTEM SHALL enable Objects > Delete Part only WHILE a part is selected.
4. IF the deleted part is a background field, THEN THE SYSTEM SHALL remove its entry from the `bgFieldContents` of every card in the same history command.
5. THE SYSTEM SHALL send no message when a part is created or deleted.

### Requirement 11: Go Menu
**User Story:** As a user, I want the Go menu to move between cards in any tool, so that I can check other cards while I author.

#### Acceptance Criteria
1. WHEN the user chooses Go > First, Prev, Next or Last, THE SYSTEM SHALL change the current card through the message bus in one command dispatch, with the same lifecycle messages as `go` (spec 01 Requirement 2.4), WHILE the Browse tool or any authoring tool is active.
2. THE SYSTEM SHALL wrap Prev and Next around the ends of the stack, as `go prev` and `go next` do.
3. WHEN the user chooses Go > Back, THE SYSTEM SHALL go to the back target of spec 01 Requirement 2.7 through the message bus in one command dispatch.
4. THE SYSTEM SHALL enable Go > First only WHILE the current card is not the first card, Go > Last only WHILE it is not the last card, Go > Prev and Go > Next only WHILE the stack has more than one card, and Go > Back only WHILE the back history holds a card of the stack other than the current card.
5. WHEN a command dispatch for a Go item starts, THE SYSTEM SHALL resolve the destination card from the store snapshot at that moment, not at the moment the item was chosen.
6. THE SYSTEM SHALL NOT record navigation in the undo history; Edit > Undo and Edit > Redo SHALL keep their labels and targets across Go commands.

### Requirement 12: AI Conjure Menu
**User Story:** As a creator, I want to reach the Spellcaster from the menu bar, so that I can describe a behaviour without first opening the inspector.

#### Acceptance Criteria
1. WHEN the user chooses AI Conjure > Conjure Script, THE SYSTEM SHALL open the Object Inspector on its HexAI Spellcaster tab for the selected part, or for the current card WHILE no part is selected.
2. THE SYSTEM SHALL keep AI Conjure > Conjure Script enabled at all times, and SHALL show every AI Conjure item that is not implemented as a disabled reserved item (Requirement 1.5).

### Requirement 13: Undo and Redo of Structural Commands
**User Story:** As a creator, I want to undo and redo every structural change exactly, so that I can experiment without losing work.

#### Acceptance Criteria
1. THE SYSTEM SHALL apply each structural command as exactly one `history.execute` command, labelled `New Card`, `New Background`, `Delete Card`, `New Button`, `New Field` or `Delete Part`, so that the Edit menu shows for example "Undo New Card" and "Redo Delete Part".
2. WHEN a structural command is undone, THE SYSTEM SHALL restore a stack deep-equal to the stack right before the command (card order, background order, the parts order of every layer, the `bgFieldContents` of every card, a removed background) and SHALL make the card that was current right before the command current again.
3. WHEN a structural command is redone, THE SYSTEM SHALL restore a stack deep-equal to the stack right after the command and SHALL make the card that was current right after the command current again.
4. WHEN Undo or Redo runs, THE SYSTEM SHALL send no message (no `newCard`, `deleteCard`, `closeCard` or `openCard`) and SHALL leave the tool and the edit layer unchanged; a current-card change made by Undo or Redo is recorded in the back history like any other card change (spec 01 Requirement 2.7).
5. THE SYSTEM SHALL send `newCard` and `deleteCard` as runtime messages through the message bus, outside the history command; undoing a New Card or New Background SHALL NOT send `deleteCard`, and runtime changes made by script handlers during a structural command SHALL NOT be part of its history command.

### Requirement 14: State Ownership
**User Story:** As a developer, I want the authoring loop to keep the spec 01 write paths, so that undo, auto-save and rendering stay consistent.

#### Acceptance Criteria
1. THE SYSTEM SHALL keep the selected part in the store snapshot as UI state, next to the tool and the edit layer, and SHALL NOT keep any other new state outside the store.
2. THE SYSTEM SHALL apply every structural command through `history.execute`, load the new stack of File > New Stack only through the stack loader, and send messages only through the message bus; UI components SHALL keep receiving the store view without `applyAuthoring` and `replaceStack` (spec 04 Requirement 2.6).
3. THE SYSTEM SHALL add no persisted field: every stack produced by the commands of this spec SHALL be a schema 2.0.0 `HexStack` that passes `validateStack`.

### Requirement 15: Verification
**User Story:** As the maintainer, I want the authoring loop covered by unit, property and browser checks, so that regressions are caught before release.

#### Acceptance Criteria
1. THE SYSTEM SHALL ship unit tests for every structural command, every enabling rule, every message order of Requirements 4 to 6 and 11, and the Undo and Redo of every structural command.
2. THE SYSTEM SHALL ship a fast-check property test that runs random sequences of at most 50 actions drawn from New Card, Delete Card, New Background, New Button, New Field, Delete Part (of a random existing part), Undo and Redo, in both edit layers, skipping actions whose menu item would be disabled; after every action the stack SHALL pass `validateStack`, contain at least one card, use every id once and have an existing current card; after undoing every action the stack SHALL deep-equal the original stack and the current card SHALL equal the original current card.
3. THE SYSTEM SHALL ship a menu test that enumerates every menu item of every menu in a fixed set of representative states and fails if an enabled item has no menu handler, if running an enabled, unchecked item produces no observable effect, or if a reserved item is enabled.
4. THE SYSTEM SHALL be checked in headless Chrome by building a two-card stack from File > New Stack using only menus (New Card, New Button, New Field, Go > Prev, Go > Next, Delete Part, Undo), taking a screenshot after every step, and confirming that every screenshot contains only the ClassicPaper colours `#000000` and `#FFFFFF` and that the auto-saved stack matches each step.

### Requirement 16: Text Input Focus
**User Story:** As a user typing text, I want the editing keys to edit my text, so that a studio shortcut never deletes a part, undoes an authoring change or toggles Edit Background while I type.

#### Acceptance Criteria
1. WHILE the keyboard focus is in a text input (an unlocked card field being edited in Browse mode, the Object Inspector, the script editor, the Spellcaster prompt, or a dialog's text box), THE SYSTEM SHALL fire no studio shortcut.
2. WHILE the keyboard focus is in a text input, THE SYSTEM SHALL leave Cmd/Ctrl+Z, Cmd/Ctrl+Shift+Z, Delete and Backspace to that text input, with their normal text-editing meaning, and SHALL NOT prevent their default action.
3. WHILE a dialog or studio window is open, THE SYSTEM SHALL fire no studio shortcut, even when the focus is not in a text input.
4. THE SYSTEM SHALL keep the abort shortcut Cmd/Ctrl+. (spec 01 Requirement 3.7) working in every focus state.
5. THE SYSTEM SHALL ship tests that press every studio shortcut with the focus in each kind of text input of Requirement 16.1 and assert that no menu handler runs and the default action is not prevented.
