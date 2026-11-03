# Technical Design Document: System 7 UI, WebAudio Synth, Spellcaster, Storage & Showcase Stacks

## 1. Component Architecture
- **`src/ui/System7Shell.tsx`:** menu bar (`Hex`, `File`, `Edit`, `Go`, `Tools`, `Objects`, `Paint`, `AI Conjure`), Edit Background stripe indicator, theme switcher writing CSS variables `--dark-bit` / `--light-bit`, modal manager (alerts, bomb dialog, `answer`/`ask` dialogs used by the VM host).
- **`src/ui/FloatingTools.tsx`:** tear-off 2x6 grid of 1-bit SVG tool icons plus the pattern selector.
- **`src/ui/CardViewport.tsx`:** one `<canvas width=512 height=342>` showing frames from spec 03 `composeFrame`; pointer events converted to card coordinates and passed to `hitTest` / message bus; the hidden textarea for field editing; authoring selection handles.
- **`src/ui/ObjectInspector.tsx`:** tabbed modal (`Properties`, `HexTalk Script`, `HexAI Spellcaster`); the script editor shows parser errors inline.
- **`src/ui/StackGraphModal.tsx`:** node-link view; edges come from `GoToCard` nodes whose target is a literal (relative targets link to neighbours).
- All components read state with `useSyncExternalStore(store.subscribe, store.getSnapshot)` and never write to the stack object directly (structure.md rules).

## 2. VM Host Implementation (`src/ui/vmHost.ts`)
Implements the spec-02 `HexHost` interface: dialogs via the modal manager, `goToCard` via the store plus spec-03 `playEffect`, `playSound` via the synth, `fetchJson` via `src/core/fetchPolicy.ts`.

## 3. Synth (`src/engine/audio/synth.ts`)
- Singleton `HexAudioSynth` with one shared `AudioContext`, resumed on the first pointer/key event (browser autoplay policy).
- Voices: Karplus-Strong `harpsichord` (noise burst into a feedback delay of `sampleRate / f` with two-point averaging), pitch-swept sine with LFO `boing`, ADSR triangle `flute`, PWM square `square8bit`, 2 ms impulse `click`.
- Note grammar: `Note ::= ( Letter [ "#" | "b" ] [ Octave ] | "r" ) Duration [ "." ]`, `Letter ::= a..g`, `Octave ::= 1..7` (default: previous octave, initially 4), `Duration ::= w | h | q | e | s`. Notes are separated by spaces.

## 4. Spellcaster (`src/ai/spellcaster.ts`, `src/ai/grimoire.ts`)
~~~typescript
export async function conjureScript(prompt: string, context: SpellContext):
  Promise<{ ok: true; ast: HexScriptAST; hexTalk: string } | { ok: false; reason: string; suggestions: GrimoireEntry[] }>;
~~~
- Tier 1: tokenizer + intent/slot rules mapping to AST fragments; the 24 Grimoire entries are `{ prompt, ast }` pairs whose ASTs are validated in tests.
- Tier 2: `POST` to `VITE_HEXAI_PROXY_URL` expecting AST JSON. Tier 3: direct provider call with the in-memory key, asking for AST JSON only.
- Every tier's output goes through the acceptance pipeline (design spec §4.4) before the preview.

## 5. Storage (`src/storage/`)
- `indexedDb.ts`: one object store `stacks`, key = stack id, value = stack JSON (no ASTs); injected into the spec-01 store as the auto-save callback.
- `stackFile.ts` / `urlCodec.ts`: `JSON.stringify -> CompressionStream("deflate-raw") -> Base64URL` and the reverse, then `validateStack`.
- `htmlExporter.ts`: see §6.

## 6. Player Build & Standalone HTML Export
- `src/player/main.ts` is a browse-only entry: it reads the embedded stack, validates it, and mounts a minimal viewport using spec-01, spec-02 and spec-03 modules plus the synth. No authoring tools, no AI, no React shell.
- `vite.player.config.ts` builds it as one minified IIFE (`dist-player/player.js`). The npm `build` script runs the player build first, then the studio build.
- `htmlExporter.ts` imports the bundle as text (`import playerJs from "../../dist-player/player.js?raw"`) and writes:
~~~html
<!doctype html><html><head><meta charset="utf-8"><title>{escaped stack name}</title></head>
<body><script type="application/json" id="hexstack">{stack JSON with every "<" replaced by "<"}</script>
<script>{playerJs}</script></body></html>
~~~
- The stack name in `<title>` is HTML-escaped.

## 7. Showcase Stacks (`src/presets/`)
- `hauntedMansion.ts`: 5-card 1-bit mystery; inventory in background fields with `sharedText: false`; dissolve transitions; harpsichord motifs.
- `retroSynthDeck.ts`: keyboard card and 16-step sequencer driven by `PlaySound`.
- `apiWeatherOracle.ts`: `fetch` from a CORS-enabled, key-free weather API under the §4.3 policy, with bundled offline sample data on failure.
- Preset art is drawn or imported (Atkinson) inside HexCard itself and exported, so preset files only ever contain `rleData` produced by the spec-03 encoder.
