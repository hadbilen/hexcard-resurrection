# Requirements Document: HexCard Core Engine & System 7 Studio

## Introduction
HexCard is a modern web resurrection of Apple's 1987 HyperCard built for Kiroween 2026. This specification defines the core 5-layer stack architecture, deterministic message-passing hierarchy, gas-limited `HexScriptAST` virtual machine, mathematical 1-bit graphics engine (Bill Atkinson dithering and Galois LFSR dissolve transitions), procedural WebAudio synthesizer, and immediate-mode System 7 authoring interface.

## Requirements

### Requirement 1: 5-Layer Stack Architecture & SharedText Semantics
**User Story:** As a stack author, I want cards to inherit shared graphics, parts, and scripts from a background template while retaining card-specific field data, so that I can build structured multi-card applications and adventure games without duplicating layouts.

#### Acceptance Criteria
1. WHEN a `HexCard` is rendered in the viewport, THE SYSTEM SHALL composite the linked `HexBackground` bitmap layer and background parts underneath the active `HexCard` bitmap layer and card parts.
2. WHERE a background `HexFieldPart` has `sharedText` set to `false`, WHEN a user or script reads or mutates the field content on a specific card, THE SYSTEM SHALL read from and write to `HexCard.bgFieldContents[fieldId]` without altering other cards sharing that background.
3. WHERE a background `HexFieldPart` has `sharedText` set to `true`, WHEN a user or script mutates the field content on any card, THE SYSTEM SHALL update `HexFieldPart.content` directly on the `HexBackground` so all cards sharing that background display the updated text immediately.
4. WHEN the user toggles `Edit Background` mode (`Cmd+B` or `Ctrl+B`), THE SYSTEM SHALL display diagonal hash marks in the menu bar and route all subsequent paint strokes and part creations directly to the active `HexBackground`.

### Requirement 2: Deterministic Message Passing Hierarchy
**User Story:** As a stack developer, I want UI and lifecycle events to bubble deterministically through the HyperCard object hierarchy, so that shared handlers can be defined at the card, background, or stack level.

#### Acceptance Criteria
1. WHEN an interaction event (`mouseUp`, `mouseDown`, `mouseEnter`, `mouseLeave`) occurs on an enabled `HexPart` while the active tool is `browse`, THE SYSTEM SHALL dispatch the event to the target `HexPart.compiledAst` handler first.
2. IF a target object does not define a handler for the dispatched event OR executes a `PassEvent` (`pass <eventName>`) statement, THEN THE SYSTEM SHALL propagate the event upward in the strict order: `HexPart -> HexCard -> HexBackground -> HexStack -> HexRuntimeBuiltIns`.
3. WHEN navigating between cards, THE SYSTEM SHALL dispatch `closeCard` on the departing card and `openCard` on the destination card; IF the destination card belongs to a different background, THE SYSTEM SHALL also dispatch `closeBackground` and `openBackground` in sequence.

### Requirement 3: Sandboxed & Step-Budgeted HexScriptAST Virtual Machine
**User Story:** As a platform user, I want all interactive scripts and AI-generated behaviors to execute inside a deterministic, gas-limited virtual machine without `eval()`, so that stacks are 100% immune to arbitrary code execution and infinite loop freezes.

#### Acceptance Criteria
1. WHEN executing any handler in `HexScriptAST`, THE SYSTEM SHALL interpret AST nodes strictly within the sandboxed TypeScript virtual machine (`src/core/vm.ts`) and SHALL NOT invoke `eval()`, `new Function()`, or dynamic script injection.
2. WHILE a handler chain is executing, THE SYSTEM SHALL increment an instruction step counter for every evaluated statement and expression node.
3. IF the instruction step counter exceeds `10,000` steps within a single event dispatch, THEN THE SYSTEM SHALL abort execution immediately, preserve the stack state, and display a System 7 bomb error dialog identifying the offending handler.
4. WHEN commands such as `ask`, `answer`, or `fetch` complete, THE SYSTEM SHALL store their result in the local `it` variable within the active handler scope.

### Requirement 4: Authentic 1-Bit Graphics, Atkinson Dithering & LFSR Transitions
**User Story:** As a retro computing enthusiast, I want authentic `512x342` 1-bit pixel rendering, Bill Atkinson image dithering, and Galois LFSR dissolve transitions, so that the visual experience is mathematically faithful to the 1987 Macintosh.

#### Acceptance Criteria
1. WHEN an external color or grayscale image is imported onto a card or background layer, THE SYSTEM SHALL scale the image to fit `512x342` and convert it to 1-bit pixels using Bill Atkinson's error-diffusion algorithm (propagating `6/8` of the quantization error to 6 neighboring pixels).
2. WHEN a script executes `visual effect dissolve` followed by `go to card`, THE SYSTEM SHALL transition between the source and destination `512x342` pixel buffers using an 18-bit maximal-period Galois LFSR (`0x20400` polynomial mask) rather than CSS opacity fading.
3. WHEN painting with the brush or paint bucket tool, THE SYSTEM SHALL apply the selected 8x8 Macintosh bit pattern aligned to world-space canvas coordinates (`x mod 8`, `y mod 8`).

### Requirement 5: Immediate-Mode Authoring, Procedural Audio & AI Spellcaster
**User Story:** As a creator, I want to switch seamlessly between live browsing and authoring tools, synthesize retro sound effects, and compile natural language prompts into working HexTalk/HexAST scripts.

#### Acceptance Criteria
1. WHEN the user selects the `browse` (Hand) tool from the tear-off tool palette, THE SYSTEM SHALL immediately enable live runtime interaction; WHEN the user selects `button`, `field`, or paint tools, THE SYSTEM SHALL immediately enable visual manipulation and inspection without a build step.
2. WHEN a user enters a natural language prompt in the `HexAI Spellcaster` inspector tab, THE SYSTEM SHALL compile the intent into both a valid `HexScriptAST` JSON structure and human-readable `HexTalk` source code.
3. WHEN a `PlaySound` AST node is executed, THE SYSTEM SHALL synthesize the requested voice (`harpsichord`, `boing`, `flute`, `square8bit`, `click`) and note sequence procedurally via the WebAudio API.