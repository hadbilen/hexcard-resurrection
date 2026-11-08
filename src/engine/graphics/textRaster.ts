// Crisp 1-bit text rasterizer. Canonical contract: hexcard_design_spec.md §5.5 and spec 03 design.md §4.
//
// Card text (field text, button titles, script output on a card) is never DOM text. It is drawn with
// `fillText` at integer coordinates on a scratch canvas and every pixel is hard-thresholded
// (`alpha >= 128 ? 2 : 0`), so no anti-aliasing fringe survives on any operating system.
//
// Everything here except `createCanvasTextBackend` and `loadBundledFonts` is pure TypeScript: the
// browser canvas sits behind the small `TextRasterBackend` adapter, so layout (word wrapping),
// thresholding and the pixel text styles are testable in Node with a fixed-metric stub.

import type { HexFieldPart, HexRect } from "../../core/schema.ts";

export type LogicalFont = HexFieldPart["textFont"];
export type TextSize = HexFieldPart["textSize"];
export type TextStyle = HexFieldPart["textStyle"][number];
export type TextAlign = HexFieldPart["textAlign"];

// ---------------------------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------------------------

export interface FontFileInfo {
  /** CSS family the file is registered under with FontFace (one family per file, weight normal). */
  family: string;
  /** Pixel size of the font's design grid: at this CSS px size one font pixel is one screen pixel. */
  nativeSize: number;
  /** Ascent above the baseline at the native size, in pixels (hhea.ascender). */
  ascent: number;
  /** Descent below the baseline at the native size, in pixels (-hhea.descender). */
  descent: number;
}

/**
 * Every bundled font file (public/fonts/, licences in public/fonts/LICENSES.md) and its native
 * pixel metrics. This is the single place where native sizes are declared. All values were read
 * from the files: each font draws its glyphs on a grid of 100 font units per pixel, so
 * `nativeSize = unitsPerEm / 100` and the ascent/descent are hhea.ascender/descender / 100.
 * Apple's Chicago, Geneva, Monaco and New York files are never bundled or loaded.
 */
export const FONT_FILES = {
  // Pixel Operator (CC0): unitsPerEm 1600, hhea 1300 / -300.
  "PixelOperator.ttf": { family: "HexCard PixelOperator", nativeSize: 16, ascent: 13, descent: 3 },
  "PixelOperator-Bold.ttf": { family: "HexCard PixelOperator Bold", nativeSize: 16, ascent: 13, descent: 3 },
  "PixelOperatorMono.ttf": { family: "HexCard PixelOperatorMono", nativeSize: 16, ascent: 13, descent: 3 },
  "PixelOperatorMono-Bold.ttf": { family: "HexCard PixelOperatorMono Bold", nativeSize: 16, ascent: 13, descent: 3 },
  // Pixel Operator 8 (CC0): unitsPerEm 800, hhea 700 / -100.
  "PixelOperator8.ttf": { family: "HexCard PixelOperator8", nativeSize: 8, ascent: 7, descent: 1 },
  "PixelOperator8-Bold.ttf": { family: "HexCard PixelOperator8 Bold", nativeSize: 8, ascent: 7, descent: 1 },
  "PixelOperatorMono8.ttf": { family: "HexCard PixelOperatorMono8", nativeSize: 8, ascent: 7, descent: 1 },
  "PixelOperatorMono8-Bold.ttf": { family: "HexCard PixelOperatorMono8 Bold", nativeSize: 8, ascent: 7, descent: 1 },
  // Fairfax Serif (OFL-1.1, Latin subset): unitsPerEm 1200, hhea 900 / -300.
  "FairfaxSerif-Latin.ttf": { family: "HexCard FairfaxSerif", nativeSize: 12, ascent: 9, descent: 3 },
} as const satisfies Record<string, FontFileInfo>;

export type FontFileName = keyof typeof FONT_FILES;

export interface TextSizeEntry {
  /** Regular face. */
  file: FontFileName;
  /** Bold face with the same native size; when absent, bold is synthesized in pixels. */
  boldFile?: FontFileName;
  /** CSS px size passed to the canvas: always a positive integer multiple of the file's native size. */
  renderSize: number;
  /** Distance between consecutive line tops: `ceil(textSize * 4/3)`, HyperCard's default textHeight. */
  lineHeight: number;
}

/** Logical text sizes of HexFieldPart.textSize, in ascending order. */
export const TEXT_SIZES: readonly TextSize[] = [9, 10, 12, 14, 18, 24];

/** Generic CSS family used only until the bundled faces have loaded. */
const GENERIC_FAMILY: Readonly<Record<LogicalFont, string>> = {
  System: "sans-serif",
  Sans: "sans-serif",
  Mono: "monospace",
  Serif: "serif",
};

/**
 * Logical font and size -> font file, render size and line height. Rendering, measuring, CSS font
 * strings, FontFace registration and line metrics all derive from this table, so text is only ever
 * drawn at 1x, 2x, ... of a file's native pixel size, never at an in-between size.
 * Each size picks the native multiple whose cap height is nearest to that of HyperCard's font at
 * that point size (cap heights: Pixel Operator 9 px, Pixel Operator 8 and Fairfax 7 px per 1x).
 * None of the bundled fonts has an italic face, so italic is always a pixel shear.
 */
export const TEXT_SIZE_TABLE: Readonly<Record<LogicalFont, Readonly<Record<TextSize, Readonly<TextSizeEntry>>>>> = {
  // Chicago-like: Pixel Operator Bold faces as the regular face; bold is synthesized.
  System: {
    9: { file: "PixelOperator8-Bold.ttf", renderSize: 8, lineHeight: 12 },
    10: { file: "PixelOperator8-Bold.ttf", renderSize: 8, lineHeight: 14 },
    12: { file: "PixelOperator-Bold.ttf", renderSize: 16, lineHeight: 16 },
    14: { file: "PixelOperator-Bold.ttf", renderSize: 16, lineHeight: 19 },
    18: { file: "PixelOperator8-Bold.ttf", renderSize: 16, lineHeight: 24 },
    24: { file: "PixelOperator-Bold.ttf", renderSize: 32, lineHeight: 32 },
  },
  // Geneva-like: proportional sans.
  Sans: {
    9: { file: "PixelOperator8.ttf", boldFile: "PixelOperator8-Bold.ttf", renderSize: 8, lineHeight: 12 },
    10: { file: "PixelOperator8.ttf", boldFile: "PixelOperator8-Bold.ttf", renderSize: 8, lineHeight: 14 },
    12: { file: "PixelOperator.ttf", boldFile: "PixelOperator-Bold.ttf", renderSize: 16, lineHeight: 16 },
    14: { file: "PixelOperator.ttf", boldFile: "PixelOperator-Bold.ttf", renderSize: 16, lineHeight: 19 },
    18: { file: "PixelOperator8.ttf", boldFile: "PixelOperator8-Bold.ttf", renderSize: 16, lineHeight: 24 },
    24: { file: "PixelOperator.ttf", boldFile: "PixelOperator-Bold.ttf", renderSize: 32, lineHeight: 32 },
  },
  // Monaco-like: monospace.
  Mono: {
    9: { file: "PixelOperatorMono8.ttf", boldFile: "PixelOperatorMono8-Bold.ttf", renderSize: 8, lineHeight: 12 },
    10: { file: "PixelOperatorMono8.ttf", boldFile: "PixelOperatorMono8-Bold.ttf", renderSize: 8, lineHeight: 14 },
    12: { file: "PixelOperatorMono.ttf", boldFile: "PixelOperatorMono-Bold.ttf", renderSize: 16, lineHeight: 16 },
    14: { file: "PixelOperatorMono.ttf", boldFile: "PixelOperatorMono-Bold.ttf", renderSize: 16, lineHeight: 19 },
    18: { file: "PixelOperatorMono8.ttf", boldFile: "PixelOperatorMono8-Bold.ttf", renderSize: 16, lineHeight: 24 },
    24: { file: "PixelOperatorMono.ttf", boldFile: "PixelOperatorMono-Bold.ttf", renderSize: 32, lineHeight: 32 },
  },
  // New York-like: serif; one face, bold is synthesized.
  Serif: {
    9: { file: "FairfaxSerif-Latin.ttf", renderSize: 12, lineHeight: 12 },
    10: { file: "FairfaxSerif-Latin.ttf", renderSize: 12, lineHeight: 14 },
    12: { file: "FairfaxSerif-Latin.ttf", renderSize: 12, lineHeight: 16 },
    14: { file: "FairfaxSerif-Latin.ttf", renderSize: 12, lineHeight: 19 },
    18: { file: "FairfaxSerif-Latin.ttf", renderSize: 24, lineHeight: 24 },
    24: { file: "FairfaxSerif-Latin.ttf", renderSize: 24, lineHeight: 32 },
  },
};

/** Table entry for a logical font and size; throws for a size outside HexFieldPart.textSize. */
export function textSizeEntry(font: LogicalFont, size: TextSize): Readonly<TextSizeEntry> {
  const entry = TEXT_SIZE_TABLE[font]?.[size];
  if (!entry) throw new Error(`textRaster: no size table entry for ${String(font)} ${String(size)}`);
  return entry;
}

/** True when `bold` is drawn with a bold face rather than synthesized in pixels. */
export function hasBoldVariant(font: LogicalFont, size: TextSize): boolean {
  return textSizeEntry(font, size).boldFile !== undefined;
}

/** CSS font shorthand used for drawing and measuring: the table's file (bold file if requested and present) at its render size. */
export function cssFontString(font: LogicalFont, size: TextSize, bold: boolean): string {
  const entry = textSizeEntry(font, size);
  const file = bold && entry.boldFile !== undefined ? entry.boldFile : entry.file;
  return `${entry.renderSize}px "${FONT_FILES[file].family}", ${GENERIC_FAMILY[font]}`;
}

export interface LineMetrics {
  /** Distance between consecutive line tops, in pixels. */
  lineHeight: number;
  /** Baseline position measured from the line top, in pixels. */
  baselineOffset: number;
}

/**
 * Line height from the size table and the baseline: the rendered face's ascent + descent
 * (native metrics times the render multiple) is centred in the line, odd spare rows going below.
 */
export function lineMetrics(font: LogicalFont, size: TextSize): LineMetrics {
  const { file, renderSize, lineHeight } = textSizeEntry(font, size);
  const info = FONT_FILES[file];
  const multiple = renderSize / info.nativeSize;
  const ascent = info.ascent * multiple;
  const faceHeight = (info.ascent + info.descent) * multiple;
  return { lineHeight, baselineOffset: Math.floor((lineHeight - faceHeight) / 2) + ascent };
}

// ---------------------------------------------------------------------------------------------
// Backend adapter
// ---------------------------------------------------------------------------------------------

/** The only browser-dependent part of text rasterization. */
export interface TextRasterBackend {
  /** Advance width of `text` in pixels (CanvasRenderingContext2D.measureText().width). */
  measureText(text: string, cssFont: string): number;
  /**
   * Fills `text` in opaque black at integer (`x`, `baseline`) with an alphabetic baseline on a
   * transparent `width` x `height` surface and returns its alpha channel (row-major, `width * height`).
   */
  drawText(text: string, cssFont: string, x: number, baseline: number, width: number, height: number): ArrayLike<number>;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** Backend on an OffscreenCanvas (or a detached <canvas> where OffscreenCanvas is missing). */
export function createCanvasTextBackend(): TextRasterBackend {
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  let ctx: Ctx2D | null;
  if (typeof OffscreenCanvas !== "undefined") {
    const c = new OffscreenCanvas(1, 1);
    canvas = c;
    ctx = c.getContext("2d", { willReadFrequently: true });
  } else if (typeof document !== "undefined") {
    const c = document.createElement("canvas");
    canvas = c;
    ctx = c.getContext("2d", { willReadFrequently: true });
  } else {
    throw new Error("textRaster: no canvas available; pass a TextRasterBackend");
  }
  if (!ctx) throw new Error("textRaster: 2D canvas context unavailable");
  const context = ctx;

  return {
    measureText(text, cssFont) {
      context.font = cssFont;
      return context.measureText(text).width;
    },
    drawText(text, cssFont, x, baseline, width, height) {
      const alpha = new Uint8Array(width * height);
      if (width === 0 || height === 0) return alpha;
      // Resizing resets the context state, so all state is set after it.
      if (canvas.width < width || canvas.height < height) {
        canvas.width = Math.max(canvas.width, width);
        canvas.height = Math.max(canvas.height, height);
      }
      context.clearRect(0, 0, width, height);
      context.font = cssFont;
      context.fillStyle = "#000000";
      context.textAlign = "left";
      context.textBaseline = "alphabetic";
      context.fillText(text, x, baseline);
      const rgba = context.getImageData(0, 0, width, height).data;
      for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
      return alpha;
    },
  };
}

let defaultBackend: TextRasterBackend | null = null;

/** The shared canvas backend, created on first use (throws where no canvas exists, e.g. in Node). */
export function getDefaultBackend(): TextRasterBackend {
  defaultBackend ??= createCanvasTextBackend();
  return defaultBackend;
}

// ---------------------------------------------------------------------------------------------
// Font loading (browser only)
// ---------------------------------------------------------------------------------------------

const DEFAULT_FONT_BASE: string = `${import.meta.env?.BASE_URL ?? "/"}fonts/`;
const fontLoads = new Map<string, Promise<void>>();

/** Every font file the size table uses, in table order (each file once). */
export function tableFontFiles(): FontFileName[] {
  const files = new Set<FontFileName>();
  for (const sizes of Object.values(TEXT_SIZE_TABLE)) {
    for (const entry of Object.values(sizes)) {
      files.add(entry.file);
      if (entry.boldFile !== undefined) files.add(entry.boldFile);
    }
  }
  return [...files];
}

/** Every FontFace HexCard registers: one per font file used by the size table, weight normal. */
export function bundledFontFaces(): Array<{ family: string; file: FontFileName }> {
  return tableFontFiles().map((file) => ({ family: FONT_FILES[file].family, file }));
}

/** URLs that replace `<baseUrl><file>` for single font files, e.g. `data:` URLs embedded in a bundle. */
export type FontUrlOverrides = Readonly<Partial<Record<FontFileName, string>>>;

/** The URL a font file is loaded from: its override if there is one, else `<baseUrl><file>`. */
export function fontFileUrl(baseUrl: string, file: FontFileName, overrides?: FontUrlOverrides): string {
  return overrides?.[file] ?? `${baseUrl}${file}`;
}

/**
 * Loads the bundled fonts from `baseUrl` (default `<BASE_URL>fonts/`) with FontFace, adds them to
 * `document.fonts` and resolves after `document.fonts.ready`. The first frame must wait for it.
 * Memoised per base URL; a failed load is not cached, so it can be retried.
 *
 * `overrides` (spec 04 Requirement 6.1) replaces the URL of individual files. The standalone
 * player passes `data:` URLs it carries inside its own bundle, so an exported single-file HTML makes
 * no font requests. Loads with overrides are not memoised.
 */
export function loadBundledFonts(baseUrl: string = DEFAULT_FONT_BASE, overrides?: FontUrlOverrides): Promise<void> {
  const pending = overrides ? undefined : fontLoads.get(baseUrl);
  if (pending) return pending;
  const load = (async () => {
    const faces = bundledFontFaces().map(
      ({ family, file }) => new FontFace(family, `url("${fontFileUrl(baseUrl, file, overrides)}")`, { weight: "normal", style: "normal" }),
    );
    await Promise.all(faces.map((face) => face.load()));
    for (const face of faces) document.fonts.add(face);
    await document.fonts.ready;
  })();
  if (!overrides) {
    fontLoads.set(baseUrl, load);
    load.catch(() => fontLoads.delete(baseUrl));
  }
  return load;
}

// ---------------------------------------------------------------------------------------------
// Threshold
// ---------------------------------------------------------------------------------------------

/** Hard threshold: `alpha >= 128 ? ink : 0` (ink defaults to state 2 = dark). */
export function thresholdAlpha(alpha: ArrayLike<number>, ink = 2): Uint8Array {
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) out[i] = alpha[i] >= 128 ? ink : 0;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Layout (word wrapping)
// ---------------------------------------------------------------------------------------------

export interface TextLine {
  /** UTF-16 index of the line's first character in the original text. */
  start: number;
  /** UTF-16 index after the line's last character; excludes hard line breaks, includes hanging spaces. */
  end: number;
  /** Measured width of the line without trailing spaces. */
  width: number;
}

function trimTrailingSpaces(s: string): string {
  let e = s.length;
  while (e > 0 && s.charCodeAt(e - 1) === 32) e--;
  return s.slice(0, e);
}

function nextCodePoint(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const d = text.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return i + 2;
  }
  return i + 1;
}

/**
 * Splits `text` into lines. `\r\n`, `\r` and `\n` are hard breaks. With `wrap`, each paragraph is
 * wrapped greedily at spaces: spaces hang at the end of a line, a word that does not fit starts a
 * new line, and a word wider than `maxWidth` on its own is broken between code points (at least one
 * code point per line). All widths come from `measure`, so the result depends only on the font
 * metrics, never on the browser's own line breaking.
 */
export function layoutText(text: string, maxWidth: number, wrap: boolean, measure: (s: string) => number): TextLine[] {
  const lines: TextLine[] = [];
  const emit = (start: number, end: number): void => {
    lines.push({ start, end, width: measure(trimTrailingSpaces(text.slice(start, end))) });
  };
  const fits = (start: number, end: number): boolean => measure(text.slice(start, end)) <= maxWidth;

  // Breaks [lineStart, end) between code points until the rest fits; returns the new line start.
  const breakLongRun = (lineStart: number, end: number): number => {
    while (lineStart < end && !fits(lineStart, end)) {
      let k = nextCodePoint(text, lineStart);
      while (k < end) {
        const n = nextCodePoint(text, k);
        if (!fits(lineStart, n)) break;
        k = n;
      }
      if (k >= end) break; // a single code point wider than maxWidth stays on its own line
      emit(lineStart, k);
      lineStart = k;
    }
    return lineStart;
  };

  const wrapParagraph = (start: number, end: number): void => {
    let lineStart = start;
    let hasWord = false;
    let i = start;
    while (i < end) {
      let j = i;
      if (text.charCodeAt(i) === 32) {
        while (j < end && text.charCodeAt(j) === 32) j++;
        i = j; // spaces hang on the current line
        continue;
      }
      while (j < end && text.charCodeAt(j) !== 32) j++;
      if (hasWord && !fits(lineStart, j)) {
        emit(lineStart, i);
        lineStart = i;
        hasWord = false;
      }
      if (!hasWord) lineStart = breakLongRun(lineStart, j);
      hasWord = true;
      i = j;
    }
    emit(lineStart, end);
  };

  const hardBreak = /\r\n|\r|\n/g;
  let paraStart = 0;
  for (;;) {
    const m = hardBreak.exec(text);
    const paraEnd = m ? m.index : text.length;
    if (wrap) wrapParagraph(paraStart, paraEnd);
    else emit(paraStart, paraEnd);
    if (!m) break;
    paraStart = m.index + m[0].length;
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Pixel text styles (on a 0/1 line band)
// ---------------------------------------------------------------------------------------------

/** QuickDraw-style synthetic bold: every row ORed with itself shifted right by 1 px. */
function embolden(bits: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = w - 1; x > 0; x--) if (bits[row + x - 1]) bits[row + x] = 1;
  }
}

/** Removes the first column of every empty column run between ink; returns the number removed. */
function condense(bits: Uint8Array, w: number, h: number): number {
  const empty = new Array<boolean>(w).fill(true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (bits[y * w + x]) empty[x] = false;
  const first = empty.indexOf(false);
  if (first < 0) return 0;
  const last = empty.lastIndexOf(false);
  const remove = new Array<boolean>(w).fill(false);
  let removed = 0;
  for (let x = first + 1; x < last; x++) {
    if (empty[x] && !empty[x - 1]) {
      remove[x] = true;
      removed++;
    }
  }
  if (removed === 0) return 0;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let dst = 0;
    for (let x = 0; x < w; x++) if (!remove[x]) bits[row + dst++] = bits[row + x];
    while (dst < w) bits[row + dst++] = 0;
  }
  return removed;
}

/** QuickDraw-style italic: rows shift right by 1 px per 2 rows above the baseline (left below). */
function shear(bits: Uint8Array, w: number, h: number, baseline: number): void {
  const row = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const offset = Math.floor((baseline - 1 - y) / 2);
    if (offset === 0) continue;
    const base = y * w;
    row.fill(0);
    for (let x = 0; x < w; x++) {
      const nx = x + offset;
      if (bits[base + x] && nx >= 0 && nx < w) row[nx] = 1;
    }
    bits.set(row, base);
  }
}

/** 8-neighbour dilation. */
function dilate(bits: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(bits.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!bits[y * w + x]) continue;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx >= 0 && nx < w) out[ny * w + nx] = 1;
        }
      }
    }
  }
  return out;
}

/** Outline: the 1-px ring around the glyphs (dilation minus the glyphs). */
function outline(bits: Uint8Array, w: number, h: number): Uint8Array {
  const ring = dilate(bits, w, h);
  for (let i = 0; i < ring.length; i++) if (bits[i]) ring[i] = 0;
  return ring;
}

/** Shadow: outline plus a copy of the dilation offset by (+1, +1), minus the glyphs. */
function shadow(bits: Uint8Array, w: number, h: number): Uint8Array {
  const grown = dilate(bits, w, h);
  const out = grown.slice();
  for (let y = h - 1; y > 0; y--) {
    for (let x = w - 1; x > 0; x--) if (grown[(y - 1) * w + (x - 1)]) out[y * w + x] = 1;
  }
  for (let i = 0; i < out.length; i++) if (bits[i]) out[i] = 0;
  return out;
}

// ---------------------------------------------------------------------------------------------
// renderCrisp1BitText
// ---------------------------------------------------------------------------------------------

export interface TextLineBox {
  /** Range of the original text on this line (see `TextLine`). */
  start: number;
  end: number;
  /** Left edge of the drawn text, in the coordinate space of `rect` (frame coordinates). */
  x: number;
  /** Line top, in the coordinate space of `rect`. */
  y: number;
  /** Width of the drawn text after styles (without trailing spaces). */
  width: number;
  /** Line height (`lineMetrics().lineHeight`). */
  height: number;
  /** Baseline row, in the coordinate space of `rect`. */
  baseline: number;
}

export interface TextRasterResult {
  /**
   * `rect.width * rect.height` states, row-major and local to `rect`
   * (index `(y - rect.y) * rect.width + (x - rect.x)`): 2 = ink, 0 = no ink. Never any other value.
   */
  mask: Uint8Array;
  /** One box per line, including lines that fall outside `rect` (they draw nothing). */
  lineBoxes: TextLineBox[];
}

/** Vertical padding of a line band, room for outline/shadow. */
const PAD_Y = 2;

/**
 * Lays out `text` in `rect` (`wrap` = word wrap, i.e. `!dontWrap`), draws each line with the
 * backend at integer coordinates, thresholds it at alpha >= 128 and applies the pixel styles in
 * the order bold (synthetic only) -> condense -> italic -> underline -> outline/shadow.
 * Lines are `lineMetrics(font, size).lineHeight` apart starting at `rect.y`, aligned within
 * `rect.width`, and clipped to `rect`. `rect` is floored to integers. The face and the pixel size
 * come from `TEXT_SIZE_TABLE`; a size outside it throws.
 */
export function renderCrisp1BitText(
  text: string,
  font: LogicalFont,
  size: TextSize,
  style: readonly TextStyle[],
  rect: HexRect,
  align: TextAlign,
  wrap: boolean,
  backend: TextRasterBackend = getDefaultBackend(),
): TextRasterResult {
  const rx = Math.floor(rect.x);
  const ry = Math.floor(rect.y);
  const rw = Math.max(0, Math.floor(rect.width));
  const rh = Math.max(0, Math.floor(rect.height));
  const styles = new Set(style);
  const bold = styles.has("bold");
  const fakeBold = bold && !hasBoldVariant(font, size);
  const css = cssFontString(font, size, bold);
  const { lineHeight, baselineOffset } = lineMetrics(font, size);
  const padX = Math.ceil(lineHeight / 2) + 2; // room for italic shear, outline and shadow
  const bandH = lineHeight + 2 * PAD_Y;
  const bandBaseline = PAD_Y + baselineOffset;

  const measure = (s: string): number => backend.measureText(s, css);
  const lines = layoutText(text, rw, wrap, measure);
  const mask = new Uint8Array(rw * rh);
  const lineBoxes: TextLineBox[] = [];

  lines.forEach((line, index) => {
    const top = index * lineHeight; // rect-local
    const content = trimTrailingSpaces(text.slice(line.start, line.end));
    const visible = top - PAD_Y < rh && top + lineHeight + PAD_Y > 0;
    let width = content.length === 0 ? 0 : Math.ceil(line.width) + (fakeBold ? 1 : 0);
    let band: Uint8Array | null = null;
    let bandW = 0;

    if (content.length > 0 && (visible || styles.has("condense"))) {
      bandW = Math.ceil(line.width) + 2 * padX + 2;
      const alpha = backend.drawText(content, css, padX, bandBaseline, bandW, bandH);
      if (alpha.length !== bandW * bandH) {
        throw new Error(`renderCrisp1BitText: backend returned ${alpha.length} pixels, expected ${bandW * bandH}`);
      }
      band = thresholdAlpha(alpha, 1);
      if (fakeBold) embolden(band, bandW, bandH);
      if (styles.has("condense")) width -= condense(band, bandW, bandH);
      if (styles.has("italic")) shear(band, bandW, bandH, bandBaseline);
      if (styles.has("underline")) band.fill(1, (bandBaseline + 1) * bandW + padX, (bandBaseline + 1) * bandW + padX + width);
      if (styles.has("shadow")) band = shadow(band, bandW, bandH);
      else if (styles.has("outline")) band = outline(band, bandW, bandH);
    }

    const alignX = align === "center" ? Math.floor((rw - width) / 2) : align === "right" ? rw - width : 0;

    if (band && visible) {
      const originX = alignX - padX;
      const originY = top - PAD_Y;
      for (let by = 0; by < bandH; by++) {
        const my = originY + by;
        if (my < 0 || my >= rh) continue;
        for (let bx = 0; bx < bandW; bx++) {
          if (!band[by * bandW + bx]) continue;
          const mx = originX + bx;
          if (mx >= 0 && mx < rw) mask[my * rw + mx] = 2;
        }
      }
    }

    lineBoxes.push({
      start: line.start,
      end: line.end,
      x: rx + alignX,
      y: ry + top,
      width,
      height: lineHeight,
      baseline: ry + top + baselineOffset,
    });
  });

  return { mask, lineBoxes };
}
