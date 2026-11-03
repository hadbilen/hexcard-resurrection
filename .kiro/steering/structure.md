---
inclusion: always
---

# Project Directory Structure & Module Boundaries

This is the canonical directory tree. Create files only where this tree says; if a new module is needed, update this file in the same change.

~~~text
hexcard/
├── .kiro/
│   ├── steering/              # Always-included guardrails (product.md, tech.md, structure.md)
│   ├── specs/                 # 01-core-stack-engine, 02-hextalk-ast-vm, 03-1bit-canvas-dither, 04-ui-audio-showcase
│   └── hooks/                 # Kiro agent hooks (IDE 1.0 JSON format)
├── public/
│   └── fonts/                 # Freely licensed bitmap fonts + LICENSES.md
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
│   │       └── synth.ts          # WebAudio Karplus-Strong & 8-bit sound engine + note parser             [04]
│   ├── ai/                                                                                                 [04]
│   │   ├── spellcaster.ts     # NL -> HexScriptAST (Tier 1 local, Tier 2 proxy, Tier 3 BYOK)
│   │   ├── grimoire.ts        # 24 curated prompt -> AST presets
│   │   └── stackGenerator.ts  # Multi-card stack generator from prompts
│   ├── storage/                                                                                            [04]
│   │   ├── indexedDb.ts       # Local auto-save
│   │   ├── stackFile.ts       # .hexstack file import/export (deflate-raw + Base64URL)
│   │   ├── urlCodec.ts        # URL-hash share links (deflate-raw + Base64URL)
│   │   └── htmlExporter.ts    # Single-file standalone HTML (embeds the player bundle)
│   ├── player/                                                                                             [04]
│   │   └── main.ts            # Browse-only runtime entry for exported HTML (no authoring, no AI)
│   ├── presets/               # 3 showcase stacks (Haunted Mansion, Synth, Weather Oracle)                [04]
│   └── ui/                    # React System 7 shell, tools palette, viewport, inspector, stack graph     [04]
├── vite.config.ts             # Studio build
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
