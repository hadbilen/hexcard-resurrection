import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createHistory } from "../../../core/history.ts";
import type { HexStack } from "../../../core/schema.ts";
import { createHexStore, type CompiledScript, type HexLayer } from "../../../core/store.ts";
import type { AuthoringTool } from "../../../core/schema.ts";
import { PATTERNS, patternState } from "../patterns.ts";
import { bresenhamLine, createPaintController, type PaintSettings } from "../paintTools.ts";
import { BITMAP_WIDTH as W, TOTAL_PIXELS, decodeBitmapRLE, encodeBitmapRLE } from "../rleCodec.ts";

// Per-test budget for the heavy tests, so CPU contention in the parallel suite cannot time them out.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const SOLID_DARK = PATTERNS[1];
const SOLID_LIGHT = PATTERNS[0];
const GREY = PATTERNS[3];

function layerData(set: Array<[x: number, y: number, v: number]>, fill = 0): string {
  const p = new Uint8Array(TOTAL_PIXELS).fill(fill);
  for (const [x, y, v] of set) p[y * W + x] = v;
  return encodeBitmapRLE(p);
}

function makeStack(cardData = "", bgData = ""): HexStack {
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

const compile = (): CompiledScript => ({ ast: { handlers: {} }, errors: [] });

function setup(opts: { tool: AuthoringTool; layer?: HexLayer; cardData?: string; bgData?: string; settings?: Partial<PaintSettings>; seed?: number }) {
  const store = createHexStore({ stack: makeStack(opts.cardData, opts.bgData), compile });
  const history = createHistory(store);
  store.setTool(opts.tool);
  if (opts.layer) store.setEditLayer(opts.layer);
  const settings: PaintSettings = { pattern: SOLID_DARK, ...opts.settings };
  const paint = createPaintController({ store, history, getSettings: () => settings, seed: opts.seed });
  const card = () => decodeBitmapRLE(store.getSnapshot().stack.cards[0].bitmap.rleData, 0);
  const bg = () => decodeBitmapRLE(store.getSnapshot().stack.backgrounds[0].bitmap.rleData, 1);
  const stroke = (points: Array<[number, number]>): boolean => {
    paint.begin(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1, -1)) paint.move(x, y);
    const last = points[points.length - 1];
    return points.length > 1 ? paint.end(last[0], last[1]) : paint.end();
  };
  return { store, history, paint, card, bg, stroke, settings };
}

const countNonZero = (p: Uint8Array): number => p.reduce((n, v) => n + (v !== 0 ? 1 : 0), 0);
const at = (p: Uint8Array, x: number, y: number): number => p[y * W + x];

describe("layer routing (Requirement 7.1)", () => {
  const tools: AuthoringTool[] = ["pencil", "brush", "eraser", "line", "rect", "spray", "paintBucket"];

  it.each(tools)("%s on the card layer leaves the background untouched", (tool) => {
    const t = setup({ tool, layer: "card", bgData: layerData([[5, 5, 2]], 1), cardData: layerData([[5, 5, 2]]) });
    const bgBefore = t.store.getSnapshot().stack.backgrounds[0].bitmap.rleData;
    t.stroke([[4, 4], [20, 12]]);
    expect(t.store.getSnapshot().stack.backgrounds[0].bitmap.rleData).toBe(bgBefore);
  });

  it.each(tools)("%s with Edit Background on leaves the card untouched", (tool) => {
    const t = setup({ tool, layer: "background", cardData: layerData([[5, 5, 2]]), bgData: layerData([[5, 5, 2]], 1) });
    const cardBefore = t.store.getSnapshot().stack.cards[0].bitmap.rleData;
    t.stroke([[4, 4], [20, 12]]);
    expect(t.store.getSnapshot().stack.cards[0].bitmap.rleData).toBe(cardBefore);
  });

  it("ignores non-paint tools", () => {
    const t = setup({ tool: "browse" });
    expect(t.paint.begin(1, 1)).toBe(false);
    expect(t.paint.isActive()).toBe(false);
    expect(t.history.canUndo()).toBe(false);
  });
});

describe("one command per stroke (Requirement 7.5)", () => {
  it("submits a whole multi-move stroke as one undo step", () => {
    const t = setup({ tool: "brush", settings: { brushSize: 3 } });
    const pts: Array<[number, number]> = Array.from({ length: 40 }, (_, i) => [10 + i * 3, 20 + (i % 5) * 4]);
    expect(t.stroke(pts)).toBe(true);
    expect(countNonZero(t.card())).toBeGreaterThan(40);
    expect(t.history.undoLabel()).toBe("Brush");
    expect(t.history.undo()).toBe(true);
    expect(t.history.canUndo()).toBe(false); // exactly one command was recorded
    expect(countNonZero(t.card())).toBe(0);
    t.history.redo();
    expect(countNonZero(t.card())).toBeGreaterThan(40);
  });

  it("records nothing for a cancelled stroke or a stroke that changes nothing", () => {
    const t = setup({ tool: "pencil" });
    t.paint.begin(3, 3);
    t.paint.move(30, 30);
    t.paint.cancel();
    expect(t.history.canUndo()).toBe(false);
    expect(countNonZero(t.card())).toBe(0);

    const e = setup({ tool: "eraser", layer: "card" }); // erasing an empty card layer
    expect(e.stroke([[10, 10], [40, 40]])).toBe(false);
    expect(e.history.canUndo()).toBe(false);
  });

  it("stores only the bounding rectangle of the stroke", () => {
    const t = setup({ tool: "pencil" });
    t.stroke([[100, 100], [103, 100]]);
    expect(countNonZero(t.card())).toBe(4);
    t.history.undo();
    expect(t.store.getSnapshot().stack.cards[0].bitmap.rleData).toBe("");
  });
});

describe("pencil and brush with world-aligned patterns (Requirement 7.2)", () => {
  it("pencil paints solid dark pixels along a Bresenham line", () => {
    const t = setup({ tool: "pencil" });
    t.stroke([[2, 2], [6, 2]]);
    for (let x = 2; x <= 6; x++) expect(at(t.card(), x, 2)).toBe(2);
    expect(at(t.card(), 7, 2)).toBe(0);
    expect(at(t.card(), 1, 2)).toBe(0);
  });

  it("every brush pixel equals the pattern at its canvas coordinates, however strokes overlap", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 8, maxLength: 8 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 })), { minLength: 2, maxLength: 6 }),
        fc.array(fc.tuple(fc.integer({ min: 0, max: 60 }), fc.integer({ min: 0, max: 60 })), { minLength: 2, maxLength: 6 }),
        (pattern, first, second) => {
          const t = setup({ tool: "brush", settings: { pattern, brushSize: 5 } });
          t.stroke(first);
          t.stroke(second);
          const card = t.card();
          for (let i = 0; i < TOTAL_PIXELS; i++) {
            if (card[i] === 0) continue;
            const x = i % W;
            const y = (i - x) / W;
            expect(card[i]).toBe(patternState(pattern, x, y));
          }
        },
      ),
      { numRuns: 25 },
    );
  }, HEAVY_TEST_TIMEOUT_MS);

  it("a light pattern paints opaque light pixels, not transparent ones", () => {
    const t = setup({ tool: "brush", settings: { pattern: SOLID_LIGHT, brushSize: 2 } });
    t.stroke([[10, 10]]);
    expect(at(t.card(), 10, 10)).toBe(1);
  });
});

describe("eraser (Requirement 7.3)", () => {
  it("sets card-layer pixels to 0 (transparent)", () => {
    const t = setup({ tool: "eraser", layer: "card", settings: { eraserSize: 4 }, cardData: layerData([[10, 10, 2], [11, 10, 1], [30, 30, 2]]) });
    t.stroke([[10, 10]]);
    expect(at(t.card(), 10, 10)).toBe(0);
    expect(at(t.card(), 11, 10)).toBe(0);
    expect(at(t.card(), 30, 30)).toBe(2);
  });

  it("sets background-layer pixels to 1 (light)", () => {
    const t = setup({ tool: "eraser", layer: "background", settings: { eraserSize: 4 }, bgData: layerData([[10, 10, 2], [30, 30, 2]], 1) });
    t.stroke([[10, 10]]);
    expect(at(t.bg(), 10, 10)).toBe(1);
    expect(at(t.bg(), 30, 30)).toBe(2);
  });
});

describe("line and rect", () => {
  it("bresenhamLine includes both ends and is 8-connected with max(dx, dy) + 1 pixels", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 }),
        fc.integer({ min: -50, max: 50 }), fc.integer({ min: -50, max: 50 }),
        (x0, y0, x1, y1) => {
          const pts: Array<[number, number]> = [];
          bresenhamLine(x0, y0, x1, y1, (x, y) => pts.push([x, y]));
          expect(pts).toHaveLength(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) + 1);
          expect(pts[0]).toEqual([x0, y0]);
          expect(pts[pts.length - 1]).toEqual([x1, y1]);
          for (let i = 1; i < pts.length; i++) {
            expect(Math.max(Math.abs(pts[i][0] - pts[i - 1][0]), Math.abs(pts[i][1] - pts[i - 1][1]))).toBe(1);
          }
        },
      ),
    );
  });

  it("the line tool rubber-bands: only the final end point leaves pixels", () => {
    const t = setup({ tool: "line" });
    t.paint.begin(10, 10);
    t.paint.move(50, 80);
    t.paint.move(20, 10);
    expect(t.paint.end()).toBe(true);
    expect(countNonZero(t.card())).toBe(11);
    expect(at(t.card(), 20, 10)).toBe(2);
    expect(at(t.card(), 50, 80)).toBe(0);
  });

  it("the rect tool draws a frame, or a filled box with rectFilled", () => {
    const frame = setup({ tool: "rect" });
    frame.stroke([[10, 10], [19, 14]]); // 10 x 5
    expect(countNonZero(frame.card())).toBe(10 * 5 - 8 * 3);
    expect(at(frame.card(), 12, 12)).toBe(0);

    const filled = setup({ tool: "rect", settings: { rectFilled: true } });
    filled.stroke([[19, 14], [10, 10]]); // dragged up-left
    expect(countNonZero(filled.card())).toBe(50);
  });

  it("a filled rect with a grey pattern alternates dark and light", () => {
    const t = setup({ tool: "rect", settings: { rectFilled: true, pattern: GREY } });
    t.stroke([[0, 0], [3, 3]]);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) expect(at(t.card(), x, y)).toBe(patternState(GREY, x, y));
  });
});

describe("spray", () => {
  const sprayed = (seed: number) => {
    const t = setup({ tool: "spray", seed, settings: { sprayRadius: 6, sprayDots: 20 } });
    t.stroke([[100, 100], [100, 100], [100, 100]]);
    return t.card();
  };

  it("is deterministic for a seed, and differs between seeds", () => {
    expect(Array.from(sprayed(7))).toEqual(Array.from(sprayed(7)));
    expect(Array.from(sprayed(7))).not.toEqual(Array.from(sprayed(8)));
  }, HEAVY_TEST_TIMEOUT_MS);

  it("keeps every dot within the radius", () => {
    const card = sprayed(3);
    expect(countNonZero(card)).toBeGreaterThan(5);
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      if (card[i] === 0) continue;
      const x = (i % W) - 100;
      const y = Math.floor(i / W) - 100;
      expect(x * x + y * y).toBeLessThanOrEqual(36);
    }
  });
});

describe("paint bucket (Requirement 7.4)", () => {
  /** A hollow dark square, outline from (10,10) to (30,30). */
  const squareOutline = (): Array<[number, number, number]> => {
    const px: Array<[number, number, number]> = [];
    for (let i = 10; i <= 30; i++) px.push([i, 10, 2], [i, 30, 2], [10, i, 2], [30, i, 2]);
    return px;
  };

  it("fills the enclosed region with the pattern and nothing outside it", () => {
    const t = setup({ tool: "paintBucket", layer: "card", cardData: layerData(squareOutline()), settings: { pattern: GREY } });
    expect(t.stroke([[20, 20]])).toBe(true);
    const card = t.card();
    expect(at(card, 20, 20)).toBe(patternState(GREY, 20, 20));
    expect(at(card, 11, 11)).toBe(patternState(GREY, 11, 11));
    expect(at(card, 5, 5)).toBe(0);
    expect(at(card, 31, 20)).toBe(0);
    expect(t.history.undoLabel()).toBe("Paint Bucket");
  });

  it("does not leak through a diagonal gap (4-connected)", () => {
    const outline = squareOutline().filter(([x, y]) => !(x === 10 && y === 20));
    // knock out the outline pixel at (10,20) but keep (10,19)/(10,21): the gap is a straight hole -> leaks
    const leaking = setup({ tool: "paintBucket", layer: "card", cardData: layerData(outline) });
    leaking.stroke([[20, 20]]);
    expect(at(leaking.card(), 5, 5)).toBe(2);

    // a diagonal-only opening: walls (10,19) and (9,20) closed around the gap pixel (10,20)
    const diag = squareOutline().filter(([x, y]) => !(x === 10 && y === 20));
    diag.push([9, 20, 2]);
    const sealed = setup({ tool: "paintBucket", layer: "card", cardData: layerData(diag) });
    sealed.stroke([[20, 20]]);
    expect(at(sealed.card(), 5, 5)).toBe(0);
    expect(at(sealed.card(), 10, 20)).toBe(2); // the gap pixel itself is part of the region
  });

  it("follows the composed colour: a card fill is bounded by the background picture", () => {
    const t = setup({ tool: "paintBucket", layer: "card", bgData: layerData(squareOutline(), 1) });
    t.stroke([[20, 20]]);
    const card = t.card();
    expect(at(card, 20, 20)).toBe(2);
    expect(at(card, 10, 10)).toBe(0); // background outline pixels are another colour
    expect(at(card, 5, 5)).toBe(0);
  });

  it("a background fill is bounded by an opaque card picture", () => {
    const t = setup({ tool: "paintBucket", layer: "background", cardData: layerData(squareOutline()) });
    t.stroke([[20, 20]]);
    const bg = t.bg();
    expect(at(bg, 20, 20)).toBe(2);
    expect(at(bg, 5, 5)).toBe(1);
    expect(at(bg, 10, 10)).toBe(1);
  });
});

describe("select and lasso", () => {
  it("a rectangular selection can be dragged: one command moves the pixels", () => {
    const t = setup({ tool: "select", cardData: layerData([[12, 12, 2], [13, 12, 1], [40, 40, 2]]) });
    expect(t.stroke([[10, 10], [15, 15]])).toBe(false); // selecting changes no pixels
    expect(t.history.canUndo()).toBe(false);
    expect(t.paint.getSelection()?.bounds).toEqual({ x: 10, y: 10, width: 6, height: 6 });

    t.paint.begin(12, 12);
    t.paint.move(50, 20);
    expect(t.paint.end(52, 22)).toBe(true); // moved by (+40, +10)
    const card = t.card();
    expect(at(card, 12, 12)).toBe(0);
    expect(at(card, 13, 12)).toBe(0);
    expect(at(card, 52, 22)).toBe(2);
    expect(at(card, 53, 22)).toBe(1);
    expect(at(card, 40, 40)).toBe(2); // outside the selection: untouched
    expect(t.paint.getSelection()?.bounds).toEqual({ x: 50, y: 20, width: 6, height: 6 });

    t.history.undo();
    expect(at(t.card(), 12, 12)).toBe(2);
    expect(at(t.card(), 52, 22)).toBe(0);
    expect(t.history.canUndo()).toBe(false);
  });

  it("moving on the background layer leaves light behind (eraser rule)", () => {
    const t = setup({ tool: "select", layer: "background", bgData: layerData([[12, 12, 2]], 1) });
    t.stroke([[10, 10], [15, 15]]);
    t.paint.begin(11, 11);
    t.paint.end(31, 11);
    expect(at(t.bg(), 12, 12)).toBe(1);
    expect(at(t.bg(), 32, 12)).toBe(2);
  });

  it("transparent card pixels do not overwrite what they are dropped on", () => {
    const t = setup({ tool: "select", cardData: layerData([[12, 12, 2], [40, 12, 2]]) });
    t.stroke([[12, 12], [14, 12]]); // selects (12..14, 12): one dark, two transparent
    t.paint.begin(12, 12);
    t.paint.end(38, 12); // lands at 38..40: the transparent source of (14,12) falls on (40,12)
    expect(at(t.card(), 40, 12)).toBe(2);
    expect(at(t.card(), 38, 12)).toBe(2);
  });

  it("a click without dragging deselects", () => {
    const t = setup({ tool: "select" });
    t.stroke([[10, 10], [15, 15]]);
    expect(t.paint.getSelection()).not.toBeNull();
    t.paint.begin(100, 100);
    t.paint.end();
    expect(t.paint.getSelection()).toBeNull();
  });

  it("the lasso selects the pixels inside a freeform loop", () => {
    const t = setup({ tool: "lasso", cardData: layerData([[20, 20, 2], [60, 60, 2]]) });
    t.stroke([[10, 10], [40, 10], [40, 40], [10, 40], [10, 10]]);
    const sel = t.paint.getSelection();
    expect(sel).not.toBeNull();
    expect(sel!.mask[20 * W + 20]).toBe(1);
    expect(sel!.mask[60 * W + 60]).toBe(0);
    expect(sel!.bounds).toEqual({ x: 10, y: 10, width: 31, height: 31 });

    t.paint.begin(20, 20);
    t.paint.end(25, 25);
    expect(at(t.card(), 20, 20)).toBe(0);
    expect(at(t.card(), 25, 25)).toBe(2);
    expect(at(t.card(), 60, 60)).toBe(2);
  });

  it("drops the selection when the edit layer changes", () => {
    const t = setup({ tool: "select" });
    t.stroke([[10, 10], [15, 15]]);
    t.store.setEditLayer("background");
    t.paint.begin(12, 12);
    t.paint.cancel();
    expect(t.paint.getSelection()).toBeNull();
  });
});

describe("preview", () => {
  it("exposes the unfinished stroke and nothing once it ends", () => {
    const t = setup({ tool: "pencil" });
    expect(t.paint.getPreview()).toBeNull();
    t.paint.begin(5, 5);
    t.paint.move(9, 5);
    const preview = t.paint.getPreview();
    expect(preview?.layer).toBe("card");
    expect(at(preview!.pixels, 9, 5)).toBe(2);
    expect(t.store.getSnapshot().stack.cards[0].bitmap.rleData).toBe(""); // stack unchanged until the stroke ends
    t.paint.end();
    expect(t.paint.getPreview()).toBeNull();
  });
});
