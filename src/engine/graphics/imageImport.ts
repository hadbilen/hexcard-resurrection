// Import Image (spec 06 Requirement 6, design §imageImport.ts): file checks, header sizes, limits
// and the one "Import Image" history command on the edit target.
//
// Pure TypeScript except the injected decoder: the default decoder (`decodeImageBlobToRgba`, spec 03)
// needs a browser, so Node tests pass their own. The file is decoded from its bytes in memory: no
// URL, no <img>, no fetch (Requirement 6.6).

import { PaintStrokeCommand, type BitmapCodec, type HexHistory } from "../../core/history.ts";
import type { HexRect } from "../../core/schema.ts";
import { resolveEditTarget, type HexRuntimeState, type HexStore } from "../../core/store.ts";
import { decodeImageBlobToRgba, fitSize, importImageToBitmap, type RgbaImage } from "./atkinsonDither.ts";
import { bitmapCodec, isPaintTool } from "./paintTools.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS } from "./rleCodec.ts";

export const IMAGE_IMPORT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"] as const;
export type ImageImportType = (typeof IMAGE_IMPORT_TYPES)[number];
/** The file chooser's `accept` value. */
export const IMAGE_IMPORT_ACCEPT: string = IMAGE_IMPORT_TYPES.join(",");
export const IMAGE_IMPORT_MAX_BYTES = 16_777_216; // 16 MiB
export const IMAGE_IMPORT_MAX_SIDE = 8_192;
export const IMAGE_IMPORT_MAX_PIXELS = 16_777_216;

/** Requirements 6.3 and 6.10. */
export const IMPORT_MESSAGES = {
  type: "HexCard can import PNG, JPEG, GIF, WebP and BMP images.",
  size: "This image file is larger than 16 MB.",
  dimensions: "This image is larger than 8192 x 8192 pixels or 16 megapixels.",
  unreadable: "This image could not be read.",
  needsPaintTool: "Choose a paint tool to import an image.",
} as const;

/** What a File from the picker or a drop offers; Node tests pass plain objects. */
export interface ImageFileLike {
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ImageHeader {
  type: ImageImportType;
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------------------------
// Header sizes (Requirement 6.5)
// ---------------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, i) => bytes[offset + i] === value);
}

const ascii = (text: string): number[] => Array.from(text, (ch) => ch.charCodeAt(0));

const u16be = (b: Uint8Array, i: number): number => (b[i] << 8) | b[i + 1];
const u16le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);
const u24le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
const u32be = (b: Uint8Array, i: number): number => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
const u32le = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const i32le = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

function sized(type: ImageImportType, width: number, height: number): ImageHeader | null {
  return width > 0 && height > 0 ? { type, width, height } : null;
}

function readPng(b: Uint8Array): ImageHeader | null {
  if (b.length < 24 || !startsWith(b, ascii("IHDR"), 12)) return null;
  return sized("image/png", u32be(b, 16), u32be(b, 20));
}

function readGif(b: Uint8Array): ImageHeader | null {
  if (b.length < 10) return null;
  return sized("image/gif", u16le(b, 6), u16le(b, 8));
}

function readBmp(b: Uint8Array): ImageHeader | null {
  if (b.length < 18) return null;
  if (u32le(b, 14) === 12) {
    if (b.length < 22) return null; // BITMAPCOREHEADER: 16-bit sizes
    return sized("image/bmp", u16le(b, 18), u16le(b, 20));
  }
  if (b.length < 26) return null;
  // Negative heights mean a top-down bitmap.
  return sized("image/bmp", i32le(b, 18), Math.abs(i32le(b, 22)));
}

/** SOF markers C0-CF except DHT (C4), JPG (C8) and DAC (CC). */
const isStartOfFrame = (marker: number): boolean =>
  marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;

function readJpeg(b: Uint8Array): ImageHeader | null {
  let i = 2;
  while (i + 1 < b.length) {
    if (b[i] !== 0xff) return null;
    if (b[i + 1] === 0xff) {
      i++; // fill byte
      continue;
    }
    const marker = b[i + 1];
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      if (marker === 0xd9) return null; // end of image before any frame
      i += 2; // markers without a length
      continue;
    }
    if (i + 3 >= b.length) return null;
    const length = u16be(b, i + 2);
    if (length < 2) return null;
    if (isStartOfFrame(marker)) {
      if (i + 8 >= b.length) return null;
      return sized("image/jpeg", u16be(b, i + 7), u16be(b, i + 5));
    }
    i += 2 + length;
  }
  return null;
}

function readWebp(b: Uint8Array): ImageHeader | null {
  if (b.length < 16) return null;
  if (startsWith(b, ascii("VP8 "), 12)) {
    if (b.length < 30) return null;
    return sized("image/webp", u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (startsWith(b, ascii("VP8L"), 12)) {
    if (b.length < 25) return null;
    const bits = u32le(b, 21);
    return sized("image/webp", (bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (startsWith(b, ascii("VP8X"), 12)) {
    if (b.length < 30) return null;
    return sized("image/webp", u24le(b, 24) + 1, u24le(b, 27) + 1);
  }
  return null;
}

/** Requirement 6.5: format and size from the header bytes, or null when no supported header is found. */
export function readImageHeader(bytes: Uint8Array): ImageHeader | null {
  if (startsWith(bytes, PNG_SIGNATURE)) return readPng(bytes);
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) return readGif(bytes);
  if (startsWith(bytes, ascii("BM"))) return readBmp(bytes);
  if (startsWith(bytes, [0xff, 0xd8])) return readJpeg(bytes);
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) return readWebp(bytes);
  return null;
}

/** Requirement 6.5: each side at most 8,192 pixels and at most 16,777,216 pixels in all. */
export function withinImportLimits(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1
    && width <= IMAGE_IMPORT_MAX_SIDE && height <= IMAGE_IMPORT_MAX_SIDE
    && width * height <= IMAGE_IMPORT_MAX_PIXELS;
}

/** The aspect-fit rectangle `importImageToBitmap` fills: fitSize(width, height), centred with floor offsets. */
export function importRect(width: number, height: number): HexRect {
  const fit = fitSize(width, height);
  return {
    x: Math.floor((BITMAP_WIDTH - fit.width) / 2),
    y: Math.floor((BITMAP_HEIGHT - fit.height) / 2),
    width: fit.width,
    height: fit.height,
  };
}

// ---------------------------------------------------------------------------------------------
// The history command (Requirements 6.8, 6.9)
// ---------------------------------------------------------------------------------------------

function copyRect(pixels: Uint8Array, rect: HexRect): Uint8Array {
  const out = new Uint8Array(rect.width * rect.height);
  for (let row = 0; row < rect.height; row++) {
    const from = (rect.y + row) * BITMAP_WIDTH + rect.x;
    out.set(pixels.subarray(from, from + rect.width), row * rect.width);
  }
  return out;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Requirements 6.8 and 6.9: the "Import Image" PaintStrokeCommand that writes `imported`'s `rect`
 * into the edit target's layer (resolved from `state` now), or null if no pixel would change.
 * Pixels outside `rect` are not part of the command.
 */
export function createImportImageCommand(
  state: HexRuntimeState,
  imported: Uint8Array,
  rect: HexRect,
  codec: BitmapCodec = bitmapCodec,
): PaintStrokeCommand | null {
  if (imported.length !== TOTAL_PIXELS) {
    throw new Error(`Imported bitmap must hold ${TOTAL_PIXELS} pixels, got ${imported.length}`);
  }
  const target = resolveEditTarget(state);
  const layerPixels = codec.decode(target.owner.bitmap.rleData, target.layer === "card" ? 0 : 1);
  const before = copyRect(layerPixels, rect);
  const after = copyRect(imported, rect);
  if (sameBytes(before, after)) return null;
  return new PaintStrokeCommand({ layer: target.layer, layerOwnerId: target.owner.id, rect, before, after }, codec, "Import Image");
}

// ---------------------------------------------------------------------------------------------
// File import (Requirements 6.1-6.10)
// ---------------------------------------------------------------------------------------------

export interface ImportLimits {
  maxSide: number;
  maxPixels: number;
}

export const IMPORT_LIMITS: ImportLimits = { maxSide: IMAGE_IMPORT_MAX_SIDE, maxPixels: IMAGE_IMPORT_MAX_PIXELS };

export interface ImageImportDeps {
  store: Pick<HexStore, "getSnapshot">;
  history: Pick<HexHistory, "execute">;
  alert: (message: string) => void;
  /** Default: decodeImageBlobToRgba with the import limits (spec 03, browser only). */
  decode?: (blob: Blob, limits: ImportLimits) => Promise<RgbaImage>;
  codec?: BitmapCodec;
}

const isImportType = (type: string): type is ImageImportType => (IMAGE_IMPORT_TYPES as readonly string[]).includes(type);

/** Requirements 6.4-6.10. Resolves true when a command was executed. */
export async function importImageFile(file: ImageFileLike, deps: ImageImportDeps): Promise<boolean> {
  const fail = (message: string): false => {
    deps.alert(message);
    return false;
  };
  if (!isImportType(file.type)) return fail(IMPORT_MESSAGES.type);
  if (!(file.size <= IMAGE_IMPORT_MAX_BYTES)) return fail(IMPORT_MESSAGES.size);

  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch {
    return fail(IMPORT_MESSAGES.unreadable);
  }
  if (bytes.byteLength > IMAGE_IMPORT_MAX_BYTES) return fail(IMPORT_MESSAGES.size);
  const header = readImageHeader(bytes);
  if (!header) return fail(IMPORT_MESSAGES.unreadable);
  if (!withinImportLimits(header.width, header.height)) return fail(IMPORT_MESSAGES.dimensions);

  // The header's own type from here on: a renamed file is decoded by what it contains.
  const decode = deps.decode ?? decodeImageBlobToRgba;
  let imported: Uint8Array;
  let rect: HexRect;
  try {
    const rgba = await decode(new Blob([bytes], { type: header.type }), IMPORT_LIMITS);
    if (!withinImportLimits(rgba.width, rgba.height)) return fail(IMPORT_MESSAGES.dimensions);
    imported = importImageToBitmap(rgba);
    rect = importRect(rgba.width, rgba.height);
  } catch (error) {
    return fail(error instanceof RangeError ? IMPORT_MESSAGES.dimensions : IMPORT_MESSAGES.unreadable);
  }

  const command = createImportImageCommand(deps.store.getSnapshot(), imported, rect, deps.codec);
  if (!command) return false;
  deps.history.execute(command);
  return true;
}

/** Requirements 6.2, 6.3: the paint-tool check of a drop, then importImageFile. */
export async function importDroppedImage(file: ImageFileLike, deps: ImageImportDeps): Promise<boolean> {
  if (!isPaintTool(deps.store.getSnapshot().tool)) {
    deps.alert(IMPORT_MESSAGES.needsPaintTool);
    return false;
  }
  return importImageFile(file, deps);
}
