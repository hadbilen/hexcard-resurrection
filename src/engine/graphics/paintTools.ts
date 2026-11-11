// Paint tools: pencil, brush, eraser, line, rect, spray, paint bucket, select, lasso.
// Contracts: spec 03 requirements 7.1-7.5 and design.md §6; patterns hexcard_design_spec.md §5.3.
//
// A `PaintController` turns pointer events (canvas coordinates, i.e. already divided by the integer
// scale factor) into strokes. At `begin` it reads the current tool and the Edit Background state
// from the store and decodes the target layer into a working copy; tools only ever write to that
// copy. At `end` the stroke's tight bounding rectangle (before/after pixels) is submitted as ONE
// `PaintStrokeCommand` to the history. `cancel` discards the copy and submits nothing.
//
// Pixel rules: pattern bit 1 -> dark (2), bit 0 -> light (1), evaluated at canvas coordinates.
// The pencil paints solid dark. The eraser writes 0 on the card layer and 1 on the background layer.
//
// Pure TypeScript: no DOM access, testable in Node.

import { PaintStrokeCommand, type BitmapCodec, type HexHistory } from "../../core/history.ts";
import type { AuthoringTool, HexID, HexRect } from "../../core/schema.ts";
import { resolveEditTarget, type HexLayer, type HexStore } from "../../core/store.ts";
import { floodFill4, patternState, PATTERNS, type Pattern } from "./patterns.ts";
import {
  BITMAP_HEIGHT as H,
  BITMAP_WIDTH as W,
  TOTAL_PIXELS,
  decodeBitmapRLE,
  encodeBitmapRLE,
  type PixelState,
} from "./rleCodec.ts";

/** Production codec for `PaintStrokeCommand` (spec 01 design §4). */
export const bitmapCodec: BitmapCodec = { encode: encodeBitmapRLE, decode: decodeBitmapRLE };

export type PaintTool = Extract<
  AuthoringTool,
  "pencil" | "brush" | "eraser" | "line" | "rect" | "spray" | "paintBucket" | "select" | "lasso"
>;

const PAINT_TOOLS: ReadonlySet<AuthoringTool> = new Set<AuthoringTool>([
  "pencil", "brush", "eraser", "line", "rect", "spray", "paintBucket", "select", "lasso",
]);

export function isPaintTool(tool: AuthoringTool): tool is PaintTool {
  return PAINT_TOOLS.has(tool);
}

const LABELS: Record<PaintTool, string> = {
  pencil: "Pencil",
  brush: "Brush",
  eraser: "Eraser",
  line: "Line",
  rect: "Rectangle",
  spray: "Spray",
  paintBucket: "Paint Bucket",
  select: "Move Selection",
  lasso: "Move Selection",
};

export interface PaintSettings {
  /** Fill pattern for brush, line, rect, spray and bucket: 8 bytes (see patterns.ts). */
  pattern: Pattern;
  /** Brush diameter in pixels (round stamp). Default 4. */
  brushSize?: number;
  /** Eraser edge length in pixels (square stamp). Default 8. */
  eraserSize?: number;
  /** Spray radius in pixels. Default 10. */
  sprayRadius?: number;
  /** Dots sprayed per pointer event. Default 8. */
  sprayDots?: number;
  /** Rect tool: paint the whole box instead of the 1-pixel frame. Default false. */
  rectFilled?: boolean;
}

export const DEFAULT_PAINT_SETTINGS: PaintSettings = { pattern: PATTERNS[1] };

export interface PaintControllerOptions {
  store: Pick<HexStore, "getSnapshot">;
  history: Pick<HexHistory, "execute">;
  getSettings: () => PaintSettings;
  codec?: BitmapCodec;
  /** Base seed of the spray generator; stroke n uses `seed + n`, so a session is reproducible. */
  seed?: number;
}

/** The current pixel selection (select and lasso tools). The mask is read-only. */
export interface PixelSelection {
  layer: HexLayer;
  layerOwnerId: HexID;
  bounds: HexRect;
  /** TOTAL_PIXELS entries, 1 = selected. */
  mask: Uint8Array;
}

export interface PaintController {
  /** Starts a stroke with the store's current tool. Returns false when that tool is not a paint tool. */
  begin(x: number, y: number): boolean;
  move(x: number, y: number): void;
  /** Finishes the stroke (optionally at a last position). Returns true when a command was submitted. */
  end(x?: number, y?: number): boolean;
  /** Abandons the stroke without touching the stack or the history. */
  cancel(): void;
  isActive(): boolean;
  /** The target layer including the unfinished stroke, for live display. Read-only; null when idle. */
  getPreview(): { layer: HexLayer; layerOwnerId: HexID; pixels: Uint8Array } | null;
  getSelection(): PixelSelection | null;
  clearSelection(): void;
}

// ---------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------

interface Point {
  x: number;
  y: number;
}

const COORD_LIMIT = 4096; // keeps line loops bounded for absurd inputs; real pointers are inside the canvas

function normalizePoint(x: number, y: number): Point | null {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const clamp = (v: number): number => Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, Math.floor(v)));
  return { x: clamp(x), y: clamp(y) };
}

const inCanvas = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < W && y < H;

/** Bresenham line from (x0, y0) to (x1, y1), both ends included, calling `plot` for every pixel. */
export function bresenhamLine(x0: number, y0: number, x1: number, y1: number, plot: (x: number, y: number) => void): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  for (;;) {
    plot(x, y);
    if (x === x1 && y === y1) return;
    const e2 = 2 * err;
    if (e2 >= dy) {
      err += dy;
      x += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y += sy;
    }
  }
}

/**
 * Spec 07 Requirement 11.6: the pixels the Rect tool sets for a drag from (x0, y0) to (x1, y1), clipped
 * to the canvas: the 1-pixel frame of the box, or the whole box when `filled`. `plot` applies the pattern.
 * Pixels are visited row by row, top to bottom, each row left to right.
 */
export function plotRectShape(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  filled: boolean,
  plot: (x: number, y: number) => void,
): void {
  const left = Math.min(x0, x1);
  const right = Math.max(x0, x1);
  const top = Math.min(y0, y1);
  const bottom = Math.max(y0, y1);
  for (let y = Math.max(0, top); y <= Math.min(H - 1, bottom); y++) {
    for (let x = Math.max(0, left); x <= Math.min(W - 1, right); x++) {
      if (filled || x === left || x === right || y === top || y === bottom) plot(x, y);
    }
  }
}

/** Offsets of a stamp of the given diameter, relative to the pointer position. */
function stampOffsets(size: number, round: boolean): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  const origin = size >> 1;
  const centre = (size - 1) / 2;
  const radiusSq = (size / 2) * (size / 2);
  for (let dy = 0; dy < size; dy++) {
    for (let dx = 0; dx < size; dx++) {
      if (round && (dx - centre) ** 2 + (dy - centre) ** 2 > radiusSq) continue;
      offsets.push([dx - origin, dy - origin]);
    }
  }
  return offsets;
}

/** Deterministic generator (mulberry32), returns floats in [0, 1). */
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

/** Even-odd polygon fill (pixel centres) united with the outline pixels, so any path selects something. */
function lassoMask(points: readonly Point[]): Uint8Array {
  const mask = new Uint8Array(TOTAL_PIXELS);
  const n = points.length;
  let minY = H;
  let maxY = -1;
  for (const p of points) {
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  for (let y = Math.max(0, minY); y <= Math.min(H - 1, maxY); y++) {
    const yc = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < n; i++) {
      const a = points[i];
      const b = points[(i + 1) % n];
      if (a.y + 0.5 > yc !== b.y + 0.5 > yc) {
        crossings.push(a.x + 0.5 + ((yc - (a.y + 0.5)) * (b.x - a.x)) / (b.y - a.y));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let k = 0; k + 1 < crossings.length; k += 2) {
      const from = Math.max(0, Math.ceil(crossings[k] - 0.5));
      const to = Math.min(W - 1, Math.ceil(crossings[k + 1] - 0.5) - 1);
      if (to >= from) mask.fill(1, y * W + from, y * W + to + 1);
    }
  }
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    bresenhamLine(a.x, a.y, b.x, b.y, (x, y) => {
      if (inCanvas(x, y)) mask[y * W + x] = 1;
    });
  }
  return mask;
}

function rectMask(a: Point, b: Point): Uint8Array {
  const mask = new Uint8Array(TOTAL_PIXELS);
  const x0 = Math.max(0, Math.min(a.x, b.x));
  const x1 = Math.min(W - 1, Math.max(a.x, b.x));
  const y0 = Math.max(0, Math.min(a.y, b.y));
  const y1 = Math.min(H - 1, Math.max(a.y, b.y));
  for (let y = y0; y <= y1; y++) mask.fill(1, y * W + x0, y * W + x1 + 1);
  return mask;
}

function maskBounds(mask: Uint8Array): HexRect | null {
  let minX = W;
  let minY = H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (mask[y * W + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ---------------------------------------------------------------------------------------------
// Working copy of the target layer
// ---------------------------------------------------------------------------------------------

/** `base` is the layer as it was at pointer-down; tools write into `working`. */
class Surface {
  readonly base: Uint8Array;
  readonly working: Uint8Array;
  // Conservative bounding box of everything written since the last reset.
  #minX = W;
  #minY = H;
  #maxX = -1;
  #maxY = -1;

  constructor(base: Uint8Array) {
    this.base = base;
    this.working = base.slice();
  }

  set(x: number, y: number, value: PixelState): void {
    if (!inCanvas(x, y)) return;
    this.working[y * W + x] = value;
    if (x < this.#minX) this.#minX = x;
    if (x > this.#maxX) this.#maxX = x;
    if (y < this.#minY) this.#minY = y;
    if (y > this.#maxY) this.#maxY = y;
  }

  /** Throws away all writes (used by tools that redraw their whole shape on every move). */
  reset(): void {
    this.working.set(this.base);
    this.#minX = W;
    this.#minY = H;
    this.#maxX = -1;
    this.#maxY = -1;
  }

  /** Tightest rectangle containing every pixel where `working` differs from `base`, or null. */
  changedRect(): HexRect | null {
    let minX = W;
    let minY = H;
    let maxX = -1;
    let maxY = -1;
    for (let y = Math.max(0, this.#minY); y <= this.#maxY; y++) {
      for (let x = this.#minX; x <= this.#maxX; x++) {
        if (this.working[y * W + x] === this.base[y * W + x]) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return maxX < 0 ? null : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  }

  copyRect(source: Uint8Array, rect: HexRect): Uint8Array {
    const out = new Uint8Array(rect.width * rect.height);
    for (let row = 0; row < rect.height; row++) {
      const from = (rect.y + row) * W + rect.x;
      out.set(source.subarray(from, from + rect.width), row * rect.width);
    }
    return out;
  }
}

// ---------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------

type Mode = "draw" | "marquee" | "move";

interface ActiveStroke {
  tool: PaintTool;
  mode: Mode;
  layer: HexLayer;
  ownerId: HexID;
  surface: Surface;
  start: Point;
  last: Point;
  settings: Required<PaintSettings>;
  eraseValue: PixelState;
  random: () => number;
  stamp: Array<[number, number]>;
  path: Point[]; // lasso vertices
}

function resolveSettings(raw: PaintSettings): Required<PaintSettings> {
  if (!(raw.pattern instanceof Uint8Array) || raw.pattern.length !== 8) {
    throw new Error("Paint pattern must be a Uint8Array of 8 bytes");
  }
  const size = (v: number | undefined, fallback: number): number =>
    v !== undefined && Number.isFinite(v) ? Math.max(1, Math.min(256, Math.floor(v))) : fallback;
  return {
    pattern: raw.pattern.slice(),
    brushSize: size(raw.brushSize, 4),
    eraserSize: size(raw.eraserSize, 8),
    sprayRadius: size(raw.sprayRadius, 10),
    sprayDots: size(raw.sprayDots, 8),
    rectFilled: raw.rectFilled ?? false,
  };
}

export function createPaintController(options: PaintControllerOptions): PaintController {
  const codec = options.codec ?? bitmapCodec;
  const baseSeed = options.seed ?? 0x48455843;
  let strokeCount = 0;
  let active: ActiveStroke | null = null;
  let selection: PixelSelection | null = null;

  // --- drawing primitives -------------------------------------------------------------------

  function stampAt(s: ActiveStroke, cx: number, cy: number): void {
    const { tool, settings } = s;
    for (const [dx, dy] of s.stamp) {
      const x = cx + dx;
      const y = cy + dy;
      if (tool === "eraser") s.surface.set(x, y, s.eraseValue);
      else if (tool === "pencil") s.surface.set(x, y, 2);
      else s.surface.set(x, y, patternState(settings.pattern, x, y));
    }
  }

  function freehandSegment(s: ActiveStroke, from: Point, to: Point): void {
    bresenhamLine(from.x, from.y, to.x, to.y, (x, y) => stampAt(s, x, y));
  }

  function spray(s: ActiveStroke, centre: Point): void {
    const r = s.settings.sprayRadius;
    let placed = 0;
    for (let attempt = 0; attempt < s.settings.sprayDots * 8 && placed < s.settings.sprayDots; attempt++) {
      const dx = Math.floor(s.random() * (2 * r + 1)) - r;
      const dy = Math.floor(s.random() * (2 * r + 1)) - r;
      if (dx * dx + dy * dy > r * r) continue;
      const x = centre.x + dx;
      const y = centre.y + dy;
      s.surface.set(x, y, patternState(s.settings.pattern, x, y));
      placed++;
    }
  }

  function drawShape(s: ActiveStroke, to: Point): void {
    s.surface.reset();
    const pattern = s.settings.pattern;
    const put = (x: number, y: number): void => s.surface.set(x, y, patternState(pattern, x, y));
    if (s.tool === "line") {
      bresenhamLine(s.start.x, s.start.y, to.x, to.y, put);
      return;
    }
    plotRectShape(s.start.x, s.start.y, to.x, to.y, s.settings.rectFilled, put);
  }

  /** Requirement 7.4: 4-connected region of equal composed colour, filled with the pattern. */
  function bucketFill(s: ActiveStroke, at: Point, composed: Uint8Array): void {
    const region = floodFill4(composed, W, H, at.x, at.y);
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      if (region[i] === 0) continue;
      const x = i % W;
      const y = (i - x) / W;
      s.surface.set(x, y, patternState(s.settings.pattern, x, y));
    }
  }

  /** Lifts the selected pixels, clears their source (eraser rule) and drops them `(dx, dy)` away. */
  function moveSelection(s: ActiveStroke, sel: PixelSelection, dx: number, dy: number): void {
    s.surface.reset();
    const { x: bx, y: by, width, height } = sel.bounds;
    const lifted: Array<[number, number, PixelState]> = [];
    for (let y = by; y < by + height; y++) {
      for (let x = bx; x < bx + width; x++) {
        const i = y * W + x;
        if (sel.mask[i] === 1) lifted.push([x, y, s.surface.base[i] as PixelState]);
      }
    }
    for (const [x, y] of lifted) s.surface.set(x, y, s.eraseValue);
    // Transparent pixels (card layer) are not pasted, so they never punch holes into the target.
    for (const [x, y, value] of lifted) if (value !== 0) s.surface.set(x + dx, y + dy, value);
  }

  function shiftedSelection(sel: PixelSelection, dx: number, dy: number): PixelSelection | null {
    const mask = new Uint8Array(TOTAL_PIXELS);
    for (let y = sel.bounds.y; y < sel.bounds.y + sel.bounds.height; y++) {
      for (let x = sel.bounds.x; x < sel.bounds.x + sel.bounds.width; x++) {
        if (sel.mask[y * W + x] === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (inCanvas(nx, ny)) mask[ny * W + nx] = 1;
      }
    }
    const bounds = maskBounds(mask);
    return bounds ? { ...sel, bounds, mask } : null;
  }

  function finishSelection(s: ActiveStroke, to: Point): void {
    let mask: Uint8Array;
    if (s.tool === "select") {
      mask = rectMask(s.start, to);
    } else {
      mask = lassoMask(s.path);
    }
    const distinct = s.tool === "select" ? s.start.x !== to.x || s.start.y !== to.y : s.path.some((p) => p.x !== s.start.x || p.y !== s.start.y);
    const bounds = distinct ? maskBounds(mask) : null; // a plain click deselects
    selection = bounds ? { layer: s.layer, layerOwnerId: s.ownerId, bounds, mask } : null;
  }

  // --- public API ---------------------------------------------------------------------------

  function begin(rawX: number, rawY: number): boolean {
    active = null;
    const point = normalizePoint(rawX, rawY);
    const state = options.store.getSnapshot();
    const tool = state.tool;
    if (!point || !isPaintTool(tool)) return false;

    // Requirement 7.1: the Edit Background state alone picks the layer.
    const target = resolveEditTarget(state);
    const layer = target.layer;
    const ownerId = target.owner.id;
    const settings = resolveSettings(options.getSettings());
    const decode = (rleData: string, l: HexLayer): Uint8Array => codec.decode(rleData, l === "card" ? 0 : 1);
    const surface = new Surface(decode(target.owner.bitmap.rleData, layer));

    if (selection && (selection.layer !== layer || selection.layerOwnerId !== ownerId)) selection = null;
    if (tool !== "select" && tool !== "lasso") selection = null;

    let mode: Mode = "draw";
    if (tool === "select" || tool === "lasso") {
      mode = selection && inCanvas(point.x, point.y) && selection.mask[point.y * W + point.x] === 1 ? "move" : "marquee";
      if (mode === "marquee") selection = null;
    }

    const stamp =
      tool === "pencil" ? stampOffsets(1, false)
      : tool === "brush" ? stampOffsets(settings.brushSize, true)
      : tool === "eraser" ? stampOffsets(settings.eraserSize, false)
      : [];

    const s: ActiveStroke = {
      tool,
      mode,
      layer,
      ownerId,
      surface,
      start: point,
      last: point,
      settings,
      eraseValue: layer === "card" ? 0 : 1,
      random: createRandom(baseSeed + strokeCount),
      stamp,
      path: [point],
    };
    strokeCount++;
    active = s;

    switch (tool) {
      case "pencil":
      case "brush":
      case "eraser":
        stampAt(s, point.x, point.y);
        break;
      case "spray":
        spray(s, point);
        break;
      case "line":
      case "rect":
        drawShape(s, point);
        break;
      case "paintBucket": {
        // The composed colour needs the layer that is not being edited as well.
        const card = state.stack.cards.find((c) => c.id === state.currentCardId);
        const background = state.stack.backgrounds.find((b) => b.id === card?.backgroundId);
        const otherRle = (layer === "card" ? background?.bitmap.rleData : card?.bitmap.rleData) ?? "";
        bucketFill(s, point, composeBitmaps(layer, surface.base, otherRle, decode));
        break;
      }
      default:
        break; // select, lasso: nothing is drawn at pointer-down
    }
    return true;
  }

  /** Background bitmap (0 -> 1) with the card bitmap on top wherever it is not transparent (§5.6 steps 1 and 3). */
  function composeBitmaps(
    targetLayer: HexLayer,
    targetPixels: Uint8Array,
    otherRle: string,
    decode: (rleData: string, l: HexLayer) => Uint8Array,
  ): Uint8Array {
    const cardPixels = targetLayer === "card" ? targetPixels : decode(otherRle, "card");
    const bgPixels = targetLayer === "background" ? targetPixels : decode(otherRle, "background");
    const composed = new Uint8Array(TOTAL_PIXELS);
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      composed[i] = cardPixels[i] !== 0 ? cardPixels[i] : bgPixels[i] === 0 ? 1 : bgPixels[i];
    }
    return composed;
  }

  function move(rawX: number, rawY: number): void {
    const s = active;
    const point = normalizePoint(rawX, rawY);
    if (!s || !point) return;
    if (s.mode === "move") {
      if (selection) moveSelection(s, selection, point.x - s.start.x, point.y - s.start.y);
      s.last = point;
      return;
    }
    switch (s.tool) {
      case "pencil":
      case "brush":
      case "eraser":
        freehandSegment(s, s.last, point);
        break;
      case "spray":
        spray(s, point);
        break;
      case "line":
      case "rect":
        drawShape(s, point);
        break;
      case "lasso":
        s.path.push(point);
        break;
      default:
        break; // paintBucket acts at pointer-down; select only needs the end position
    }
    s.last = point;
  }

  function end(rawX?: number, rawY?: number): boolean {
    const s = active;
    if (!s) return false;
    if (rawX !== undefined && rawY !== undefined) move(rawX, rawY);
    active = null;

    if (s.mode === "marquee") {
      finishSelection(s, s.last);
      return false;
    }

    const rect = s.surface.changedRect();
    if (!rect) return false; // nothing changed: no history entry
    const command = new PaintStrokeCommand(
      {
        layer: s.layer,
        layerOwnerId: s.ownerId,
        rect,
        before: s.surface.copyRect(s.surface.base, rect),
        after: s.surface.copyRect(s.surface.working, rect),
      },
      codec,
      LABELS[s.tool],
    );
    options.history.execute(command);

    if (s.mode === "move" && selection) {
      selection = shiftedSelection(selection, s.last.x - s.start.x, s.last.y - s.start.y);
    }
    return true;
  }

  return {
    begin,
    move,
    end,
    cancel() {
      active = null;
    },
    isActive: () => active !== null,
    getPreview: () => (active ? { layer: active.layer, layerOwnerId: active.ownerId, pixels: active.surface.working } : null),
    getSelection: () => selection,
    clearSelection() {
      selection = null;
    },
  };
}
