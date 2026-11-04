// 8x8 bit patterns and 4-way flood fill.
// Canonical contract: hexcard_design_spec.md §5.3 and spec 03 design.md §6.
//
// A pattern is a Uint8Array(8): one byte per row, most significant bit = leftmost column. A pattern
// bit is locked to canvas coordinates (not to the stroke), so overlapping strokes never drift:
//   bit = (pattern[y & 7] >> (7 - (x & 7))) & 1
// Bit 1 paints a dark pixel (state 2), bit 0 a light pixel (state 1).
//
// Pure TypeScript: no DOM access, testable in Node.

import type { PixelState } from "./rleCodec.ts";

export type Pattern = Uint8Array;

/** The pattern bit at canvas coordinates (x, y); works for any integer, including negatives. */
export function patternBit(pattern: Pattern, x: number, y: number): 0 | 1 {
  return ((pattern[y & 7] >> (7 - (x & 7))) & 1) as 0 | 1;
}

/** Pixel state the pattern paints at (x, y): bit 1 -> 2 (dark), bit 0 -> 1 (light). */
export function patternState(pattern: Pattern, x: number, y: number): PixelState {
  return patternBit(pattern, x, y) === 1 ? 2 : 1;
}

/**
 * The 38 patterns of the pattern palette, rows listed top to bottom. They are original 8x8 tiles
 * in the classic style (greys, stripes, diagonals, grids, bricks, dots, weaves); the design spec
 * fixes the count (38) and the bit formula but not the tiles. Index 0 is solid light, 1 solid dark.
 */
const PATTERN_ROWS: readonly (readonly number[])[] = [
  [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00], //  0 solid light
  [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff], //  1 solid dark
  [0xdd, 0x77, 0xdd, 0x77, 0xdd, 0x77, 0xdd, 0x77], //  2 75% grey
  [0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55, 0xaa, 0x55], //  3 50% checkerboard
  [0x88, 0x22, 0x88, 0x22, 0x88, 0x22, 0x88, 0x22], //  4 25% grey
  [0x80, 0x00, 0x08, 0x00, 0x80, 0x00, 0x08, 0x00], //  5 sparse dots
  [0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff, 0x00], //  6 horizontal stripes 1:1
  [0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa], //  7 vertical stripes 1:1
  [0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc, 0xcc], //  8 vertical stripes 2:2
  [0xff, 0xff, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00], //  9 horizontal stripes 2:2
  [0xff, 0x00, 0x00, 0x00, 0xff, 0x00, 0x00, 0x00], // 10 thin horizontal lines
  [0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88, 0x88], // 11 thin vertical lines
  [0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77, 0x77], // 12 thick vertical lines
  [0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01], // 13 diagonal down
  [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80], // 14 diagonal up
  [0x88, 0x44, 0x22, 0x11, 0x88, 0x44, 0x22, 0x11], // 15 wide diagonal down
  [0x11, 0x22, 0x44, 0x88, 0x11, 0x22, 0x44, 0x88], // 16 wide diagonal up
  [0xc0, 0x60, 0x30, 0x18, 0x0c, 0x06, 0x03, 0x81], // 17 thick diagonal down
  [0x03, 0x06, 0x0c, 0x18, 0x30, 0x60, 0xc0, 0x81], // 18 thick diagonal up
  [0x92, 0x49, 0x24, 0x92, 0x49, 0x24, 0x92, 0x49], // 19 diagonal hatch down
  [0x49, 0x92, 0x24, 0x49, 0x92, 0x24, 0x49, 0x92], // 20 diagonal hatch up
  [0xff, 0x80, 0x80, 0x80, 0xff, 0x80, 0x80, 0x80], // 21 grid 4x4
  [0xff, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xff], // 22 box
  [0xff, 0x80, 0x80, 0x80, 0xff, 0x08, 0x08, 0x08], // 23 bricks
  [0x7f, 0x7f, 0x7f, 0x00, 0xf7, 0xf7, 0xf7, 0x00], // 24 inverse bricks
  [0xcc, 0xcc, 0x00, 0x00, 0x33, 0x33, 0x00, 0x00], // 25 2x2 dots
  [0xcc, 0xcc, 0x33, 0x33, 0xcc, 0xcc, 0x33, 0x33], // 26 2x2 checkerboard
  [0xf0, 0xf0, 0xf0, 0xf0, 0x0f, 0x0f, 0x0f, 0x0f], // 27 4x4 checkerboard
  [0xf8, 0x74, 0x22, 0x47, 0x8f, 0x17, 0x22, 0x71], // 28 weave
  [0x10, 0x10, 0x10, 0xff, 0x10, 0x10, 0x10, 0x10], // 29 crosses
  [0x10, 0x28, 0x44, 0x82, 0x44, 0x28, 0x10, 0x00], // 30 diamonds
  [0x3c, 0x42, 0x81, 0x81, 0x81, 0x81, 0x42, 0x3c], // 31 circles
  [0x81, 0x42, 0x24, 0x18, 0x18, 0x24, 0x42, 0x81], // 32 X marks
  [0x38, 0x44, 0x82, 0x00, 0x38, 0x44, 0x82, 0x00], // 33 scales
  [0xee, 0xff, 0xbb, 0xff, 0xee, 0xff, 0xbb, 0xff], // 34 light dots on dark
  [0xb1, 0x3e, 0xd4, 0x69, 0x8b, 0xe2, 0x4d, 0x97], // 35 noise
  [0xf0, 0xf0, 0xf0, 0xf0, 0x00, 0x00, 0x00, 0x00], // 36 half blocks
  [0xe0, 0xe0, 0xe0, 0x00, 0x0e, 0x0e, 0x0e, 0x00], // 37 3x3 blocks
];

export const PATTERN_COUNT = 38;

/** The 38 patterns. Do not mutate the entries. */
export const PATTERNS: readonly Pattern[] = PATTERN_ROWS.map((rows) => Uint8Array.from(rows));

export const PATTERN_SOLID_LIGHT = 0;
export const PATTERN_SOLID_DARK = 1;

// ---------------------------------------------------------------------------------------------
// 4-way flood fill
// ---------------------------------------------------------------------------------------------

/**
 * Scanline 4-connected flood fill. Returns a mask (1 = in the region) of every pixel reachable
 * from (startX, startY) through horizontal and vertical steps over pixels whose value equals the
 * start pixel's value in `pixels`. The input is not modified. A start outside the buffer yields an
 * empty mask.
 */
export function floodFill4(pixels: Uint8Array, width: number, height: number, startX: number, startY: number): Uint8Array {
  const mask = new Uint8Array(width * height);
  if (!Number.isInteger(startX) || !Number.isInteger(startY)) return mask;
  if (startX < 0 || startY < 0 || startX >= width || startY >= height) return mask;

  const target = pixels[startY * width + startX];
  const open = (x: number, y: number): boolean => {
    const i = y * width + x;
    return mask[i] === 0 && pixels[i] === target;
  };

  // Each stack entry is a seed pixel; its whole horizontal span is filled, then the rows above
  // and below are scanned for new spans.
  const stack: number[] = [startX, startY];
  while (stack.length > 0) {
    const y = stack.pop() as number;
    const x = stack.pop() as number;
    if (!open(x, y)) continue;

    let left = x;
    while (left > 0 && open(left - 1, y)) left--;
    let right = x;
    while (right < width - 1 && open(right + 1, y)) right++;
    mask.fill(1, y * width + left, y * width + right + 1);

    for (const ny of [y - 1, y + 1]) {
      if (ny < 0 || ny >= height) continue;
      let inSpan = false;
      for (let nx = left; nx <= right; nx++) {
        if (open(nx, ny)) {
          if (!inSpan) {
            stack.push(nx, ny);
            inSpan = true;
          }
        } else {
          inSpan = false;
        }
      }
    }
  }
  return mask;
}
