# Implementation Plan

- [ ] 1. Initialize project scaffolding and core 5-layer TypeScript schema
  - Initialize Vite + React + TypeScript configuration and retro System 7 pixel styling rules
  - Implement `src/core/schema.ts` with `HexStack`, `HexBackground`, `HexCard`, `HexButtonPart`, `HexFieldPart`, and RLE bitmap helpers
  - Implement `src/core/ast.ts` defining all deterministic `HexScriptAST`, `HexStatementNode`, and `HexExprNode` types
  - _Requirements: 1.1, 1.2, 1.3, 3.1_

- [ ] 2. Implement the sandboxed HexScriptAST Virtual Machine and Message Passing Bus
  - Implement `src/core/vm.ts` with a 10,000-step gas counter, `it` local variable binding, field container read/write (`sharedText` aware), and System 7 Bomb error reporting
  - Implement `src/core/messageBus.ts` enforcing `HexPart -> HexCard -> HexBackground -> HexStack` event bubbling and `pass` statement delegation
  - Implement `src/core/parser.ts` for bidirectional `HexTalk` script parsing and formatting
  - Implement `src/core/history.ts` providing a 50-step Command Pattern Undo/Redo ring buffer
  - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4_

- [ ] 3. Build the 1-Bit Graphics Engine (Compositor, Atkinson Dithering, LFSR Dissolve, 8x8 Patterns)
  - Implement `src/engine/graphics/patterns.ts` containing the 38 classic 8x8 Macintosh bit patterns and 4-way flood-fill algorithm
  - Implement `src/engine/graphics/atkinsonDither.ts` for converting imported images into 1-bit `512x342` bitmaps using Bill Atkinson's 6/8 error-diffusion matrix
  - Implement `src/engine/graphics/lfsrDissolve.ts` providing the 18-bit Galois LFSR (`0x20400`) pixel dissolve, Venetian blinds, checkerboard, and iris transitions
  - Implement `src/engine/graphics/bitmapCanvas.ts` for dual-layer (Background + Card) 1-bit rendering and authoring paint tools (Pencil, Brush, Line, Rect, Paint Bucket, Eraser)
  - _Requirements: 1.1, 1.4, 4.1, 4.2, 4.3_

- [ ] 4. Build the Procedural WebAudio Synthesizer
  - Implement `src/engine/audio/synth.ts` with Karplus-Strong `harpsichord` string synthesis, pitch-modulated `boing`, `flute`, `square8bit`, and UI `click` sounds
  - Add the tempo-synced musical note sequence parser (`c4q e4q g4h`) wired to the VM `PlaySound` instruction
  - _Requirements: 5.3_

- [ ] 5. Build the Macintosh System 7 GUI Shell and Immediate-Mode Authoring Studio
  - Implement `src/ui/System7Shell.tsx` with the classic menu bar, `Edit Background` hash-mark indicator, CRT palette switcher (`ClassicPaper`, `AmberCRT`, `GreenPhosphor`), and Bomb error modal
  - Implement `src/ui/FloatingTools.tsx` providing the tear-off 12-tool HyperCard palette (`browse`, `button`, `field`, and paint tools) and 8x8 pattern selector
  - Implement `src/ui/CardViewport.tsx` combining the `512x342` 1-bit canvas with interactive/draggable Button and Field parts
  - Implement `src/ui/ObjectInspector.tsx` and `src/ai/spellcaster.ts` enabling property editing, `HexTalk` code editing, and Natural Language to `HexScriptAST` compilation
  - Implement `src/ui/StackGraphModal.tsx` to visualize all cards and `GoToCard` links as an interactive node graph
  - _Requirements: 1.4, 5.1, 5.2_

- [ ] 6. Create the 3 Built-in Showcase Stacks and Export/Share Utilities
  - Implement `src/presets/hauntedMansion.ts` ("The Haunted Stack of 1987" 1-bit mystery adventure game with inventory and LFSR transitions)
  - Implement `src/presets/retroSynthDeck.ts` ("HexSynth & Sequencer" interactive harpsichord and 8-bit step sequencer deck)
  - Implement `src/presets/apiWeatherOracle.ts` ("MacOracle 1987" live data dashboard and AI micro-app conjurer)
  - Implement `src/storage/htmlExporter.ts` and ` indexedDb.ts` for local auto-save and single-file standalone HTML export
  - _Requirements: 1.1, 2.2, 4.2, 5.1, 5.2, 5.3_