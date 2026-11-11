// validate_stack (spec 07 Requirement 6; design §tools/validateStack.ts). Reads the stack text,
// runs the studio's gate, and reports script errors and non-canonical layers for an accepted stack.
// Pure TypeScript: no Node module, no DOM.

import type { HexStack } from "../../core/schema.ts";
import { decodeBitmapRLE, encodeBitmapRLE } from "../../engine/graphics/rleCodec.ts";
import { encodeStackFile } from "../../storage/stackFile.ts";
import { cappedList, errorResult, quoteText, shortenGateError, shortenMessage, toolResult, type CallToolResult } from "../results.ts";
import { readAndGate } from "../stackText.ts";
import type { ToolSteps } from "./index.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Every `scriptSource` of the stack with its gate path: the stack, then each background and its parts, then each card and its parts. */
function scriptSources(stack: HexStack): Array<{ path: string; source: string }> {
  const out = [{ path: "scriptSource", source: stack.scriptSource }];
  stack.backgrounds.forEach((background, i) => {
    out.push({ path: `backgrounds[${i}].scriptSource`, source: background.scriptSource });
    background.parts.forEach((part, j) => out.push({ path: `backgrounds[${i}].parts[${j}].scriptSource`, source: part.scriptSource }));
  });
  stack.cards.forEach((card, i) => {
    out.push({ path: `cards[${i}].scriptSource`, source: card.scriptSource });
    card.parts.forEach((part, j) => out.push({ path: `cards[${i}].parts[${j}].scriptSource`, source: part.scriptSource }));
  });
  return out;
}

/** Notes for the layers whose rleData decodes but is not canonical; "" is canonical. Backgrounds before cards. */
function nonCanonicalNotes(stack: HexStack): string[] {
  const layers = [
    ...stack.backgrounds.map((background, i) => ({ path: `backgrounds[${i}].bitmap.rleData`, rleData: background.bitmap.rleData })),
    ...stack.cards.map((card, i) => ({ path: `cards[${i}].bitmap.rleData`, rleData: card.bitmap.rleData })),
  ];
  return layers
    .filter(({ rleData }) => rleData !== "" && encodeBitmapRLE(decodeBitmapRLE(rleData)) !== rleData)
    .map(({ path }) => `${path}: this rleData decodes but is not canonical; replace it with draw_layer output or ""`);
}

export async function runValidateStack(
  args: Record<string, unknown>,
  steps: Pick<ToolSteps, "listStackErrors" | "parseHexTalk">,
): Promise<CallToolResult> {
  const outcome = await readAndGate(args.stack as string, steps);
  if (outcome.kind === "readError" || outcome.kind === "checkError") return errorResult([shortenMessage(outcome.error)]);
  if (outcome.kind === "rejected") {
    return toolResult({ ok: false, ...cappedList("errors", outcome.errors.map(shortenGateError)) });
  }

  const { stack } = outcome;
  const scriptErrors: string[] = [];
  try {
    for (const { path, source } of scriptSources(stack)) {
      for (const error of steps.parseHexTalk(source).errors) {
        scriptErrors.push(`${path} line ${error.line}, column ${error.column}: ${shortenMessage(error.message)}`);
      }
    }
  } catch (error) {
    return errorResult([shortenMessage(`stack: A script in the stack could not be compiled: ${messageOf(error)}`)]);
  }

  const payload: Record<string, unknown> = {
    ok: true,
    errors: [],
    ...cappedList("scriptErrors", scriptErrors),
    ...cappedList("notes", nonCanonicalNotes(stack)),
    stack: { name: quoteText(stack.name), cards: stack.cards.length, backgrounds: stack.backgrounds.length },
  };
  if (args.hexstack === true) payload.hexstack = await encodeStackFile(stack);
  return toolResult(payload);
}
