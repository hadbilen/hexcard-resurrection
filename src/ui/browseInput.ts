/**
 * Browse-tool input shared by the studio's card viewport and the standalone player (spec 04
 * Requirements 2.1, 2.9, 6.3): client-to-card pointer mapping, the checkBox / radioButton
 * auto-hilite and the translation of pointer and keyboard input into message bus posts.
 *
 * Extracted from `CardViewport.tsx` unchanged so that the player bundle does not import React.
 * `CardViewport.tsx` re-exports everything here. No React, no DOM access: testable in Node.
 */
import { resolveBrowseClick, type BrowseClick, type MessageBus } from "../core/messageBus.ts";
import type { HexFieldPart, HexID, HexPart } from "../core/schema.ts";
import type { HexLayer, HexRuntimeState, RuntimeMutation } from "../core/store.ts";
import { hitTest } from "../engine/graphics/partRenderer.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH } from "../engine/graphics/rleCodec.ts";
import type { UiStore } from "./System7Shell.tsx";

// ---------------------------------------------------------------------------------------------
// Pointer mapping
// ---------------------------------------------------------------------------------------------

export interface CardPoint {
  x: number;
  y: number;
}

/**
 * Maps a client-space pointer position to card pixels. `rect` is the canvas's bounding client
 * rect, whose size is 512k x 342k CSS pixels for the integer scale k; the result is floored, so
 * every CSS pixel of a card pixel maps to that card pixel. Positions outside the canvas map
 * outside 0..511 / 0..341.
 */
export function clientToCardPoint(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number; width: number; height: number },
): CardPoint {
  const sx = rect.width > 0 ? BITMAP_WIDTH / rect.width : 1;
  const sy = rect.height > 0 ? BITMAP_HEIGHT / rect.height : 1;
  return { x: Math.floor((clientX - rect.left) * sx), y: Math.floor((clientY - rect.top) * sy) };
}

// ---------------------------------------------------------------------------------------------
// Browse-tool input (Requirement 2.1)
// ---------------------------------------------------------------------------------------------

/** Interval of `mouseStillDown` (button held) and `mouseWithin` (pointer over a part). */
export const CONTINUOUS_MESSAGE_INTERVAL_MS = 100;

/** Keys that are never sent as `keyDown` on their own. */
const MODIFIER_KEYS: ReadonlySet<string> = new Set(["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "AltGraph", "Tab"]);

export interface BrowseInputOptions {
  /** `applyRuntime` writes the checkBox / radioButton auto-hilite (Requirement 2.9). */
  store: Pick<UiStore, "getSnapshot" | "applyRuntime">;
  bus: Pick<MessageBus, "post">;
}

/**
 * Requirement 2.9: the runtime mutations for a Browse-tool click (press and release over the same
 * part) on `partId`, to be applied before its `mouseUp` is posted. Only an enabled, visible
 * button with `autoHilite` on the current card or its background qualifies:
 * - checkBox: toggles its `hilite`;
 * - radioButton: sets its `hilite` to true and, when it has a `family` (1..15), clears `hilite` on
 *   every other radioButton of that family in the same parts list (the current card's parts, or
 *   the current card's background's parts). A radioButton without a family belongs to no group.
 * Only real changes are returned, so an unqualified part or a radio that is already the only
 * hilited one in its family yields `[]`.
 */
export function autoHiliteMutations(state: HexRuntimeState, partId: HexID): RuntimeMutation[] {
  const card = state.stack.cards.find((candidate) => candidate.id === state.currentCardId);
  if (!card) return [];
  const background = state.stack.backgrounds.find((candidate) => candidate.id === card.backgroundId);
  const setHilite = (id: HexID, value: boolean): RuntimeMutation => ({ type: "setPartProperty", partId: id, property: "hilite", value });

  for (const parts of [card.parts, background?.parts ?? []]) {
    const part = parts.find((candidate) => candidate.id === partId);
    if (!part) continue;
    if (part.type !== "button" || !part.autoHilite || !part.enabled || !part.visible) return [];
    if (part.style === "checkBox") return [setHilite(part.id, !part.hilite)];
    if (part.style !== "radioButton") return [];
    const mutations = part.hilite ? [] : [setHilite(part.id, true)];
    if (part.family === undefined) return mutations;
    for (const other of parts) {
      if (other.id !== part.id && other.type === "button" && other.style === "radioButton" && other.family === part.family && other.hilite) {
        mutations.push(setHilite(other.id, false));
      }
    }
    return mutations;
  }
  return [];
}

/**
 * Turns Browse-tool pointer and keyboard input (in card pixels) into message bus posts (design
 * spec §3, §3.1): `mouseEnter` / `mouseLeave` when the part under the pointer changes,
 * `mouseDown` to the part or the card, `mouseUp` when released over the same target (anywhere on
 * the card for a card target), `mouseStillDown` / `mouseWithin` on `tick()`, `mouseDoubleClick`,
 * and `keyDown` to the current card. A press in an enabled unlocked field sends no mouse message
 * and is returned as `editField`. Disabled parts are filtered by the bus.
 */
export interface BrowseInput {
  pointerDown(x: number, y: number): BrowseClick;
  pointerMove(x: number, y: number): void;
  pointerUp(x: number, y: number): void;
  pointerLeave(): void;
  /** Drops a press without `mouseUp` (pointer cancel). */
  cancel(): void;
  /** Forgets press and hover without sending messages (card or tool change). */
  reset(): void;
  doubleClick(x: number, y: number): void;
  keyDown(key: string): void;
  /** Sends the continuous messages; called every `CONTINUOUS_MESSAGE_INTERVAL_MS`. */
  tick(): void;
  /** Part drawn pressed (autoHilite): pressed, enabled and still under the pointer. */
  pressedPartId(): HexID | undefined;
}

export function createBrowseInput({ store, bus }: BrowseInputOptions): BrowseInput {
  let press: { targetId: HexID; isPart: boolean; enabled: boolean; inside: boolean } | null = null;
  let hovered: HexID | null = null;

  const post = (name: string, targetId: HexID, params: (string | number)[] = []): void => bus.post({ name, params, targetId });

  const partAt = (x: number, y: number): HexPart | null => {
    const state = store.getSnapshot();
    return hitTest(state.stack, state.currentCardId, x, y);
  };

  const hover = (partId: HexID | null): void => {
    if (partId === hovered) return;
    if (hovered !== null) post("mouseLeave", hovered);
    hovered = partId;
    if (partId !== null) post("mouseEnter", partId);
  };

  return {
    pointerDown(x, y) {
      const part = partAt(x, y);
      hover(part?.id ?? null);
      const click = resolveBrowseClick(store.getSnapshot(), part?.id ?? null);
      press = null;
      if (click.action === "editField") return click;
      press = { targetId: click.targetId, isPart: part !== null, enabled: part?.enabled ?? true, inside: true };
      post("mouseDown", click.targetId);
      return click;
    },

    pointerMove(x, y) {
      const part = partAt(x, y);
      hover(part?.id ?? null);
      if (press?.isPart) press.inside = part?.id === press.targetId;
    },

    pointerUp(x, y) {
      const released = press;
      press = null;
      if (!released) return;
      if (released.isPart) {
        if (partAt(x, y)?.id !== released.targetId) return; // released outside: no click
        // Requirement 2.9: the auto-hilite is in the store before mouseUp is queued.
        for (const mutation of autoHiliteMutations(store.getSnapshot(), released.targetId)) store.applyRuntime(mutation);
      }
      post("mouseUp", released.targetId);
    },

    pointerLeave() {
      hover(null);
    },

    cancel() {
      press = null;
    },

    reset() {
      press = null;
      hovered = null;
    },

    doubleClick(x, y) {
      const part = partAt(x, y);
      const click = resolveBrowseClick(store.getSnapshot(), part?.id ?? null);
      if (click.action === "send") post("mouseDoubleClick", click.targetId);
    },

    keyDown(key) {
      if (MODIFIER_KEYS.has(key)) return;
      post("keyDown", store.getSnapshot().currentCardId, [key]);
    },

    tick() {
      if (press) post("mouseStillDown", press.targetId);
      if (hovered !== null) post("mouseWithin", hovered);
    },

    pressedPartId: () => (press?.isPart && press.enabled && press.inside ? press.targetId : undefined),
  };
}

// ---------------------------------------------------------------------------------------------
// Field editing (Requirement 2.5)
// ---------------------------------------------------------------------------------------------

/** The field being edited: a field of `layer` shown on card `cardId`. */
export interface FieldEditTarget {
  cardId: HexID;
  layer: HexLayer;
  partId: HexID;
}

/**
 * The field of `target` if it can be edited right now: Browse tool, `cardId` is the current card,
 * and the field is on that card (or its background), visible, enabled and unlocked.
 */
export function editableField(state: HexRuntimeState, target: FieldEditTarget): HexFieldPart | null {
  if (state.tool !== "browse" || state.currentCardId !== target.cardId) return null;
  const card = state.stack.cards.find((candidate) => candidate.id === target.cardId);
  if (!card) return null;
  const owner = target.layer === "card" ? card : state.stack.backgrounds.find((candidate) => candidate.id === card.backgroundId);
  const part = owner?.parts.find((candidate) => candidate.id === target.partId);
  if (!part || part.type !== "field" || !part.visible || !part.enabled || part.lockText) return null;
  return part;
}

/** Design spec §3.1: `closeField` when the text changed while the field was open, else `exitField`. */
export function fieldExitMessage(textAtOpen: string, textAtClose: string): "closeField" | "exitField" {
  return textAtOpen === textAtClose ? "exitField" : "closeField";
}
