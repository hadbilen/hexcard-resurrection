/**
 * Spec 06 Requirement 7.2 and design §fatBits.ts: FatBits cells. Task 3.2 covers `drawFatCell`
 * (used by the Icon Editor grid); task 5 adds the rest of the module and its tests.
 */
import { describe, expect, it } from "vitest";
import {
  FATBITS_COLUMNS,
  FATBITS_MAX,
  FATBITS_ROWS,
  FATBITS_START,
  FATBITS_CELL,
  INSET_SIZE,
  clampFatBitsView,
  drawFatCell,
  fatBitsCardPoint,
  inInset,
  insetRect,
  renderFatBits,
} from "../fatBits.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH } from "../rleCodec.ts";

const WIDTH = 24;
const HEIGHT = 16;
const rows = (frame: Uint8Array, x: number, y: number): string[] =>
  Array.from({ length: FATBITS_CELL }, (_, dy) =>
    Array.from({ length: FATBITS_CELL }, (_, dx) => frame[(y + dy) * WIDTH + x + dx]).map((v) => (v === 2 ? "#" : ".")).join(""));

describe("drawFatCell", () => {
  it("draws a dark pixel as a dark 7 x 7 square with a light right column and bottom row", () => {
    const frame = new Uint8Array(WIDTH * HEIGHT);
    drawFatCell(frame, WIDTH, 8, 8, true);
    expect(rows(frame, 8, 8)).toEqual([
      "#######.", "#######.", "#######.", "#######.", "#######.", "#######.", "#######.", "........",
    ]);
  });

  it("draws a light pixel as an all-light cell and replaces what was there", () => {
    const frame = new Uint8Array(WIDTH * HEIGHT).fill(2);
    drawFatCell(frame, WIDTH, 8, 0, false);
    expect(rows(frame, 8, 0)).toEqual(Array(8).fill("........"));
    expect(frame[7]).toBe(2); // next to the cell: untouched
    expect(frame[16]).toBe(2);
  });

  it("writes only states 1 and 2 inside the cell and nothing outside it", () => {
    const frame = new Uint8Array(WIDTH * HEIGHT);
    drawFatCell(frame, WIDTH, 0, 0, true);
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const inside = x < FATBITS_CELL && y < FATBITS_CELL;
        expect(frame[y * WIDTH + x] === 0, `${x},${y}`).toBe(!inside);
        if (inside) expect([1, 2]).toContain(frame[y * WIDTH + x]);
      }
    }
  });

  it("clips a cell that lies partly outside the frame", () => {
    const frame = new Uint8Array(WIDTH * HEIGHT);
    drawFatCell(frame, WIDTH, WIDTH - 3, HEIGHT - 3, true);
    expect(frame[(HEIGHT - 1) * WIDTH + WIDTH - 1]).toBe(2);
    expect(frame).toHaveLength(WIDTH * HEIGHT);
    drawFatCell(frame, WIDTH, -4, -4, true);
    expect(frame[0]).toBe(2);
    expect(frame[2 * WIDTH + 2]).toBe(2); // cell column 6, row 6: still inside the 7 x 7 square
    expect(frame[3]).toBe(1); // cell column 7: the light right column
    expect(frame[3 * WIDTH]).toBe(1); // cell row 7: the light bottom row
  });
});

/** A composed-card stand-in: all light with the given card pixels dark. */
function cardWith(dark: Array<[number, number]>): Uint8Array {
  const frame = new Uint8Array(BITMAP_WIDTH * BITMAP_HEIGHT).fill(1);
  for (const [x, y] of dark) frame[y * BITMAP_WIDTH + x] = 2;
  return frame;
}
const at = (frame: Uint8Array, x: number, y: number): number => frame[y * BITMAP_WIDTH + x];

describe("constants (Requirements 7.1, 7.2, 7.7)", () => {
  it("describe a 64 x 43 cell view whose origin stays on the card", () => {
    expect(FATBITS_COLUMNS * FATBITS_CELL).toBe(BITMAP_WIDTH);
    expect(FATBITS_ROWS).toBe(Math.ceil(BITMAP_HEIGHT / FATBITS_CELL));
    expect(FATBITS_MAX).toEqual({ x: BITMAP_WIDTH - FATBITS_COLUMNS, y: BITMAP_HEIGHT - FATBITS_ROWS });
    expect(FATBITS_START).toEqual({ x: 224, y: 149 });
    expect(INSET_SIZE).toEqual({ width: FATBITS_COLUMNS + 4, height: FATBITS_ROWS + 4 });
  });
});

describe("clampFatBitsView (Requirement 7.7)", () => {
  it("keeps valid origins and clamps to x 0..448 and y 0..299", () => {
    expect(clampFatBitsView({ x: 224, y: 149 })).toEqual({ x: 224, y: 149 });
    expect(clampFatBitsView({ x: -8, y: -1 })).toEqual({ x: 0, y: 0 });
    expect(clampFatBitsView({ x: 456, y: 307 })).toEqual({ x: 448, y: 299 });
    expect(clampFatBitsView({ x: 448, y: 299 })).toEqual({ x: 448, y: 299 });
  });
  it("turns non-integers into integers and NaN into 0", () => {
    expect(clampFatBitsView({ x: 10.9, y: 3.2 })).toEqual({ x: 10, y: 3 });
    expect(clampFatBitsView({ x: Number.NaN, y: Number.POSITIVE_INFINITY })).toEqual({ x: 0, y: 299 });
  });
});

describe("renderFatBits cells (Requirements 7.2, 7.4)", () => {
  it("shows the 64 x 43 card pixels from the origin, each dark pixel as a 7 x 7 square in an 8 x 8 cell", () => {
    const view = { x: 100, y: 100 };
    const out = renderFatBits(cardWith([[100, 110], [103, 112], [163, 142]]), view);
    expect(out).toHaveLength(BITMAP_WIDTH * BITMAP_HEIGHT);
    const cell = (cx: number, cy: number): string[] =>
      Array.from({ length: 8 }, (_, dy) => Array.from({ length: 8 }, (_, dx) => (at(out, cx * 8 + dx, cy * 8 + dy) === 2 ? "#" : ".")).join(""));
    // Cells 0-8 x 0-5 lie under the inset at the top-left, so look at cells outside it.
    expect(cell(3, 12)).toEqual(["#######.", "#######.", "#######.", "#######.", "#######.", "#######.", "#######.", "........"]);
    expect(cell(4, 12)).toEqual(Array(8).fill("........")); // card pixel (104, 112): light
    expect(cell(0, 10).slice(0, 7).every((row) => row === "#######.")).toBe(true); // card pixel (100, 110)
    expect(cell(63, 42).slice(0, 6).every((row) => row === "#######.")).toBe(true); // card pixel (163, 142), last cell
  });
  it("cuts the last row of cells to the 6 lines that fit in the 342-line frame", () => {
    const out = renderFatBits(cardWith([[0, 299 + 42]]), { x: 0, y: 299 });
    // Cell row 42 starts at line 336; lines 336..341 are dark (cell lines 0..5 of the 7-line square).
    for (let y = 336; y < 342; y++) expect(at(out, 0, y), `line ${y}`).toBe(2);
    expect(at(out, 7, 336)).toBe(1); // light right column
    expect(out).toHaveLength(BITMAP_WIDTH * BITMAP_HEIGHT);
  });
  it("treats any state other than 2 as light and returns only states 1 and 2", () => {
    const frame = new Uint8Array(BITMAP_WIDTH * BITMAP_HEIGHT); // state 0 everywhere
    frame[100 * BITMAP_WIDTH + 100] = 2;
    const out = renderFatBits(frame, { x: 100, y: 100 });
    expect(out.every((value) => value === 1 || value === 2)).toBe(true);
    expect(at(out, 30 * 8, 20 * 8)).toBe(1);
    const mixed = renderFatBits(cardWith([[5, 5], [200, 200], [511, 341]]), { x: 0, y: 0 });
    expect(mixed.every((value) => value === 1 || value === 2)).toBe(true);
  });
  it("does not change the frame it reads", () => {
    const frame = cardWith([[224, 149]]);
    const copy = frame.slice();
    renderFatBits(frame, FATBITS_START);
    expect(frame).toEqual(copy);
  });
});

describe("the inset (Requirement 7.3)", () => {
  it("sits at the top-left, and at the top-right while x < 9 and y < 6", () => {
    expect(insetRect({ x: 224, y: 149 })).toEqual({ x: 0, y: 0, width: 68, height: 47 });
    expect(insetRect({ x: 9, y: 0 })).toEqual({ x: 0, y: 0, width: 68, height: 47 });
    expect(insetRect({ x: 0, y: 6 })).toEqual({ x: 0, y: 0, width: 68, height: 47 });
    expect(insetRect({ x: 8, y: 5 })).toEqual({ x: 444, y: 0, width: 68, height: 47 });
    expect(insetRect({ x: 0, y: 0 })).toEqual({ x: 444, y: 0, width: 68, height: 47 });
  });
  it("lets every card pixel be reached: the top-left cells covered at the origin are uncovered by panning", () => {
    // With the origin at (0, 0) the inset is at the right; the cells under it show card pixels x >= 55.
    const corner = insetRect({ x: 0, y: 0 });
    expect(Math.floor(corner.x / FATBITS_CELL)).toBe(55);
    // From the origin (9, 0) the inset is at the left and the top-left card pixel (0..8, 0..5) is
    // reachable from (8, 5) / (0, 0) with the inset on the right: no pixel is covered in both views.
    for (const [x, y] of [[0, 0], [8, 5]] as const) {
      expect(inInset({ x: 0, y: 0 }, x * 8, y * 8)).toBe(false);
    }
  });
  it("draws a light margin, a dark 1-pixel frame and the card pixels at actual size inside", () => {
    const view = { x: 224, y: 149 };
    const out = renderFatBits(cardWith([[224, 149], [225, 150], [287, 191]]), view);
    // Inset at (0, 0), 68 x 47: margin ring 0, frame ring 1, card pixels from (2, 2).
    for (let x = 0; x < 68; x++) {
      expect(at(out, x, 0), `margin top ${x}`).toBe(1);
      expect(at(out, x, 46), `margin bottom ${x}`).toBe(1);
      expect(at(out, x, 1), `frame top ${x}`).toBe(x === 0 || x === 67 ? 1 : 2);
      expect(at(out, x, 45), `frame bottom ${x}`).toBe(x === 0 || x === 67 ? 1 : 2);
    }
    for (let y = 0; y < 47; y++) {
      expect(at(out, 0, y), `margin left ${y}`).toBe(1);
      expect(at(out, 67, y), `margin right ${y}`).toBe(1);
      if (y >= 1 && y <= 45) {
        expect(at(out, 1, y), `frame left ${y}`).toBe(2);
        expect(at(out, 66, y), `frame right ${y}`).toBe(2);
      }
    }
    expect(at(out, 2, 2)).toBe(2); // card pixel (224, 149)
    expect(at(out, 3, 3)).toBe(2); // (225, 150)
    expect(at(out, 65, 44)).toBe(2); // (287, 191): the last pixel of the 64 x 43 region
    expect(at(out, 4, 2)).toBe(1);
    expect(at(out, 3, 2)).toBe(1);
  });
  it("draws the same inset at the top-right corner", () => {
    const out = renderFatBits(cardWith([[0, 0]]), { x: 0, y: 0 });
    expect(at(out, 444 + 1, 1)).toBe(2); // frame corner
    expect(at(out, 444, 0)).toBe(1); // margin
    expect(at(out, 444 + 2, 2)).toBe(2); // card pixel (0, 0)
    expect(at(out, 511, 46)).toBe(1);
    expect(at(out, 443, 10)).toBe(1); // the cell next to the inset: a light cell
  });
  it("tells a point inside the inset, margin included, from one outside", () => {
    const view = { x: 224, y: 149 };
    expect(inInset(view, 0, 0)).toBe(true);
    expect(inInset(view, 67, 46)).toBe(true);
    expect(inInset(view, 68, 10)).toBe(false);
    expect(inInset(view, 10, 47)).toBe(false);
    const right = { x: 0, y: 0 };
    expect(inInset(right, 444, 0)).toBe(true);
    expect(inInset(right, 443, 0)).toBe(false);
    expect(inInset(right, 511, 46)).toBe(true);
    expect(inInset(right, 10, 10)).toBe(false);
  });
});

describe("fatBitsCardPoint (Requirement 7.5)", () => {
  it("maps a frame point to the card pixel of its cell", () => {
    expect(fatBitsCardPoint({ x: 224, y: 149 }, 0, 0)).toEqual({ x: 224, y: 149 });
    expect(fatBitsCardPoint({ x: 224, y: 149 }, 7, 7)).toEqual({ x: 224, y: 149 });
    expect(fatBitsCardPoint({ x: 224, y: 149 }, 8, 15)).toEqual({ x: 225, y: 150 });
    expect(fatBitsCardPoint({ x: 10, y: 20 }, 100, 200)).toEqual({ x: 22, y: 45 });
  });
  it("reaches the last card pixel from the last cell, including the partly shown row", () => {
    expect(fatBitsCardPoint(FATBITS_MAX, 511, 341)).toEqual({ x: 511, y: 341 });
    expect(fatBitsCardPoint(FATBITS_MAX, 0, 336)).toEqual({ x: 448, y: 341 });
  });
  it("clamps to the card", () => {
    expect(fatBitsCardPoint({ x: 448, y: 299 }, 600, 500)).toEqual({ x: 511, y: 341 });
    expect(fatBitsCardPoint({ x: 0, y: 0 }, -5, -5)).toEqual({ x: 0, y: 0 });
  });
  it("agrees with what renderFatBits draws: the cell under a point shows the mapped pixel", () => {
    const view = { x: 77, y: 31 };
    const frame = cardWith([[90, 40]]);
    const out = renderFatBits(frame, view);
    const point = fatBitsCardPoint(view, (90 - 77) * 8 + 3, (40 - 31) * 8 + 5);
    expect(point).toEqual({ x: 90, y: 40 });
    expect(at(out, (90 - 77) * 8 + 3, (40 - 31) * 8 + 5)).toBe(2);
  });
});
