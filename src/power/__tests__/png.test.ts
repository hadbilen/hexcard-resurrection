// Spec 07 task 4.2: the PNG encoder (Requirement 9.4; design §png.ts).
import { describe, expect, it } from "vitest";
import { THEME_PALETTES } from "../../core/schema.ts";
import { TOTAL_PIXELS } from "../../engine/graphics/rleCodec.ts";
import { encodeFramePng } from "../png.ts";
import { crc32Reference, readPng } from "./pngReader.ts";
const CLASSIC = THEME_PALETTES.ClassicPaper;
const frameOf = (fill: 1 | 2, dark: Array<[number, number]> = []): Uint8Array => {
  const frame = new Uint8Array(TOTAL_PIXELS).fill(fill);
  for (const [x, y] of dark) frame[y * 512 + x] = fill === 1 ? 2 : 1;
  return frame;
};
describe("encodeFramePng layout", () => {
  it("writes the signature and exactly the chunks IHDR, PLTE, IDAT and IEND, each with a correct CRC", () => {
    for (const scale of [1, 2] as const) {
      const png = encodeFramePng(frameOf(1, [[3, 4]]), scale, CLASSIC);
      expect(Array.from(png.subarray(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const decoded = readPng(png); // throws on a bad CRC, a trailing byte or a bad length
      expect(decoded.chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
      expect(decoded.chunks[3].data.length).toBe(0);
    }
  });
  it("writes the IHDR of Requirement 9.4: 512k x 342k, bit depth 1, indexed colour, no interlace", () => {
    const one = readPng(encodeFramePng(frameOf(1), 1, CLASSIC));
    expect([one.width, one.height, one.bitDepth, one.colourType, one.compression, one.filterMethod, one.interlace]).toEqual([512, 342, 1, 3, 0, 0, 0]);
    const two = readPng(encodeFramePng(frameOf(1), 2, CLASSIC));
    expect([two.width, two.height, two.bitDepth, two.colourType, two.compression, two.filterMethod, two.interlace]).toEqual([1024, 684, 1, 3, 0, 0, 0]);
  });
  it("matches the IHDR and PLTE bytes computed by hand, with the CRCs of the independent reference", () => {
    const png = encodeFramePng(frameOf(1), 1, { lightBitHex: "#ffb000", darkBitHex: "#1A1000" });
    // IHDR: length 13, "IHDR", 512, 342, 1, 3, 0, 0, 0.
    const ihdr = [0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 2, 0, 0, 0, 1, 0x56, 1, 3, 0, 0, 0];
    expect(Array.from(png.subarray(8, 8 + ihdr.length))).toEqual(ihdr);
    const ihdrCrc = crc32Reference(png.subarray(12, 12 + 17));
    expect(Array.from(png.subarray(8 + 21, 8 + 25))).toEqual([ihdrCrc >>> 24, (ihdrCrc >>> 16) & 255, (ihdrCrc >>> 8) & 255, ihdrCrc & 255]);
    // PLTE: length 6, "PLTE", entry 0 = light #FFB000, entry 1 = dark #1A1000 (hex read case-insensitively).
    const plteStart = 8 + 25;
    expect(Array.from(png.subarray(plteStart, plteStart + 18))).toEqual([0, 0, 0, 6, 0x50, 0x4c, 0x54, 0x45, 255, 176, 0, 26, 16, 0, ...Array.from(png.subarray(plteStart + 14, plteStart + 18))]);
    expect(readPng(png).palette).toEqual([[255, 176, 0], [26, 16, 0]]);
  });
  it("packs rows MSB first with filter byte 0: pixel (0,0) and (511,341) dark at scale 1", () => {
    const { raw } = readPng(encodeFramePng(frameOf(1, [[0, 0], [511, 341]]), 1, CLASSIC));
    const stride = 65;
    expect(raw.length).toBe(stride * 342);
    expect(Array.from(raw.subarray(0, stride))).toEqual([0, 0x80, ...new Array(63).fill(0)]);
    expect(Array.from(raw.subarray(1 * stride, 2 * stride))).toEqual(new Array(stride).fill(0));
    expect(Array.from(raw.subarray(341 * stride, 342 * stride))).toEqual([0, ...new Array(63).fill(0), 0x01]);
  });
  it("fills the k x k block of every pixel at scale 2: a dark (0,0) is 11 in two rows, (511,341) the last two bits of the last two rows", () => {
    const { raw } = readPng(encodeFramePng(frameOf(1, [[0, 0], [511, 341]]), 2, CLASSIC));
    const stride = 129;
    expect(raw.length).toBe(stride * 684);
    for (const row of [0, 1]) {
      expect(Array.from(raw.subarray(row * stride, (row + 1) * stride))).toEqual([0, 0xc0, ...new Array(127).fill(0)]);
    }
    expect(Array.from(raw.subarray(2 * stride, 3 * stride))).toEqual(new Array(stride).fill(0));
    for (const row of [682, 683]) {
      expect(Array.from(raw.subarray(row * stride, (row + 1) * stride))).toEqual([0, ...new Array(127).fill(0), 0x03]);
    }
  });
  it("gives bit 0 to state 1 and bit 1 to state 2: an all-dark frame is all one bits", () => {
    const decoded = readPng(encodeFramePng(frameOf(2), 1, CLASSIC));
    expect(decoded.indices.every((index) => index === 1)).toBe(true);
    const light = readPng(encodeFramePng(frameOf(1), 1, CLASSIC));
    expect(light.indices.every((index) => index === 0)).toBe(true);
  });
  it("puts each pixel of a mixed row into its own bits at both scales", () => {
    const frame = frameOf(1, [[1, 7], [2, 7], [9, 7], [200, 100]]);
    for (const scale of [1, 2] as const) {
      const { indices, width } = readPng(encodeFramePng(frame, scale, CLASSIC));
      let wrong = 0;
      for (let y = 0; y < 342; y++) {
        for (let x = 0; x < 512; x++) {
          const want = frame[y * 512 + x] === 2 ? 1 : 0;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            if (indices[(y * scale + dy) * width + x * scale + dx] !== want) wrong++;
          }
        }
      }
      expect(wrong).toBe(0);
    }
  });
  it("gives the same bytes for the same frame, scale and palette", () => {
    const frame = frameOf(1, [[5, 5], [300, 200]]);
    for (const scale of [1, 2] as const) {
      expect(Buffer.from(encodeFramePng(frame, scale, CLASSIC)).equals(Buffer.from(encodeFramePng(frame.slice(), scale, { ...CLASSIC })))).toBe(true);
    }
  });
});
describe("encodeFramePng programming errors", () => {
  it("throws on a frame state other than 1 or 2", () => {
    for (const state of [0, 3]) {
      const frame = frameOf(1);
      frame[1000] = state;
      expect(() => encodeFramePng(frame, 1, CLASSIC)).toThrow(/invalid pixel state/);
    }
  });
  it("throws on a frame of the wrong length, a scale outside 1 and 2, and a palette colour that is not #RRGGBB", () => {
    expect(() => encodeFramePng(new Uint8Array(10).fill(1), 1, CLASSIC)).toThrow(/expected 175104 pixels/);
    expect(() => encodeFramePng(frameOf(1), 3 as unknown as 1, CLASSIC)).toThrow(/scale must be 1 or 2/);
    expect(() => encodeFramePng(frameOf(1), 1, { lightBitHex: "white", darkBitHex: "#000000" })).toThrow(/not a #RRGGBB colour/);
  });
});
