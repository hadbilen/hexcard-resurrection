# Requirements Document: System 7 UI, WebAudio Synth, Spellcaster, Storage & Showcase Stacks

## Introduction
This spec covers everything the user touches directly: the React System 7 shell, tools palette, card viewport, Object Inspector and dialogs; the procedural sound engine; the HexAI Spellcaster; persistence, sharing and standalone HTML export; and the three showcase stacks. It builds on spec 01 (store, message bus), spec 02 (parser, VM, AST validator) and spec 03 (rendering).

## Requirements

### Requirement 1: Procedural WebAudio Synthesizer
**User Story:** As a stack author, I want scripts to play authentic 1987-style instruments from note notation without audio files.

#### Acceptance Criteria
1. WHEN a `PlaySound` node runs, THE SYSTEM SHALL synthesize the requested voice (`harpsichord` via Karplus-Strong, `boing`, `flute`, `square8bit`, `click`) with the WebAudio API and no audio asset files.
2. WHEN parsing a note string such as `"c4q e4q g4h c5w"`, THE SYSTEM SHALL schedule pitches and durations (`w`, `h`, `q`, `e`, `s`, dotted `.`, rest `r`) at the given tempo (default 120 BPM).
3. IF sound is requested before the browser allows audio (no user gesture yet), THEN THE SYSTEM SHALL drop that request silently and SHALL resume the `AudioContext` on the first pointer or key event.

### Requirement 2: System 7 Shell, Tools & Modes
**User Story:** As a creator, I want to switch between Browse and authoring with authentic System 7 menus and a tear-off 12-tool palette.

#### Acceptance Criteria
1. WHEN the user selects the Browse tool, THE SYSTEM SHALL forward pointer and keyboard events on the card to the spec-01 message bus.
2. WHILE Edit Background mode (`Cmd+B` / `Ctrl+B`) is active, THE SYSTEM SHALL draw diagonal hash stripes along the menu bar border.
3. WHEN the user drags the Tools menu below the menu bar, THE SYSTEM SHALL detach it as a draggable floating palette with the 12 tools of design spec §2.1 and an 8x8 pattern selector.
4. THE SYSTEM SHALL offer the four themes `ClassicPaper`, `AmberCRT`, `GreenPhosphor`, `MidnightHex` with the colours of `THEME_PALETTES` (design spec §2.1).
5. WHILE an unlocked field is edited in Browse mode, THE SYSTEM SHALL route text input through the hidden textarea defined in spec 03 Requirement 4.2 and write changes with `store.applyRuntime`.
6. THE SYSTEM SHALL give UI components a store view without `applyAuthoring` and `replaceStack`, so authoring changes can only go through the history and loading only through the loader.
7. WHEN the studio or the exported player starts, THE SYSTEM SHALL await `loadBundledFonts()` before composing the first frame.
8. WHILE a paint tool is active, THE SYSTEM SHALL route pointer events on the card to the spec 03 paint controller, created with the store and history.
9. WHEN a checkBox with autoHilite = true is clicked in Browse mode, THE SYSTEM SHALL toggle its hilite; WHEN a radioButton with autoHilite = true is clicked, THE SYSTEM SHALL set its hilite to true and set hilite to false on every other radioButton with the same family on the same layer of the current card. Both changes SHALL be applied with store.applyRuntime before mouseUp is delivered.
10. THE SYSTEM SHALL draw the whole studio UI — menu bar, menus, dialogs, tools palette and card — at the same integer scale factor k computed by computeIntegerScale for the available viewport (menu bar height included).

### Requirement 3: Object Inspector, Script Editor & Error Dialogs
**User Story:** As a stack author, I want to edit properties and scripts with immediate feedback, and see clear errors when scripts fail.

#### Acceptance Criteria
1. WHEN the user double-clicks a part with an authoring tool, THE SYSTEM SHALL open the Object Inspector with tabs `Properties`, `HexTalk Script`, `HexAI Spellcaster`.
2. WHEN the user saves HexTalk in the script editor, THE SYSTEM SHALL store it as `scriptSource` through `history.execute`, recompile it, and show compile errors inline at their line and column without affecting the running stack.
3. WHEN the VM raises `HexVmGasLimitError`, THE SYSTEM SHALL show the System 7 bomb dialog "Sorry, a script error occurred: Loop exceeded 10,000 steps" with object, handler and line.
4. WHEN the VM raises `HexScriptError`, THE SYSTEM SHALL show a System 7 alert with object, handler, line and message, and a **Script** button that opens the editor at that line.
5. WHEN the user opens the Stack Graph, THE SYSTEM SHALL show every card as a node with a 1-bit thumbnail and an arrow for every `GoToCard` with a statically known target.

### Requirement 4: Zero-Config HexAI Spellcaster
**User Story:** As a hackathon judge or user without an API key, I want natural language turned into working scripts immediately, and I want to see the result before it is applied.

#### Acceptance Criteria
1. WHEN no proxy URL and no session API key are configured, THE SYSTEM SHALL compile prompts with the local Tier 1 compiler and the 24 Grimoire presets, with no network call.
2. WHEN any tier returns a result, THE SYSTEM SHALL run the acceptance pipeline of design spec §4.4: AST validation, printing, re-parsing, deep-equal check, preview; and SHALL change `scriptSource` only after the user clicks Apply.
3. IF the Tier 1 compiler cannot map a prompt to an AST, THEN THE SYSTEM SHALL say so and suggest the closest Grimoire presets instead of producing a guess.
4. WHERE a BYOK API key is entered, THE SYSTEM SHALL keep it in memory only for the current session and SHALL NOT write it to any storage, URL, export or log.
5. IF the Tier 2 proxy is unreachable, THEN THE SYSTEM SHALL fall back to Tier 1 and tell the user.
6. THE SYSTEM SHALL ship a test corpus of at least 60 free-form English prompts that are not Grimoire entries (paraphrases, different word order, synonyms, typos, multi-step requests) with expected AST outcomes; every corpus prompt SHALL have an expected outcome (a specific script or a refusal) and the Tier 1 compiler SHALL match 100% of them; at least 75% of corpus prompts SHALL expect a script.

### Requirement 5: Persistence & Sharing
**User Story:** As a user, I want my work saved automatically and shareable without a server.

#### Acceptance Criteria
1. WHEN the stack changes, THE SYSTEM SHALL auto-save it to IndexedDB (debounced 500 ms) without ASTs.
2. WHEN the user chooses `File -> Save Stack File` or `Open Stack File`, THE SYSTEM SHALL write or read a `.hexstack` file containing the stack JSON compressed with `deflate-raw` and encoded as Base64URL.
3. WHEN the user chooses `File -> Copy Share Link`, THE SYSTEM SHALL put the same compressed encoding in the URL hash; IF the link exceeds 32,000 characters, THEN THE SYSTEM SHALL warn and offer the `.hexstack` file instead.
4. WHEN a stack is opened from IndexedDB, a file or a URL hash, THE SYSTEM SHALL pass it through the spec-01 stack validator before loading.
5. WHEN any stack is loaded (IndexedDB, file, URL hash, preset), THE SYSTEM SHALL validate it, then decode every bitmap layer with `decodeBitmapRLE`; IF validation or any decode throws (including invalid Base64), THEN THE SYSTEM SHALL reject the whole stack with one "This stack is damaged" alert. On success it SHALL call `history.clear()` and `clearDecodedLayerCache()` before `store.replaceStack()`.

### Requirement 6: Standalone HTML Export
**User Story:** As a user, I want to export a stack as a single HTML file that runs anywhere without HexCard.

#### Acceptance Criteria
1. WHEN the user chooses `File -> Export Standalone HTML`, THE SYSTEM SHALL produce one `.html` file containing the browse-only player bundle and the stack JSON, with no external requests other than the stack's own `fetch` commands. The player bundle SHALL embed the bundled fonts as base64 `data:` URLs, so the exported file makes no font requests; only the player bundle does this, and the studio and the live site SHALL keep loading fonts from `<BASE_URL>fonts/`.
2. THE SYSTEM SHALL embed the stack JSON in a `<script type="application/json">` element with every `<` written as the six-character escape `\u003c`.
3. WHEN the exported file is opened, THE SYSTEM SHALL validate the embedded stack and run it in Browse mode only, without authoring tools or AI features.

### Requirement 7: Showcase Stacks
**User Story:** As a hackathon judge, I want rich example stacks available immediately.

#### Acceptance Criteria
1. WHEN HexCard starts for the first time, THE SYSTEM SHALL offer `File -> Open Showcase Stack` with `The Haunted Stack of 1987`, `HexSynth Sequencer` and `HexOracle 1987`.
2. THE SYSTEM SHALL author every showcase stack as HexTalk `scriptSource` with canonical `rleData`, and SHALL verify in tests that each passes the stack validator and compiles with zero errors.
3. WHEN `HexOracle 1987` cannot reach its API, THE SYSTEM SHALL show its bundled offline sample data.
4. WHEN HexCard starts with no auto-saved stack and no share link, THE SYSTEM SHALL open 'The Haunted Stack of 1987' instead of the starter stack.
5. THE SYSTEM SHALL offer File -> Open Showcase Stack as a chooser listing the three showcase stacks by name. (Spec 07 adds a fourth showcase stack, built in a Kiro chat with the HexCard Kiro power.)
6. WHEN the user chooses `File -> Open Showcase Stack`, `File -> Open Stack File` or any other File command that replaces the current stack, IF the current stack has authoring or runtime changes since it was loaded or last saved as a `.hexstack` file, THEN THE SYSTEM SHALL first ask "Save changes to a file first?" with the buttons `Save…`, `Don't Save` and `Cancel`: `Save…` SHALL save the stack as a `.hexstack` file and then open, `Don't Save` SHALL open without saving, and `Cancel` SHALL leave the current stack unchanged; without such changes THE SYSTEM SHALL open without asking.
