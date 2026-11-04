// 3-state bitmap codec: 2-bit packing + PackBits + Base64.
// Reference implementation copied from hexcard_design_spec.md §5.4.

export const BITMAP_WIDTH = 512;
export const BITMAP_HEIGHT = 342;
export const TOTAL_PIXELS = BITMAP_WIDTH * BITMAP_HEIGHT; // 175,104
export const PACKED_BYTES = TOTAL_PIXELS / 4; // 43,776 (4 pixels per byte, 2 bits each)

export type PixelState = 0 | 1 | 2; // 0 = Transparent, 1 = White/Light, 2 = Black/Dark

/**
 * Pixels -> 2-bit pack (MSB-first, 4 px/byte) -> PackBits -> Base64.
 * An all-transparent layer encodes to the empty string "".
 */
export function encodeBitmapRLE(pixels: Uint8Array): string {
  if (pixels.length !== TOTAL_PIXELS) {
    throw new Error(`Invalid bitmap buffer length: expected ${TOTAL_PIXELS}, got ${pixels.length}`);
  }
  const packed = new Uint8Array(PACKED_BYTES);
  let allTransparent = true;
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const v = pixels[i];
    if (v > 2) throw new Error(`Invalid pixel state ${v} at index ${i}`);
    if (v !== 0) allTransparent = false;
    packed[i >> 2] |= v << (6 - 2 * (i & 3));
  }
  if (allTransparent) return "";

  const out: number[] = [];
  let i = 0;
  while (i < PACKED_BYTES) {
    let run = 1;
    while (i + run < PACKED_BYTES && run < 128 && packed[i + run] === packed[i]) run++;
    if (run >= 2) {
      out.push(257 - run, packed[i]); // header 129..255 = repeat next byte (257 - header) times
      i += run;
      continue;
    }
    const start = i;
    while (i < PACKED_BYTES && i - start < 128) {
      // stop the literal where a run of 3+ identical bytes begins (a run of 2 is cheaper inside the literal)
      if (i + 2 < PACKED_BYTES && packed[i] === packed[i + 1] && packed[i] === packed[i + 2]) break;
      i++;
    }
    out.push(i - start - 1); // header 0..127 = copy next (header + 1) bytes literally
    for (let j = start; j < i; j++) out.push(packed[j]);
  }

  let binary = "";
  for (let k = 0; k < out.length; k += 0x8000) {
    binary += String.fromCharCode(...out.slice(k, k + 0x8000));
  }
  return btoa(binary);
}

/**
 * Inverse of encodeBitmapRLE. "" decodes to a layer filled with `emptyFill`
 * (cards: 0 = transparent, backgrounds: 1 = light). Throws on corrupt data.
 */
export function decodeBitmapRLE(rleData: string, emptyFill: PixelState = 0): Uint8Array {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  if (!rleData) {
    pixels.fill(emptyFill);
    return pixels;
  }
  const binary = atob(rleData);
  const packed = new Uint8Array(PACKED_BYTES);
  let r = 0;
  let w = 0;
  while (r < binary.length && w < PACKED_BYTES) {
    const header = binary.charCodeAt(r++);
    if (header < 128) {
      const count = header + 1;
      if (r + count > binary.length || w + count > PACKED_BYTES) throw new Error("Corrupt bitmap data (literal overflow)");
      for (let k = 0; k < count; k++) packed[w++] = binary.charCodeAt(r++);
    } else if (header > 128) {
      const count = 257 - header;
      if (r >= binary.length || w + count > PACKED_BYTES) throw new Error("Corrupt bitmap data (run overflow)");
      packed.fill(binary.charCodeAt(r++), w, w + count);
      w += count;
    } // header === 128 is a no-op (PackBits convention)
  }
  if (w !== PACKED_BYTES || r !== binary.length) throw new Error("Corrupt bitmap data (length mismatch)");

  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const v = (packed[i >> 2] >> (6 - 2 * (i & 3))) & 0x03;
    if (v === 3) throw new Error(`Corrupt bitmap data (invalid state 3 at index ${i})`);
    pixels[i] = v;
  }
  return pixels;
}
