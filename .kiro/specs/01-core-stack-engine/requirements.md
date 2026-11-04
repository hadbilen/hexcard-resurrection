# Requirements Document: Core Stack Engine

## Introduction
This spec covers the persisted data model, the runtime store and its two write paths, the 50-step undo history, stack validation on load, and the message bus (message path, queue, `idle`, nested lifecycle messages). Shared contracts are defined in `hexcard_design_spec.md`: schema §2.1, message path §3, concurrency model §3.2. The script language and VM are in spec 02; rendering is in spec 03.

## Requirements

### Requirement 1: Layered Stack Model & SharedText Semantics
**User Story:** As a stack author, I want cards to inherit shared graphics, parts and scripts from a background while keeping card-specific field data, so that I can build multi-card applications without duplicating layouts.

#### Acceptance Criteria
1. WHEN the store resolves the visible content of a card, THE SYSTEM SHALL return the linked `HexBackground` bitmap and parts beneath the card's own bitmap and parts, in the layer order of design spec §5.6.
2. WHERE a background `HexFieldPart` has `sharedText` set to `false`, WHEN a user or script reads or writes that field on a card, THE SYSTEM SHALL read from and write to `HexCard.bgFieldContents[fieldId]` of that card only, treating a missing entry as the empty string.
3. WHERE a background `HexFieldPart` has `sharedText` set to `true`, WHEN a user or script writes that field on any card, THE SYSTEM SHALL update `HexFieldPart.content` on the `HexBackground`, so every card sharing that background shows the new text.
4. WHILE Edit Background mode is active, THE SYSTEM SHALL route every authoring mutation (paint strokes, part creation, part edits) to the active card's `HexBackground`.
5. THE SYSTEM SHALL support exactly two part types, `button` and `field`, as defined in design spec §2.1.

### Requirement 2: Deterministic Message Path
**User Story:** As a stack developer, I want UI and lifecycle messages to bubble through the HyperCard object hierarchy, so that shared handlers can live at card, background or stack level.

#### Acceptance Criteria
1. WHEN a message is dispatched, THE SYSTEM SHALL deliver it along the path `HexPart -> HexCard -> HexBackground -> HexStack -> HexRuntimeBuiltIns`, starting at the message target defined in design spec §3.
2. WHEN an object on the path has a handler for the message (case-insensitive name match), THE SYSTEM SHALL run that handler and stop propagation, unless the handler executes `pass`.
3. WHEN a handler executes `pass <message>`, THE SYSTEM SHALL end that handler immediately and continue delivery at the next object on the path with the same parameters.
4. WHEN the current card changes, THE SYSTEM SHALL send `closeCard` to the departing card and `openCard` to the destination card; IF the background changes, THEN THE SYSTEM SHALL send `closeBackground` after `closeCard` and `openBackground` before `openCard`.
5. IF no object handles `keyDown` with the Left or Right arrow key, THEN THE SYSTEM SHALL go to the previous or next card respectively.
6. WHEN the user clicks inside an unlocked field with the Browse tool, THE SYSTEM SHALL place the text caret and SHALL NOT send mouse messages.
7. WHEN the current card changes by any means other than `go back`, THE SYSTEM SHALL push the departing card's id onto a back history of at most 64 entries (dropping the oldest); WHEN `go back` runs, THE SYSTEM SHALL go to the most recent entry that still exists and is not the current card, removing it and any skipped entries above it; IF none exists, THEN `go back` SHALL do nothing. Replacing the stack SHALL clear the history.
8. WHEN a mouse message targets a part with `enabled = false`, THE SYSTEM SHALL NOT deliver it to that part or any object on its path; the disabled part still captures the hit.
9. WHEN a stack becomes current (studio start after fonts are loaded, or after the loader's store.replaceStack), THE SYSTEM SHALL abort any running dispatch, clear the queue, and post openStack, openBackground and openCard to the current card, in that order.

### Requirement 3: Single-Threaded Runtime Concurrency
**User Story:** As a stack author, I want predictable script execution when users click during waits, dialogs or network calls, so that my stacks behave the same every time.

#### Acceptance Criteria
1. THE SYSTEM SHALL run at most one dispatch at a time and keep pending messages in a FIFO queue.
2. WHILE a dispatch is suspended in `wait`, `answer`, `ask`, `fetch` or a visual effect, THE SYSTEM SHALL keep it as the running dispatch and queue newly arriving messages.
3. WHEN discrete messages arrive while a dispatch runs, THE SYSTEM SHALL queue them in arrival order up to 32 entries, dropping the oldest entry on overflow and logging a console warning.
4. WHEN continuous messages (`mouseStillDown`, `mouseWithin`, `idle`) arrive while one of the same kind is already pending, THE SYSTEM SHALL keep only one pending entry of that kind.
5. THE SYSTEM SHALL send `idle` every 200 ms only WHILE the Browse tool is active, the queue is empty, no dispatch is running, no modal dialog is open and the page is visible.
6. WHEN `go` changes the card, THE SYSTEM SHALL deliver the resulting lifecycle messages as nested dispatches inside the current dispatch, sharing its gas budget; IF nesting exceeds 16 levels, THEN THE SYSTEM SHALL abort the dispatch with the script error "Too much recursion".
7. WHEN the user presses `Cmd+.` or `Ctrl+.`, or switches from Browse to an authoring tool, THE SYSTEM SHALL abort the running dispatch and clear the queue.

### Requirement 4: Runtime Store & Write Paths
**User Story:** As a developer, I want one owner of the stack state with explicit write paths, so that undo, auto-save and React re-rendering stay consistent.

#### Acceptance Criteria
1. THE SYSTEM SHALL keep the current stack in `src/core/store.ts`, expose `subscribe` and `getSnapshot`, and return a new immutable snapshot object after every change.
2. WHEN an authoring tool changes the stack, THE SYSTEM SHALL apply the change only through `history.execute(command)`.
3. WHEN the VM or Browse-mode typing changes the stack, THE SYSTEM SHALL apply the change only through `store.applyRuntime(mutation)` and SHALL NOT add it to the undo history.
4. WHEN a stack is loaded or a `scriptSource` changes, THE SYSTEM SHALL compile the affected scripts into the in-memory `ScriptCache`; IF a script fails to compile, THEN THE SYSTEM SHALL store an empty AST plus the compile errors for that object and continue loading.
5. THE SYSTEM SHALL NOT include any AST in a persisted or exported stack.

### Requirement 5: 50-Step Undo History
**User Story:** As a stack author, I want to undo and redo my authoring changes, so that I can experiment safely.

#### Acceptance Criteria
1. WHEN `history.execute(command)` runs, THE SYSTEM SHALL apply the command and push it onto a ring buffer holding at most 50 commands, discarding the oldest when full and clearing the redo list.
2. WHEN the user chooses Undo or Redo, THE SYSTEM SHALL revert or re-apply exactly one command and restore the stack to the identical prior or later state.
3. WHEN a paint stroke ends, THE SYSTEM SHALL record the whole stroke as one command holding the before/after pixels of the affected rectangle.

### Requirement 6: Stack Validation on Load
**User Story:** As a user opening a shared stack, I want malformed or malicious stack data to be rejected safely, so that it cannot corrupt the app.

#### Acceptance Criteria
1. WHEN a stack is loaded from IndexedDB, a `.hexstack` file, a URL hash or a preset, THE SYSTEM SHALL validate it with the Zod schema in `src/core/stackValidator.ts` before it reaches the store.
2. IF validation fails, THEN THE SYSTEM SHALL reject the whole stack, keep the current stack unchanged and report the first validation error in a System 7 alert.
3. THE SYSTEM SHALL reject stacks whose `schemaVersion` is not `"2.0.0"`, whose cards reference a missing `backgroundId`, or whose part `layerScope` does not match the layer that contains it.
4. THE SYSTEM SHALL reject stacks that have no cards or no backgrounds.
5. THE SYSTEM SHALL reject stacks in which any `id` (stack, background, card or part) appears more than once anywhere in the stack.
6. THE SYSTEM SHALL reject stacks whose `dimensions` or any `HexBitmapLayer` `width`/`height` differ from `512` x `342` (the only size supported in schema 2.0.0).
7. THE SYSTEM SHALL reject stacks whose `themePalette` colours are not `#RRGGBB` hex strings, and parts whose `rect` has non-integer values or a negative `width`/`height`.
