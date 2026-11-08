/**
 * Structural authoring commands: New Card, New Background, Delete Card, New Button / New Field and
 * Delete Part, plus the id and default-name rules and the blank stack of File > New Stack.
 * Design: .kiro/specs/05-authoring-loop/design.md §4. Requirements 3.2, 3.3, 4.1, 5.1, 6.1, 6.3,
 * 8.1–8.4, 9.1, 9.2, 10.3–10.5, 13.1–13.3, 14.3.
 *
 * - Every factory fixes ids, names and new objects when it runs, so Redo recreates identical objects
 *   (Requirement 8.4). Removed objects are recorded by `apply` from the stack it receives, so runtime
 *   changes made by script handlers before the commit are part of what Undo restores.
 * - Untouched objects keep their identity (structural sharing); the store freezes the new ones.
 * - `apply` / `revert` on a stack where a precondition fails throw `HexMutationError`, so the history
 *   does not record the command.
 *
 * Pure TypeScript: no React, DOM or `src/engine/` imports.
 */
import type { HexCommand } from "./history.ts";
import {
  THEME_PALETTES,
  type HexBackground,
  type HexButtonPart,
  type HexCard,
  type HexFieldPart,
  type HexID,
  type HexPart,
  type HexRect,
  type HexStack,
  type PartType,
} from "./schema.ts";
import { STACK_HEIGHT, STACK_WIDTH } from "./stackValidator.ts";
import { HexMutationError, type HexLayer, type HexRuntimeState } from "./store.ts";

// ---------------------------------------------------------------------------------------------
// Ids and default names (Requirements 8.1, 8.2, 8.3)
// ---------------------------------------------------------------------------------------------

export type IdPrefix = "stk_" | "bkg_" | "crd_" | "prt_";
export type RandomSource = () => number; // [0, 1); Math.random in production

const ID_SUFFIX_LENGTH = 10;
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** Every id of the stack: stack, backgrounds, cards and parts. */
export function collectIds(stack: HexStack): Set<HexID> {
  const ids = new Set<HexID>([stack.id]);
  for (const owner of [...stack.backgrounds, ...stack.cards]) {
    ids.add(owner.id);
    for (const part of owner.parts) ids.add(part.id);
  }
  return ids;
}

/** `prefix` + 10 base-36 characters, drawn again until it is not in `taken` (Requirement 8.3). */
export function createId(prefix: IdPrefix, taken: ReadonlySet<HexID>, random: RandomSource = Math.random): HexID {
  for (;;) {
    let id = prefix;
    for (let i = 0; i < ID_SUFFIX_LENGTH; i++) {
      const index = Math.min(BASE36.length - 1, Math.max(0, Math.floor(random() * BASE36.length)));
      id += BASE36[index];
    }
    if (!taken.has(id)) return id;
  }
}

function lowestFreeName(base: string, first: number, taken: Iterable<string>, separator: string): string {
  const used = new Set<string>();
  for (const name of taken) used.add(name.toLowerCase());
  for (let n = first; ; n++) {
    const candidate = `${base}${separator}${n}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

/** "Card N" / "Background N", lowest free N >= 1, case-insensitive (Requirement 8.1). */
export function numberedName(base: "Card" | "Background", taken: Iterable<string>): string {
  return lowestFreeName(base, 1, taken, " ");
}

/** "New Button", then "New Button 2", ... case-insensitive (Requirement 8.2). */
export function partName(base: "New Button" | "New Field", taken: Iterable<string>): string {
  const names = [...taken];
  if (!names.some((name) => name.toLowerCase() === base.toLowerCase())) return base;
  return lowestFreeName(base, 2, names, " ");
}

// ---------------------------------------------------------------------------------------------
// Blank stack and Delete Card rule (Requirements 3.2, 3.3, 6.1)
// ---------------------------------------------------------------------------------------------

function emptyBitmap() {
  return { width: STACK_WIDTH, height: STACK_HEIGHT, rleData: "" };
}

function newCardObject(id: HexID, name: string, backgroundId: HexID): HexCard {
  return {
    id,
    name,
    backgroundId,
    bitmap: emptyBitmap(),
    parts: [],
    bgFieldContents: {},
    marked: false,
    cantDelete: false,
    dontSearch: false,
    scriptSource: "",
  };
}

function newBackgroundObject(id: HexID, name: string): HexBackground {
  return { id, name, bitmap: emptyBitmap(), parts: [], scriptSource: "", cantDelete: false };
}

/** File > New Stack (Requirements 3.2, 3.3). */
export function createBlankStack(options: { now?: Date; random?: RandomSource } = {}): HexStack {
  const timestamp = (options.now ?? new Date()).toISOString();
  const random = options.random ?? Math.random;
  const taken = new Set<HexID>();
  const stackId = createId("stk_", taken, random);
  taken.add(stackId);
  const backgroundId = createId("bkg_", taken, random);
  taken.add(backgroundId);
  const cardId = createId("crd_", taken, random);
  return {
    id: stackId,
    schemaVersion: "2.0.0",
    name: "Untitled",
    author: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    dimensions: { width: STACK_WIDTH, height: STACK_HEIGHT },
    themePalette: { name: "ClassicPaper", ...THEME_PALETTES.ClassicPaper },
    backgrounds: [newBackgroundObject(backgroundId, "Background 1")],
    cards: [newCardObject(cardId, "Card 1", backgroundId)],
    customIcons: {},
    scriptSource: "",
  };
}

/**
 * Requirement 6.1: more than one card, the card's cantDelete is false, and the card is not the only
 * card of a background whose cantDelete is true.
 */
export function canDeleteCard(stack: HexStack, cardId: HexID): boolean {
  if (stack.cards.length < 2) return false;
  const card = stack.cards.find((candidate) => candidate.id === cardId);
  if (!card || card.cantDelete) return false;
  const onlyCardOfBackground = !stack.cards.some((other) => other.id !== card.id && other.backgroundId === card.backgroundId);
  if (!onlyCardOfBackground) return true;
  const background = stack.backgrounds.find((candidate) => candidate.id === card.backgroundId);
  return background !== undefined && !background.cantDelete;
}

// ---------------------------------------------------------------------------------------------
// Array helpers
// ---------------------------------------------------------------------------------------------

function insertAt<T>(items: readonly T[], index: number, item: T): T[] {
  const copy = items.slice();
  copy.splice(Math.min(Math.max(index, 0), copy.length), 0, item);
  return copy;
}

function cardIndexOf(stack: HexStack, cardId: HexID): number {
  const index = stack.cards.findIndex((card) => card.id === cardId);
  if (index < 0) throw new HexMutationError(`No card with id "${cardId}"`);
  return index;
}

function requireBackground(stack: HexStack, backgroundId: HexID): HexBackground {
  const background = stack.backgrounds.find((candidate) => candidate.id === backgroundId);
  if (!background) throw new HexMutationError(`No background with id "${backgroundId}"`);
  return background;
}

function requireAbsent(stack: HexStack, ids: readonly HexID[]): void {
  const taken = collectIds(stack);
  for (const id of ids) {
    if (taken.has(id)) throw new HexMutationError(`Id "${id}" is already used in the stack`);
  }
}

// ---------------------------------------------------------------------------------------------
// New Card, New Background, Delete Card (Requirements 4.1, 5.1, 6.1, 6.3)
// ---------------------------------------------------------------------------------------------

export interface CardChangeCommand extends HexCommand {
  readonly cardId: HexID;          // the card that is current after apply
  readonly backgroundId: HexID;    // its background
}

export function createNewCardCommand(stack: HexStack, currentCardId: HexID, random?: RandomSource): CardChangeCommand {
  const current = stack.cards[cardIndexOf(stack, currentCardId)];
  requireBackground(stack, current.backgroundId);
  const cardId = createId("crd_", collectIds(stack), random);
  const card = newCardObject(cardId, numberedName("Card", stack.cards.map((c) => c.name)), current.backgroundId);

  return {
    label: "New Card",
    cardId,
    backgroundId: card.backgroundId,
    apply(target) {
      requireAbsent(target, [cardId]);
      requireBackground(target, card.backgroundId);
      const index = cardIndexOf(target, currentCardId);
      return { ...target, cards: insertAt(target.cards, index + 1, card) };
    },
    revert(target) {
      cardIndexOf(target, cardId);
      return { ...target, cards: target.cards.filter((c) => c.id !== cardId) };
    },
    currentCardAfter: (step) => (step === "apply" ? cardId : currentCardId),
  };
}

export function createNewBackgroundCommand(stack: HexStack, currentCardId: HexID, random?: RandomSource): CardChangeCommand {
  cardIndexOf(stack, currentCardId);
  const taken = collectIds(stack);
  const backgroundId = createId("bkg_", taken, random);
  taken.add(backgroundId);
  const cardId = createId("crd_", taken, random);
  const background = newBackgroundObject(backgroundId, numberedName("Background", stack.backgrounds.map((b) => b.name)));
  const card = newCardObject(cardId, numberedName("Card", stack.cards.map((c) => c.name)), backgroundId);

  return {
    label: "New Background",
    cardId,
    backgroundId,
    apply(target) {
      requireAbsent(target, [backgroundId, cardId]);
      const index = cardIndexOf(target, currentCardId);
      return {
        ...target,
        backgrounds: [...target.backgrounds, background],
        cards: insertAt(target.cards, index + 1, card),
      };
    },
    revert(target) {
      requireBackground(target, backgroundId);
      cardIndexOf(target, cardId);
      return {
        ...target,
        backgrounds: target.backgrounds.filter((b) => b.id !== backgroundId),
        cards: target.cards.filter((c) => c.id !== cardId),
      };
    },
    currentCardAfter: (step) => (step === "apply" ? cardId : currentCardId),
  };
}

/** Throws HexMutationError unless canDeleteCard. `cardId` / `backgroundId` name the destination card. */
export function createDeleteCardCommand(
  stack: HexStack,
  cardId: HexID,
): CardChangeCommand & { readonly removesBackground: boolean } {
  if (!canDeleteCard(stack, cardId)) throw new HexMutationError(`Card "${cardId}" cannot be deleted`);
  const index = cardIndexOf(stack, cardId);
  const destination = stack.cards[index + 1] ?? stack.cards[index - 1];
  const deletedBackgroundId = stack.cards[index].backgroundId;
  const removesBackground = !stack.cards.some((c) => c.id !== cardId && c.backgroundId === deletedBackgroundId);

  let removed: { card: HexCard; cardIndex: number; background?: HexBackground; backgroundIndex?: number } | undefined;

  return {
    label: "Delete Card",
    cardId: destination.id,
    backgroundId: destination.backgroundId,
    removesBackground,
    apply(target) {
      const cardIndex = cardIndexOf(target, cardId);
      if (target.cards.length < 2) throw new HexMutationError("The last card of a stack cannot be deleted");
      if (!target.cards.some((c) => c.id === destination.id)) {
        throw new HexMutationError(`No destination card with id "${destination.id}"`);
      }
      const card = target.cards[cardIndex];
      const record: NonNullable<typeof removed> = { card, cardIndex };
      let backgrounds = target.backgrounds;
      // Requirement 6.3: the background goes with its last card.
      if (!target.cards.some((c) => c.id !== cardId && c.backgroundId === card.backgroundId)) {
        const backgroundIndex = target.backgrounds.findIndex((b) => b.id === card.backgroundId);
        if (backgroundIndex >= 0) {
          record.background = target.backgrounds[backgroundIndex];
          record.backgroundIndex = backgroundIndex;
          backgrounds = target.backgrounds.filter((b) => b.id !== card.backgroundId);
        }
      }
      removed = record;
      return { ...target, backgrounds, cards: target.cards.filter((c) => c.id !== cardId) };
    },
    revert(target) {
      if (!removed) throw new HexMutationError("Delete Card has not been applied");
      const { card, cardIndex, background, backgroundIndex } = removed;
      requireAbsent(target, [card.id]);
      let backgrounds = target.backgrounds;
      if (background && backgroundIndex !== undefined) {
        requireAbsent(target, [background.id]);
        backgrounds = insertAt(backgrounds, backgroundIndex, background);
      } else {
        requireBackground(target, card.backgroundId);
      }
      return { ...target, backgrounds, cards: insertAt(target.cards, cardIndex, card) };
    },
    currentCardAfter: (step) => (step === "apply" ? destination.id : cardId),
  };
}

// ---------------------------------------------------------------------------------------------
// New Button / New Field / Delete Part (Requirements 9.1, 9.2, 10.3, 10.4)
// ---------------------------------------------------------------------------------------------

export const NEW_BUTTON_RECT: HexRect = { x: 196, y: 159, width: 120, height: 24 };
export const NEW_FIELD_RECT: HexRect = { x: 176, y: 147, width: 160, height: 48 };

export interface NewPartCommand extends HexCommand {
  readonly partId: HexID;
  readonly partType: PartType;
  readonly layer: HexLayer;
}

type PartState = Pick<HexRuntimeState, "stack" | "currentCardId" | "editLayer">;

interface PartOwner {
  layer: HexLayer;
  ownerId: HexID;
  parts: readonly HexPart[];
}

/** The edit target of `state`: the current card, or its background in Edit Background mode. */
function resolvePartOwner(state: PartState): PartOwner {
  const card = state.stack.cards[cardIndexOf(state.stack, state.currentCardId)];
  if (state.editLayer === "card") return { layer: "card", ownerId: card.id, parts: card.parts };
  const background = requireBackground(state.stack, card.backgroundId);
  return { layer: "background", ownerId: background.id, parts: background.parts };
}

/** Replaces the parts of the card or background `ownerId`; throws when it does not exist. */
function withOwnerParts(
  stack: HexStack,
  layer: HexLayer,
  ownerId: HexID,
  update: (parts: readonly HexPart[]) => HexPart[],
): HexStack {
  if (layer === "card") {
    const index = cardIndexOf(stack, ownerId);
    const card = stack.cards[index];
    const cards = stack.cards.slice();
    cards[index] = { ...card, parts: update(card.parts) };
    return { ...stack, cards };
  }
  requireBackground(stack, ownerId);
  return {
    ...stack,
    backgrounds: stack.backgrounds.map((b) => (b.id === ownerId ? { ...b, parts: update(b.parts) } : b)),
  };
}

function buildButton(id: HexID, name: string, layer: HexLayer): HexButtonPart {
  return {
    id,
    name,
    type: "button",
    layerScope: layer,
    rect: { ...NEW_BUTTON_RECT },
    visible: true,
    enabled: true,
    scriptSource: "",
    style: "roundRect",
    title: name,
    showName: true,
    autoHilite: true,
    hilite: false,
  };
}

function buildField(id: HexID, name: string, layer: HexLayer): HexFieldPart {
  return {
    id,
    name,
    type: "field",
    layerScope: layer,
    rect: { ...NEW_FIELD_RECT },
    visible: true,
    enabled: true,
    scriptSource: "",
    style: "rectangle",
    content: "",
    sharedText: false,
    lockText: false,
    dontWrap: false,
    showLines: false,
    textAlign: "left",
    textFont: "Sans",
    textSize: 12,
    textStyle: [],
  };
}

export function createNewPartCommand(state: PartState, type: PartType, random?: RandomSource): NewPartCommand {
  const owner = resolvePartOwner(state);
  const partId = createId("prt_", collectIds(state.stack), random);
  const sameType = owner.parts.filter((part) => part.type === type).map((part) => part.name);
  const part = type === "button"
    ? buildButton(partId, partName("New Button", sameType), owner.layer)
    : buildField(partId, partName("New Field", sameType), owner.layer);
  const { currentCardId } = state;

  return {
    label: type === "button" ? "New Button" : "New Field",
    partId,
    partType: type,
    layer: owner.layer,
    apply(target) {
      requireAbsent(target, [partId]);
      return withOwnerParts(target, owner.layer, owner.ownerId, (parts) => [...parts, part]);
    },
    revert(target) {
      return withOwnerParts(target, owner.layer, owner.ownerId, (parts) => {
        if (!parts.some((p) => p.id === partId)) throw new HexMutationError(`No part with id "${partId}"`);
        return parts.filter((p) => p.id !== partId);
      });
    },
    currentCardAfter: () => currentCardId,
  };
}

export function createDeletePartCommand(state: PartState, partId: HexID): HexCommand {
  const owner = resolvePartOwner(state);
  if (!owner.parts.some((part) => part.id === partId)) {
    throw new HexMutationError(`No part with id "${partId}" on the ${owner.layer} edit target`);
  }
  const { currentCardId } = state;

  let removed: { part: HexPart; index: number; contents: Array<[cardId: HexID, text: string]> } | undefined;

  return {
    label: "Delete Part",
    apply(target) {
      let record: NonNullable<typeof removed> | undefined;
      const withoutPart = withOwnerParts(target, owner.layer, owner.ownerId, (parts) => {
        const index = parts.findIndex((p) => p.id === partId);
        if (index < 0) throw new HexMutationError(`No part with id "${partId}"`);
        record = { part: parts[index], index, contents: [] };
        return parts.filter((p) => p.id !== partId);
      });
      if (!record) throw new HexMutationError(`No part with id "${partId}"`);
      let result = withoutPart;
      // Requirement 10.4: a background field takes its per-card text with it.
      if (record.part.type === "field" && owner.layer === "background") {
        const contents = record.contents;
        result = {
          ...withoutPart,
          cards: withoutPart.cards.map((card) => {
            if (!Object.hasOwn(card.bgFieldContents, partId)) return card;
            contents.push([card.id, card.bgFieldContents[partId]]);
            return {
              ...card,
              bgFieldContents: Object.fromEntries(Object.entries(card.bgFieldContents).filter(([key]) => key !== partId)),
            };
          }),
        };
      }
      removed = record;
      return result;
    },
    revert(target) {
      if (!removed) throw new HexMutationError("Delete Part has not been applied");
      const { part, index, contents } = removed;
      requireAbsent(target, [part.id]);
      const restored = withOwnerParts(target, owner.layer, owner.ownerId, (parts) => insertAt(parts, index, part));
      if (contents.length === 0) return restored;
      const texts = new Map(contents);
      return {
        ...restored,
        cards: restored.cards.map((card) => {
          const text = texts.get(card.id);
          return text === undefined ? card : { ...card, bgFieldContents: { ...card.bgFieldContents, [partId]: text } };
        }),
      };
    },
    currentCardAfter: () => currentCardId,
  };
}
