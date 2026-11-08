/**
 * 50-step Undo/Redo history (Command pattern).
 * Design: .kiro/specs/01-core-stack-engine/design.md §4. Requirements 4.2, 5.1, 5.2, 5.3.
 *
 * - Every authoring mutation is a `HexCommand` run through `history.execute(command)`. The history
 *   computes the next stack with `apply`/`revert` on the current snapshot and hands it to
 *   `store.applyAuthoring`; it is the only caller of that method.
 * - The undo list is a ring buffer of `HISTORY_LIMIT` commands: when full, the oldest is discarded.
 *   `execute` clears the redo list.
 * - Runtime mutations (`store.applyRuntime`) never enter the history.
 *
 * Pure TypeScript: no React, DOM or `src/engine/` imports. The bitmap codec is injected.
 */
import type { HexBackground, HexCard, HexID, HexRect, HexStack } from "./schema.ts";
import { HexMutationError, type HexLayer, type HexStore } from "./store.ts";

export const HISTORY_LIMIT = 50;

export interface HexCommand {
  label: string;                           // shown in Edit > Undo <label>
  apply(stack: HexStack): HexStack;
  revert(stack: HexStack): HexStack;
  /**
   * Spec 05 (Requirements 13.2, 13.3). Read right after `apply` / `revert`; the returned card becomes
   * current in the same `store.applyAuthoring` call. Commands without it leave the current card alone.
   */
  currentCardAfter?(step: "apply" | "revert"): HexID | undefined;
}

export interface HexHistory {
  /** Applies the command and records it. A command that throws or changes nothing is not recorded. */
  execute(command: HexCommand): void;
  /** Reverts the most recent command; returns false when there is nothing to undo. */
  undo(): boolean;
  /** Re-applies the most recently undone command; returns false when there is nothing to redo. */
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Label of the command Undo would revert, for the Edit menu. */
  undoLabel(): string | undefined;
  redoLabel(): string | undefined;
  /**
   * Drops all commands so commands never cross stacks. The stack loader calls it together with
   * `clearDecodedLayerCache()` before `store.replaceStack` (spec 04 Requirement 5.5).
   */
  clear(): void;
}

/** Fixed-capacity LIFO that overwrites its oldest entry when full. */
class CommandRing {
  readonly #slots: (HexCommand | undefined)[];
  #start = 0; // index of the oldest entry
  #size = 0;

  constructor(capacity: number) {
    this.#slots = new Array<HexCommand | undefined>(capacity).fill(undefined);
  }

  get size(): number {
    return this.#size;
  }

  push(command: HexCommand): void {
    const capacity = this.#slots.length;
    if (this.#size === capacity) {
      this.#slots[this.#start] = command; // overwrite the oldest
      this.#start = (this.#start + 1) % capacity;
      return;
    }
    this.#slots[(this.#start + this.#size) % capacity] = command;
    this.#size++;
  }

  peek(): HexCommand | undefined {
    if (this.#size === 0) return undefined;
    return this.#slots[(this.#start + this.#size - 1) % this.#slots.length];
  }

  pop(): HexCommand | undefined {
    const command = this.peek();
    if (command === undefined) return undefined;
    this.#slots[(this.#start + this.#size - 1) % this.#slots.length] = undefined;
    this.#size--;
    return command;
  }

  clear(): void {
    this.#slots.fill(undefined);
    this.#start = 0;
    this.#size = 0;
  }
}

export function createHistory(store: Pick<HexStore, "getSnapshot" | "applyAuthoring">): HexHistory {
  const undoRing = new CommandRing(HISTORY_LIMIT);
  // Redo entries only come from undo, so this list never exceeds HISTORY_LIMIT either.
  const redoList: HexCommand[] = [];

  /** Computes and commits the next stack; returns false when the command changed nothing. */
  function run(command: HexCommand, step: "apply" | "revert"): boolean {
    const current = store.getSnapshot().stack;
    const next = step === "apply" ? command.apply(current) : command.revert(current);
    if (next === current) return false;
    const cardId = command.currentCardAfter?.(step);
    if (cardId === undefined) store.applyAuthoring(next);
    else store.applyAuthoring(next, cardId);
    return true;
  }

  return {
    execute(command) {
      if (!run(command, "apply")) return;
      undoRing.push(command);
      redoList.length = 0;
    },

    undo() {
      const command = undoRing.peek();
      if (command === undefined) return false;
      run(command, "revert");
      undoRing.pop();
      redoList.push(command);
      return true;
    },

    redo() {
      const command = redoList.at(-1);
      if (command === undefined) return false;
      run(command, "apply");
      redoList.pop();
      undoRing.push(command);
      return true;
    },

    canUndo: () => undoRing.size > 0,
    canRedo: () => redoList.length > 0,
    undoLabel: () => undoRing.peek()?.label,
    redoLabel: () => redoList.at(-1)?.label,

    clear() {
      undoRing.clear();
      redoList.length = 0;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// PaintStrokeCommand (Requirement 5.3)
// ---------------------------------------------------------------------------------------------

/** Decoded pixel state: 0 = Transparent, 1 = White/Light, 2 = Black/Dark. */
export type PixelState = 0 | 1 | 2;

/**
 * Injected bitmap codec, so core never imports `src/engine/`. Production passes
 * `encodeBitmapRLE`/`decodeBitmapRLE` from `src/engine/graphics/rleCodec.ts` (spec 03).
 */
export interface BitmapCodec {
  encode(pixels: Uint8Array): string;
  decode(rleData: string, emptyFill: PixelState): Uint8Array;
}

/** One whole stroke: the before/after pixels of its bounding rectangle, row-major. */
export interface PaintStroke {
  layer: HexLayer;
  layerOwnerId: HexID;                     // HexCard.id or HexBackground.id
  rect: HexRect;                           // in layer pixel coordinates, inside the layer
  before: Uint8Array;                      // rect.width * rect.height pixels
  after: Uint8Array;
}

/** "" decodes to transparent on cards and to light on backgrounds (design spec §2.1). */
const EMPTY_FILL: Record<HexLayer, PixelState> = { card: 0, background: 1 };

function findOwner(stack: HexStack, layer: HexLayer, ownerId: HexID): HexCard | HexBackground {
  const owners: readonly (HexCard | HexBackground)[] = layer === "card" ? stack.cards : stack.backgrounds;
  const owner = owners.find((candidate) => candidate.id === ownerId);
  if (!owner) throw new HexMutationError(`No ${layer} with id "${ownerId}" for paint stroke`);
  return owner;
}

/** Structural-sharing write of one layer's `rleData`. */
function withLayerData(stack: HexStack, layer: HexLayer, ownerId: HexID, rleData: string): HexStack {
  const owner = findOwner(stack, layer, ownerId);
  if (owner.bitmap.rleData === rleData) return stack;
  const updated = { ...owner, bitmap: { ...owner.bitmap, rleData } };
  if (layer === "card") {
    return { ...stack, cards: stack.cards.map((card) => (card.id === ownerId ? (updated as HexCard) : card)) };
  }
  return {
    ...stack,
    backgrounds: stack.backgrounds.map((background) =>
      background.id === ownerId ? (updated as HexBackground) : background),
  };
}

export class PaintStrokeCommand implements HexCommand {
  readonly label: string;
  readonly #stroke: Readonly<PaintStroke>;
  readonly #codec: BitmapCodec;
  /**
   * rleData seen before and produced by the last apply. Undo/redo restore these exact strings when
   * the layer is unchanged since, so states stay identical even where encode(decode(x)) !== x
   * (e.g. an empty background "" re-encodes as an explicit all-light layer).
   */
  #memo: { from: string; to: string } | undefined;

  constructor(stroke: PaintStroke, codec: BitmapCodec, label = "Paint") {
    const { rect } = stroke;
    const values = [rect.x, rect.y, rect.width, rect.height];
    if (!values.every(Number.isInteger) || rect.width < 0 || rect.height < 0) {
      throw new HexMutationError(`Invalid paint stroke rect ${JSON.stringify(rect)}`);
    }
    const pixelCount = rect.width * rect.height;
    if (stroke.before.length !== pixelCount || stroke.after.length !== pixelCount) {
      throw new HexMutationError(
        `Paint stroke pixels must hold ${pixelCount} entries, got ${stroke.before.length}/${stroke.after.length}`,
      );
    }
    // Private copies: the paint tool keeps reusing its working buffers.
    this.#stroke = Object.freeze({ ...stroke, rect: { ...rect }, before: stroke.before.slice(), after: stroke.after.slice() });
    this.#codec = codec;
    this.label = label;
  }

  apply(stack: HexStack): HexStack {
    const current = this.#currentData(stack);
    if (this.#memo?.from === current) return this.#write(stack, this.#memo.to);
    const next = this.#patch(stack, this.#stroke.after);
    this.#memo = { from: current, to: next };
    return this.#write(stack, next);
  }

  revert(stack: HexStack): HexStack {
    const current = this.#currentData(stack);
    if (this.#memo?.to === current) return this.#write(stack, this.#memo.from);
    return this.#write(stack, this.#patch(stack, this.#stroke.before));
  }

  #currentData(stack: HexStack): string {
    return findOwner(stack, this.#stroke.layer, this.#stroke.layerOwnerId).bitmap.rleData;
  }

  #write(stack: HexStack, rleData: string): HexStack {
    return withLayerData(stack, this.#stroke.layer, this.#stroke.layerOwnerId, rleData);
  }

  /** Decodes the layer, copies `pixels` into the stroke rect and re-encodes it. */
  #patch(stack: HexStack, pixels: Uint8Array): string {
    const { layer, layerOwnerId, rect } = this.#stroke;
    const { bitmap } = findOwner(stack, layer, layerOwnerId);
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > bitmap.width || rect.y + rect.height > bitmap.height) {
      throw new HexMutationError(`Paint stroke rect ${JSON.stringify(rect)} lies outside the ${layer} layer`);
    }
    const layerPixels = this.#codec.decode(bitmap.rleData, EMPTY_FILL[layer]);
    if (layerPixels.length !== bitmap.width * bitmap.height) {
      throw new HexMutationError(`Decoded ${layer} layer has ${layerPixels.length} pixels`);
    }
    for (let row = 0; row < rect.height; row++) {
      const source = pixels.subarray(row * rect.width, (row + 1) * rect.width);
      layerPixels.set(source, (rect.y + row) * bitmap.width + rect.x);
    }
    return this.#codec.encode(layerPixels);
  }
}
