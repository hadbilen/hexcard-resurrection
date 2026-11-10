import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ButtonStyle, FieldStyle, HexButtonPart, HexCard, HexFieldPart, HexPart, HexStack } from "../../../core/schema.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS } from "../rleCodec.ts";
import { type PartDrawContext, clearDecodedLayerCache, composeFrame } from "../bitmapCanvas.ts";
import type { TextRasterBackend } from "../textRaster.ts";
import { createPartRasterizer, fieldCaretIndexAt, fieldScrollToIndex, hitTest } from "../partRenderer.ts";
import { ICON_PIXELS, encodeIcon } from "../../../core/icons.ts";

// Fixed-metric stub backend: every code point advances 6 px; a non-space glyph is a 4 x 6 block of
// full alpha in the six rows above the baseline.
const ADVANCE = 6;
const stub: TextRasterBackend = {
  measureText: (text) => [...text].length * ADVANCE,
  drawText(text, _css, x, baseline, width, height) {
    const alpha = new Uint8Array(width * height);
    [...text].forEach((ch, i) => {
      if (ch === " ") return;
      for (let r = baseline - 6; r < baseline; r++) {
        for (let c = 0; c < 4; c++) {
          const px = x + i * ADVANCE + c;
          if (px >= 0 && px < width && r >= 0 && r < height) alpha[r * width + px] = 255;
        }
      }
    });
    return alpha;
  },
};

// Per-test budget for the heavy tests, so CPU contention in the parallel suite cannot time them out.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const idx = (x: number, y: number): number => y * BITMAP_WIDTH + x;
const at = (frame: Uint8Array, x: number, y: number): number => frame[idx(x, y)];
const lightFrame = (): Uint8Array => new Uint8Array(TOTAL_PIXELS).fill(1);

function button(extra: Partial<HexButtonPart> = {}): HexButtonPart {
  return {
    id: "prt_b", name: "B", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 60, height: 20 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", title: "ab", showName: true,
    autoHilite: true, hilite: false, ...extra,
  };
}

function field(extra: Partial<HexFieldPart> = {}): HexFieldPart {
  return {
    id: "prt_f", name: "F", type: "field", layerScope: "card", rect: { x: 0, y: 0, width: 100, height: 40 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "Sans", textSize: 12,
    textStyle: [], ...extra,
  };
}

function makeStack(cardParts: HexPart[] = [], bgParts: HexPart[] = []): HexStack {
  const card: HexCard = {
    id: "crd_1", name: "One", backgroundId: "bkg_1", bitmap: { width: 512, height: 342, rleData: "" },
    parts: cardParts, bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
  };
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Test", author: "Tester",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: { width: 512, height: 342, rleData: "" }, parts: bgParts, scriptSource: "", cantDelete: false }],
    cards: [card], customIcons: {}, scriptSource: "",
  };
}

const STACK = makeStack();
const ctxFor = (part: HexPart, extra: Partial<PartDrawContext> = {}): PartDrawContext => ({
  stack: STACK, card: STACK.cards[0], text: part.type === "button" ? part.title : part.content, pressed: false, ...extra,
});

const raster = createPartRasterizer({ textBackend: stub });
function draw(part: HexPart, extra: Partial<PartDrawContext> = {}, frame = lightFrame(), r = raster): Uint8Array {
  r(frame, part, ctxFor(part, extra));
  return frame;
}

beforeEach(() => clearDecodedLayerCache());

// Button title geometry for the default 60x20 rectangle at (10,10): System 12 (line height 16,
// baseline 13), line top 12 -> glyph rows 19..24; "ab" is 12 px wide, centred in the 58-px
// interior -> "a" at columns 34..37, "b" at 40..43.
describe("push buttons", () => {
  it("draws a rectangle with a light interior and a centred title", () => {
    const f = draw(button());
    expect([at(f, 10, 10), at(f, 69, 10), at(f, 10, 29), at(f, 69, 29)]).toEqual([2, 2, 2, 2]);
    expect(at(f, 12, 12)).toBe(1);
    expect(at(f, 34, 19)).toBe(2);
    expect(at(f, 38, 19)).toBe(1);
    expect(at(f, 34, 25)).toBe(1);
    expect(at(f, 9, 9)).toBe(1);
  });

  it("inverts the interior when an autoHilite button is pressed or hilite is set, keeping the border", () => {
    const pressed = draw(button(), { pressed: true });
    expect(at(pressed, 12, 12)).toBe(2);
    expect(at(pressed, 34, 19)).toBe(1);
    expect(at(pressed, 10, 10)).toBe(2);
    expect(at(pressed, 9, 9)).toBe(1);
    expect(draw(button({ hilite: true }))).toEqual(pressed);
    expect(draw(button({ autoHilite: false }), { pressed: true })).toEqual(draw(button()));
  });

  it("omits the title when showName is false", () => {
    expect(at(draw(button({ showName: false })), 34, 19)).toBe(1);
  });

  it("draws roundRect corners from the fixed corner mask", () => {
    const f = draw(button({ style: "roundRect", rect: { x: 0, y: 0, width: 40, height: 20 }, title: "" }));
    expect([at(f, 0, 0), at(f, 2, 0), at(f, 0, 2), at(f, 39, 0), at(f, 39, 19)]).toEqual([1, 1, 1, 1, 1]);
    expect([at(f, 3, 0), at(f, 1, 1), at(f, 1, 2), at(f, 0, 3), at(f, 36, 0), at(f, 38, 18)]).toEqual([2, 2, 2, 2, 2, 2]);
    const pressed = draw(button({ style: "roundRect", rect: { x: 0, y: 0, width: 40, height: 20 }, title: "" }), { pressed: true });
    expect(at(pressed, 2, 2)).toBe(2);
    expect(at(pressed, 0, 0)).toBe(1); // outside the corner stays untouched
  });

  it("draws a 2-px solid shadow on the right and bottom of shadow buttons", () => {
    const f = draw(button({ style: "shadow", rect: { x: 0, y: 0, width: 30, height: 20 }, title: "" }));
    expect([at(f, 27, 5), at(f, 28, 5), at(f, 29, 5), at(f, 5, 18), at(f, 5, 19), at(f, 29, 19)]).toEqual([2, 2, 2, 2, 2, 2]);
    expect([at(f, 28, 1), at(f, 1, 18), at(f, 5, 5)]).toEqual([1, 1, 1]);
  });

  it("draws the double border of default buttons and inverts only inside the inner border", () => {
    const part = button({ style: "default", rect: { x: 0, y: 0, width: 60, height: 30 }, title: "" });
    const f = draw(part);
    expect([at(f, 0, 15), at(f, 1, 15), at(f, 2, 15), at(f, 3, 15), at(f, 4, 15)]).toEqual([2, 1, 1, 2, 1]);
    const pressed = draw(part, { pressed: true });
    expect([at(pressed, 0, 15), at(pressed, 1, 15), at(pressed, 3, 15), at(pressed, 4, 15)]).toEqual([2, 1, 2, 2]);
  });

  it("leaves transparent buttons unfilled and fills opaque ones without a border", () => {
    const dark = (): Uint8Array => new Uint8Array(TOTAL_PIXELS).fill(2);
    const t = draw(button({ style: "transparent", title: "" }), {}, dark());
    expect(t.every((v) => v === 2)).toBe(true);
    const tp = draw(button({ style: "transparent", title: "" }), { pressed: true }, dark());
    expect([at(tp, 10, 10), at(tp, 69, 29), at(tp, 9, 9)]).toEqual([1, 1, 2]);
    const o = draw(button({ style: "opaque", title: "" }), {}, dark());
    expect([at(o, 10, 10), at(o, 69, 29), at(o, 9, 9)]).toEqual([1, 1, 2]);
  });
});

// Checkable buttons at (0,0) 80x16: the 12x12 box sits at (2,2); the title starts at x = 18.
describe("checkboxes and radio buttons", () => {
  const box = (extra: Partial<HexButtonPart> = {}) => button({ style: "checkBox", rect: { x: 0, y: 0, width: 80, height: 16 }, ...extra });

  it("draws an empty box and the title to its right", () => {
    const f = draw(box());
    expect([at(f, 2, 2), at(f, 13, 13)]).toEqual([2, 2]);
    expect([at(f, 3, 3), at(f, 1, 1)]).toEqual([1, 1]);
    expect(at(f, 18, 7)).toBe(2);
  });

  it("draws the checked X by inverting the box interior when hilite is set", () => {
    const f = draw(box({ hilite: true }));
    expect([at(f, 3, 3), at(f, 12, 3), at(f, 3, 12), at(f, 12, 12)]).toEqual([2, 2, 2, 2]);
    expect(at(f, 4, 3)).toBe(1);
  });

  it("thickens the outline by inversion while an autoHilite checkbox is pressed", () => {
    const f = draw(box(), { pressed: true });
    expect([at(f, 3, 5), at(f, 5, 3)]).toEqual([2, 2]);
    expect(at(f, 5, 5)).toBe(1);
    const both = draw(box({ hilite: true }), { pressed: true });
    expect(at(both, 3, 3)).toBe(2); // mark and ring overlap: inverted once
  });

  it("draws a round radio button with a centre dot when hilite is set", () => {
    const radio = (hilite: boolean) => box({ style: "radioButton", hilite });
    const off = draw(radio(false));
    expect([at(off, 2, 2), at(off, 6, 2), at(off, 2, 6)]).toEqual([1, 2, 2]);
    expect(at(off, 6, 5)).toBe(1);
    const on = draw(radio(true));
    expect([at(on, 6, 5), at(on, 7, 7), at(on, 5, 6)]).toEqual([2, 2, 2]);
    expect([at(on, 5, 4), at(on, 5, 5)]).toEqual([1, 1]); // above the dot, and its rounded corner
  });
});

// Fields at (0,0) 100x40 in Sans 12: text rect (4,2) 92x36, line height 16, baseline 13 ->
// line 0 glyph rows 9..14, line 1 glyph rows 25..30; glyph k starts at x = 4 + 6k.
describe("fields", () => {
  it("draws the frame and the field text in the text rect", () => {
    const f = draw(field({ content: "ab cd" }));
    expect([at(f, 0, 0), at(f, 99, 39)]).toEqual([2, 2]);
    expect([at(f, 4, 9), at(f, 22, 9)]).toEqual([2, 2]);
    expect([at(f, 4, 15), at(f, 16, 9)]).toEqual([1, 1]);
  });

  it("draws world-aligned dotted rules on every line's baseline with showLines", () => {
    const f = draw(field({ showLines: true }));
    expect([at(f, 4, 15), at(f, 5, 15), at(f, 6, 15)]).toEqual([1, 2, 1]);
    expect([at(f, 4, 31), at(f, 5, 31)]).toEqual([1, 2]);
    expect(at(f, 5, 14)).toBe(1);
  });

  it("draws a 2-px shadow for shadow fields and nothing for transparent ones", () => {
    const s = draw(field({ style: "shadow" }));
    expect([at(s, 97, 0), at(s, 98, 5), at(s, 99, 5), at(s, 5, 39)]).toEqual([2, 2, 2, 2]);
    expect(at(s, 99, 0)).toBe(1);
    const t = draw(field({ style: "transparent" }), {}, new Uint8Array(TOTAL_PIXELS).fill(2));
    expect(t.every((v) => v === 2)).toBe(true);
  });

  it("draws the caret as an inverted 1-px column just left of the caret position", () => {
    const part = field({ content: "ab" });
    const f = draw(part, { editing: { partId: part.id, caret: 1, selEnd: 1 } });
    expect([at(f, 9, 2), at(f, 9, 17)]).toEqual([2, 2]);
    expect([at(f, 9, 18), at(f, 8, 2), at(f, 10, 2)]).toEqual([1, 1, 1]);
    expect(at(f, 10, 9)).toBe(2); // the glyph next to the caret is untouched
  });

  it("draws a caret in an empty field", () => {
    const part = field();
    const f = draw(part, { editing: { partId: part.id, caret: 0, selEnd: 0 } });
    expect(at(f, 3, 5)).toBe(2);
  });

  it("inverts the selection, extending lines it continues past to the text rect's edges", () => {
    const one = field({ content: "ab" });
    const f = draw(one, { editing: { partId: one.id, caret: 2, selEnd: 0 } });
    expect([at(f, 4, 2), at(f, 15, 2), at(f, 4, 9)]).toEqual([2, 2, 1]);
    expect(at(f, 16, 2)).toBe(1);

    const two = field({ content: "ab\ncd" });
    const g = draw(two, { editing: { partId: two.id, caret: 1, selEnd: 4 } });
    expect([at(g, 10, 2), at(g, 95, 2), at(g, 4, 18), at(g, 9, 18)]).toEqual([2, 2, 2, 2]);
    expect([at(g, 9, 2), at(g, 96, 2), at(g, 10, 18)]).toEqual([1, 1, 1]);
  });

  it("maps a click to the nearest caret index", () => {
    const part = field({ content: "ab\ncd" });
    const at2 = (x: number, y: number): number => fieldCaretIndexAt(part, part.content, x, y, { backend: stub });
    expect(at2(11, 5)).toBe(1);
    expect(at2(0, 5)).toBe(0);
    expect(at2(200, 20)).toBe(5);
    expect(at2(5, 300)).toBe(3);
    expect(at2(5, -50)).toBe(0);
    // Soft-wrapped line: the end index belongs to the next line, so clicks past the end stop before it.
    const narrow = field({ content: "aaaa bbbb", rect: { x: 0, y: 0, width: 38, height: 40 } });
    expect(fieldCaretIndexAt(narrow, narrow.content, 200, 5, { backend: stub })).toBe(4);
    expect(fieldCaretIndexAt(narrow, narrow.content, 200, 20, { backend: stub })).toBe(9);
  });
});

// Scrolling field at (0,0) 100x60: scrollbar left line x = 84, arrow boxes rows 0..15 and 44..59,
// track rows 16..43; text rect (4,2) 77x56; six lines -> 96 px of content, maxScroll 40.
describe("scrolling fields", () => {
  const part = field({ style: "scrolling", rect: { x: 0, y: 0, width: 100, height: 60 }, content: "1\n2\n3\n4\n5\n6" });

  it("draws the scrollbar, arrows, gray track and thumb at the top", () => {
    const f = draw(part);
    expect([at(f, 84, 30), at(f, 90, 15), at(f, 90, 44), at(f, 91, 3), at(f, 91, 55)]).toEqual([2, 2, 2, 2, 2]);
    expect([at(f, 90, 20), at(f, 90, 30)]).toEqual([1, 2]); // thumb rows 15..30
    expect([at(f, 91, 35), at(f, 90, 35)]).toEqual([2, 1]); // 50% gray track
    expect(at(f, 4, 9)).toBe(2); // first line visible
  });

  it("applies the UI scroll offset to the text and the thumb, clamped to the content", () => {
    const scrolled = createPartRasterizer({ textBackend: stub, scrollOffset: (id) => (id === part.id ? 1000 : 0) });
    const f = draw(part, {}, lightFrame(), scrolled);
    expect([at(f, 90, 20), at(f, 91, 20)]).toEqual([2, 1]); // track where the thumb was
    expect([at(f, 90, 29), at(f, 90, 44), at(f, 90, 35)]).toEqual([2, 2, 1]); // thumb rows 29..44
    expect(at(f, 4, 17)).toBe(2); // line "4" (top 2 + 48 - 40 = 10) glyph rows 17..22
    expect(at(f, 4, 9)).toBe(1);
    expect(at(draw(part), 4, 17)).toBe(1);
  });

  it("shows a light track without a thumb when nothing overflows", () => {
    const f = draw({ ...part, content: "1" });
    expect([at(f, 91, 35), at(f, 90, 20), at(f, 90, 30)]).toEqual([1, 1, 1]);
  });
});

// Spec 06 Requirement 4.8: the found-text box. Field at (0,0) 100x40, text rect from (4,2), 16-px
// lines; "a" covers columns 4..7 and "b" 10..13 on glyph rows 9..14.
describe("found-text box", () => {
  it("inverts a 1-px outline around a match on one line, leaving the inside and the glyphs as they are", () => {
    const part = field({ content: "ab" });
    const plain = draw(part);
    const f = draw(part, { found: { start: 0, end: 2 } });
    // Outline from (x0 - 1, top) = (3, 2) to (x1, top + 15) = (16, 17).
    for (const [x, y] of [[3, 2], [16, 2], [3, 17], [16, 17], [10, 2], [10, 17], [3, 10], [16, 10]]) expect(at(f, x, y), `${x},${y}`).toBe(2);
    for (const [x, y] of [[2, 2], [17, 2], [3, 18], [16, 1], [8, 9], [5, 5]]) expect(at(f, x, y), `${x},${y}`).toBe(1);
    expect(at(f, 4, 9)).toBe(2); // glyph untouched
    // Only the outline differs from the frame without a found text.
    let changed = 0;
    for (let i = 0; i < TOTAL_PIXELS; i++) if (f[i] !== plain[i]) changed++;
    expect(changed).toBe(2 * 14 + 2 * 14);
    // Inverting, not painting: on a dark pixel the outline is light.
    const dark = draw(field({ content: "ab", style: "transparent" }), { found: { start: 0, end: 2 } }, new Uint8Array(TOTAL_PIXELS).fill(2));
    expect([at(dark, 3, 2), at(dark, 16, 17), at(dark, 8, 8)]).toEqual([1, 1, 2]);
  });

  it("draws one box per line when the match continues onto the next line", () => {
    const part = field({ content: "ab\ncd" });
    const f = draw(part, { found: { start: 1, end: 4 } });
    // Line 1: from "b" (x 10) to the text rect's right edge (96); line 2: from its left edge (4) to after "c" (10).
    for (const [x, y] of [[9, 2], [96, 2], [9, 17], [96, 17], [9, 10], [96, 10]]) expect(at(f, x, y), `${x},${y}`).toBe(2);
    for (const [x, y] of [[3, 18], [10, 18], [3, 33], [10, 33], [3, 25], [10, 20]]) expect(at(f, x, y), `${x},${y}`).toBe(2);
    expect(at(f, 10, 25)).toBe(1); // the right column crosses "d" (columns 10..13): inverted to light
    for (const [x, y] of [[8, 2], [97, 2], [11, 18], [2, 18], [3, 34], [5, 20]]) expect(at(f, x, y), `${x},${y}`).toBe(1);
    expect(at(f, 4, 25)).toBe(2); // "c" untouched
  });

  it("follows the scroll offset of a scrolling field and is clipped to the text rect", () => {
    const part = field({ style: "scrolling", rect: { x: 0, y: 0, width: 100, height: 60 }, content: "1\n2\n3\n4\n5\n6" });
    const scrolled = createPartRasterizer({ textBackend: stub, scrollOffset: () => 40 });
    // Line "4" has its top at 2 + 48 - 40 = 10.
    const four = draw(part, { found: { start: 6, end: 7 } }, lightFrame(), scrolled);
    for (const [x, y] of [[3, 10], [10, 10], [3, 25], [10, 25], [3, 17]]) expect(at(four, x, y), `${x},${y}`).toBe(2);
    // Line "3" (top -6) is cut by the text rect: only its bottom row (9) shows, never the field frame.
    const plain = draw(part, {}, lightFrame(), scrolled);
    const three = draw(part, { found: { start: 4, end: 5 } }, lightFrame(), scrolled);
    expect(at(three, 6, 9)).toBe(2);
    for (const y of [0, 1]) for (let x = 0; x < 100; x++) expect(three[idx(x, y)]).toBe(plain[idx(x, y)]);
    // Line "1" is scrolled out of view: nothing is drawn.
    expect(draw(part, { found: { start: 0, end: 1 } }, lightFrame(), scrolled)).toEqual(plain);
  });

  it("is drawn only for the part composeFrame names", () => {
    const a = field({ id: "prt_a", content: "lamp" });
    const b = field({ id: "prt_b", content: "lamp", rect: { x: 0, y: 100, width: 100, height: 40 } });
    const seen: [string, unknown][] = [];
    composeFrame(makeStack([a, b]), "crd_1", { found: { partId: "prt_b", start: 0, end: 4 } }, (_frame, part, ctx) => void seen.push([part.id, ctx.found]));
    expect(seen).toEqual([["prt_a", undefined], ["prt_b", { start: 0, end: 4 }]]);
  });
});

describe("fieldScrollToIndex (spec 06 Requirement 4.10)", () => {
  // Text rect height 56, six 16-px lines, maxScroll 40.
  const part = field({ style: "scrolling", rect: { x: 0, y: 0, width: 100, height: 60 }, content: "1\n2\n3\n4\n5\n6" });
  const scrollFor = (index: number, scroll: number): number => fieldScrollToIndex(part, part.content, index, { scroll, backend: stub });

  it("keeps the offset while the line is fully visible and otherwise scrolls the line to the top, clamped", () => {
    expect(scrollFor(0, 0)).toBe(0);
    expect(scrollFor(4, 0)).toBe(0); // line 3: rows 32..47 of 56
    expect(scrollFor(6, 0)).toBe(40); // line 4 (top 48) is cut: min(maxScroll 40, 48)
    expect(scrollFor(10, 0)).toBe(40);
    expect(scrollFor(6, 40)).toBe(40);
    expect(scrollFor(0, 40)).toBe(0);
    expect(scrollFor(2, 1000)).toBe(16); // the requested offset is clamped to 40 first; line 2 (top 16) is above it
  });

  it("never scrolls a field of another style", () => {
    expect(fieldScrollToIndex({ ...part, style: "rectangle" }, part.content, 10, { backend: stub })).toBe(0);
  });
});

// Disabled parts (Requirement 3.4): text ink only where ((x + y) & 1) === 0, chrome unchanged.
describe("disabled parts", () => {
  const checker = (x: number, y: number): boolean => ((x + y) & 1) === 0;
  /** Cap on the mismatching pixels `expectDimmedFrames` lists in its failure message. */
  const MAX_REPORTED_MISMATCHES = 20;

  /** Draws the enabled (`on`), disabled (`off`) and text-less (`blank`) renderings of a part. */
  function dimmedFrames(enabledPart: HexPart, extra: Partial<PartDrawContext> = {}): { on: Uint8Array; off: Uint8Array; blank: Uint8Array } {
    const on = draw(enabledPart, extra);
    const off = draw({ ...enabledPart, enabled: false }, extra);
    const blank = draw({ ...enabledPart, ...(enabledPart.type === "button" ? { title: "" } : { content: "" }) } as HexPart, extra);
    return { on, off, blank };
  }

  /** Compares a disabled rendering against the enabled one, pixel by pixel. */
  function expectDimmed(enabledPart: HexPart, extra: Partial<PartDrawContext> = {}): void {
    const { on, off, blank } = dimmedFrames(enabledPart, extra);
    expectDimmedFrames(on, off, blank);
  }

  /**
   * Checks the dimming rule on three composed frames: chrome unchanged, ink kept only on the checkerboard.
   * The loop compares in plain code and the helper asserts 3 times in total, so it stays fast under load.
   */
  function expectDimmedFrames(on: Uint8Array, off: Uint8Array, blank: Uint8Array): void {
    const mismatches: Array<{ index: number; x: number; y: number; expected: number; actual: number | undefined }> = [];
    let inkKept = 0;
    let inkDropped = 0;
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      const x = i % BITMAP_WIDTH;
      const y = Math.floor(i / BITMAP_WIDTH);
      let expected: number;
      if (on[i] === blank[i]) {
        expected = on[i]; // frame, chrome and everything else unchanged
      } else if (checker(x, y)) {
        expected = on[i];
        inkKept++;
      } else {
        expected = blank[i];
        inkDropped++;
      }
      // `off[i]` is undefined past the end of a short array, so a short frame still mismatches.
      if (off[i] !== expected && mismatches.length < MAX_REPORTED_MISMATCHES) {
        mismatches.push({ index: i, x, y, expected, actual: off[i] });
      }
    }
    expect(mismatches).toEqual([]);
    expect(inkKept).toBeGreaterThan(0);
    expect(inkDropped).toBeGreaterThan(0);
  }

  it("dims a push button's title and keeps its border", () => expectDimmed(button()), HEAVY_TEST_TIMEOUT_MS);
  it("dims a pressed button's title inside the inverted interior", () => expectDimmed(button(), { pressed: true }), HEAVY_TEST_TIMEOUT_MS);
  it("dims a checkbox title and keeps the box and mark", () =>
    expectDimmed(button({ style: "checkBox", hilite: true, rect: { x: 0, y: 0, width: 80, height: 16 } })), HEAVY_TEST_TIMEOUT_MS);
  it("dims field text and keeps the frame, rules and scrollbar", () =>
    expectDimmed(field({ style: "scrolling", showLines: true, rect: { x: 0, y: 0, width: 100, height: 60 }, content: "ab\ncd" })), HEAVY_TEST_TIMEOUT_MS);
  it("dims field text but draws the caret normally", () => {
    const part = field({ content: "ab", enabled: false });
    const f = draw(part, { editing: { partId: part.id, caret: 1, selEnd: 1 } });
    expect([at(f, 9, 2), at(f, 9, 3), at(f, 9, 17)]).toEqual([2, 2, 2]);
  }, HEAVY_TEST_TIMEOUT_MS);

  it("leaves the enabled rendering unchanged", () => {
    const f = draw(field({ content: "ab cd" }));
    expect([at(f, 4, 9), at(f, 5, 9), at(f, 4, 10)]).toEqual([2, 2, 2]);
  }, HEAVY_TEST_TIMEOUT_MS);

  it("expectDimmed makes at most 3 expect calls", () => {
    const before = expect.getState().assertionCalls;
    expectDimmed(button());
    const after = expect.getState().assertionCalls;
    expect(after - before).toBeLessThanOrEqual(3);
  }, HEAVY_TEST_TIMEOUT_MS);

  // The four expectDimmed configurations above, as data for the preservation property.
  const DIMMED_CONFIGS: ReadonlyArray<{ part: HexPart; extra: Partial<PartDrawContext> }> = [
    { part: button(), extra: {} },
    { part: button(), extra: { pressed: true } },
    { part: button({ style: "checkBox", hilite: true, rect: { x: 0, y: 0, width: 80, height: 16 } }), extra: {} },
    { part: field({ style: "scrolling", showLines: true, rect: { x: 0, y: 0, width: 100, height: 60 }, content: "ab\ncd" }), extra: {} },
  ];
  type MutationKind = "chrome" | "keptInk" | "droppedInk";

  it("property: flipping one chrome, kept-ink or dropped-ink pixel of the disabled frame is rejected", () => {
    const frames = DIMMED_CONFIGS.map(({ part, extra }) => dimmedFrames(part, extra));
    /** Index of the k-th pixel of the given kind, in index order, or -1 if there are not that many. */
    const kthPixel = (config: number, kind: MutationKind, k: number): number => {
      const { on, blank } = frames[config];
      const { x: rx, y: ry, width, height } = DIMMED_CONFIGS[config].part.rect;
      let seen = 0;
      for (let i = 0; i < TOTAL_PIXELS; i++) {
        const x = i % BITMAP_WIDTH;
        const y = Math.floor(i / BITMAP_WIDTH);
        const isKind =
          kind === "chrome"
            ? on[i] === blank[i] && x >= rx && x < rx + width && y >= ry && y < ry + height
            : on[i] !== blank[i] && checker(x, y) === (kind === "keptInk");
        if (isKind && seen++ === k) return i;
      }
      return -1;
    };
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: DIMMED_CONFIGS.length - 1 }),
        fc.constantFrom<MutationKind>("chrome", "keptInk", "droppedInk"),
        fc.integer({ min: 0, max: 4 }),
        (config, kind, k) => {
          const { on, off, blank } = frames[config];
          const i = kthPixel(config, kind, k);
          expect(i).toBeGreaterThanOrEqual(0); // every configuration has at least 5 pixels of each kind
          const bad = off.slice();
          bad[i] = 3 - bad[i];
          expect(() => expectDimmedFrames(on, bad, blank)).toThrow();
        },
      ),
      { numRuns: 20 },
    );
  }, HEAVY_TEST_TIMEOUT_MS);

  it("rejects frames that keep and drop no text ink", () => {
    const f = draw(button());
    expect(() => expectDimmedFrames(f, f, f)).toThrow();
  }, HEAVY_TEST_TIMEOUT_MS);
});

describe("composeFrame default rasterizer", () => {
  it("draws parts with partRenderer when no rasterizer is passed", () => {
    const f = composeFrame(makeStack([button({ showName: false })]), "crd_1");
    expect([at(f, 10, 10), at(f, 12, 12)]).toEqual([2, 1]);
  });
});

describe("rasterizer invariants", () => {
  const buttonStyles: ButtonStyle[] = ["transparent", "opaque", "rectangle", "roundRect", "shadow", "checkBox", "radioButton", "default"];
  const fieldStyles: FieldStyle[] = ["transparent", "opaque", "rectangle", "shadow", "scrolling"];
  const rectArb = fc.record({
    x: fc.integer({ min: -40, max: BITMAP_WIDTH }),
    y: fc.integer({ min: -40, max: BITMAP_HEIGHT }),
    width: fc.integer({ min: 0, max: 120 }),
    height: fc.integer({ min: 0, max: 90 }),
  });
  const textArb = fc.stringMatching(/^[a-c \n]{0,24}$/);
  const partArb: fc.Arbitrary<HexPart> = fc.oneof(
    fc.record({ style: fc.constantFrom(...buttonStyles), rect: rectArb, title: textArb, showName: fc.boolean(), autoHilite: fc.boolean(), hilite: fc.boolean(), enabled: fc.boolean() })
      .map((p) => button(p)),
    fc.record({ style: fc.constantFrom(...fieldStyles), rect: rectArb, content: textArb, showLines: fc.boolean(), dontWrap: fc.boolean(), textAlign: fc.constantFrom("left" as const, "center" as const, "right" as const), enabled: fc.boolean() })
      .map((p) => field(p)),
  );

  it("property: writes only states 1/2 and only inside the part rect", () => {
    const base = new Uint8Array(TOTAL_PIXELS);
    for (let i = 0; i < TOTAL_PIXELS; i++) base[i] = ((i % BITMAP_WIDTH) * 7 + Math.floor(i / BITMAP_WIDTH) * 3) % 2 === 0 ? 1 : 2;
    fc.assert(
      fc.property(partArb, fc.boolean(), fc.nat(30), fc.nat(30), fc.nat(200), (part, pressed, caret, selEnd, scroll) => {
        const r = createPartRasterizer({ textBackend: stub, scrollOffset: () => scroll });
        const frame = base.slice();
        r(frame, part, ctxFor(part, { pressed, editing: { partId: part.id, caret, selEnd } }));
        const { x, y, width, height } = part.rect;
        for (let i = 0; i < TOTAL_PIXELS; i++) {
          const v = frame[i];
          if (v !== 1 && v !== 2) return false;
          const px = i % BITMAP_WIDTH;
          const py = Math.floor(i / BITMAP_WIDTH);
          const inside = px >= x && px < x + width && py >= y && py < y + height;
          if (!inside && v !== base[i]) return false;
        }
        return true;
      }),
      { numRuns: 60 },
    );
  }, HEAVY_TEST_TIMEOUT_MS);
});

describe("hitTest", () => {
  const p = (id: string, layerScope: HexPart["layerScope"], x: number, y: number, extra: Partial<HexButtonPart> = {}) =>
    button({ id, layerScope, rect: { x, y, width: 10, height: 10 }, ...extra });

  it("returns the topmost visible part: card before background, later entries first", () => {
    const stack = makeStack(
      [p("prt_c1", "card", 0, 0), p("prt_c2", "card", 5, 5), p("prt_hidden", "card", 0, 0, { visible: false })],
      [p("prt_b1", "background", 0, 0), p("prt_b2", "background", 20, 20)],
    );
    expect(hitTest(stack, "crd_1", 6, 6)?.id).toBe("prt_c2");
    expect(hitTest(stack, "crd_1", 1, 1)?.id).toBe("prt_c1");
    expect(hitTest(stack, "crd_1", 25, 25)?.id).toBe("prt_b2");
    expect(hitTest(stack, "crd_1", 10, 10)?.id).toBe("prt_c2");
    expect(hitTest(stack, "crd_1", 15, 15)).toBeNull(); // right/bottom edges are exclusive
    expect(hitTest(stack, "crd_1", 100, 100)).toBeNull();
  });

  it("divides pointer coordinates by the integer scale factor", () => {
    const stack = makeStack([p("prt_c", "card", 10, 10)]);
    expect(hitTest(stack, "crd_1", 20, 20, 2)?.id).toBe("prt_c");
    expect(hitTest(stack, "crd_1", 19, 20, 2)).toBeNull();
    expect(hitTest(stack, "crd_1", 59, 59, 3)?.id).toBe("prt_c");
    expect(hitTest(stack, "crd_1", 60, 60, 3)).toBeNull();
    expect(() => hitTest(stack, "crd_1", 0, 0, 1.5)).toThrow(/scale/);
    expect(() => hitTest(stack, "crd_nope", 0, 0)).toThrow(/not found/);
  });

  it("property: hitting pointer (x*k + dx, y*k + dy) equals hitting frame pixel (x, y)", () => {
    const partsArb = fc.array(
      fc.record({ x: fc.integer({ min: 0, max: 60 }), y: fc.integer({ min: 0, max: 60 }), w: fc.nat(30), h: fc.nat(30), visible: fc.boolean(), bg: fc.boolean() }),
      { maxLength: 8 },
    );
    fc.assert(
      fc.property(partsArb, fc.integer({ min: 1, max: 4 }), fc.nat(90), fc.nat(90), fc.nat(), fc.nat(), (specs, k, x, y, rx, ry) => {
        const parts = specs.map((s, i) =>
          button({ id: `prt_${i}`, layerScope: s.bg ? "background" : "card", rect: { x: s.x, y: s.y, width: s.w, height: s.h }, visible: s.visible }),
        );
        const stack = makeStack(parts.filter((q) => q.layerScope === "card"), parts.filter((q) => q.layerScope === "background"));
        const scaled = hitTest(stack, "crd_1", x * k + (rx % k), y * k + (ry % k), k);
        expect(scaled).toBe(hitTest(stack, "crd_1", x, y));
      }),
    );
  }, HEAVY_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// Button icons (spec 06 Requirement 9)
// ---------------------------------------------------------------------------------------------

function iconData(...dark: Array<[x: number, y: number]>): string {
  const pixels = new Uint8Array(ICON_PIXELS);
  for (const [x, y] of dark) pixels[y * 32 + x] = 1;
  return encodeIcon(pixels);
}
const CORNERS = iconData([0, 0], [31, 31]);
const FULL = encodeIcon(new Uint8Array(ICON_PIXELS).fill(1));
const ICON_STACK: HexStack = { ...makeStack(), customIcons: { corners: CORNERS, full: FULL } };
const drawIcon = (part: HexButtonPart, extra: Partial<PartDrawContext> = {}, frame = lightFrame()): Uint8Array =>
  draw(part, { stack: ICON_STACK, ...extra }, frame);

// A 60 x 60 rectangle at (0,0): inside box 1..58. Icon alone at (14,14); with a title line (16 px)
// the 48-px block starts at y 6, the icon at (14,6) and the title line at y 38 (glyph rows 45..50,
// "ab" at columns 24..27 and 30..33).
const iconButton = (extra: Partial<HexButtonPart> = {}): HexButtonPart =>
  button({ rect: { x: 0, y: 0, width: 60, height: 60 }, iconId: "corners", showName: false, ...extra });

describe("button icons: layout (Requirement 9.1)", () => {
  it("centres the icon alone when showName is false", () => {
    const f = drawIcon(iconButton());
    expect([at(f, 14, 14), at(f, 45, 45)]).toEqual([2, 2]);
    expect([at(f, 15, 14), at(f, 13, 14), at(f, 14, 13), at(f, 44, 45)]).toEqual([1, 1, 1, 1]);
  });

  it("centres the icon and one title line below it as one block", () => {
    const f = drawIcon(iconButton({ showName: true }));
    expect([at(f, 14, 6), at(f, 45, 37)]).toEqual([2, 2]);
    expect(at(f, 14, 14)).toBe(1);
    expect([at(f, 24, 45), at(f, 27, 50), at(f, 30, 45)]).toEqual([2, 2, 2]);
    expect(at(f, 24, 44)).toBe(1);
  });

  it("centres the icon alone when the title is empty", () => {
    expect(drawIcon(iconButton({ showName: true, title: "" }))).toEqual(drawIcon(iconButton()));
  });
});

describe("button icons: bits, clipping, hilite and dimming (Requirements 9.2-9.4)", () => {
  it("draws set bits dark and leaves clear bits showing the opaque face", () => {
    const under = lightFrame();
    under[idx(15, 14)] = 2; // a dark pixel under a clear bit
    const f = drawIcon(iconButton({ style: "opaque" }), {}, under);
    expect([at(f, 14, 14), at(f, 15, 14)]).toEqual([2, 1]);
  });

  it("leaves clear bits showing what lies under a transparent button", () => {
    const under = lightFrame();
    under[idx(15, 14)] = 2;
    const f = drawIcon(iconButton({ style: "transparent" }), {}, under);
    expect([at(f, 14, 14), at(f, 15, 14), at(f, 16, 14)]).toEqual([2, 2, 1]);
  });

  it("clips the icon to the inside area of a small button", () => {
    const f = drawIcon(iconButton({ iconId: "full", rect: { x: 10, y: 10, width: 20, height: 20 } }));
    expect([at(f, 11, 11), at(f, 28, 28)]).toEqual([2, 2]); // inside, under the icon
    expect([at(f, 9, 15), at(f, 30, 15), at(f, 15, 30), at(f, 15, 9)]).toEqual([1, 1, 1, 1]); // outside the rect
  });

  it("keeps the icon off the border and corners of a roundRect", () => {
    const f = drawIcon(iconButton({ iconId: "full", style: "roundRect", rect: { x: 0, y: 0, width: 30, height: 30 } }));
    expect([at(f, 0, 0), at(f, 1, 0), at(f, 0, 1)]).toEqual([1, 1, 1]); // outside the rounded corner
    expect(at(f, 15, 15)).toBe(2);
  });

  it("inverts the icon with the inside area when highlighted or pressed", () => {
    const hilite = drawIcon(iconButton({ hilite: true }));
    expect([at(hilite, 14, 14), at(hilite, 15, 14), at(hilite, 0, 0)]).toEqual([1, 2, 2]);
    expect(drawIcon(iconButton({ autoHilite: true }), { pressed: true })).toEqual(hilite);
  });

  it("dims a disabled button's icon through the 50% checkerboard", () => {
    const f = drawIcon(iconButton({ iconId: "full", enabled: false }));
    expect([at(f, 14, 14), at(f, 15, 15), at(f, 15, 14), at(f, 14, 15)]).toEqual([2, 2, 1, 1]);
  });

  it("decodes many different icons correctly (decode cache of 256 entries)", () => {
    for (let i = 0; i < 300; i++) {
      const x = i % 32;
      const y = Math.floor(i / 32);
      const stack = { ...ICON_STACK, customIcons: { one: iconData([x, y]) } };
      const f = draw(iconButton({ iconId: "one" }), { stack });
      expect(at(f, 14 + x, 14 + y)).toBe(2);
      expect(at(f, 14 + ((x + 1) % 32), 14 + y)).toBe(1);
    }
  }, HEAVY_TEST_TIMEOUT_MS);
});

// Digests of frames drawn by the renderer before spec 06 (commit 75f82b2), for every style and state.
const GOLDEN: Record<string, string> = {
  "transparent/plain": "f17fabcd", "transparent/pressed": "e1e58ebd", "transparent/hilite": "e1e58ebd",
  "transparent/disabled": "e6c55155", "transparent/noName": "8f1757c5", "transparent/small": "00ff3e15",
  "transparent/edge": "8f1757c5",
  "opaque/plain": "fed080b3", "opaque/pressed": "cad88a5f", "opaque/hilite": "cad88a5f", "opaque/disabled": "f492a033",
  "opaque/noName": "bcb47093", "opaque/small": "a5b9174f", "opaque/edge": "a2d372b5",
  "rectangle/plain": "fa967cef", "rectangle/pressed": "cad88a5f", "rectangle/hilite": "cad88a5f",
  "rectangle/disabled": "903db16f", "rectangle/noName": "c81be10f", "rectangle/small": "0a1ef719",
  "rectangle/edge": "97f841ae",
  "roundRect/plain": "599f294b", "roundRect/pressed": "cd964f67", "roundRect/hilite": "cd964f67",
  "roundRect/disabled": "63dd09cb", "roundRect/noName": "1191e56b", "roundRect/small": "0a1ef719",
  "roundRect/edge": "726c763a",
  "shadow/plain": "37013f53", "shadow/pressed": "e96f9163", "shadow/hilite": "e96f9163", "shadow/disabled": "0519fad3",
  "shadow/noName": "455fa1b3", "shadow/small": "4e92fad8", "shadow/edge": "97f841ae",
  "default/plain": "e658b55b", "default/pressed": "8f15374f", "default/hilite": "8f15374f", "default/disabled": "dc1ad4db",
  "default/noName": "a43ca53b", "default/small": "0a1ef719", "default/edge": "44c1dc29",
  "checkBox/plain": "0debe3c5", "checkBox/pressed": "8c71cf05", "checkBox/hilite": "80bbc9b5",
  "checkBox/disabled": "227b9241", "checkBox/noName": "b0c4fabd", "checkBox/small": "1e50d7cf",
  "checkBox/edge": "383a07c1",
  "radioButton/plain": "63e65190", "radioButton/pressed": "8f354e08", "radioButton/hilite": "c38feaa0",
  "radioButton/disabled": "f2364f98", "radioButton/noName": "aad5698c", "radioButton/small": "bfc92ba1",
  "radioButton/edge": "7d0113bf",
};
const GOLDEN_STYLES = ["transparent", "opaque", "rectangle", "roundRect", "shadow", "default", "checkBox", "radioButton"] as const;
const GOLDEN_VARIANTS: Record<string, Partial<HexButtonPart>> = {
  plain: {}, hilite: { hilite: true }, disabled: { enabled: false }, noName: { showName: false },
  small: { rect: { x: 300, y: 200, width: 14, height: 9 } }, edge: { rect: { x: 500, y: 330, width: 40, height: 30 } },
};
function goldenFrame(style: (typeof GOLDEN_STYLES)[number], variant: string, pressed: boolean, extra: Partial<HexButtonPart> = {}): Uint8Array {
  const part = button({ style, rect: { x: 100, y: 100, width: 90, height: 40 }, title: "Go on", ...GOLDEN_VARIANTS[variant], ...extra });
  const frame = new Uint8Array(TOTAL_PIXELS);
  for (let i = 0; i < frame.length; i++) frame[i] = ((i * 7) >> 3) % 3 === 0 ? 2 : 1;
  raster(frame, part, { stack: ICON_STACK, card: ICON_STACK.cards[0], text: part.title, pressed });
  return frame;
}
function digest(frame: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const v of frame) h = Math.imul(h ^ v, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}
const goldenCases = GOLDEN_STYLES.flatMap((style) =>
  Object.keys(GOLDEN_VARIANTS).flatMap((variant) => [
    { style, variant, pressed: false, key: `${style}/${variant}` },
    ...(variant === "plain" ? [{ style, variant, pressed: true, key: `${style}/pressed` }] : []),
  ]));

describe("button icons: unchanged frames (Requirements 9.5, 9.6)", () => {
  it("draws buttons without an iconId exactly as the renderer before spec 06", () => {
    for (const c of goldenCases) expect(digest(goldenFrame(c.style, c.variant, c.pressed)), c.key).toBe(GOLDEN[c.key]);
  }, HEAVY_TEST_TIMEOUT_MS);

  it("draws no icon on checkBox and radioButton buttons, which keep their iconId", () => {
    for (const c of goldenCases.filter((g) => g.style === "checkBox" || g.style === "radioButton")) {
      expect(digest(goldenFrame(c.style, c.variant, c.pressed, { iconId: "full" })), c.key).toBe(GOLDEN[c.key]);
    }
  }, HEAVY_TEST_TIMEOUT_MS);

  it("draws a button whose iconId names no stack icon as a button without one", () => {
    for (const iconId of ["missing", "toString"]) {
      expect(digest(goldenFrame("rectangle", "plain", false, { iconId })), iconId).toBe(GOLDEN["rectangle/plain"]);
    }
  });
});
