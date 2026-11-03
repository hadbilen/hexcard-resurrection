# Tasks: System 7 GUI, WebAudio Synth, Spellcaster & Showcase Presets

- [ ] 1. Implement `src/engine/graphics/rleCodec.ts` with `encodeBitmapRLE`, `decodeBitmapRLE`, and `renderCrisp1BitText` unit tests.
- [ ] 2. Implement `src/engine/audio/synth.ts` featuring Karplus-Strong `harpsichord`, `boing`, `flute`, `square8bit`, `click`, and the tempo-aware note sequence parser.
- [ ] 3. Implement `src/ai/spellcaster.ts` with Tier 1 Local Semantic NL-to-AST compiler, 24 Grimoire presets, and optional BYOK/Proxy adapter.
- [ ] 4. Build `src/ui/System7Shell.tsx`, `src/ui/FloatingTools.tsx`, and strict 1-bit System 7 CSS stylesheet (`ClassicPaper`, `AmberCRT`, `GreenPhosphor`, `MidnightHex`).
- [ ] 5. Build `src/ui/CardViewport.tsx` integrating dual-layer bitmap rendering, `sharedText` field binding, and Browse vs. Authoring tool interactions.
- [ ] 6. Build `src/ui/ObjectInspector.tsx` and `src/ui/StackGraphModal.tsx` with live HexTalk/AST synchronization and visual card link graph.
- [ ] 7. Implement `src/storage/indexedDb.ts`, `src/storage/urlCodec.ts`, and `src/storage/htmlExporter.ts`.
- [ ] 8. Create the three jury showcase stacks (`src/presets/hauntedMansion.ts`, `src/presets/retroSynthDeck.ts`, `src/presets/apiWeatherOracle.ts`) using canonical RLE bitmaps and verified AST scripts.