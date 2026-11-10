// Atkinson image import: scale-to-fit, luminance conversion and error-diffusion dithering.
// The dithering function is copied from hexcard_design_spec.md §5.1. Everything except
// `decodeImageBlobToRgba` is pure and runs in Node.

import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS } from "./rleCodec.ts";

/** Decoded image in non-premultiplied RGBA8 (the layout of browser `ImageData`). */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray | Uint8Array;
}

/**
 * Bill Atkinson error diffusion (§5.1): 1/8 of the quantization error goes to each of
 * 6 neighbours, so 6/8 of the error is diffused. Output states: 2 = dark, 1 = light.
 */
export function applyAtkinsonDithering(
  grayscaleBuffer: Float32Array,
  width: number,
  height: number,
  threshold = 128
): Uint8Array {
  const out = new Uint8Array(width * height);
  const lum = new Float32Array(grayscaleBuffer);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = lum[idx];
      const newPixel = oldPixel < threshold ? 0 : 255;
      out[idx] = newPixel === 0 ? 2 : 1; // 2 = Black Bit, 1 = White Bit

      const err = (oldPixel - newPixel) / 8; // 1/8th of error

      if (x + 1 < width) lum[idx + 1] += err;
      if (x + 2 < width) lum[idx + 2] += err;
      if (y + 1 < height) {
        if (x - 1 >= 0) lum[(y + 1) * width + (x - 1)] += err;
        lum[(y + 1) * width + x] += err;
        if (x + 1 < width) lum[(y + 1) * width + (x + 1)] += err;
      }
      if (y + 2 < height) {
        lum[(y + 2) * width + x] += err;
      }
    }
  }
  return out;
}

function assertImage(img: RgbaImage): void {
  if (!Number.isInteger(img.width) || !Number.isInteger(img.height) || img.width < 1 || img.height < 1) {
    throw new Error(`Invalid image size ${img.width}x${img.height}`);
  }
  if (img.data.length !== img.width * img.height * 4) {
    throw new Error(`Invalid RGBA buffer length: expected ${img.width * img.height * 4}, got ${img.data.length}`);
  }
}

/**
 * Luminance `0.299R + 0.587G + 0.114B` per pixel, range 0..255. Pixels with alpha < 255 are
 * first composited over white.
 */
export function rgbaToLuminance(img: RgbaImage): Float32Array {
  assertImage(img);
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3] / 255;
    const r = d[i * 4] * a + 255 * (1 - a);
    const g = d[i * 4 + 1] * a + 255 * (1 - a);
    const b = d[i * 4 + 2] * a + 255 * (1 - a);
    out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return out;
}

/**
 * Size of an image scaled (up or down) to fit inside `maxW x maxH` with its aspect ratio
 * kept. Each side is at least 1 px and at most the maximum.
 */
export function fitSize(
  srcW: number,
  srcH: number,
  maxW = BITMAP_WIDTH,
  maxH = BITMAP_HEIGHT
): { width: number; height: number } {
  if (!(srcW >= 1) || !(srcH >= 1)) throw new Error(`Invalid image size ${srcW}x${srcH}`);
  const s = Math.min(maxW / srcW, maxH / srcH);
  return {
    width: Math.min(maxW, Math.max(1, Math.round(srcW * s))),
    height: Math.min(maxH, Math.max(1, Math.round(srcH * s))),
  };
}

/** Per-destination-pixel list of (source index, weight) pairs for exact area averaging along one axis. */
function axisWeights(srcLen: number, dstLen: number): { idx: Int32Array; w: Float32Array; start: Int32Array } {
  const ratio = srcLen / dstLen;
  const idx: number[] = [];
  const w: number[] = [];
  const start = new Int32Array(dstLen + 1);
  for (let d = 0; d < dstLen; d++) {
    start[d] = idx.length;
    const lo = d * ratio;
    const hi = (d + 1) * ratio;
    const first = Math.floor(lo);
    const last = Math.min(srcLen - 1, Math.ceil(hi) - 1);
    let total = 0;
    const from = idx.length;
    for (let s = first; s <= last; s++) {
      const cover = Math.min(hi, s + 1) - Math.max(lo, s);
      if (cover <= 0) continue;
      idx.push(s);
      w.push(cover);
      total += cover;
    }
    for (let k = from; k < w.length; k++) w[k] /= total;
  }
  start[dstLen] = idx.length;
  return { idx: Int32Array.from(idx), w: Float32Array.from(w), start };
}

/**
 * Resamples a single-channel buffer to `dstW x dstH` by area averaging (box filter, also used
 * when enlarging).
 */
export function resampleGray(
  src: Float32Array,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): Float32Array {
  const ax = axisWeights(srcW, dstW);
  const ay = axisWeights(srcH, dstH);
  const tmp = new Float32Array(dstW * srcH); // horizontal pass
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < dstW; x++) {
      let acc = 0;
      for (let k = ax.start[x]; k < ax.start[x + 1]; k++) acc += src[y * srcW + ax.idx[k]] * ax.w[k];
      tmp[y * dstW + x] = acc;
    }
  }
  const out = new Float32Array(dstW * dstH); // vertical pass
  for (let y = 0; y < dstH; y++) {
    for (let x = 0; x < dstW; x++) {
      let acc = 0;
      for (let k = ay.start[y]; k < ay.start[y + 1]; k++) acc += tmp[ay.idx[k] * dstW + x] * ay.w[k];
      out[y * dstW + x] = acc;
    }
  }
  return out;
}

/**
 * Requirement 5.1 pipeline: luminance, scale to fit 512x342, Atkinson dithering.
 * Returns a 175,104-state layer buffer (states 1 and 2 inside the image, centred; 0 =
 * transparent in the unused margin when the aspect ratio differs from 512:342).
 */
export function importImageToBitmap(img: RgbaImage): Uint8Array {
  const lum = rgbaToLuminance(img);
  const { width: w, height: h } = fitSize(img.width, img.height);
  const scaled = w === img.width && h === img.height ? lum : resampleGray(lum, img.width, img.height, w, h);
  const dithered = applyAtkinsonDithering(scaled, w, h);

  const out = new Uint8Array(TOTAL_PIXELS);
  const ox = Math.floor((BITMAP_WIDTH - w) / 2);
  const oy = Math.floor((BITMAP_HEIGHT - h) / 2);
  for (let y = 0; y < h; y++) {
    out.set(dithered.subarray(y * w, (y + 1) * w), (oy + y) * BITMAP_WIDTH + ox);
  }
  return out;
}

/**
 * Browser adapter: decodes an image file (PNG, JPEG, GIF, WebP, ...) to RGBA through
 * `createImageBitmap` and `OffscreenCanvas`. Not usable in Node.
 *
 * Spec 06 (Import Image): with `limits`, a decoded bitmap wider or taller than `maxSide` or with
 * more than `maxPixels` pixels is closed and a `RangeError` is thrown before any canvas is
 * allocated. Without `limits`, behaviour is unchanged.
 */
export async function decodeImageBlobToRgba(
  blob: Blob,
  limits?: { maxSide: number; maxPixels: number },
): Promise<RgbaImage> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas !== "function") {
    throw new Error("Image decoding is not available in this environment");
  }
  const bitmap = await createImageBitmap(blob);
  try {
    if (limits) {
      const { width, height } = bitmap;
      if (width > limits.maxSide || height > limits.maxSide || width * height > limits.maxPixels) {
        throw new RangeError(`Decoded image ${width}x${height} exceeds the import limits`);
      }
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    ctx.drawImage(bitmap, 0, 0);
    const { width, height, data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width, height, data };
  } finally {
    bitmap.close();
  }
}
