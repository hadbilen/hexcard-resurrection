import { beforeEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import type { HexButtonPart, HexCard, HexFieldPart, HexPart, HexStack } from "../../../core/schema.ts";
import { BITMAP_WIDTH, TOTAL_PIXELS, encodeBitmapRLE } from "../rleCodec.ts";
import {
  type PartRasterizer,
  clearDecodedLayerCache,
  composeFrame,
  computeIntegerScale,
  decodedLayerCacheSize,
  frameToImageData,
  packOpaqueColour,
} from "../bitmapCanvas.ts";

const idx = (x: number, y: number): number => y * BITMAP_WIDTH + x;

function layer(set: Array<[x: number, y: number, v: number]>, fill = 0): string {
  const p = new Uint8Array(TOTAL_PIXELS).fill(fill);
  for (const [x, y, v] of set) p[idx(x, y)] = v;
  return encodeBitmapRLE(p);
}

function button(id: string, layerScope: HexPart["layerScope"], x: number, y: number, extra: Partial<HexButtonPart> = {}): HexButtonPart {
  return {
    id, name: id, type: "button", layerScope, rect: { x, y, width: 4, height: 4 }, visible: true, enabled: true,
    scriptSource: "", style: "rectangle", title: `title ${id}`, showName: true, autoHilite: true, hilite: false, ...extra,
  };
}

function field(id: string, layerScope: HexPart["layerScope"], extra: Partial<HexFieldPart> = {}): HexFieldPart {
  return {
    id, name: id, type: "field", layerScope, rect: { x: 0, y: 0, width: 4, height: 4 }, visible: true, enabled: true,
    scriptSource: "", style: "rectangle", content: "shared", sharedText: false, lockText: false, dontWrap: false,
    showLines: false, textAlign: "left", textFont: "System", textSize: 12, textStyle: [], ...extra,
  };
}

function makeStack(opts: { bgData?: string; cardData?: string; bgParts?: HexPart[]; cardParts?: HexPart[]; bgFieldContents?: Record<string, string> } = {}): HexStack {
  const card: HexCard = {
    id: "crd_1", name: "One", backgroundId: "bkg_1",
    bitmap: { width: 512, height: 342, rleData: opts.cardData ?? "" },
    parts: opts.cardParts ?? [], bgFieldContents: opts.bgFieldContents ?? {},
    marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
  };
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Test", author: "Tester",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "AmberCRT", darkBitHex: "#1A1000", lightBitHex: "#FFB000" },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: { width: 512, height: 342, rleData: opts.bgData ?? "" }, parts: opts.bgParts ?? [], scriptSource: "", cantDelete: false }],
    cards: [card],
    customIcons: {}, scriptSource: "",
  };
}

/** Test rasterizer: fills each part's rect with dark pixels, and records the calls in order. */
function fillingRasterizer(calls: string[]): PartRasterizer {
  return (frame, part) => {
    calls.push(part.id);
    const { x, y, width, height } = part.rect;
    for (let yy = y; yy < y + height; yy++) for (let xx = x; xx < x + width; xx++) frame[idx(xx, yy)] = 2;
  };
}

beforeEach(() => clearDecodedLayerCache());

describe("composeFrame layer order", () => {
  it("returns only light pixels for an empty background and card", () => {
    const frame = composeFrame(makeStack(), "crd_1");
    expect(frame.length).toBe(TOTAL_PIXELS);
    expect(frame.every((v) => v === 1)).toBe(true);
  });

  it("treats background 0 pixels as light", () => {
    // Explicit background data with transparent pixels (a stray 0) plus one dark pixel.
    const frame = composeFrame(makeStack({ bgData: layer([[5, 5, 2]], 0) }), "crd_1");
    expect(frame[idx(5, 5)]).toBe(2);
    expect(frame[idx(0, 0)]).toBe(1);
    expect(frame.every((v) => v === 1 || v === 2)).toBe(true);
  });

  it("draws card bitmap pixels over the background bitmap, and leaves it visible where the card is 0", () => {
    const bgData = layer([[1, 1, 2], [2, 2, 2]], 1);
    const cardData = layer([[1, 1, 1], [3, 3, 2]]);
    const frame = composeFrame(makeStack({ bgData, cardData }), "crd_1");
    expect(frame[idx(1, 1)]).toBe(1); // card light covers background dark
    expect(frame[idx(2, 2)]).toBe(2); // card transparent shows background dark
    expect(frame[idx(3, 3)]).toBe(2); // card dark over background light
  });

  it("lets a card bitmap pixel cover a background part, and card parts cover the card bitmap", () => {
    const calls: string[] = [];
    const stack = makeStack({
      cardData: layer([[10, 10, 1], [21, 21, 1]]),
      bgParts: [button("prt_bg", "background", 10, 10)],
      cardParts: [button("prt_cd", "card", 20, 20)],
    });
    const frame = composeFrame(stack, "crd_1", {}, fillingRasterizer(calls));
    expect(calls).toEqual(["prt_bg", "prt_cd"]);
    expect(frame[idx(10, 10)]).toBe(1); // card picture above background button
    expect(frame[idx(11, 11)]).toBe(2); // rest of the background button
    expect(frame[idx(21, 21)]).toBe(2); // card button above card picture
  });

  it("draws parts in array order, background before card, and skips invisible parts", () => {
    const calls: string[] = [];
    const stack = makeStack({
      bgParts: [button("prt_b1", "background", 0, 0), button("prt_hidden", "background", 0, 0, { visible: false }), button("prt_b2", "background", 0, 0)],
      cardParts: [button("prt_c1", "card", 0, 0), button("prt_c2", "card", 0, 0)],
    });
    composeFrame(stack, "crd_1", {}, fillingRasterizer(calls));
    expect(calls).toEqual(["prt_b1", "prt_b2", "prt_c1", "prt_c2"]);
  });

  it("passes the §5.6 field text, pressed and editing state to the rasterizer", () => {
    const seen: Record<string, { text: string; pressed: boolean; editing: unknown }> = {};
    const stack = makeStack({
      bgParts: [field("prt_own", "background"), field("prt_missing", "background"), field("prt_shared", "background", { sharedText: true })],
      cardParts: [field("prt_card", "card", { content: "card text" }), button("prt_btn", "card", 0, 0)],
      bgFieldContents: { prt_own: "per card" },
    });
    const editing = { partId: "prt_card", caret: 2, selEnd: 4 };
    composeFrame(stack, "crd_1", { editing, pressedPartId: "prt_btn" }, (_f, part, ctx) => {
      seen[part.id] = { text: ctx.text, pressed: ctx.pressed, editing: ctx.editing };
    });
    expect(seen.prt_own.text).toBe("per card");
    expect(seen.prt_missing.text).toBe("");
    expect(seen.prt_shared.text).toBe("shared");
    expect(seen.prt_card).toEqual({ text: "card text", pressed: false, editing });
    expect(seen.prt_btn).toEqual({ text: "title prt_btn", pressed: true, editing: undefined });
  });

  it("throws for an unknown card or a missing background", () => {
    const stack = makeStack();
    expect(() => composeFrame(stack, "crd_nope")).toThrow(/not found/);
    const orphan = { ...stack, cards: [{ ...stack.cards[0], backgroundId: "bkg_nope" }] };
    expect(() => composeFrame(orphan, "crd_1")).toThrow(/not found/);
  });
});

describe("decoded-layer cache", () => {
  it("reuses decoded layers, re-decodes on rleData change, and never leaks frame writes into the cache", () => {
    const stack = makeStack({ bgData: layer([[0, 0, 2]], 1) });
    const first = composeFrame(stack, "crd_1");
    expect(decodedLayerCacheSize()).toBe(2);
    first.fill(2); // mutating a returned frame must not affect the next one
    const second = composeFrame(stack, "crd_1");
    expect(second[idx(1, 1)]).toBe(1);
    expect(decodedLayerCacheSize()).toBe(2);

    const changed = { ...stack, backgrounds: [{ ...stack.backgrounds[0], bitmap: { ...stack.backgrounds[0].bitmap, rleData: layer([[1, 1, 2]], 1) } }] };
    const third = composeFrame(changed, "crd_1");
    expect(third[idx(0, 0)]).toBe(1);
    expect(third[idx(1, 1)]).toBe(2);
    expect(decodedLayerCacheSize()).toBe(2); // the slot is replaced, not added
  });

  it("does not let a part rasterizer write into cached layers", () => {
    const stack = makeStack({ bgParts: [button("prt_bg", "background", 0, 0)] });
    composeFrame(stack, "crd_1", {}, fillingRasterizer([]));
    expect(composeFrame(stack, "crd_1")[idx(0, 0)]).toBe(1);
  });
});

describe("frameToImageData", () => {
  it("packs colours in ImageData RGBA byte order", () => {
    const word = new Uint32Array([packOpaqueColour("#FFB000")]);
    expect([...new Uint8Array(word.buffer)]).toEqual([0xff, 0xb0, 0x00, 0xff]);
    expect(packOpaqueColour("#ffb000")).toBe(word[0]);
    expect(() => packOpaqueColour("#FFF")).toThrow(/#RRGGBB/);
  });

  it("maps 1 to lightBitHex and 2 to darkBitHex", () => {
    const frame = new Uint8Array(TOTAL_PIXELS).fill(1);
    frame[0] = 2;
    frame[TOTAL_PIXELS - 1] = 2;
    const data = new Uint8ClampedArray(TOTAL_PIXELS * 4); // stands in for ImageData.data
    frameToImageData(frame, { darkBitHex: "#1A1000", lightBitHex: "#FFB000" }, new Uint32Array(data.buffer));
    expect([...data.subarray(0, 8)]).toEqual([0x1a, 0x10, 0x00, 0xff, 0xff, 0xb0, 0x00, 0xff]);
    expect([...data.subarray(data.length - 4)]).toEqual([0x1a, 0x10, 0x00, 0xff]);
  });

  it("rejects wrong lengths and states other than 1 and 2", () => {
    const palette = { darkBitHex: "#000000", lightBitHex: "#FFFFFF" };
    const out = new Uint32Array(TOTAL_PIXELS);
    expect(() => frameToImageData(new Uint8Array(10), palette, out)).toThrow(/pixels/);
    expect(() => frameToImageData(new Uint8Array(TOTAL_PIXELS).fill(1), palette, new Uint32Array(10))).toThrow(/pixels/);
    expect(() => frameToImageData(new Uint8Array(TOTAL_PIXELS), palette, out)).toThrow(/state 0/);
  });
});

describe("computeIntegerScale", () => {
  it("picks the largest integer factor that fits, at least 1", () => {
    expect(computeIntegerScale(512, 342)).toBe(1);
    expect(computeIntegerScale(1920, 1080)).toBe(3);
    expect(computeIntegerScale(1024, 683)).toBe(1);
    expect(computeIntegerScale(100, 100)).toBe(1);
    expect(computeIntegerScale(Number.NaN, 1000)).toBe(1);
  });

  it("never exceeds the available space when k > 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10000 }), fc.integer({ min: 0, max: 10000 }), (w, h) => {
        const k = computeIntegerScale(w, h);
        expect(Number.isInteger(k) && k >= 1).toBe(true);
        if (k > 1) expect(512 * k <= w && 342 * k <= h).toBe(true);
        expect(512 * (k + 1) > w || 342 * (k + 1) > h).toBe(true);
      }),
    );
  });
});
