/// <reference types="node" />
// 1-bit indexed PNG encoder for render_card (spec 07 Requirement 9.4; design §png.ts, D12).
//
// Chunks IHDR, PLTE, IDAT, IEND only. The frame pixel (x, y) fills the k x k block that starts at
// (kx, ky); state 1 is palette entry 0 (the light colour) and state 2 is entry 1 (the dark colour).
// The image data goes through one zlib.deflateSync call at level 9 and the chunk CRCs come from
// zlib.crc32, so the same frame, scale and palette give the same bytes on the same Node binary
// (Requirement 9.7). Both functions are Node built-ins that Node.js 22.13.0 provides (22.2.0 for
// crc32; Requirement 2.4).
import { crc32, deflateSync } from "node:zlib";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS } from "../engine/graphics/rleCodec.ts";
const SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const HEX_COLOUR = /^#([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})([0-9A-Fa-f]{2})$/;
function colourBytes(hex: string): number[] {
  const match = HEX_COLOUR.exec(hex);
  if (match === null) throw new Error(`encodeFramePng: "${hex}" is not a #RRGGBB colour`);
  return [match[1], match[2], match[3]].map((digits) => parseInt(digits, 16));
}
function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  // The CRC covers the type and the data.
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
/** Indexed-colour PNG, bit depth 1, palette [light, dark], no interlace, chunks IHDR PLTE IDAT IEND only. */
export function encodeFramePng(frame: Uint8Array, scale: 1 | 2, palette: { lightBitHex: string; darkBitHex: string }): Uint8Array {
  if (frame.length !== TOTAL_PIXELS) throw new Error(`encodeFramePng: expected ${TOTAL_PIXELS} pixels, got ${frame.length}`);
  if (scale !== 1 && scale !== 2) throw new Error(`encodeFramePng: scale must be 1 or 2, got ${String(scale)}`);
  const width = BITMAP_WIDTH * scale;
  const height = BITMAP_HEIGHT * scale;
  const rowBytes = width / 8; // 64 * scale, exact because 512 is a multiple of 8
  const stride = 1 + rowBytes; // filter byte 0, then the packed pixels
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < BITMAP_HEIGHT; y++) {
    const first = y * scale * stride; // the first of this frame row's `scale` identical output rows
    for (let x = 0; x < BITMAP_WIDTH; x++) {
      const state = frame[y * BITMAP_WIDTH + x];
      if (state !== 1 && state !== 2) throw new Error(`encodeFramePng: invalid pixel state ${state} at index ${y * BITMAP_WIDTH + x}`);
      if (state === 1) continue; // bit 0
      for (let i = 0; i < scale; i++) {
        const bit = x * scale + i;
        raw[first + 1 + (bit >> 3)] |= 0x80 >> (bit & 7);
      }
    }
    for (let r = 1; r < scale; r++) raw.copyWithin(first + r * stride, first, first + stride);
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 1; // bit depth
  ihdr[9] = 3; // colour type: indexed
  // compression 0, filter 0, interlace 0
  const plte = Uint8Array.from([...colourBytes(palette.lightBitHex), ...colourBytes(palette.darkBitHex)]);
  const idat = deflateSync(raw, { level: 9 });
  const parts = [SIGNATURE, chunk("IHDR", ihdr), chunk("PLTE", plte), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}
