/// <reference types="node" />
// Not a test: a small PNG reader for the render_card tests (spec 07 tasks 4.2 and 4.3). It checks
// the signature and every chunk CRC with its own table-driven CRC-32 (independent of the encoder's
// zlib.crc32), inflates the image data with node:zlib, and unpacks a bit-depth-1 indexed image
// whose rows all use filter 0.
import { inflateSync } from "node:zlib";
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
export function crc32Reference(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export interface PngChunk {
  type: string;
  data: Uint8Array;
}
export interface DecodedPng {
  chunks: PngChunk[];
  width: number;
  height: number;
  bitDepth: number;
  colourType: number;
  compression: number;
  filterMethod: number;
  interlace: number;
  /** PLTE entries as [r, g, b]. */
  palette: Array<[number, number, number]>;
  /** The inflated image data, filter bytes included. */
  raw: Uint8Array;
  /** One palette index (0 or 1) per pixel, row-major, width * height entries. */
  indices: Uint8Array;
}
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export function readPng(png: Uint8Array): DecodedPng {
  for (let i = 0; i < 8; i++) if (png[i] !== SIGNATURE[i]) throw new Error("not a PNG: bad signature");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: PngChunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(...png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    const stored = view.getUint32(offset + 8 + length);
    const expected = crc32Reference(png.subarray(offset + 4, offset + 8 + length));
    if (stored !== expected) throw new Error(`chunk ${type}: CRC ${stored} but computed ${expected}`);
    chunks.push({ type, data });
    offset += 12 + length;
  }
  if (offset !== png.length) throw new Error("trailing bytes after the last chunk");
  const header = chunks[0].data;
  const hv = new DataView(header.buffer, header.byteOffset, header.byteLength);
  const width = hv.getUint32(0);
  const height = hv.getUint32(4);
  const plte = chunks.find((chunk) => chunk.type === "PLTE")?.data ?? new Uint8Array(0);
  const palette: Array<[number, number, number]> = [];
  for (let i = 0; i + 2 < plte.length; i += 3) palette.push([plte[i], plte[i + 1], plte[i + 2]]);
  const compressed = Buffer.concat(chunks.filter((chunk) => chunk.type === "IDAT").map((chunk) => chunk.data));
  const raw = new Uint8Array(inflateSync(compressed));
  const rowBytes = Math.ceil(width / 8);
  if (raw.length !== (rowBytes + 1) * height) throw new Error(`image data has ${raw.length} bytes, expected ${(rowBytes + 1) * height}`);
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * (rowBytes + 1);
    if (raw[row] !== 0) throw new Error(`row ${y} uses filter ${raw[row]}`);
    for (let x = 0; x < width; x++) indices[y * width + x] = (raw[row + 1 + (x >> 3)] >> (7 - (x & 7))) & 1;
  }
  return {
    chunks,
    width,
    height,
    bitDepth: header[8],
    colourType: header[9],
    compression: header[10],
    filterMethod: header[11],
    interlace: header[12],
    palette,
    raw,
    indices,
  };
}
/** The PNG of a render_card result's second content (base64 in `data`). */
export function pngOfContent(content: { type: string; data?: string; mimeType?: string }): Uint8Array {
  if (content.type !== "image" || content.mimeType !== "image/png" || typeof content.data !== "string") {
    throw new Error("the content is not an image/png content");
  }
  return new Uint8Array(Buffer.from(content.data, "base64"));
}
