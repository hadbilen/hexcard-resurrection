// TextRasterBackend for Node (spec 07 Requirements 10.1, 10.2, 10.5, 10.6, 14.1; design
// §nodeTextBackend.ts).
//
// renderCrisp1BitText and the part renderer stay unchanged; only the backend differs from the
// studio's canvas backend. Glyph outlines and advances come from the font file of the text's face,
// which this module finds only through FONT_FILES from the cssFont string that cssFontString()
// built, so the logical-font-to-face mapping stays in TEXT_SIZE_TABLE. Pure TypeScript: no canvas,
// no FontFace, no native module, no file access.
import { FONT_FILES, type FontFileName, type TextRasterBackend } from "../engine/graphics/textRaster.ts";
import { fillOutline, parseTrueType, type TrueTypeFont } from "./trueType.ts";

export type FontBytes = Readonly<Record<FontFileName, Uint8Array>>;

export interface ParsedFaces {
  readonly fonts: ReadonlyMap<FontFileName, TrueTypeFont>;
}

/** Drawn and measured as U+0020 (space), whether or not the font maps them (Requirement 10.2). */
const AS_SPACE: ReadonlySet<number> = new Set([0x0009, 0x000b, 0x000c]);
/** Nothing drawn and an advance of 0, whether or not the font maps them (Requirement 10.2). */
const ZERO_WIDTH: ReadonlySet<number> = new Set([0x00ad, 0x200b]);

/** Parses every given font file (TrueTypeError on a file the reader cannot read). */
export function parseFaces(bytes: FontBytes): ParsedFaces {
  const fonts = new Map<FontFileName, TrueTypeFont>();
  for (const file of Object.keys(bytes) as FontFileName[]) fonts.set(file, parseTrueType(bytes[file]));
  return { fonts };
}

const CSS_FONT = /^(\d+)px "([^"]+)", [a-z-]+$/;

/** The face of a cssFontString() value: the FONT_FILES entry whose family it names, and its px size. */
export function faceOf(cssFont: string): { file: FontFileName; renderSize: number } {
  const match = CSS_FONT.exec(cssFont);
  if (match === null) throw new Error(`nodeTextBackend: "${cssFont}" is not a font string of cssFontString`);
  const renderSize = Number(match[1]);
  for (const file of Object.keys(FONT_FILES) as FontFileName[]) {
    if (FONT_FILES[file].family === match[2]) return { file, renderSize };
  }
  throw new Error(`nodeTextBackend: no bundled font file has the family "${match[2]}"`);
}

function fontOf(faces: ParsedFaces, file: FontFileName): TrueTypeFont {
  const font = faces.fonts.get(file);
  if (font === undefined) throw new Error(`nodeTextBackend: the font file ${file} was not parsed`);
  return font;
}

/** The glyph drawn for a code point (null: nothing drawn, no advance). */
function glyphFor(font: TrueTypeFont, codePoint: number): number | null {
  if (ZERO_WIDTH.has(codePoint)) return null;
  if (AS_SPACE.has(codePoint)) return font.cmap.get(0x20) ?? 0;
  return font.cmap.get(codePoint) ?? 0; // an uncovered character is drawn as .notdef (Requirement 10.5)
}

export function createNodeTextBackend(faces: ParsedFaces): TextRasterBackend {
  /** Calls `visit` with each code point's glyph (or null) and its unrounded advance in pixels. */
  const walk = (text: string, cssFont: string, visit: (glyph: number | null, advance: number, scale: number, font: TrueTypeFont) => void): void => {
    const { file, renderSize } = faceOf(cssFont);
    const font = fontOf(faces, file);
    const scale = renderSize / font.unitsPerEm;
    // for...of yields a surrogate pair as one code point and a lone surrogate as its own code unit.
    for (const character of text) {
      const glyph = glyphFor(font, character.codePointAt(0)!);
      visit(glyph, glyph === null ? 0 : (font.advance(glyph) * renderSize) / font.unitsPerEm, scale, font);
    }
  };

  return {
    measureText(text, cssFont) {
      let width = 0;
      walk(text, cssFont, (_glyph, advance) => {
        width += advance;
      });
      return width;
    },
    drawText(text, cssFont, x, baseline, width, height) {
      const alpha = new Uint8Array(width * height);
      if (width === 0 || height === 0) return alpha;
      let pen = x;
      walk(text, cssFont, (glyph, advance, scale, font) => {
        if (glyph !== null) fillOutline(alpha, width, height, font.outline(glyph), scale, pen, baseline);
        pen += advance;
      });
      return alpha;
    },
  };
}

function isCovered(font: TrueTypeFont, codePoint: number): boolean {
  return AS_SPACE.has(codePoint) || ZERO_WIDTH.has(codePoint) || font.cmap.has(codePoint);
}

/** Covered characters of a font file (Glossary): its cmap plus U+0009, U+000B, U+000C, U+00AD, U+200B. */
export function coveredCodePoints(faces: ParsedFaces, file: FontFileName): ReadonlySet<number> {
  return new Set([...fontOf(faces, file).cmap.keys(), ...AS_SPACE, ...ZERO_WIDTH]);
}

/** `U+` followed by at least four uppercase hexadecimal digits. */
export function formatCodePoint(codePoint: number): string {
  return `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Distinct uncovered characters of `text` in `cssFont`, in order of first occurrence, as "U+XXXX".
 * Hard line breaks are dropped first: the layout splits at them and never draws them.
 */
export function uncoveredCharacters(faces: ParsedFaces, text: string, cssFont: string): string[] {
  const font = fontOf(faces, faceOf(cssFont).file);
  const seen = new Set<number>();
  const found: string[] = [];
  for (const character of text.replace(/[\r\n]/g, "")) {
    const codePoint = character.codePointAt(0)!;
    if (seen.has(codePoint) || isCovered(font, codePoint)) continue;
    seen.add(codePoint);
    found.push(formatCodePoint(codePoint));
  }
  return found;
}
