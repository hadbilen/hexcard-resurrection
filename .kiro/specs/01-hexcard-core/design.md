# Technical Design Document: HexCard Core Architecture

## 1. Architectural Overview

HexCard separates pure runtime/graphics logic (`src/core/`, `src/engine/`) from the Macintosh System 7 React shell (`src/ui/`). All state mutations in Authoring Mode pass through a reversible 50-step Command Ring Buffer (`src/core/history.ts`).

~~~text
+-----------------------------------------------------------------------+
|                        System 7 GUI Shell (React)                     |
|  MenuBar | TearOffToolsPalette | CardViewport | ObjectInspector + AI  |
+-----------------------------------+-----------------------------------+
                                    |
                                    v
+-----------------------------------------------------------------------+
|                     Core Runtime & Message Bus (TS)                   |
|   MessagePath (Part -> Card -> Bg -> Stack)  <-->  HexAST Sandbox VM  |
|   Command History (50-step Undo/Redo)        <-->  HexTalk Parser     |
+-----------------+-----------------------------------+-----------------+
                  |                                   |
                  v                                   v
+-----------------------------------+   +-------------------------------+
|    1-Bit Graphics Engine (Canvas) |   |  Procedural WebAudio Engine   |
|  - 512x342 Bg + Card Compositor   |   |  - Karplus-Strong Harpsichord |
|  - Bill Atkinson 6/8 Dithering    |   |  - Pitch-Envelope Boing       |
|  - 18-Bit Galois LFSR Dissolve    |   |  - 8-Bit Square/Flute ADSR    |
|  - 38 Classic 8x8 Bit Patterns    |   +-------------------------------+
+-----------------------------------+
~~~

## 2. Core Data Schema (`src/core/schema.ts`)

- **`HexStack`**: Root container holding `dimensions` (`512x342`), `themePalette` (`ClassicPaper`, `AmberCRT`, `GreenPhosphor`), `backgrounds: HexBackground[]`, `cards: HexCard[]`, and stack-level `compiledAst`.
- **`HexBackground`**: Shared template holding a `512x342` 1-bit `bitmap`, shared `parts: HexPart[]`, and background-level `compiledAst`.
- **`HexCard`**: Individual card referencing `backgroundId`, its own transparent/masked 1-bit `bitmap` (`0`=Transparent, `1`=White/Opaque, `2`=Black/Opaque), `bgFieldContents: Record<HexID, string>` for `sharedText: false` background fields, card-specific `parts`, and card-level `compiledAst`.

## 3. Sandboxed VM & Message Bubbling (`src/core/vm.ts` & `src/core/messageBus.ts`)

1. **Event Dispatch**: `dispatchMessage(stack, activeCardId, targetPartId, eventName, payload)` resolves the target node chain: `[Part?, Card, Background, Stack]`.
2. **Execution Context**: Creates a scoped variable map initialized with `it = ""` and `stepCount = 0`.
3. **Gas Metering**: Every call to `evalStatement(node)` and `evalExpr(node)` increments `context.stepCount`. If `context.stepCount > 10000`, throws `HexVmGasLimitError`, caught by the UI shell to display the classic System 7 Bomb Modal.
4. **Pass Delegation**: If a handler executes `{ kind: "PassEvent" }`, the loop continues to the next parent layer in the hierarchy; otherwise propagation stops once handled.

## 4. Mathematical 1-Bit Graphics Pipeline (`src/engine/graphics/`)

### 4.1 Layer Compositing (`bitmapCanvas.ts`)
For each pixel index `i` in `0 .. (512 * 342 - 1)`:
- Start with `bgPixel = background.bitmap[i]` (`1` for White, `2` for Black).
- Read `cardPixel = card.bitmap[i]`.
- If `cardPixel !== 0` (not transparent), output `cardPixel`; else output `bgPixel`.
- Map `1 -> themePalette.lightBitHex` and `2 -> themePalette.darkBitHex` into a `Uint32Array` `ImageData` buffer.

### 4.2 18-Bit Galois LFSR Dissolve (`lfsrDissolve.ts`)
- Uses polynomial mask `0x20400` (`x^18 + x^11 + 1`), which cycles through `1 .. 262,143` without repetition.
- On each animation frame, steps the register until `pixelsPerFrame` (`~14,500` at normal speed) valid indices (`state < 175,104`) are copied from the target buffer to the active screen buffer.

### 4.3 Bill Atkinson Dithering (`atkinsonDither.ts`)
- Converts RGB to luminance `L = 0.299*R + 0.587*G + 0.114*B`.
- Quantizes to `0` or `255` at threshold `128`, takes `err = (old - new) / 8`, and adds `err` to `(x+1,y)`, `(x+2,y)`, `(x-1,y+1)`, `(x,y+1)`, `(x+1,y+1)`, and `(x,y+2)`.

## 5. Procedural WebAudio Synthesizer (`src/engine/audio/synth.ts`)
- **Harpsichord**: Generates a short noise burst into a feedback delay line of length `sampleRate / frequency` with a two-point averaging low-pass filter (Karplus-Strong plucked string algorithm).
- **Note Parser**: Parses strings like `"c4q e4q g4h c5w"` into scheduled `AudioContext` events according to the specified `tempo` BPM.