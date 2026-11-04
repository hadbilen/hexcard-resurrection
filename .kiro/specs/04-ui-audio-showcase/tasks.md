# Implementation Plan: System 7 UI, WebAudio Synth, Spellcaster, Storage & Showcase Stacks

- [ ] 1. Implement the WebAudio synthesizer
  - `src/engine/audio/synth.ts` with the five voices, note parser (including rests and dotted notes) and autoplay unlock
  - _Requirements: 1.1, 1.2, 1.3_

- [ ] 2. Build the System 7 shell and tools palette
  - `System7Shell.tsx` menus, Edit Background stripes, four themes, modal manager
  - `FloatingTools.tsx` tear-off palette with 12 tools and pattern selector
  - _Requirements: 2.2, 2.3, 2.4_

- [ ] 3. Build the card viewport and VM host
  - `CardViewport.tsx` canvas presentation, pointer mapping, Browse event forwarding, hidden-textarea editing, selection handles
  - `src/ui/vmHost.ts` implementing the spec-02 `HexHost`
  - `src/main.tsx` is the composition root: it creates the store with a built-in starter stack (one background, one card with a "Welcome to HexCard" field and one button), the history, the message bus, the VM host and the paint controller, and passes the narrowed store view to the UI. The starter stack must pass `validateStack`. The loader (task 6) and the showcase stacks (task 8) later replace the starter stack through `store.replaceStack`
  - _Requirements: 2.1, 2.5, 2.6, 2.7, 2.8_

- [ ] 4. Build the Object Inspector, error dialogs and Stack Graph
  - `ObjectInspector.tsx` with inline compile errors; bomb dialog and script-error alert with **Script** button
  - `StackGraphModal.tsx`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 5. Implement the Spellcaster
  - `grimoire.ts` (24 validated prompt/AST pairs) and Tier 1 compiler with closest-preset suggestions
  - Acceptance pipeline and preview/Apply flow; optional Tier 2 proxy and Tier 3 in-memory BYOK
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [ ] 6. Implement persistence and sharing
  - `indexedDb.ts` auto-save, `stackFile.ts`, `urlCodec.ts` with the 32,000-character warning, validation on every load
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 7. Implement the player build and standalone HTML export
  - `src/player/main.ts`, `vite.player.config.ts`, build-order script, `htmlExporter.ts` with `<` escaping
  - _Requirements: 2.7, 6.1, 6.2, 6.3_

- [ ] 8. Create the three showcase stacks
  - Author scripts in HexTalk; draw/import art in HexCard and export canonical `rleData`; offline data for MacOracle
  - Tests: every preset validates and compiles with zero errors
  - _Requirements: 7.1, 7.2, 7.3_
