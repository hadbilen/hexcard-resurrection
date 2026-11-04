/**
 * Message bus: message path, handled rule, FIFO queue, `idle` timer and nested lifecycle dispatch.
 * Design: .kiro/specs/01-core-stack-engine/design.md §5. Shared contracts: hexcard_design_spec.md
 * §3 (message path, handled rule, `pass`, message targets) and §3.2 (concurrency model).
 *
 * - Exactly one dispatch runs at a time. A dispatch suspended in `wait`, `answer`, `ask`, `fetch` or
 *   a visual effect is still the running dispatch; messages posted meanwhile wait in the queue.
 * - Nested dispatches (`closeCard`, `closeBackground`, `openBackground`, `openCard` sent by `go`)
 *   bypass the queue and share the parent's `DispatchContext` (gas budget, abort signal, depth).
 * - Each top-level dispatch has its own AbortController; `abort()` fires it and clears the queue.
 *
 * Pure TypeScript: no React, no DOM. The VM entry point, the HexHost, page visibility, modal state,
 * the interval timer and the error sink are injected.
 */
import type { HexHandlerNode } from "./ast.ts";
import type { HexCard, HexFieldPart, HexID, HexPart } from "./schema.ts";
import type { HexLayer, HexRuntimeState, HexStore } from "./store.ts";
import {
  createDispatchContext,
  HexAbortError,
  HexScriptError,
  MAX_DISPATCH_DEPTH,
  runHandler as vmRunHandler,
  suspend,
  type DispatchContext,
  type HexHost,
  type HexValue,
} from "./vm.ts";

// ---------------------------------------------------------------------------------------------
// Public types and constants
// ---------------------------------------------------------------------------------------------

export interface HexMessage {
  name: string;
  params: (string | number)[];
  targetId: HexID;
}

/**
 * Target of `go back`: the most recent back-history entry that still exists and is not the
 * current card (Requirement 2.7).
 */
export interface BackTarget {
  type: "relative";
  dir: "back";
}

/** A card id, or `go back`. */
export type CardChangeTarget = HexID | BackTarget;

/** Most pending entries the queue holds; the oldest entry is dropped on overflow (§3.2 rule 3). */
export const MAX_QUEUE_LENGTH = 32;
/** Most entries the back history holds; the oldest entry is dropped on overflow (Requirement 2.7). */
export const MAX_BACK_HISTORY = 64;
/** Interval of the `idle` timer (§3.2 rule 4). */
export const IDLE_INTERVAL_MS = 200;

/** Continuous messages: at most one pending entry per kind (lowercase names). */
const CONTINUOUS_MESSAGES: ReadonlySet<string> = new Set(["mousestilldown", "mousewithin", "idle"]);
/** Click messages that a Browse-tool click inside an unlocked field never sends (§3, Requirement 2.6). */
const CLICK_MESSAGES: ReadonlySet<string> = new Set(["mousedown", "mousestilldown", "mouseup", "mousedoubleclick"]);
/** Every mouse message of §3.1; none of them reaches a disabled part's path (Requirement 2.8). */
const MOUSE_MESSAGES: ReadonlySet<string> = new Set([...CLICK_MESSAGES, "mouseenter", "mousewithin", "mouseleave"]);

/** Runs one handler; production passes `runHandler` from vm.ts (spec 02). */
export type HandlerRunner = (
  handler: HexHandlerNode,
  params: (string | number)[],
  me: HexID,
  ctx: DispatchContext,
  host: HexHost,
) => Promise<"handled" | "passed">;

/** Starts a repeating timer and returns a function that stops it. */
export type IntervalScheduler = (callback: () => void, ms: number) => () => void;

export interface MessageBusOptions {
  store: HexStore;
  /**
   * Host passed to every handler. Its `goToCard` is expected to resolve the target, then call
   * `bus.changeCard`, so the lifecycle messages are nested in the running dispatch; `go back` is
   * passed to `changeCard` unresolved, because the bus owns the back history. A host that
   * needs the bus can reference it lazily (the bus is created before any message is dispatched).
   */
  host: HexHost;
  runHandler?: HandlerRunner;
  /** Runtime-wide globals (`global x`); the same map is shared by every dispatch. */
  globals?: Map<string, HexValue>;
  /** `document.visibilityState === "visible"` in the browser. */
  isPageVisible: () => boolean;
  /** True while a modal dialog (answer, ask, alerts, menus with modal state) is open. */
  isModalOpen: () => boolean;
  /** Defaults to `setInterval`/`clearInterval`. */
  scheduleInterval?: IntervalScheduler;
  /** Receives script errors (`HexScriptError`, `HexVmGasLimitError`, ...); aborts are not reported. */
  onError?: (error: unknown, message: HexMessage) => void;
  /** Receives queue warnings; defaults to `console.warn`. */
  warn?: (message: string) => void;
}

export interface MessageBus {
  /** From the UI: enqueue with the coalescing and overflow rules; starts dispatching when idle. */
  post(msg: HexMessage): void;
  /** From the VM/host during a dispatch: delivers `msg` immediately, inside the running dispatch. */
  sendNested(msg: HexMessage, ctx: DispatchContext): Promise<void>;
  /**
   * Changes the current card inside the running dispatch (used by `go` and the arrow-key
   * built-in): `closeCard`, [`closeBackground`], card change, `transition`, [`openBackground`],
   * `openCard`. The optional `transition` (visual effect playback) is a suspension point.
   * `{ type: "relative", dir: "back" }` takes the most recent entry that still exists and is not
   * the current card off the back history, dropping the skipped entries above it (Requirement
   * 2.7), and does nothing at all when there is none.
   */
  changeCard(target: CardChangeTarget, ctx: DispatchContext, transition?: () => Promise<void>): Promise<void>;
  /** Cmd/Ctrl+. or a tool switch: aborts the running dispatch and clears the queue. */
  abort(): void;
  /** `[part?, card, background, stack]` for a target in the current snapshot; empty if it is gone. */
  buildPath(targetId: HexID): HexID[];
  /** True while a dispatch runs (including while it is suspended). */
  isRunning(): boolean;
  /** Number of queued messages. */
  pendingCount(): number;
  /** Copy of the back history, oldest first (the last entry is what `go back` tries first). */
  backHistory(): readonly HexID[];
  /** Stops the idle timer, unsubscribes from the store and aborts. */
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------

function findPart(state: HexRuntimeState, partId: HexID): { part: HexPart; layer: HexLayer; ownerId: HexID } | undefined {
  for (const background of state.stack.backgrounds) {
    const part = background.parts.find((candidate) => candidate.id === partId);
    if (part) return { part, layer: "background", ownerId: background.id };
  }
  for (const card of state.stack.cards) {
    const part = card.parts.find((candidate) => candidate.id === partId);
    if (part) return { part, layer: "card", ownerId: card.id };
  }
  return undefined;
}

function cardPath(state: HexRuntimeState, card: HexCard): HexID[] {
  return [card.id, card.backgroundId, state.stack.id];
}

/**
 * The message path of §3 for `targetId` (built-ins excluded): a card part goes through its own
 * card, a background part through the current card. Returns an empty path when the target no
 * longer exists, or when a background part does not belong to the current card's background.
 */
export function buildMessagePath(state: HexRuntimeState, targetId: HexID): HexID[] {
  const { stack } = state;
  if (stack.id === targetId) return [stack.id];
  if (stack.backgrounds.some((background) => background.id === targetId)) return [targetId, stack.id];
  const card = stack.cards.find((candidate) => candidate.id === targetId);
  if (card) return cardPath(state, card);

  const found = findPart(state, targetId);
  if (!found) return [];
  if (found.layer === "card") {
    const owner = stack.cards.find((candidate) => candidate.id === found.ownerId);
    return owner ? [targetId, ...cardPath(state, owner)] : [];
  }
  const current = stack.cards.find((candidate) => candidate.id === state.currentCardId);
  if (!current || current.backgroundId !== found.ownerId) return [];
  return [targetId, ...cardPath(state, current)];
}

/**
 * Card reached by a relative move from the current card. `next`/`prev` wrap around the ends of
 * the stack, as in HyperCard.
 */
export function resolveRelativeCard(state: HexRuntimeState, dir: "next" | "prev" | "first" | "last"): HexID {
  const { cards } = state.stack;
  const index = Math.max(0, cards.findIndex((card) => card.id === state.currentCardId));
  switch (dir) {
    case "first": return cards[0].id;
    case "last": return cards[cards.length - 1].id;
    case "next": return cards[(index + 1) % cards.length].id;
    case "prev": return cards[(index - 1 + cards.length) % cards.length].id;
  }
}

function asUnlockedField(state: HexRuntimeState, partId: HexID): { part: HexFieldPart; layer: HexLayer } | undefined {
  const found = findPart(state, partId);
  if (!found || found.part.type !== "field" || found.part.lockText) return undefined;
  return { part: found.part, layer: found.layer };
}

/**
 * Requirement 2.8: true for a mouse message whose target is a disabled part. Such a message is
 * dropped whole; it is never retargeted to a part underneath or to the card.
 */
function isDisabledMouseTarget(state: HexRuntimeState, msg: HexMessage): boolean {
  if (!MOUSE_MESSAGES.has(msg.name.toLowerCase())) return false;
  const found = findPart(state, msg.targetId);
  return found !== undefined && !found.part.enabled;
}

export type BrowseClick =
  | { action: "editField"; partId: HexID; layer: HexLayer } // place the caret, send no mouse messages
  | { action: "send"; targetId: HexID };                     // send mouse messages to targetId

/**
 * Message target of a Browse-tool click (§3, Requirement 2.6): an enabled unlocked field takes
 * the caret and receives no mouse messages; any other part receives them; no hit means the
 * current card. A disabled part, including a disabled unlocked field, still captures the click
 * and is returned as the target (no caret); the bus then drops its mouse messages (Requirement 2.8).
 */
export function resolveBrowseClick(state: HexRuntimeState, hitPartId: HexID | null): BrowseClick {
  if (hitPartId === null) return { action: "send", targetId: state.currentCardId };
  const field = asUnlockedField(state, hitPartId);
  if (field && field.part.enabled) return { action: "editField", partId: hitPartId, layer: field.layer };
  return { action: "send", targetId: hitPartId };
}

/** HyperCard's abort shortcut: Cmd+. (macOS) or Ctrl+. (elsewhere). */
export function isAbortShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean }): boolean {
  return event.key === "." && (event.metaKey || event.ctrlKey);
}

const defaultScheduleInterval: IntervalScheduler = (callback, ms) => {
  const handle = setInterval(callback, ms);
  return () => clearInterval(handle);
};

function handlerFor(objectId: HexID, store: HexStore, name: string): HexHandlerNode | undefined {
  const { handlers } = store.getCompiled(objectId).ast;
  const key = name.toLowerCase();
  // Own keys only: names such as "constructor" must not resolve to Object.prototype members.
  return Object.hasOwn(handlers, key) ? handlers[key] : undefined;
}

// ---------------------------------------------------------------------------------------------
// Bus
// ---------------------------------------------------------------------------------------------

export function createMessageBus(options: MessageBusOptions): MessageBus {
  const { store, host, isPageVisible, isModalOpen } = options;
  const runHandler = options.runHandler ?? vmRunHandler;
  const globals = options.globals ?? new Map<string, HexValue>();
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const onError = options.onError ?? ((error: unknown) => console.error(error));
  const scheduleInterval = options.scheduleInterval ?? defaultScheduleInterval;

  const queue: HexMessage[] = [];
  let running = false;
  let controller: AbortController | null = null;

  /** Requirement 2.7: departing card ids, oldest first, at most MAX_BACK_HISTORY entries. */
  const backHistory: HexID[] = [];
  /** True while `go back` changes the card, so that change is not pushed. */
  let goingBack = false;

  function pushBack(cardId: HexID): void {
    backHistory.push(cardId);
    if (backHistory.length > MAX_BACK_HISTORY) backHistory.shift();
  }

  /**
   * Pops entries until one names a card of the current stack other than the current card.
   * Entries for deleted cards and for the current card are dropped; returns undefined (and
   * leaves the history empty) when no entry qualifies.
   */
  function popBack(): HexID | undefined {
    const { stack, currentCardId } = store.getSnapshot();
    for (let cardId = backHistory.pop(); cardId !== undefined; cardId = backHistory.pop()) {
      if (cardId !== currentCardId && stack.cards.some((card) => card.id === cardId)) return cardId;
    }
    return undefined;
  }

  /** Walks the path; the first handler that does not `pass` handles the message. */
  async function deliver(msg: HexMessage, ctx: DispatchContext): Promise<void> {
    const path = buildMessagePath(store.getSnapshot(), msg.targetId);
    if (path.length === 0) return; // the target was removed while the message waited
    for (const objectId of path) {
      const handler = handlerFor(objectId, store, msg.name);
      if (!handler) continue;
      if ((await runHandler(handler, msg.params, objectId, ctx, host)) === "handled") return;
    }
    await runBuiltIn(msg, ctx);
  }

  /** Layer 5 of the path: unhandled messages are ignored, except the arrow-key default. */
  async function runBuiltIn(msg: HexMessage, ctx: DispatchContext): Promise<void> {
    if (msg.name.toLowerCase() !== "keydown") return;
    const key = msg.params[0];
    if (key !== "ArrowLeft" && key !== "ArrowRight") return;
    const cardId = resolveRelativeCard(store.getSnapshot(), key === "ArrowLeft" ? "prev" : "next");
    await bus.changeCard(cardId, ctx);
  }

  async function runTopLevel(msg: HexMessage): Promise<void> {
    const own = new AbortController();
    controller = own;
    const ctx = createDispatchContext({ abortSignal: own.signal, globals });
    try {
      // Requirement 2.8, checked again at dequeue: a script may disable the part while its mouse
      // message waits in the queue (for example a mouseUp that disables its own button).
      if (!isDisabledMouseTarget(store.getSnapshot(), msg)) await deliver(msg, ctx);
    } catch (error) {
      if (!(error instanceof HexAbortError)) onError(error, msg);
    } finally {
      ctx.pendingVisualEffect = null; // an unconsumed visual effect ends with its dispatch (§3.2 rule 7)
      if (controller === own) controller = null;
    }
  }

  async function drain(): Promise<void> {
    running = true;
    try {
      for (let msg = queue.shift(); msg; msg = queue.shift()) await runTopLevel(msg);
    } finally {
      running = false;
    }
  }

  function enqueue(msg: HexMessage): void {
    const kind = msg.name.toLowerCase();
    if (CONTINUOUS_MESSAGES.has(kind)) {
      const pending = queue.findIndex((entry) => entry.name.toLowerCase() === kind);
      if (pending >= 0) {
        queue[pending] = msg; // keep the queue position, take the newest target and params
        return;
      }
    }
    queue.push(msg);
    if (queue.length > MAX_QUEUE_LENGTH) {
      const dropped = queue.shift();
      warn(`HexCard message queue is full (${MAX_QUEUE_LENGTH}); dropped the oldest message "${dropped?.name}"`);
    }
  }

  /** Requirement 2.6: a Browse-tool click in an unlocked field never becomes a mouse message. */
  function isSuppressedClick(msg: HexMessage): boolean {
    const state = store.getSnapshot();
    return state.tool === "browse" && CLICK_MESSAGES.has(msg.name.toLowerCase()) && asUnlockedField(state, msg.targetId) !== undefined;
  }

  function idleAllowed(): boolean {
    return store.getSnapshot().tool === "browse" && queue.length === 0 && !running && !isModalOpen() && isPageVisible();
  }

  const bus: MessageBus = {
    post(msg) {
      if (isSuppressedClick(msg)) return;
      // Requirement 2.8: dropped before it takes a queue slot or replaces a pending entry.
      if (isDisabledMouseTarget(store.getSnapshot(), msg)) return;
      enqueue(msg);
      if (!running) void drain();
    },

    async sendNested(msg, ctx) {
      if (ctx.abortSignal.aborted) throw new HexAbortError();
      if (ctx.depth >= MAX_DISPATCH_DEPTH) throw new HexScriptError("Too much recursion");
      ctx.depth += 1;
      try {
        await deliver(msg, ctx);
      } finally {
        ctx.depth -= 1;
      }
    },

    async changeCard(target, ctx, transition) {
      const isBack = typeof target !== "string";
      const cardId = isBack ? popBack() : target;
      if (cardId === undefined) return; // empty back history: go back does nothing
      const before = store.getSnapshot();
      const from = before.stack.cards.find((card) => card.id === before.currentCardId);
      const to = before.stack.cards.find((card) => card.id === cardId);
      if (!to) throw new HexScriptError(`No such card id "${cardId}"`);
      if (from && from.id === to.id) return; // already there: no lifecycle messages
      const backgroundChanges = !from || from.backgroundId !== to.backgroundId;

      if (from) {
        await bus.sendNested({ name: "closeCard", params: [], targetId: from.id }, ctx);
        if (backgroundChanges) await bus.sendNested({ name: "closeBackground", params: [], targetId: from.id }, ctx);
      }
      if (ctx.abortSignal.aborted) throw new HexAbortError();
      goingBack = isBack;
      try {
        store.applyRuntime({ type: "goToCard", cardId: to.id }); // the store listener below pushes `from`
      } finally {
        goingBack = false;
      }
      if (transition) await suspend(ctx, transition());
      if (backgroundChanges) await bus.sendNested({ name: "openBackground", params: [], targetId: to.id }, ctx);
      await bus.sendNested({ name: "openCard", params: [], targetId: to.id }, ctx);
    },

    abort() {
      queue.length = 0;
      controller?.abort();
    },

    buildPath: (targetId) => buildMessagePath(store.getSnapshot(), targetId),

    isRunning: () => running,

    pendingCount: () => queue.length,

    backHistory: () => backHistory.slice(),

    dispose() {
      stopIdle();
      unsubscribe();
      unsubscribeReplace();
      bus.abort();
    },
  };

  let lastTool = store.getSnapshot().tool;
  let lastCardId = store.getSnapshot().currentCardId;
  const unsubscribe = store.subscribe(() => {
    const { tool, currentCardId } = store.getSnapshot();
    // Requirement 3.7: switching from Browse to an authoring tool aborts like Cmd/Ctrl+.
    if (lastTool === "browse" && tool !== "browse") bus.abort();
    lastTool = tool;
    // Requirement 2.7: every card change except go back pushes the departing card. The store only
    // publishes a new current card when it differs, so a no-op go never pushes.
    if (currentCardId !== lastCardId) {
      if (!goingBack) pushBack(lastCardId);
      lastCardId = currentCardId;
    }
  });

  // Requirement 2.7: a replaced stack starts with an empty back history. This runs before the
  // subscriber above, so the switch to the new stack's first card is not pushed either.
  const unsubscribeReplace = store.onReplaceStack(() => {
    backHistory.length = 0;
    lastCardId = store.getSnapshot().currentCardId;
  });

  const stopIdle = scheduleInterval(() => {
    if (idleAllowed()) bus.post({ name: "idle", params: [], targetId: store.getSnapshot().currentCardId });
  }, IDLE_INTERVAL_MS);

  return bus;
}
