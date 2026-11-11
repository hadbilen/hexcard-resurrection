/// <reference types="node" />
// Spec 07 task 4.1: the Node text backend and the bundled font bytes (Requirements 10.1, 10.2,
// 10.5, 14.1; design §nodeTextBackend.ts, §fontBytes.ts).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FONT_FILES,
  TEXT_SIZES,
  TEXT_SIZE_TABLE,
  cssFontString,
  renderCrisp1BitText,
  tableFontFiles,
  textSizeEntry,
  type FontFileName,
  type LogicalFont,
} from "../../engine/graphics/textRaster.ts";
import { bundledFontBytes } from "../fontBytes.ts";
import { coveredCodePoints, createNodeTextBackend, faceOf, formatCodePoint, parseFaces, uncoveredCharacters } from "../nodeTextBackend.ts";
import { fillOutline } from "../trueType.ts";

const FACES = parseFaces(bundledFontBytes());
const backend = createNodeTextBackend(FACES);
const FONTS = Object.keys(TEXT_SIZE_TABLE) as LogicalFont[];
const PRINTABLE_ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(0x20 + i)).join("");

/** Every cssFontString value the text pipeline can build, with the file and size it selects. */
const ALL_CSS_FONTS = FONTS.flatMap((font) =>
  TEXT_SIZES.flatMap((size) =>
    [false, true].map((bold) => {
      const entry = textSizeEntry(font, size);
      return { css: cssFontString(font, size, bold), file: bold && entry.boldFile ? entry.boldFile : entry.file, renderSize: entry.renderSize };
    }),
  ),
);
const SANS_12 = cssFontString("Sans", 12, false); // PixelOperator.ttf at 16 px
const SERIF_18 = cssFontString("Serif", 18, false); // FairfaxSerif-Latin.ttf at 24 px

const fontOf = (file: FontFileName) => FACES.fonts.get(file)!;
/** Unrounded advance in pixels of a code point's glyph in a face. */
const advanceOf = (css: string, codePoint: number): number => {
  const { file, renderSize } = faceOf(css);
  const font = fontOf(file);
  return (font.advance(font.cmap.get(codePoint) ?? 0) * renderSize) / font.unitsPerEm;
};
const draw = (text: string, css = SANS_12, x = 4) => Array.from(backend.drawText(text, css, x, 30, 120, 40));

describe("bundledFontBytes", () => {
  it("returns the exact bytes of every font file the size table uses", () => {
    const bytes = bundledFontBytes();
    expect(Object.keys(bytes).sort()).toEqual([...tableFontFiles()].sort());
    for (const file of tableFontFiles()) {
      expect(Buffer.from(bytes[file]).equals(readFileSync(new URL(`../../../public/fonts/${file}`, import.meta.url))), file).toBe(true);
    }
  });

  it("parses every bundled face", () => {
    expect([...FACES.fonts.keys()].sort()).toEqual([...tableFontFiles()].sort());
  });
});

describe("faceOf", () => {
  it("finds the file and render size of every cssFontString value through FONT_FILES", () => {
    for (const { css, file, renderSize } of ALL_CSS_FONTS) expect(faceOf(css), css).toEqual({ file, renderSize });
  });

  it("rejects a family no bundled file has and a string cssFontString does not build", () => {
    expect(() => faceOf('16px "Chicago", sans-serif')).toThrow(/no bundled font file/);
    expect(() => faceOf("bold 16px sans-serif")).toThrow(/not a font string/);
    expect(() => faceOf(`16px "${FONT_FILES["PixelOperator.ttf"].family}"`)).toThrow(/not a font string/);
  });
});

describe("createNodeTextBackend: measureText", () => {
  it("is the exact sum of the hmtx advances, scaled to the render size and not rounded", () => {
    for (const { css } of ALL_CSS_FONTS) {
      let sum = 0;
      for (const ch of PRINTABLE_ASCII) sum += advanceOf(css, ch.codePointAt(0)!);
      expect(backend.measureText(PRINTABLE_ASCII, css), css).toBe(sum);
    }
    // Pixel Operator at its native 16 px: 100 font units per pixel.
    const po = fontOf("PixelOperator.ttf");
    expect(backend.measureText("Hi", SANS_12)).toBe((po.advance(po.cmap.get(0x48)!) + po.advance(po.cmap.get(0x69)!)) / 100);
    expect(backend.measureText("", SANS_12)).toBe(0);
  });

  it("measures U+0009, U+000B and U+000C as a space, and U+00AD and U+200B as 0", () => {
    for (const { css } of ALL_CSS_FONTS) {
      const space = backend.measureText(" ", css);
      expect(space, css).toBeGreaterThan(0);
      for (const ch of ["\t", "\v", "\f"]) expect(backend.measureText(ch, css), css).toBe(space);
      for (const ch of ["\u00ad", "\u200b"]) expect(backend.measureText(ch, css), css).toBe(0);
    }
  });

  it("measures an uncovered character with the .notdef advance, a surrogate pair as one code point and a lone surrogate as its own code unit", () => {
    const notdef = advanceOf(SANS_12, 0x2603);
    expect(notdef).toBe((fontOf("PixelOperator.ttf").advance(0) * 16) / 1600);
    expect(backend.measureText("\u2603", SANS_12)).toBe(notdef);
    expect(backend.measureText("\u{1F600}", SANS_12)).toBe(notdef);
    expect(backend.measureText("\ud800", SANS_12)).toBe(notdef);
    expect(backend.measureText("\ud83d\ud83d", SANS_12)).toBe(2 * notdef);
  });
});

describe("createNodeTextBackend: drawText", () => {
  it("returns width * height alpha values, only 0 and 255", () => {
    const alpha = backend.drawText("Hello", SANS_12, 2, 14, 50, 20);
    expect(alpha.length).toBe(1000);
    expect(new Set(Array.from(alpha))).toEqual(new Set([0, 255]));
    expect(backend.drawText("Hello", SANS_12, 0, 0, 0, 5).length).toBe(0);
  });

  it("draws each glyph at x plus the advances of the code points before it", () => {
    for (const css of [SANS_12, SERIF_18, cssFontString("Mono", 9, true)]) {
      const together = draw("AB", css);
      const a = draw("A", css);
      const b = draw("B", css, 4 + advanceOf(css, 0x41));
      expect(together, css).toEqual(a.map((v, i) => Math.max(v, b[i])));
    }
  });

  it("draws U+0009, U+000B and U+000C as a space and nothing for U+00AD and U+200B", () => {
    expect(draw("a\tb\vc\fd")).toEqual(draw("a b c d"));
    expect(draw("a\u00adb\u200bc")).toEqual(draw("abc"));
    expect(draw("\u00ad\u200b").every((v) => v === 0)).toBe(true);
  });

  it("draws an uncovered character as the face's .notdef glyph", () => {
    const font = fontOf("PixelOperator.ttf");
    const expected = new Uint8Array(120 * 40);
    fillOutline(expected, 120, 40, font.outline(0), 16 / 1600, 4, 30);
    expect(expected.some((v) => v === 255)).toBe(true);
    for (const text of ["\u2603", "\u{1F600}", "\udc00"]) expect(draw(text)).toEqual(Array.from(expected));
  });

  it("lets renderCrisp1BitText lay out and draw text in Node without a canvas", () => {
    expect(typeof (globalThis as { OffscreenCanvas?: unknown }).OffscreenCanvas).toBe("undefined");
    const rect = { x: 0, y: 0, width: 200, height: 16 };
    const { mask, lineBoxes } = renderCrisp1BitText("Hello", "Sans", 12, [], rect, "left", true, backend);
    expect(lineBoxes).toHaveLength(1);
    expect(lineBoxes[0].width).toBe(Math.ceil(backend.measureText("Hello", SANS_12)));
    const inkColumns = new Set<number>();
    mask.forEach((v, i) => {
      if (v === 2) inkColumns.add(i % rect.width);
    });
    expect(Math.min(...inkColumns)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...inkColumns)).toBeLessThan(lineBoxes[0].width);
  });
});

describe("coveredCodePoints and uncoveredCharacters (Requirement 10.5, Glossary)", () => {
  it("covers the cmap plus U+0009, U+000B, U+000C, U+00AD and U+200B", () => {
    for (const file of tableFontFiles()) {
      const covered = coveredCodePoints(FACES, file);
      const expected = new Set([...fontOf(file).cmap.keys(), 0x09, 0x0b, 0x0c, 0xad, 0x200b]);
      expect(covered, file).toEqual(expected);
      for (const ch of PRINTABLE_ASCII) expect(covered.has(ch.codePointAt(0)!), file).toBe(true);
    }
  });

  it("lists each distinct uncovered character once, in order of first occurrence, as U+ and at least four uppercase hex digits", () => {
    const text = "a\u2603b\u{1F600}\u2603\u0001\ud800c\u{1F600}";
    expect(uncoveredCharacters(FACES, text, SANS_12)).toEqual(["U+2603", "U+1F600", "U+0001", "U+D800"]);
  });

  it("lists no covered character, no special code point and no hard line break", () => {
    expect(uncoveredCharacters(FACES, `${PRINTABLE_ASCII}\t\v\f\u00ad\u200b\r\n\r\n`, SANS_12)).toEqual([]);
    for (const { css, file } of ALL_CSS_FONTS) {
      const mapped = [...fontOf(file).cmap.keys()].map((cp) => String.fromCodePoint(cp)).join("");
      expect(uncoveredCharacters(FACES, mapped, css), css).toEqual([]);
    }
  });

  it("depends on the face: a character one face maps can be uncovered in another", () => {
    const fairfaxOnly = [...fontOf("FairfaxSerif-Latin.ttf").cmap.keys()].find((cp) => !fontOf("PixelOperator.ttf").cmap.has(cp));
    expect(fairfaxOnly).toBeDefined();
    const ch = String.fromCodePoint(fairfaxOnly!);
    expect(uncoveredCharacters(FACES, ch, SERIF_18)).toEqual([]);
    expect(uncoveredCharacters(FACES, ch, SANS_12)).toEqual([formatCodePoint(fairfaxOnly!)]);
  });

  it("formats code points with at least four digits", () => {
    expect(formatCodePoint(0x1)).toBe("U+0001");
    expect(formatCodePoint(0xabcd)).toBe("U+ABCD");
    expect(formatCodePoint(0x10ffff)).toBe("U+10FFFF");
  });
});
