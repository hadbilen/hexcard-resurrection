// Reads the `stack` argument and runs the gate (spec 07 Requirements 5.2, 5.3, 6.1, 6.2, 9.1; design
// §stackText.ts). Shared by validate_stack and render_card. Pure TypeScript: no Node module, no DOM.

import type { GateError } from "../core/stackValidator.ts";
import type { HexStack } from "../core/schema.ts";
import { decodeStackPayload } from "../storage/stackFile.ts";
import type { ToolSteps } from "./tools/index.ts";

/** Requirement 5.3: the longest `stack` text, and the limit for the decompressed JSON bytes. */
export const MAX_STACK_TEXT = 4_194_304;

export type GateOutcome =
  | { kind: "readError"; error: string } // "stack: <message>"
  | { kind: "checkError"; error: string } // "stack: The stack could not be checked: <message>" (Requirement 5.4)
  | { kind: "rejected"; errors: GateError[] } // raw gate errors, in gate order
  | { kind: "accepted"; stack: HexStack }; // the stack checkStack would return

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads the stack text (JSON text or `.hexstack` text) and checks the value with the gate.
 * Never throws; the messages are not yet shortened (the tools apply Requirement 5.7).
 */
export async function readAndGate(stackText: string, steps: Pick<ToolSteps, "listStackErrors">): Promise<GateOutcome> {
  if (stackText.length > MAX_STACK_TEXT) {
    return { kind: "readError", error: `stack: The stack text has more than ${MAX_STACK_TEXT} characters` };
  }
  // String.prototype.trim: the white space of Requirement 6.1.
  const trimmed = stackText.trim();
  let value: unknown;
  if (trimmed.startsWith("{")) {
    try {
      value = JSON.parse(trimmed);
    } catch (error) {
      return { kind: "readError", error: `stack: The stack is not valid JSON: ${messageOf(error)}` };
    }
  } else {
    try {
      value = await decodeStackPayload(trimmed, MAX_STACK_TEXT);
    } catch (error) {
      return { kind: "readError", error: `stack: ${messageOf(error)}` };
    }
  }

  try {
    const report = steps.listStackErrors(value);
    if (report.errors.length > 0) return { kind: "rejected", errors: report.errors };
    if (report.stack === null) throw new Error("listStackErrors returned neither an error nor a stack");
    return { kind: "accepted", stack: report.stack };
  } catch (error) {
    return { kind: "checkError", error: `stack: The stack could not be checked: ${messageOf(error)}` };
  }
}
