/**
 * HexTalk virtual machine: a gas-limited, asynchronous tree-walking interpreter over HexScriptAST.
 * Design: .kiro/specs/02-hextalk-ast-vm/design.md §4. Shared contracts: hexcard_design_spec.md
 * §3.2 (concurrency, nested dispatch, card context), §4.2 (AST), §4.3 (gas, values, variables,
 * property validity).
 *
 * Sandbox rules (Requirement 4.1): scripts run only by interpreting AST nodes. This module never uses
 * eval(), new Function(), string timers or script elements. Everything outside the VM (store, dialogs,
 * sound, network, card changes) is reached through the injected `HexHost`.
 *
 * Gas: `evalStatement` and `evalExpr` call `ctx.tick()` before doing anything else, so every
 * evaluated statement and expression node costs exactly 1 step. A repeat loop additionally costs
 * 1 step per iteration (the loop node is re-entered), so loops with an empty body or with only
 * control-flow statements still run out of gas instead of freezing the page.
 */
import type {
  HexCardTarget,
  HexContainerTarget,
  HexExprNode,
  HexHandlerNode,
  HexObjectTarget,
  HexPartSelector,
  HexPropertyName,
  HexRepeatHead,
  HexSourceLoc,
  HexStatementNode,
  HexVoice,
} from "./ast.ts";
import type {
  HexBackground,
  HexCard,
  HexID,
  HexPart,
  HexStack,
  VisualEffectSpeed,
  VisualEffectType,
} from "./schema.ts";
import {
  formatLocation,
  formatRect,
  formatTextStyle,
  getCardBackground,
  HexMutationError,
  type HexLayer,
  type HexRuntimeState,
  type RuntimeMutation,
} from "./store.ts";

// ---------------------------------------------------------------------------------------------
// Limits and values
// ---------------------------------------------------------------------------------------------

/** Steps per top-level dispatch, shared with its nested dispatches (§4.3). */
export const GAS_LIMIT = 10_000;
/** Maximum nesting of dispatches (§3.2 rule 5); enforced by the message bus. */
export const MAX_DISPATCH_DEPTH = 16;

/** A runtime value (§4.3). Field contents are always strings. */
export type HexValue = string | number | boolean;

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** Where a runtime error happened: the object owning the handler, the handler and the source line. */
export interface HexErrorLocation {
  objectId: HexID;
  handler: string; // original spelling, e.g. "mouseUp"
  line: number;    // 1-based; 0 when the AST carries no source locations
}

/**
 * Base class of errors that stop a dispatch and are shown to the user. Errors are raised without a
 * location deep inside the VM; `runHandler` attaches the location of the innermost running handler
 * as the error leaves it, so a nested dispatch reports its own handler, not the caller's.
 */
export class HexRuntimeError extends Error {
  objectId: HexID | undefined;
  handler: string | undefined;
  line: number | undefined;

  constructor(message: string, location?: HexErrorLocation) {
    super(message);
    this.objectId = location?.objectId;
    this.handler = location?.handler;
    this.line = location?.line;
  }

  get location(): HexErrorLocation | undefined {
    if (this.objectId === undefined || this.handler === undefined || this.line === undefined) return undefined;
    return { objectId: this.objectId, handler: this.handler, line: this.line };
  }
}

/** Type errors, missing parts, invalid property/object combinations and similar failures. */
export class HexScriptError extends HexRuntimeError {
  override name = "HexScriptError";
}

/** The shared step counter exceeded `GAS_LIMIT`. Mutations already applied are kept. */
export class HexVmGasLimitError extends HexRuntimeError {
  override name = "HexVmGasLimitError";

  constructor(location?: HexErrorLocation) {
    super("Loop exceeded 10,000 steps", location);
  }
}

/** The dispatch's abort signal fired (Cmd/Ctrl+. or a tool switch). Not a script error: shown silently. */
export class HexAbortError extends Error {
  override name = "HexAbortError";

  constructor() {
    super("Script aborted");
  }
}

// ---------------------------------------------------------------------------------------------
// Dispatch context
// ---------------------------------------------------------------------------------------------

export type PendingEffect = { effect: VisualEffectType; speed: VisualEffectSpeed };

/**
 * State of one top-level dispatch, shared by reference with all of its nested dispatches
 * (§3.2 rule 5). Created by the message bus (spec 01) for each top-level dispatch.
 */
export interface DispatchContext {
  /** Steps used so far by this dispatch and its nested dispatches. */
  stepCount: number;
  /** Current nesting level; 0 for the top-level dispatch. Maintained by the message bus. */
  depth: number;
  readonly abortSignal: AbortSignal;
  /** Set by `visual effect`, consumed by the next `go`, discarded at the end of the dispatch. */
  pendingVisualEffect: PendingEffect | null;
  /**
   * Runtime-wide globals (`global x`). The runtime owns one map and passes the same map to every
   * dispatch; it lives only in memory and is never persisted or exported.
   */
  readonly globals: Map<string, HexValue>;
  /** Charges 1 step. Throws `HexAbortError` once aborted, `HexVmGasLimitError` above `GAS_LIMIT`. */
  tick(): void;
}

export interface DispatchContextOptions {
  abortSignal: AbortSignal;
  globals: Map<string, HexValue>;
}

export function createDispatchContext(options: DispatchContextOptions): DispatchContext {
  const ctx: DispatchContext = {
    stepCount: 0,
    depth: 0,
    abortSignal: options.abortSignal,
    pendingVisualEffect: null,
    globals: options.globals,
    tick() {
      if (ctx.abortSignal.aborted) throw new HexAbortError();
      ctx.stepCount += 1;
      if (ctx.stepCount > GAS_LIMIT) throw new HexVmGasLimitError();
    },
  };
  return ctx;
}

/**
 * Awaits a host promise as a suspension point (§3.2 rule 2): rejects with `HexAbortError` as soon
 * as the dispatch is aborted, even if the host promise never settles.
 */
export function suspend<T>(ctx: DispatchContext, promise: Promise<T>): Promise<T> {
  const signal = ctx.abortSignal;
  if (signal.aborted) return Promise.reject(new HexAbortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new HexAbortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** Longest delay a JS timer supports; longer `wait`s are clamped to it instead of firing at once. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * The timer promise of `wait` (a suspension point, §3.2 rule 2): resolves after `ms`, or rejects
 * with `HexAbortError` as soon as the dispatch is aborted, clearing the timer. Uses a callback
 * timer only, never a string timer.
 */
function sleep(ctx: DispatchContext, ms: number): Promise<void> {
  const signal = ctx.abortSignal;
  if (signal.aborted) return Promise.reject(new HexAbortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(handle);
      reject(new HexAbortError());
    };
    const handle = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.min(Math.max(ms, 0), MAX_TIMER_MS));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Host interface
// ---------------------------------------------------------------------------------------------

/** A field on a specific card; for background fields `cardId` selects the card-specific text. */
export interface ResolvedFieldRef {
  cardId: HexID;
  layer: HexLayer;
  partId: HexID;
}

/** A `HexPartSelector` whose expression has been evaluated by the VM. */
export type EvaluatedSelector = { by: "id" | "auto"; value: HexValue };

/** A `HexObjectTarget` whose selector expressions have been evaluated by the VM. */
export type EvaluatedObjectTarget =
  | { objectType: "me" }
  | { objectType: "button" | "field"; layer: HexLayer; selector: EvaluatedSelector }
  | { objectType: "card"; selector?: EvaluatedSelector }
  | { objectType: "background" }
  | { objectType: "stack" };

/** A `HexCardTarget` whose expression has been evaluated by the VM. */
export type EvaluatedCardTarget =
  | Extract<HexCardTarget, { type: "relative" }>
  | { type: "id" | "auto"; value: HexValue };

/** An object of the current snapshot. `cardId` is the card a part's text is read from and written to. */
export type ResolvedObject =
  | { kind: "part"; part: HexPart; layer: HexLayer; cardId: HexID }
  | { kind: "card"; card: HexCard; number: number } // 1-based position in the stack
  | { kind: "background"; background: HexBackground }
  | { kind: "stack"; stack: HexStack };

export interface HostClock {
  date: string;
  time: string;
  ticks: number;
  seconds: number;
  mouseH: number;
  mouseV: number;
}

export type FetchResult = { ok: true; value: string } | { ok: false; reason: string };

/** Injected; keeps the VM free of DOM, React and audio code. */
export interface HexHost {
  readField(ref: ResolvedFieldRef): string;
  /** Spec 01 store write path. May throw `HexMutationError`, which the VM reports as `HexScriptError`. */
  applyRuntime(m: RuntimeMutation): void;
  /** Resolves against the current card at call time; throws `HexScriptError` if the object is missing. */
  resolveObject(t: EvaluatedObjectTarget, me: HexID): ResolvedObject;
  /** Changes card and sends the nested lifecycle messages with `ctx`. */
  goToCard(target: EvaluatedCardTarget, effect: PendingEffect | null, ctx: DispatchContext): Promise<void>;
  playSound(voice: HexVoice, tempo: number, notes: string): void;
  showAnswer(prompt: string, buttons: string[]): Promise<string>;
  showAsk(prompt: string, defaultAnswer: string): Promise<string>;
  fetchJson(url: string, jsonPath?: string): Promise<FetchResult>;
  now(): HostClock;
}

// ---------------------------------------------------------------------------------------------
// Object resolution against a store snapshot (for HexHost implementations)
// ---------------------------------------------------------------------------------------------

function describeSelector(selector: EvaluatedSelector): string {
  if (selector.by === "id") return `id "${toText(selector.value)}"`;
  return isNumeric(selector.value) ? toText(selector.value) : `"${toText(selector.value)}"`;
}

/** id => exact id; number => 1-based position; anything else => case-insensitive name. */
function selectItem<T extends { id: HexID; name: string }>(
  items: readonly T[],
  selector: EvaluatedSelector,
): { item: T; index: number } | undefined {
  let index: number;
  if (selector.by === "id") {
    const id = toText(selector.value);
    index = items.findIndex((item) => item.id === id);
  } else if (isNumeric(selector.value)) {
    const position = toNumber(selector.value);
    index = Number.isInteger(position) ? position - 1 : -1;
  } else {
    const name = toText(selector.value).toLowerCase();
    index = items.findIndex((item) => item.name.toLowerCase() === name);
  }
  return index >= 0 && index < items.length ? { item: items[index], index } : undefined;
}

function currentCard(state: HexRuntimeState): HexCard {
  const card = state.stack.cards.find((candidate) => candidate.id === state.currentCardId);
  if (!card) throw new HexScriptError(`The current card "${state.currentCardId}" no longer exists`);
  return card;
}

function resolveById(state: HexRuntimeState, id: HexID): ResolvedObject {
  const { stack } = state;
  if (stack.id === id) return { kind: "stack", stack };
  const background = stack.backgrounds.find((candidate) => candidate.id === id);
  if (background) return { kind: "background", background };
  const cardIndex = stack.cards.findIndex((candidate) => candidate.id === id);
  if (cardIndex >= 0) return { kind: "card", card: stack.cards[cardIndex], number: cardIndex + 1 };
  for (const owner of stack.backgrounds) {
    const part = owner.parts.find((candidate) => candidate.id === id);
    if (part) return { kind: "part", part, layer: "background", cardId: currentCard(state).id };
  }
  for (const owner of stack.cards) {
    const part = owner.parts.find((candidate) => candidate.id === id);
    if (part) return { kind: "part", part, layer: "card", cardId: owner.id };
  }
  throw new HexScriptError(`The object "${id}" no longer exists`);
}

/**
 * Resolves an evaluated target against a snapshot (§3.2 rule 6): parts, "this card" and "this
 * background" use the current card of `state`; `me` is looked up by id. Button and field positions
 * count only parts of that type on that layer. Throws `HexScriptError` when nothing matches.
 */
export function resolveObjectTarget(state: HexRuntimeState, target: EvaluatedObjectTarget, me: HexID): ResolvedObject {
  const { stack } = state;
  switch (target.objectType) {
    case "me":
      return resolveById(state, me);
    case "button":
    case "field": {
      const card = currentCard(state);
      const owner = target.layer === "card" ? card : getCardBackground(stack, card);
      const candidates = owner.parts.filter((part) => part.type === target.objectType);
      const match = selectItem(candidates, target.selector);
      if (!match) {
        const layerWord = target.layer === "card" ? "card" : "bg";
        throw new HexScriptError(`No such ${layerWord} ${target.objectType} ${describeSelector(target.selector)}`);
      }
      return { kind: "part", part: match.item, layer: target.layer, cardId: card.id };
    }
    case "card": {
      if (!target.selector) {
        const card = currentCard(state);
        return { kind: "card", card, number: stack.cards.indexOf(card) + 1 };
      }
      const match = selectItem(stack.cards, target.selector);
      if (!match) throw new HexScriptError(`No such card ${describeSelector(target.selector)}`);
      return { kind: "card", card: match.item, number: match.index + 1 };
    }
    case "background":
      return { kind: "background", background: getCardBackground(stack, currentCard(state)) };
    case "stack":
      return { kind: "stack", stack };
    default: {
      const unknown: never = target;
      throw new HexScriptError(`Unknown object ${JSON.stringify(unknown)}`);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Value rules (§4.3)
// ---------------------------------------------------------------------------------------------

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;

function describeValue(value: HexValue): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

/**
 * Finite numbers and numeric-looking strings (surrounding whitespace allowed). Booleans and "" are
 * not numeric, so comparisons with empty stay text-based and selectors never read "" as a position.
 */
export function isNumeric(value: HexValue): boolean {
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return NUMERIC_TEXT.test(value.trim());
  return false;
}

/**
 * Arithmetic conversion: numeric values become numbers and the exact empty string "" (an unset
 * variable or an empty field) becomes 0, as in HyperCard. Anything else is a script error.
 */
export function toNumber(value: HexValue): number {
  if (value === "") return 0;
  if (!isNumeric(value)) throw new HexScriptError(`Expected a number but found ${describeValue(value)}`);
  return typeof value === "number" ? value : Number((value as string).trim());
}

/** Integers print as-is; other numbers with at most 6 decimals (HyperCard's default numberFormat). */
function formatNumber(value: number): string {
  const rounded = Number.isInteger(value) ? value : Number(value.toFixed(6));
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

export function toText(value: HexValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return formatNumber(value);
}

/** Conditions: booleans, or the strings "true"/"false" in any case. */
export function toBoolean(value: HexValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const word = value.trim().toLowerCase();
    if (word === "true") return true;
    if (word === "false") return false;
  }
  throw new HexScriptError(`Expected true or false but found ${describeValue(value)}`);
}

/** Numeric when both sides are numeric, otherwise case-insensitive text order. Returns -1, 0 or 1. */
export function compareValues(left: HexValue, right: HexValue): number {
  if (isNumeric(left) && isNumeric(right)) {
    const a = toNumber(left);
    const b = toNumber(right);
    return a < b ? -1 : a > b ? 1 : 0;
  }
  const a = toText(left).toLowerCase();
  const b = toText(right).toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function divisor(value: HexValue): number {
  const number = toNumber(value);
  if (number === 0) throw new HexScriptError("Division by zero");
  return number;
}

// ---------------------------------------------------------------------------------------------
// Property validity (§4.3)
// ---------------------------------------------------------------------------------------------

type ObjectKind = "button" | "field" | "card" | "background" | "stack";

const PARTS: readonly ObjectKind[] = ["button", "field"];
const BUTTONS: readonly ObjectKind[] = ["button"];
const FIELDS: readonly ObjectKind[] = ["field"];

const PROPERTY_SCOPE: Record<HexPropertyName, readonly ObjectKind[]> = {
  name: ["button", "field", "card", "background", "stack"],
  visible: PARTS,
  enabled: PARTS,
  location: PARTS,
  rect: PARTS,
  style: PARTS,
  hilite: BUTTONS,
  title: BUTTONS,
  showName: BUTTONS,
  autoHilite: BUTTONS,
  lockText: FIELDS,
  textAlign: FIELDS,
  textFont: FIELDS,
  textSize: FIELDS,
  textStyle: FIELDS,
  marked: ["card"],
};

function objectKind(object: ResolvedObject): ObjectKind {
  return object.kind === "part" ? object.part.type : object.kind;
}

function checkProperty(property: HexPropertyName, object: ResolvedObject): void {
  const kind = objectKind(object);
  if (!PROPERTY_SCOPE[property].includes(kind)) {
    throw new HexScriptError(`The ${property} property does not apply to a ${kind}`);
  }
}

function invalidProperty(property: HexPropertyName, object: ResolvedObject): HexScriptError {
  return new HexScriptError(`The ${property} property does not apply to a ${objectKind(object)}`);
}

function readPartProperty(part: HexPart, property: HexPropertyName): HexValue | undefined {
  switch (property) {
    case "name": return part.name;
    case "visible": return part.visible;
    case "enabled": return part.enabled;
    case "location": return formatLocation(part.rect);
    case "rect": return formatRect(part.rect);
    case "style": return part.style;
    default: break;
  }
  if (part.type === "button") {
    switch (property) {
      case "hilite": return part.hilite;
      case "title": return part.title;
      case "showName": return part.showName;
      case "autoHilite": return part.autoHilite;
      default: return undefined;
    }
  }
  switch (property) {
    case "lockText": return part.lockText;
    case "textAlign": return part.textAlign;
    case "textFont": return part.textFont;
    case "textSize": return part.textSize;
    case "textStyle": return formatTextStyle(part.textStyle);
    default: return undefined;
  }
}

function readProperty(object: ResolvedObject, property: HexPropertyName): HexValue {
  checkProperty(property, object);
  let value: HexValue | undefined;
  switch (object.kind) {
    case "part": value = readPartProperty(object.part, property); break;
    case "card": value = property === "marked" ? object.card.marked : property === "name" ? object.card.name : undefined; break;
    case "background": value = property === "name" ? object.background.name : undefined; break;
    case "stack": value = property === "name" ? object.stack.name : undefined; break;
  }
  if (value === undefined) throw invalidProperty(property, object);
  return value;
}

/** Builds the store mutation for `set`; value parsing (location, rect, styles...) is the store's job. */
function propertyMutation(object: ResolvedObject, property: HexPropertyName, value: HexValue): RuntimeMutation {
  checkProperty(property, object);
  switch (object.kind) {
    case "part":
      return { type: "setPartProperty", partId: object.part.id, property, value };
    case "card":
      if (property === "marked") return { type: "setCardProperty", cardId: object.card.id, property, value: typeof value === "boolean" ? value : toText(value) };
      if (property === "name") return { type: "setCardProperty", cardId: object.card.id, property, value: toText(value) };
      break;
    case "background":
      if (property === "name") return { type: "setBackgroundProperty", backgroundId: object.background.id, property, value: toText(value) };
      break;
    case "stack":
      if (property === "name") return { type: "setStackProperty", property, value: toText(value) };
      break;
  }
  throw invalidProperty(property, object);
}

// ---------------------------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------------------------

/** Control-flow sentinels: returned (never thrown) so gas accounting stays exact. */
type ControlFlow = { readonly flow: "exitRepeat" | "nextRepeat" | "exitHandler" | "pass" };

const EXIT_REPEAT: ControlFlow = Object.freeze({ flow: "exitRepeat" });
const NEXT_REPEAT: ControlFlow = Object.freeze({ flow: "nextRepeat" });
const EXIT_HANDLER: ControlFlow = Object.freeze({ flow: "exitHandler" });
const PASS: ControlFlow = Object.freeze({ flow: "pass" });

/** One running handler call. */
interface Frame {
  readonly handler: HexHandlerNode;
  readonly me: HexID;
  readonly ctx: DispatchContext;
  readonly host: HexHost;
  readonly locals: Map<string, HexValue>;
  /** Names declared with `global` so far in this call. */
  readonly globalNames: Set<string>;
  /** Line of the node evaluated most recently; used to locate errors. */
  line: number;
}

type ResolvedContainer =
  | { kind: "variable"; name: string }
  | { kind: "field"; ref: ResolvedFieldRef };

/** Every node evaluation starts here: record the line, then charge one step. */
function enter(frame: Frame, loc: HexSourceLoc | undefined): void {
  if (loc) frame.line = loc.line;
  frame.ctx.tick();
}

function scopeOf(frame: Frame, name: string): Map<string, HexValue> {
  return frame.globalNames.has(name) ? frame.ctx.globals : frame.locals;
}

/** An unset variable evaluates to empty. */
function getVariable(frame: Frame, name: string): HexValue {
  return scopeOf(frame, name).get(name) ?? "";
}

function setVariable(frame: Frame, name: string, value: HexValue): void {
  scopeOf(frame, name).set(name, value);
}

function evaluateSelector(frame: Frame, selector: HexPartSelector): EvaluatedSelector {
  return { by: selector.by, value: evalExpr(frame, selector.value) };
}

function evaluateTarget(frame: Frame, target: HexObjectTarget): EvaluatedObjectTarget {
  switch (target.objectType) {
    case "button":
    case "field":
      return { objectType: target.objectType, layer: target.layer, selector: evaluateSelector(frame, target.selector) };
    case "card":
      return target.selector ? { objectType: "card", selector: evaluateSelector(frame, target.selector) } : { objectType: "card" };
    default:
      return target;
  }
}

function resolveTarget(frame: Frame, target: HexObjectTarget): ResolvedObject {
  return frame.host.resolveObject(evaluateTarget(frame, target), frame.me);
}

function resolveContainer(frame: Frame, target: HexContainerTarget): ResolvedContainer {
  if (target.scope === "variable") return { kind: "variable", name: target.name };
  const object = frame.host.resolveObject(
    { objectType: "field", layer: target.layer, selector: evaluateSelector(frame, target.selector) },
    frame.me,
  );
  if (object.kind !== "part" || object.part.type !== "field") {
    throw new HexScriptError("Only variables and fields can hold text");
  }
  return { kind: "field", ref: { cardId: object.cardId, layer: object.layer, partId: object.part.id } };
}

function readContainer(frame: Frame, container: ResolvedContainer): HexValue {
  return container.kind === "variable" ? getVariable(frame, container.name) : frame.host.readField(container.ref);
}

function writeContainer(frame: Frame, container: ResolvedContainer, value: HexValue): void {
  if (container.kind === "variable") {
    setVariable(frame, container.name, value);
    return;
  }
  frame.host.applyRuntime({ type: "setFieldText", ...container.ref, text: toText(value) });
}

// --- Expressions -----------------------------------------------------------------------------

const CONSTANTS: Record<Extract<HexExprNode, { kind: "Constant" }>["name"], string> = {
  empty: "",
  quote: "\"",
  return: "\n",
  space: " ",
  tab: "\t",
};

function expectArgs(name: string, args: readonly HexValue[], min: number, max: number): void {
  if (args.length < min || args.length > max) {
    const expected = min === max ? String(min) : max === Infinity ? `at least ${min}` : `${min} to ${max}`;
    throw new HexScriptError(`${name} expects ${expected} argument${min === 1 && max === 1 ? "" : "s"}, got ${args.length}`);
  }
}

/** Rounds half away from zero. */
function roundNumber(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

function callFunction(name: Extract<HexExprNode, { kind: "FunctionCall" }>["name"], args: HexValue[]): HexValue {
  switch (name) {
    case "random": {
      expectArgs(name, args, 1, 1);
      const limit = Math.floor(toNumber(args[0]));
      if (limit < 1) throw new HexScriptError(`random expects a number of at least 1, got ${toText(args[0])}`);
      return 1 + Math.floor(Math.random() * limit);
    }
    case "round":
      expectArgs(name, args, 1, 1);
      return roundNumber(toNumber(args[0]));
    case "trunc":
      expectArgs(name, args, 1, 1);
      return Math.trunc(toNumber(args[0]));
    case "abs":
      expectArgs(name, args, 1, 1);
      return Math.abs(toNumber(args[0]));
    case "length":
      expectArgs(name, args, 1, 1);
      return toText(args[0]).length;
    case "min":
    case "max": {
      expectArgs(name, args, 1, Infinity);
      const numbers = args.map(toNumber);
      return name === "min" ? Math.min(...numbers) : Math.max(...numbers);
    }
    default: {
      const unknown: never = name;
      throw new HexScriptError(`Unknown function ${String(unknown)}`);
    }
  }
}

function applyBinary(op: Exclude<Extract<HexExprNode, { kind: "BinaryOp" }>["op"], "and" | "or">, left: HexValue, right: HexValue): HexValue {
  switch (op) {
    case "=": return compareValues(left, right) === 0;
    case "<>": return compareValues(left, right) !== 0;
    case "<": return compareValues(left, right) < 0;
    case ">": return compareValues(left, right) > 0;
    case "<=": return compareValues(left, right) <= 0;
    case ">=": return compareValues(left, right) >= 0;
    case "contains": return toText(left).toLowerCase().includes(toText(right).toLowerCase());
    case "&": return toText(left) + toText(right);
    case "&&": return `${toText(left)} ${toText(right)}`;
    case "+": return toNumber(left) + toNumber(right);
    case "-": return toNumber(left) - toNumber(right);
    case "*": return toNumber(left) * toNumber(right);
    case "/": {
      const a = toNumber(left);
      return a / divisor(right);
    }
    case "div": {
      const a = toNumber(left);
      return Math.trunc(a / divisor(right));
    }
    case "mod": {
      const a = toNumber(left);
      return a % divisor(right);
    }
    default: {
      const unknown: never = op;
      throw new HexScriptError(`Unknown operator ${String(unknown)}`);
    }
  }
}

function evalBuiltIn(frame: Frame, name: Extract<HexExprNode, { kind: "BuiltIn" }>["name"]): HexValue {
  switch (name) {
    case "numberOfCards": {
      const object = frame.host.resolveObject({ objectType: "stack" }, frame.me);
      if (object.kind !== "stack") throw new HexScriptError("Cannot count the cards of this stack");
      return object.stack.cards.length;
    }
    case "cardNumber": {
      const object = frame.host.resolveObject({ objectType: "card" }, frame.me);
      if (object.kind !== "card") throw new HexScriptError("Cannot find the number of this card");
      return object.number;
    }
    default:
      return frame.host.now()[name];
  }
}

/** Evaluates one expression node. Expressions never suspend, so this is synchronous. */
function evalExpr(frame: Frame, expr: HexExprNode): HexValue {
  enter(frame, expr.loc);
  switch (expr.kind) {
    case "Literal":
      return expr.value;
    case "Constant":
      return CONSTANTS[expr.name];
    case "Variable":
      return getVariable(frame, expr.name);
    case "BuiltIn":
      return evalBuiltIn(frame, expr.name);
    case "FunctionCall":
      return callFunction(expr.name, expr.args.map((arg) => evalExpr(frame, arg)));
    case "ReadContainer":
      return readContainer(frame, resolveContainer(frame, expr.source));
    case "ReadProperty":
      return readProperty(resolveTarget(frame, expr.target), expr.property);
    case "BinaryOp": {
      // `and`/`or` short-circuit: the right operand is evaluated (and charged) only when needed.
      if (expr.op === "and") return toBoolean(evalExpr(frame, expr.left)) && toBoolean(evalExpr(frame, expr.right));
      if (expr.op === "or") return toBoolean(evalExpr(frame, expr.left)) || toBoolean(evalExpr(frame, expr.right));
      const left = evalExpr(frame, expr.left);
      const right = evalExpr(frame, expr.right);
      return applyBinary(expr.op, left, right);
    }
    case "UnaryOp": {
      const operand = evalExpr(frame, expr.operand);
      return expr.op === "not" ? !toBoolean(operand) : 0 - toNumber(operand); // 0 - x avoids -0
    }
    default: {
      const unknown: never = expr;
      throw new HexScriptError(`Unknown expression ${JSON.stringify(unknown)}`);
    }
  }
}

// --- Statements ------------------------------------------------------------------------------

async function runBlock(frame: Frame, body: readonly HexStatementNode[]): Promise<ControlFlow | undefined> {
  for (const statement of body) {
    const flow = await evalStatement(frame, statement);
    if (flow) return flow;
  }
  return undefined;
}

/** Returns a function that decides, before each iteration, whether the body runs again. */
function loopCondition(frame: Frame, head: HexRepeatHead): () => boolean {
  switch (head.type) {
    case "forever":
      return () => true;
    case "count": {
      const times = Math.trunc(toNumber(evalExpr(frame, head.times)));
      let done = 0;
      return () => done++ < times;
    }
    case "while":
      return () => toBoolean(evalExpr(frame, head.condition));
    case "until":
      return () => !toBoolean(evalExpr(frame, head.condition));
    case "range": {
      const start = toNumber(evalExpr(frame, head.start));
      const end = toNumber(evalExpr(frame, head.end));
      const step = head.direction === "up" ? 1 : -1;
      let counter = start;
      return () => {
        if (step > 0 ? counter > end : counter < end) return false;
        setVariable(frame, head.varName, counter);
        counter += step;
        return true;
      };
    }
    default: {
      const unknown: never = head;
      throw new HexScriptError(`Unknown repeat form ${JSON.stringify(unknown)}`);
    }
  }
}

async function runRepeat(frame: Frame, loop: Extract<HexStatementNode, { kind: "RepeatLoop" }>): Promise<ControlFlow | undefined> {
  const shouldContinue = loopCondition(frame, loop.head);
  for (;;) {
    enter(frame, loop.loc); // 1 step per iteration; also the abort check between iterations
    if (!shouldContinue()) return undefined;
    const flow = await runBlock(frame, loop.body);
    if (flow === EXIT_REPEAT) return undefined;
    if (flow === EXIT_HANDLER || flow === PASS) return flow;
    // NEXT_REPEAT or a normal end of the body: next iteration.
  }
}

function evaluateCardTarget(frame: Frame, target: HexCardTarget): EvaluatedCardTarget {
  if (target.type === "relative") return { type: "relative", dir: target.dir };
  return { type: target.type, value: evalExpr(frame, target.value) };
}

/** `wait` amounts: 1 tick = 1/60 s (§4.2). */
function waitMilliseconds(amount: number, unit: "ticks" | "seconds"): number {
  return unit === "seconds" ? amount * 1000 : (amount * 1000) / 60;
}

/** Evaluates one statement node; returns a control-flow sentinel or undefined to continue. */
async function evalStatement(frame: Frame, statement: HexStatementNode): Promise<ControlFlow | undefined> {
  enter(frame, statement.loc);
  const { ctx, host } = frame;
  switch (statement.kind) {
    case "PutValue": {
      const value = evalExpr(frame, statement.value);
      const destination = resolveContainer(frame, statement.destination);
      if (statement.mode === "into") {
        writeContainer(frame, destination, value);
      } else {
        const current = toText(readContainer(frame, destination));
        const text = toText(value);
        writeContainer(frame, destination, statement.mode === "after" ? current + text : text + current);
      }
      return undefined;
    }
    case "GetValue":
      setVariable(frame, "it", evalExpr(frame, statement.value));
      return undefined;
    case "MathMutation": {
      const amount = evalExpr(frame, statement.amount);
      const destination = resolveContainer(frame, statement.destination);
      const current = toNumber(readContainer(frame, destination));
      let result: number;
      switch (statement.op) {
        case "add": result = current + toNumber(amount); break;
        case "subtract": result = current - toNumber(amount); break;
        case "multiply": result = current * toNumber(amount); break;
        case "divide": result = current / divisor(amount); break;
      }
      writeContainer(frame, destination, result);
      return undefined;
    }
    case "SetProperty": {
      const value = evalExpr(frame, statement.value);
      host.applyRuntime(propertyMutation(resolveTarget(frame, statement.target), statement.property, value));
      return undefined;
    }
    case "DeclareGlobal":
      for (const name of statement.names) frame.globalNames.add(name);
      return undefined;
    case "IfCondition": {
      const condition = toBoolean(evalExpr(frame, statement.condition));
      return runBlock(frame, condition ? statement.thenBranch : statement.elseBranch ?? []);
    }
    case "RepeatLoop":
      return runRepeat(frame, statement);
    case "PassEvent":
      if (statement.eventName.toLowerCase() !== frame.handler.eventName.toLowerCase()) {
        throw new HexScriptError(`Cannot pass ${statement.eventName} from the ${frame.handler.eventName} handler`);
      }
      return PASS;
    case "ExitHandler":
      return EXIT_HANDLER;
    case "ExitRepeat":
      return EXIT_REPEAT;
    case "NextRepeat":
      return NEXT_REPEAT;
    case "QueueVisualEffect":
      ctx.pendingVisualEffect = { effect: statement.effect, speed: statement.speed }; // last one wins
      return undefined;
    case "ShowAnswerDialog": {
      const prompt = toText(evalExpr(frame, statement.prompt));
      const buttons = statement.buttons.map((button) => toText(evalExpr(frame, button)));
      setVariable(frame, "it", await suspend(ctx, host.showAnswer(prompt, buttons.length > 0 ? buttons : ["OK"])));
      return undefined;
    }
    case "ShowAskDialog": {
      const prompt = toText(evalExpr(frame, statement.prompt));
      const defaultAnswer = statement.defaultAnswer ? toText(evalExpr(frame, statement.defaultAnswer)) : "";
      setVariable(frame, "it", await suspend(ctx, host.showAsk(prompt, defaultAnswer)));
      return undefined;
    }
    case "FetchJson": {
      const url = toText(evalExpr(frame, statement.url));
      const destination = resolveContainer(frame, statement.destination);
      const result = await suspend(ctx, host.fetchJson(url, statement.jsonPath));
      if (result.ok) {
        writeContainer(frame, destination, result.value);
        setVariable(frame, "it", result.value);
      } else {
        setVariable(frame, "it", `error: ${result.reason}`); // destination stays unchanged
      }
      return undefined;
    }
    case "GoToCard": {
      const target = evaluateCardTarget(frame, statement.target);
      // §3.2 rule 7: this go consumes the pending effect, so handlers it triggers start without one.
      const effect = ctx.pendingVisualEffect;
      ctx.pendingVisualEffect = null;
      // The host sends the nested lifecycle messages with `ctx` and suspends for the effect;
      // statements after `go` see the new card (§3.2 rule 6).
      await host.goToCard(target, effect, ctx);
      return undefined;
    }
    case "Wait": {
      const amount = toNumber(evalExpr(frame, statement.amount));
      await sleep(ctx, waitMilliseconds(amount, statement.unit));
      return undefined;
    }
    case "PlaySound":
      // Not a suspension point (§3.2 rule 2): the sound plays while the script continues.
      host.playSound(statement.voice, statement.tempo, statement.notes);
      return undefined;
    default: {
      const unknown: never = statement;
      throw new HexScriptError(`Unknown statement ${JSON.stringify(unknown)}`);
    }
  }
}

/** Converts store errors and attaches the location of this handler call to unlocated runtime errors. */
function locateError(frame: Frame, error: unknown): unknown {
  const location: HexErrorLocation = { objectId: frame.me, handler: frame.handler.eventName, line: frame.line };
  if (error instanceof HexMutationError) {
    const converted = new HexScriptError(error.message, location);
    converted.cause = error;
    return converted;
  }
  if (error instanceof HexRuntimeError && error.location === undefined) {
    error.objectId = location.objectId;
    error.handler = location.handler;
    error.line = location.line;
  }
  return error;
}

/**
 * Runs one handler as the object `me`. Parameters bind positionally to the handler's parameter
 * names (missing ones are empty); `it` starts empty. Resolves to "passed" when the handler ran
 * `pass`, otherwise "handled". Throws `HexScriptError`, `HexVmGasLimitError` (both located) or
 * `HexAbortError`, which stop the whole dispatch.
 */
export async function runHandler(
  handler: HexHandlerNode,
  params: (string | number)[],
  me: HexID,
  ctx: DispatchContext,
  host: HexHost,
): Promise<"handled" | "passed"> {
  const frame: Frame = {
    handler,
    me,
    ctx,
    host,
    locals: new Map<string, HexValue>([["it", ""]]),
    globalNames: new Set<string>(),
    line: handler.loc?.line ?? 0,
  };
  handler.params.forEach((name, index) => frame.locals.set(name, index < params.length ? params[index] : ""));

  try {
    const flow = await runBlock(frame, handler.body);
    if (flow === PASS) return "passed";
    if (flow === EXIT_REPEAT || flow === NEXT_REPEAT) {
      throw new HexScriptError(`${flow === EXIT_REPEAT ? "exit repeat" : "next repeat"} used outside a repeat loop`);
    }
    return "handled";
  } catch (error) {
    throw locateError(frame, error);
  }
}
