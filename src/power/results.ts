// Result shapes, list cap and quoting of argument text (spec 07 Requirements 5.6, 5.7; design §results.ts).
// Pure TypeScript: no Node module, no DOM.

import { formatGateError, type GateError } from "../core/stackValidator.ts";

/** Requirement 5.6: a result list shows at most this many entries. */
export const LIST_LIMIT = 100;
/** Requirement 5.7: at most this many consecutive characters of an argument in a message. */
export const QUOTE_LIMIT = 80;

const ELLIPSIS = "...";

/**
 * Requirement 5.7 for text the tool quotes itself: whole when <= 80 characters, else the first 77
 * characters followed by "...". Characters are UTF-16 code units.
 */
export function quoteText(text: string): string {
  return text.length <= QUOTE_LIMIT ? text : text.slice(0, QUOTE_LIMIT - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Requirement 5.7 for messages other than gate errors that embed argument text (read errors, parser
 * messages, refusal reasons, thrown errors): (1) the inner text of every "..." pair longer than 80
 * characters becomes quoteText(inner); (2) then every run of more than 80 characters without white
 * space or '"' becomes quoteText(run). The other text is unchanged.
 */
export function shortenMessage(message: string): string {
  const quoted = message.replace(/"([^"]*)"/g, (pair, inner: string) =>
    inner.length > QUOTE_LIMIT ? `"${quoteText(inner)}"` : pair,
  );
  // {81,} is QUOTE_LIMIT + 1; a literal keeps the pattern fixed.
  return quoted.replace(/[^\s"]{81,}/g, (run) => quoteText(run));
}

/** Requirements 5.7 and 6.4 for gate errors: formatGateError(error, quoteText). */
export function shortenGateError(error: GateError): string {
  return formatGateError(error, quoteText);
}

/** `{ [key]: first 100 items, [key + "NotShown"]: rest }`; the count key only when items > 100. */
export function cappedList<T>(key: string, items: readonly T[]): Record<string, T[] | number> {
  if (items.length <= LIST_LIMIT) return { [key]: [...items] };
  return { [key]: items.slice(0, LIST_LIMIT), [`${key}NotShown`]: items.length - LIST_LIMIT };
}

export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" };

export interface CallToolResult {
  content: ToolContent[];
  isError: boolean;
}

/** Standard Base64 with padding, through `btoa` (a global in Node 16+ and in browsers). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** A result (isError false): the payload's JSON text, then the PNG as image content when given. */
export function toolResult(payload: Record<string, unknown>, png?: Uint8Array): CallToolResult {
  const content: ToolContent[] = [{ type: "text", text: JSON.stringify(payload) }];
  if (png !== undefined) content.push({ type: "image", data: bytesToBase64(png), mimeType: "image/png" });
  return { content, isError: false };
}

/**
 * An error result (isError true): `{ ok: false, errors, errorsNotShown? }`. The entries are written
 * as given; callers shorten them (Requirement 5.7) before they pass them in.
 */
export function errorResult(errors: readonly string[]): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify({ ok: false, ...cappedList("errors", errors) }) }],
    isError: true,
  };
}
