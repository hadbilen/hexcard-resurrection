// Spec 07 test oracle: `checkStack` of src/storage/stackLoader.ts as it was before spec 07
// (commit 756ad07), calling the pre-spec-07 validateStack of ../../core/__tests__/stackValidatorOracle.ts.
// Do not edit; it pins the pre-spec-07 behaviour of checkStack (Requirement 14.2).
import type { HexStack } from "../../core/schema.ts";
import { decodeBitmapRLE } from "../../engine/graphics/rleCodec.ts";
import { validateStack } from "../../core/__tests__/stackValidatorOracle.ts";

export type CheckStackResult = { ok: true; stack: HexStack } | { ok: false; error: string };

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
