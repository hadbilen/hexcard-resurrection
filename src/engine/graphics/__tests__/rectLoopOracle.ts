// Spec 07 test oracle: the Rect branch of `drawShape` in src/engine/graphics/paintTools.ts as it
// was before spec 07 (commit 756ad07), with the stroke state passed as arguments. `put` stands
// for the controller's `put` (pattern state written to the working surface).
// Do not edit; it pins the pre-spec-07 pixels of the Rect tool (Requirements 11.6, 14.2).
import { BITMAP_HEIGHT as H, BITMAP_WIDTH as W } from "../rleCodec.ts";

export function rectLoopOracle(
  start: { x: number; y: number },
  to: { x: number; y: number },
  rectFilled: boolean,
  put: (x: number, y: number) => void,
): void {
  const x0 = Math.min(start.x, to.x);
  const x1 = Math.max(start.x, to.x);
  const y0 = Math.min(start.y, to.y);
  const y1 = Math.max(start.y, to.y);
  for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) {
      if (rectFilled || x === x0 || x === x1 || y === y0 || y === y1) put(x, y);
    }
  }
}
