/**
 * Spec 06 Requirement 7.2 and design §fatBits.ts: FatBits cells. Task 3.2 covers `drawFatCell`
 * (used by the Icon Editor grid); task 5 adds the rest of the module and its tests.
 */
import { describe, expect, it } from "vitest";
import { FATBITS_CELL, drawFatCell } from "../fatBits.ts";

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
