import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { ButtonStyle, FieldStyle, HexButtonPart, HexCard, HexFieldPart, HexPart, HexStack } from "../../../core/schema.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS } from "../rleCodec.ts";
import { type PartDrawContext, clearDecodedLayerCache, composeFrame } from "../bitmapCanvas.ts";
import type { TextRasterBackend } from "../textRaster.ts";
import { createPartRasterizer, fieldCaretIndexAt, hitTest } from "../partRenderer.ts";

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

// Disabled parts (Requirement 3.4): text ink only where ((x + y) & 1) === 0, chrome unchanged.
describe("disabled parts", () => {
  const checker = (x: number, y: number): boolean => ((x + y) & 1) === 0;

  /** Compares a disabled rendering against the enabled one, pixel by pixel. */
  function expectDimmed(enabledPart: HexPart, extra: Partial<PartDrawContext> = {}): void {
    const on = draw(enabledPart, extra);
    const off = draw({ ...enabledPart, enabled: false }, extra);
    const blank = draw({ ...enabledPart, ...(enabledPart.type === "button" ? { title: "" } : { content: "" }) } as HexPart, extra);
    let inkKept = 0;
    let inkDropped = 0;
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      const x = i % BITMAP_WIDTH;
      const y = Math.floor(i / BITMAP_WIDTH);
      if (on[i] === blank[i]) {
        expect(off[i]).toBe(on[i]); // frame, chrome and everything else unchanged
      } else if (checker(x, y)) {
        expect(off[i]).toBe(on[i]);
        inkKept++;
      } else {
        expect(off[i]).toBe(blank[i]);
        inkDropped++;
      }
    }
    expect(inkKept).toBeGreaterThan(0);
    expect(inkDropped).toBeGreaterThan(0);
  }

  it("dims a push button's title and keeps its border", () => expectDimmed(button()));
  it("dims a pressed button's title inside the inverted interior", () => expectDimmed(button(), { pressed: true }));
  it("dims a checkbox title and keeps the box and mark", () =>
    expectDimmed(button({ style: "checkBox", hilite: true, rect: { x: 0, y: 0, width: 80, height: 16 } })));
  it("dims field text and keeps the frame, rules and scrollbar", () =>
    expectDimmed(field({ style: "scrolling", showLines: true, rect: { x: 0, y: 0, width: 100, height: 60 }, content: "ab\ncd" })));
  it("dims field text but draws the caret normally", () => {
    const part = field({ content: "ab", enabled: false });
    const f = draw(part, { editing: { partId: part.id, caret: 1, selEnd: 1 } });
    expect([at(f, 9, 2), at(f, 9, 3), at(f, 9, 17)]).toEqual([2, 2, 2]);
  });

  it("leaves the enabled rendering unchanged", () => {
    const f = draw(field({ content: "ab cd" }));
    expect([at(f, 4, 9), at(f, 5, 9), at(f, 4, 10)]).toEqual([2, 2, 2]);
  });
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
  });
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
  });
});
