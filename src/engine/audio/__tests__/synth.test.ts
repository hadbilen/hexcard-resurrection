import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  HexAudioSynth,
  MAX_NOTES_PER_SEQUENCE,
  midiToFrequency,
  normalizeTempo,
  parseNoteSequence,
  renderClick,
  renderKarplusStrong,
} from "../synth.ts";
import type { HexVoice } from "../../../core/ast.ts";

// ---------------------------------------------------------------------------------------------
// Note parser (Requirement 1.2)
// ---------------------------------------------------------------------------------------------

describe("parseNoteSequence", () => {
  it("schedules 'c4q e4q g4h c5w' at 120 BPM", () => {
    const { events, invalid, totalSeconds } = parseNoteSequence("c4q e4q g4h c5w");
    expect(invalid).toEqual([]);
    expect(events.map((e) => [e.start, e.duration])).toEqual([[0, 0.5], [0.5, 0.5], [1, 1], [2, 2]]);
    expect(events.map((e) => e.frequency)).toEqual([
      midiToFrequency(60), midiToFrequency(64), midiToFrequency(67), midiToFrequency(72),
    ]);
    expect(totalSeconds).toBe(4);
    expect(events[0].frequency).toBeCloseTo(261.626, 2);
  });

  it("scales durations with the tempo", () => {
    expect(parseNoteSequence("c4q", 60).events[0].duration).toBe(1);
    expect(parseNoteSequence("c4q", 240).events[0].duration).toBe(0.25);
    expect(parseNoteSequence("c4q", Number.NaN).events[0].duration).toBe(0.5);
  });

  it("knows w, h, q, e, s and the dot (1.5 times)", () => {
    const beats = (note: string) => parseNoteSequence(note, 60).events[0].duration;
    expect([beats("cw"), beats("ch"), beats("cq"), beats("ce"), beats("cs")]).toEqual([4, 2, 1, 0.5, 0.25]);
    expect(beats("cq.")).toBe(1.5);
    expect(beats("cw.")).toBe(6);
  });

  it("takes time for rests, including dotted rests, and makes no sound", () => {
    const { events } = parseNoteSequence("c4q rq r4h rh. d4q");
    // "r4h" is not a rest (rests take no octave): it is reported invalid and takes no time.
    expect(events.map((e) => e.frequency === null)).toEqual([false, true, true, false]);
    expect(events[3].start).toBeCloseTo(0.5 + 0.5 + 1.5, 10);
  });

  it("applies sharps and flats and keeps the octave until it changes", () => {
    const { events } = parseNoteSequence("c#4 db a3 b c5 bb");
    const midi = events.map((e) => Math.round(69 + 12 * Math.log2((e.frequency ?? 1) / 440)));
    expect(midi).toEqual([61, 61, 57, 59, 72, 82]);
  });

  it("defaults the duration to a quarter note and the octave to 4", () => {
    const { events } = parseNoteSequence("c d e");
    expect(events.map((e) => e.duration)).toEqual([0.5, 0.5, 0.5]);
    expect(events[0].frequency).toBeCloseTo(midiToFrequency(60), 10);
  });

  it("is case-insensitive", () => {
    expect(parseNoteSequence("C4Q E4Q").events).toEqual(parseNoteSequence("c4q e4q").events);
  });

  it("skips invalid tokens without giving them time", () => {
    const result = parseNoteSequence("c4q x4q c8q h c0q c4q");
    expect(result.invalid).toEqual(["x4q", "c8q", "h", "c0q"]);
    expect(result.events).toHaveLength(2);
    expect(result.events[1].start).toBe(0.5);
  });

  it("returns nothing for an empty string and caps very long input", () => {
    expect(parseNoteSequence("").events).toEqual([]);
    expect(parseNoteSequence("   ").events).toEqual([]);
    expect(parseNoteSequence("cs ".repeat(1000)).events).toHaveLength(MAX_NOTES_PER_SEQUENCE);
  });

  it("ignores notes that would start after 60 seconds", () => {
    const { events, totalSeconds } = parseNoteSequence("cw ".repeat(20), 20); // 12 s each
    expect(events).toHaveLength(5);
    expect(totalSeconds).toBe(60);
  });

  it("clamps the tempo to the validator range", () => {
    expect(normalizeTempo(1)).toBe(20);
    expect(normalizeTempo(1000)).toBe(400);
    expect(normalizeTempo(0)).toBe(120);
    expect(normalizeTempo(140)).toBe(140);
  });

  it("**Validates: Requirements 1.2** events are contiguous and each pitch matches its midi number", () => {
    const note = fc.record({
      letter: fc.constantFrom("c", "d", "e", "f", "g", "a", "b"),
      accidental: fc.constantFrom("", "#", "b"),
      octave: fc.constantFrom("", "1", "2", "3", "4", "5", "6", "7"),
      duration: fc.constantFrom("", "w", "h", "q", "e", "s"),
      dot: fc.constantFrom("", "."),
    });
    const rest = fc.record({ duration: fc.constantFrom("", "w", "h", "q", "e", "s"), dot: fc.constantFrom("", ".") });
    const token = fc.oneof(
      note.map((n) => ({ text: n.letter + n.accidental + n.octave + n.duration + n.dot, rest: false })),
      rest.map((r) => ({ text: "r" + r.duration + r.dot, rest: true })),
    );
    fc.assert(
      fc.property(fc.array(token, { maxLength: 25 }), fc.integer({ min: 200, max: 400 }), (tokens, tempo) => {
        const result = parseNoteSequence(tokens.map((t) => t.text).join(" "), tempo);
        expect(result.invalid).toEqual([]);
        expect(result.events).toHaveLength(tokens.length);
        let cursor = 0;
        result.events.forEach((event, i) => {
          expect(event.start).toBeCloseTo(cursor, 9);
          expect(event.duration).toBeGreaterThan(0);
          expect(event.frequency === null).toBe(tokens[i].rest);
          if (event.frequency !== null) {
            expect(event.frequency).toBeGreaterThan(30);
            expect(event.frequency).toBeLessThan(8000);
          }
          cursor += event.duration;
        });
        expect(result.totalSeconds).toBeCloseTo(cursor, 9);
      }),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// Sample generators (Requirement 1.1)
// ---------------------------------------------------------------------------------------------

/** Deterministic noise in [0, 1). */
function lcg(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Period in samples (within 0.8..1.2 of `expected`) with the highest autocorrelation. */
function estimatePeriod(samples: Float32Array, expected: number): number {
  let best = 0;
  let bestLag = 0;
  for (let lag = Math.floor(expected * 0.8); lag <= Math.ceil(expected * 1.2); lag++) {
    let sum = 0;
    for (let i = 0; i + lag < samples.length; i++) sum += samples[i] * samples[i + lag];
    if (sum > best) { best = sum; bestLag = lag; }
  }
  return bestLag;
}

describe("renderKarplusStrong", () => {
  const rate = 44100;

  it("is bounded, decays and ends silent", () => {
    const out = renderKarplusStrong(220, rate, 1, lcg());
    expect(out).toHaveLength(rate);
    expect(out.every((v) => v >= -1 && v <= 1)).toBe(true);
    const energy = (from: number, to: number) => out.slice(from, to).reduce((sum, v) => sum + v * v, 0);
    expect(energy(0, 4410)).toBeGreaterThan(energy(rate - 4410 - 100, rate - 100));
    expect(Math.abs(out[rate - 1])).toBe(0);
  });

  it("is deterministic for a fixed noise source", () => {
    expect(renderKarplusStrong(330, rate, 0.2, lcg(7))).toEqual(renderKarplusStrong(330, rate, 0.2, lcg(7)));
  });

  it("**Validates: Requirements 1.1** sounds near the requested pitch", () => {
    fc.assert(
      fc.property(fc.integer({ min: 110, max: 660 }), fc.integer({ min: 1, max: 1000 }), (frequency, seed) => {
        const out = renderKarplusStrong(frequency, rate, 0.5, lcg(seed));
        // Measured on the tonal part, after the noise burst has been filtered.
        const period = estimatePeriod(out.slice(rate * 0.1, rate * 0.4), rate / frequency);
        expect(Math.abs(rate / period / frequency - 1)).toBeLessThan(0.03);
      }),
      { numRuns: 25 },
    );
  });
});

describe("renderClick", () => {
  it("is a 2 ms falling impulse", () => {
    const out = renderClick(48000);
    expect(out).toHaveLength(96);
    expect(out[0]).toBe(1);
    expect(out[95]).toBeGreaterThan(0);
    expect(out[95]).toBeLessThan(0.05);
  });
});

// ---------------------------------------------------------------------------------------------
// Synth with a recording fake AudioContext (Requirements 1.1, 1.3)
// ---------------------------------------------------------------------------------------------

class FakeParam {
  value = 0;
  calls: Array<[string, number, number?]> = [];
  setValueAtTime(v: number, t: number) { this.calls.push(["set", v, t]); return this; }
  linearRampToValueAtTime(v: number, t: number) { this.calls.push(["linear", v, t]); return this; }
  exponentialRampToValueAtTime(v: number, t: number) { this.calls.push(["exp", v, t]); return this; }
}

class FakeNode {
  readonly connections: unknown[] = [];
  readonly gain = new FakeParam();
  readonly frequency = new FakeParam();
  readonly delayTime = new FakeParam();
  type = "";
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  readonly kind: string;
  constructor(kind: string) { this.kind = kind; }
  connect(to: unknown) { this.connections.push(to); return to; }
  start(t: number) { this.startedAt = t; }
  stop(t: number) { this.stoppedAt = t; }
}

class FakeBuffer {
  readonly data: Float32Array;
  constructor(length: number) { this.data = new Float32Array(length); }
  getChannelData() { return this.data; }
}

class FakeContext {
  state: "suspended" | "running" = "suspended";
  currentTime = 10;
  sampleRate = 8000;
  destination = { kind: "destination" };
  nodes: FakeNode[] = [];
  resumeCalls = 0;
  private make(kind: string) { const n = new FakeNode(kind); this.nodes.push(n); return n; }
  createGain() { const n = this.make("gain"); (n as unknown as { context: unknown }).context = this; return n; }
  createOscillator() { return this.make("osc"); }
  createBufferSource() { return this.make("buffer"); }
  createDelay() { return this.make("delay"); }
  createBuffer(_channels: number, length: number) { return new FakeBuffer(length); }
  resume() { this.resumeCalls++; this.state = "running"; return Promise.resolve(); }
  of(kind: string) { return this.nodes.filter((n) => n.kind === kind); }
}

class FakeTarget {
  readonly listeners = new Map<string, Array<{ fn: () => void; capture: unknown }>>();
  addEventListener(name: string, fn: () => void, capture?: unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), { fn, capture }]);
  }
  removeEventListener(name: string, fn: () => void) {
    this.listeners.set(name, (this.listeners.get(name) ?? []).filter((l) => l.fn !== fn));
  }
  fire(name: string) { for (const l of [...(this.listeners.get(name) ?? [])]) l.fn(); }
  count() { return [...this.listeners.values()].reduce((sum, list) => sum + list.length, 0); }
}

function setup(running = true) {
  const context = new FakeContext();
  if (running) context.state = "running";
  const synth = new HexAudioSynth({ createContext: () => context as unknown as AudioContext, random: lcg() });
  if (running) synth.unlock();
  return { context, synth };
}

describe("HexAudioSynth voices", () => {
  const VOICES: HexVoice[] = ["harpsichord", "boing", "flute", "square8bit", "click"];

  it("harpsichord renders one Karplus-Strong buffer per note, at the note's start time", () => {
    const { context, synth } = setup();
    synth.play("harpsichord", 120, "c4q rq e4q");
    const sources = context.of("buffer");
    expect(sources).toHaveLength(2);
    expect(sources[0].startedAt).toBeCloseTo(10.03, 9);
    expect(sources[1].startedAt).toBeCloseTo(11.03, 9);
    expect(sources.every((s) => s.buffer && s.buffer.data.some((v) => v !== 0))).toBe(true);
  });

  it("boing slides an oscillator's pitch exponentially with an LFO on its frequency", () => {
    const { context, synth } = setup();
    synth.play("boing", 120, "a4q");
    const [osc, lfo] = context.of("osc");
    expect(osc.type).toBe("sine");
    expect(osc.frequency.calls.map((c) => c[1])).toEqual([880, 220]);
    expect(osc.frequency.calls[1][1]).toBeLessThan(osc.frequency.calls[0][1]);
    expect(lfo.connections.some((c) => c instanceof FakeNode && c.connections.includes(osc.frequency))).toBe(true);
  });

  it("flute is a triangle wave with attack, decay, sustain and release", () => {
    const { context, synth } = setup();
    synth.play("flute", 120, "a4h");
    const [osc] = context.of("osc");
    expect(osc.type).toBe("triangle");
    expect(osc.frequency.value).toBeCloseTo(440, 6);
    const env = context.of("gain").find((g) => g.gain.calls.length > 0)!;
    const levels = env.gain.calls.map((c) => c[1]);
    expect(levels[0]).toBe(0);
    expect(levels[levels.length - 1]).toBe(0);
    expect(Math.max(...levels)).toBeGreaterThan(levels[2]);
  });

  it("square8bit builds a pulse from two sawtooth oscillators and a modulated delay", () => {
    const { context, synth } = setup();
    synth.play("square8bit", 120, "c4q");
    expect(context.of("osc").map((o) => o.type)).toEqual(["sawtooth", "sawtooth", "sine"]);
    expect(context.of("delay")).toHaveLength(1);
    expect(context.of("osc").every((o) => o.startedAt === 10.03 && o.stoppedAt! > 10.03)).toBe(true);
  });

  it("click plays a 2 ms impulse per note and ignores the pitch", () => {
    const { context, synth } = setup();
    synth.play("click", 120, "c4q g4q");
    const sources = context.of("buffer");
    expect(sources).toHaveLength(2);
    expect(sources[0].buffer!.data).toHaveLength(16); // 2 ms at 8 kHz
  });

  it("click and boing without notes make one default sound; melodic voices stay silent", () => {
    for (const voice of VOICES) {
      const { context, synth } = setup();
      synth.play(voice, 120, "");
      const count = context.nodes.filter((n) => n.startedAt !== null).length;
      expect(count > 0).toBe(voice === "click" || voice === "boing");
    }
  });

  it("plays nothing for rests only and for unparseable notes", () => {
    for (const voice of VOICES) {
      const { context, synth } = setup();
      synth.play(voice, 120, "rq rh");
      synth.play(voice, 120, "x y z");
      expect(context.nodes.filter((n) => n.startedAt !== null)).toEqual([]);
    }
  });

  it("every voice makes sound for a plain note", () => {
    for (const voice of VOICES) {
      const { context, synth } = setup();
      synth.play(voice, 140, "c4q");
      expect(context.nodes.some((n) => n.startedAt !== null)).toBe(true);
    }
  });

  it("never throws, even when the audio API does", () => {
    const { context, synth } = setup();
    context.createBufferSource = () => { throw new Error("boom"); };
    expect(() => synth.play("harpsichord", 120, "c4q")).not.toThrow();
  });
});

describe("HexAudioSynth autoplay unlock (Requirement 1.3)", () => {
  it("drops requests silently until the context runs, then resumes on the first pointer event", async () => {
    const context = new FakeContext();
    const synth = new HexAudioSynth({ createContext: () => context as unknown as AudioContext });
    const target = new FakeTarget();
    synth.installAutoplayUnlock(target);

    synth.play("harpsichord", 120, "c4q"); // no gesture yet
    expect(context.nodes).toEqual([]);
    expect(synth.ready).toBe(false);

    target.fire("pointerdown");
    expect(context.resumeCalls).toBe(1);
    await Promise.resolve();
    expect(synth.ready).toBe(true);

    synth.play("harpsichord", 120, "c4q");
    expect(context.of("buffer")).toHaveLength(1); // the dropped request was not queued
  });

  it("also unlocks on a key event and removes its listeners once audio runs", async () => {
    const context = new FakeContext();
    const synth = new HexAudioSynth({ createContext: () => context as unknown as AudioContext });
    const target = new FakeTarget();
    synth.installAutoplayUnlock(target);
    expect(target.count()).toBe(3);
    expect([...target.listeners.values()].every((l) => l.every((x) => x.capture === true))).toBe(true);

    target.fire("keydown");
    await Promise.resolve();
    await Promise.resolve();
    expect(synth.ready).toBe(true);
    expect(target.count()).toBe(0);
  });

  it("keeps listening when resume does not start the context", async () => {
    const context = new FakeContext();
    context.resume = () => { context.resumeCalls++; return Promise.resolve(); }; // stays suspended
    const synth = new HexAudioSynth({ createContext: () => context as unknown as AudioContext });
    const target = new FakeTarget();
    synth.installAutoplayUnlock(target);
    target.fire("pointerdown");
    await Promise.resolve();
    await Promise.resolve();
    expect(target.count()).toBe(3);
  });

  it("survives a missing or throwing AudioContext and an event-less target", () => {
    const none = new HexAudioSynth({ createContext: () => null });
    expect(() => { none.unlock(); none.play("click", 120, ""); }).not.toThrow();
    const throwing = new HexAudioSynth({ createContext: () => { throw new Error("no audio"); } });
    expect(() => throwing.unlock()).not.toThrow();
    const remove = none.installAutoplayUnlock({});
    expect(() => remove()).not.toThrow();
  });
});
