import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  applyAtkinsonDithering,
  fitSize,
  importImageToBitmap,
  resampleGray,
  rgbaToLuminance,
  type RgbaImage,
} from "../atkinsonDither";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS } from "../rleCodec";

function solid(w: number, h: number, r: number, g: number, b: number, a = 255): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, a], i * 4);
  return { width: w, height: h, data };
}

describe("applyAtkinsonDithering", () => {
  it("matches a hand-computed 4x4 mid-gray result", () => {
    // Hand computation (threshold 128, err = (old - new) / 8 to the 6 neighbours):
    //  (0,0) 128 -> light, err -15.875  -> (1,0)=112.125 (2,0)=112.125 (0,1)=112.125 (1,1)=112.125 (0,2)=112.125
    //  (1,0) 112.125 -> dark, err +14.0156 ... and so on across the grid. Every decision is
    //  at least 2 away from the threshold, so float32 rounding cannot change the outcome.
    const input = new Float32Array(16).fill(128);
    const out = applyAtkinsonDithering(input, 4, 4);
    expect(Array.from(out)).toEqual([
      1, 2, 2, 1,
      2, 1, 1, 2,
      2, 1, 1, 2,
      1, 2, 2, 1,
    ]);
  });

  it("maps pure white to 1 and pure black to 2, and does not mutate the input", () => {
    const white = new Float32Array(16).fill(255);
    const black = new Float32Array(16).fill(0);
    expect(Array.from(applyAtkinsonDithering(white, 4, 4))).toEqual(new Array(16).fill(1));
    expect(Array.from(applyAtkinsonDithering(black, 4, 4))).toEqual(new Array(16).fill(2));
    expect(Array.from(white)).toEqual(new Array(16).fill(255));
  });

  it("only emits states 1 and 2 for arbitrary input (property)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 12 }),
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 144, maxLength: 144 }),
        (w, h, vals) => {
          const out = applyAtkinsonDithering(Float32Array.from(vals.slice(0, w * h)), w, h);
          return out.length === w * h && out.every((v) => v === 1 || v === 2);
        }
      )
    );
  });
});

describe("rgbaToLuminance", () => {
  it("uses 0.299R + 0.587G + 0.114B", () => {
    const img: RgbaImage = { width: 3, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255]) };
    const l = rgbaToLuminance(img);
    expect(l[0]).toBeCloseTo(0.299 * 255, 3);
    expect(l[1]).toBeCloseTo(0.587 * 255, 3);
    expect(l[2]).toBeCloseTo(0.114 * 255, 3);
  });

  it("composites transparent pixels over white", () => {
    expect(rgbaToLuminance(solid(1, 1, 0, 0, 0, 0))[0]).toBeCloseTo(255, 3);
  });

  it("rejects a buffer of the wrong length", () => {
    expect(() => rgbaToLuminance({ width: 2, height: 2, data: new Uint8Array(4) })).toThrow();
  });
});

describe("fitSize / resampleGray", () => {
  it("fits inside 512x342 keeping the aspect ratio, enlarging small images", () => {
    expect(fitSize(1024, 684)).toEqual({ width: 512, height: 342 });
    expect(fitSize(100, 100)).toEqual({ width: 342, height: 342 });
    expect(fitSize(1000, 100)).toEqual({ width: 512, height: 51 });
    expect(fitSize(1, 1000)).toEqual({ width: 1, height: 342 });
  });

  it("area-averages when shrinking", () => {
    const src = Float32Array.from([0, 100, 200, 100]);
    const out = resampleGray(src, 4, 1, 2, 1);
    expect(Array.from(out)).toEqual([50, 150]);
  });
});

describe("importImageToBitmap", () => {
  it("fills the whole layer for a 512:342 image", () => {
    const out = importImageToBitmap(solid(512, 342, 255, 255, 255));
    expect(out.length).toBe(TOTAL_PIXELS);
    expect(out.every((v) => v === 1)).toBe(true);
    expect(importImageToBitmap(solid(256, 171, 0, 0, 0)).every((v) => v === 2)).toBe(true);
  });

  it("centres a non-matching aspect ratio and leaves the margin transparent", () => {
    const out = importImageToBitmap(solid(100, 100, 0, 0, 0)); // fits to 342x342
    const ox = (BITMAP_WIDTH - 342) / 2; // 85
    for (let y = 0; y < BITMAP_HEIGHT; y++) {
      expect(out[y * BITMAP_WIDTH + ox - 1]).toBe(0);
      expect(out[y * BITMAP_WIDTH + ox]).toBe(2);
      expect(out[y * BITMAP_WIDTH + ox + 341]).toBe(2);
      expect(out[y * BITMAP_WIDTH + ox + 342]).toBe(0);
    }
  });
});
