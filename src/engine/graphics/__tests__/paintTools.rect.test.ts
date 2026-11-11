/**
 * Spec 07 task 2: `plotRectShape` (design §paintTools.ts), Requirements 11.6 and 14.2.
 * The paint controller's Rect tool is compared with the pre-spec-07 loop in `rectLoopOracle.ts`.
 */
import { describe, expect, it } from "vitest";
import { createHistory } from "../../../core/history.ts";
import type { HexStack } from "../../../core/schema.ts";
import { createHexStore, type CompiledScript, type HexLayer } from "../../../core/store.ts";
import { createPaintController, plotRectShape } from "../paintTools.ts";
import { PATTERNS, patternState } from "../patterns.ts";
import { BITMAP_WIDTH as W, TOTAL_PIXELS, decodeBitmapRLE, encodeBitmapRLE } from "../rleCodec.ts";
import { rectLoopOracle } from "./rectLoopOracle.ts";

type Point = { x: number; y: number };
const calls = (draw: (plot: (x: number, y: number) => void) => void): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  draw((x, y) => out.push([x, y]));
  return out;
};

describe("plotRectShape", () => {
  it("plots the 1-pixel frame of the box, row by row", () => {
    expect(calls((plot) => plotRectShape(2, 3, 5, 5, false, plot))).toEqual([
      [2, 3], [3, 3], [4, 3], [5, 3],
      [2, 4], [5, 4],
      [2, 5], [3, 5], [4, 5], [5, 5],
    ]);
  });

  it("plots every pixel of the box when filled", () => {
    const filled = calls((plot) => plotRectShape(2, 3, 5, 5, true, plot));
    expect(filled).toHaveLength(12);
    expect(filled).toContainEqual([3, 4]);
  });

  it("plots a single pixel and one-pixel-wide boxes", () => {
    expect(calls((plot) => plotRectShape(7, 7, 7, 7, false, plot))).toEqual([[7, 7]]);
    expect(calls((plot) => plotRectShape(1, 0, 1, 2, false, plot))).toEqual([[1, 0], [1, 1], [1, 2]]);
  });

  it("gives the same calls for every corner order", () => {
    const expected = calls((plot) => plotRectShape(2, 3, 9, 8, false, plot));
    expect(calls((plot) => plotRectShape(9, 8, 2, 3, false, plot))).toEqual(expected);
    expect(calls((plot) => plotRectShape(2, 8, 9, 3, false, plot))).toEqual(expected);
    expect(calls((plot) => plotRectShape(9, 3, 2, 8, false, plot))).toEqual(expected);
  });

  it("clips to the canvas without plotting the frame edges outside it", () => {
    expect(calls((plot) => plotRectShape(-3, -3, 1, 1, false, plot))).toEqual([[1, 0], [0, 1], [1, 1]]);
    const corner = calls((plot) => plotRectShape(510, 340, 600, 400, true, plot));
    expect(corner).toEqual([[510, 340], [511, 340], [510, 341], [511, 341]]);
    expect(calls((plot) => plotRectShape(-10, 5, -2, 9, false, plot))).toEqual([]);
  });

  it("makes the same calls in the same order as the pre-spec-07 Rect loop", () => {
    // Order-sensitive digest of a call sequence: count and a polynomial hash of (x, y).
    const digest = (draw: (plot: (x: number, y: number) => void) => void): [number, number] => {
      let count = 0;
      let hash = 7;
      draw((x, y) => {
        count++;
        hash = (Math.imul(hash, 31) + x * 1031 + y) | 0;
      });
      return [count, hash];
    };
    const coords = [-5, 0, 7, 341, 342, 511, 520];
    for (const filled of [false, true]) {
      for (const x0 of coords) for (const y0 of coords) for (const [x1, y1] of [[3, 4], [511, 0], [0, 341], [x0, 9], [-1, -1]]) {
        const actual = digest((plot) => plotRectShape(x0, y0, x1, y1, filled, plot));
        const expected = digest((plot) => rectLoopOracle({ x: x0, y: y0 }, { x: x1, y: y1 }, filled, plot));
        if (actual[0] !== expected[0] || actual[1] !== expected[1]) {
          expect({ x0, y0, x1, y1, filled, actual }).toEqual({ x0, y0, x1, y1, filled, actual: expected });
        }
      }
    }
  }, 30_000);
});

describe("the Rect tool draws the same pixels as before spec 07 (Requirement 14.2)", () => {
  const compile = (): CompiledScript => ({ ast: { handlers: {} }, errors: [] });

  function noisyLayer(fill: number): Uint8Array {
    const p = new Uint8Array(TOTAL_PIXELS).fill(fill);
    for (let i = 0; i < TOTAL_PIXELS; i += 37) p[i] = (i % 3) as 0 | 1 | 2;
    return p;
  }

  function makeStack(cardData: string, bgData: string): HexStack {
    return {
      id: "stk_1", schemaVersion: "2.0.0", name: "T", author: "T",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      dimensions: { width: 512, height: 342 },
      themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
      backgrounds: [{ id: "bkg_1", name: "Main", bitmap: { width: 512, height: 342, rleData: bgData }, parts: [], scriptSource: "", cantDelete: false }],
      cards: [{
        id: "crd_1", name: "One", backgroundId: "bkg_1", bitmap: { width: 512, height: 342, rleData: cardData },
        parts: [], bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      }],
      customIcons: {}, scriptSource: "",
    };
  }

  const drags: Array<[Point, Point]> = [
    [{ x: 10, y: 10 }, { x: 60, y: 40 }],
    [{ x: 200, y: 300 }, { x: 120, y: 150 }],
    [{ x: -20, y: 330 }, { x: 40, y: 360 }],
    [{ x: 505, y: 2 }, { x: 600, y: -9 }],
    [{ x: 33, y: 33 }, { x: 33, y: 33 }],
    [{ x: 0, y: 0 }, { x: 511, y: 341 }],
  ];

  for (const layer of ["card", "background"] as HexLayer[]) {
    for (const rectFilled of [false, true]) {
      for (const patternIndex of [1, 0, 3, 17, 37]) {
        it(`${layer} layer, filled ${rectFilled}, pattern ${patternIndex}`, () => {
          const cardBase = noisyLayer(0);
          const bgBase = noisyLayer(1);
          const store = createHexStore({ stack: makeStack(encodeBitmapRLE(cardBase), encodeBitmapRLE(bgBase)), compile });
          const history = createHistory(store);
          store.setTool("rect");
          store.setEditLayer(layer);
          const pattern = PATTERNS[patternIndex];
          const paint = createPaintController({ store, history, getSettings: () => ({ pattern, rectFilled }) });

          const expected = (layer === "card" ? cardBase : bgBase).slice();
          for (const [from, to] of drags) {
            paint.begin(from.x, from.y);
            paint.move(Math.round((from.x + to.x) / 2), from.y);
            paint.end(to.x, to.y);
            rectLoopOracle(from, to, rectFilled, (x, y) => {
              if (x >= 0 && y >= 0 && x < W && y < 342) expected[y * W + x] = patternState(pattern, x, y);
            });
          }
          const stack = store.getSnapshot().stack;
          const actual = layer === "card"
            ? decodeBitmapRLE(stack.cards[0].bitmap.rleData, 0)
            : decodeBitmapRLE(stack.backgrounds[0].bitmap.rleData, 1);
          let differing = 0;
          for (let i = 0; i < TOTAL_PIXELS; i++) if (actual[i] !== expected[i]) differing++;
          expect(differing).toBe(0);
          expect(history.canUndo()).toBe(true);
        });
      }
    }
  }
});
