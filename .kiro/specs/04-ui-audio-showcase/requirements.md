# Requirements: System 7 GUI, WebAudio Synth, Zero-Config Spellcaster & Showcase Stacks

## REQ-1: Procedural WebAudio Synthesizer
- **User Story:** As a stack author, I want scripts to play authentic 1987 Macintosh instruments (`harpsichord`, `boing`, `flute`, `square8bit`, `click`) using note notation without external audio files.
- **Acceptance Criteria (EARS):**
  1. WHEN a `PlaySound` AST node is evaluated, THE SYSTEM SHALL synthesize the requested voice procedurally via WebAudio `AudioContext` (using Karplus-Strong delay-line synthesis for `harpsichord`).
  2. WHEN parsing a note sequence string (e.g., `"c4q e4q g4h c5w"`), THE SYSTEM SHALL schedule pitch frequencies and note durations (`w`, `h`, `q`, `e`, `s`, and dotted `.`) according to the specified `tempo` BPM.

## REQ-2: System 7 Dual-Mode Authoring Shell & Tear-Off Palette
- **User Story:** As a creator, I want to switch seamlessly between Browse mode and Authoring/Background modes using authentic Macintosh System 7 menus and a tear-off 12-tool palette.
- **Acceptance Criteria (EARS):**
  1. WHEN the user selects the `browse` (Hand) tool, THE SYSTEM SHALL dispatch mouse and keyboard interactions directly to the Message Passing Engine (`HexPart -> HexCard -> HexBackground -> HexStack`).
  2. WHILE `Edit Background` mode (`Cmd+B`) is active, THE SYSTEM SHALL render diagonal hash stripes along the menu bar border and route all drawing and part creation operations to the active `HexBackground` layer.
  3. WHEN the user drags the `Tools` menu below the menu bar threshold, THE SYSTEM SHALL detach and render `FloatingTools` as a draggable floating window.

## REQ-3: Zero-Config HexAI Spellcaster & Object Inspector
- **User Story:** As a hackathon judge or user without an API key, I want to compile natural language prompts into working `HexScriptAST` and `HexTalk` code immediately.
- **Acceptance Criteria (EARS):**
  1. WHEN a user enters a natural language prompt or selects a Grimoire preset in `ObjectInspector`, THE SYSTEM SHALL compile it into both deterministic `HexScriptAST` and formatted `HexTalk` source code using the local semantic compiler if no external API key is configured.
  2. WHEN a user manually edits `HexTalk` code in the script editor and saves, THE SYSTEM SHALL parse the updated source into `HexScriptAST` and highlight syntax errors inline without crashing the runtime.

## REQ-4: Three Pre-Built Jury Showcase Stacks & Single-File HTML Export
- **User Story:** As a hackathon judge evaluating HexCard, I want immediate access to rich interactive showcase stacks and single-file HTML export.
- **Acceptance Criteria (EARS):**
  1. WHEN HexCard launches for the first time, THE SYSTEM SHALL provide instant switcher access in the `File -> Open Showcase Stack` menu to three complete stacks: `The Haunted Stack of 1987` (adventure game), `HexSynth Sequencer` (musical deck), and `MacOracle 1987` (live weather/data dashboard).
  2. WHEN the user triggers `File -> Export Standalone HTML`, THE SYSTEM SHALL bundle the serialized `HexStack` JSON and player runtime into a self-contained `.html` download.