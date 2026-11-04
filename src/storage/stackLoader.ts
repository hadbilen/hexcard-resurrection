/**
 * The one stack loading path (spec 04 Requirement 5.5, design.md §5 "Stack loader"), shared by
 * IndexedDB, `.hexstack` files, URL-hash links and presets:
 *
 * 1. `validateStack` (spec 01 Requirement 6.1);
 * 2. `decodeBitmapRLE` on every card layer (empty = transparent) and background layer (empty = light);
 * 3. on success: `history.clear()`, `clearDecodedLayerCache()`, then `store.replaceStack()`.
 *
 * Any failure, including a throw while reading or decompressing the source and invalid Base64 in
 * a layer, rejects the whole stack with one "This stack is damaged" alert, whose detail line is the
 * first error (spec 01 Requirement 6.2). The current stack is then left untouched.
 *
 * This module is the only holder of `replaceStack` besides the composition root (Requirement 2.6).
 * No React; testable in Node.
 */
import type { HexHistory } from "../core/history.ts";
import type { HexStack } from "../core/schema.ts";
import { validateStack } from "../core/stackValidator.ts";
import type { HexStore } from "../core/store.ts";
import { clearDecodedLayerCache } from "../engine/graphics/bitmapCanvas.ts";
import { decodeBitmapRLE } from "../engine/graphics/rleCodec.ts";

export const DAMAGED_STACK_MESSAGE = "This stack is damaged";

export type CheckStackResult = { ok: true; stack: HexStack } | { ok: false; error: string };

export type LoadStackResult = { ok: true; stack: HexStack } | { ok: false; error: string };

export interface StackLoaderOptions {
  store: Pick<HexStore, "replaceStack">;
  history: Pick<HexHistory, "clear">;
  /**
   * Shows the "This stack is damaged" alert. It is not awaited, so a load during start-up (before
   * the dialogs are mounted) does not wait for the user.
   */
  alert: (message: string, options: { details: readonly string[] }) => unknown;
}

export interface StackLoader {
  /** Loads an untrusted, already parsed value. */
  load(input: unknown): LoadStackResult;
  /** Reads an untrusted value (e.g. decompresses a file), then loads it; a throw while reading rejects it too. */
  loadFrom(read: () => unknown): Promise<LoadStackResult>;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Steps 1 and 2 without side effects: validates `input` and decodes every bitmap layer.
 * Returns the validated stack (sharing no objects with `input`) or the first error.
 */
export function checkStack(input: unknown): CheckStackResult {
  const validated = validateStack(input);
  if (!validated.ok) return validated;
  const { stack } = validated;
  const layers: Array<[path: string, rleData: string, emptyFill: 0 | 1]> = [
    ...stack.backgrounds.map((background, i): [string, string, 0 | 1] => [`backgrounds[${i}].bitmap.rleData`, background.bitmap.rleData, 1]),
    ...stack.cards.map((card, i): [string, string, 0 | 1] => [`cards[${i}].bitmap.rleData`, card.bitmap.rleData, 0]),
  ];
  for (const [path, rleData, emptyFill] of layers) {
    try {
      decodeBitmapRLE(rleData, emptyFill);
    } catch (error) {
      return { ok: false, error: `${path}: ${describe(error)}` };
    }
  }
  return { ok: true, stack };
}

export function createStackLoader({ store, history, alert }: StackLoaderOptions): StackLoader {
  const reject = (error: string): LoadStackResult => {
    alert(DAMAGED_STACK_MESSAGE, { details: [error] });
    return { ok: false, error };
  };

  const load = (input: unknown): LoadStackResult => {
    const checked = checkStack(input);
    if (!checked.ok) return reject(checked.error);
    try {
      history.clear();
      clearDecodedLayerCache();
      store.replaceStack(checked.stack);
    } catch (error) {
      return reject(describe(error));
    }
    return { ok: true, stack: checked.stack };
  };

  return {
    load,
    async loadFrom(read) {
      let input: unknown;
      try {
        input = await read();
      } catch (error) {
        return reject(describe(error));
      }
      return load(input);
    },
  };
}
