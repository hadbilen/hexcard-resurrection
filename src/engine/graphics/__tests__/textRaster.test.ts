import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  FONT_FILES,
  type FontFileName,
  type LogicalFont,
  TEXT_SIZES,
  TEXT_SIZE_TABLE,
  type TextRasterBackend,
  type TextSize,
  type TextStyle,
  bundledFontFaces,
  cssFontString,
  layoutText,
  lineMetrics,
  renderCrisp1BitText,
  tableFontFiles,
  thresholdAlpha,
} from "../textRaster.ts";

// ---------------------------------------------------------------------------------------------
// Fixed-metric stub backend (design.md §7): every code point advances 6 px. A non-space glyph is a
// 5x7 ink block sitting on the baseline, with anti-aliasing-like fringes around it:
//   columns 0..3 alpha 255, column 4 alpha 128 (kept), column 5 alpha 127 (dropped),
//   rows baseline-7..baseline-1 inked, row baseline-8 alpha 100 (dropped).
// ---------------------------------------------------------------------------------------------

const ADVANCE = 6;
const stubMeasure = (s: string): number => [...s].length * ADVANCE;

const stub: TextRasterBackend = {
  measureText: (text) => stubMeasure(text),
  drawText(text, _css, x, baseline, width, height) {
    const alpha = new Uint8Array(width * height);
    const put = (px: number, py: number, a: number): void => {
      if (px >= 0 && px < width && py >= 0 && py < height) alpha[py * width + px] = Math.max(alpha[py * width + px], a);
    };
    [...text].forEach((ch, i) => {
      if (ch === " ") return;
      const gx = x + i * ADVANCE;
      for (let r = baseline - 7; r < baseline; r++) {
        for (let c = 0; c < 4; c++) put(gx + c, r, 255);
        put(gx + 4, r, 128);
        put(gx + 5, r, 127);
      }
      for (let c = 0; c < 5; c++) put(gx + c, baseline - 8, 100);
    });
    return alpha;
  },
};

/** Ink pixels of a result as "x,y" in rect-local coordinates. */
function inkSet(mask: Uint8Array, width: number): Set<string> {
  const s = new Set<string>();
  mask.forEach((v, i) => {
    if (v) s.add(`${i % width},${Math.floor(i / width)}`);
  });
  return s;
}

function inkColumns(mask: Uint8Array, width: number): number[] {
  const cols = new Set<number>();
  mask.forEach((v, i) => {
    if (v) cols.add(i % width);
  });
  return [...cols].sort((a, b) => a - b);
}

const RECT = { x: 10, y: 20, width: 40, height: 16 };
// Sans 12: Pixel Operator at 16 px, lineHeight 16, baseline 0 + 13 = 13 -> stub glyph rows 6..12.
const BASELINE = lineMetrics("Sans", 12).baselineOffset;

describe("thresholdAlpha", () => {
  it("keeps alpha >= 128 as state 2 and drops the rest", () => {
    expect([...thresholdAlpha([0, 1, 127, 128, 200, 255])]).toEqual([0, 0, 0, 2, 2, 2]);
  });

  // Design §7: "threshold produces only 0/2".
  it("property: produces only 0/2, exactly alpha >= 128 ? 2 : 0", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 512 }), (alpha) => {
        const out = thresholdAlpha(alpha);
        return out.length === alpha.length && out.every((v, i) => v === (alpha[i] >= 128 ? 2 : 0));
      }),
    );
  });
});

const LOGICAL_FONTS: LogicalFont[] = ["System", "Sans", "Mono", "Serif"];
const tableEntries = LOGICAL_FONTS.flatMap((font) => TEXT_SIZES.map((size) => ({ font, size, entry: TEXT_SIZE_TABLE[font][size] })));

describe("size table, lineMetrics and fonts", () => {
  // Requirement 4.3: text is only drawn at 1x, 2x, ... of a font file's native pixel size.
  it("every entry renders at a positive integer multiple of its files' native size", () => {
    for (const { font, size, entry } of tableEntries) {
      for (const file of entry.boldFile ? [entry.file, entry.boldFile] : [entry.file]) {
        const multiple = entry.renderSize / FONT_FILES[file].nativeSize;
        expect(Number.isInteger(multiple) && multiple >= 1, `${font} ${size}: ${file} at ${entry.renderSize}px`).toBe(true);
      }
    }
  });

  it("bold files share the regular file's native size and the face fits the line height", () => {
    for (const { entry } of tableEntries) {
      const info = FONT_FILES[entry.file];
      if (entry.boldFile) expect(FONT_FILES[entry.boldFile].nativeSize).toBe(info.nativeSize);
      expect(((info.ascent + info.descent) * entry.renderSize) / info.nativeSize).toBeLessThanOrEqual(entry.lineHeight);
    }
  });

  it("uses HyperCard-like line heights and baselines from the rendered face", () => {
    for (const font of LOGICAL_FONTS) {
      expect(TEXT_SIZES.map((s) => lineMetrics(font, s).lineHeight)).toEqual([12, 14, 16, 19, 24, 32]);
    }
    expect(lineMetrics("Sans", 12)).toEqual({ lineHeight: 16, baselineOffset: 13 });
    expect(lineMetrics("Sans", 9)).toEqual({ lineHeight: 12, baselineOffset: 9 });
    expect(lineMetrics("Sans", 24)).toEqual({ lineHeight: 32, baselineOffset: 26 });
    expect(lineMetrics("Serif", 12)).toEqual({ lineHeight: 16, baselineOffset: 11 });
  });

  it("names the table's file at its render size and uses a bold file only where one exists", () => {
    expect(cssFontString("Sans", 12, true)).toBe('16px "HexCard PixelOperator Bold", sans-serif');
    expect(cssFontString("Sans", 18, false)).toBe('16px "HexCard PixelOperator8", sans-serif');
    expect(cssFontString("Serif", 12, true)).toBe('12px "HexCard FairfaxSerif", serif');
    expect(cssFontString("Mono", 9, false)).toBe('8px "HexCard PixelOperatorMono8", monospace');
    expect(cssFontString("System", 24, true)).toBe('32px "HexCard PixelOperator Bold", sans-serif');
  });

  it("registers one FontFace per font file the table uses, and declares no unused file", () => {
    expect(bundledFontFaces()).toHaveLength(9);
    expect(new Set(tableFontFiles())).toEqual(new Set(Object.keys(FONT_FILES)));
  });
});

// Requirements 4.3 / 4.4: the files exist, are licensed in LICENSES.md, and none is an Apple font.
const fontFiles = Object.keys(import.meta.glob("/public/fonts/*")).map((p) => p.slice("/public/fonts/".length));
const licences = Object.values(
  import.meta.glob<string>("/public/fonts/LICENSES.md", { query: "?raw", import: "default", eager: true }),
)[0];
const fontData = import.meta.glob<string>("/public/fonts/*.ttf", { query: "?inline", import: "default", eager: true });

/** unitsPerEm (head) and ascender/descender (hhea) of a TrueType file given as a base64 data URL. */
function ttfMetrics(dataUrl: string): { unitsPerEm: number; ascender: number; descender: number } {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(",") + 1));
  const view = new DataView(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer);
  const tables = new Map<string, number>();
  for (let i = 0; i < view.getUint16(4); i++) {
    const rec = 12 + i * 16;
    tables.set(String.fromCharCode(...[0, 1, 2, 3].map((k) => view.getUint8(rec + k))), view.getUint32(rec + 8));
  }
  const head = tables.get("head")!;
  const hhea = tables.get("hhea")!;
  return { unitsPerEm: view.getUint16(head + 18), ascender: view.getInt16(hhea + 4), descender: view.getInt16(hhea + 6) };
}

describe("bundled font files", () => {
  it("every mapped file exists in public/fonts and is listed in LICENSES.md", () => {
    for (const file of tableFontFiles()) {
      expect(fontFiles).toContain(file);
      expect(licences).toContain(`\`${file}\``);
    }
  });

  it("every bundled font file is mapped and the licences are only CC0 / OFL-1.1", () => {
    const fonts = fontFiles.filter((f) => /\.(ttf|otf|woff2?)$/i.test(f));
    expect(new Set(fonts)).toEqual(new Set(tableFontFiles()));
    expect(licences).toContain("CC0 1.0 Universal");
    expect(licences).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  // The declared native metrics match the font headers (100 font units = 1 pixel in every file).
  it("declared native sizes and ascent/descent match each file's head and hhea tables", () => {
    for (const [file, info] of Object.entries(FONT_FILES) as Array<[FontFileName, (typeof FONT_FILES)[FontFileName]]>) {
      const m = ttfMetrics(fontData[`/public/fonts/${file}`]);
      const unit = m.unitsPerEm / info.nativeSize;
      expect(unit, file).toBe(100);
      expect([m.ascender / unit, -m.descender / unit], file).toEqual([info.ascent, info.descent]);
    }
  });

  it("bundles no Apple Chicago, Geneva, Monaco or New York files", () => {
    for (const file of fontFiles) expect(file).not.toMatch(/chicago|geneva|monaco|new[\s_-]?york/i);
    for (const info of Object.values(FONT_FILES)) expect(info.family).not.toMatch(/chicago|geneva|monaco|new york/i);
  });
});

describe("layoutText", () => {
  it("wraps greedily at spaces, letting spaces hang", () => {
    const lines = layoutText("hello world foo", 66, true, stubMeasure);
    expect(lines).toEqual([
      { start: 0, end: 12, width: 66 },
      { start: 12, end: 15, width: 18 },
    ]);
  });

  it("breaks a word wider than the line between code points", () => {
    expect(layoutText("abcdefghij", 30, true, stubMeasure).map((l) => [l.start, l.end])).toEqual([
      [0, 5],
      [5, 10],
    ]);
    // Surrogate pairs are never split.
    expect(layoutText("😀😀😀", 6, true, stubMeasure).map((l) => [l.start, l.end])).toEqual([
      [0, 2],
      [2, 4],
      [4, 6],
    ]);
  });

  it("treats \\r\\n, \\r and \\n as hard breaks and keeps empty lines", () => {
    expect(layoutText("a\r\nb\rc\n\nd", 100, true, stubMeasure).map((l) => [l.start, l.end])).toEqual([
      [0, 1],
      [3, 4],
      [5, 6],
      [7, 7],
      [8, 9],
    ]);
    expect(layoutText("", 100, true, stubMeasure)).toEqual([{ start: 0, end: 0, width: 0 }]);
  });

  it("does not wrap when wrap is false", () => {
    expect(layoutText("hello world foo\nbar", 10, false, stubMeasure).map((l) => [l.start, l.end])).toEqual([
      [0, 15],
      [16, 19],
    ]);
  });

  // Design §7: "wrapping is deterministic for a fixed font metric stub".
  it("property: lines partition the text, fit the width and are reproducible", () => {
    const textArb = fc
      .array(fc.constantFrom("a", "bb", "ccccccc", " ", "  ", "\n", "\r\n", "😀"), { maxLength: 30 })
      .map((parts) => parts.join(""));
    fc.assert(
      fc.property(textArb, fc.integer({ min: 0, max: 80 }), (text, maxWidth) => {
        const lines = layoutText(text, maxWidth, true, stubMeasure);
        expect(layoutText(text, maxWidth, true, stubMeasure)).toEqual(lines);
        // Partition: lines are in order, contiguous except for hard breaks, covering the text.
        let pos = 0;
        lines.forEach((line, i) => {
          const gap = text.slice(pos, line.start);
          if (i === 0) expect(gap).toBe("");
          else expect(["", "\n", "\r\n", "\r"]).toContain(gap);
          expect(text.slice(line.start, line.end)).not.toMatch(/[\r\n]/);
          pos = line.end;
        });
        expect(pos).toBe(text.length);
        // Fit: a line wider than maxWidth holds a single code point.
        for (const line of lines) {
          if (line.width > maxWidth) expect([...text.slice(line.start, line.end).trimEnd()]).toHaveLength(1);
        }
      }),
    );
  });
});

describe("renderCrisp1BitText", () => {
  const render = (text: string, style: TextStyle[] = [], align: "left" | "center" | "right" = "left", font: LogicalFont = "Sans") =>
    renderCrisp1BitText(text, font, 12, style, RECT, align, true, stub);

  it("draws thresholded glyphs at integer positions and drops sub-128 fringes", () => {
    const { mask, lineBoxes } = render("a");
    expect(mask).toHaveLength(RECT.width * RECT.height);
    const expected = new Set<string>();
    for (let y = BASELINE - 7; y < BASELINE; y++) for (let x = 0; x < 5; x++) expected.add(`${x},${y}`);
    expect(inkSet(mask, RECT.width)).toEqual(expected);
    expect(lineBoxes).toEqual([{ start: 0, end: 1, x: 10, y: 20, width: 6, height: 16, baseline: 20 + BASELINE }]);
  });

  it("aligns lines left, center and right within the rect", () => {
    expect(render("ab", [], "left").lineBoxes[0].x).toBe(10);
    expect(render("ab", [], "center").lineBoxes[0].x).toBe(10 + 14);
    expect(render("ab", [], "right").lineBoxes[0].x).toBe(10 + 28);
    expect(inkColumns(render("ab", [], "right").mask, RECT.width)[0]).toBe(28);
  });

  it("stacks wrapped lines lineHeight apart and clips lines below the rect", () => {
    const { mask, lineBoxes } = render("aaaaaa aaaaaa");
    expect(lineBoxes.map((b) => [b.start, b.end, b.y])).toEqual([
      [0, 7, 20],
      [7, 13, 36],
    ]);
    // The second line lies outside the 16-px-high rect, so only the first line's rows are inked.
    const rows = new Set([...inkSet(mask, RECT.width)].map((p) => Number(p.split(",")[1])));
    expect(Math.max(...rows)).toBe(BASELINE - 1);
  });

  it("underline draws the row below the baseline across the text width", () => {
    const { mask } = render("ab", ["underline"]);
    for (let x = 0; x < 12; x++) expect(mask[(BASELINE + 1) * RECT.width + x]).toBe(2);
    expect(mask[(BASELINE + 1) * RECT.width + 12]).toBe(0);
  });

  it("outline keeps only the ring around the glyphs", () => {
    const plain = inkSet(render("a").mask, RECT.width);
    const ring = inkSet(render("a", ["outline"]).mask, RECT.width);
    for (const p of plain) expect(ring.has(p)).toBe(false);
    expect(ring.has(`5,${BASELINE - 1}`)).toBe(true); // right of the glyph
    expect(ring.has(`2,${BASELINE - 8}`)).toBe(true); // above the glyph
    // 7x9 ring box minus the 5x7 glyph, minus the ring's left column (x = -1), which the rect clips.
    expect(ring.size).toBe(7 * 9 - 5 * 7 - 9);
  });

  it("shadow adds a heavier bottom-right edge to the outline", () => {
    const ring = inkSet(render("a", ["outline"]).mask, RECT.width);
    const shade = inkSet(render("a", ["shadow"]).mask, RECT.width);
    for (const p of ring) expect(shade.has(p)).toBe(true);
    expect(shade.has(`6,${BASELINE + 1}`)).toBe(true);
    expect(ring.has(`6,${BASELINE + 1}`)).toBe(false);
  });

  it("bold uses the bold face when available and smears 1 px otherwise", () => {
    const variant = render("a", ["bold"], "left", "Sans");
    expect(variant.lineBoxes[0].width).toBe(6);
    expect(inkColumns(variant.mask, RECT.width)).toEqual([0, 1, 2, 3, 4]);
    const synthetic = renderCrisp1BitText("a", "Serif", 12, ["bold"], RECT, "left", true, stub);
    expect(synthetic.lineBoxes[0].width).toBe(7);
    expect(inkColumns(synthetic.mask, RECT.width)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("italic shears rows above the baseline to the right", () => {
    const { mask } = render("a", ["italic"]);
    const rowCols = (y: number) =>
      [...inkSet(mask, RECT.width)].filter((p) => p.endsWith(`,${y}`)).map((p) => Number(p.split(",")[0])).sort((a, b) => a - b);
    expect(rowCols(BASELINE - 1)).toEqual([0, 1, 2, 3, 4]);
    expect(rowCols(BASELINE - 7)).toEqual([3, 4, 5, 6, 7]);
  });

  it("condense removes one empty column between glyphs", () => {
    const { mask, lineBoxes } = render("ab", ["condense"]);
    expect(lineBoxes[0].width).toBe(11);
    expect(inkColumns(mask, RECT.width)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  // Design §7 / Requirement 4.1: whatever the text, style and layout, the mask is strictly 0/2.
  it("property: the mask holds only 0/2 and rendering is deterministic", () => {
    const styleArb = fc.subarray<TextStyle>(["bold", "italic", "underline", "outline", "shadow", "condense"]);
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.constantFrom<LogicalFont>("System", "Sans", "Mono", "Serif"),
        fc.constantFrom<TextSize>(...TEXT_SIZES),
        styleArb,
        fc.record({ x: fc.integer({ min: 0, max: 400 }), y: fc.integer({ min: 0, max: 300 }), width: fc.integer({ min: 0, max: 120 }), height: fc.integer({ min: 0, max: 60 }) }),
        fc.constantFrom<"left" | "center" | "right">("left", "center", "right"),
        fc.boolean(),
        (text, font, size, style, rect, align, wrap) => {
          const a = renderCrisp1BitText(text, font, size, style, rect, align, wrap, stub);
          const b = renderCrisp1BitText(text, font, size, style, rect, align, wrap, stub);
          expect(a).toEqual(b);
          expect(a.mask).toHaveLength(rect.width * rect.height);
          return a.mask.every((v) => v === 0 || v === 2);
        },
      ),
      { numRuns: 200 },
    );
  });
});
