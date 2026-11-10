/**
 * FatBits (spec 06 design §fatBits.ts, Requirement 7): the 8x zoomed view of the Pencil and the
 * Eraser. `drawFatCell` (task 3.2) is also used by the Icon Editor grid; the zoom view itself
 * (`renderFatBits`, the inset, pointer mapping and panning) is task 5.
 *
 * The view is a window of 64 x 43 card pixels whose top-left card pixel is the view's origin; the
 * viewport shows each of them as one 8 x 8 cell (the last row of cells is cut to 6 lines by the
 * 342-line frame). Every frame it produces holds only pixel states 1 (light) and 2 (dark).
 *
 * Pure TypeScript: no React and no DOM.
 */
import type { HexRect } from "../../core/schema.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH } from "./rleCodec.ts";

/** The origin of the view, in card pixels (the card pixel shown in its top-left cell). */
export interface FatBitsView {
  x: number;
  y: number;
}

export const FATBITS_CELL = 8;
export const FATBITS_COLUMNS = 64; // 512 / 8
export const FATBITS_ROWS = 43; // ceil(342 / 8); the last row shows 6 of 8 lines
export const FATBITS_MAX = { x: 448, y: 299 } as const; // 512 - 64, 342 - 43
/** Requirement 7.1: the origin that centres the view on the card. */
export const FATBITS_START: FatBitsView = { x: 224, y: 149 };
export const FATBITS_PAN_STEP = 8;
/** 64 x 43 card pixels + 1-pixel dark frame + 1-pixel light margin on each side. */
export const INSET_SIZE = { width: 68, height: 47 } as const;

/** Rounds down to an integer and clamps into the origin range (Requirement 7.7); NaN becomes 0. */
function clampAxis(value: number, max: number): number {
  const whole = Math.floor(value);
  if (Number.isNaN(whole)) return 0;
  return Math.min(max, Math.max(0, whole));
}

/** Requirement 7.7: integer coordinates clamped to x 0..448 and y 0..299. */
export function clampFatBitsView(view: FatBitsView): FatBitsView {
  return { x: clampAxis(view.x, FATBITS_MAX.x), y: clampAxis(view.y, FATBITS_MAX.y) };
}

/**
 * Requirement 7.3: the inset sits in the top-left corner of the viewport, or in the top-right
 * corner while the origin is at x < 9 and y < 6. At the top-left it would cover cells 0-8 x 0-5,
 * whose card pixels (x 0-8, y 0-5 for the origin 0,0) could then never be uncovered by panning;
 * at the top-right it covers cells whose pixels can.
 */
export function insetRect(view: FatBitsView): HexRect {
  const topRight = view.x < 9 && view.y < 6;
  return {
    x: topRight ? BITMAP_WIDTH - INSET_SIZE.width : 0,
    y: 0,
    width: INSET_SIZE.width,
    height: INSET_SIZE.height,
  };
}

/** Whether frame point (x, y) lies inside the inset, margin included (Requirement 7.5). */
export function inInset(view: FatBitsView, x: number, y: number): boolean {
  const rect = insetRect(view);
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/**
 * Requirement 7.5: the card pixel shown by the cell under frame point (x, y), clamped to the card.
 * The view is clamped first, so a stray origin cannot map outside the card either.
 */
export function fatBitsCardPoint(view: FatBitsView, x: number, y: number): { x: number; y: number } {
  const origin = clampFatBitsView(view);
  const column = Math.floor(x / FATBITS_CELL);
  const row = Math.floor(y / FATBITS_CELL);
  return {
    x: Math.min(BITMAP_WIDTH - 1, Math.max(0, origin.x + column)),
    y: Math.min(BITMAP_HEIGHT - 1, Math.max(0, origin.y + row)),
  };
}

/**
 * One FatBits cell drawn into `out` (pixel states 1 = light, 2 = dark) at (ox, oy), `outWidth`
 * pixels per row. A dark pixel is a dark 7 x 7 square whose right column and bottom row stay
 * light; a light pixel is an all-light cell (spec 06 Requirement 7.2). The whole 8 x 8 cell is
 * written, so earlier contents are replaced. Parts of the cell outside `out` are skipped.
 */
export function drawFatCell(out: Uint8Array, outWidth: number, ox: number, oy: number, dark: boolean): void {
  const outHeight = Math.floor(out.length / outWidth);
  for (let dy = 0; dy < FATBITS_CELL; dy++) {
    const y = oy + dy;
    if (y < 0 || y >= outHeight) continue;
    for (let dx = 0; dx < FATBITS_CELL; dx++) {
      const x = ox + dx;
      if (x < 0 || x >= outWidth) continue;
      out[y * outWidth + x] = dark && dx < FATBITS_CELL - 1 && dy < FATBITS_CELL - 1 ? 2 : 1;
    }
  }
}

/**
 * Requirements 7.2-7.4: a new 512 x 342 frame (states 1 and 2 only) that shows the 64 x 43 card
 * pixels of `frame` from the origin of `view` as 8 x 8 cells, with the inset on top: the same
 * region at actual size inside a 1-pixel dark frame and a 1-pixel light margin. `frame` is the
 * composed card frame (paint previews included); a pixel is dark when its state is 2.
 */
export function renderFatBits(frame: Uint8Array, view: FatBitsView): Uint8Array {
  const out = new Uint8Array(BITMAP_WIDTH * BITMAP_HEIGHT);
  const origin = clampFatBitsView(view);
  const darkAt = (x: number, y: number): boolean => frame[y * BITMAP_WIDTH + x] === 2;

  for (let row = 0; row < FATBITS_ROWS; row++) {
    for (let column = 0; column < FATBITS_COLUMNS; column++) {
      drawFatCell(out, BITMAP_WIDTH, column * FATBITS_CELL, row * FATBITS_CELL, darkAt(origin.x + column, origin.y + row));
    }
  }

  const inset = insetRect(origin);
  const frameLeft = inset.x + 1;
  const frameTop = inset.y + 1;
  const frameRight = inset.x + inset.width - 2;
  const frameBottom = inset.y + inset.height - 2;
  for (let y = inset.y; y < inset.y + inset.height; y++) {
    for (let x = inset.x; x < inset.x + inset.width; x++) {
      const onFrame = x >= frameLeft && x <= frameRight && y >= frameTop && y <= frameBottom;
      const inside = x > frameLeft && x < frameRight && y > frameTop && y < frameBottom;
      let dark = false;
      if (inside) dark = darkAt(origin.x + (x - inset.x - 2), origin.y + (y - inset.y - 2));
      else if (onFrame) dark = true;
      out[y * BITMAP_WIDTH + x] = dark ? 2 : 1;
    }
  }
  return out;
}
