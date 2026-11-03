# Design: System 7 GUI, WebAudio Synth, Spellcaster & Presets

## 1. Component Architecture
- **`src/engine/audio/synth.ts`**: Singleton `HexAudioSynth` managing a shared `AudioContext`. Implements a Karplus-Strong plucked-string worklet/buffer generator (`harpsichord`), pitch-swept sine LFO (`boing`), ADSR triangle wave (`flute`), PWM square wave (`square8bit`), and 2ms impulse (`click`).
- **`src/ai/spellcaster.ts`**: Exports `conjureScript(prompt: string, context: SpellContext): Promise<{ ast: HexScriptAST; hexTalk: string }>`. Implements Tier 1 deterministic regex/intent AST synthesis + 24 Grimoire templates, with optional Tier 2/3 LLM JSON-schema completion.
- **`src/ui/` Modules**:
  - `System7Shell.tsx`: Top menu bar, active stack state, Background Mode striped border indicator, CRT/Classic palette CSS variables (`--dark-bit`, `--light-bit`), and modal manager.
  - `FloatingTools.tsx`: Tear-off 2x6 grid of 1-bit SVG tool icons (`browse`, `button`, `field`, `select`, `lasso`, `pencil`, `brush`, `eraser`, `line`, `spray`, `rect`, `paintBucket`) plus 8x8 pattern selector.
  - `CardViewport.tsx`: Dual-buffer `<canvas width={512} height={342}>` compositing `HexBackground.bitmap` + `HexCard.bitmap`, overlaid with interactive/resizable `HexPart` DOM/canvas representations.
  - `ObjectInspector.tsx`: Tabbed System 7 modal (`Properties`, `HexTalk Script`, `HexAI Spellcaster`).
  - `StackGraphModal.tsx`: Interactive node-link topology view computing `GoToCard` edges across `HexCard[]`.
- **`src/presets/` Showcase Stacks**:
  - `hauntedMansion.ts`: 5-card interactive 1-bit mystery featuring locked doors, inventory state stored in background fields (`sharedText: false`), Galois LFSR `dissolve` transitions, and eerie harpsichord motifs.
  - `retroSynthDeck.ts`: Interactive multi-voice step sequencer and keyboard card triggering `PlaySound` AST handlers.
  - `apiWeatherOracle.ts`: Retro desktop utility demonstrating `FetchJson` AST nodes with offline fallback data and dynamic field rendering.