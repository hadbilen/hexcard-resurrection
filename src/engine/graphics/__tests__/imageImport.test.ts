/**
 * Spec 06 Import Image (Requirements 6.4-6.10): header sizes, file checks, limits, the pixel
 * mapping on both edit layers and the one "Import Image" history command. The browser decoder
 * is replaced by a function returning a given RGBA image (the `decode` injection point).
 */
import { describe, expect, it } from "vitest";
import { createHistory } from "../../../core/history.ts";
import { parseHexTalk } from "../../../core/parser.ts";
import type { HexStack } from "../../../core/schema.ts";
import { validateStack } from "../../../core/stackValidator.ts";
import { createHexStore, type HexLayer } from "../../../core/store.ts";
import type { RgbaImage } from "../atkinsonDither.ts";
import {
  createImportImageCommand,
  IMAGE_IMPORT_MAX_BYTES,
  IMPORT_LIMITS,
  IMPORT_MESSAGES,
  importDroppedImage,
  importImageFile,
  importRect,
  readImageHeader,
  withinImportLimits,
  type ImageFileLike,
} from "../imageImport.ts";
import { BITMAP_WIDTH, decodeBitmapRLE, encodeBitmapRLE, TOTAL_PIXELS } from "../rleCodec.ts";

// ---------------------------------------------------------------------------------------------
// Hand-built headers
// ---------------------------------------------------------------------------------------------

const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));
const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
const be16 = (v: number) => [(v >> 8) & 0xff, v & 0xff];
const le24 = (v: number) => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const le32 = (v: number) => [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
const be32 = (v: number) => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const bytes = (...parts: (number | number[])[]) => Uint8Array.from(parts.flat());

const png = (w: number, h: number) => bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, be32(13), ascii("IHDR"), be32(w), be32(h));
const gif = (w: number, h: number, version = "89a") => bytes(ascii(`GIF${version}`), le16(w), le16(h));
const bmpInfo = (w: number, h: number) => bytes(ascii("BM"), new Array(12).fill(0), le32(40), le32(w), le32(h));
const bmpCore = (w: number, h: number) => bytes(ascii("BM"), new Array(12).fill(0), le32(12), le16(w), le16(h));
/** SOI, APP0, a DHT (C4, not a frame), fill bytes, then a progressive SOF2 ending right after the width. */
const jpeg = (w: number, h: number) => bytes(
  0xff, 0xd8,
  0xff, 0xe0, be16(16), ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0,
  0xff, 0xc4, be16(4), 0, 0,
  0xff, 0xff,
  0xff, 0xc2, be16(17), 8, be16(h), be16(w),
);
const riff = (chunk: string, body: number[]) => bytes(ascii("RIFF"), le32(4 + 8 + body.length), ascii("WEBP"), ascii(chunk), le32(body.length), body);
const webpLossy = (w: number, h: number) => riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)]);
const webpLossless = (w: number, h: number) => riff("VP8L", [0x2f, ...le32(((w - 1) | ((h - 1) << 14)) >>> 0)]);
const webpExtended = (w: number, h: number) => riff("VP8X", [0, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)]);

describe("readImageHeader", () => {
  const cases: [string, (w: number, h: number) => Uint8Array, string][] = [
    ["PNG", png, "image/png"],
    ["GIF89a", gif, "image/gif"],
    ["GIF87a", (w, h) => gif(w, h, "87a"), "image/gif"],
    ["BMP (BITMAPINFOHEADER)", bmpInfo, "image/bmp"],
    ["BMP (BITMAPCOREHEADER)", bmpCore, "image/bmp"],
    ["JPEG", jpeg, "image/jpeg"],
    ["WebP VP8", webpLossy, "image/webp"],
    ["WebP VP8L", webpLossless, "image/webp"],
    ["WebP VP8X", webpExtended, "image/webp"],
  ];

  it("reads the format and size of every supported header", () => {
    for (const [name, make, type] of cases) {
      expect(readImageHeader(make(640, 480)), name).toEqual({ type, width: 640, height: 480 });
      expect(readImageHeader(make(1, 3)), name).toEqual({ type, width: 1, height: 3 });
    }
    expect(readImageHeader(png(8192, 2048))).toEqual({ type: "image/png", width: 8192, height: 2048 });
    expect(readImageHeader(webpExtended(16_384, 9000))).toEqual({ type: "image/webp", width: 16_384, height: 9000 });
  });

  it("returns null for a header cut short by one byte", () => {
    for (const [name, make] of cases) {
      const full = make(64, 32);
      expect(readImageHeader(full.subarray(0, full.length - 1)), name).toBeNull();
    }
  });

  it("returns null for a zero width or height", () => {
    for (const [name, make] of cases.filter(([n]) => !n.includes("VP8L") && !n.includes("VP8X"))) {
      expect(readImageHeader(make(0, 10)), name).toBeNull();
      expect(readImageHeader(make(10, 0)), name).toBeNull();
    }
  });

  it("takes the absolute height of a top-down BMP and masks the VP8 scale bits", () => {
    expect(readImageHeader(bmpInfo(20, -30))).toEqual({ type: "image/bmp", width: 20, height: 30 });
    expect(readImageHeader(bmpInfo(-20, 30))).toBeNull();
    expect(readImageHeader(webpLossy(100 | 0x4000, 50 | 0x8000))).toEqual({ type: "image/webp", width: 100, height: 50 });
  });

  it("rejects unknown signatures, SVG text, a PNG without IHDR and a JPEG without a frame", () => {
    expect(readImageHeader(new Uint8Array(0))).toBeNull();
    expect(readImageHeader(bytes(ascii('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>')))).toBeNull();
    const noIhdr = png(10, 10);
    noIhdr.set(ascii("IDAT"), 12);
    expect(readImageHeader(noIhdr)).toBeNull();
    expect(readImageHeader(bytes(0xff, 0xd8, 0xff, 0xd9))).toBeNull();
    expect(readImageHeader(bytes(0xff, 0xd8, 0x00, 0x00, 0x00))).toBeNull();
    expect(readImageHeader(riff("ALPH", [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
  });
});

describe("limits and the image rectangle", () => {
  it("accepts at most 8192 pixels per side and 16,777,216 pixels in all", () => {
    expect(withinImportLimits(8192, 2048)).toBe(true);
    expect(withinImportLimits(4096, 4096)).toBe(true);
    expect(withinImportLimits(8192, 2049)).toBe(false);
    expect(withinImportLimits(8193, 1)).toBe(false);
    expect(withinImportLimits(1, 8193)).toBe(false);
    expect(withinImportLimits(0, 1)).toBe(false);
    expect(withinImportLimits(1.5, 1)).toBe(false);
  });

  it("is the aspect-fit rectangle, centred with floor offsets", () => {
    expect(importRect(512, 342)).toEqual({ x: 0, y: 0, width: 512, height: 342 });
    expect(importRect(100, 100)).toEqual({ x: 85, y: 0, width: 342, height: 342 });
    expect(importRect(2, 1)).toEqual({ x: 0, y: 43, width: 512, height: 256 });
  });
});

// ---------------------------------------------------------------------------------------------
// Import through a real store and history
// ---------------------------------------------------------------------------------------------

const layer = (fill: number): string => encodeBitmapRLE(new Uint8Array(TOTAL_PIXELS).fill(fill));

function makeStack(cardRle: string, backgroundRle: string): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: { width: 512, height: 342, rleData: backgroundRle }, parts: [], scriptSource: "", cantDelete: false }],
    cards: [{
      id: "crd_1", name: "One", backgroundId: "bkg_1", bitmap: { width: 512, height: 342, rleData: cardRle }, parts: [],
      bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
    }],
    customIcons: {}, scriptSource: "",
  };
}

/** Left half black, right half white (solid colours dither to exactly dark and light). */
function halves(w: number, h: number): RgbaImage {
  const data = new Uint8Array(w * h * 4).fill(255);
  for (let y = 0; y < h; y++) for (let x = 0; x < w / 2; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}
const solid = (w: number, h: number, v: number): RgbaImage => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(v).map((c, i) => (i % 4 === 3 ? 255 : c)) });

function fileOf(content: Uint8Array, type = "image/png", size = content.length) {
  const record = { reads: 0 };
  const file: ImageFileLike = {
    type,
    size,
    arrayBuffer: async () => {
      record.reads++;
      return content.slice().buffer;
    },
  };
  return { file, record };
}

function setup(cardRle = "", backgroundRle = "", editLayer: HexLayer = "card") {
  const store = createHexStore({ stack: makeStack(cardRle, backgroundRle), compile: parseHexTalk });
  store.setTool("pencil");
  store.setEditLayer(editLayer);
  const history = createHistory(store);
  const alerts: string[] = [];
  const decoded: { type: string; limits: unknown }[] = [];
  const deps = (image: RgbaImage | (() => never)) => ({
    store,
    history,
    alert: (message: string) => void alerts.push(message),
    decode: async (blob: Blob, limits: unknown) => {
      decoded.push({ type: blob.type, limits });
      return typeof image === "function" ? image() : image;
    },
  });
  const pixels = (which: HexLayer): Uint8Array => {
    const { stack } = store.getSnapshot();
    const rle = which === "card" ? stack.cards[0].bitmap.rleData : stack.backgrounds[0].bitmap.rleData;
    return decodeBitmapRLE(rle, which === "card" ? 0 : 1);
  };
  return { store, history, alerts, decoded, deps, pixels };
}

describe("importImageFile: file checks (Requirements 6.4, 6.5, 6.10)", () => {
  it("rejects a type other than PNG, JPEG, GIF, WebP and BMP without reading the file", async () => {
    for (const type of ["image/svg+xml", "text/plain", "", "image/tiff"]) {
      const t = setup();
      const { file, record } = fileOf(png(4, 4), type);
      expect(await importImageFile(file, t.deps(solid(4, 4, 0)))).toBe(false);
      expect(t.alerts).toEqual([IMPORT_MESSAGES.type]);
      expect(record.reads).toBe(0);
      expect(t.history.canUndo()).toBe(false);
    }
  });

  it("rejects a file over 16 MiB without reading it", async () => {
    const t = setup();
    const { file, record } = fileOf(png(4, 4), "image/png", IMAGE_IMPORT_MAX_BYTES + 1);
    expect(await importImageFile(file, t.deps(solid(4, 4, 0)))).toBe(false);
    expect(t.alerts).toEqual(["This image file is larger than 16 MB."]);
    expect(record.reads).toBe(0);
  });

  it("rejects bytes without a supported header, and a header over the limits, before decoding", async () => {
    const t = setup();
    expect(await importImageFile(fileOf(bytes(1, 2, 3, 4, 5)).file, t.deps(solid(4, 4, 0)))).toBe(false);
    expect(await importImageFile(fileOf(png(8193, 1)).file, t.deps(solid(4, 4, 0)))).toBe(false);
    expect(await importImageFile(fileOf(gif(8192, 2049), "image/gif").file, t.deps(solid(4, 4, 0)))).toBe(false);
    expect(t.alerts).toEqual([IMPORT_MESSAGES.unreadable, IMPORT_MESSAGES.dimensions, IMPORT_MESSAGES.dimensions]);
    expect(t.decoded).toEqual([]);
  });

  it("maps a decoder RangeError and an oversized decoded image to the size alert, any other failure to unreadable", async () => {
    const t = setup();
    const before = t.store.getSnapshot().stack;
    await importImageFile(fileOf(png(4, 4)).file, t.deps(() => {
      throw new RangeError("too big");
    }));
    await importImageFile(fileOf(png(4, 4)).file, t.deps(solid(8193, 1, 0)));
    await importImageFile(fileOf(png(4, 4)).file, t.deps(() => {
      throw new Error("corrupt");
    }));
    expect(t.alerts).toEqual([IMPORT_MESSAGES.dimensions, IMPORT_MESSAGES.dimensions, IMPORT_MESSAGES.unreadable]);
    expect(t.store.getSnapshot().stack).toBe(before);
    expect(t.history.canUndo()).toBe(false);
  });

  it("decodes by the header's own type with the import limits (a renamed file)", async () => {
    const t = setup();
    expect(await importImageFile(fileOf(png(2, 1), "image/jpeg").file, t.deps(halves(2, 1)))).toBe(true);
    expect(t.decoded).toEqual([{ type: "image/png", limits: IMPORT_LIMITS }]);
    expect(IMPORT_LIMITS).toEqual({ maxSide: 8192, maxPixels: 16_777_216 });
  });
});

describe("importImageFile: pixels and history (Requirements 6.7-6.9)", () => {
  const RECT = importRect(2, 1); // { x: 0, y: 43, width: 512, height: 256 }
  const inRect = (i: number): boolean => {
    const x = i % BITMAP_WIDTH;
    const y = (i - x) / BITMAP_WIDTH;
    return x >= RECT.x && x < RECT.x + RECT.width && y >= RECT.y && y < RECT.y + RECT.height;
  };
  const expected = (i: number): number => ((i % BITMAP_WIDTH) < 256 ? 2 : 1);

  it("writes dark as 2 and light as 1 on a transparent card layer; outside the rectangle stays transparent", async () => {
    const backgroundRle = layer(2);
    const t = setup("", backgroundRle, "card");
    expect(await importImageFile(fileOf(png(2, 1)).file, t.deps(halves(2, 1)))).toBe(true);
    const card = t.pixels("card");
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      if (inRect(i)) expect(card[i]).toBe(expected(i));
      else if (card[i] !== 0) throw new Error(`pixel ${i} outside the rectangle changed to ${card[i]}`);
    }
    expect(t.store.getSnapshot().stack.backgrounds[0].bitmap.rleData).toBe(backgroundRle);
    expect(t.history.undoLabel()).toBe("Import Image");
    expect(validateStack(t.store.getSnapshot().stack).ok).toBe(true);
  });

  it("writes into the background layer in Edit Background mode and leaves the card layer alone", async () => {
    const cardRle = layer(0);
    const t = setup(cardRle, "", "background");
    expect(await importImageFile(fileOf(png(2, 1)).file, t.deps(halves(2, 1)))).toBe(true);
    const background = t.pixels("background");
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      const want = inRect(i) ? expected(i) : 1;
      if (background[i] !== want) throw new Error(`background pixel ${i} is ${background[i]}, expected ${want}`);
    }
    expect(t.store.getSnapshot().stack.cards[0].bitmap.rleData).toBe(cardRle);
    t.history.undo();
    expect(t.store.getSnapshot().stack.backgrounds[0].bitmap.rleData).toBe("");
  });

  it("keeps the margin of a narrow image untouched and undoes to the exact rleData", async () => {
    const cardRle = layer(2);
    const t = setup(cardRle);
    expect(await importImageFile(fileOf(png(1, 1)).file, t.deps(solid(1, 1, 255)))).toBe(true);
    const rect = importRect(1, 1); // x 85..426
    const card = t.pixels("card");
    for (let y = 0; y < 342; y++) {
      for (let x = 0; x < 512; x++) {
        const inside = x >= rect.x && x < rect.x + rect.width;
        if (card[y * 512 + x] !== (inside ? 1 : 2)) throw new Error(`pixel (${x}, ${y}) is ${card[y * 512 + x]}`);
      }
    }
    t.history.undo();
    expect(t.store.getSnapshot().stack.cards[0].bitmap.rleData).toBe(cardRle);
    t.history.redo();
    expect(t.pixels("card")[200 * 512 + 200]).toBe(1);
  });

  it("records nothing when the import changes no pixel", async () => {
    const t = setup(layer(2));
    const before = t.store.getSnapshot().stack;
    expect(await importImageFile(fileOf(png(512, 342)).file, t.deps(solid(512, 342, 0)))).toBe(false);
    expect(t.store.getSnapshot().stack).toBe(before);
    expect(t.history.canUndo()).toBe(false);
    expect(t.alerts).toEqual([]);
  });

  it("createImportImageCommand rejects an imported buffer of the wrong size", () => {
    const t = setup();
    expect(() => createImportImageCommand(t.store.getSnapshot(), new Uint8Array(10), RECT)).toThrow();
  });
});

describe("importDroppedImage (Requirements 6.2, 6.3)", () => {
  it("alerts and reads nothing without a paint tool", async () => {
    for (const tool of ["browse", "button", "field"] as const) {
      const t = setup();
      t.store.setTool(tool);
      const { file, record } = fileOf(png(2, 1));
      expect(await importDroppedImage(file, t.deps(halves(2, 1)))).toBe(false);
      expect(t.alerts).toEqual(["Choose a paint tool to import an image."]);
      expect(record.reads).toBe(0);
      expect(t.history.canUndo()).toBe(false);
    }
  });

  it("imports with any paint tool", async () => {
    for (const tool of ["select", "lasso", "brush", "eraser", "line", "spray", "rect", "paintBucket", "pencil"] as const) {
      const t = setup();
      t.store.setTool(tool);
      expect(await importDroppedImage(fileOf(png(2, 1)).file, t.deps(halves(2, 1))), tool).toBe(true);
      expect(t.history.undoLabel()).toBe("Import Image");
    }
  });
});
