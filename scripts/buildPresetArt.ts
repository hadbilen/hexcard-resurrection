/**
 * Draws the showcase stack art (spec 04 task 8, design.md §7) with the spec 03 engine and writes
 * the canonical `rleData` to `src/presets/presetArt.ts`:
 *
 *   npm run build:preset-art                 # rewrite src/presets/presetArt.ts
 *   npm run build:preset-art -- --check      # exit 1 if the committed file is out of date
 *   node scripts/buildPresetArt.ts [--check] # the same, on a Node with TypeScript type stripping
 *
 * Everything is procedural: 8x8 patterns and the 4-way flood fill (patterns.ts), Bresenham lines
 * (paintTools.ts) and Atkinson dithering of generated grey images (atkinsonDither.ts). Every layer
 * is encoded with `encodeBitmapRLE` (rleCodec.ts). No image or font files are read.
 *
 * Layer coordinates match the part rects in src/presets/*.ts (picture window, panels, key bed).
 * The drawing is deterministic (seeded generator), so the output only changes when this file does;
 * src/presets/__tests__/presets.test.ts checks that the committed file equals `renderPresetArtModule()`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { applyAtkinsonDithering } from "../src/engine/graphics/atkinsonDither.ts";
import { bresenhamLine } from "../src/engine/graphics/paintTools.ts";
import { PATTERNS, floodFill4, patternState, type Pattern } from "../src/engine/graphics/patterns.ts";
import { BITMAP_HEIGHT as H, BITMAP_WIDTH as W, TOTAL_PIXELS, encodeBitmapRLE, type PixelState } from "../src/engine/graphics/rleCodec.ts";

// ---------------------------------------------------------------------------------------------
// Drawing kit
// ---------------------------------------------------------------------------------------------

const LIGHT: PixelState = 1;
const DARK: PixelState = 2;

/** A pixel state, or a pattern evaluated at canvas coordinates (bit 1 = dark, 0 = light). */
type Ink = PixelState | Pattern;

const P = {
  grey75: PATTERNS[2],
  grey50: PATTERNS[3],
  grey25: PATTERNS[4],
  sparseDots: PATTERNS[5],
  hStripes: PATTERNS[6],
  vStripes2: PATTERNS[8],
  hStripes2: PATTERNS[9],
  thinH: PATTERNS[10],
  thinV: PATTERNS[11],
  diagDown: PATTERNS[13],
  wideDiagUp: PATTERNS[16],
  grid: PATTERNS[21],
  box: PATTERNS[22],
  bricks: PATTERNS[23],
  inverseBricks: PATTERNS[24],
  dots2: PATTERNS[25],
  checker4: PATTERNS[27],
  weave: PATTERNS[28],
  noise: PATTERNS[35],
} as const;

/** Deterministic generator (mulberry32), floats in [0, 1). */
function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Pt {
  x: number;
  y: number;
}

class Picture {
  readonly pixels: Uint8Array;

  /** Cards start transparent (0), backgrounds light (1). */
  constructor(fill: PixelState) {
    this.pixels = new Uint8Array(TOTAL_PIXELS).fill(fill);
  }

  plot(x: number, y: number, ink: Ink): void {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    this.pixels[y * W + x] = typeof ink === "number" ? ink : patternState(ink, x, y);
  }

  fillRect(x: number, y: number, w: number, h: number, ink: Ink): void {
    for (let py = y; py < y + h; py++) for (let px = x; px < x + w; px++) this.plot(px, py, ink);
  }

  frameRect(x: number, y: number, w: number, h: number, ink: Ink, thickness = 1): void {
    this.fillRect(x, y, w, thickness, ink);
    this.fillRect(x, y + h - thickness, w, thickness, ink);
    this.fillRect(x, y, thickness, h, ink);
    this.fillRect(x + w - thickness, y, thickness, h, ink);
  }

  /** Bresenham line with a square pen of `size` pixels. */
  line(x0: number, y0: number, x1: number, y1: number, ink: Ink, size = 1): void {
    bresenhamLine(Math.round(x0), Math.round(y0), Math.round(x1), Math.round(y1), (x, y) => {
      for (let dy = 0; dy < size; dy++) for (let dx = 0; dx < size; dx++) this.plot(x + dx, y + dy, ink);
    });
  }

  polyline(points: readonly Pt[], ink: Ink, size = 1): void {
    for (let i = 0; i + 1 < points.length; i++) this.line(points[i].x, points[i].y, points[i + 1].x, points[i + 1].y, ink, size);
  }

  fillEllipse(cx: number, cy: number, rx: number, ry: number, ink: Ink): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1) this.plot(x, y, ink);
      }
    }
  }

  frameEllipse(cx: number, cy: number, rx: number, ry: number, ink: Ink, thickness = 1): void {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const outer = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
        const inner = ((x - cx) / (rx - thickness)) ** 2 + ((y - cy) / (ry - thickness)) ** 2;
        if (outer <= 1 && inner > 1) this.plot(x, y, ink);
      }
    }
  }

  /** Even-odd scanline fill of a closed polygon (pixel centres). */
  fillPolygon(points: readonly Pt[], ink: Ink): void {
    const ys = points.map((p) => p.y);
    for (let y = Math.floor(Math.min(...ys)); y <= Math.ceil(Math.max(...ys)); y++) {
      const yc = y + 0.5;
      const crossings: number[] = [];
      for (let i = 0; i < points.length; i++) {
        const a = points[i];
        const b = points[(i + 1) % points.length];
        if (a.y > yc !== b.y > yc) crossings.push(a.x + ((yc - a.y) * (b.x - a.x)) / (b.y - a.y));
      }
      crossings.sort((p, q) => p - q);
      for (let k = 0; k + 1 < crossings.length; k += 2) {
        for (let x = Math.ceil(crossings[k] - 0.5); x <= Math.ceil(crossings[k + 1] - 0.5) - 1; x++) this.plot(x, y, ink);
      }
    }
  }

  /** Paint bucket: 4-way flood fill of the region containing (x, y) with `ink`. */
  bucket(x: number, y: number, ink: Ink): void {
    const mask = floodFill4(this.pixels, W, H, x, y);
    for (let i = 0; i < TOTAL_PIXELS; i++) if (mask[i]) this.plot(i % W, Math.floor(i / W), ink);
  }

  /** Spray can: `dots` random pixels within `radius` of (cx, cy). */
  spray(cx: number, cy: number, radius: number, dots: number, ink: Ink, random: () => number): void {
    for (let i = 0; i < dots; i++) {
      const angle = random() * Math.PI * 2;
      const r = Math.sqrt(random()) * radius;
      this.plot(Math.round(cx + Math.cos(angle) * r), Math.round(cy + Math.sin(angle) * r), ink);
    }
  }

  /**
   * Atkinson-dithers the grey image `luminance(x, y)` (0 = dark .. 255 = light) over the rect and
   * writes it where `inside(x, y)` holds (default: the whole rect).
   */
  dither(x: number, y: number, w: number, h: number, luminance: (x: number, y: number) => number, inside?: (x: number, y: number) => boolean): void {
    const grey = new Float32Array(w * h);
    for (let v = 0; v < h; v++) for (let u = 0; u < w; u++) grey[v * w + u] = luminance(x + u, y + v);
    const states = applyAtkinsonDithering(grey, w, h);
    for (let v = 0; v < h; v++) {
      for (let u = 0; u < w; u++) {
        if (!inside || inside(x + u, y + v)) this.plot(x + u, y + v, states[v * w + u] as PixelState);
      }
    }
  }

  encode(): string {
    return encodeBitmapRLE(this.pixels);
  }
}

const clamp = (value: number, lo = 0, hi = 255): number => Math.max(lo, Math.min(hi, value));

// ---------------------------------------------------------------------------------------------
// The Haunted Stack of 1987 (src/presets/hauntedMansion.ts)
// ---------------------------------------------------------------------------------------------

/** Picture window of the mansion background; every room picture fills exactly this rect. */
const ROOM = { x: 16, y: 42, w: 480, h: 180 } as const;

function hauntedBackground(): string {
  const pic = new Picture(LIGHT);
  pic.fillRect(0, 0, W, H, P.bricks);
  pic.frameRect(0, 0, W, H, DARK, 2);
  // Picture window: a 3 px frame with a light 1 px inner line.
  pic.frameRect(ROOM.x - 4, ROOM.y - 4, ROOM.w + 8, ROOM.h + 8, DARK, 3);
  pic.frameRect(ROOM.x - 1, ROOM.y - 1, ROOM.w + 2, ROOM.h + 2, LIGHT);
  pic.fillRect(ROOM.x, ROOM.y, ROOM.w, ROOM.h, LIGHT);
  // Button bar.
  pic.fillRect(8, 305, 496, 32, LIGHT);
  pic.frameRect(8, 305, 496, 32, DARK);
  pic.fillRect(10, 335, 496, 2, DARK); // hard 2 px shadow under the bar
  // Candle sconces left and right of the title.
  for (const x of [6, 500]) {
    pic.fillRect(x, 14, 6, 14, LIGHT);
    pic.frameRect(x, 14, 6, 14, DARK);
    pic.fillEllipse(x + 2.5, 10, 2, 3, DARK);
  }
  return pic.encode();
}

/** A room picture: the scene drawn by `draw`, clipped to the picture window. */
function room(draw: (pic: Picture, random: () => number) => void, seed: number): string {
  const scratch = new Picture(LIGHT);
  draw(scratch, createRandom(seed));
  const pic = new Picture(0);
  for (let y = ROOM.y; y < ROOM.y + ROOM.h; y++) {
    pic.pixels.set(scratch.pixels.subarray(y * W + ROOM.x, y * W + ROOM.x + ROOM.w), y * W + ROOM.x);
  }
  return pic.encode();
}

function hauntedGate(): string {
  return room((pic, random) => {
    const { x: x0, y: y0, w, h } = ROOM;
    const horizon = y0 + 150;
    const moon = { x: x0 + 380, y: y0 + 34, r: 22 };
    // Night sky: dark at the top, lighter towards the horizon, with a glowing moon.
    pic.dither(x0, y0, w, horizon - y0, (x, y) => {
      const d = Math.hypot(x - moon.x, y - moon.y);
      if (d <= moon.r) {
        const crater = [[-7, -5, 5], [6, 4, 4], [-2, 10, 3]].some(([dx, dy, r]) => Math.hypot(x - moon.x - dx, y - moon.y - dy) < r);
        return crater ? 170 : 245;
      }
      const glow = d < moon.r + 26 ? 70 * (1 - (d - moon.r) / 26) : 0;
      return clamp(18 + 70 * ((y - y0) / (horizon - y0)) + glow);
    });
    for (let i = 0; i < 40; i++) {
      const sx = x0 + Math.floor(random() * w);
      const sy = y0 + Math.floor(random() * 60);
      if (Math.hypot(sx - moon.x, sy - moon.y) > moon.r + 30) pic.plot(sx, sy, LIGHT);
    }
    // Hill and ground.
    pic.fillPolygon([
      { x: x0, y: horizon }, { x: x0 + 120, y: horizon - 14 }, { x: x0 + 360, y: horizon - 16 },
      { x: x0 + w, y: horizon - 2 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
    ], DARK);
    // Mansion silhouette: main block, gables and a tower.
    const base = horizon - 14;
    pic.fillRect(x0 + 150, base - 70, 170, 70, DARK);
    pic.fillPolygon([{ x: x0 + 140, y: base - 70 }, { x: x0 + 200, y: base - 108 }, { x: x0 + 260, y: base - 70 }], DARK);
    pic.fillPolygon([{ x: x0 + 236, y: base - 70 }, { x: x0 + 286, y: base - 98 }, { x: x0 + 330, y: base - 70 }], DARK);
    pic.fillRect(x0 + 300, base - 120, 40, 120, DARK);
    pic.fillPolygon([{ x: x0 + 294, y: base - 120 }, { x: x0 + 320, y: base - 160 }, { x: x0 + 346, y: base - 120 }], DARK);
    pic.line(x0 + 320, base - 160, x0 + 320, base - 172, DARK); // weather vane
    pic.line(x0 + 314, base - 168, x0 + 326, base - 168, DARK);
    // Windows: most dark, one lit with a cross bar, one flickering (50 % grey).
    for (let i = 0; i < 5; i++) {
      for (let row = 0; row < 2; row++) {
        const wx = x0 + 162 + i * 30;
        const wy = base - 60 + row * 30;
        pic.frameRect(wx, wy, 14, 18, P.grey25);
      }
    }
    pic.fillRect(x0 + 222, base - 60, 14, 18, LIGHT);
    pic.line(x0 + 229, base - 60, x0 + 229, base - 43, DARK);
    pic.line(x0 + 222, base - 52, x0 + 235, base - 52, DARK);
    pic.fillRect(x0 + 312, base - 104, 16, 20, P.grey50);
    // Iron fence with a gate arch in the middle.
    for (let x = x0 + 4; x < x0 + w; x += 8) {
      const inGate = x > x0 + 200 && x < x0 + 280;
      const top = inGate ? horizon - 52 : horizon - 34;
      pic.line(x, top, x, y0 + h - 1, DARK);
      pic.fillPolygon([{ x: x - 2, y: top + 3 }, { x: x + 0.5, y: top - 3 }, { x: x + 3, y: top + 3 }], DARK);
    }
    pic.line(x0, horizon - 26, x0 + w, horizon - 26, DARK, 2);
    pic.line(x0, horizon - 4, x0 + w, horizon - 4, DARK, 2);
    pic.frameEllipse(x0 + 240, horizon - 52, 40, 16, DARK, 2);
    // Dead tree on the left.
    pic.line(x0 + 60, y0 + h, x0 + 64, y0 + 70, DARK, 4);
    pic.polyline([{ x: x0 + 64, y: y0 + 90 }, { x: x0 + 34, y: y0 + 60 }, { x: x0 + 22, y: y0 + 62 }], DARK, 2);
    pic.polyline([{ x: x0 + 65, y: y0 + 78 }, { x: x0 + 96, y: y0 + 50 }, { x: x0 + 104, y: y0 + 36 }], DARK, 2);
    pic.polyline([{ x: x0 + 64, y: y0 + 70 }, { x: x0 + 70, y: y0 + 40 }, { x: x0 + 62, y: y0 + 26 }], DARK, 2);
    pic.line(x0 + 34, y0 + 60, x0 + 30, y0 + 44, DARK);
    pic.line(x0 + 96, y0 + 50, x0 + 116, y0 + 52, DARK);
    // Bats.
    for (const [bx, by] of [[x0 + 120, y0 + 30], [x0 + 150, y0 + 18], [x0 + 430, y0 + 80]]) {
      pic.polyline([{ x: bx - 6, y: by - 2 }, { x: bx - 3, y: by }, { x: bx, y: by - 1 }, { x: bx + 3, y: by }, { x: bx + 6, y: by - 2 }], DARK);
      pic.plot(bx, by, DARK);
    }
  }, 1987);
}

function hauntedHall(): string {
  return room((pic) => {
    const { x: x0, y: y0, w, h } = ROOM;
    const floor = y0 + 140;
    pic.fillRect(x0, y0, w, floor - y0, P.grey25); // wallpaper
    pic.fillRect(x0, floor - 40, w, 40, P.thinV); // wainscot
    pic.line(x0, floor - 41, x0 + w, floor - 41, DARK, 2);
    pic.fillRect(x0, floor, w, y0 + h - floor, P.checker4); // chequered floor
    pic.line(x0, floor, x0 + w, floor, DARK, 2);
    // Library door (left) with panels.
    const door = (dx: number, dw: number, dh: number, face: Ink): void => {
      pic.fillRect(dx, floor - dh, dw, dh, face);
      pic.frameRect(dx - 3, floor - dh - 3, dw + 6, dh + 3, DARK, 3);
    };
    door(x0 + 40, 56, 90, LIGHT);
    pic.frameRect(x0 + 46, floor - 82, 20, 34, DARK);
    pic.frameRect(x0 + 70, floor - 82, 20, 34, DARK);
    pic.frameRect(x0 + 46, floor - 42, 44, 30, DARK);
    pic.fillEllipse(x0 + 88, floor - 46, 2, 2, DARK);
    // Cellar door (middle), dark wood with a brass keyhole.
    door(x0 + 176, 52, 74, P.grey75);
    pic.fillEllipse(x0 + 216, floor - 38, 3, 3, LIGHT);
    pic.fillRect(x0 + 215, floor - 37, 3, 7, LIGHT);
    // Side table with the candle.
    pic.fillRect(x0 + 252, floor - 32, 44, 4, DARK);
    pic.line(x0 + 256, floor - 28, x0 + 256, floor, DARK, 2);
    pic.line(x0 + 290, floor - 28, x0 + 290, floor, DARK, 2);
    pic.fillRect(x0 + 270, floor - 46, 6, 14, LIGHT);
    pic.frameRect(x0 + 270, floor - 46, 6, 14, DARK);
    pic.fillEllipse(x0 + 272.5, floor - 51, 2, 4, DARK);
    // Grand staircase rising to the right.
    for (let i = 0; i < 10; i++) {
      const sx = x0 + 316 + i * 16;
      const sy = floor - (i + 1) * 12;
      pic.fillRect(sx, sy, w - (sx - x0), 12, LIGHT);
      pic.line(sx, sy, x0 + w, sy, DARK);
      pic.line(sx, sy, sx, sy + 12, DARK);
    }
    pic.line(x0 + 316, floor - 34, x0 + 476, floor - 154, DARK, 2); // banister
    for (let i = 0; i < 10; i++) pic.line(x0 + 322 + i * 16, floor - 12 * (i + 1), x0 + 322 + i * 16, floor - 12 * (i + 1) - 26, DARK);
    // Chandelier.
    pic.line(x0 + 150, y0, x0 + 150, y0 + 24, DARK);
    pic.frameEllipse(x0 + 150, y0 + 30, 26, 6, DARK, 2);
    for (const dx of [-24, -12, 0, 12, 24]) {
      pic.line(x0 + 150 + dx, y0 + 30, x0 + 150 + dx, y0 + 22, DARK);
      pic.fillEllipse(x0 + 150 + dx, y0 + 19, 1.5, 2.5, DARK);
    }
    // Portrait with staring eyes.
    pic.fillRect(x0 + 120, y0 + 44, 40, 46, LIGHT);
    pic.frameRect(x0 + 116, y0 + 40, 48, 54, DARK, 4);
    pic.fillEllipse(x0 + 140, y0 + 70, 12, 16, P.grey50);
    pic.fillRect(x0 + 134, y0 + 64, 3, 3, DARK);
    pic.fillRect(x0 + 143, y0 + 64, 3, 3, DARK);
  }, 2);
}

function hauntedLibrary(): string {
  return room((pic, random) => {
    const { x: x0, y: y0, w, h } = ROOM;
    const floor = y0 + 140;
    pic.fillRect(x0, y0, w, floor - y0, P.grey50);
    // Three shelves of books.
    const faces: Ink[] = [DARK, LIGHT, P.grey75, P.vStripes2, P.hStripes, P.grey25, P.weave];
    for (let shelf = 0; shelf < 3; shelf++) {
      const boardY = y0 + 44 + shelf * 46;
      let x = x0 + 4;
      while (x < x0 + w - 8) {
        const bw = 6 + Math.floor(random() * 9);
        const bh = 26 + Math.floor(random() * 14);
        if (random() < 0.08) {
          x += bw; // a gap on the shelf
          continue;
        }
        const face = faces[Math.floor(random() * faces.length)];
        pic.fillRect(x, boardY - bh, bw, bh, face);
        pic.frameRect(x, boardY - bh, bw, bh, DARK);
        if (bw > 9) pic.line(x + 2, boardY - bh + 4, x + bw - 3, boardY - bh + 4, face === DARK ? LIGHT : DARK);
        x += bw;
      }
      pic.fillRect(x0, boardY, w, 4, DARK);
    }
    // Floorboards and a reading desk with an open book.
    pic.fillRect(x0, floor, w, y0 + h - floor, P.thinH);
    pic.line(x0, floor, x0 + w, floor, DARK, 2);
    pic.fillRect(x0 + 180, floor - 14, 120, 8, DARK);
    pic.fillRect(x0 + 186, floor - 6, 6, 40, DARK);
    pic.fillRect(x0 + 288, floor - 6, 6, 40, DARK);
    pic.fillPolygon([{ x: x0 + 200, y: floor - 16 }, { x: x0 + 238, y: floor - 26 }, { x: x0 + 240, y: floor - 16 }], LIGHT);
    pic.fillPolygon([{ x: x0 + 240, y: floor - 16 }, { x: x0 + 242, y: floor - 26 }, { x: x0 + 280, y: floor - 16 }], LIGHT);
    pic.polyline([{ x: x0 + 200, y: floor - 16 }, { x: x0 + 238, y: floor - 26 }, { x: x0 + 242, y: floor - 26 }, { x: x0 + 280, y: floor - 16 }], DARK);
    // Cobwebs in the corners.
    for (const [cx, sx] of [[x0, 1], [x0 + w - 1, -1]]) {
      for (let i = 0; i < 5; i++) pic.line(cx, y0, cx + sx * (40 - i * 8), y0 + i * 8, LIGHT);
      for (let r = 10; r <= 34; r += 8) pic.polyline([{ x: cx + sx * r, y: y0 }, { x: cx + sx * r * 0.7, y: y0 + r * 0.7 }, { x: cx, y: y0 + r }], LIGHT);
    }
  }, 3);
}

function hauntedCellar(): string {
  return room((pic) => {
    const { x: x0, y: y0, w, h } = ROOM;
    const glow = { x: x0 + 240, y: y0 + 110 };
    // Candle light: a dithered glow that fades into the dark.
    pic.dither(x0, y0, w, h, (x, y) => {
      const d = Math.hypot((x - glow.x) * 0.8, y - glow.y);
      return clamp(210 * Math.pow(Math.max(0, 1 - d / 170), 1.6));
    });
    // Stone vaults.
    for (const cx of [x0 + 80, x0 + 240, x0 + 400]) pic.frameEllipse(cx, y0 + 90, 78, 86, DARK, 4);
    for (const px of [x0 + 160, x0 + 320]) pic.fillRect(px - 6, y0 + 60, 12, 120, P.bricks);
    // Coffin.
    const coffin: Pt[] = [
      { x: glow.x - 80, y: y0 + 140 }, { x: glow.x - 60, y: y0 + 124 }, { x: glow.x + 70, y: y0 + 122 },
      { x: glow.x + 86, y: y0 + 136 }, { x: glow.x + 66, y: y0 + 156 }, { x: glow.x - 60, y: y0 + 156 },
    ];
    pic.fillPolygon(coffin, DARK);
    pic.polyline([...coffin, coffin[0]], LIGHT);
    pic.line(glow.x - 8, y0 + 130, glow.x - 8, y0 + 150, LIGHT, 2);
    pic.line(glow.x - 16, y0 + 136, glow.x, y0 + 136, LIGHT, 2);
    // Floor flagstones.
    pic.fillRect(x0, y0 + 166, w, 14, P.box);
  }, 4);
}

function hauntedDawn(): string {
  return room((pic, random) => {
    const { x: x0, y: y0, w, h } = ROOM;
    const horizon = y0 + 120;
    const sun = { x: x0 + 300, y: horizon, r: 36 };
    pic.dither(x0, y0, w, horizon - y0, (x, y) => {
      const d = Math.hypot(x - sun.x, y - sun.y);
      if (d <= sun.r) return 255;
      const angle = Math.atan2(sun.y - y, x - sun.x);
      const ray = Math.cos(angle * 14) > 0.6 ? 40 : 0;
      return clamp(150 + 100 * (1 - (horizon - y) / (horizon - y0)) + ray - d / 12);
    });
    // Rolling hills and the mansion, small and far away.
    pic.fillPolygon([
      { x: x0, y: horizon + 6 }, { x: x0 + 160, y: horizon - 6 }, { x: x0 + 320, y: horizon + 4 },
      { x: x0 + w, y: horizon - 4 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
    ], P.grey75);
    pic.fillRect(x0 + 70, horizon - 28, 48, 24, DARK);
    pic.fillPolygon([{ x: x0 + 66, y: horizon - 28 }, { x: x0 + 94, y: horizon - 44 }, { x: x0 + 122, y: horizon - 28 }], DARK);
    pic.fillRect(x0 + 108, horizon - 52, 10, 24, DARK);
    // A path leading away.
    pic.fillPolygon([{ x: x0 + 236, y: y0 + h }, { x: x0 + 292, y: horizon + 4 }, { x: x0 + 298, y: horizon + 4 }, { x: x0 + 300, y: y0 + h }], LIGHT);
    // Birds.
    for (let i = 0; i < 6; i++) {
      const bx = x0 + 180 + Math.floor(random() * 240);
      const by = y0 + 16 + Math.floor(random() * 50);
      pic.polyline([{ x: bx - 4, y: by - 3 }, { x: bx, y: by }, { x: bx + 4, y: by - 3 }], DARK);
    }
  }, 5);
}

// ---------------------------------------------------------------------------------------------
// HexSynth Sequencer (src/presets/retroSynthDeck.ts)
// ---------------------------------------------------------------------------------------------

function synthBackground(): string {
  const pic = new Picture(LIGHT);
  pic.fillRect(0, 0, W, 40, DARK);
  pic.fillRect(0, 36, W, 4, P.hStripes);
  pic.fillRect(0, 298, W, H - 298, P.grey25);
  pic.line(0, 298, W, 298, DARK, 2);
  pic.frameRect(0, 0, W, H, DARK, 2);
  // Screws in the corners of the panel.
  for (const [sx, sy] of [[10, 50], [501, 50], [10, 288], [501, 288]]) {
    pic.fillEllipse(sx, sy, 3, 3, LIGHT);
    pic.frameEllipse(sx, sy, 3.5, 3.5, DARK);
    pic.line(sx - 2, sy, sx + 2, sy, DARK);
  }
  return pic.encode();
}

function synthKeyboard(): string {
  const pic = new Picture(0);
  // Wooden cheeks.
  for (const x of [20, 452]) {
    pic.fillRect(x, 46, 40, 246, P.weave);
    pic.frameRect(x, 46, 40, 246, DARK, 2);
  }
  // Speaker grilles.
  for (const cx of [116, 396]) {
    pic.fillEllipse(cx, 94, 40, 40, P.dots2);
    pic.frameEllipse(cx, 94, 41, 41, DARK, 3);
    pic.frameEllipse(cx, 94, 10, 10, DARK, 2);
  }
  // Voice panel behind the radio buttons.
  pic.fillRect(186, 48, 140, 92, LIGHT);
  pic.frameRect(186, 48, 140, 92, DARK);
  pic.fillRect(188, 140, 140, 2, DARK);
  // Key bed.
  pic.fillRect(88, 146, 336, 122, DARK);
  pic.fillRect(92, 150, 328, 2, P.grey50);
  return pic.encode();
}

function synthSequencer(): string {
  const pic = new Picture(0);
  // Oscilloscope: a sine and a square wave on a grid.
  pic.fillRect(104, 48, 382, 56, LIGHT);
  pic.fillRect(104, 48, 382, 56, P.grid);
  pic.fillRect(105, 49, 380, 54, P.sparseDots);
  pic.frameRect(102, 46, 386, 60, DARK, 2);
  let previous: Pt | null = null;
  for (let x = 106; x < 484; x++) {
    const point = { x, y: 62 + Math.round(10 * Math.sin((x - 106) / 12)) };
    if (previous) pic.line(previous.x, previous.y, point.x, point.y, DARK, 2);
    previous = point;
  }
  for (let x = 106; x < 484; x += 24) {
    pic.line(x, 96, x, 82, DARK);
    pic.line(x, 82, x + 12, 82, DARK);
    pic.line(x + 12, 82, x + 12, 96, DARK);
    pic.line(x + 12, 96, Math.min(x + 24, 483), 96, DARK);
  }
  // Step grid: bars 2 and 4 shaded, a rule between bars.
  pic.fillRect(100, 112, 390, 96, LIGHT);
  for (const bar of [1, 3]) pic.fillRect(100 + bar * 96, 113, 96, 94, P.grey25);
  for (const bar of [1, 2, 3]) pic.line(100 + bar * 96, 112, 100 + bar * 96, 207, DARK);
  pic.frameRect(98, 110, 394, 100, DARK, 2);
  // Playhead track.
  pic.fillRect(100, 214, 390, 8, P.hStripes2);
  pic.frameRect(98, 212, 394, 12, DARK);
  return pic.encode();
}

// ---------------------------------------------------------------------------------------------
// HexOracle 1987 (src/presets/apiWeatherOracle.ts)
// ---------------------------------------------------------------------------------------------

function oracleBackground(): string {
  const pic = new Picture(LIGHT);
  pic.frameRect(0, 0, W, H, DARK, 2);
  // Night panel with the crystal ball.
  const panel = { x: 16, y: 42, w: 176, h: 256 };
  pic.fillRect(panel.x, panel.y, panel.w, panel.h, DARK);
  pic.frameRect(panel.x - 2, panel.y - 2, panel.w + 4, panel.h + 4, DARK);
  const random = createRandom(1987);
  for (let i = 0; i < 6; i++) pic.spray(panel.x + 20 + random() * 136, panel.y + 16 + random() * 70, 18, 14, LIGHT, random);
  for (let i = 0; i < 30; i++) pic.plot(panel.x + Math.floor(random() * panel.w), panel.y + Math.floor(random() * 120), LIGHT);
  const ball = { x: 104, y: 160, r: 62 };
  pic.dither(ball.x - ball.r, ball.y - ball.r, 2 * ball.r + 1, 2 * ball.r + 1, (x, y) => {
    const dx = (x - ball.x) / ball.r;
    const dy = (y - ball.y) / ball.r;
    const z = Math.sqrt(Math.max(0, 1 - dx * dx - dy * dy));
    // Lambert shading lit from the upper left, a highlight, and swirling mist inside.
    const light = clamp(255 * Math.max(0, -0.5 * dx - 0.6 * dy + 0.62 * z));
    const highlight = Math.hypot(dx + 0.38, dy + 0.42) < 0.16 ? 255 : 0;
    const mist = 50 * Math.sin(6 * Math.atan2(dy, dx) + 9 * Math.hypot(dx, dy));
    return clamp(Math.max(light * 0.8 + 20 + mist, highlight));
  }, (x, y) => Math.hypot(x - ball.x, y - ball.y) <= ball.r);
  pic.frameEllipse(ball.x, ball.y, ball.r + 1, ball.r + 1, LIGHT, 2);
  // Pedestal.
  const top = ball.y + ball.r - 6;
  pic.fillPolygon([{ x: 60, y: top }, { x: 148, y: top }, { x: 166, y: 290 }, { x: 42, y: 290 }], LIGHT);
  pic.polyline([{ x: 60, y: top }, { x: 148, y: top }, { x: 166, y: 290 }, { x: 42, y: 290 }, { x: 60, y: top }], DARK);
  pic.bucket(104, top + 12, P.wideDiagUp);
  pic.fillRect(54, top, 100, 6, LIGHT);
  pic.frameRect(54, top, 100, 6, DARK);
  // Bottom rule above the status line.
  pic.fillRect(200, 300, 300, 2, DARK);
  return pic.encode();
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/** Every layer, keyed by the name the presets import. Order is the output order. */
export function buildPresetArt(): Record<string, string> {
  return {
    hauntedBackground: hauntedBackground(),
    hauntedGate: hauntedGate(),
    hauntedHall: hauntedHall(),
    hauntedLibrary: hauntedLibrary(),
    hauntedCellar: hauntedCellar(),
    hauntedDawn: hauntedDawn(),
    synthBackground: synthBackground(),
    synthKeyboard: synthKeyboard(),
    synthSequencer: synthSequencer(),
    oracleBackground: oracleBackground(),
  };
}

const CHUNK = 100;

/** Source of src/presets/presetArt.ts for `art`. */
export function renderPresetArtModule(art: Record<string, string> = buildPresetArt()): string {
  const lines = [
    "// Generated by scripts/buildPresetArt.ts with the spec 03 engine. Do not edit by hand;",
    "// run `npm run build:preset-art` after changing the drawing code.",
    "// Every value is HexBitmapLayer.rleData produced by encodeBitmapRLE (2-bit packing + PackBits + Base64).",
    "",
    "export const PRESET_ART = {",
  ];
  for (const [name, rle] of Object.entries(art)) {
    const chunks: string[] = [];
    for (let i = 0; i < rle.length; i += CHUNK) chunks.push(`    "${rle.slice(i, i + CHUNK)}",`);
    lines.push(`  ${name}: [`, ...chunks, '  ].join(""),');
  }
  lines.push("} as const;", "", "export type PresetArtName = keyof typeof PRESET_ART;", "");
  return lines.join("\n");
}

export const PRESET_ART_PATH = fileURLToPath(new URL("../src/presets/presetArt.ts", import.meta.url));

/** CLI entry: writes the module, or with `--check` only compares it. */
export function main(argv: readonly string[]): void {
  const source = renderPresetArtModule();
  if (argv.includes("--check")) {
    let current = "";
    try {
      current = readFileSync(PRESET_ART_PATH, "utf8");
    } catch {
      // a missing file is out of date
    }
    if (current !== source) {
      console.error("src/presets/presetArt.ts is out of date; run `npm run build:preset-art`.");
      process.exitCode = 1;
    }
    return;
  }
  mkdirSync(dirname(PRESET_ART_PATH), { recursive: true });
  writeFileSync(PRESET_ART_PATH, source);
  console.log(`Wrote ${PRESET_ART_PATH} (${source.length.toLocaleString("en-US")} characters).`);
}

// Direct run on a Node with TypeScript type stripping (official builds >= 22.18). `npm run
// build:preset-art` loads the file through Vite's module runner instead and calls `main`, which
// also works on Node builds without type stripping.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
