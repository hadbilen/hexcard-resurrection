/**
 * Runtime store: the single owner of the current HexStack.
 * Design: .kiro/specs/01-core-stack-engine/design.md §3. Shared contracts: hexcard_design_spec.md
 * §2.1 (schema), §3.2 rule 9 (state writes), §4.3 (property validity), §5.6 (layer order).
 *
 * - Snapshots are frozen and produced with structural sharing: a change copies only the path from
 *   the root to the changed object, every untouched object keeps its identity.
 * - `applyRuntime` is the runtime write path (VM, Browse-mode typing). It is not undoable and
 *   schedules a debounced auto-save through an injected callback.
 * - Compiled scripts live only in the in-memory ScriptCache; the persisted stack never holds an AST.
 *
 * Pure TypeScript: no React, DOM or storage imports. The compiler and the auto-save sink are injected.
 */
import type { HexCompileError, HexPropertyName, HexScriptAST } from "./ast.ts";
import type {
  AuthoringTool,
  ButtonStyle,
  FieldStyle,
  HexBackground,
  HexBitmapLayer,
  HexButtonPart,
  HexCard,
  HexFieldPart,
  HexID,
  HexPart,
  HexRect,
  HexStack,
} from "./schema.ts";

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export type HexLayer = "card" | "background";

export interface HexRuntimeState {
  stack: HexStack;                 // immutable snapshot; replaced on every change
  currentCardId: HexID;
  editLayer: HexLayer;             // Edit Background mode
  tool: AuthoringTool;
}

export type RuntimeMutation =
  | { type: "setFieldText"; cardId: HexID; layer: HexLayer; partId: HexID; text: string }
  | { type: "setPartProperty"; partId: HexID; property: HexPropertyName; value: string | number | boolean }
  | { type: "setCardProperty"; cardId: HexID; property: "name" | "marked"; value: string | boolean }
  | { type: "setBackgroundProperty"; backgroundId: HexID; property: "name"; value: string }
  | { type: "setStackProperty"; property: "name"; value: string }
  | { type: "goToCard"; cardId: HexID };

/** One ScriptCache entry. A script with compile errors always has an empty AST. */
export interface CompiledScript {
  ast: HexScriptAST;
  errors: HexCompileError[];
}

/** Injected compiler; production passes `parseHexTalk` from parser.ts (spec 02). */
export type ScriptCompiler = (source: string) => CompiledScript;

export interface HexStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HexRuntimeState;
  applyRuntime(m: RuntimeMutation): void;           // not undoable, schedules auto-save
  replaceStack(stack: HexStack): void;              // after validation only; recompiles ScriptCache
  /**
   * Called by every `replaceStack`, after the new snapshot is in place and before `subscribe`
   * listeners are notified. Used by the message bus to clear its back history (Requirement 2.7).
   */
  onReplaceStack(listener: () => void): () => void;
  /**
   * Authoring write path, called only by history.ts (Requirement 4.2). Replaces the stack with an
   * authoring result, recompiles only scripts that changed, notifies listeners and schedules
   * auto-save. Never touches the undo history.
   */
  applyAuthoring(next: HexStack): void;
  getCompiled(objectId: HexID): CompiledScript;
  /** Toggles Edit Background mode (Cmd/Ctrl+B). UI state only: not saved, not undoable. */
  setEditLayer(layer: HexLayer): void;
  /** Selects the current tool. UI state only: not saved, not undoable. */
  setTool(tool: AuthoringTool): void;
}

export interface HexStoreOptions {
  /** Initial stack; must already have passed `validateStack`. */
  stack: HexStack;
  compile: ScriptCompiler;
  /** Receives the latest stack once runtime writes have been quiet for `autoSaveDelayMs`. */
  autoSave?: (stack: HexStack) => void;
  autoSaveDelayMs?: number;
}

export const AUTO_SAVE_DELAY_MS = 500;

/** Thrown when a mutation names a missing object or an invalid property/value. The state is left unchanged. */
export class HexMutationError extends Error {
  override name = "HexMutationError";
}

// ---------------------------------------------------------------------------------------------
// Immutability helpers
// ---------------------------------------------------------------------------------------------

function freeze<T>(value: T): T {
  return Object.freeze(value) as T;
}

function freezeDeep<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeDeep((value as Record<string, unknown>)[key]);
  }
  return value;
}

/**
 * Freezes every not-yet-frozen object of a JSON-like tree. Unlike `freezeDeep` it also descends
 * into frozen objects, because an authoring result may be a frozen copy holding new, unfrozen children.
 */
function freezeTree<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freezeTree((value as Record<string, unknown>)[key]);
  }
  return value;
}

function replaceAt<T>(items: readonly T[], index: number, item: T): T[] {
  const copy = items.slice();
  copy[index] = item;
  return freeze(copy);
}

/** Shallow value equality, enough for the primitives, HexRect and textStyle arrays stored on parts. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  }
  if (typeof a === "object" && a !== null && typeof b === "object" && b !== null) {
    const aKeys = Object.keys(a);
    const bRecord = b as Record<string, unknown>;
    return aKeys.length === Object.keys(b).length
      && aKeys.every((key) => Object.is((a as Record<string, unknown>)[key], bRecord[key]));
  }
  return false;
}

/** Returns `obj` itself when the value is unchanged, so no-op writes keep the snapshot identity. */
function withProp<T extends object, K extends keyof T>(obj: T, key: K, value: T[K]): T {
  if (sameValue(obj[key], value)) return obj;
  return freeze({ ...obj, [key]: value });
}

function readOwn(record: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Lookups
// ---------------------------------------------------------------------------------------------

function indexOfCard(stack: HexStack, cardId: HexID): number {
  const index = stack.cards.findIndex((card) => card.id === cardId);
  if (index < 0) throw new HexMutationError(`No card with id "${cardId}"`);
  return index;
}

function indexOfBackground(stack: HexStack, backgroundId: HexID): number {
  const index = stack.backgrounds.findIndex((background) => background.id === backgroundId);
  if (index < 0) throw new HexMutationError(`No background with id "${backgroundId}"`);
  return index;
}

function requireCard(stack: HexStack, cardId: HexID): HexCard {
  return stack.cards[indexOfCard(stack, cardId)];
}

/** The HexBackground a card inherits from. */
export function getCardBackground(stack: HexStack, card: HexCard): HexBackground {
  return stack.backgrounds[indexOfBackground(stack, card.backgroundId)];
}

function requireField(parts: readonly HexPart[], partId: HexID, layer: HexLayer): HexFieldPart {
  const part = parts.find((candidate) => candidate.id === partId);
  if (!part) throw new HexMutationError(`No ${layer} field with id "${partId}"`);
  if (part.type !== "field") throw new HexMutationError(`Part "${partId}" is a ${part.type}, not a field`);
  return part;
}

// ---------------------------------------------------------------------------------------------
// Read helpers (Requirements 1.1, 1.2, 1.4)
// ---------------------------------------------------------------------------------------------

/**
 * Text shown by a field on a given card (§5.6 step 2): card fields and shared background fields
 * read `content`; unshared background fields read `card.bgFieldContents[id]`, missing = "".
 */
export function readFieldText(stack: HexStack, cardId: HexID, layer: HexLayer, partId: HexID): string {
  const card = requireCard(stack, cardId);
  if (layer === "card") return requireField(card.parts, partId, layer).content;
  const field = requireField(getCardBackground(stack, card).parts, partId, layer);
  if (field.sharedText) return field.content;
  return readOwn(card.bgFieldContents, partId) ?? "";
}

export type VisibleLayer =
  | { kind: "bitmap"; layer: HexLayer; bitmap: HexBitmapLayer }
  | { kind: "parts"; layer: HexLayer; parts: readonly HexPart[] };

export interface VisibleCardContent {
  card: HexCard;
  background: HexBackground;
  /** Bottom-most first, in the §5.6 order: background bitmap, background parts, card bitmap, card parts. */
  layers: readonly [VisibleLayer, VisibleLayer, VisibleLayer, VisibleLayer];
}

/** Requirement 1.1: the linked background's bitmap and parts beneath the card's own. */
export function resolveVisibleContent(stack: HexStack, cardId: HexID): VisibleCardContent {
  const card = requireCard(stack, cardId);
  const background = getCardBackground(stack, card);
  return {
    card,
    background,
    layers: [
      { kind: "bitmap", layer: "background", bitmap: background.bitmap },
      { kind: "parts", layer: "background", parts: background.parts },
      { kind: "bitmap", layer: "card", bitmap: card.bitmap },
      { kind: "parts", layer: "card", parts: card.parts },
    ],
  };
}

export type HexEditTarget =
  | { layer: "card"; owner: HexCard }
  | { layer: "background"; owner: HexBackground };

/**
 * Requirement 1.4: the object that authoring mutations (paint strokes, part creation, part edits)
 * must target. In Edit Background mode this is the current card's HexBackground; new parts take
 * `layerScope = target.layer`.
 */
export function resolveEditTarget(state: HexRuntimeState): HexEditTarget {
  const card = requireCard(state.stack, state.currentCardId);
  if (state.editLayer === "background") return { layer: "background", owner: getCardBackground(state.stack, card) };
  return { layer: "card", owner: card };
}

// ---------------------------------------------------------------------------------------------
// ScriptCache (Requirements 4.4, 4.5)
// ---------------------------------------------------------------------------------------------

export interface ScriptCache {
  get(objectId: HexID): CompiledScript;
  /** Recompiles every object of the stack (load). */
  rebuild(stack: HexStack): void;
  /** Recompiles only objects whose `scriptSource` changed or that are new; drops removed objects. */
  sync(stack: HexStack): void;
}

const EMPTY_AST: HexScriptAST = freezeDeep({ handlers: {} });
const EMPTY_COMPILED: CompiledScript = freezeDeep({ ast: EMPTY_AST, errors: [] });

function forEachScriptOwner(stack: HexStack, visit: (id: HexID, source: string) => void): void {
  visit(stack.id, stack.scriptSource);
  for (const owner of [...stack.backgrounds, ...stack.cards]) {
    visit(owner.id, owner.scriptSource);
    for (const part of owner.parts) visit(part.id, part.scriptSource);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A thrown compiler or a script with errors yields an empty AST plus the errors; it never throws. */
function compileSafely(compile: ScriptCompiler, source: string): CompiledScript {
  let result: CompiledScript;
  try {
    result = compile(source);
  } catch (error) {
    return freezeDeep({
      ast: EMPTY_AST,
      errors: [{ line: 1, column: 1, message: `Script could not be compiled: ${errorMessage(error)}` }],
    });
  }
  if (result.errors.length > 0) return freezeDeep({ ast: EMPTY_AST, errors: [...result.errors] });
  return freezeDeep({ ast: result.ast, errors: [] });
}

export function createScriptCache(compile: ScriptCompiler): ScriptCache {
  const entries = new Map<HexID, { source: string; compiled: CompiledScript }>();

  const sync = (stack: HexStack): void => {
    const live = new Set<HexID>();
    forEachScriptOwner(stack, (id, source) => {
      live.add(id);
      if (entries.get(id)?.source === source) return;
      entries.set(id, { source, compiled: compileSafely(compile, source) });
    });
    for (const id of entries.keys()) {
      if (!live.has(id)) entries.delete(id);
    }
  };

  return {
    get: (objectId) => entries.get(objectId)?.compiled ?? EMPTY_COMPILED,
    rebuild(stack) {
      entries.clear();
      sync(stack);
    },
    sync,
  };
}

// ---------------------------------------------------------------------------------------------
// Value coercion (hexcard_design_spec.md §4.3 "Property validity")
// ---------------------------------------------------------------------------------------------

type PropertyValue = string | number | boolean;

const BUTTON_STYLES = Object.keys({
  transparent: true, opaque: true, rectangle: true, roundRect: true,
  shadow: true, checkBox: true, radioButton: true, default: true,
} satisfies Record<ButtonStyle, true>) as ButtonStyle[];

const FIELD_STYLES = Object.keys({
  transparent: true, opaque: true, rectangle: true, shadow: true, scrolling: true,
} satisfies Record<FieldStyle, true>) as FieldStyle[];

const TEXT_ALIGNS: ReadonlyArray<HexFieldPart["textAlign"]> = ["left", "center", "right"];
const TEXT_FONTS: ReadonlyArray<HexFieldPart["textFont"]> = ["System", "Sans", "Mono", "Serif"];
const TEXT_SIZES: ReadonlyArray<HexFieldPart["textSize"]> = [9, 10, 12, 14, 18, 24];
const TEXT_STYLES: ReadonlyArray<HexFieldPart["textStyle"][number]> = [
  "bold", "italic", "underline", "outline", "shadow", "condense",
];

function describeValue(value: PropertyValue): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function invalidValue(property: string, value: PropertyValue, expected: string): HexMutationError {
  return new HexMutationError(`Invalid ${property} ${describeValue(value)}: expected ${expected}`);
}

function toText(value: PropertyValue): string {
  return typeof value === "string" ? value : String(value);
}

/** Booleans, or the strings "true"/"false" (case-insensitive), as in HexTalk conditions. */
function toBoolean(value: PropertyValue, property: string): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (word === "true") return true;
    if (word === "false") return false;
  }
  throw invalidValue(property, value, "true or false");
}

/** Case-insensitive match; returns the canonical spelling. */
function matchWord<T extends string>(value: PropertyValue, options: readonly T[], property: string): T {
  const word = toText(value).trim().toLowerCase();
  const match = options.find((option) => option.toLowerCase() === word);
  if (match === undefined) throw invalidValue(property, value, `one of ${options.join(", ")}`);
  return match;
}

/** Comma-separated numbers, rounded to integers so rects stay valid for the stack validator. */
function toIntegers(value: PropertyValue, count: number, property: string, expected: string): number[] {
  const items = toText(value).split(",");
  if (items.length !== count) throw invalidValue(property, value, expected);
  return items.map((item) => {
    const trimmed = item.trim();
    const number = Number(trimmed);
    if (trimmed === "" || !Number.isFinite(number)) throw invalidValue(property, value, expected);
    return Math.round(number);
  });
}

/** `rect` is "left,top,right,bottom". */
function parseRect(value: PropertyValue): HexRect {
  const expected = '"left,top,right,bottom" with right >= left and bottom >= top';
  const [left, top, right, bottom] = toIntegers(value, 4, "rect", expected);
  if (right < left || bottom < top) throw invalidValue("rect", value, expected);
  return freeze({ x: left, y: top, width: right - left, height: bottom - top });
}

/** Offset of a part's centre from its top-left corner: (floor(width / 2), floor(height / 2)). */
function centreOffset(rect: HexRect): { dx: number; dy: number } {
  return { dx: Math.floor(rect.width / 2), dy: Math.floor(rect.height / 2) };
}

/** `location` is the part centre "x,y", with centre = (x + floor(width / 2), y + floor(height / 2)). */
function moveCentreTo(rect: HexRect, value: PropertyValue): HexRect {
  const [cx, cy] = toIntegers(value, 2, "location", '"x,y"');
  const { dx, dy } = centreOffset(rect);
  return freeze({ x: cx - dx, y: cy - dy, width: rect.width, height: rect.height });
}

/** Read direction of `location`: the part centre as "x,y" (inverse of the `location` write). */
export function formatLocation(rect: HexRect): string {
  const { dx, dy } = centreOffset(rect);
  return `${rect.x + dx},${rect.y + dy}`;
}

/** Read direction of `rect`: "left,top,right,bottom" (inverse of the `rect` write). */
export function formatRect(rect: HexRect): string {
  return `${rect.x},${rect.y},${rect.x + rect.width},${rect.y + rect.height}`;
}

/** Read direction of `textStyle`: comma-separated styles, or "plain" when none is set. */
export function formatTextStyle(styles: readonly HexFieldPart["textStyle"][number][]): string {
  return styles.length === 0 ? "plain" : styles.join(",");
}

function parseTextSize(value: PropertyValue): HexFieldPart["textSize"] {
  const number = typeof value === "number" ? value : Number(toText(value).trim());
  const size = TEXT_SIZES.find((candidate) => candidate === number);
  if (size === undefined) throw invalidValue("textSize", value, `one of ${TEXT_SIZES.join(", ")}`);
  return size;
}

/** Comma-separated styles in the given order, duplicates removed; "plain" or "" clears all styles. */
function parseTextStyle(value: PropertyValue): HexFieldPart["textStyle"] {
  const text = toText(value).trim();
  if (text === "" || text.toLowerCase() === "plain") return freeze([]);
  const styles = text.split(",").map((item) => matchWord(item, TEXT_STYLES, "textStyle"));
  return freeze([...new Set(styles)]);
}

function invalidProperty(property: string, objectKind: string): HexMutationError {
  return new HexMutationError(`Property "${property}" does not apply to a ${objectKind}`);
}

function requireButton(part: HexPart, property: string): HexButtonPart {
  if (part.type !== "button") throw invalidProperty(property, part.type);
  return part;
}

function requireFieldPart(part: HexPart, property: string): HexFieldPart {
  if (part.type !== "field") throw invalidProperty(property, part.type);
  return part;
}

function setPartProperty(part: HexPart, property: HexPropertyName, value: PropertyValue): HexPart {
  switch (property) {
    case "name":
      return withProp(part, "name", toText(value));
    case "visible":
    case "enabled":
      return withProp(part, property, toBoolean(value, property));
    case "location":
      return withProp(part, "rect", moveCentreTo(part.rect, value));
    case "rect":
      return withProp(part, "rect", parseRect(value));
    case "style":
      return part.type === "button"
        ? withProp(part, "style", matchWord(value, BUTTON_STYLES, "button style"))
        : withProp(part, "style", matchWord(value, FIELD_STYLES, "field style"));
    case "hilite":
    case "showName":
    case "autoHilite":
      return withProp(requireButton(part, property), property, toBoolean(value, property));
    case "title":
      return withProp(requireButton(part, property), "title", toText(value));
    case "lockText":
      return withProp(requireFieldPart(part, property), "lockText", toBoolean(value, property));
    case "textAlign":
      return withProp(requireFieldPart(part, property), "textAlign", matchWord(value, TEXT_ALIGNS, property));
    case "textFont":
      return withProp(requireFieldPart(part, property), "textFont", matchWord(value, TEXT_FONTS, property));
    case "textSize":
      return withProp(requireFieldPart(part, property), "textSize", parseTextSize(value));
    case "textStyle":
      return withProp(requireFieldPart(part, property), "textStyle", parseTextStyle(value));
    case "marked":
      throw invalidProperty(property, part.type);
    default: {
      const unknown: never = property;
      throw new HexMutationError(`Unknown property "${String(unknown)}"`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Structural-sharing updates
// ---------------------------------------------------------------------------------------------

function updateCardAt(stack: HexStack, index: number, update: (card: HexCard) => HexCard): HexStack {
  const card = stack.cards[index];
  const next = update(card);
  return next === card ? stack : freeze({ ...stack, cards: replaceAt(stack.cards, index, next) });
}

function updateBackgroundAt(
  stack: HexStack,
  index: number,
  update: (background: HexBackground) => HexBackground,
): HexStack {
  const background = stack.backgrounds[index];
  const next = update(background);
  return next === background ? stack : freeze({ ...stack, backgrounds: replaceAt(stack.backgrounds, index, next) });
}

function updatePartAt<T extends { parts: HexPart[] }>(owner: T, index: number, update: (part: HexPart) => HexPart): T {
  const part = owner.parts[index];
  const next = update(part);
  return next === part ? owner : freeze({ ...owner, parts: replaceAt(owner.parts, index, next) });
}

/** Part ids are unique across the stack (Requirement 6.5), so the first match is the only one. */
function updatePart(stack: HexStack, partId: HexID, update: (part: HexPart) => HexPart): HexStack {
  for (let i = 0; i < stack.backgrounds.length; i++) {
    const j = stack.backgrounds[i].parts.findIndex((part) => part.id === partId);
    if (j >= 0) return updateBackgroundAt(stack, i, (background) => updatePartAt(background, j, update));
  }
  for (let i = 0; i < stack.cards.length; i++) {
    const j = stack.cards[i].parts.findIndex((part) => part.id === partId);
    if (j >= 0) return updateCardAt(stack, i, (card) => updatePartAt(card, j, update));
  }
  throw new HexMutationError(`No part with id "${partId}"`);
}

function writeFieldContent<T extends { parts: HexPart[] }>(owner: T, partId: HexID, layer: HexLayer, text: string): T {
  const field = requireField(owner.parts, partId, layer);
  return updatePartAt(owner, owner.parts.indexOf(field), () => withProp(field, "content", text));
}

/** Requirements 1.2 and 1.3: sharedText decides where a background field's text lives. */
function setFieldText(stack: HexStack, m: Extract<RuntimeMutation, { type: "setFieldText" }>): HexStack {
  const cardIndex = indexOfCard(stack, m.cardId);
  if (m.layer === "card") {
    return updateCardAt(stack, cardIndex, (card) => writeFieldContent(card, m.partId, "card", m.text));
  }

  const card = stack.cards[cardIndex];
  const backgroundIndex = indexOfBackground(stack, card.backgroundId);
  const field = requireField(stack.backgrounds[backgroundIndex].parts, m.partId, "background");
  if (field.sharedText) {
    return updateBackgroundAt(stack, backgroundIndex, (background) =>
      writeFieldContent(background, m.partId, "background", m.text));
  }

  if ((readOwn(card.bgFieldContents, m.partId) ?? "") === m.text) return stack;
  return updateCardAt(stack, cardIndex, (current) => freeze({
    ...current,
    bgFieldContents: freeze({ ...current.bgFieldContents, [m.partId]: m.text }),
  }));
}

/** Applies a stack-changing runtime mutation; returns the same stack object when nothing changed. */
function applyStackMutation(stack: HexStack, m: Exclude<RuntimeMutation, { type: "goToCard" }>): HexStack {
  switch (m.type) {
    case "setFieldText":
      return setFieldText(stack, m);
    case "setPartProperty":
      return updatePart(stack, m.partId, (part) => setPartProperty(part, m.property, m.value));
    case "setCardProperty":
      return updateCardAt(stack, indexOfCard(stack, m.cardId), (card) =>
        m.property === "name"
          ? withProp(card, "name", toText(m.value))
          : withProp(card, "marked", toBoolean(m.value, "marked")));
    case "setBackgroundProperty":
      return updateBackgroundAt(stack, indexOfBackground(stack, m.backgroundId), (background) =>
        withProp(background, "name", toText(m.value)));
    case "setStackProperty":
      return withProp(stack, "name", toText(m.value));
    default: {
      const unknown: never = m;
      throw new HexMutationError(`Unknown runtime mutation ${JSON.stringify(unknown)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------

/** Deep-frozen private copy, so callers can neither mutate the snapshot nor be affected by it. */
function adoptStack(stack: HexStack): HexStack {
  if (stack.cards.length === 0) throw new HexMutationError("Cannot load a stack without cards");
  return freezeDeep(structuredClone(stack));
}

export function createHexStore(options: HexStoreOptions): HexStore {
  const { autoSave } = options;
  const autoSaveDelayMs = options.autoSaveDelayMs ?? AUTO_SAVE_DELAY_MS;
  const cache = createScriptCache(options.compile);
  const listeners = new Set<() => void>();
  const replaceListeners = new Set<() => void>();
  let saveTimer: ReturnType<typeof setTimeout> | undefined;

  const initialStack = adoptStack(options.stack);
  cache.rebuild(initialStack);
  let state: HexRuntimeState = freeze({
    stack: initialStack,
    currentCardId: initialStack.cards[0].id,
    editLayer: "card",
    tool: "browse",
  });

  function publish(next: HexRuntimeState, replaced = false): void {
    state = freeze(next);
    if (replaced) for (const listener of [...replaceListeners]) listener();
    for (const listener of [...listeners]) listener();
  }

  function scheduleAutoSave(): void {
    if (!autoSave) return;
    if (saveTimer !== undefined) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = undefined;
      autoSave(state.stack);
    }, autoSaveDelayMs);
  }

  /** Saves a pending debounced write right away (used before the stack is replaced). */
  function flushAutoSave(): void {
    if (saveTimer === undefined) return;
    clearTimeout(saveTimer);
    saveTimer = undefined;
    autoSave?.(state.stack);
  }

  /** Every stack change goes through here so the ScriptCache follows `scriptSource` edits. */
  function commitStack(stack: HexStack): void {
    cache.sync(stack);
    publish({ ...state, stack });
  }

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    getSnapshot: () => state,

    applyRuntime(m) {
      if (m.type === "goToCard") {
        requireCard(state.stack, m.cardId);
        if (m.cardId !== state.currentCardId) publish({ ...state, currentCardId: m.cardId });
        return;
      }
      const next = applyStackMutation(state.stack, m);
      if (next === state.stack) return;
      commitStack(next);
      scheduleAutoSave();
    },

    replaceStack(stack) {
      const next = adoptStack(stack);
      flushAutoSave();
      cache.rebuild(next);
      publish({ stack: next, currentCardId: next.cards[0].id, editLayer: "card", tool: state.tool }, true);
    },

    onReplaceStack(listener) {
      replaceListeners.add(listener);
      return () => {
        replaceListeners.delete(listener);
      };
    },

    applyAuthoring(next) {
      if (next === state.stack) return;
      if (next.cards.length === 0) throw new HexMutationError("An authoring change cannot remove every card");
      // Structural sharing: untouched subtrees keep their identity, new objects are frozen in place.
      const stack = freezeTree(next);
      let { currentCardId } = state;
      if (!stack.cards.some((card) => card.id === currentCardId)) {
        // The current card was removed (e.g. undoing "New Card"): stay at the same position.
        const oldIndex = state.stack.cards.findIndex((card) => card.id === currentCardId);
        currentCardId = stack.cards[Math.min(Math.max(oldIndex, 0), stack.cards.length - 1)].id;
      }
      cache.sync(stack);
      publish({ ...state, stack, currentCardId });
      scheduleAutoSave();
    },

    getCompiled: (objectId) => cache.get(objectId),

    setEditLayer(layer) {
      if (layer !== state.editLayer) publish({ ...state, editLayer: layer });
    },

    setTool(tool) {
      if (tool !== state.tool) publish({ ...state, tool });
    },
  };
}
