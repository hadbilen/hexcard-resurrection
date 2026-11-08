# Implementation Plan: Authoring Loop — Menus, Cards, Backgrounds & Parts

- [x] 1. Extend the store and the history for part selection and the restored current card
  - `src/core/store.ts`: `selectedPartId` in `HexRuntimeState`, `setSelectedPart`, the selection invariant enforced on every published state, and `applyAuthoring(next, currentCardId?)` (design §3.1)
  - `src/core/history.ts`: optional `HexCommand.currentCardAfter(step)`, passed to `applyAuthoring` by `execute`, `undo` and `redo` (design §3.2)
  - `createUiStoreView` in `src/ui/App.tsx` exposes `setSelectedPart`; the `HexRuntimeState` literal in `StackGraphModal.tsx` gets `selectedPartId: null`
  - Tests in `store.test.ts` and `history.test.ts`: selection rules, current card after execute / undo / redo, unchanged behaviour of commands without `currentCardAfter`
  - _Requirements: 10.2, 13.2, 13.3, 13.4, 14.1_

- [x] 2. Extend the message bus with command dispatches
  - `src/core/messageBus.ts`: `runCommand(label, task)` as a queued top-level dispatch, and `changeCardBy(ctx, change)` with the message orders of design §5 (design §3.3)
  - Command entries in the FIFO queue: overflow, abort and error reporting as in design §3.3
  - Tests in `messageBus.test.ts`: FIFO order with posted messages, abort of queued and running commands, message orders for a new card, a new background and a deleted card, no commit after an abort, a script error or a handler's `go`
  - _Requirements: 4.2, 4.3, 5.2, 5.3, 6.2, 6.4, 11.1, 13.4, 13.5_

- [x] 3. Implement the structural commands
  - `src/core/authoringCommands.ts`: ids, default names, `createBlankStack`, `canDeleteCard` and the six command factories of design §4
  - Unit tests in `src/core/__tests__/authoringCommands.test.ts` (design §9)
  - fast-check property in `src/core/__tests__/authoringCommands.property.test.ts`: random action sequences of at most 50 steps through a real store and history keep the stack valid, and full undo restores the original stack and current card
  - _Requirements: 3.2, 3.3, 4.1, 5.1, 6.1, 6.3, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 10.3, 10.4, 10.5, 13.1, 13.2, 13.3, 14.3, 15.1, 15.2_

- [ ] 4. Implement the menu model, menu handlers and shortcuts
  - `src/ui/menuCommands.ts`: the layout, exact labels (trailing `...` rule), enabling rules and handlers of design §6.1, the API of §6.2, the shortcut table, platform labels, text-input rule and key mapping of §6.3, and the "not available now" check of §8
  - Command dispatches for New Card, New Background, Delete Card and the Go items as in design §5
  - Tests in `src/ui/__tests__/menuCommands.test.ts` (design §9): every enabling rule and label, the menu coverage test, shortcut labels and reserved browser shortcuts, every studio shortcut with text-input targets, end-to-end message orders with a real store, history and bus
  - _Requirements: 1.1, 1.2, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.4, 3.5, 4.2, 4.4, 5.2, 5.4, 6.1, 6.2, 6.5, 7.1, 7.2, 7.3, 7.4, 9.3, 9.4, 10.3, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 12.1, 12.2, 13.5, 14.2, 15.1, 15.3, 16.1, 16.2, 16.5_

- [ ] 5. Wire the menus, shortcuts and selection into the studio
  - `System7Shell.tsx`: render `buildMenus` from `menuCommands.ts`, run items with `runMenuCommand`, one `keydown` listener using `shortcutCommand`, the dim overlay of design §7; remove `ForwardedCommand` and `onCommand` (design §3.4)
  - `system7.css`: disabled menu items without strike-through, positioned for the overlay
  - `CardViewport.tsx` reads and writes the selection through the store; `App.tsx` and `main.tsx` pass the handlers, back history, platform and the extended bus (design §3.5)
  - Update the spec 04 tests that assert the old menu layout or the viewport's local selection
  - The shell's `keydown` listener ignores text-input targets and does nothing while a dialog or studio window is open; the abort shortcut and the arrow keys keep working as today
  - _Requirements: 1.3, 1.8, 2.4, 2.5, 2.6, 3.4, 9.3, 10.1, 10.2, 14.1, 14.2, 16.1, 16.3, 16.4_

- [ ] 6. Check the authoring loop in headless Chrome
  - Build a two-card stack from File > New Stack using only menus, as in design §9.1, at UI scale 1 and 2
  - Screenshot every step, compare the auto-saved stack with each step, and confirm every screenshot contains only `#000000` and `#FFFFFF`
  - _Requirements: 15.4_
