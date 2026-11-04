/**
 * Procedural WebAudio synthesizer: five voices, the note sequence parser and the autoplay unlock.
 * Requirements: spec 04 1.1, 1.2, 1.3. Design: .kiro/specs/04-ui-audio-showcase/design.md §3;
 * hexcard_design_spec.md §6.
 *
 * - No audio asset files: every sound is computed (Karplus-Strong string, oscillators, an impulse).
 * - Pure TypeScript with no React. Browser globals are only read inside functions, so the module
 *   imports in Node; tests inject a fake `AudioContext` through `createContext`.
 * - A request made before the browser allows audio is dropped silently (never queued). The
 *   `AudioContext` is created and resumed on the first pointer or key event.
 */
import type { HexVoice } from "../../core/ast.ts";

// ---------------------------------------------------------------------------------------------
// Note sequence parser (design.md §3)
//   Note     ::= ( Letter [ "#" | "b" ] [ Octave ] | "r" ) [ Duration ] [ "." ]
//   Letter   ::= a..g     Octave ::= 1..7 (default: previous octave, initially 4)
//   Duration ::= w | h | q | e | s     (default: q)
// ---------------------------------------------------------------------------------------------

export const DEFAULT_TEMPO = 120;
export const MIN_TEMPO = 20;
export const MAX_TEMPO = 400;
export const DEFAULT_OCTAVE = 4;
/** A single `play` schedules at most this many notes; the rest of the string is ignored. */
export const MAX_NOTES_PER_SEQUENCE = 128;
/** Notes that would start later than this many seconds after the call are ignored. */
export const MAX_SEQUENCE_SECONDS = 60;

/** Duration letters in quarter-note beats. */
const BEATS: Readonly<Record<string, number>> = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25 };
const SEMITONE: Readonly<Record<string, number>> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

const PITCHED = /^([a-g])([#b])?([1-7])?([whqes])?(\.)?$/;
const REST = /^r([whqes])?(\.)?$/;

export interface NoteEvent {
  /** Seconds after the start of the sequence. */
  start: number;
  /** Seconds. Dotted notes are 1.5 times the plain value. */
  duration: number;
  /** Hz; `null` for a rest. */
  frequency: number | null;
}

export interface ParsedSequence {
  events: NoteEvent[];
  /** Tokens that did not match the grammar. They are skipped and take no time. */
  invalid: string[];
  /** Seconds from the start to the end of the last event. */
  totalSeconds: number;
}

/** Non-finite or non-positive tempos become 120; others are clamped to the validator range 20..400. */
export function normalizeTempo(tempo: number): number {
  if (!Number.isFinite(tempo) || tempo <= 0) return DEFAULT_TEMPO;
  return Math.min(MAX_TEMPO, Math.max(MIN_TEMPO, tempo));
}

/** Equal temperament, A4 = 440 Hz. `midi` 69 is A4. */
export function midiToFrequency(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function parseNoteSequence(notes: string, tempo: number = DEFAULT_TEMPO): ParsedSequence {
  const quarter = 60 / normalizeTempo(tempo);
  const events: NoteEvent[] = [];
  const invalid: string[] = [];
  let octave = DEFAULT_OCTAVE;
  let cursor = 0;

  for (const raw of notes.trim().split(/\s+/)) {
    if (raw === "") continue;
    if (events.length >= MAX_NOTES_PER_SEQUENCE || cursor >= MAX_SEQUENCE_SECONDS) break;
    const token = raw.toLowerCase();

    const rest = REST.exec(token);
    if (rest) {
      const duration = durationSeconds(rest[1], rest[2] !== undefined, quarter);
      events.push({ start: cursor, duration, frequency: null });
      cursor += duration;
      continue;
    }

    const pitched = PITCHED.exec(token);
    if (!pitched) {
      invalid.push(raw);
      continue;
    }
    const [, letter, accidental, octaveDigit, durationLetter, dot] = pitched;
    if (octaveDigit !== undefined) octave = Number(octaveDigit);
    const accidentalShift = accidental === "#" ? 1 : accidental === "b" ? -1 : 0;
    const midi = 12 * (octave + 1) + SEMITONE[letter] + accidentalShift;
    const duration = durationSeconds(durationLetter, dot !== undefined, quarter);
    events.push({ start: cursor, duration, frequency: midiToFrequency(midi) });
    cursor += duration;
  }

  return { events, invalid, totalSeconds: cursor };
}

function durationSeconds(letter: string | undefined, dotted: boolean, quarter: number): number {
  const beats = letter === undefined ? BEATS.q : BEATS[letter];
  return beats * quarter * (dotted ? 1.5 : 1);
}

// ---------------------------------------------------------------------------------------------
// Sample generators (pure, testable in Node)
// ---------------------------------------------------------------------------------------------

/** Loss per trip round the delay line; below 1 so the string dies away. */
const KS_DAMPING = 0.997;
const KS_FADE_SECONDS = 0.02;

/**
 * Karplus-Strong plucked string. A noise burst fills a delay line of about `sampleRate / frequency`
 * samples; each trip round the line replaces a sample by the damped average of itself and its
 * successor (the two-point low-pass). Returns `ceil(sampleRate * seconds)` samples in -1..1.
 */
export function renderKarplusStrong(
  frequency: number,
  sampleRate: number,
  seconds: number,
  random: () => number = Math.random,
): Float32Array {
  const length = Math.max(1, Math.ceil(sampleRate * seconds));
  // The averaging filter adds half a sample of delay, so the line is half a sample shorter.
  const lineLength = Math.max(2, Math.round(sampleRate / frequency - 0.5));
  const line = new Float32Array(lineLength);
  for (let i = 0; i < lineLength; i++) line[i] = random() * 2 - 1;

  const out = new Float32Array(length);
  let index = 0;
  for (let n = 0; n < length; n++) {
    const current = line[index];
    const next = line[(index + 1) % lineLength];
    out[n] = current;
    line[index] = KS_DAMPING * 0.5 * (current + next);
    index = (index + 1) % lineLength;
  }

  // Linear fade over the last 20 ms so the buffer never ends on a step.
  const fade = Math.min(length, Math.floor(sampleRate * KS_FADE_SECONDS));
  for (let i = 0; i < fade; i++) out[length - 1 - i] *= i / fade;
  return out;
}

const CLICK_SECONDS = 0.002;

/** The `click` voice: a 2 ms impulse that falls linearly from 1 to 0. */
export function renderClick(sampleRate: number): Float32Array {
  const length = Math.max(1, Math.round(sampleRate * CLICK_SECONDS));
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = 1 - i / length;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Synth
// ---------------------------------------------------------------------------------------------

/** Seconds between the call and the first note, so scheduling never lands in the past. */
const LEAD_SECONDS = 0.03;
const MASTER_GAIN = 0.3;
/** Notes that can sound at once; a request that would exceed it is dropped. */
const MAX_ACTIVE_SOURCES = 512;
const MAX_KS_RING_SECONDS = 2;

const UNLOCK_EVENTS = ["pointerdown", "pointerup", "keydown"] as const;

export interface HexAudioSynthOptions {
  /** Returns a new context, or `null` where WebAudio is unavailable. Defaults to the browser's. */
  createContext?: () => AudioContext | null;
  /** Noise source for the Karplus-Strong burst. */
  random?: () => number;
}

type EventSource = Pick<EventTarget, "addEventListener" | "removeEventListener">;

function browserContext(): AudioContext | null {
  const scope = globalThis as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export class HexAudioSynth {
  private readonly createContext: () => AudioContext | null;
  private readonly random: () => number;
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private active = 0;
  private removeListeners: (() => void) | null = null;

  constructor(options: HexAudioSynthOptions = {}) {
    this.createContext = options.createContext ?? browserContext;
    this.random = options.random ?? Math.random;
  }

  /** True when the context exists and the browser lets it run. */
  get ready(): boolean {
    return this.context !== null && this.context.state === "running";
  }

  /**
   * Listens for the first pointer or key event on `target` (capture phase) and unlocks audio then.
   * The listeners remove themselves once the context runs. Returns a function that removes them
   * now. Where `target` has no event API (Node) nothing is installed.
   */
  installAutoplayUnlock(target: Partial<EventSource> = globalThis): () => void {
    this.removeListeners?.();
    const { addEventListener, removeEventListener } = target;
    if (typeof addEventListener !== "function" || typeof removeEventListener !== "function") return () => undefined;

    const handler = (): void => this.unlock();
    for (const name of UNLOCK_EVENTS) addEventListener.call(target, name, handler, true);
    const remove = (): void => {
      for (const name of UNLOCK_EVENTS) removeEventListener.call(target, name, handler, true);
      if (this.removeListeners === remove) this.removeListeners = null;
    };
    this.removeListeners = remove;
    return remove;
  }

  /** Creates the context if needed and resumes it. Call from a user gesture. Never throws. */
  unlock(): void {
    try {
      if (!this.context) {
        this.context = this.createContext();
        if (!this.context) return;
      }
      if (this.context.state === "running") {
        this.removeListeners?.();
        return;
      }
      const context = this.context;
      void context.resume().then(
        () => {
          if (context.state === "running") this.removeListeners?.();
        },
        () => undefined,
      );
    } catch {
      // Audio is optional; a failing browser API must not break the page.
    }
  }

  /**
   * Plays `notes` on `voice`. Silently does nothing when audio is not allowed yet, when the notes
   * contain nothing to play, or when the browser API fails. Never throws, so a script is never
   * stopped by a sound problem.
   */
  play(voice: HexVoice, tempo: number, notes: string): void {
    try {
      const context = this.context;
      if (!context || context.state !== "running") return;

      const sequence = parseNoteSequence(notes, tempo);
      let events = sequence.events.filter((event) => event.frequency !== null);
      if (sequence.events.length === 0 && sequence.invalid.length === 0 && (voice === "click" || voice === "boing")) {
        // `play click ""` and `play boing ""` are sound effects without notes: one default hit.
        events = [{ start: 0, duration: 0.5 * (60 / normalizeTempo(tempo)), frequency: midiToFrequency(60) }];
      }
      if (events.length === 0 || this.active + events.length > MAX_ACTIVE_SOURCES) return;

      const out = this.output(context);
      const t0 = context.currentTime + LEAD_SECONDS;
      for (const event of events) {
        const start = t0 + event.start;
        const frequency = event.frequency ?? 0;
        switch (voice) {
          case "harpsichord": this.harpsichord(context, out, start, event.duration, frequency); break;
          case "boing": this.boing(context, out, start, event.duration, frequency); break;
          case "flute": this.flute(context, out, start, event.duration, frequency); break;
          case "square8bit": this.square8bit(context, out, start, event.duration, frequency); break;
          case "click": this.click(context, out, start); break;
        }
      }
    } catch {
      // See above.
    }
  }

  // --- voices ------------------------------------------------------------------------------

  private output(context: AudioContext): GainNode {
    if (!this.master || this.master.context !== context) {
      this.master = context.createGain();
      this.master.gain.value = MASTER_GAIN;
      this.master.connect(context.destination);
    }
    return this.master;
  }

  /** Counts a source as active until it ends. */
  private track(source: AudioScheduledSourceNode): void {
    this.active++;
    source.onended = () => {
      this.active--;
    };
  }

  private harpsichord(context: AudioContext, out: AudioNode, start: number, duration: number, frequency: number): void {
    const ring = Math.min(MAX_KS_RING_SECONDS, duration + 0.3);
    const samples = renderKarplusStrong(frequency, context.sampleRate, ring, this.random);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    this.track(source);
    source.start(start);
  }

  private click(context: AudioContext, out: AudioNode, start: number): void {
    const samples = renderClick(context.sampleRate);
    const buffer = context.createBuffer(1, samples.length, context.sampleRate);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    this.track(source);
    source.start(start);
  }

  /** Sine with an exponential pitch slide from 2f down to f/2 and a 14 Hz wobble. */
  private boing(context: AudioContext, out: AudioNode, start: number, duration: number, frequency: number): void {
    const length = Math.max(duration, 0.2);
    const end = start + length;

    const osc = context.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency * 2, start);
    osc.frequency.exponentialRampToValueAtTime(frequency * 0.5, end);

    const lfo = context.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 14;
    const depth = context.createGain();
    depth.gain.value = frequency * 0.1;
    lfo.connect(depth);
    depth.connect(osc.frequency);

    const env = context.createGain();
    env.gain.setValueAtTime(0.8, start);
    env.gain.exponentialRampToValueAtTime(0.001, end);
    osc.connect(env);
    env.connect(out);

    this.track(osc);
    osc.start(start);
    lfo.start(start);
    osc.stop(end);
    lfo.stop(end);
  }

  /** Triangle wave with attack, decay, sustain and release. */
  private flute(context: AudioContext, out: AudioNode, start: number, duration: number, frequency: number): void {
    const gate = Math.max(duration, 0.05);
    const attack = Math.min(0.04, gate * 0.3);
    const decay = Math.min(0.06, gate * 0.3);
    const release = 0.08;
    const peak = 0.7;
    const sustain = 0.7 * peak;

    const osc = context.createOscillator();
    osc.type = "triangle";
    osc.frequency.value = frequency;
    const env = context.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(peak, start + attack);
    env.gain.linearRampToValueAtTime(sustain, start + attack + decay);
    env.gain.setValueAtTime(sustain, start + gate);
    env.gain.linearRampToValueAtTime(0, start + gate + release);
    osc.connect(env);
    env.connect(out);

    this.track(osc);
    osc.start(start);
    osc.stop(start + gate + release + 0.01);
  }

  /**
   * Pulse wave with a slowly moving duty cycle (5 Hz, 20% to 80%). The pulse is the difference of
   * a sawtooth and the same sawtooth delayed by `duty / f`, with the delay time modulated by an LFO.
   */
  private square8bit(context: AudioContext, out: AudioNode, start: number, duration: number, frequency: number): void {
    const gate = Math.max(duration * 0.9, 0.05);
    const release = 0.01;
    const end = start + gate + release;
    const period = 1 / frequency;

    const sawA = context.createOscillator();
    sawA.type = "sawtooth";
    sawA.frequency.value = frequency;
    const sawB = context.createOscillator();
    sawB.type = "sawtooth";
    sawB.frequency.value = frequency;

    const invert = context.createGain();
    invert.gain.value = -1;
    const delay = context.createDelay(0.1);
    delay.delayTime.value = 0.5 * period;
    const lfo = context.createOscillator();
    lfo.type = "sine";
    lfo.frequency.value = 5;
    const lfoDepth = context.createGain();
    lfoDepth.gain.value = 0.3 * period;
    lfo.connect(lfoDepth);
    lfoDepth.connect(delay.delayTime);

    const mix = context.createGain();
    mix.gain.value = 0.5;
    const env = context.createGain();
    env.gain.setValueAtTime(0, start);
    env.gain.linearRampToValueAtTime(0.5, start + 0.003);
    env.gain.setValueAtTime(0.5, start + gate);
    env.gain.linearRampToValueAtTime(0, end);

    sawA.connect(mix);
    sawB.connect(invert);
    invert.connect(delay);
    delay.connect(mix);
    mix.connect(env);
    env.connect(out);

    this.track(sawA);
    sawA.start(start);
    sawB.start(start);
    lfo.start(start);
    sawA.stop(end);
    sawB.stop(end);
    lfo.stop(end);
  }
}

// ---------------------------------------------------------------------------------------------
// Shared instance
// ---------------------------------------------------------------------------------------------

let shared: HexAudioSynth | null = null;

/** The one synth of the page. The first call also installs the autoplay unlock on `globalThis`. */
export function getHexAudioSynth(): HexAudioSynth {
  if (!shared) {
    shared = new HexAudioSynth();
    shared.installAutoplayUnlock();
  }
  return shared;
}

/** Matches the VM host's `SoundPlayer` signature: `createVmHost({ playSound })`. */
export function playSound(voice: HexVoice, tempo: number, notes: string): void {
  getHexAudioSynth().play(voice, tempo, notes);
}
