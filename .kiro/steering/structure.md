---
inclusion: always
---

# Project Directory Structure & Module Boundaries

~~~text
hexcard/
├── .kiro/
│   ├── steering/              # Architectural guardrails (product.md, tech.md, structure.md)
│   ├── specs/                 # EARS-formatted specifications (requirements.md, design.md, tasks.md)
│   └── hooks/                 # Automated Kiro Agent Hooks
├── src/
│   ├── core/
│   │   ├── schema.ts          # HexStack, HexBackground, HexCard, HexPart data structures
│   │   ├── ast.ts             # HexScriptAST node definitions
│   │   ├── vm.ts              # Gas-limited (10,000 steps) sandboxed AST interpreter
│   │   ├── parser.ts          # Bidirectional HexTalk <-> HexScriptAST parser/printer
│   │   ├── messageBus.ts      # Part -> Card -> Background -> Stack event bubbling engine
│   │   └── history.ts         # 50-step Undo/Redo Command Pattern ring buffer
│   ├── engine/
│   │   ├── graphics/
│   │   │   ├── bitmapCanvas.ts   # Dual-layer (Background + Card) 512x342 1-bit compositor
│   │   │   ├── atkinsonDither.ts # Bill Atkinson 6/8 error-diffusion dithering
│   │   │   ├── patterns.ts       # 38 classic 8x8 bitmasks and 4-way flood-fill
│   │   │   └── lfsrDissolve.ts   # 18-bit Galois LFSR dissolve and classic visual effects
│   │   └── audio/
│   │       └── synth.ts          # WebAudio procedural Karplus-Strong & 8-bit sound engine
│   ├── ai/
│   │   ├── spellcaster.ts     # Natural Language -> HexScriptAST + HexTalk compiler
│   │   └── stackGenerator.ts  # Full multi-card stack generator from user prompts
│   ├── presets/               # 3 built-in showcase stacks (Haunted Mansion, Synth, Weather Oracle)
│   └── ui/                    # System 7 GUI Shell, Tear-off Floating Tools, Object Inspector
└── hexcard_design_spec.md     # Master reference specification
~~~

## Architectural Rules
- `src/core/` and `src/engine/` MUST remain pure TypeScript modules with zero React dependencies so they can be unit-tested independently.
- All UI components in `src/ui/` interact with the stack state exclusively through the message bus (`src/core/messageBus.ts`) and command history manager (`src/core/history.ts`).
- Every state mutation triggered in Authoring Mode (moving parts, painting pixels, editing scripts) MUST be wrapped in a reversible Command object and pushed to the 50-step ring buffer.
- Preset showcase stacks in `src/presets/` MUST conform strictly to the `HexStack` JSON schema (`schemaVersion: "2.0.0"`).