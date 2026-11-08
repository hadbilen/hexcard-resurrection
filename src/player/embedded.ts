/**
 * How a stack is embedded in an exported standalone HTML file (spec 04 Requirements 6.2, 6.3;
 * design.md §6). Shared by the exporter (`storage/htmlExporter.ts`, writes) and the player
 * (`player/main.ts`, reads), so both agree on the element id and the escaping.
 *
 * The stack JSON sits in `<script type="application/json" id="hexstack">`. Every `<` is written as
 * the JSON escape `\u003c`, so the data can never contain `</script>` or `<!--` and close or
 * confuse the element (steering tech.md, Security Guardrails 6). `JSON.parse` turns the escape back
 * into `<`, so the stack round-trips exactly.
 *
 * No DOM access: testable in Node.
 */
import type { HexStack } from "../core/schema.ts";
import { checkStack, type CheckStackResult } from "../storage/stackLoader.ts";

export const EMBEDDED_STACK_ELEMENT_ID = "hexstack";
export const EMBEDDED_STACK_MIME_TYPE = "application/json";

/** The stack as JSON text that is safe inside a `<script>` element: every `<` is `\u003c`. */
export function serializeEmbeddedStack(stack: HexStack): string {
  return JSON.stringify(stack).replace(/</g, "\\u003c");
}

/**
 * Reads the text of the embedded stack element. The stack is untrusted: it goes through the same
 * check as every other load (spec 04 Requirement 5.5, `checkStack`: validator plus a decode of every
 * bitmap layer). A missing element, bad JSON or an invalid stack gives `{ ok: false }`.
 */
export function parseEmbeddedStack(text: string | null | undefined): CheckStackResult {
  if (text === null || text === undefined || text.trim() === "") return { ok: false, error: "The page contains no stack" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `The embedded stack is not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
  return checkStack(value);
}
