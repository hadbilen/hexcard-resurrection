import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { PATTERN_COUNT, PATTERNS, floodFill4, patternBit, patternState } from "../patterns.ts";

describe("PATTERNS", () => {
  it("defines 38 distinct Uint8Array(8) patterns", () => {
    expect(PATTERN_COUNT).toBe(38);
    expect(PATTERNS).toHaveLength(38);
    for (const p of PATTERNS) {
      expect(p).toBeInstanceOf(Uint8Array);
      expect(p).toHaveLength(8);
    }
    expect(new Set(PATTERNS.map((p) => Array.from(p).join(","))).size).toBe(38);
  });

  it("starts with solid light and solid dark", () => {
    expect(Array.from(PATTERNS[0]).every((b) => b === 0x00)).toBe(true);
    expect(Array.from(PATTERNS[1]).every((b) => b === 0xff)).toBe(true);
  });
});

describe("patternBit / patternState (Requirement 7.2)", () => {
  it("uses the world-aligned formula, MSB = leftmost column", () => {
    const p = Uint8Array.of(0x80, 0x01, 0, 0, 0, 0, 0, 0);
    expect(patternBit(p, 0, 0)).toBe(1);
    expect(patternBit(p, 7, 0)).toBe(0);
    expect(patternBit(p, 7, 1)).toBe(1);
    expect(patternBit(p, 8, 8)).toBe(1); // wraps every 8 pixels
    expect(patternState(p, 0, 0)).toBe(2);
    expect(patternState(p, 1, 0)).toBe(1);
  });

  it("matches (pattern[y & 7] >> (7 - (x & 7))) & 1 and repeats every 8 pixels", () => {
    fc.assert(
      fc.property(
        fc.uint8Array({ minLength: 8, maxLength: 8 }),
        fc.integer({ min: 0, max: 511 }),
        fc.integer({ min: 0, max: 341 }),
        fc.integer({ min: 0, max: 20 }),
        (pattern, x, y, k) => {
          const expected = (pattern[y & 7] >> (7 - (x & 7))) & 1;
          expect(patternBit(pattern, x, y)).toBe(expected);
          expect(patternBit(pattern, x + 8 * k, y + 8 * k)).toBe(expected);
        },
      ),
    );
  });
});

describe("floodFill4", () => {
  // 5x5: a wall of 2s with a diagonal gap-less ring; interior is 1s
  const grid = (rows: string[]): Uint8Array => Uint8Array.from(rows.join("").split("").map(Number));

  it("fills the bounded region and stops at the wall", () => {
    const px = grid([
      "22222",
      "21112",
      "21112",
      "21112",
      "22222",
    ]);
    const mask = floodFill4(px, 5, 5, 2, 2);
    expect(Array.from(mask).reduce((a, b) => a + b, 0)).toBe(9);
    expect(mask[0]).toBe(0);
    expect(mask[1 * 5 + 1]).toBe(1);
  });

  it("is 4-connected: diagonal neighbours are not reached", () => {
    const px = grid([
      "12",
      "21",
    ]);
    const mask = floodFill4(px, 2, 2, 0, 0);
    expect(Array.from(mask)).toEqual([1, 0, 0, 0]);
  });

  it("handles a serpentine region and an out-of-range start", () => {
    const px = grid([
      "11111",
      "22221",
      "11111",
      "12222",
      "11111",
    ]);
    expect(Array.from(floodFill4(px, 5, 5, 0, 0)).reduce((a, b) => a + b, 0)).toBe(17);
    expect(Array.from(floodFill4(px, 5, 5, 9, 0)).every((v) => v === 0)).toBe(true);
  });

  it("agrees with a naive breadth-first fill on random grids", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 144, maxLength: 144 }),
        fc.nat(),
        fc.nat(),
        (w, h, cells, sx, sy) => {
          const px = Uint8Array.from(cells.slice(0, w * h));
          const x0 = sx % w;
          const y0 = sy % h;
          const target = px[y0 * w + x0];
          const expected = new Uint8Array(w * h);
          const queue: Array<[number, number]> = [[x0, y0]];
          while (queue.length) {
            const [x, y] = queue.pop()!;
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            const i = y * w + x;
            if (expected[i] || px[i] !== target) continue;
            expected[i] = 1;
            queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
          }
          expect(Array.from(floodFill4(px, w, h, x0, y0))).toEqual(Array.from(expected));
        },
      ),
    );
  });
});
