// Spec 07 task 5.1: draw_layer (Requirements 11.1 to 11.11, 10.5, 5.3, 5.6, 5.7; design
// §tools/drawLayer.ts, §Data Models). Property tests 4 to 6 are tasks 5.2 to 5.4.
import { describe, expect, it } from "vitest";
import { bresenhamLine, plotRectShape } from "../../engine/graphics/paintTools.ts";
import { PATTERNS, patternState } from "../../engine/graphics/patterns.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS, decodeBitmapRLE, encodeBitmapRLE } from "../../engine/graphics/rleCodec.ts";
import { cssFontString, renderCrisp1BitText } from "../../engine/graphics/textRaster.ts";
import { createNodeTextBackend } from "../nodeTextBackend.ts";
import { checkDrawCommands, drawCommands, type DrawCommand } from "../tools/drawLayer.ts";
import { FONTS, makeCaller } from "./toolFixtures.ts";

const { call } = makeCaller();
type Layer = "card" | "background";
const baseOf = (layer: Layer): number => (layer === "card" ? 0 : 1);
const draw = (layer: unknown, commands: unknown, extra: Record<string, unknown> = {}) => call("draw_layer", { layer, commands, ...extra });
const decoded = (json: Record<string, any>, layer: Layer): Uint8Array => decodeBitmapRLE(json.rleData, baseOf(layer) as 0 | 1);
const baseLayer = (layer: Layer): Uint8Array => new Uint8Array(TOTAL_PIXELS).fill(baseOf(layer));
const at = (pixels: Uint8Array, x: number, y: number): number => pixels[y * BITMAP_WIDTH + x];
const backend = createNodeTextBackend(FONTS);

/** The pixels whose state differs from the layer's base. */
function changedPixels(pixels: Uint8Array, layer: Layer): Array<[number, number, number]> {
  const out: Array<[number, number, number]> = [];
  pixels.forEach((state, i) => {
    if (state !== baseOf(layer)) out.push([i % BITMAP_WIDTH, Math.floor(i / BITMAP_WIDTH), state]);
  });
  return out;
}

/** Pixel visits of a drag, in the paint tools' own code. */
const lineVisits = (x1: number, y1: number, x2: number, y2: number): string[] => {
  const visits: string[] = [];
  bresenhamLine(x1, y1, x2, y2, (x, y) => visits.push(`${x},${y}`));
  return visits;
};

describe("rect (Requirement 11.2)", () => {
  it("draws the 1-pixel frame in solid dark by default, and nothing inside", async () => {
    const result = await draw("card", [{ op: "rect", x: 10, y: 20, width: 5, height: 4 }]);
    expect(result.isError).toBe(false);
    expect(result.json.ok).toBe(true);
    expect(result.json.layer).toBe("card");
    const pixels = decoded(result.json, "card");
    const expected: string[] = [];
    for (let y = 20; y < 24; y++) for (let x = 10; x < 15; x++) if (x === 10 || x === 14 || y === 20 || y === 23) expected.push(`${x},${y}`);
    expect(changedPixels(pixels, "card").map(([x, y, s]) => `${x},${y}:${s}`)).toEqual(expected.map((p) => `${p}:2`));
    expect(at(pixels, 12, 21)).toBe(0);
    expect(result.json.darkPixels).toBe(14);
    expect(result.json.lightPixels).toBe(0);
  });

  it("fills every pixel of the box when filled is true", async () => {
    const result = await draw("card", [{ op: "rect", x: 10, y: 20, width: 5, height: 4, filled: true }]);
    expect(changedPixels(decoded(result.json, "card"), "card")).toHaveLength(20);
    expect(result.json.darkPixels).toBe(20);
  });

  it("gives each pixel the state of the pattern at the pixel's own layer coordinates", async () => {
    for (const pattern of [0, 1, 5, 20, 37]) {
      const result = await draw("card", [{ op: "rect", x: 3, y: 5, width: 17, height: 11, pattern, filled: true }]);
      const pixels = decoded(result.json, "card");
      for (let y = 5; y < 16; y++) {
        for (let x = 3; x < 20; x++) expect(at(pixels, x, y), `pattern ${pattern} at ${x},${y}`).toBe(patternState(PATTERNS[pattern], x, y));
      }
      expect(at(pixels, 2, 5)).toBe(0);
      expect(at(pixels, 20, 5)).toBe(0);
    }
  });

  it("sets pattern 0 as light and pattern 1 as dark", async () => {
    const light = await draw("card", [{ op: "rect", x: 0, y: 0, width: 2, height: 2, pattern: 0, filled: true }]);
    expect(light.json.lightPixels).toBe(4);
    expect(light.json.darkPixels).toBe(0);
    const dark = await draw("card", [{ op: "rect", x: 0, y: 0, width: 2, height: 2, pattern: 1, filled: true }]);
    expect(dark.json.darkPixels).toBe(4);
  });

  it("draws a 1 x 1 rectangle, a 1-pixel-wide frame and the whole layer", async () => {
    const one = await draw("card", [{ op: "rect", x: 7, y: 8, width: 1, height: 1 }]);
    expect(changedPixels(decoded(one.json, "card"), "card")).toEqual([[7, 8, 2]]);
    const column = await draw("card", [{ op: "rect", x: 7, y: 8, width: 1, height: 5 }]);
    expect(column.json.darkPixels).toBe(5);
    const all = await draw("card", [{ op: "rect", x: 0, y: 0, width: 512, height: 342, filled: true }]);
    expect(all.json.darkPixels).toBe(TOTAL_PIXELS);
    expect(decoded(all.json, "card").every((state) => state === 2)).toBe(true);
  });

  it("sets the pixels of plotRectShape, the function the Rect tool calls (Requirement 11.6)", async () => {
    for (const filled of [false, true]) {
      const wanted = new Set<string>();
      plotRectShape(30, 40, 30 + 9 - 1, 40 + 6 - 1, filled, (x, y) => wanted.add(`${x},${y}`));
      const result = await draw("card", [{ op: "rect", x: 30, y: 40, width: 9, height: 6, filled }]);
      expect(new Set(changedPixels(decoded(result.json, "card"), "card").map(([x, y]) => `${x},${y}`))).toEqual(wanted);
    }
  });
});

describe("line (Requirement 11.3)", () => {
  it("sets the pixels bresenhamLine visits, both ends included", async () => {
    const result = await draw("card", [{ op: "line", x1: 2, y1: 3, x2: 30, y2: 12 }]);
    const wanted = lineVisits(2, 3, 30, 12);
    const got = changedPixels(decoded(result.json, "card"), "card").map(([x, y, s]) => {
      expect(s).toBe(2);
      return `${x},${y}`;
    });
    expect(new Set(got)).toEqual(new Set(wanted));
    expect(got).toContain("2,3");
    expect(got).toContain("30,12");
  });

  it("draws a single point and horizontal and vertical lines", async () => {
    const point = await draw("card", [{ op: "line", x1: 9, y1: 9, x2: 9, y2: 9 }]);
    expect(changedPixels(decoded(point.json, "card"), "card")).toEqual([[9, 9, 2]]);
    const horizontal = await draw("card", [{ op: "line", x1: 1, y1: 5, x2: 4, y2: 5 }]);
    expect(horizontal.json.darkPixels).toBe(4);
    const vertical = await draw("card", [{ op: "line", x1: 6, y1: 9, x2: 6, y2: 1 }]);
    expect(vertical.json.darkPixels).toBe(9);
  });

  it("keeps the order of the two points: swapping them can set different pixels", async () => {
    expect(new Set(lineVisits(0, 0, 4, 1))).not.toEqual(new Set(lineVisits(4, 1, 0, 0)));
    for (const [x1, y1, x2, y2] of [[0, 0, 4, 1], [4, 1, 0, 0]]) {
      const result = await draw("card", [{ op: "line", x1, y1, x2, y2 }]);
      expect(new Set(changedPixels(decoded(result.json, "card"), "card").map(([x, y]) => `${x},${y}`))).toEqual(new Set(lineVisits(x1, y1, x2, y2)));
    }
  });

  it("applies the pattern at the pixel's own coordinates, default solid dark", async () => {
    const result = await draw("card", [{ op: "line", x1: 0, y1: 0, x2: 40, y2: 0, pattern: 4 }]);
    const pixels = decoded(result.json, "card");
    for (let x = 0; x <= 40; x++) expect(at(pixels, x, 0)).toBe(patternState(PATTERNS[4], x, 0));
    expect(at(pixels, 41, 0)).toBe(0);
  });
});

describe("sprite (Requirement 11.4)", () => {
  const rows = ["#.#", ".#.", "##."];

  it("sets # dark and . light at (x + column, y + row) on a card layer, and leaves the rest transparent", async () => {
    const result = await draw("card", [{ op: "sprite", x: 5, y: 6, rows }]);
    const pixels = decoded(result.json, "card");
    rows.forEach((row, dy) => [...row].forEach((c, dx) => expect(at(pixels, 5 + dx, 6 + dy)).toBe(c === "#" ? 2 : 1)));
    expect(changedPixels(pixels, "card")).toHaveLength(9);
    expect(result.json.darkPixels).toBe(5);
    expect(result.json.lightPixels).toBe(4);
  });

  it("counts all 175,104 pixels of a background layer, base pixels included", async () => {
    const result = await draw("background", [{ op: "sprite", x: 5, y: 6, rows }]);
    expect(result.json.darkPixels).toBe(5);
    expect(result.json.lightPixels).toBe(TOTAL_PIXELS - 5);
    const pixels = decoded(result.json, "background");
    expect(changedPixels(pixels, "background")).toHaveLength(5);
  });

  it("draws the largest sprite in the corner of the layer", async () => {
    const big = Array.from({ length: 64 }, (_, i) => (i % 2 === 0 ? "#." : ".#").repeat(32));
    const result = await draw("card", [{ op: "sprite", x: 448, y: 278, rows: big }]);
    expect(result.json.ok).toBe(true);
    const pixels = decoded(result.json, "card");
    expect(at(pixels, 448, 278)).toBe(2);
    expect(at(pixels, 511, 341)).toBe(2);
    expect(changedPixels(pixels, "card")).toHaveLength(4096);
  });
});

describe("text (Requirement 11.5)", () => {
  /** The ink of the studio's own call, from the same arguments. */
  function expectedInk(
    text: string,
    box: { x: number; y: number; width: number; height: number },
    options: Partial<{ font: "System" | "Sans" | "Mono" | "Serif"; size: 9 | 10 | 12 | 14 | 18 | 24; style: ("bold" | "italic" | "underline" | "outline" | "shadow" | "condense")[]; align: "left" | "center" | "right"; wrap: boolean }> = {},
  ): Set<string> {
    const result = renderCrisp1BitText(text, options.font ?? "Sans", options.size ?? 12, options.style ?? [], box, options.align ?? "left", options.wrap ?? true, backend);
    const ink = new Set<string>();
    result.mask.forEach((state, i) => {
      if (state === 2) ink.add(`${box.x + (i % box.width)},${box.y + Math.floor(i / box.width)}`);
    });
    return ink;
  }
  const inkOf = (pixels: Uint8Array, layer: Layer): Set<string> => new Set(changedPixels(pixels, layer).map(([x, y]) => `${x},${y}`));

  it("draws the text with renderCrisp1BitText in Sans 12, left, wrapped, dark, in the box from (x, y) to the layer's edge", async () => {
    const text = "Hello, HexCard world";
    const result = await draw("card", [{ op: "text", x: 10, y: 12, text }]);
    expect(result.json.ok).toBe(true);
    const wanted = expectedInk(text, { x: 10, y: 12, width: 502, height: 330 });
    expect(wanted.size).toBeGreaterThan(20);
    expect(inkOf(decoded(result.json, "card"), "card")).toEqual(wanted);
    expect(result.json.notes).toEqual([]);
    expect(result.json.uncoveredCharacters).toEqual([]);
  });

  it("passes font, size, style, align, wrap and the box through", async () => {
    const text = "A longer text that wraps in a narrow box";
    const box = { x: 20, y: 30, width: 120, height: 90 };
    const result = await draw("card", [
      { op: "text", x: 20, y: 30, width: 120, height: 90, text, font: "Serif", size: 14, style: ["bold", "underline"], align: "center", wrap: true },
    ]);
    expect(inkOf(decoded(result.json, "card"), "card")).toEqual(
      expectedInk(text, box, { font: "Serif", size: 14, style: ["bold", "underline"], align: "center", wrap: true }),
    );
    const unwrapped = await draw("card", [{ op: "text", x: 20, y: 30, width: 120, height: 90, text, wrap: false, align: "right", font: "Mono", size: 10 }]);
    expect(inkOf(decoded(unwrapped.json, "card"), "card")).toEqual(expectedInk(text, box, { wrap: false, align: "right", font: "Mono", size: 10 }));
  });

  it("breaks lines only at line breaks when wrap is false, and wraps at the box width when wrap is true", async () => {
    const text = "one two three four five six seven eight";
    const wrapped = await draw("card", [{ op: "text", x: 0, y: 0, width: 60, height: 200, text }]);
    const single = await draw("card", [{ op: "text", x: 0, y: 0, width: 60, height: 200, text, wrap: false }]);
    expect(wrapped.json.notes).toEqual([]);
    expect(single.json.notes).toHaveLength(1);
    const lowest = (json: Record<string, any>) => Math.max(...changedPixels(decoded(json, "card"), "card").map(([, y]) => y));
    expect(lowest(wrapped.json)).toBeGreaterThan(32);
    expect(lowest(single.json)).toBeLessThan(16);
  });

  it("sets the ink pixels to light with ink light, over what is already there", async () => {
    const result = await draw("background", [
      { op: "rect", x: 0, y: 0, width: 200, height: 40, filled: true },
      { op: "text", x: 4, y: 4, text: "Light on dark", ink: "light" },
    ]);
    const pixels = decoded(result.json, "background");
    const ink = expectedInk("Light on dark", { x: 4, y: 4, width: 508, height: 338 });
    expect(ink.size).toBeGreaterThan(10);
    for (const key of ink) {
      const [x, y] = key.split(",").map(Number);
      expect(at(pixels, x, y), key).toBe(1);
    }
    // The rest of the filled box stays dark.
    expect(at(pixels, 199, 39)).toBe(2);
    expect(at(pixels, 0, 0)).toBe(2);
  });

  it("returns \"\" for a text of spaces on a card layer, the pixel counts included", async () => {
    const result = await draw("card", [{ op: "text", x: 3, y: 3, text: "     " }]);
    expect(result.json).toMatchObject({ ok: true, layer: "card", rleData: "", lightPixels: 0, darkPixels: 0, notes: [] });
  });
});

describe("text that does not fit (Requirement 11.9)", () => {
  const css = cssFontString("Sans", 12, false);
  const hello = Math.ceil(backend.measureText("Hello", css));

  it("fits a line exactly as wide and as tall as its box, and notes it one pixel narrower or shorter", async () => {
    const fits = await draw("card", [{ op: "text", x: 0, y: 0, width: hello, height: 16, text: "Hello", wrap: false }]);
    expect(fits.json.notes).toEqual([]);
    const narrower = await draw("card", [{ op: "text", x: 0, y: 0, width: hello - 1, height: 16, text: "Hello", wrap: false }]);
    expect(narrower.json.notes).toEqual(["commands[0]: 1 line of the text does not fit in its box; make the box larger, the text shorter or the size smaller"]);
    const shorter = await draw("card", [{ op: "text", x: 0, y: 0, width: 200, height: 15, text: "Hello" }]);
    expect(shorter.json.notes).toEqual(["commands[0]: 1 line of the text does not fit in its box; make the box larger, the text shorter or the size smaller"]);
    // The box edge is the clip: width and height are not exceeded.
    const taller = await draw("card", [{ op: "text", x: 0, y: 0, width: 200, height: 16, text: "Hello" }]);
    expect(taller.json.notes).toEqual([]);
  });

  it("counts every line that does not fit and names the command by its position", async () => {
    const result = await draw("card", [
      { op: "rect", x: 0, y: 0, width: 3, height: 3 },
      { op: "text", x: 0, y: 40, width: 10, height: 100, text: "aaaaaaaaaaaaaaaaaaaaaaaa\nbbbbbbbbbbbbbbbbbbbbbbbbb\n", wrap: false },
    ]);
    expect(result.json.notes).toEqual(["commands[1]: 2 lines of the text do not fit in its box; make the box larger, the text shorter or the size smaller"]);
    expect(result.json.ok).toBe(true);
  });

  it("drops the pixels outside the box", async () => {
    const result = await draw("card", [{ op: "text", x: 50, y: 60, width: 20, height: 10, text: "Wide text in a small box", wrap: false }]);
    const changed = changedPixels(decoded(result.json, "card"), "card");
    expect(changed.length).toBeGreaterThan(0);
    for (const [x, y] of changed) {
      expect(x).toBeGreaterThanOrEqual(50);
      expect(x).toBeLessThan(70);
      expect(y).toBeGreaterThanOrEqual(60);
      expect(y).toBeLessThan(70);
    }
    expect(result.json.notes).toHaveLength(1);
  });

  it("always fits a line whose drawn width is 0", async () => {
    const result = await draw("card", [{ op: "text", x: 0, y: 0, width: 1, height: 1, text: "   \n  " }]);
    expect(result.json.notes).toEqual([]);
    expect(result.json.rleData).toBe("");
  });
});

describe("uncovered characters (Requirement 10.5)", () => {
  it("draws .notdef, lists each distinct uncovered character once per command with its path, and keeps ok", async () => {
    const result = await draw("card", [
      { op: "text", x: 0, y: 0, text: "a\u2603\u2603b\u2604\u2603" },
      { op: "rect", x: 0, y: 100, width: 4, height: 4 },
      { op: "text", x: 0, y: 120, text: "plain" },
      { op: "text", x: 0, y: 140, text: "\u2603", font: "Serif" },
    ]);
    expect(result.json.ok).toBe(true);
    expect(result.json.uncoveredCharacters).toEqual([
      { path: "commands[0]", character: "U+2603" },
      { path: "commands[0]", character: "U+2604" },
      { path: "commands[3]", character: "U+2603" },
    ]);
    // The .notdef glyph is ink: the unknown characters are not drawn as blanks.
    const box = { x: 0, y: 140, width: 512, height: 202 };
    const blank = renderCrisp1BitText("", "Serif", 12, [], box, "left", true, backend).mask.filter((state) => state === 2).length;
    const drawn = renderCrisp1BitText("\u2603", "Serif", 12, [], box, "left", true, backend).mask.filter((state) => state === 2).length;
    expect(blank).toBe(0);
    expect(drawn).toBeGreaterThan(0);
  });

  it("lists nothing for covered characters, and treats U+0009 and U+00AD as covered", async () => {
    const result = await draw("card", [{ op: "text", x: 0, y: 0, text: "tab\there\u00ADsoft" }]);
    expect(result.json.uncoveredCharacters).toEqual([]);
  });
});

describe("command order and layer bases (Requirement 11.1)", () => {
  it("lets a later command overwrite an earlier one, whatever the earlier one set", async () => {
    const darkThenLight = await draw("card", [
      { op: "rect", x: 10, y: 10, width: 10, height: 10, filled: true },
      { op: "rect", x: 12, y: 12, width: 4, height: 4, filled: true, pattern: 0 },
    ]);
    const pixels = decoded(darkThenLight.json, "card");
    expect(at(pixels, 11, 11)).toBe(2);
    expect(at(pixels, 13, 13)).toBe(1);
    const lightThenDark = await draw("card", [
      { op: "rect", x: 12, y: 12, width: 4, height: 4, filled: true, pattern: 0 },
      { op: "rect", x: 10, y: 10, width: 10, height: 10, filled: true },
    ]);
    expect(at(decoded(lightThenDark.json, "card"), 13, 13)).toBe(2);
    expect(darkThenLight.json.rleData).not.toBe(lightThenDark.json.rleData);
  });

  it("changes only the pixels a command sets: a sprite's dark pixels over an earlier line", async () => {
    const result = await draw("card", [
      { op: "line", x1: 0, y1: 0, x2: 9, y2: 0 },
      { op: "sprite", x: 3, y: 0, rows: ["..."] },
    ]);
    const pixels = decoded(result.json, "card");
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((x) => at(pixels, x, 0))).toEqual([2, 2, 2, 1, 1, 1, 2, 2, 2, 2]);
  });

  it("starts a card layer all transparent and a background layer all light", async () => {
    const card = await draw("card", [{ op: "rect", x: 100, y: 100, width: 1, height: 1 }]);
    expect(card.json.lightPixels).toBe(0);
    expect(at(decoded(card.json, "card"), 0, 0)).toBe(0);
    const background = await draw("background", [{ op: "rect", x: 100, y: 100, width: 1, height: 1 }]);
    expect(background.json.darkPixels).toBe(1);
    expect(background.json.lightPixels).toBe(TOTAL_PIXELS - 1);
    expect(at(decoded(background.json, "background"), 0, 0)).toBe(1);
  });
});

describe("the result (Requirements 11.7 and 11.8)", () => {
  it("returns canonical rleData that decodes to exactly the drawn pixels, in the field order of the design", async () => {
    const commands: DrawCommand[] = [
      { op: "rect", x: 20, y: 20, width: 100, height: 60, pattern: 12, filled: true },
      { op: "line", x1: 0, y1: 0, x2: 511, y2: 341 },
      { op: "sprite", x: 300, y: 200, rows: ["#.#.", ".#.#"] },
      { op: "text", x: 150, y: 100, text: "Canonical", size: 18 },
    ];
    for (const layer of ["card", "background"] as const) {
      const result = await draw(layer, commands);
      expect(Object.keys(result.json)).toEqual(["ok", "layer", "rleData", "lightPixels", "darkPixels", "notes", "uncoveredCharacters"]);
      const pixels = decoded(result.json, layer);
      expect(pixels).toEqual(drawCommands(layer, commands, FONTS).pixels);
      expect(encodeBitmapRLE(decodeBitmapRLE(result.json.rleData))).toBe(result.json.rleData);
      expect(result.json.lightPixels).toBe(pixels.filter((state) => state === 1).length);
      expect(result.json.darkPixels).toBe(pixels.filter((state) => state === 2).length);
    }
  });

  it("returns \"\" when the drawing equals the base: a background drawn only in light, a card drawn only in transparent text", async () => {
    const lightOnly = await draw("background", [
      { op: "rect", x: 0, y: 0, width: 512, height: 342, filled: true, pattern: 0 },
      { op: "sprite", x: 5, y: 5, rows: ["...", "..."] },
      { op: "line", x1: 0, y1: 0, x2: 50, y2: 50, pattern: 0 },
    ]);
    expect(lightOnly.json).toMatchObject({ ok: true, layer: "background", rleData: "", lightPixels: TOTAL_PIXELS, darkPixels: 0 });
    expect(decodeBitmapRLE("", 1)).toEqual(baseLayer("background"));
    // Dark pixels that a later command paints over again leave the base too.
    const painted = await draw("background", [
      { op: "rect", x: 0, y: 0, width: 4, height: 4, filled: true },
      { op: "rect", x: 0, y: 0, width: 4, height: 4, filled: true, pattern: 0 },
    ]);
    expect(painted.json.rleData).toBe("");
    const empty = await draw("card", [{ op: "text", x: 0, y: 0, text: " " }]);
    expect(empty.json).toMatchObject({ ok: true, rleData: "", lightPixels: 0, darkPixels: 0 });
  });

  it("returns an rleData of more than 80 characters whole, with no shortening", async () => {
    const rows = Array.from({ length: 64 }, (_, y) => Array.from({ length: 64 }, (_, x) => ((x * 7 + y * 13) % 5 < 2 ? "#" : ".")).join(""));
    const result = await draw("card", [{ op: "sprite", x: 40, y: 30, rows }]);
    expect(result.json.rleData.length).toBeGreaterThan(80);
    expect(result.json.rleData).not.toContain("...");
    const wanted = baseLayer("card");
    rows.forEach((row, dy) => [...row].forEach((c, dx) => (wanted[(30 + dy) * BITMAP_WIDTH + 40 + dx] = c === "#" ? 2 : 1)));
    expect(result.json.rleData).toBe(encodeBitmapRLE(wanted));
    expect(decoded(result.json, "card")).toEqual(wanted);
    // The first content is the whole JSON text, with the rleData inside it.
    expect(result.text).toContain(result.json.rleData);
    expect(result.contentTypes).toEqual(["text"]);
  });

  it("caps the notes and the uncovered characters at 100 entries and counts the rest (Requirement 5.6)", async () => {
    const commands = Array.from({ length: 101 }, () => ({ op: "text", x: 0, y: 0, width: 1, height: 1, text: "\u2603", wrap: false }));
    const result = await draw("card", commands);
    expect(result.json.ok).toBe(true);
    expect(result.json.notes).toHaveLength(100);
    expect(result.json.notesNotShown).toBe(1);
    expect(result.json.uncoveredCharacters).toHaveLength(100);
    expect(result.json.uncoveredCharactersNotShown).toBe(1);
    expect(result.json.notes[99]).toMatch(/^commands\[99\]: 1 line of the text does not fit/);
    const exactly = await draw("card", commands.slice(0, 100));
    expect(exactly.json.notes).toHaveLength(100);
    expect(exactly.json).not.toHaveProperty("notesNotShown");
    expect(exactly.json).not.toHaveProperty("uncoveredCharactersNotShown");
  });
});

describe("rules of Requirement 11.10", () => {
  const LAYER = "the 512 x 342 layer";
  const refusal = async (commands: unknown, layer: unknown = "card") => {
    const result = await draw(layer, commands);
    expect(result.isError).toBe(true);
    expect(result.contentTypes).toEqual(["text"]);
    expect(result.json.ok).toBe(false);
    expect(result.json).not.toHaveProperty("rleData");
    return result.json.errors as string[];
  };

  it("accepts a rectangle that ends on the last column and row, and refuses one past them", async () => {
    expect((await draw("card", [{ op: "rect", x: 500, y: 340, width: 12, height: 2 }])).isError).toBe(false);
    expect(await refusal([{ op: "rect", x: 500, y: 0, width: 13, height: 5 }])).toEqual([`commands[0]: the rectangle must lie inside ${LAYER}`]);
    expect(await refusal([{ op: "rect", x: 0, y: 340, width: 5, height: 3 }])).toEqual([`commands[0]: the rectangle must lie inside ${LAYER}`]);
    expect(await refusal([{ op: "rect", x: 1, y: 0, width: 512, height: 1 }])).toEqual([`commands[0]: the rectangle must lie inside ${LAYER}`]);
  });

  it("refuses a point outside the layer by its coordinate", async () => {
    expect(await refusal([{ op: "line", x1: 512, y1: 0, x2: 0, y2: 342 }])).toEqual([
      "commands[0].x1: must be from 0 to 511",
      "commands[0].y2: must be from 0 to 341",
    ]);
    expect(await refusal([{ op: "sprite", x: -1, y: 0, rows: ["#"] }])).toEqual(["commands[0].x: must be from 0 to 511"]);
  });

  it("refuses sprite rows of different lengths, naming each row that differs from rows[0]", async () => {
    expect(await refusal([{ op: "sprite", x: 0, y: 0, rows: ["##", "#", "###", "##"] }])).toEqual([
      "commands[0].rows[1]: must have the same length as rows[0] (2 characters)",
      "commands[0].rows[2]: must have the same length as rows[0] (2 characters)",
    ]);
  });

  it("refuses a sprite character other than # and ., and a sprite outside the layer", async () => {
    expect(await refusal([{ op: "sprite", x: 0, y: 0, rows: ["#x#"] }])).toEqual(["commands[0].rows[0]: must contain only # and ."]);
    expect(await refusal([{ op: "sprite", x: 511, y: 0, rows: ["##"] }])).toEqual([`commands[0]: the sprite must lie inside ${LAYER}`]);
    expect(await refusal([{ op: "sprite", x: 0, y: 341, rows: ["#", "#"] }])).toEqual([`commands[0]: the sprite must lie inside ${LAYER}`]);
    expect((await draw("card", [{ op: "sprite", x: 511, y: 341, rows: ["#"] }])).isError).toBe(false);
  });

  it("checks a text box with the defaults width = 512 - x and height = 342 - y", async () => {
    expect((await draw("card", [{ op: "text", x: 511, y: 341, text: "x" }])).isError).toBe(false);
    expect((await draw("card", [{ op: "text", x: 0, y: 0, width: 512, height: 342, text: "x" }])).isError).toBe(false);
    expect(await refusal([{ op: "text", x: 300, y: 0, width: 213, text: "x" }])).toEqual([`commands[0]: the text box must lie inside ${LAYER}`]);
    expect(await refusal([{ op: "text", x: 0, y: 300, height: 43, text: "x" }])).toEqual([`commands[0]: the text box must lie inside ${LAYER}`]);
  });

  it("lists every broken rule in command order, the call's own fields first and the total of characters last", async () => {
    const big = { op: "sprite", x: 0, y: 0, rows: Array.from({ length: 64 }, () => "#".repeat(64)) };
    const commands = [
      { op: "rect", x: 500, y: 0, width: 20, height: 5 },
      { op: "line", x1: 512, y1: 0, x2: 0, y2: 0 },
      { op: "circle" },
      { op: "sprite", x: 0, y: 0, rows: ["##", "#"] },
      ...Array.from({ length: 16 }, () => big),
      { op: "text", x: 400, y: 0, width: 200, text: "end" },
    ];
    const result = await call("draw_layer", { layer: "paper", commands, extra: 1 });
    expect(result.isError).toBe(true);
    expect(result.json).toEqual({
      ok: false,
      errors: [
        "extra: is not an allowed argument",
        "layer: must be one of card, background",
        `commands[0]: the rectangle must lie inside ${LAYER}`,
        "commands[1].x1: must be from 0 to 511",
        "commands[2].op: must be one of rect, line, sprite, text",
        "commands[3].rows[1]: must have the same length as rows[0] (2 characters)",
        `commands[20]: the text box must lie inside ${LAYER}`,
        // 16 sprites of 4096, "##" and "#", and "end".
        "commands: the sprite rows and texts have 65542 characters in all, more than 65536",
      ],
    });
  });

  it("answers a call with no commands, too many commands and no layer", async () => {
    expect(await refusal([])).toEqual(["commands: must have 1 to 256 entries"]);
    expect(await refusal(Array.from({ length: 257 }, () => ({ op: "rect", x: 0, y: 0, width: 1, height: 1 })))).toEqual([
      "commands: must have 1 to 256 entries",
    ]);
    expect((await call("draw_layer", { commands: [{ op: "rect", x: 0, y: 0, width: 1, height: 1 }] })).json.errors).toEqual(["layer: is required"]);
    expect((await call("draw_layer", { layer: "card" })).json.errors).toEqual(["commands: is required"]);
    expect((await call("draw_layer", { layer: "card", commands: "rect" })).json.errors).toEqual(["commands: must be an array"]);
    expect((await call("draw_layer", { layer: "card", commands: [3] })).json.errors).toEqual(["commands[0]: must be an object"]);
  });

  it("refuses a total of sprite-row and text characters one past 65536, and accepts exactly 65536", async () => {
    const sprite = (rows: number) => ({ op: "sprite", x: 0, y: 0, rows: Array.from({ length: rows }, () => ".".repeat(64)) });
    const exactly = [...Array.from({ length: 15 }, () => sprite(64)), { op: "text", x: 0, y: 0, text: " ".repeat(256), wrap: false }, ...Array.from({ length: 15 }, () => ({ op: "text", x: 0, y: 0, text: " ".repeat(256), wrap: false }))];
    // 15 x 4096 + 16 x 256 = 65536
    expect((await draw("background", exactly)).isError).toBe(false);
    const past = await refusal([...exactly, { op: "text", x: 0, y: 0, text: " " }], "background");
    expect(past).toEqual(["commands: the sprite rows and texts have 65537 characters in all, more than 65536"]);
  });

  it("lists at most 100 errors and counts the rest (Requirement 5.6)", async () => {
    const result = await draw("card", Array.from({ length: 150 }, () => ({ op: "rect", x: 511, y: 0, width: 2, height: 1 })));
    expect(result.isError).toBe(true);
    expect(result.json.errors).toHaveLength(100);
    expect(result.json.errorsNotShown).toBe(50);
    expect(result.json.errors[99]).toBe(`commands[99]: the rectangle must lie inside ${LAYER}`);
  });

  it("draws nothing for a refused call: a later valid call is not affected", async () => {
    const valid = [{ op: "rect", x: 1, y: 1, width: 3, height: 3 }];
    const first = await draw("card", valid);
    await refusal([{ op: "rect", x: 511, y: 0, width: 5, height: 5 }, ...valid]);
    expect((await draw("card", valid)).text).toBe(first.text);
  });
});

describe("checkDrawCommands", () => {
  it("returns no entry for commands that lie inside the layer", () => {
    const commands: DrawCommand[] = [
      { op: "rect", x: 0, y: 0, width: 512, height: 342 },
      { op: "line", x1: 0, y1: 0, x2: 511, y2: 341 },
      { op: "sprite", x: 510, y: 340, rows: ["##", "##"] },
      { op: "text", x: 0, y: 0, text: "x" },
    ];
    expect(checkDrawCommands(commands)).toEqual([]);
  });

  it("numbers the entries by the position in the list it is given", () => {
    const commands: DrawCommand[] = [
      { op: "line", x1: 0, y1: 0, x2: 1, y2: 1 },
      { op: "rect", x: 511, y: 0, width: 2, height: 1 },
      { op: "sprite", x: 0, y: 0, rows: ["#", "##"] },
    ];
    expect(checkDrawCommands(commands)).toEqual([
      "commands[1]: the rectangle must lie inside the 512 x 342 layer",
      "commands[2].rows[1]: must have the same length as rows[0] (1 characters)",
    ]);
  });
});

describe("determinism (Requirement 11.11)", () => {
  const good = [
    { op: "rect", x: 10, y: 10, width: 90, height: 40, pattern: 9, filled: true },
    { op: "line", x1: 0, y1: 100, x2: 300, y2: 60 },
    { op: "text", x: 12, y: 14, width: 80, height: 30, text: "Same every time", style: ["shadow"] },
  ];
  const bad = [{ op: "rect", x: 511, y: 0, width: 9, height: 1 }, { op: "sprite", x: 0, y: 0, rows: ["#", "##"] }];

  it("returns the same JSON text for the same arguments, a result or an error result, also after other calls and on a fresh caller", async () => {
    const first = await draw("background", good);
    const firstError = await draw("card", bad);
    await draw("card", [{ op: "rect", x: 0, y: 0, width: 5, height: 5, filled: true }]);
    await call("compile_hextalk", { source: "on mouseUp\nend mouseUp" });
    await draw("background", [{ op: "text", x: 0, y: 0, text: "\u2603 other call" }]);
    expect((await draw("background", good)).text).toBe(first.text);
    expect((await draw("card", bad)).text).toBe(firstError.text);
    const fresh = makeCaller();
    expect((await fresh.call("draw_layer", { layer: "background", commands: good })).text).toBe(first.text);
    expect((await fresh.call("draw_layer", { layer: "card", commands: bad })).text).toBe(firstError.text);
  });

  it("does not change the commands it is given", async () => {
    const commands = JSON.parse(JSON.stringify(good));
    await draw("card", commands);
    expect(commands).toEqual(good);
  });
});

describe("drawCommands", () => {
  it("draws on the base of the layer without checking, clipping what leaves the layer", () => {
    const outside = drawCommands("card", [{ op: "sprite", x: 511, y: 341, rows: ["##", "##"] }], FONTS);
    expect(changedPixels(outside.pixels, "card")).toEqual([[511, 341, 2]]);
    expect(outside.pixels).toHaveLength(TOTAL_PIXELS);
  });
});

describe("the layer size", () => {
  it("is 512 x 342", () => {
    expect([BITMAP_WIDTH, BITMAP_HEIGHT]).toEqual([512, 342]);
  });
});
