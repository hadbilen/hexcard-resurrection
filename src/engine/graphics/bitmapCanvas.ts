// Frame compositor. Canonical contract: hexcard_design_spec.md §5.6 and spec 03 design.md §2.
//
// Per frame, into one Uint8Array(175,104) of pixel states (only 1 = light or 2 = dark):
//   1. background bitmap ("" decodes to all-light; a stray 0 is treated as 1)
//   2. background parts in array order
//   3. card bitmap, wherever its pixel is not 0
//   4. card parts in array order
// `frameToImageData` then maps 1 -> lightBitHex and 2 -> darkBitHex into a Uint32Array view of an
// ImageData buffer, and `computeIntegerScale` gives the integer CSS scale factor of the canvas.
//
// Pure TypeScript: no DOM access, testable in Node.

import type { HexCard, HexID, HexPart, HexStack } from "../../core/schema.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS, decodeBitmapRLE } from "./rleCodec.ts";

export interface EditingState {
  partId: HexID;
  caret: number;
  selEnd: number;
}

export interface ComposeOptions {
  editing?: EditingState;
  pressedPartId?: HexID;
}

/** What a part rasterizer gets to know about the part it draws. */
export interface PartDrawContext {
  stack: HexStack;
  card: HexCard;
  /**
   * Fields: the text to show (§5.6 step 2: background fields with `sharedText: false` read
   * `card.bgFieldContents[part.id] ?? ""`, all other fields read `part.content`).
   * Buttons: `part.title` (whether it is drawn depends on `showName` and the style).
   */
  text: string;
  /** `opts.pressedPartId === part.id` */
  pressed: boolean;
  /** `opts.editing` when it refers to this part, otherwise undefined. */
  editing?: EditingState;
}

/** Draws one visible part into the frame (states 1/2 only). Implemented by partRenderer.ts. */
export type PartRasterizer = (frame: Uint8Array, part: HexPart, ctx: PartDrawContext) => void;

/** Placeholder until partRenderer.ts (spec 03 task 4) supplies the real rasterizer. */
const noPartRasterizer: PartRasterizer = () => {};

// ---------------------------------------------------------------------------------------------
// Decoded-layer cache
// ---------------------------------------------------------------------------------------------

type LayerKind = "card" | "background";

/**
 * One slot per (layer kind, owner id), holding the decoded pixels of the last rleData seen for that
 * owner. A slot is reused only when its rleData is identical, so a hit is always correct even if
 * two stacks share an id. Background entries are stored already normalised (0 -> 1).
 * Cached arrays are internal and never handed out or written to.
 */
const layerCache = new Map<string, { rleData: string; pixels: Uint8Array }>();

function decodedLayer(kind: LayerKind, ownerId: HexID, rleData: string): Uint8Array {
  const key = `${kind}:${ownerId}`;
  const hit = layerCache.get(key);
  if (hit && hit.rleData === rleData) return hit.pixels;

  const pixels = decodeBitmapRLE(rleData, kind === "background" ? 1 : 0);
  if (kind === "background") {
    for (let i = 0; i < pixels.length; i++) if (pixels[i] === 0) pixels[i] = 1;
  }
  layerCache.set(key, { rleData, pixels });
  return pixels;
}

/** Drops all decoded layers (e.g. when a different stack is loaded). */
export function clearDecodedLayerCache(): void {
  layerCache.clear();
}

/** Number of cached decoded layers (for tests and diagnostics). */
export function decodedLayerCacheSize(): number {
  return layerCache.size;
}

// ---------------------------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------------------------

/** §5.6 step 2 field text rule; buttons yield their title. */
function partText(part: HexPart, card: HexCard): string {
  if (part.type === "button") return part.title;
  if (part.layerScope === "background" && !part.sharedText) return card.bgFieldContents[part.id] ?? "";
  return part.content;
}

function drawParts(
  frame: Uint8Array,
  parts: readonly HexPart[],
  stack: HexStack,
  card: HexCard,
  opts: ComposeOptions,
  rasterize: PartRasterizer,
): void {
  for (const part of parts) {
    if (!part.visible) continue;
    rasterize(frame, part, {
      stack,
      card,
      text: partText(part, card),
      pressed: opts.pressedPartId === part.id,
      editing: opts.editing?.partId === part.id ? opts.editing : undefined,
    });
  }
}

/**
 * Composes the full 512x342 frame of `cardId` in §5.6 order. Returns a new buffer whose states
 * are only 1 (light) or 2 (dark). Throws if the card or its background does not exist, or if a
 * layer's rleData is corrupt.
 *
 * `rasterizePart` defaults to a no-op until partRenderer.ts exists; it is exposed so the part
 * steps of the layer order can be exercised independently of the renderer.
 */
export function composeFrame(
  stack: HexStack,
  cardId: HexID,
  opts: ComposeOptions = {},
  rasterizePart: PartRasterizer = noPartRasterizer,
): Uint8Array {
  const card = stack.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`composeFrame: card ${cardId} not found`);
  const background = stack.backgrounds.find((b) => b.id === card.backgroundId);
  if (!background) throw new Error(`composeFrame: background ${card.backgroundId} of card ${cardId} not found`);

  // 1. Background bitmap (already normalised to 1/2).
  const frame = decodedLayer("background", background.id, background.bitmap.rleData).slice();

  // 2. Background parts.
  drawParts(frame, background.parts, stack, card, opts, rasterizePart);

  // 3. Card bitmap, non-transparent pixels only.
  const cardPixels = decodedLayer("card", card.id, card.bitmap.rleData);
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const v = cardPixels[i];
    if (v !== 0) frame[i] = v;
  }

  // 4. Card parts.
  drawParts(frame, card.parts, stack, card, opts, rasterizePart);

  return frame;
}

// ---------------------------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------------------------

const HEX_COLOUR = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/;

// Scratch views used to pack RGBA bytes with the platform's native byte order.
const scratchBytes = new Uint8Array(4);
const scratchWord = new Uint32Array(scratchBytes.buffer);

/**
 * Packs an opaque "#RRGGBB" colour into the 32-bit word that, written into a Uint32Array view of
 * an ImageData buffer, yields the bytes R, G, B, 255 in memory (ImageData is RGBA byte order).
 * On little-endian platforms (all current browsers and Node targets) the word is 0xAABBGGRR,
 * e.g. "#FFB000" -> 0xFF00B0FF. The packing goes through a byte view, so it is also correct on
 * big-endian platforms (0xRRGGBBAA there).
 */
export function packOpaqueColour(hex: string): number {
  const m = HEX_COLOUR.exec(hex);
  if (!m) throw new Error(`Invalid colour ${JSON.stringify(hex)}: expected #RRGGBB`);
  scratchBytes[0] = parseInt(m[1], 16);
  scratchBytes[1] = parseInt(m[2], 16);
  scratchBytes[2] = parseInt(m[3], 16);
  scratchBytes[3] = 0xff;
  return scratchWord[0];
}

/**
 * Maps a composed frame to ImageData pixels: 1 -> lightBitHex, 2 -> darkBitHex.
 * `out` is a Uint32Array view of the ImageData buffer (`new Uint32Array(imageData.data.buffer)`).
 * Throws on a wrong buffer length or on a frame state other than 1 or 2.
 */
export function frameToImageData(
  frame: Uint8Array,
  palette: { darkBitHex: string; lightBitHex: string },
  out: Uint32Array,
): void {
  if (frame.length !== TOTAL_PIXELS) throw new Error(`frameToImageData: frame has ${frame.length} pixels, expected ${TOTAL_PIXELS}`);
  if (out.length !== TOTAL_PIXELS) throw new Error(`frameToImageData: output has ${out.length} pixels, expected ${TOTAL_PIXELS}`);
  const light = packOpaqueColour(palette.lightBitHex);
  const dark = packOpaqueColour(palette.darkBitHex);
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const v = frame[i];
    if (v === 1) out[i] = light;
    else if (v === 2) out[i] = dark;
    else throw new Error(`frameToImageData: invalid frame state ${v} at index ${i}`);
  }
}

/**
 * Integer CSS scale factor for the 512x342 canvas:
 * k = max(1, floor(min(availableWidth / 512, availableHeight / 342))).
 * The canvas CSS size is then 512k x 342k. Non-finite inputs yield 1.
 */
export function computeIntegerScale(availableWidth: number, availableHeight: number): number {
  const k = Math.floor(Math.min(availableWidth / BITMAP_WIDTH, availableHeight / BITMAP_HEIGHT));
  return Number.isFinite(k) ? Math.max(1, k) : 1;
}
