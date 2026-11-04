# Implementation Plan: System 7 UI, WebAudio Synth, Spellcaster, Storage & Showcase Stacks

- [x] 1. Implement the WebAudio synthesizer
  - `src/engine/audio/synth.ts` with the five voices, note parser (including rests and dotted notes) and autoplay unlock
  - _Requirements: 1.1, 1.2, 1.3_

- [x] 2. Build the System 7 shell and tools palette
  - `System7Shell.tsx` menus, Edit Background stripes, four themes, modal manager
  - `FloatingTools.tsx` tear-off palette with 12 tools and pattern selector
  - _Requirements: 2.2, 2.3, 2.4, 2.10_

- [x] 3. Build the card viewport and VM host
  - `CardViewport.tsx` canvas presentation, pointer mapping, Browse event forwarding, hidden-textarea editing, selection handles
  - `src/ui/vmHost.ts` implementing the spec-02 `HexHost`
  - `src/main.tsx` is the composition root: it creates the store with a built-in starter stack (one background, one card with a "Welcome to HexCard" field and one button), the history, the message bus, the VM host and the paint controller, and passes the narrowed store view to the UI. The starter stack must pass `validateStack`. The loader (task 6) and the showcase stacks (task 8) later replace the starter stack through `store.replaceStack`
  - _Requirements: 2.1, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10_

- [x] 4. Build the Object Inspector, error dialogs and Stack Graph
  - `ObjectInspector.tsx` with inline compile errors; bomb dialog and script-error alert with **Script** button
  - `StackGraphModal.tsx`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 5. Implement the Spellcaster

  - [ ] 5.1 Tier 1 local compiler, 24-entry Grimoire, acceptance pipeline and the Spellcaster tab preview/Apply flow
    - _Requirements: 4.1, 4.2, 4.3, 4.6_

  - [ ] 5.2 Optional Tier 2 proxy adapter and Tier 3 in-memory BYOK
    - _Requirements: 4.4, 4.5_

- [x] 6. Implement persistence and sharing
  - `indexedDb.ts` auto-save, `stackFile.ts`, `urlCodec.ts` with the 32,000-character warning, validation on every load
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [ ] 7. Implement the player build and standalone HTML export
  - `src/player/main.ts`, `vite.player.config.ts`, build-order script, `htmlExporter.ts` with `<` escaping
  - _Requirements: 2.7, 6.1, 6.2, 6.3_

- [x] 8. Create the three showcase stacks
  - Author scripts in HexTalk; generate canonical rleData with scripts/buildPresetArt.ts (or draw/import in HexCard); offline data for HexOracle
  - Open 'The Haunted Stack of 1987' on first launch (7.4) and add the File -> Open Showcase Stack chooser (7.5)
  - Tests: every preset validates and compiles with zero errors
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_
