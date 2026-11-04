// 18-bit Galois LFSR dissolve. Canonical contract: hexcard_design_spec.md §5.2 (reference code,
// copied unchanged below) and spec 03 Requirement 6.2.
//
// The register walks all 2^18 - 1 = 262,143 non-zero states exactly once before returning to 1.
// States below 175,104 are pixel indices; the rest are skipped. Index 0 is never produced by the
// register, so the reference code copies it when the cycle closes. Starting from state 1 therefore
// copies every index 0..175,103 exactly once.
//
// Pure TypeScript: no DOM access, testable in Node.

import type { VisualEffectSpeed } from "../../core/schema.ts";

/** 18-bit maximal-period Galois LFSR polynomial mask (§5.2). */
export const DISSOLVE_LFSR_MASK = 0x20400;

/** Pixels copied per animation frame for each speed (Requirement 6.2). */
export const DISSOLVE_PIXELS_PER_FRAME: Readonly<Record<VisualEffectSpeed, number>> = {
  verySlow: 3_600,
  slow: 7_300,
  normal: 14_500,
  fast: 29_000,
};

/** Register state for one dissolve. Must start at 1; `stepDissolveFrame` resets it to 1 when done. */
export function createDissolveState(): { state: number } {
  return { state: 1 };
}

// 18-bit maximal-period (2^18 - 1 = 262,143) Galois LFSR polynomial mask: 0x20400
export function stepDissolveFrame(
  currentFrameBuffer: Uint32Array,
  targetFrameBuffer: Uint32Array,
  totalPixels: number,
  lfsrStateRef: { state: number },
  pixelsPerFrame: number
): boolean {
  let state = lfsrStateRef.state;
  let copied = 0;

  while (copied < pixelsPerFrame) {
    const lsb = state & 1;
    state >>= 1;
    if (lsb !== 0) {
      state ^= 0x20400; // 18-bit maximal length tap
    }
    if (state < totalPixels) {
      currentFrameBuffer[state] = targetFrameBuffer[state];
      copied++;
    }
    if (state === 1) {
      currentFrameBuffer[0] = targetFrameBuffer[0];
      lfsrStateRef.state = 1;
      return true; // Transition complete
    }
  }
  lfsrStateRef.state = state;
  return false;
}
