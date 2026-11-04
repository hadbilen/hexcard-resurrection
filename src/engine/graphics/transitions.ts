// Card visual effects on two fully composed pixel frames. Canonical contracts: spec 03
// Requirement 6 and design.md §5; dissolve from hexcard_design_spec.md §5.2 (lfsrDissolve.ts).
//
// `from` and `to` are complete 512x342 frames (all layers and parts, palette-mapped, e.g. by
// `composeEffectFrame`). Every effect copies pixels from `to` into a working copy of `from` and
// hands that buffer to `present` once per animation frame; no CSS opacity, filters or DOM
// transitions are involved (Requirement 6.3, tech.md 1-Bit Fidelity Rule 1).
//
// Geometric effects (wipes, iris, barn doors, venetian blinds, checkerboard) run for a fixed number
// of frames per speed (design.md §5); at step i of n, a region that grows monotonically with i/n is
// copied, and step n covers the whole frame.
//
// Pure TypeScript: frame scheduling is injectable, so this module is testable in Node.

import type { HexID, HexStack, VisualEffectSpeed, VisualEffectType } from "../../core/schema.ts";
import { HexAbortError } from "../../core/vm.ts";
import { type PartRasterizer, composeFrame, frameToImageData } from "./bitmapCanvas.ts";
import { DISSOLVE_PIXELS_PER_FRAME, createDissolveState, stepDissolveFrame } from "./lfsrDissolve.ts";
import { rasterizePart as defaultPartRasterizer } from "./partRenderer.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS } from "./rleCodec.ts";

/** Frames per speed for every effect except `cut` and `dissolve` (design.md §5). */
export const EFFECT_FRAMES: Readonly<Record<VisualEffectSpeed, number>> = {
  verySlow: 48,
  slow: 24,
  normal: 12,
  fast: 6,
};

/** Row height of one venetian-blind slat. */
export const VENETIAN_SLAT_HEIGHT = 16;
/** Edge length of one checkerboard cell (design.md §5: 8x8 cells). */
export const CHECKER_CELL = 8;

const W = BITMAP_WIDTH;
const H = BITMAP_HEIGHT;
const HALF_W = W / 2; // 256
const HALF_H = H / 2; // 171

// ---------------------------------------------------------------------------------------------
// Frame composition for effects (Requirement 6.1)
// ---------------------------------------------------------------------------------------------

/**
 * Composes the complete frame of `cardId` (bitmaps and parts, §5.6) and maps it to the stack's
 * theme palette, ready to be passed to `playEffect` as `from` or `to`.
 */
export function composeEffectFrame(
  stack: HexStack,
  cardId: HexID,
  rasterizePart: PartRasterizer = defaultPartRasterizer,
): Uint32Array {
  const out = new Uint32Array(TOTAL_PIXELS);
  frameToImageData(composeFrame(stack, cardId, {}, rasterizePart), stack.themePalette, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Geometric effects
// ---------------------------------------------------------------------------------------------

export type GeometricEffect = Exclude<VisualEffectType, "cut" | "dissolve">;

/** Copies the half-open rectangle [x0, x1) x [y0, y1) from `to` into `display`. */
function copyRect(display: Uint32Array, to: Uint32Array, x0: number, y0: number, x1: number, y1: number): void {
  if (x1 <= x0 || y1 <= y0) return;
  for (let y = y0; y < y1; y++) {
    const row = y * W;
    display.set(to.subarray(row + x0, row + x1), row + x0);
  }
}

/** Copies the first `rows` rows of every checkerboard cell of the given parity. */
function copyCheckerRows(display: Uint32Array, to: Uint32Array, parity: 0 | 1, rows: number): void {
  if (rows <= 0) return;
  for (let y = 0; y < H; y++) {
    if (y % CHECKER_CELL >= rows) continue;
    const cy = Math.floor(y / CHECKER_CELL);
    const row = y * W;
    for (let cx = 0; cx * CHECKER_CELL < W; cx++) {
      if (((cx + cy) & 1) !== parity) continue;
      const x0 = cx * CHECKER_CELL;
      display.set(to.subarray(row + x0, row + x0 + CHECKER_CELL), row + x0);
    }
  }
}

/**
 * Copies the region of step `step` (1..steps) of a geometric effect from `to` into `display`.
 * Regions grow monotonically with `step`; at `step === steps` the whole frame is copied.
 */
export function revealEffectStep(
  effect: GeometricEffect,
  display: Uint32Array,
  to: Uint32Array,
  step: number,
  steps: number,
): void {
  const p = Math.min(1, Math.max(0, step / steps));
  switch (effect) {
    case "wipeLeft": { // new card enters at the right edge and sweeps left
      copyRect(display, to, W - Math.round(p * W), 0, W, H);
      return;
    }
    case "wipeRight": {
      copyRect(display, to, 0, 0, Math.round(p * W), H);
      return;
    }
    case "wipeUp": { // enters at the bottom edge and sweeps up
      copyRect(display, to, 0, H - Math.round(p * H), W, H);
      return;
    }
    case "wipeDown": {
      copyRect(display, to, 0, 0, W, Math.round(p * H));
      return;
    }
    case "irisOpen": { // centred rectangle growing outwards
      const hw = Math.round(p * HALF_W);
      const hh = Math.round(p * HALF_H);
      copyRect(display, to, HALF_W - hw, HALF_H - hh, HALF_W + hw, HALF_H + hh);
      return;
    }
    case "irisClose": { // everything outside a centred rectangle that shrinks to nothing
      const hw = Math.round((1 - p) * HALF_W);
      const hh = Math.round((1 - p) * HALF_H);
      const x0 = HALF_W - hw, x1 = HALF_W + hw, y0 = HALF_H - hh, y1 = HALF_H + hh;
      copyRect(display, to, 0, 0, W, y0);
      copyRect(display, to, 0, y1, W, H);
      copyRect(display, to, 0, y0, x0, y1);
      copyRect(display, to, x1, y0, W, y1);
      return;
    }
    case "barnDoorOpen": { // vertical opening from the centre column outwards
      const hw = Math.round(p * HALF_W);
      copyRect(display, to, HALF_W - hw, 0, HALF_W + hw, H);
      return;
    }
    case "barnDoorClose": { // two doors closing from the left and right edges
      const hw = Math.round(p * HALF_W);
      copyRect(display, to, 0, 0, hw, H);
      copyRect(display, to, W - hw, 0, W, H);
      return;
    }
    case "venetianBlinds": { // every slat opens top-down at the same time
      const rows = Math.round(p * VENETIAN_SLAT_HEIGHT);
      if (rows <= 0) return;
      for (let y0 = 0; y0 < H; y0 += VENETIAN_SLAT_HEIGHT) copyRect(display, to, 0, y0, W, Math.min(H, y0 + rows));
      return;
    }
    case "checkerboard": { // first half: even cells fill top-down; second half: odd cells
      if (p <= 0.5) {
        copyCheckerRows(display, to, 0, Math.round(2 * p * CHECKER_CELL));
      } else {
        copyCheckerRows(display, to, 0, CHECKER_CELL);
        copyCheckerRows(display, to, 1, Math.round((2 * p - 1) * CHECKER_CELL));
      }
      return;
    }
    default: {
      const unknown: never = effect;
      throw new Error(`revealEffectStep: unknown effect ${String(unknown)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------------------------

/** Schedules `callback` for the next animation frame. */
export type FrameScheduler = (callback: () => void) => void;

export interface PlayEffectOptions {
  /** The running dispatch's abort signal (spec 01 Requirement 3.7). */
  signal?: AbortSignal;
  /** Defaults to `requestAnimationFrame`, or a 16 ms callback timer where it does not exist. */
  requestFrame?: FrameScheduler;
}

const defaultRequestFrame: FrameScheduler = (callback) => {
  if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(() => callback());
  else setTimeout(callback, 16);
};

/**
 * Plays `effect` from frame `from` to frame `to` (both 175,104 palette-mapped pixels; neither is
 * modified). `present` receives the same working buffer once per animation frame and must copy it
 * out (e.g. into ImageData) before returning. Resolves once the destination frame has been
 * presented.
 *
 * `cut` presents the destination immediately. If `signal` aborts (before or during playback), the
 * destination frame is presented at once and the promise rejects with `HexAbortError`.
 */
export function playEffect(
  effect: VisualEffectType,
  speed: VisualEffectSpeed,
  from: Uint32Array,
  to: Uint32Array,
  present: (buf: Uint32Array) => void,
  options: PlayEffectOptions = {},
): Promise<void> {
  if (from.length !== TOTAL_PIXELS || to.length !== TOTAL_PIXELS) {
    return Promise.reject(new Error(`playEffect: frames must have ${TOTAL_PIXELS} pixels, got ${from.length} and ${to.length}`));
  }
  const { signal } = options;
  const requestFrame = options.requestFrame ?? defaultRequestFrame;
  const display = from.slice();

  return new Promise<void>((resolve, reject) => {
    let settled = false;

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };

    function onAbort(): void {
      if (settled) return;
      display.set(to);
      present(display);
      finish(new HexAbortError());
    }

    if (signal?.aborted) {
      onAbort();
      return;
    }

    if (effect === "cut") {
      display.set(to);
      present(display);
      finish();
      return;
    }

    signal?.addEventListener("abort", onAbort, { once: true });

    // Returns true once the destination frame is complete.
    let advance: () => boolean;
    if (effect === "dissolve") {
      const lfsr = createDissolveState();
      const perFrame = DISSOLVE_PIXELS_PER_FRAME[speed];
      advance = () => stepDissolveFrame(display, to, TOTAL_PIXELS, lfsr, perFrame);
    } else {
      const steps = EFFECT_FRAMES[speed];
      let step = 0;
      advance = () => {
        step += 1;
        revealEffectStep(effect, display, to, step, steps);
        return step >= steps;
      };
    }

    const tick = (): void => {
      if (settled) return;
      try {
        const done = advance();
        present(display);
        if (done) finish();
        else requestFrame(tick);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    };
    requestFrame(tick);
  });
}
