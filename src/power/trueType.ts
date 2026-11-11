// TrueType reader and pixel-centre rasterizer for the Node text backend (spec 07 Requirement 10.1;
// design §trueType.ts, D13).
//
// It reads exactly the subset the bundled fonts use: the glyf/loca outline format with straight
// edges only, simple and composite glyphs, hmtx advances and a Unicode cmap subtable of format 4
// or 12. Anything outside that subset (quadratic curves, point-matched components, CFF outlines,
// missing tables, truncated data) throws TrueTypeError instead of being approximated, because an
// approximation could never be checked against Chrome. Pure TypeScript: no Node or DOM API.

export class TrueTypeError extends Error {
  override name = "TrueTypeError";
}

export interface GlyphOutline {
  /** Closed polygons in font units (y up): [x0, y0, x1, y1, ...]; the last point joins the first. */
  contours: readonly Float64Array[];
}

export interface TrueTypeFont {
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  /** Code point -> glyph id from the chosen Unicode subtable; unmapped code points are absent. */
  readonly cmap: ReadonlyMap<number, number>;
  /** hmtx advance width in font units; glyphs at or after numberOfHMetrics use the last entry. */
  advance(glyph: number): number;
  /** Composites resolved. Glyph 0 is .notdef. */
  outline(glyph: number): GlyphOutline;
}

/** Deepest composite nesting resolved: a composite may contain composites up to 8 levels down. */
export const MAX_COMPOSITE_DEPTH = 8;

/**
 * Unicode cmap subtables in the order fontTools' getBestCmap prefers them (the order the coverage
 * measurement of the requirements used). Only formats 4 and 12 are read.
 */
const CMAP_PREFERENCE: readonly (readonly [platform: number, encoding: number])[] = [
  [3, 10],
  [0, 6],
  [0, 4],
  [3, 1],
  [0, 3],
  [0, 2],
  [0, 1],
  [0, 0],
];

// Simple-glyph flags.
const ON_CURVE = 0x01;
const X_SHORT = 0x02;
const Y_SHORT = 0x04;
const REPEAT = 0x08;
const X_SAME_OR_POSITIVE = 0x10;
const Y_SAME_OR_POSITIVE = 0x20;

// Composite-glyph flags.
const ARG_1_AND_2_ARE_WORDS = 0x0001;
const ARGS_ARE_XY_VALUES = 0x0002;
const WE_HAVE_A_SCALE = 0x0008;
const MORE_COMPONENTS = 0x0020;
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040;
const WE_HAVE_A_TWO_BY_TWO = 0x0080;
const SCALED_COMPONENT_OFFSET = 0x0800;

/** Big-endian reads with bounds checks that throw TrueTypeError. */
class Reader {
  readonly bytes: Uint8Array;
  private readonly view: DataView;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private check(offset: number, size: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset + size > this.bytes.length) {
      throw new TrueTypeError(`the font data ends before byte ${offset + size}`);
    }
  }
  u8(offset: number): number {
    this.check(offset, 1);
    return this.view.getUint8(offset);
  }
  i8(offset: number): number {
    this.check(offset, 1);
    return this.view.getInt8(offset);
  }
  u16(offset: number): number {
    this.check(offset, 2);
    return this.view.getUint16(offset);
  }
  i16(offset: number): number {
    this.check(offset, 2);
    return this.view.getInt16(offset);
  }
  u32(offset: number): number {
    this.check(offset, 4);
    return this.view.getUint32(offset);
  }
  /** F2Dot14 fixed-point number. */
  f2dot14(offset: number): number {
    return this.i16(offset) / 16384;
  }
  tag(offset: number): string {
    this.check(offset, 4);
    return String.fromCharCode(this.u8(offset), this.u8(offset + 1), this.u8(offset + 2), this.u8(offset + 3));
  }
}

interface TableRecord {
  offset: number;
  length: number;
}

const REQUIRED_TABLES = ["head", "maxp", "hhea", "hmtx", "loca", "glyf", "cmap"] as const;
type RequiredTable = (typeof REQUIRED_TABLES)[number];

function readTables(r: Reader): Record<RequiredTable, TableRecord> {
  const version = r.u32(0);
  if (version !== 0x00010000 && version !== 0x74727565 /* 'true' */) {
    throw new TrueTypeError(`unsupported sfnt version 0x${version.toString(16).padStart(8, "0")} (only TrueType outlines are read)`);
  }
  const count = r.u16(4);
  const found = new Map<string, TableRecord>();
  for (let i = 0; i < count; i++) {
    const record = 12 + i * 16;
    const offset = r.u32(record + 8);
    const length = r.u32(record + 12);
    if (offset + length > r.bytes.length) throw new TrueTypeError(`table ${r.tag(record)} lies outside the font data`);
    found.set(r.tag(record), { offset, length });
  }
  const tables = {} as Record<RequiredTable, TableRecord>;
  for (const name of REQUIRED_TABLES) {
    const table = found.get(name);
    if (table === undefined) throw new TrueTypeError(`the font has no ${name} table`);
    tables[name] = table;
  }
  return tables;
}

function readCmapSubtable(r: Reader, offset: number, numGlyphs: number): Map<number, number> {
  const format = r.u16(offset);
  const map = new Map<number, number>();
  const put = (codePoint: number, glyph: number): void => {
    // Glyph 0 (.notdef) means "not mapped"; ids past the glyph count are broken data.
    if (glyph === 0) return;
    if (glyph >= numGlyphs) throw new TrueTypeError(`cmap maps U+${codePoint.toString(16).toUpperCase()} to missing glyph ${glyph}`);
    if (!map.has(codePoint)) map.set(codePoint, glyph);
  };
  if (format === 4) {
    const segCount = r.u16(offset + 6) / 2;
    const endCodes = offset + 14;
    const startCodes = endCodes + segCount * 2 + 2;
    const idDeltas = startCodes + segCount * 2;
    const idRangeOffsets = idDeltas + segCount * 2;
    for (let s = 0; s < segCount; s++) {
      const end = r.u16(endCodes + s * 2);
      const start = r.u16(startCodes + s * 2);
      const delta = r.i16(idDeltas + s * 2);
      const rangeOffsetAt = idRangeOffsets + s * 2;
      const rangeOffset = r.u16(rangeOffsetAt);
      if (start > end) throw new TrueTypeError("cmap format 4 has a segment whose start is after its end");
      for (let c = start; c <= end; c++) {
        if (c === 0xffff) break; // the closing segment maps nothing
        let glyph: number;
        if (rangeOffset === 0) {
          glyph = (c + delta) & 0xffff;
        } else {
          glyph = r.u16(rangeOffsetAt + rangeOffset + (c - start) * 2);
          if (glyph !== 0) glyph = (glyph + delta) & 0xffff;
        }
        put(c, glyph);
      }
    }
    return map;
  }
  if (format === 12) {
    const groups = r.u32(offset + 12);
    for (let g = 0; g < groups; g++) {
      const group = offset + 16 + g * 12;
      const start = r.u32(group);
      const end = r.u32(group + 4);
      const startGlyph = r.u32(group + 8);
      if (start > end || end > 0x10ffff) throw new TrueTypeError("cmap format 12 has an invalid group");
      for (let c = start; c <= end; c++) put(c, startGlyph + (c - start));
    }
    return map;
  }
  throw new TrueTypeError(`unsupported cmap format ${format}`);
}

function readCmap(r: Reader, table: TableRecord, numGlyphs: number): Map<number, number> {
  const count = r.u16(table.offset + 2);
  const subtables: { platform: number; encoding: number; offset: number }[] = [];
  for (let i = 0; i < count; i++) {
    const record = table.offset + 4 + i * 8;
    subtables.push({ platform: r.u16(record), encoding: r.u16(record + 2), offset: table.offset + r.u32(record + 4) });
  }
  for (const [platform, encoding] of CMAP_PREFERENCE) {
    for (const sub of subtables) {
      if (sub.platform !== platform || sub.encoding !== encoding) continue;
      const format = r.u16(sub.offset);
      if (format === 4 || format === 12) return readCmapSubtable(r, sub.offset, numGlyphs);
    }
  }
  throw new TrueTypeError("the font has no Unicode cmap subtable of format 4 or 12");
}

/** One component reference of a composite glyph, with its 2x2 transform and offset. */
interface Component {
  glyph: number;
  /** x' = a*x + c*y + dx, y' = b*x + d*y + dy. */
  a: number;
  b: number;
  c: number;
  d: number;
  dx: number;
  dy: number;
}

type RawGlyph = { kind: "simple"; contours: Float64Array[] } | { kind: "composite"; components: Component[] };

function readSimpleGlyph(r: Reader, at: number, contourCount: number, glyph: number): Float64Array[] {
  let p = at + 10;
  const ends: number[] = [];
  for (let i = 0; i < contourCount; i++, p += 2) {
    const end = r.u16(p);
    if (i > 0 && end <= ends[i - 1]) throw new TrueTypeError(`glyph ${glyph} has contour end points out of order`);
    ends.push(end);
  }
  const pointCount = contourCount === 0 ? 0 : ends[contourCount - 1] + 1;
  const instructionLength = r.u16(p);
  p += 2 + instructionLength; // instructions skipped (no font has a hinting program)

  const flags = new Uint8Array(pointCount);
  for (let i = 0; i < pointCount; ) {
    const flag = r.u8(p++);
    flags[i++] = flag;
    if (flag & REPEAT) {
      const repeat = r.u8(p++);
      if (i + repeat > pointCount) throw new TrueTypeError(`glyph ${glyph} repeats a flag past its last point`);
      for (let k = 0; k < repeat; k++) flags[i++] = flag;
    }
  }
  for (let i = 0; i < pointCount; i++) {
    if (!(flags[i] & ON_CURVE)) throw new TrueTypeError(`glyph ${glyph} has an off-curve point (quadratic curves are not drawn)`);
  }

  const xs = new Float64Array(pointCount);
  const ys = new Float64Array(pointCount);
  let value = 0;
  for (let i = 0; i < pointCount; i++) {
    const flag = flags[i];
    if (flag & X_SHORT) {
      const delta = r.u8(p++);
      value += flag & X_SAME_OR_POSITIVE ? delta : -delta;
    } else if (!(flag & X_SAME_OR_POSITIVE)) {
      value += r.i16(p);
      p += 2;
    }
    xs[i] = value;
  }
  value = 0;
  for (let i = 0; i < pointCount; i++) {
    const flag = flags[i];
    if (flag & Y_SHORT) {
      const delta = r.u8(p++);
      value += flag & Y_SAME_OR_POSITIVE ? delta : -delta;
    } else if (!(flag & Y_SAME_OR_POSITIVE)) {
      value += r.i16(p);
      p += 2;
    }
    ys[i] = value;
  }

  const contours: Float64Array[] = [];
  let first = 0;
  for (const end of ends) {
    const contour = new Float64Array((end - first + 1) * 2);
    for (let i = first, k = 0; i <= end; i++, k += 2) {
      contour[k] = xs[i];
      contour[k + 1] = ys[i];
    }
    contours.push(contour);
    first = end + 1;
  }
  return contours;
}

function readCompositeGlyph(r: Reader, at: number, glyph: number, numGlyphs: number): Component[] {
  const components: Component[] = [];
  let p = at + 10;
  for (;;) {
    const flags = r.u16(p);
    const component = r.u16(p + 2);
    p += 4;
    if (component >= numGlyphs) throw new TrueTypeError(`glyph ${glyph} refers to missing glyph ${component}`);
    if (!(flags & ARGS_ARE_XY_VALUES)) throw new TrueTypeError(`glyph ${glyph} places a component by point matching`);
    let dx: number;
    let dy: number;
    if (flags & ARG_1_AND_2_ARE_WORDS) {
      dx = r.i16(p);
      dy = r.i16(p + 2);
      p += 4;
    } else {
      dx = r.i8(p);
      dy = r.i8(p + 1);
      p += 2;
    }
    let a = 1;
    let b = 0;
    let c = 0;
    let d = 1;
    if (flags & WE_HAVE_A_SCALE) {
      a = d = r.f2dot14(p);
      p += 2;
    } else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) {
      a = r.f2dot14(p);
      d = r.f2dot14(p + 2);
      p += 4;
    } else if (flags & WE_HAVE_A_TWO_BY_TWO) {
      a = r.f2dot14(p);
      b = r.f2dot14(p + 2);
      c = r.f2dot14(p + 4);
      d = r.f2dot14(p + 6);
      p += 8;
    }
    if (flags & SCALED_COMPONENT_OFFSET) {
      // The offset is transformed with the component.
      const tx = a * dx + c * dy;
      const ty = b * dx + d * dy;
      dx = tx;
      dy = ty;
    }
    // ROUND_XY_TO_GRID is not applied: every offset of the bundled fonts is a whole pixel already.
    components.push({ glyph: component, a, b, c, d, dx, dy });
    if (!(flags & MORE_COMPONENTS)) break; // trailing instructions (WE_HAVE_INSTRUCTIONS) are skipped
  }
  return components;
}

/** Parses every glyph eagerly. Throws TrueTypeError on anything outside the subset above. */
export function parseTrueType(bytes: Uint8Array): TrueTypeFont {
  const r = new Reader(bytes);
  const tables = readTables(r);

  const unitsPerEm = r.u16(tables.head.offset + 18);
  const indexToLocFormat = r.i16(tables.head.offset + 50);
  if (unitsPerEm === 0) throw new TrueTypeError("head.unitsPerEm is 0");
  if (indexToLocFormat !== 0 && indexToLocFormat !== 1) throw new TrueTypeError(`unsupported indexToLocFormat ${indexToLocFormat}`);
  const numGlyphs = r.u16(tables.maxp.offset + 4);
  if (numGlyphs === 0) throw new TrueTypeError("the font has no glyphs");
  const numberOfHMetrics = r.u16(tables.hhea.offset + 34);
  if (numberOfHMetrics === 0 || numberOfHMetrics > numGlyphs) throw new TrueTypeError(`invalid numberOfHMetrics ${numberOfHMetrics}`);

  const advances = new Uint16Array(numberOfHMetrics);
  for (let i = 0; i < numberOfHMetrics; i++) advances[i] = r.u16(tables.hmtx.offset + i * 4);

  const cmap = readCmap(r, tables.cmap, numGlyphs);

  const glyphOffset = (glyph: number): number =>
    indexToLocFormat === 0 ? r.u16(tables.loca.offset + glyph * 2) * 2 : r.u32(tables.loca.offset + glyph * 4);

  const raw: RawGlyph[] = [];
  for (let glyph = 0; glyph < numGlyphs; glyph++) {
    const start = glyphOffset(glyph);
    const end = glyphOffset(glyph + 1);
    if (end < start || end > tables.glyf.length) throw new TrueTypeError(`glyph ${glyph} lies outside the glyf table`);
    if (end === start) {
      raw.push({ kind: "simple", contours: [] });
      continue;
    }
    const at = tables.glyf.offset + start;
    const contourCount = r.i16(at);
    if (contourCount >= 0) raw.push({ kind: "simple", contours: readSimpleGlyph(r, at, contourCount, glyph) });
    else raw.push({ kind: "composite", components: readCompositeGlyph(r, at, glyph, numGlyphs) });
  }

  const outlines: GlyphOutline[] = new Array(numGlyphs);
  const resolve = (glyph: number, depth: number): Float64Array[] => {
    const entry = raw[glyph];
    if (entry.kind === "simple") return entry.contours;
    if (depth >= MAX_COMPOSITE_DEPTH) throw new TrueTypeError(`composite glyphs are nested more than ${MAX_COMPOSITE_DEPTH} levels deep`);
    const contours: Float64Array[] = [];
    for (const { glyph: part, a, b, c, d, dx, dy } of entry.components) {
      for (const contour of resolve(part, depth + 1)) {
        const placed = new Float64Array(contour.length);
        for (let k = 0; k < contour.length; k += 2) {
          const x = contour[k];
          const y = contour[k + 1];
          placed[k] = a * x + c * y + dx;
          placed[k + 1] = b * x + d * y + dy;
        }
        contours.push(placed);
      }
    }
    return contours;
  };
  for (let glyph = 0; glyph < numGlyphs; glyph++) outlines[glyph] = { contours: resolve(glyph, 0) };

  const checkGlyph = (glyph: number): void => {
    if (!Number.isInteger(glyph) || glyph < 0 || glyph >= numGlyphs) throw new TrueTypeError(`glyph ${glyph} does not exist`);
  };

  return {
    unitsPerEm,
    numGlyphs,
    cmap,
    advance(glyph) {
      checkGlyph(glyph);
      return advances[Math.min(glyph, numberOfHMetrics - 1)];
    },
    outline(glyph) {
      checkGlyph(glyph);
      return outlines[glyph];
    },
  };
}

/**
 * Nonzero-winding fill sampled at pixel centres; sets alpha 255 inside, leaves other pixels.
 * A font point (gx, gy) maps to (originX + gx * scale, baselineY - gy * scale). Pixel (x, y) is
 * inside when the edges that cross the line y + 0.5 strictly left of x + 0.5 have a nonzero sum of
 * directions. An edge crosses that line when min(y0, y1) <= y + 0.5 < max(y0, y1).
 */
export function fillOutline(
  alpha: Uint8Array,
  width: number,
  height: number,
  outline: GlyphOutline,
  scale: number,
  originX: number,
  baselineY: number,
): void {
  // Edges in surface coordinates: x0, y0, x1, y1 per edge, horizontal edges dropped.
  const edges: number[] = [];
  let minY = Infinity;
  let maxY = -Infinity;
  for (const contour of outline.contours) {
    const n = contour.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = originX + contour[i * 2] * scale;
      const y0 = baselineY - contour[i * 2 + 1] * scale;
      const x1 = originX + contour[j * 2] * scale;
      const y1 = baselineY - contour[j * 2 + 1] * scale;
      if (y0 === y1) continue;
      edges.push(x0, y0, x1, y1);
      minY = Math.min(minY, y0, y1);
      maxY = Math.max(maxY, y0, y1);
    }
  }
  if (edges.length === 0) return;

  const firstRow = Math.max(0, Math.floor(minY - 0.5));
  const lastRow = Math.min(height - 1, Math.ceil(maxY));
  const crossings: { x: number; dir: number }[] = [];
  for (let y = firstRow; y <= lastRow; y++) {
    const sampleY = y + 0.5;
    crossings.length = 0;
    for (let e = 0; e < edges.length; e += 4) {
      const x0 = edges[e];
      const y0 = edges[e + 1];
      const x1 = edges[e + 2];
      const y1 = edges[e + 3];
      if (Math.min(y0, y1) <= sampleY && sampleY < Math.max(y0, y1)) {
        crossings.push({ x: x0 + ((sampleY - y0) * (x1 - x0)) / (y1 - y0), dir: y1 > y0 ? 1 : -1 });
      }
    }
    if (crossings.length === 0) continue;
    crossings.sort((p, q) => p.x - q.x);
    const row = y * width;
    let winding = 0;
    for (let i = 0; i < crossings.length; i++) {
      winding += crossings[i].dir;
      if (winding === 0 || i + 1 === crossings.length) continue;
      // Pixels whose centre lies in (crossings[i].x, crossings[i + 1].x] have this winding.
      const from = Math.max(0, Math.floor(crossings[i].x - 0.5) + 1);
      const to = Math.min(width - 1, Math.floor(crossings[i + 1].x - 0.5));
      for (let x = from; x <= to; x++) alpha[row + x] = 255;
    }
  }
}
