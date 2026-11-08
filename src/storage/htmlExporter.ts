/**
 * Standalone HTML export (spec 04 Requirements 6.1, 6.2; design.md §6): one `.html` file that holds
 * the browse-only player bundle (`dist-player/player.js`, built by `vite.player.config.ts` before
 * the studio build) and the stack JSON, and makes no requests of its own. The only network access
 * a running exported stack has is the stack's own `fetch` commands.
 *
 * ~~~html
 * <!doctype html><html><head><meta charset="utf-8"><title>{escaped stack name}</title></head>
 * <body><script type="application/json" id="hexstack">{stack JSON, every "<" as \u003c}</script>
 * <script>{player bundle}</script></body></html>
 * ~~~
 *
 * Escaping: the stack JSON by `serializeEmbeddedStack`; the stack name in `<title>` as HTML text;
 * the player bundle cannot contain a literal `</script` or `<!--` either (they are rewritten to the
 * equivalent `<\/script` and `<\!--`, which only occur inside string and regular-expression
 * literals of minified code, where the backslash is an identity escape). The file never reaches the
 * DOM through `innerHTML`: it is a string that the browser parses when the user opens it.
 *
 * Pure: the player source is a parameter. This module never imports `dist-player`; the File menu
 * command reads the built bundle lazily from the virtual module `virtual:hexcard-player` (see
 * `vite.config.ts`), so tests and `npm run dev` work without a player build.
 */
import type { HexStack } from "../core/schema.ts";
import { EMBEDDED_STACK_ELEMENT_ID, EMBEDDED_STACK_MIME_TYPE, serializeEmbeddedStack } from "../player/embedded.ts";
import { STACK_FILE_EXTENSION, stackFileName } from "./stackFile.ts";

export const HTML_FILE_EXTENSION = ".html";
export const HTML_MIME_TYPE = "text/html";

/** Escapes `text` for use as HTML text content or a quoted attribute value. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** `source` made safe to place inside a `<script>` element without changing what it does. */
export function escapeScriptText(source: string): string {
  return source.replace(/<\/(script)/gi, "<\\/$1").replace(/<!--/g, "<\\!--");
}

/** The HTML document for `stack` around the given player bundle source. */
export function renderStandaloneHtml(stack: HexStack, player: string): string {
  return [
    `<!doctype html><html><head><meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<title>${escapeHtml(stack.name)}</title></head>`,
    `<body><script type="${EMBEDDED_STACK_MIME_TYPE}" id="${EMBEDDED_STACK_ELEMENT_ID}">${serializeEmbeddedStack(stack)}</script>`,
    `<script>${escapeScriptText(player)}</script></body></html>`,
    ``,
  ].join("\n");
}

/** `<stack name>.html`, named like the `.hexstack` file of the same stack. */
export function htmlFileName(stack: Pick<HexStack, "name">): string {
  return `${stackFileName(stack).slice(0, -STACK_FILE_EXTENSION.length)}${HTML_FILE_EXTENSION}`;
}
