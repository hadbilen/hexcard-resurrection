import { describe, expect, it } from "vitest";
import type { HexStack, VisualEffectSpeed, VisualEffectType } from "../../../core/schema.ts";
import { HexAbortError } from "../../../core/vm.ts";
import { TOTAL_PIXELS, encodeBitmapRLE } from "../rleCodec.ts";
import { DISSOLVE_PIXELS_PER_FRAME, createDissolveState, stepDissolveFrame } from "../lfsrDissolve.ts";
import { packOpaqueColour } from "../bitmapCanvas.ts";
import { EFFECT_FRAMES, type GeometricEffect, composeEffectFrame, playEffect, revealEffectStep } from "../transitions.ts";

// Per-test budget for the heavy tests, so CPU contention in the parallel suite cannot time them out.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const SPEEDS: VisualEffectSpeed[] = ["verySlow", "slow", "normal", "fast"];
const GEOMETRIC: GeometricEffect[] = [
  "venetianBlinds", "checkerboard", "irisOpen", "irisClose",
  "wipeLeft", "wipeRight", "wipeUp", "wipeDown", "barnDoorOpen", "barnDoorClose",
];
const ALL_EFFECTS: VisualEffectType[] = ["cut", "dissolve", ...GEOMETRIC];

const FROM_VALUE = 0x11111111;
const TO_VALUE = 0x22222222;
const solid = (v: number): Uint32Array => new Uint32Array(TOTAL_PIXELS).fill(v);
/** Distinct value per pixel, so a copy to the wrong index is detectable. */
const distinct = (): Uint32Array => Uint32Array.from({ length: TOTAL_PIXELS }, (_, i) => i + 1);
const countOf = (buf: Uint32Array, v: number): number => buf.reduce((n, x) => n + (x === v ? 1 : 0), 0);

/** Manual frame pump: frames run only when the test calls `run()`. */
function manualFrames() {
  const pending: Array<() => void> = [];
  return {
    requestFrame: (cb: () => void) => void pending.push(cb),
    pending: () => pending.length,
    /** Runs frames until none are scheduled; returns how many ran. */
    run(limit = 1_000): number {
      let n = 0;
      while (pending.length > 0 && n < limit) { pending.shift()!(); n++; }
      return n;
    },
    step(): void { pending.shift()?.(); },
  };
}

describe("lfsrDissolve (Requirement 6.2)", () => {
  it("copies every index 0..175,103 exactly once over a full dissolve", () => {
    const writes = new Uint8Array(TOTAL_PIXELS);
    const backing = new Uint32Array(TOTAL_PIXELS);
    // Counts every write the reference code makes into the displayed buffer.
    const counting = new Proxy(backing, {
      set(target, prop, value) {
        const i = Number(prop);
        if (!Number.isInteger(i) || i < 0 || i >= TOTAL_PIXELS) throw new Error(`write outside frame: ${String(prop)}`);
        writes[i] += 1;
        target[i] = value as number;
        return true;
      },
    }) as unknown as Uint32Array;
    const target = distinct();
    const lfsr = createDissolveState();

    let frames = 0;
    while (!stepDissolveFrame(counting, target, TOTAL_PIXELS, lfsr, DISSOLVE_PIXELS_PER_FRAME.fast)) {
      frames++;
      expect(frames).toBeLessThan(100);
    }
    expect(writes.every((n) => n === 1)).toBe(true);
    expect(backing).toEqual(target);
    expect(lfsr.state).toBe(1); // reset, ready for the next dissolve
  });

  it.each(SPEEDS)("copies exactly the per-frame pixel count at %s speed", (speed) => {
    const perFrame = DISSOLVE_PIXELS_PER_FRAME[speed];
    const display = solid(FROM_VALUE);
    const target = solid(TO_VALUE);
    const lfsr = createDissolveState();
    const perFrameCopies: number[] = [];
    let before = 0;
    let done = false;
    while (!done) {
      done = stepDissolveFrame(display, target, TOTAL_PIXELS, lfsr, perFrame);
      const now = countOf(display, TO_VALUE);
      perFrameCopies.push(now - before);
      before = now;
    }
    // Index 0 is copied in the closing frame on top of its count (§5.2 reference code).
    expect(perFrameCopies.slice(0, -1).every((n) => n === perFrame)).toBe(true);
    expect(perFrameCopies.length).toBe(Math.ceil((TOTAL_PIXELS - 1) / perFrame));
    expect(before).toBe(TOTAL_PIXELS);
  });

  it("uses the Requirement 6.2 speed table", () => {
    expect(DISSOLVE_PIXELS_PER_FRAME).toEqual({ verySlow: 3_600, slow: 7_300, normal: 14_500, fast: 29_000 });
  });
});

describe("revealEffectStep (Requirement 6.3)", () => {
  it.each(GEOMETRIC)("%s copies only destination pixels, grows monotonically and ends on the destination", (effect) => {
    for (const speed of SPEEDS) {
      const steps = EFFECT_FRAMES[speed];
      const display = solid(FROM_VALUE);
      const to = distinct();
      let previous = 0;
      for (let step = 1; step <= steps; step++) {
        revealEffectStep(effect, display, to, step, steps);
        let revealed = 0;
        for (let i = 0; i < TOTAL_PIXELS; i++) {
          if (display[i] === to[i]) revealed++;
          else if (display[i] !== FROM_VALUE) throw new Error(`${effect}: pixel ${i} has foreign value`);
        }
        expect(revealed).toBeGreaterThanOrEqual(previous);
        previous = revealed;
      }
      expect(display).toEqual(to);
    }
  }, HEAVY_TEST_TIMEOUT_MS);

  it("wipeRight at half way covers exactly the left half", () => {
    const display = solid(FROM_VALUE);
    revealEffectStep("wipeRight", display, solid(TO_VALUE), 6, 12);
    expect(display[0]).toBe(TO_VALUE);
    expect(display[255]).toBe(TO_VALUE);
    expect(display[256]).toBe(FROM_VALUE);
    expect(countOf(display, TO_VALUE)).toBe(TOTAL_PIXELS / 2);
  });

  it("checkerboard fills one cell parity in the first half", () => {
    const display = solid(FROM_VALUE);
    revealEffectStep("checkerboard", display, solid(TO_VALUE), 3, 6);
    expect(display[0]).toBe(TO_VALUE);   // cell (0,0): even
    expect(display[8]).toBe(FROM_VALUE); // cell (1,0): odd
  });
});

describe("playEffect (Requirements 6.1, 6.2, 6.3)", () => {
  it.each(ALL_EFFECTS.flatMap((e) => SPEEDS.map((s) => [e, s] as const)))(
    "%s %s resolves after presenting the destination, without touching from/to",
    async (effect, speed) => {
      const from = solid(FROM_VALUE);
      const to = distinct();
      const toCopy = to.slice();
      const frames = manualFrames();
      const presented: Uint32Array[] = [];
      let resolved = false;
      const promise = playEffect(effect, speed, from, to, (buf) => presented.push(buf.slice()), { requestFrame: frames.requestFrame })
        .then(() => { resolved = true; });
      const ran = frames.run();
      await promise;
      expect(resolved).toBe(true);
      expect(presented.at(-1)).toEqual(to);
      expect(from.every((v) => v === FROM_VALUE)).toBe(true);
      expect(to).toEqual(toCopy);
      if (effect === "cut") expect(ran).toBe(0);
      else if (effect === "dissolve") expect(ran).toBe(Math.ceil((TOTAL_PIXELS - 1) / DISSOLVE_PIXELS_PER_FRAME[speed]));
      else expect(ran).toBe(EFFECT_FRAMES[speed]);
      expect(presented.length).toBe(Math.max(1, ran));
    },
  );

  it("on abort mid-effect presents the destination and rejects with HexAbortError", async () => {
    const controller = new AbortController();
    const frames = manualFrames();
    const to = solid(TO_VALUE);
    const presented: Uint32Array[] = [];
    const promise = playEffect("dissolve", "verySlow", solid(FROM_VALUE), to, (b) => presented.push(b.slice()), {
      signal: controller.signal, requestFrame: frames.requestFrame,
    });
    frames.step();
    frames.step();
    expect(presented.at(-1)).not.toEqual(to);
    controller.abort();
    await expect(promise).rejects.toBeInstanceOf(HexAbortError);
    expect(presented.at(-1)).toEqual(to);
    const count = presented.length;
    frames.run(); // a frame scheduled before the abort does nothing
    expect(presented.length).toBe(count);
  });

  it("with an already aborted signal presents the destination and rejects", async () => {
    const controller = new AbortController();
    controller.abort();
    const to = solid(TO_VALUE);
    const presented: Uint32Array[] = [];
    const frames = manualFrames();
    await expect(
      playEffect("wipeLeft", "slow", solid(FROM_VALUE), to, (b) => presented.push(b.slice()), { signal: controller.signal, requestFrame: frames.requestFrame }),
    ).rejects.toBeInstanceOf(HexAbortError);
    expect(presented).toEqual([to]);
    expect(frames.pending()).toBe(0);
  });

  it("rejects frames of the wrong size", async () => {
    await expect(playEffect("cut", "fast", new Uint32Array(4), solid(0), () => {})).rejects.toThrow(/175104/);
  });
});

describe("composeEffectFrame (Requirement 6.1)", () => {
  it("composes the full card frame, parts included, in the stack palette", () => {
    const bg = new Uint8Array(TOTAL_PIXELS).fill(1);
    bg[0] = 2;
    const stack: HexStack = {
      id: "stk_1", schemaVersion: "2.0.0", name: "T", author: "A",
      createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z",
      dimensions: { width: 512, height: 342 },
      themePalette: { name: "AmberCRT", darkBitHex: "#1A1000", lightBitHex: "#FFB000" },
      backgrounds: [{ id: "bkg_1", name: "B", bitmap: { width: 512, height: 342, rleData: encodeBitmapRLE(bg) }, parts: [], scriptSource: "", cantDelete: false }],
      cards: [{
        id: "crd_1", name: "C", backgroundId: "bkg_1", bitmap: { width: 512, height: 342, rleData: "" },
        parts: [{
          id: "prt_1", name: "b", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 4, height: 4 },
          visible: true, enabled: true, scriptSource: "", style: "rectangle", title: "", showName: false, autoHilite: false, hilite: false,
        }],
        bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      }],
      customIcons: {}, scriptSource: "",
    };
    const drawn: string[] = [];
    const frame = composeEffectFrame(stack, "crd_1", (f, part) => {
      drawn.push(part.id);
      f[10 * 512 + 10] = 2;
    });
    const dark = packOpaqueColour("#1A1000");
    const light = packOpaqueColour("#FFB000");
    expect(drawn).toEqual(["prt_1"]);
    expect(frame[0]).toBe(dark);
    expect(frame[10 * 512 + 10]).toBe(dark);
    expect(frame[1]).toBe(light);
  });
});
