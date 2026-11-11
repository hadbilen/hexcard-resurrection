/// <reference types="node" />
// Spec 07 task 4.1: the TrueType reader and the pixel-centre rasterizer (Requirements 10.1, 10.6;
// design §trueType.ts, D13).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FONT_FILES, TEXT_SIZE_TABLE, tableFontFiles, type FontFileName } from "../../engine/graphics/textRaster.ts";
import { MAX_COMPOSITE_DEPTH, TrueTypeError, fillOutline, parseTrueType, type GlyphOutline } from "../trueType.ts";

const fileBytes = (file: FontFileName): Uint8Array => new Uint8Array(readFileSync(new URL(`../../../public/fonts/${file}`, import.meta.url)));
const FILES = tableFontFiles();
const FONTS = new Map(FILES.map((file) => [file, parseTrueType(fileBytes(file))]));
const font = (file: FontFileName) => FONTS.get(file)!;

/** The render sizes TEXT_SIZE_TABLE uses for a file. */
function renderSizes(file: FontFileName): number[] {
  const sizes = new Set<number>();
  for (const entries of Object.values(TEXT_SIZE_TABLE)) {
    for (const entry of Object.values(entries)) if (entry.file === file || entry.boldFile === file) sizes.add(entry.renderSize);
  }
  return [...sizes].sort((a, b) => a - b);
}

/** Minimal raw reads of a font file, independent of trueType.ts. */
function rawTables(bytes: Uint8Array): { view: DataView; table: (tag: string) => number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tables = new Map<string, number>();
  for (let i = 0; i < view.getUint16(4); i++) {
    const record = 12 + i * 16;
    tables.set(String.fromCharCode(...[0, 1, 2, 3].map((k) => view.getUint8(record + k))), view.getUint32(record + 8));
  }
  return { view, table: (tag) => tables.get(tag)! };
}

/** Offsets of every component of every composite glyph, read directly from glyf. */
function componentOffsets(bytes: Uint8Array): { dx: number; dy: number; flags: number }[] {
  const { view, table } = rawTables(bytes);
  const numGlyphs = view.getUint16(table("maxp") + 4);
  const longLoca = view.getInt16(table("head") + 50) === 1;
  const loca = (g: number): number => (longLoca ? view.getUint32(table("loca") + g * 4) : view.getUint16(table("loca") + g * 2) * 2);
  const offsets: { dx: number; dy: number; flags: number }[] = [];
  for (let g = 0; g < numGlyphs; g++) {
    if (loca(g + 1) === loca(g)) continue;
    let p = table("glyf") + loca(g);
    if (view.getInt16(p) >= 0) continue;
    p += 10;
    for (;;) {
      const flags = view.getUint16(p);
      p += 4;
      const words = (flags & 1) !== 0;
      const dx = words ? view.getInt16(p) : view.getInt8(p);
      const dy = words ? view.getInt16(p + 2) : view.getInt8(p + 1);
      p += words ? 4 : 2;
      p += flags & 0x8 ? 2 : flags & 0x40 ? 4 : flags & 0x80 ? 8 : 0;
      offsets.push({ dx, dy, flags });
      if (!(flags & 0x20)) break;
    }
  }
  return offsets;
}

/** The contour points of an outline as [x, y] pairs. */
const points = (outline: GlyphOutline): number[][] =>
  outline.contours.map((c) => Array.from({ length: c.length / 2 }, (_, i) => [c[i * 2], c[i * 2 + 1]])).flat();

/** Rows of `#` and `.` for the inked part of an alpha surface. */
function inkRows(alpha: Uint8Array, width: number): string[] {
  const rows: string[] = [];
  for (let y = 0; y * width < alpha.length; y++) {
    const row = Array.from(alpha.subarray(y * width, (y + 1) * width), (a) => (a >= 128 ? "#" : ".")).join("");
    if (row.includes("#")) rows.push(`${y}:${row}`);
  }
  return rows;
}

// ---------------------------------------------------------------------------------------------
// A tiny TrueType writer for inputs outside the bundled fonts' subset.
// ---------------------------------------------------------------------------------------------

class Bytes {
  readonly out: number[] = [];
  u8(v: number): this {
    this.out.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v >> 8).u8(v);
  }
  u32(v: number): this {
    return this.u16(Math.floor(v / 0x10000)).u16(v & 0xffff);
  }
  bytes(b: readonly number[]): this {
    this.out.push(...b);
    return this;
  }
}

/** A simple glyph from contours of [x, y] points, every point on-curve unless listed in `offCurve`. */
function simpleGlyph(contours: number[][][], offCurve: ReadonlySet<number> = new Set()): number[] {
  const b = new Bytes().u16(contours.length).u16(0).u16(0).u16(0).u16(0);
  let end = -1;
  for (const contour of contours) b.u16((end += contour.length));
  b.u16(0); // no instructions
  const all = contours.flat();
  all.forEach((_, i) => b.u8(offCurve.has(i) ? 0x00 : 0x01)); // long coordinates, no repeat
  for (const axis of [0, 1]) {
    let last = 0;
    for (const point of all) {
      b.u16((point[axis] - last) & 0xffff);
      last = point[axis];
    }
  }
  return b.out;
}

interface ComponentSpec {
  glyph: number;
  dx: number;
  dy: number;
  /** false drops ARGS_ARE_XY_VALUES, so the component is placed by point matching. */
  xy?: boolean;
  /** Adds WE_HAVE_A_SCALE with this F2Dot14 scale. */
  scale?: number;
}

function compositeGlyph(components: ComponentSpec[]): number[] {
  const b = new Bytes().u16(0xffff).u16(0).u16(0).u16(0).u16(0);
  components.forEach((c, i) => {
    const more = i + 1 < components.length ? 0x20 : 0;
    const flags = 0x0001 | (c.xy === false ? 0 : 0x0002) | (c.scale !== undefined ? 0x0008 : 0) | more;
    b.u16(flags).u16(c.glyph).u16(c.dx & 0xffff).u16(c.dy & 0xffff);
    if (c.scale !== undefined) b.u16(Math.round(c.scale * 16384) & 0xffff);
  });
  return b.out;
}

interface FontSpec {
  glyphs: number[][];
  /** Code point -> glyph id, written as one cmap format 12 subtable per (platform, encoding). */
  cmaps?: { platform: number; encoding: number; map: [number, number][]; format?: number }[];
  advances?: number[];
  sfntVersion?: number;
  omit?: string;
}

function buildFont(spec: FontSpec): Uint8Array {
  const numGlyphs = spec.glyphs.length;
  const advances = spec.advances ?? spec.glyphs.map(() => 500);
  const head = new Bytes().bytes(new Array(18).fill(0)).u16(1000).bytes(new Array(30).fill(0)).u16(1).u16(0).out; // long loca
  const maxp = new Bytes().u32(0x00005000).u16(numGlyphs).out;
  const hhea = new Bytes().bytes(new Array(34).fill(0)).u16(advances.length).out;
  const hmtx = new Bytes();
  for (const advance of advances) hmtx.u16(advance).u16(0);
  for (let i = advances.length; i < numGlyphs; i++) hmtx.u16(0);
  const loca = new Bytes();
  const glyf = new Bytes();
  for (const glyph of spec.glyphs) {
    loca.u32(glyf.out.length);
    glyf.bytes(glyph);
  }
  loca.u32(glyf.out.length);
  const cmaps = spec.cmaps ?? [{ platform: 3, encoding: 10, map: [[0x41, 1]] }];
  const subtables = cmaps.map(({ map, format }) => {
    if (format === 0) return new Bytes().u16(0).u16(262).u16(0).bytes(new Array(256).fill(0)).out;
    const s = new Bytes().u16(12).u16(0).u32(16 + map.length * 12).u32(0).u32(map.length);
    for (const [code, glyph] of map) s.u32(code).u32(code).u32(glyph);
    return s.out;
  });
  const cmap = new Bytes().u16(0).u16(cmaps.length);
  let at = 4 + cmaps.length * 8;
  cmaps.forEach((c, i) => {
    cmap.u16(c.platform).u16(c.encoding).u32(at);
    at += subtables[i].length;
  });
  for (const s of subtables) cmap.bytes(s);

  const tables: [string, number[]][] = (
    [
      ["cmap", cmap.out],
      ["glyf", glyf.out],
      ["head", head],
      ["hhea", hhea],
      ["hmtx", hmtx.out],
      ["loca", loca.out],
      ["maxp", maxp],
    ] as [string, number[]][]
  ).filter(([tag]) => tag !== spec.omit);
  const file = new Bytes().u32(spec.sfntVersion ?? 0x00010000).u16(tables.length).u16(0).u16(0).u16(0);
  let offset = 12 + tables.length * 16;
  for (const [tag, data] of tables) {
    file.bytes([...tag].map((c) => c.charCodeAt(0))).u32(0).u32(offset).u32(data.length);
    offset += data.length;
  }
  for (const [, data] of tables) file.bytes(data);
  return new Uint8Array(file.out);
}

const SQUARE = [
  [0, 0],
  [0, 100],
  [100, 100],
  [100, 0],
];

// ---------------------------------------------------------------------------------------------

describe("parseTrueType on the bundled fonts", () => {
  it("parses every font file the size table uses, with its glyph count and Unicode cmap", () => {
    for (const file of FILES) {
      const parsed = font(file);
      const fairfax = file === "FairfaxSerif-Latin.ttf";
      expect(parsed.numGlyphs, file).toBe(fairfax ? 452 : 241);
      expect(parsed.cmap.size, file).toBe(fairfax ? 356 : 238);
      expect(parsed.unitsPerEm, file).toBe(FONT_FILES[file].nativeSize * 100);
    }
  });

  it("maps all 95 printable ASCII code points (U+0020 to U+007E) in every font file (Requirement 10.6)", () => {
    for (const file of FILES) {
      const unmapped: string[] = [];
      for (let cp = 0x20; cp <= 0x7e; cp++) if (!font(file).cmap.has(cp)) unmapped.push(`U+${cp.toString(16).toUpperCase().padStart(4, "0")}`);
      expect(unmapped, file).toEqual([]);
    }
  });

  it("gives the hmtx advance of each glyph, and the last entry past numberOfHMetrics", () => {
    const po = font("PixelOperator.ttf");
    expect(po.advance(po.cmap.get(0x49)!)).toBe(500); // 'I'
    for (const file of ["PixelOperatorMono.ttf", "PixelOperatorMono8-Bold.ttf"] as const) {
      const bytes = fileBytes(file);
      const { view, table } = rawTables(bytes);
      const numberOfHMetrics = view.getUint16(table("hhea") + 34);
      expect(numberOfHMetrics).toBe(4);
      const last = view.getUint16(table("hmtx") + (numberOfHMetrics - 1) * 4);
      const parsed = font(file);
      for (let g = numberOfHMetrics - 1; g < parsed.numGlyphs; g++) expect(parsed.advance(g)).toBe(last);
      expect(parsed.advance(0)).toBe(view.getUint16(table("hmtx")));
    }
  });

  it("resolves composites: exclamdown is exclam turned by 180 degrees", () => {
    for (const file of FILES.filter((f) => f.startsWith("PixelOperator"))) {
      const parsed = font(file);
      const exclam = points(parsed.outline(parsed.cmap.get(0x21)!));
      const turned = points(parsed.outline(parsed.cmap.get(0xa1)!));
      expect(turned.length, file).toBe(exclam.length);
      const [dx, dy] = [turned[0][0] + exclam[0][0], turned[0][1] + exclam[0][1]];
      expect(turned, file).toEqual(exclam.map(([x, y]) => [dx - x, dy - y]));
    }
    const po = font("PixelOperator.ttf");
    expect(points(po.outline(po.cmap.get(0xa1)!))[0]).toEqual([500 - 200, 700 - 900]);
  });

  it("resolves nested composites into the components' contours (Agrave = grave + A)", () => {
    const po = font("PixelOperator.ttf");
    const agrave = points(po.outline(po.cmap.get(0xc0)!));
    const grave = points(po.outline(po.cmap.get(0x60)!));
    const a = points(po.outline(po.cmap.get(0x41)!));
    expect(agrave).toEqual([...grave.map(([x, y]) => [x + 100, y + 300]), ...a]);
  });

  it("places every component at a whole pixel at every render size the size table uses", () => {
    for (const file of FILES) {
      const offsets = componentOffsets(fileBytes(file));
      if (file === "FairfaxSerif-Latin.ttf") expect(offsets).toEqual([]);
      else expect(offsets.length, file).toBeGreaterThan(30);
      for (const size of renderSizes(file)) {
        const pixelsPerUnit = size / font(file).unitsPerEm;
        for (const { dx, dy, flags } of offsets) {
          expect(flags & 0x2, file).toBe(0x2); // ARGS_ARE_XY_VALUES
          expect(Number.isInteger(dx * pixelsPerUnit) && Number.isInteger(dy * pixelsPerUnit), `${file} ${size}px`).toBe(true);
        }
      }
    }
  });

  it("gives an empty outline for a glyph without data (space)", () => {
    for (const file of FILES) expect(font(file).outline(font(file).cmap.get(0x20)!).contours, file).toEqual([]);
  });

  it("rejects a glyph id outside the font", () => {
    const po = font("PixelOperator.ttf");
    expect(() => po.outline(po.numGlyphs)).toThrow(TrueTypeError);
    expect(() => po.advance(-1)).toThrow(TrueTypeError);
  });
});

describe("parseTrueType on inputs outside the subset", () => {
  const notdef = simpleGlyph([SQUARE]);

  it("reads a well-formed minimal font", () => {
    const parsed = parseTrueType(buildFont({ glyphs: [notdef, simpleGlyph([SQUARE]), compositeGlyph([{ glyph: 1, dx: 200, dy: -100, scale: 1.5 }])] }));
    expect(parsed.numGlyphs).toBe(3);
    expect([...parsed.cmap]).toEqual([[0x41, 1]]);
    expect(points(parsed.outline(2))).toEqual(SQUARE.map(([x, y]) => [1.5 * x + 200, 1.5 * y - 100]));
  });

  it("rejects an off-curve point (quadratic curves are not drawn)", () => {
    const curved = simpleGlyph([SQUARE], new Set([2]));
    expect(() => parseTrueType(buildFont({ glyphs: [notdef, curved] }))).toThrow(/off-curve/);
    expect(() => parseTrueType(buildFont({ glyphs: [notdef, curved] }))).toThrow(TrueTypeError);
  });

  it("rejects a component placed by point matching", () => {
    const matched = compositeGlyph([{ glyph: 1, dx: 0, dy: 0, xy: false }]);
    expect(() => parseTrueType(buildFont({ glyphs: [notdef, simpleGlyph([SQUARE]), matched] }))).toThrow(/point matching/);
  });

  it(`resolves composites nested ${MAX_COMPOSITE_DEPTH} levels deep and rejects one level more`, () => {
    const chain = (levels: number): number[][] => [
      notdef,
      simpleGlyph([SQUARE]),
      ...Array.from({ length: levels }, (_, i) => compositeGlyph([{ glyph: i + 1, dx: 100, dy: 0 }])),
    ];
    const deepest = parseTrueType(buildFont({ glyphs: chain(MAX_COMPOSITE_DEPTH) }));
    expect(points(deepest.outline(MAX_COMPOSITE_DEPTH + 1))[0]).toEqual([MAX_COMPOSITE_DEPTH * 100, 0]);
    expect(() => parseTrueType(buildFont({ glyphs: chain(MAX_COMPOSITE_DEPTH + 1) }))).toThrow(/nested more than 8/);
  });

  it("rejects a composite that contains itself", () => {
    expect(() => parseTrueType(buildFont({ glyphs: [notdef, compositeGlyph([{ glyph: 1, dx: 0, dy: 0 }])] }))).toThrow(TrueTypeError);
  });

  it("rejects a component that names a missing glyph", () => {
    expect(() => parseTrueType(buildFont({ glyphs: [notdef, compositeGlyph([{ glyph: 9, dx: 0, dy: 0 }])] }))).toThrow(/missing glyph 9/);
  });

  it("rejects CFF outlines, a missing table and truncated data", () => {
    expect(() => parseTrueType(buildFont({ glyphs: [notdef], sfntVersion: 0x4f54544f }))).toThrow(/sfnt version/);
    for (const omit of ["glyf", "loca", "cmap", "hmtx"]) {
      expect(() => parseTrueType(buildFont({ glyphs: [notdef], omit }))).toThrow(new RegExp(`no ${omit} table`));
    }
    const whole = fileBytes("PixelOperator.ttf");
    expect(() => parseTrueType(whole.subarray(0, 8))).toThrow(TrueTypeError);
    expect(() => parseTrueType(whole.subarray(0, whole.length - 100))).toThrow(TrueTypeError);
  });

  it("picks the cmap subtable in fontTools' getBestCmap order, among formats 4 and 12", () => {
    const glyphs = [notdef, simpleGlyph([SQUARE]), simpleGlyph([SQUARE])];
    const preferred = parseTrueType(
      buildFont({
        glyphs,
        cmaps: [
          { platform: 0, encoding: 3, map: [[0x41, 1]] },
          { platform: 3, encoding: 10, map: [[0x41, 2]] },
        ],
      }),
    );
    expect(preferred.cmap.get(0x41)).toBe(2);
    const later = parseTrueType(
      buildFont({
        glyphs,
        cmaps: [
          { platform: 0, encoding: 3, map: [[0x41, 1]] },
          { platform: 3, encoding: 1, map: [[0x41, 2]] },
        ],
      }),
    );
    expect(later.cmap.get(0x41)).toBe(2);
    expect(() => parseTrueType(buildFont({ glyphs, cmaps: [{ platform: 1, encoding: 0, map: [], format: 0 }] }))).toThrow(/no Unicode cmap/);
  });
});

describe("fillOutline: nonzero winding sampled at pixel centres", () => {
  const rect = (x0: number, y0: number, x1: number, y1: number, clockwise = true): Float64Array =>
    Float64Array.from(clockwise ? [x0, y0, x0, y1, x1, y1, x1, y0] : [x0, y0, x1, y0, x1, y1, x0, y1]);

  it("fills exactly the pixels whose centre lies inside", () => {
    const alpha = new Uint8Array(6 * 6);
    // Font units with scale 1, baseline 6: x 1.4..3.4 covers the centres 1.5 and 2.5; y 1..3 covers rows 3 and 4.
    fillOutline(alpha, 6, 6, { contours: [rect(1.4, 1, 3.4, 3)] }, 1, 0, 6);
    expect(inkRows(alpha, 6)).toEqual(["3:.##...", "4:.##..."]);
  });

  it("maps font units through scale, origin and baseline (y up)", () => {
    const alpha = new Uint8Array(10 * 10);
    fillOutline(alpha, 10, 10, { contours: [rect(0, 0, 100, 200)] }, 0.02, 3, 8);
    expect(inkRows(alpha, 10)).toEqual(["4:...##.....", "5:...##.....", "6:...##.....", "7:...##....."]);
  });

  it("unites overlapping contours of the same direction and cuts holes of the opposite direction", () => {
    const union = new Uint8Array(8 * 4);
    fillOutline(union, 8, 4, { contours: [rect(0, 0, 4, 4), rect(2, 0, 6, 4)] }, 1, 0, 4);
    expect(inkRows(union, 8)).toEqual(["0:######..", "1:######..", "2:######..", "3:######.."]);
    const ring = new Uint8Array(5 * 5);
    fillOutline(ring, 5, 5, { contours: [rect(0, 0, 5, 5), rect(1, 1, 4, 4, false)] }, 1, 0, 5);
    expect(inkRows(ring, 5)).toEqual(["0:#####", "1:#...#", "2:#...#", "3:#...#", "4:#####"]);
  });

  it("clips to the surface and leaves pixels it does not fill unchanged", () => {
    const alpha = new Uint8Array(4 * 4).fill(7);
    fillOutline(alpha, 4, 4, { contours: [rect(-10, -10, 2, 20)] }, 1, 0, 4);
    expect(Array.from(alpha)).toEqual([255, 255, 7, 7, 255, 255, 7, 7, 255, 255, 7, 7, 255, 255, 7, 7]);
  });

  it("draws the bundled 'I' as one column of 9 pixels at 16 px and a 2 x 18 block at 32 px", () => {
    const po = font("PixelOperator.ttf");
    const outline = po.outline(po.cmap.get(0x49)!);
    const small = new Uint8Array(16 * 20);
    fillOutline(small, 16, 20, outline, 16 / 1600, 4, 18);
    expect(inkRows(small, 16)).toEqual(Array.from({ length: 9 }, (_, i) => `${9 + i}:......#.........`));
    const large = new Uint8Array(16 * 40);
    fillOutline(large, 16, 40, outline, 32 / 1600, 4, 36);
    expect(inkRows(large, 16)).toEqual(Array.from({ length: 18 }, (_, i) => `${18 + i}:........##......`));
  });
});
