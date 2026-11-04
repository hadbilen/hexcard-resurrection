/**
 * VM host: the studio's implementation of the spec 02 `HexHost` interface.
 * Design: .kiro/specs/04-ui-audio-showcase/design.md §2. Shared contracts: hexcard_design_spec.md
 * §3.2 (nested `go`, suspension points), §4.3 (fetch policy), §5.2/§5.6 (visual effects on two
 * fully composed frames).
 *
 * - Dialogs (`answer`, `ask`) go through the shell's modal manager.
 * - `go` resolves its target against the current snapshot and changes card through the message
 *   bus (`changeCard`), which sends the nested lifecycle messages. A pending visual effect becomes
 *   the bus's `transition`, played by spec 03 `playEffect` on the `EffectStage` the card viewport
 *   attaches to.
 * - `play` is delegated to an injected sound player (the spec 04 synth); without one it is silent.
 * - `fetch` goes through `src/core/fetchPolicy.ts`.
 *
 * No React and no DOM access: everything browser-specific is injected, so this module runs in Node.
 */
import type { HexVoice } from "../core/ast.ts";
import { fetchJson as policyFetchJson } from "../core/fetchPolicy.ts";
import { resolveRelativeCard, type MessageBus } from "../core/messageBus.ts";
import type { VisualEffectSpeed, VisualEffectType } from "../core/schema.ts";
import { readFieldText, type HexStore } from "../core/store.ts";
import {
  HexScriptError,
  resolveObjectTarget,
  type FetchResult,
  type HexHost,
  type HostClock,
  type PendingEffect,
} from "../core/vm.ts";
import type { PartRasterizer } from "../engine/graphics/bitmapCanvas.ts";
import { composeEffectFrame, playEffect, type FrameScheduler } from "../engine/graphics/transitions.ts";
import type { ModalManager } from "./System7Shell.tsx";

// ---------------------------------------------------------------------------------------------
// Effect stage: where visual effects are shown
// ---------------------------------------------------------------------------------------------

/** The surface a visual effect is drawn on (the card viewport's canvas). */
export interface EffectView {
  /** Shows one effect frame (175,104 palette-mapped pixels). Must copy the buffer before returning. */
  present(buf: Uint32Array): void;
  /** A copy of the frame currently on screen, or null before the first frame was drawn. */
  capture(): Uint32Array | null;
}

export interface EffectFrames {
  /** Used when the view has nothing on screen yet. */
  from: () => Uint32Array;
  to: () => Uint32Array;
}

export interface EffectStage {
  /** Attaches the view effects are drawn on; returns a function that detaches it. */
  attach(view: EffectView): () => void;
  /** True while an effect owns the view; the viewport must not draw its own frames meanwhile. */
  isPlaying(): boolean;
  /** Notified whenever `isPlaying()` changes. */
  subscribe(listener: () => void): () => void;
  /**
   * Plays `effect` from the frame on screen to `frames.to()`. Resolves at once, composing nothing,
   * when no view is attached. Rejects with `HexAbortError` when `signal` aborts.
   */
  play(effect: VisualEffectType, speed: VisualEffectSpeed, frames: EffectFrames, signal?: AbortSignal): Promise<void>;
}

export interface EffectStageOptions {
  /** Passed to `playEffect`; defaults to `requestAnimationFrame`. */
  requestFrame?: FrameScheduler;
}

export function createEffectStage(options: EffectStageOptions = {}): EffectStage {
  const listeners = new Set<() => void>();
  let view: EffectView | null = null;
  let playing = 0;

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  return {
    attach(next) {
      view = next;
      return () => {
        if (view === next) view = null;
      };
    },

    isPlaying: () => playing > 0,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async play(effect, speed, frames, signal) {
      const target = view;
      if (!target) return;
      // `from` is taken synchronously, before the viewport can redraw the new card.
      const from = target.capture() ?? frames.from();
      const to = frames.to();
      playing += 1;
      notify();
      try {
        await playEffect(effect, speed, from, to, (buf) => target.present(buf), {
          signal,
          requestFrame: options.requestFrame,
        });
      } finally {
        playing -= 1;
        notify();
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Pointer position for `the mouseH` / `the mouseV`
// ---------------------------------------------------------------------------------------------

export interface MouseTracker {
  /** Last pointer position in card pixels. */
  get(): { h: number; v: number };
  set(h: number, v: number): void;
}

export function createMouseTracker(): MouseTracker {
  let position = { h: 0, v: 0 };
  return {
    get: () => position,
    set(h, v) {
      position = { h, v };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Clock
// ---------------------------------------------------------------------------------------------

/** HyperCard's short date: month/day/two-digit year, e.g. "1/9/26". */
export function formatShortDate(date: Date): string {
  return `${date.getMonth() + 1}/${date.getDate()}/${String(date.getFullYear() % 100).padStart(2, "0")}`;
}

/** HyperCard's short time: 12-hour clock with AM/PM, e.g. "9:05 PM". */
export function formatShortTime(date: Date): string {
  const hours = date.getHours();
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${String(date.getMinutes()).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

// ---------------------------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------------------------

/** Plays a note sequence; implemented by the spec 04 synth (`src/engine/audio/synth.ts`). */
export type SoundPlayer = (voice: HexVoice, tempo: number, notes: string) => void;

export interface VmHostOptions {
  /** Runtime view of the store: the host reads snapshots and writes only with `applyRuntime`. */
  store: Pick<HexStore, "getSnapshot" | "applyRuntime">;
  /** The message bus; read lazily because the bus is created after the host. */
  bus: () => Pick<MessageBus, "changeCard">;
  dialogs: Pick<ModalManager, "answer" | "ask">;
  /** Where visual effects play. Without a stage, `go` changes card without an effect. */
  effects?: EffectStage;
  /** Source of `the mouseH` / `the mouseV`; 0,0 without one. */
  mouse?: Pick<MouseTracker, "get">;
  /** Without a player, `play` is silent. */
  playSound?: SoundPlayer;
  /** Defaults to the sandboxed `fetchJson` of fetchPolicy.ts. */
  fetchJson?: (url: string, jsonPath?: string) => Promise<FetchResult>;
  /** Rasterizer used to compose effect frames; defaults to partRenderer.ts's. */
  rasterizePart?: PartRasterizer;
  /** Wall clock for `the date`, `the time` and `the seconds`. Defaults to `new Date()`. */
  now?: () => Date;
  /** Milliseconds since start-up for `the ticks`. Defaults to `performance.now()`. */
  uptimeMs?: () => number;
}

const silent: SoundPlayer = () => undefined;

export function createVmHost(options: VmHostOptions): HexHost {
  const { store, dialogs, effects } = options;
  const playSound = options.playSound ?? silent;
  const fetchJson = options.fetchJson ?? ((url: string, jsonPath?: string) => policyFetchJson(url, jsonPath));
  const now = options.now ?? (() => new Date());
  const uptimeMs = options.uptimeMs ?? (() => performance.now());

  return {
    readField: (ref) => readFieldText(store.getSnapshot().stack, ref.cardId, ref.layer, ref.partId),

    applyRuntime: (m) => store.applyRuntime(m),

    resolveObject: (target, me) => resolveObjectTarget(store.getSnapshot(), target, me),

    async goToCard(target, effect: PendingEffect | null, ctx) {
      const bus = options.bus();
      const before = store.getSnapshot();
      const transition = effect && effects
        ? () => {
          const after = store.getSnapshot();
          return effects.play(effect.effect, effect.speed, {
            from: () => composeEffectFrame(before.stack, before.currentCardId, options.rasterizePart),
            to: () => composeEffectFrame(after.stack, after.currentCardId, options.rasterizePart),
          }, ctx.abortSignal);
        }
        : undefined;

      if (target.type === "relative") {
        // `go back` is resolved by the bus, which owns the back history (spec 01 Requirement 2.7).
        if (target.dir === "back") return bus.changeCard({ type: "relative", dir: "back" }, ctx, transition);
        return bus.changeCard(resolveRelativeCard(before, target.dir), ctx, transition);
      }
      const found = resolveObjectTarget(
        before,
        { objectType: "card", selector: { by: target.type, value: target.value } },
        before.currentCardId,
      );
      if (found.kind !== "card") throw new HexScriptError("go needs a card");
      return bus.changeCard(found.card.id, ctx, transition);
    },

    playSound: (voice, tempo, notes) => playSound(voice, tempo, notes),

    showAnswer: (prompt, buttons) => dialogs.answer(prompt, buttons),

    showAsk: (prompt, defaultAnswer) => dialogs.ask(prompt, defaultAnswer),

    fetchJson: (url, jsonPath) => fetchJson(url, jsonPath),

    now(): HostClock {
      const date = now();
      const mouse = options.mouse?.get() ?? { h: 0, v: 0 };
      return {
        date: formatShortDate(date),
        time: formatShortTime(date),
        ticks: Math.floor((uptimeMs() * 60) / 1000),
        seconds: Math.floor(date.getTime() / 1000),
        mouseH: mouse.h,
        mouseV: mouse.v,
      };
    },
  };
}
