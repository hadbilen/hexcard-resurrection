import type { HexStack } from "../../core/schema.ts";
import { encodeBitmapRLE, TOTAL_PIXELS } from "../../engine/graphics/rleCodec.ts";
import { createStarterStack } from "../../ui/starterStack.ts";

/** Deterministic pseudo-random layer (LCG): compresses poorly, like a dithered photo. */
export function noiseLayer(seed: number): string {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  let state = seed >>> 0;
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    pixels[i] = 1 + (state >>> 31);
  }
  return encodeBitmapRLE(pixels);
}

/** A small drawing: a dark 40x20 block at (10,10) on a transparent card layer. */
export function blockLayer(): string {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  for (let y = 10; y < 30; y++) pixels.fill(2, y * 512 + 10, y * 512 + 50);
  return encodeBitmapRLE(pixels);
}

/** The starter stack with a painted card layer and a stable timestamp. */
export function makeStack(overrides: Partial<HexStack> = {}): HexStack {
  const stack = createStarterStack(new Date("2026-01-01T00:00:00.000Z"));
  stack.cards[0].bitmap.rleData = blockLayer();
  return { ...stack, ...overrides };
}
