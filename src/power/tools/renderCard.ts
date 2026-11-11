// render_card (spec 07 Requirements 9 and 10; design §tools/renderCard.ts). Reads the stack text
// and runs the studio's gate as validate_stack does, picks a card, composes its frame with the
// studio's compositor and part renderer on the Node text backend, and returns a JSON summary plus
// a 1-bit PNG. It runs no script. Pure TypeScript: no Node module, no DOM (the PNG encoder is
// png.ts).
import type { HexCard, HexPart, HexStack } from "../../core/schema.ts";
import { readFieldText } from "../../core/store.ts";
import { clearDecodedLayerCache, composeFrame } from "../../engine/graphics/bitmapCanvas.ts";
import { BUTTON_TEXT, clearIconCache, createPartRasterizer } from "../../engine/graphics/partRenderer.ts";
import { cssFontString } from "../../engine/graphics/textRaster.ts";
import { createNodeTextBackend, uncoveredCharacters, type ParsedFaces } from "../nodeTextBackend.ts";
import { encodeFramePng } from "../png.ts";
import { cappedList, errorResult, quoteText, shortenGateError, shortenMessage, toolResult, type CallToolResult } from "../results.ts";
import { readAndGate } from "../stackText.ts";
import type { ToolSteps } from "./index.ts";
/** Requirement 5.3: the `card` argument as a position, 1 to this value. */
export const MAX_CARD_POSITION = 100_000;
/** Requirement 5.3: the `card` argument as a string, at most this many characters. */
export const MAX_CARD_SELECTOR = 256;
/** Requirement 10.5: stated once for every listed part, so the listed characters are not a surprise. */
export const UNCOVERED_NOTE =
  "The studio draws each listed character with a system fallback font, so the studio's pixels of each listed part can differ from this preview.";
type TextSource = "cardContent" | "sharedBackgroundContent" | "cardBgFieldContents";
interface PartSummary {
  path: string;
  layer: "background" | "card";
  type: "button" | "field";
  id: string;
  name: string;
  rect: { x: number; y: number; width: number; height: number };
  style: string;
  hidden: boolean;
  disabled: boolean;
  outsideCard: boolean;
  title?: string;
  iconId?: string;
  text?: string;
  textLength?: number;
  textSource?: TextSource;
}
/** Requirement 9.2: no `card` is the first card; an integer is a 1-based position; a string is an id, else a lower-cased name. */
function pickCard(stack: HexStack, selector: unknown): HexCard | undefined {
  if (selector === undefined) return stack.cards[0];
  if (typeof selector === "number") return stack.cards[selector - 1];
  const text = selector as string;
  return stack.cards.find((card) => card.id === text) ?? stack.cards.find((card) => card.name.toLowerCase() === text.toLowerCase());
}
function summarizePart(stack: HexStack, card: HexCard, part: HexPart, path: string): PartSummary {
  const { x, y, width, height } = part.rect;
  const summary: PartSummary = {
    path,
    layer: part.layerScope,
    type: part.type,
    id: quoteText(part.id),
    name: quoteText(part.name),
    rect: { x, y, width, height },
    style: part.style,
    hidden: !part.visible,
    disabled: !part.enabled,
    outsideCard: x < 0 || y < 0 || x + width > 512 || y + height > 342,
  };
  if (part.type === "button") {
    if (part.showName) summary.title = quoteText(part.title);
    if (part.iconId !== undefined) summary.iconId = quoteText(part.iconId);
  } else {
    const text = readFieldText(stack, card.id, part.layerScope, part.id);
    summary.text = quoteText(text);
    summary.textLength = text.length;
    summary.textSource =
      part.layerScope === "card" ? "cardContent" : part.sharedText ? "sharedBackgroundContent" : "cardBgFieldContents";
  }
  return summary;
}
export async function runRenderCard(
  args: Record<string, unknown>,
  steps: Pick<ToolSteps, "listStackErrors">,
  faces: ParsedFaces,
): Promise<CallToolResult> {
  try {
    const outcome = await readAndGate(args.stack as string, steps);
    if (outcome.kind === "readError" || outcome.kind === "checkError") return errorResult([shortenMessage(outcome.error)]);
    if (outcome.kind === "rejected") return errorResult(outcome.errors.map(shortenGateError));
    const { stack } = outcome;
    const selector = args.card;
    const card = pickCard(stack, selector);
    if (card === undefined) {
      const shown = typeof selector === "number" ? String(selector) : `"${quoteText(selector as string)}"`;
      return errorResult([`card: no card matches ${shown}; the stack has ${stack.cards.length} cards`]);
    }
    const scale = (args.scale ?? 1) as 1 | 2;
    const backend = createNodeTextBackend(faces);
    const frame = composeFrame(stack, card.id, {}, createPartRasterizer({ textBackend: backend }));
    const png = encodeFramePng(frame, scale, stack.themePalette);
    const background = stack.backgrounds.find((candidate) => candidate.id === card.backgroundId)!;
    // Drawing order: the background's parts, then the card's parts (Requirement 9.6).
    const backgroundIndex = stack.backgrounds.indexOf(background);
    const cardIndex = stack.cards.indexOf(card);
    const parts: PartSummary[] = [];
    const uncovered: { path: string; character: string }[] = [];
    const visit = (list: readonly HexPart[], owner: string): void => {
      list.forEach((part, i) => {
        const path = `${owner}.parts[${i}]`;
        parts.push(summarizePart(stack, card, part, path));
        if (!part.visible) return; // hidden parts are not drawn, so no character of theirs is
        // The text the part renderer draws, in the font string the renderer builds (Requirement 10.5).
        const drawn =
          part.type === "button"
            ? part.showName
              ? { text: part.title, css: cssFontString(BUTTON_TEXT.font, BUTTON_TEXT.size, false) }
              : undefined
            : {
                text: readFieldText(stack, card.id, part.layerScope, part.id),
                css: cssFontString(part.textFont, part.textSize, part.textStyle.includes("bold")),
              };
        if (drawn === undefined) return;
        for (const character of uncoveredCharacters(faces, drawn.text, drawn.css)) uncovered.push({ path, character });
      });
    };
    visit(background.parts, `backgrounds[${backgroundIndex}]`);
    visit(card.parts, `cards[${cardIndex}]`);
    const payload: Record<string, unknown> = {
      ok: true,
      card: { position: cardIndex + 1, count: stack.cards.length, id: quoteText(card.id), name: quoteText(card.name) },
      background: { id: quoteText(background.id), name: quoteText(background.name) },
      cardSize: { width: 512, height: 342 },
      image: { width: 512 * scale, height: 342 * scale, scale, mimeType: "image/png" },
      theme: { name: stack.themePalette.name, lightBitHex: stack.themePalette.lightBitHex, darkBitHex: stack.themePalette.darkBitHex },
      ...cappedList("parts", parts),
      ...cappedList("uncoveredCharacters", uncovered),
    };
    if (uncovered.length > 0) payload.uncoveredNote = UNCOVERED_NOTE;
    return toolResult(payload, png);
  } finally {
    // Requirement 5.5: nothing derived from this call's arguments outlives it, error results included.
    clearDecodedLayerCache();
    clearIconCache();
  }
}
