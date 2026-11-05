---
inclusion: always
---

# Project Directory Structure & Module Boundaries

This is the canonical directory tree. Create files only where this tree says; if a new module is needed, update this file in the same change.

~~~text
hexcard/
├── .github/
│   └── workflows/
│       └── deploy.yml         # GitHub Pages: npm ci, typecheck, test, build (BASE_PATH=/hexcard-resurrection/), deploy dist/
├── .kiro/
│   ├── steering/              # Always-included guardrails (product.md, tech.md, structure.md)
│   ├── specs/                 # 01-core-stack-engine, 02-hextalk-ast-vm, 03-1bit-canvas-dither, 04-ui-audio-showcase
│   │                          # Bugfix specs from Kiro's bugfix workflow also live here, next to 01-04 (currently partrenderer-test-timeouts)
│   └── hooks/                 # Kiro agent hooks (IDE 1.0 JSON format)
├── public/
│   ├── favicon.svg            # 16x16 1-bit pixel-art favicon (linked from index.html)
│   └── fonts/                 # Freely licensed bitmap fonts + LICENSES.md
├── scripts/                   # Committed build-time scripts, not shipped in any bundle                   [04]
│   └── buildPresetArt.ts      # Draws preset art with the spec 03 engine and writes canonical rleData
├── src/
│   ├── core/                  # Pure TypeScript, no React, no DOM          [spec 01 + 02]
│   │   ├── schema.ts          # Persisted types: HexStack, HexBackground, HexCard, HexPart, THEME_PALETTES   [01]
│   │   ├── stackValidator.ts  # Zod schema for persisted stacks (import/load gate)                         [01]
│   │   ├── store.ts           # Observable stack store: history.execute() + applyRuntime() + ScriptCache   [01]
│   │   ├── history.ts         # 50-step Undo/Redo Command Pattern ring buffer                               [01]
│   │   ├── messageBus.ts      # Message path, FIFO queue, idle timer, nested dispatch (design spec §3.2)  [01]
│   │   ├── ast.ts             # HexScriptAST node types (design spec §4.2)                                  [02]
│   │   ├── astValidator.ts    # Zod schema for ASTs (AI acceptance gate)                                    [02]
│   │   ├── parser.ts          # parseHexTalk + printHexTalk (design spec §4.1)                              [02]
│   │   ├── vm.ts              # Gas-limited async interpreter (design spec §4.3)                            [02]
│   │   ├── fetchPolicy.ts     # Sandboxed fetch + JSON path (design spec §4.3)                              [02]
│   │   └── __tests__/         # Vitest + fast-check tests for core
│   ├── engine/                # Pure TypeScript, no React                  [spec 03 + 04]
│   │   ├── graphics/                                                                                       [03]
│   │   │   ├── rleCodec.ts       # 2-bit packing + PackBits bitmap codec (design spec §5.4)
│   │   │   ├── bitmapCanvas.ts   # Frame compositor (design spec §5.6)
│   │   │   ├── partRenderer.ts   # Rasterizes buttons/fields into the frame; geometric hit testing
│   │   │   ├── textRaster.ts     # renderCrisp1BitText + font mapping (design spec §5.5)
│   │   │   ├── paintTools.ts     # Pencil, brush, eraser, line, rect, spray, bucket, select, lasso
│   │   │   ├── atkinsonDither.ts # Bill Atkinson 6/8 error-diffusion dithering
│   │   │   ├── patterns.ts       # 38 classic 8x8 bitmasks and 4-way flood fill
│   │   │   ├── transitions.ts    # Visual effects on two composed frames (wipes, iris, blinds, ...)
│   │   │   ├── lfsrDissolve.ts   # 18-bit Galois LFSR dissolve
│   │   │   └── __tests__/
│   │   └── audio/
│   │       ├── synth.ts          # WebAudio Karplus-Strong & 8-bit sound engine + note parser             [04]
│   │       └── __tests__/
│   ├── ai/                                                                                                 [04]
│   │   ├── spellcaster.ts     # NL -> HexScriptAST (Tier 1 local, Tier 2 proxy, Tier 3 BYOK)
│   │   ├── grimoire.ts        # 24 curated prompt -> AST presets
│   │   ├── stackGenerator.ts  # Multi-card stack generator from prompts
│   │   └── __tests__/
│   ├── storage/                                                                                            [04]
│   │   ├── indexedDb.ts       # Local auto-save
│   │   ├── stackFile.ts       # .hexstack file import/export (deflate-raw + Base64URL)
│   │   ├── urlCodec.ts        # URL-hash share links (deflate-raw + Base64URL)
│   │   ├── stackLoader.ts     # The one load path: validateStack + decode every layer, then replaceStack
│   │   ├── htmlExporter.ts    # Single-file standalone HTML (embeds the player bundle)
│   │   └── __tests__/
│   ├── player/                                                                                             [04]
│   │   └── main.ts            # Browse-only runtime entry for exported HTML (no authoring, no AI)
│   ├── presets/               # 3 showcase stacks (Haunted Mansion, Synth, Weather Oracle)                [04]
│   │   ├── hauntedMansion.ts  # "The Haunted Stack of 1987"
│   │   ├── retroSynthDeck.ts  # "HexSynth Sequencer"
│   │   ├── apiWeatherOracle.ts # "HexOracle 1987" (fetch + bundled offline samples)
│   │   ├── index.ts           # SHOWCASE_STACKS catalog (File > Open Showcase Stack, first launch)
│   │   ├── presetKit.ts       # Part/card/stack builders with schema defaults
│   │   ├── presetArt.ts       # GENERATED by scripts/buildPresetArt.ts: canonical rleData, never hand-edited
│   │   └── __tests__/
│   ├── ui/                    # React System 7 shell, tools palette, viewport, inspector, stack graph     [04]
│   │   ├── ShowcaseChooser.tsx # File > Open Showcase Stack chooser window
│   │   └── __tests__/
│   └── main.tsx               # Studio entry: mounts ui/App.tsx into index.html's #root                   [04]
├── index.html                 # Studio HTML entry (Vite)
├── package.json               # Scripts: dev, build, typecheck, test (vitest --run)
├── tsconfig.json              # Project references: tsconfig.app.json (src, strict) + tsconfig.node.json (vite config, scripts/)
├── vite.config.ts             # Studio build (base from BASE_PATH, default "/") + Vitest config (Node environment)
├── vite.player.config.ts      # Player build (single IIFE, imported by htmlExporter via ?raw)
├── LICENSE                    # MIT (required: OSI open-source licence file in the repo)
└── hexcard_design_spec.md     # Master reference specification (canonical shared contracts)
~~~

## Architectural Rules
- `src/core/` and `src/engine/` MUST remain pure TypeScript modules with zero React dependencies so they can be unit-tested in Node.
- The stack object is owned by `src/core/store.ts`. Nothing else mutates it. There are exactly two write paths:
  1. `history.execute(command)` for **authoring mutations** (moving or resizing parts, painting, editing properties or scripts). Every such change is a reversible Command in the 50-step ring buffer. A paint stroke is one command (it stores the before/after pixels of the affected rectangle), not one command per pixel.
  2. `store.applyRuntime(mutation)` for **runtime mutations** (VM writes, typing into an unlocked field in Browse mode). These are auto-saved and are not undoable.
- UI components read state through `useSyncExternalStore(store.subscribe, store.getSnapshot)` and send user events to `messageBus.ts`; they never write to the stack object directly.
- Persisted data never contains ASTs; `store.ts` keeps them in the `ScriptCache` and recompiles on load or on script edits.
- Preset showcase stacks in `src/presets/` MUST conform strictly to the `HexStack` schema (`schemaVersion: "2.0.0"`) and pass `stackValidator.ts`.
- Each module belongs to exactly one spec (bracketed numbers above); a task for a module appears only in that spec's `tasks.md`.
