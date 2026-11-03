# Technical Design Document: 1-Bit Canvas, Codec, Text & Transitions

## 1. Scope & Shared Contracts
Modules in `src/engine/graphics/`: `rleCodec.ts`, `bitmapCanvas.ts`, `partRenderer.ts`, `textRaster.ts`, `paintTools.ts`, `atkinsonDither.ts`, `patterns.ts`, `transitions.ts`, `lfsrDissolve.ts`. Pure TypeScript; the only browser APIs used are `OffscreenCanvas`/`CanvasRenderingContext2D` (text rasterization) and `ImageData`, both behind small adapters so the rest is Node-testable.

Canonical contracts: `hexcard_design_spec.md` §5.1 (dithering code), §5.2 (dissolve code), §5.3 (pattern bit formula), §5.4 (codec, reference implementation), §5.5 (text & fonts), §5.6 (composition order).

## 2. Composition (`bitmapCanvas.ts`)

~~~typescript
export function composeFrame(
  stack: HexStack, cardId: HexID, opts: { editing?: { partId: HexID; caret: number; selEnd: number }; pressedPartId?: HexID }
): Uint8Array;                                  // 175,104 states, only 1 or 2

export function frameToImageData(frame: Uint8Array, palette: { darkBitHex: string; lightBitHex: string }, out: Uint32Array): void;
~~~

- Decoded layers are cached per `(layerOwnerId, rleData)` so that unchanged bitmaps are not re-decoded on every frame.
- Integer scale factor `k = max(1, floor(min(availableWidth / 512, availableHeight / 342)))`; the canvas CSS size is `512k x 342k`.

## 3. Part Rendering (`partRenderer.ts`)
- One draw function per `ButtonStyle` and `FieldStyle`, drawing into the frame with 1-px lines; `roundRect` uses a fixed 1-bit corner mask; `shadow` adds a solid 1/2-px offset; `default` draws the double border.
- `scrolling` fields draw a 1-bit scrollbar and keep a per-field scroll offset in UI state (not persisted).
- `hitTest(stack, cardId, x, y) -> HexPart | null` (Requirement 3.3).

## 4. Text (`textRaster.ts`)
- `renderCrisp1BitText(text, font, size, style, rect, align, wrap) -> { mask: Uint8Array; lineBoxes }` draws with `fillText` at integer coordinates on an `OffscreenCanvas`, then thresholds alpha `>= 128`.
- Word wrapping is done in TypeScript with `measureText`, so line breaks are identical across browsers that load the same font.
- `textStyle` support: bold/italic come from the bitmap font's variants when available; `underline`, `outline`, `shadow`, `condense` are pixel operations on the mask.
- Font loading uses `FontFace` with files from `public/fonts/`; rendering waits for `document.fonts.ready` before the first frame.

## 5. Transitions (`transitions.ts`, `lfsrDissolve.ts`)
- `playEffect(effect, speed, from: Uint32Array, to: Uint32Array, present: (buf) => void): Promise<void>` drives frames with `requestAnimationFrame` and resolves when the destination frame is fully shown. It rejects on abort (spec 01 Requirement 3.7) after presenting the destination frame.
- `dissolve` uses the §5.2 reference code. Wipes, iris, barn door, venetian blinds and checkerboard copy rectangles/rows/8x8 cells from `to` into the displayed buffer over a fixed number of frames per speed (`verySlow` 48, `slow` 24, `normal` 12, `fast` 6).

## 6. Paint Tools (`paintTools.ts`, `patterns.ts`)
- Tools operate on a decoded working copy of the target layer and track the stroke's bounding rectangle; on pointer-up they emit `PaintStrokeCommand` (spec 01).
- Line: Bresenham. Spray: seeded random dots within a radius. Bucket: scanline 4-way flood fill on the *composed* colour, writing the pattern into the target layer.
- The 38 patterns are defined as `Uint8Array(8)` constants in `patterns.ts`.

## 7. Testing
- Codec: the reference tests (round trip for blank/solid/checkerboard/dithered/random/fuzz, corruption cases, `""` fill rules) plus fast-check round trip.
- Composition: layer-order cases (card pixel over background button), background `0` handling, palette mapping.
- Dissolve: every index `0..175,103` copied exactly once.
- Atkinson: known 4x4 input against a hand-computed expected output.
- Text: threshold produces only `0`/`2`; wrapping is deterministic for a fixed font metric stub.
