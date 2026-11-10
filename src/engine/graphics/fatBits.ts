/**
 * FatBits cells (spec 06 design §fatBits.ts). Task 3.2 adds `drawFatCell`, which the Icon Editor
 * grid uses; the zoom view itself (`renderFatBits`, the inset, pointer mapping) is added by task 5.
 *
 * Pure TypeScript: no React and no DOM.
 */

export const FATBITS_CELL = 8;

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
