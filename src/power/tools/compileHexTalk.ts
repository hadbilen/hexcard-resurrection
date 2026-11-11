// compile_hextalk (spec 07 Requirement 7; design §tools/compileHexTalk.ts). Parses and prints a
// script and never runs it. Pure TypeScript: no Node module, no DOM.

import { printHexTalk } from "../../core/parser.ts";
import { cappedList, errorResult, shortenMessage, toolResult, type CallToolResult } from "../results.ts";
import type { ToolSteps } from "./index.ts";

/** Requirement 5.3: the longest `source`. */
export const MAX_SOURCE_LENGTH = 65_536;

export async function runCompileHexTalk(args: Record<string, unknown>, steps: Pick<ToolSteps, "parseHexTalk">): Promise<CallToolResult> {
  let parsed: ReturnType<ToolSteps["parseHexTalk"]>;
  try {
    // Requirement 7.1: the untouched source, so every line and column refers to the text sent.
    parsed = steps.parseHexTalk(args.source as string);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorResult([shortenMessage(`source: The script could not be compiled: ${message}`)]);
  }

  const { ast, errors } = parsed;
  // The parser inserts handlers in source order and their names start with a letter, so the key order is source order.
  const handlers = Object.values(ast.handlers).map((handler) => handler.eventName);
  if (errors.length > 0) {
    return toolResult({
      ok: false,
      ...cappedList(
        "compileErrors",
        errors.map((e) => ({ line: e.line, column: e.column, message: shortenMessage(e.message) })),
      ),
      handlers,
      notes: [],
    });
  }
  return toolResult({
    ok: true,
    canonical: printHexTalk(ast),
    handlers,
    notes: handlers.length === 0 ? ["The script has no handlers."] : [],
  });
}
