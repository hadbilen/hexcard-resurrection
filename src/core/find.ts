/**
 * Find (spec 06 Requirement 4): word-start matching and the next-match search over the cards and
 * fields of a stack. Design: .kiro/specs/06-hypercard-classics/design.md §find.ts.
 *
 * - A match is an occurrence of the whole search text, compared case-insensitively with the
 *   locale-independent `toLowerCase`, that starts at the start of a word (Requirement 4.5).
 * - Matches are ordered by (card index, field order, start index); the search goes to the first
 *   match after the found text, or at or after the start of the current card, and wraps around
 *   (Requirement 4.6).
 *
 * Pure TypeScript: no React, no DOM. Reads the stack only; it never changes it (Requirement 4.12).
 */
import type { HexCard, HexFieldPart, HexID, HexStack } from "./schema.ts";
import type { FoundText, HexLayer } from "./store.ts";

export interface FindMatch {
  cardId: HexID;
  layer: HexLayer;
  partId: HexID;
  start: number;
  end: number;
}

const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

/**
 * Requirement 4.5: `index` is 0, or the code point before it is not a Unicode letter or digit.
 * An index between the two halves of a surrogate pair is never a word start.
 */
export function isWordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  if (index < 0 || index > text.length) return false;
  const before = text.charCodeAt(index - 1);
  if (isHighSurrogate(before) && index < text.length && isLowSurrogate(text.charCodeAt(index))) return false;
  const from = isLowSurrogate(before) && index >= 2 && isHighSurrogate(text.charCodeAt(index - 2)) ? index - 2 : index - 1;
  const previous = String.fromCodePoint(text.codePointAt(from)!);
  return !LETTER_OR_DIGIT.test(previous);
}

/** Start indexes of every match of `needle` in `text` (Requirement 4.5), ascending; [] for an empty needle. */
export function matchStarts(text: string, needle: string): number[] {
  if (needle === "") return [];
  const wanted = needle.toLowerCase();
  const starts: number[] = [];
  for (let i = 0; i + needle.length <= text.length; i++) {
    if (isWordStart(text, i) && text.slice(i, i + needle.length).toLowerCase() === wanted) starts.push(i);
  }
  return starts;
}

export interface SearchableField {
  layer: HexLayer;
  part: HexFieldPart;
  text: string;
}

/**
 * Requirement 4.4: the searchable fields of one card in search order: none on a `dontSearch` card;
 * otherwise the visible background fields in the order of the background's `parts`, then the
 * card's visible fields in the order of its `parts`. A background field reads
 * `sharedText ? content : bgFieldContents[id] ?? ""`.
 */
export function searchableFields(stack: HexStack, card: HexCard): SearchableField[] {
  if (card.dontSearch) return [];
  const result: SearchableField[] = [];
  const background = stack.backgrounds.find((candidate) => candidate.id === card.backgroundId);
  for (const part of background?.parts ?? []) {
    if (part.type !== "field" || !part.visible) continue;
    const text = part.sharedText
      ? part.content
      : Object.hasOwn(card.bgFieldContents, part.id) ? card.bgFieldContents[part.id] : "";
    result.push({ layer: "background", part, text });
  }
  for (const part of card.parts) {
    if (part.type === "field" && part.visible) result.push({ layer: "card", part, text: part.content });
  }
  return result;
}

/** (card index, field order, start): the order of Requirement 4.6. */
type MatchKey = readonly [number, number, number];

function compareKeys(a: MatchKey, b: MatchKey): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** The order key of the found text, or null when its field is no longer searchable. */
function foundKey(stack: HexStack, found: FoundText): MatchKey | null {
  const cardIndex = stack.cards.findIndex((card) => card.id === found.cardId);
  if (cardIndex < 0) return null;
  const fieldIndex = searchableFields(stack, stack.cards[cardIndex])
    .findIndex((field) => field.layer === found.layer && field.part.id === found.partId);
  return fieldIndex < 0 ? null : [cardIndex, fieldIndex, found.start];
}

/**
 * Requirement 4.6: the first match strictly after `found`, or, without a (still searchable) found
 * text, the first match at or after the start of the current card; when nothing follows, the
 * first match of the whole stack (wrap-around). Null when the stack has no match at all.
 */
export function findNext(stack: HexStack, currentCardId: HexID, found: FoundText | null, needle: string): FindMatch | null {
  if (needle === "") return null;
  const after = found ? foundKey(stack, found) : null;
  const currentIndex = Math.max(0, stack.cards.findIndex((card) => card.id === currentCardId));
  const from: MatchKey = after ?? [currentIndex, 0, 0];
  let first: FindMatch | null = null;
  for (let cardIndex = 0; cardIndex < stack.cards.length; cardIndex++) {
    const card = stack.cards[cardIndex];
    const fields = searchableFields(stack, card);
    for (let fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
      const { layer, part, text } = fields[fieldIndex];
      for (const start of matchStarts(text, needle)) {
        const match: FindMatch = { cardId: card.id, layer, partId: part.id, start, end: start + needle.length };
        first ??= match;
        const order = compareKeys([cardIndex, fieldIndex, start], from);
        if (after ? order > 0 : order >= 0) return match;
      }
    }
  }
  return first;
}
