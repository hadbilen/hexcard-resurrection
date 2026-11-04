import { afterEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { HexStatementNode } from "../ast.ts";
import {
  buildMessagePath,
  createMessageBus,
  IDLE_INTERVAL_MS,
  isAbortShortcut,
  MAX_BACK_HISTORY,
  MAX_QUEUE_LENGTH,
  resolveBrowseClick,
  resolveRelativeCard,
  type HandlerRunner,
  type HexMessage,
  type MessageBus,
} from "../messageBus.ts";
import type { HexButtonPart, HexCard, HexFieldPart, HexStack } from "../schema.ts";
import { createHexStore, readFieldText, type CompiledScript } from "../store.ts";
import {
  createDispatchContext,
  resolveObjectTarget,
  runHandler,
  suspend,
  type DispatchContext,
  type HexHost,
} from "../vm.ts";

// ---------------------------------------------------------------------------------------------
// Fixture: crd_1 and crd_2 use bkg_1, crd_3 uses bkg_2.
// Scripts are stored as JSON `{ handlerName: statements[] }` and compiled by `compile` below.
// ---------------------------------------------------------------------------------------------

type Scripts = Record<string, HexStatementNode[]>;

const script = (handlers: Scripts): string => JSON.stringify(handlers);

function compile(source: string): CompiledScript {
  if (source === "") return { ast: { handlers: {} }, errors: [] };
  const parsed = JSON.parse(source) as Scripts;
  const handlers = Object.fromEntries(
    Object.entries(parsed).map(([eventName, body]) => [eventName.toLowerCase(), { eventName, params: [], body }]),
  );
  return { ast: { handlers }, errors: [] };
}

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function field(overrides: Partial<HexFieldPart> & Pick<HexFieldPart, "id" | "name">): HexFieldPart {
  return {
    type: "field", layerScope: "background", rect: { x: 10, y: 40, width: 200, height: 100 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "System",
    textSize: 12, textStyle: [], ...overrides,
  };
}

function button(scriptSource = ""): HexButtonPart {
  return {
    id: "prt_btn", name: "Go", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true, enabled: true, scriptSource, style: "roundRect", title: "Go", showName: true,
    autoHilite: true, hilite: false,
  };
}

function card(id: string, backgroundId: string, scriptSource = "", parts: HexCard["parts"] = []): HexCard {
  return {
    id, name: id, backgroundId, bitmap: emptyBitmap, parts, bgFieldContents: {}, marked: false,
    cantDelete: false, dontSearch: false, scriptSource,
  };
}

interface ScriptSet {
  stack?: Scripts;
  bkg_1?: Scripts;
  bkg_2?: Scripts;
  crd_1?: Scripts;
  crd_2?: Scripts;
  crd_3?: Scripts;
  prt_btn?: Scripts;
}

function makeStack(scripts: ScriptSet): HexStack {
  const src = (handlers?: Scripts): string => (handlers ? script(handlers) : "");
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      {
        id: "bkg_1", name: "Main", bitmap: emptyBitmap, scriptSource: src(scripts.bkg_1), cantDelete: false,
        parts: [field({ id: "prt_in", name: "Input" }), field({ id: "prt_lbl", name: "Label", lockText: true })],
      },
      { id: "bkg_2", name: "Other", bitmap: emptyBitmap, scriptSource: src(scripts.bkg_2), cantDelete: false, parts: [] },
    ],
    cards: [
      card("crd_1", "bkg_1", src(scripts.crd_1), [button(src(scripts.prt_btn))]),
      card("crd_2", "bkg_1", src(scripts.crd_2)),
      card("crd_3", "bkg_2", src(scripts.crd_3)),
    ],
    customIcons: {}, scriptSource: src(scripts.stack),
  };
}

// AST builders
const answer: HexStatementNode = { kind: "ShowAnswerDialog", prompt: { kind: "Literal", value: "wait" }, buttons: [] };
const pass = (eventName: string): HexStatementNode => ({ kind: "PassEvent", eventName });
const goNext: HexStatementNode = { kind: "GoToCard", target: { type: "relative", dir: "next" } };
const goBack: HexStatementNode = { kind: "GoToCard", target: { type: "relative", dir: "back" } };
const ask: HexStatementNode = { kind: "ShowAskDialog", prompt: { kind: "Literal", value: "Name?" } };
const fetchJson: HexStatementNode = {
  kind: "FetchJson", url: { kind: "Literal", value: "https://example.com" }, destination: { scope: "variable", name: "x" },
};
const wait: HexStatementNode = { kind: "Wait", amount: { kind: "Literal", value: 1 }, unit: "seconds" };

interface SetupOptions {
  visible?: boolean;
  modal?: boolean;
  /** `go` plays a visual-effect transition that stays suspended until released. */
  transition?: boolean;
  /** Use the bus's default `setInterval` scheduler instead of the manual idle tick. */
  realInterval?: boolean;
}

/**
 * Real store and VM. The injected handler runner logs every handler call and executes `go` and
 * `wait` itself, so the test controls when they suspend and resume (the VM's own `go` and `wait`
 * are implemented in vm.ts and covered by vm.test.ts and vm.goEndToEnd.test.ts); all other
 * statements run in the real VM. `answer`, `ask`, `fetch`, `wait` and transitions suspend until
 * `releaseAnswers()`.
 */
function setup(scripts: ScriptSet, options: SetupOptions = {}) {
  const store = createHexStore({ stack: makeStack(scripts), compile });
  const log: string[] = [];
  const depths: number[] = [];
  const contexts = new Set<DispatchContext>();
  const errors: unknown[] = [];
  const warnings: string[] = [];
  const pendingAnswers: (() => void)[] = [];
  const env = { visible: options.visible ?? true, modal: options.modal ?? false };
  let idleTick: (() => void) | undefined;
  let bus: MessageBus | undefined;

  /** A host promise that settles with `value` once released. */
  const hold = <T,>(value: T): Promise<T> => new Promise<T>((resolve) => pendingAnswers.push(() => resolve(value)));

  const host: HexHost = {
    readField: (ref) => readFieldText(store.getSnapshot().stack, ref.cardId, ref.layer, ref.partId),
    applyRuntime: (m) => store.applyRuntime(m),
    resolveObject: (t, me) => resolveObjectTarget(store.getSnapshot(), t, me),
    goToCard: (target, _effect, ctx) => {
      if (target.type !== "relative") throw new Error("unsupported in this test");
      const transition = options.transition ? () => hold<void>(undefined) : undefined;
      if (target.dir === "back") return bus!.changeCard({ type: "relative", dir: "back" }, ctx, transition);
      return bus!.changeCard(resolveRelativeCard(store.getSnapshot(), target.dir), ctx, transition);
    },
    playSound: () => undefined,
    showAnswer: () => hold("OK"),
    showAsk: (_prompt, defaultAnswer) => hold(defaultAnswer),
    fetchJson: () => hold({ ok: false as const, reason: "blocked url" }),
    now: () => ({ date: "1/1/26", time: "12:00 PM", ticks: 0, seconds: 0, mouseH: 0, mouseV: 0 }),
  };

  const runner: HandlerRunner = async (handler, params, me, ctx, h) => {
    log.push(params.length > 0 ? `${me}.${handler.eventName}(${params.join(",")})` : `${me}.${handler.eventName}`);
    depths.push(ctx.depth);
    contexts.add(ctx);
    if (handler.body[0]?.kind === "GoToCard") {
      await h.goToCard(handler.body[0].target as { type: "relative"; dir: "next" | "back" }, null, ctx);
      return "handled";
    }
    if (handler.body[0]?.kind === "Wait") {
      await suspend(ctx, hold<void>(undefined));
      return "handled";
    }
    return runHandler(handler, params, me, ctx, h);
  };

  bus = createMessageBus({
    store,
    host,
    runHandler: runner,
    isPageVisible: () => env.visible,
    isModalOpen: () => env.modal,
    scheduleInterval: options.realInterval
      ? undefined
      : (callback) => {
        idleTick = callback;
        return () => {
          idleTick = undefined;
        };
      },
    onError: (error) => errors.push(error),
    warn: (message) => warnings.push(message),
  });

  const releaseAnswers = async (): Promise<void> => {
    while (pendingAnswers.length > 0) {
      pendingAnswers.shift()!();
      await settle();
    }
  };

  return {
    store, bus, log, depths, contexts, errors, warnings, env, pendingAnswers, releaseAnswers,
    tickIdle: () => idleTick?.(),
  };
}

/** Lets every pending promise chain run to completion. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const msg = (name: string, targetId: string, ...params: (string | number)[]): HexMessage => ({ name, params, targetId });

// ---------------------------------------------------------------------------------------------
// Message path (Requirements 2.1-2.3)
// ---------------------------------------------------------------------------------------------

describe("message path", () => {
  it("builds part -> card -> background -> stack paths from the current snapshot", () => {
    const { store, bus } = setup({});
    const state = store.getSnapshot();
    expect(bus.buildPath("prt_btn")).toEqual(["prt_btn", "crd_1", "bkg_1", "stk_1"]);
    expect(buildMessagePath(state, "prt_lbl")).toEqual(["prt_lbl", "crd_1", "bkg_1", "stk_1"]);
    expect(buildMessagePath(state, "crd_3")).toEqual(["crd_3", "bkg_2", "stk_1"]);
    expect(buildMessagePath(state, "bkg_1")).toEqual(["bkg_1", "stk_1"]);
    expect(buildMessagePath(state, "stk_1")).toEqual(["stk_1"]);
    expect(buildMessagePath(state, "prt_missing")).toEqual([]);
  });

  it("runs only the first matching handler, matching names case-insensitively", async () => {
    const { bus, log } = setup({ crd_1: { MOUSEUP: [] }, bkg_1: { mouseUp: [] }, stack: { mouseUp: [] } });
    bus.post(msg("mouseup", "prt_btn"));
    await settle();
    expect(log).toEqual(["crd_1.MOUSEUP"]);
  });

  it("continues after pass at the next object with the same parameters", async () => {
    const { bus, log } = setup({
      prt_btn: { mouseUp: [pass("mouseUp")] },
      crd_1: { mouseUp: [pass("mouseUp")] },
      stack: { mouseUp: [] },
    });
    bus.post(msg("mouseUp", "prt_btn", "a", 1));
    await settle();
    expect(log).toEqual(["prt_btn.mouseUp(a,1)", "crd_1.mouseUp(a,1)", "stk_1.mouseUp(a,1)"]);
  });

  it("ends the passing handler immediately: statements after pass never run", async () => {
    const { bus, log, pendingAnswers } = setup({ prt_btn: { mouseUp: [pass("mouseUp"), answer] }, crd_1: { mouseUp: [] } });
    bus.post(msg("mouseUp", "prt_btn"));
    await settle();
    expect(log).toEqual(["prt_btn.mouseUp", "crd_1.mouseUp"]);
    expect(pendingAnswers).toHaveLength(0); // the answer after pass was never shown
    expect(bus.isRunning()).toBe(false);
  });

  it("delivers background-part messages through the current card", async () => {
    const { bus, store, log } = setup({ crd_2: { mouseUp: [pass("mouseUp")] }, bkg_1: { mouseUp: [] } });
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    expect(bus.buildPath("prt_lbl")).toEqual(["prt_lbl", "crd_2", "bkg_1", "stk_1"]);
    bus.post(msg("mouseUp", "prt_lbl"));
    await settle();
    expect(log).toEqual(["crd_2.mouseUp", "bkg_1.mouseUp"]);
  });

  it("ignores messages nobody handles", async () => {
    const { bus, log, errors } = setup({});
    bus.post(msg("mouseUp", "prt_btn"));
    bus.post(msg("constructor", "crd_1")); // must not resolve to Object.prototype members
    await settle();
    expect(log).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe("arrow-key built-in (Requirement 2.5)", () => {
  it("goes to the next and previous card, wrapping at the ends", async () => {
    const { bus, store } = setup({});
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    bus.post(msg("keyDown", "crd_2", "ArrowLeft"));
    bus.post(msg("keyDown", "crd_1", "ArrowLeft"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_3");
  });

  it("does nothing when a handler takes keyDown, or for other keys", async () => {
    const { bus, store } = setup({ crd_1: { keyDown: [] } });
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    bus.post(msg("keyDown", "bkg_1", "x"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
  });

  it("navigates when the handler passes keyDown", async () => {
    const { bus, store } = setup({ crd_1: { keyDown: [pass("keyDown")] } });
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
  });
});

describe("Browse clicks in unlocked fields (Requirement 2.6)", () => {
  it("places the caret in unlocked fields and targets locked fields, parts or the card", () => {
    const { store } = setup({});
    const state = store.getSnapshot();
    expect(resolveBrowseClick(state, "prt_in")).toEqual({ action: "editField", partId: "prt_in", layer: "background" });
    expect(resolveBrowseClick(state, "prt_lbl")).toEqual({ action: "send", targetId: "prt_lbl" });
    expect(resolveBrowseClick(state, "prt_btn")).toEqual({ action: "send", targetId: "prt_btn" });
    expect(resolveBrowseClick(state, null)).toEqual({ action: "send", targetId: "crd_1" });
  });

  it("never sends mouse click messages targeting an unlocked field", async () => {
    const { bus, log } = setup({ crd_1: { mouseUp: [], mouseDown: [] } });
    bus.post(msg("mouseDown", "prt_in"));
    bus.post(msg("mouseUp", "prt_in"));
    bus.post(msg("mouseUp", "prt_lbl"));
    await settle();
    expect(log).toEqual(["crd_1.mouseUp"]);
  });
});

describe("mouse messages to disabled parts (Requirement 2.8)", () => {
  const mouseMessages = ["mouseDown", "mouseStillDown", "mouseUp", "mouseDoubleClick", "mouseEnter", "mouseWithin", "mouseLeave"];
  const handlersFor = (names: string[]): Scripts => Object.fromEntries(names.map((name) => [name, []]));
  const everyLevel = (handlers: Scripts): ScriptSet => ({ prt_btn: handlers, crd_1: handlers, bkg_1: handlers, stack: handlers });
  const disable = (store: ReturnType<typeof setup>["store"], partId: string, value = false): void =>
    store.applyRuntime({ type: "setPartProperty", partId, property: "enabled", value });

  it("delivers no mouse message of a disabled button to the part, card, background or stack", async () => {
    const { bus, store, log } = setup(everyLevel(handlersFor(mouseMessages)));
    disable(store, "prt_btn");
    for (const name of mouseMessages) bus.post(msg(name, "prt_btn"));
    await settle();
    expect(log).toEqual([]);
    expect(bus.pendingCount()).toBe(0);
  });

  it("delivers mouseUp to an enabled button, including one enabled again", async () => {
    const { bus, store, log } = setup(everyLevel(handlersFor(["mouseUp"])));
    bus.post(msg("mouseUp", "prt_btn"));
    await settle();
    disable(store, "prt_btn");
    disable(store, "prt_btn", true);
    bus.post(msg("mouseUp", "prt_btn"));
    await settle();
    expect(log).toEqual(["prt_btn.mouseUp", "prt_btn.mouseUp"]);
  });

  it("lets a disabled part capture the click: nothing reaches the part underneath or the card", async () => {
    const { bus, store, log } = setup({ crd_1: { mouseUp: [] } });
    const { stack } = store.getSnapshot();
    const under: HexButtonPart = { ...button(script({ mouseUp: [] })), id: "prt_under", name: "Under" };
    store.applyAuthoring({
      ...stack,
      cards: stack.cards.map((c) => (c.id === "crd_1" ? { ...c, parts: [under, ...c.parts] } : c)), // prt_btn stays on top
    });
    disable(store, "prt_btn");
    const click = resolveBrowseClick(store.getSnapshot(), "prt_btn"); // hit testing returned the disabled top part
    expect(click).toEqual({ action: "send", targetId: "prt_btn" });
    if (click.action === "send") bus.post(msg("mouseUp", click.targetId));
    await settle();
    expect(log).toEqual([]);
  });

  it("gives a disabled unlocked field no caret and drops its mouse messages", async () => {
    const { bus, store, log } = setup({ crd_1: { mouseUp: [] } });
    disable(store, "prt_in");
    expect(resolveBrowseClick(store.getSnapshot(), "prt_in")).toEqual({ action: "send", targetId: "prt_in" });
    bus.post(msg("mouseUp", "prt_in"));
    await settle();
    expect(log).toEqual([]);
  });

  it("drops a queued mouse message whose part was disabled before its dispatch started", async () => {
    const { bus, store, log, releaseAnswers } = setup({ crd_2: { openCard: [answer] }, prt_btn: { mouseUp: [] } });
    bus.post(msg("keyDown", "crd_1", "ArrowRight")); // -> crd_2, whose openCard suspends in answer
    await settle();
    bus.post(msg("mouseUp", "prt_btn"));
    expect(bus.pendingCount()).toBe(1);
    disable(store, "prt_btn");
    await releaseAnswers();
    expect(log).toEqual(["crd_2.openCard"]);
  });

  it("leaves non-mouse messages and nested (script/host) sends to a disabled part unaffected", async () => {
    const { bus, store, log } = setup(everyLevel({ keyDown: [], doIt: [], mouseUp: [] }));
    disable(store, "prt_btn");
    bus.post(msg("keyDown", "prt_btn", "x"));
    bus.post(msg("doIt", "prt_btn"));
    await settle();
    await bus.sendNested(msg("mouseUp", "prt_btn"), createDispatchContext({ abortSignal: new AbortController().signal, globals: new Map() }));
    expect(log).toEqual(["prt_btn.keyDown(x)", "prt_btn.doIt", "prt_btn.mouseUp"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Nested lifecycle dispatch (Requirements 2.4, 3.6)
// ---------------------------------------------------------------------------------------------

describe("nested lifecycle messages", () => {
  const lifecycle: Scripts = { closeCard: [], closeBackground: [], openBackground: [], openCard: [] };

  it("orders closeCard, closeBackground, openBackground, openCard when the background changes", async () => {
    const { bus, store, log, depths, contexts } = setup({ crd_2: lifecycle, crd_3: lifecycle });
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().currentCardId));
    bus.post(msg("keyDown", "crd_2", "ArrowRight"));
    await settle();
    expect(log).toEqual(["crd_2.closeCard", "crd_2.closeBackground", "crd_3.openBackground", "crd_3.openCard"]);
    expect(depths).toEqual([1, 1, 1, 1]);
    expect(contexts.size).toBe(1); // one shared DispatchContext (shared gas budget)
    expect(seen).toEqual(["crd_3"]); // the card changes once, between the close and open messages
  });

  it("sends only closeCard and openCard when the background stays the same", async () => {
    const { bus, log } = setup({ crd_1: lifecycle, crd_2: lifecycle });
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    await settle();
    expect(log).toEqual(["crd_1.closeCard", "crd_2.openCard"]);
  });

  it("delivers lifecycle messages inside the dispatch that ran go, sharing its context", async () => {
    const { bus, log, depths, contexts } = setup({ prt_btn: { mouseUp: [goNext] }, crd_1: lifecycle, crd_2: lifecycle });
    bus.post(msg("mouseUp", "prt_btn"));
    await settle();
    expect(log).toEqual(["prt_btn.mouseUp", "crd_1.closeCard", "crd_2.openCard"]);
    expect(depths).toEqual([0, 1, 1]);
    expect(contexts.size).toBe(1);
  });

  it("aborts with 'Too much recursion' when nesting exceeds 16 levels", async () => {
    const { bus, log, errors, store } = setup({ prt_btn: { mouseUp: [goNext] }, stack: { openCard: [goNext] } });
    bus.post(msg("mouseUp", "prt_btn"));
    await settle();
    expect(log.filter((entry) => entry === "stk_1.openCard")).toHaveLength(16);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).name).toBe("HexScriptError");
    expect((errors[0] as Error).message).toBe("Too much recursion");
    expect(bus.isRunning()).toBe(false);

    // The bus keeps working after the failed dispatch.
    const before = store.getSnapshot().currentCardId;
    bus.post(msg("keyDown", before, "x"));
    await settle();
    expect(bus.isRunning()).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Back history (Requirement 2.7)
// ---------------------------------------------------------------------------------------------

describe("go back history", () => {
  const lifecycle: Scripts = { closeCard: [], closeBackground: [], openBackground: [], openCard: [] };
  /** The stack script runs `go back` for a `goBack` message sent to any card. */
  const withGoBack = (scripts: ScriptSet = {}): ScriptSet => ({ ...scripts, stack: { goBack: [goBack] } });
  const newCtx = (): DispatchContext => createDispatchContext({ abortSignal: new AbortController().signal, globals: new Map() });

  it("pushes the departing card on every change except a no-op change to the current card", async () => {
    const { bus, store } = setup({ crd_2: { mouseUp: [goNext] } });
    bus.post(msg("keyDown", "crd_1", "ArrowRight")); // arrow-key built-in
    await settle();
    bus.post(msg("mouseUp", "crd_2")); // go next
    await settle();
    expect(bus.backHistory()).toEqual(["crd_1", "crd_2"]);

    await bus.changeCard("crd_1", newCtx()); // go by id
    await bus.changeCard("crd_1", newCtx()); // already there: no push
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(bus.backHistory()).toEqual(["crd_1", "crd_2", "crd_3"]);
  });

  it(`keeps at most ${MAX_BACK_HISTORY} entries, dropping the oldest`, () => {
    const { bus, store } = setup({});
    const order = ["crd_2", "crd_3", "crd_1"];
    const departed: string[] = [];
    for (let i = 0; i < MAX_BACK_HISTORY + 6; i += 1) {
      departed.push(store.getSnapshot().currentCardId);
      store.applyRuntime({ type: "goToCard", cardId: order[i % order.length] });
    }
    expect(bus.backHistory()).toEqual(departed.slice(-MAX_BACK_HISTORY));
  });

  it("goes to the most recent entry without pushing, then does nothing once the history is empty", async () => {
    const { bus, store, log, errors } = setup(withGoBack());
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    await settle();
    expect(bus.backHistory()).toEqual(["crd_1"]);

    bus.post(msg("goBack", "crd_2"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(bus.backHistory()).toEqual([]); // go back itself pushed nothing

    bus.post(msg("goBack", "crd_1"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual(["stk_1.goBack", "stk_1.goBack"]);
    expect(errors).toEqual([]);
  });

  it("sends no lifecycle messages and plays no transition when the history is empty", async () => {
    const { bus, log, errors, pendingAnswers } = setup(withGoBack({ crd_1: lifecycle }), { transition: true });
    bus.post(msg("goBack", "crd_1"));
    await settle();
    expect(log).toEqual(["stk_1.goBack"]);
    expect(pendingAnswers).toHaveLength(0);
    expect(errors).toEqual([]);
    expect(bus.isRunning()).toBe(false);
  });

  it("skips and removes entries whose card was deleted", async () => {
    const { bus, store } = setup(withGoBack());
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    bus.post(msg("keyDown", "crd_2", "ArrowRight"));
    await settle();
    expect(bus.backHistory()).toEqual(["crd_1", "crd_2"]);

    const { stack } = store.getSnapshot();
    store.applyAuthoring({ ...stack, cards: stack.cards.filter((c) => c.id !== "crd_2") });
    bus.post(msg("goBack", "crd_3"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(bus.backHistory()).toEqual([]);
  });

  it("skips and removes entries equal to the current card, and does nothing when only such entries remain", async () => {
    const { bus, store, log, errors, pendingAnswers, releaseAnswers } = setup(
      withGoBack({ crd_1: lifecycle, crd_2: lifecycle }),
      { transition: true },
    );
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    bus.post(msg("keyDown", "crd_2", "ArrowRight"));
    await settle();
    expect(bus.backHistory()).toEqual(["crd_1", "crd_2"]);

    // Deleting the current card crd_3 moves the store to crd_2, which is already in the history.
    let { stack } = store.getSnapshot();
    store.applyAuthoring({ ...stack, cards: stack.cards.filter((c) => c.id !== "crd_3") });
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    expect(bus.backHistory()).toEqual(["crd_1", "crd_2", "crd_3"]);

    // crd_3 (deleted) and crd_2 (current) are skipped; go back reaches crd_1.
    log.length = 0;
    bus.post(msg("goBack", "crd_2"));
    await settle();
    await releaseAnswers(); // the transition
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual(["stk_1.goBack", "crd_2.closeCard", "crd_1.openCard"]);
    expect(bus.backHistory()).toEqual([]);

    // Only a deleted card (crd_2) and the current card (crd_1) remain: go back does nothing.
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    await settle();
    ({ stack } = store.getSnapshot());
    store.applyAuthoring({ ...stack, cards: stack.cards.filter((c) => c.id !== "crd_2") });
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(bus.backHistory()).toEqual(["crd_1", "crd_2"]);

    log.length = 0;
    bus.post(msg("goBack", "crd_1"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual(["stk_1.goBack"]);
    expect(pendingAnswers).toHaveLength(0);
    expect(bus.backHistory()).toEqual([]);
    expect(errors).toEqual([]);
    expect(bus.isRunning()).toBe(false);
  });

  it("clears the history when the stack is replaced", async () => {
    const { bus, store, log } = setup(withGoBack());
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    bus.post(msg("keyDown", "crd_2", "ArrowRight"));
    await settle();
    expect(bus.backHistory()).toHaveLength(2);

    store.replaceStack(makeStack(withGoBack()));
    expect(bus.backHistory()).toEqual([]); // the switch to the new stack's first card is not pushed
    bus.post(msg("goBack", "crd_1"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual(["stk_1.goBack"]);
  });

  it("sends the lifecycle messages in order when go back changes the background", async () => {
    const { bus, store, log, depths } = setup(withGoBack({ crd_2: lifecycle, crd_3: lifecycle }));
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    bus.post(msg("keyDown", "crd_2", "ArrowRight"));
    await settle();
    log.length = 0;
    depths.length = 0;

    bus.post(msg("goBack", "crd_3"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    expect(log).toEqual([
      "stk_1.goBack", "crd_3.closeCard", "crd_3.closeBackground", "crd_2.openBackground", "crd_2.openCard",
    ]);
    expect(depths).toEqual([0, 1, 1, 1, 1]);
    expect(bus.backHistory()).toEqual(["crd_1"]);
  });
});

// ---------------------------------------------------------------------------------------------
// Queue (Requirements 3.1-3.4)
// ---------------------------------------------------------------------------------------------

describe("dispatch queue", () => {
  it("runs one dispatch at a time and keeps a suspended dispatch running", async () => {
    const { bus, log, releaseAnswers } = setup({ crd_1: { mouseUp: [answer], mouseDown: [], keyDown: [] } });
    bus.post(msg("mouseUp", "crd_1"));
    bus.post(msg("keyDown", "crd_1", "a"));
    bus.post(msg("mouseDown", "crd_1"));
    await settle();
    expect(log).toEqual(["crd_1.mouseUp"]);
    expect(bus.isRunning()).toBe(true);
    expect(bus.pendingCount()).toBe(2);

    await releaseAnswers();
    expect(log).toEqual(["crd_1.mouseUp", "crd_1.keyDown(a)", "crd_1.mouseDown"]);
    expect(bus.isRunning()).toBe(false);
  });

  it.each([
    ["ask", ask],
    ["fetch", fetchJson],
    ["wait", wait],
  ] as const)("keeps a dispatch suspended in %s running and queues new messages", async (_label, statement) => {
    const { bus, log, releaseAnswers } = setup({ crd_1: { mouseUp: [statement], keyDown: [] } });
    bus.post(msg("mouseUp", "crd_1"));
    await settle();
    bus.post(msg("keyDown", "crd_1", "a"));
    await settle();
    expect(bus.isRunning()).toBe(true);
    expect(bus.pendingCount()).toBe(1);
    expect(log).toEqual(["crd_1.mouseUp"]);

    await releaseAnswers();
    expect(log).toEqual(["crd_1.mouseUp", "crd_1.keyDown(a)"]);
    expect(bus.isRunning()).toBe(false);
  });

  it("keeps a dispatch suspended in a visual-effect transition running", async () => {
    const { bus, store, log, releaseAnswers } = setup(
      { prt_btn: { mouseUp: [goNext] }, crd_2: { openCard: [] }, crd_1: { keyDown: [] } },
      { transition: true },
    );
    bus.post(msg("mouseUp", "prt_btn"));
    bus.post(msg("keyDown", "crd_1", "a"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2"); // card changed, effect still playing
    expect(log).toEqual(["prt_btn.mouseUp"]);
    expect(bus.isRunning()).toBe(true);
    expect(bus.pendingCount()).toBe(1);

    await releaseAnswers();
    expect(log).toEqual(["prt_btn.mouseUp", "crd_2.openCard", "crd_1.keyDown(a)"]);
  });

  it("keeps at most 32 entries, dropping the oldest with a warning", async () => {
    const { bus, log, warnings, releaseAnswers } = setup({ crd_1: { mouseUp: [answer], mouseDown: [] } });
    bus.post(msg("mouseUp", "crd_1"));
    for (let i = 0; i < 40; i += 1) bus.post(msg("mouseDown", "crd_1", i));
    expect(bus.pendingCount()).toBe(32);
    expect(warnings).toHaveLength(8);

    await releaseAnswers();
    const expected = Array.from({ length: 32 }, (_, k) => `crd_1.mouseDown(${k + 8})`);
    expect(log).toEqual(["crd_1.mouseUp", ...expected]);
  });

  it("coalesces continuous messages to one pending entry per kind", async () => {
    const { bus, log, releaseAnswers } = setup({
      crd_1: { mouseUp: [answer], mouseWithin: [], idle: [], mouseStillDown: [], keyDown: [] },
    });
    bus.post(msg("mouseUp", "crd_1"));
    bus.post(msg("mouseWithin", "crd_1", 1));
    bus.post(msg("idle", "crd_1"));
    bus.post(msg("mouseWithin", "crd_1", 2));
    bus.post(msg("keyDown", "crd_1", "a"));
    bus.post(msg("idle", "crd_1"));
    bus.post(msg("mouseStillDown", "crd_1"));
    bus.post(msg("mouseStillDown", "crd_1"));
    bus.post(msg("keyDown", "crd_1", "a"));
    expect(bus.pendingCount()).toBe(5);

    await releaseAnswers();
    expect(log).toEqual([
      "crd_1.mouseUp", "crd_1.mouseWithin(2)", "crd_1.idle", "crd_1.keyDown(a)", "crd_1.mouseStillDown", "crd_1.keyDown(a)",
    ]);
  });
});

describe("dispatch queue model (Requirements 3.1, 3.3, 3.4)", () => {
  const DISCRETE = ["mouseDown", "mouseUp", "keyDown"] as const;
  const CONTINUOUS = ["mouseStillDown", "mouseWithin", "idle"] as const;
  const handlers: Scripts = Object.fromEntries([...DISCRETE, ...CONTINUOUS].map((name) => [name, []]));

  it("delivers any burst posted during a running dispatch in FIFO order with coalescing and overflow", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.constantFrom(...DISCRETE, ...CONTINUOUS), { maxLength: 80 }), async (names) => {
        const { bus, log, warnings, releaseAnswers } = setup({ crd_1: { ...handlers, suspend: [answer] } });
        bus.post(msg("suspend", "crd_1"));

        // Model of §3.2: FIFO, one pending entry per continuous kind (newest params, old position),
        // at most MAX_QUEUE_LENGTH entries with the oldest dropped on overflow.
        const model: { name: string; i: number }[] = [];
        let overflows = 0;
        names.forEach((name, i) => {
          bus.post(msg(name, "crd_1", i));
          const pending = (CONTINUOUS as readonly string[]).includes(name) ? model.findIndex((m) => m.name === name) : -1;
          if (pending >= 0) {
            model[pending] = { name, i };
            return;
          }
          model.push({ name, i });
          if (model.length > MAX_QUEUE_LENGTH) {
            model.shift();
            overflows += 1;
          }
        });
        expect(bus.pendingCount()).toBe(model.length);
        expect(warnings).toHaveLength(overflows);

        await releaseAnswers();
        expect(log).toEqual(["crd_1.suspend", ...model.map((m) => `crd_1.${m.name}(${m.i})`)]);
        expect(bus.isRunning()).toBe(false);
      }),
      { numRuns: 100 },
    );
  });
});

describe("idle timer (Requirement 3.5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("posts idle every 200 ms with the default interval scheduler", async () => {
    vi.useFakeTimers();
    const { bus, log } = setup({ crd_1: { idle: [] } }, { realInterval: true });
    await vi.advanceTimersByTimeAsync(IDLE_INTERVAL_MS - 1);
    expect(log).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(log).toEqual(["crd_1.idle"]);
    await vi.advanceTimersByTimeAsync(IDLE_INTERVAL_MS * 2);
    expect(log).toEqual(["crd_1.idle", "crd_1.idle", "crd_1.idle"]);

    bus.dispose();
    await vi.advanceTimersByTimeAsync(IDLE_INTERVAL_MS * 5);
    expect(log).toHaveLength(3);
  });

  it("posts idle to the current card only while every condition holds", async () => {
    const { bus, store, log, env, tickIdle, releaseAnswers } = setup({ crd_1: { idle: [], mouseUp: [answer] } });
    tickIdle();
    await settle();
    expect(log).toEqual(["crd_1.idle"]);

    env.modal = true;
    tickIdle();
    env.modal = false;
    env.visible = false;
    tickIdle();
    env.visible = true;
    store.setTool("button");
    tickIdle();
    store.setTool("browse");
    await settle();
    expect(log).toEqual(["crd_1.idle"]);

    bus.post(msg("mouseUp", "crd_1")); // a running dispatch blocks idle
    tickIdle();
    expect(bus.pendingCount()).toBe(0);
    await releaseAnswers();
    expect(log).toEqual(["crd_1.idle", "crd_1.mouseUp"]);
  });

  it("stops the idle timer on dispose", async () => {
    const { bus, log, tickIdle } = setup({ crd_1: { idle: [] } });
    bus.dispose();
    tickIdle();
    await settle();
    expect(log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Abort (Requirement 3.7)
// ---------------------------------------------------------------------------------------------

describe("abort", () => {
  it("aborts the running dispatch and clears the queue without reporting an error", async () => {
    const { bus, log, errors } = setup({ crd_1: { mouseUp: [answer], keyDown: [] } });
    bus.post(msg("mouseUp", "crd_1"));
    bus.post(msg("keyDown", "crd_1", "a"));
    bus.abort();
    await settle();
    expect(bus.isRunning()).toBe(false);
    expect(bus.pendingCount()).toBe(0);
    expect(log).toEqual(["crd_1.mouseUp"]);
    expect(errors).toEqual([]);

    bus.post(msg("keyDown", "crd_1", "b"));
    await settle();
    expect(log).toEqual(["crd_1.mouseUp", "crd_1.keyDown(b)"]);
  });

  it("aborts a dispatch suspended in a visual-effect transition before openCard runs", async () => {
    const { bus, log, errors, pendingAnswers } = setup(
      { prt_btn: { mouseUp: [goNext] }, crd_2: { openCard: [] }, crd_1: { keyDown: [] } },
      { transition: true },
    );
    bus.post(msg("mouseUp", "prt_btn"));
    bus.post(msg("keyDown", "crd_1", "a"));
    await settle();
    bus.abort();
    await settle();
    pendingAnswers.splice(0).forEach((release) => release()); // a late transition end changes nothing
    await settle();
    expect(log).toEqual(["prt_btn.mouseUp"]);
    expect(errors).toEqual([]);
    expect(bus.isRunning()).toBe(false);
    expect(bus.pendingCount()).toBe(0);
  });

  it("aborts when switching from Browse to an authoring tool", async () => {
    const { bus, store, log } = setup({ crd_1: { mouseUp: [answer], keyDown: [] } });
    bus.post(msg("mouseUp", "crd_1"));
    bus.post(msg("keyDown", "crd_1", "a"));
    store.setTool("pencil");
    await settle();
    expect(bus.isRunning()).toBe(false);
    expect(bus.pendingCount()).toBe(0);
    expect(log).toEqual(["crd_1.mouseUp"]);
  });

  it("recognises Cmd+. and Ctrl+. as the abort shortcut", () => {
    expect(isAbortShortcut({ key: ".", metaKey: true, ctrlKey: false })).toBe(true);
    expect(isAbortShortcut({ key: ".", metaKey: false, ctrlKey: true })).toBe(true);
    expect(isAbortShortcut({ key: ".", metaKey: false, ctrlKey: false })).toBe(false);
    expect(isAbortShortcut({ key: "a", metaKey: true, ctrlKey: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Opening the current stack (Requirement 2.9)
// ---------------------------------------------------------------------------------------------

describe("opening the current stack", () => {
  const openers: Scripts = { openStack: [], openBackground: [], openCard: [] };
  const lifecycle: Scripts = { ...openers, closeCard: [], closeBackground: [] };
  /** Card lifecycle handlers without openStack, so openStack reaches the stack's handler. */
  const cardLifecycle: Scripts = { closeCard: [], closeBackground: [], openBackground: [], openCard: [] };
  /** Without openBackground, so openBackground reaches the background's handler. */
  const cardOpenClose: Scripts = { closeCard: [], openCard: [] };

  it("posts openStack, openBackground and openCard to the current card, in that order", async () => {
    const { bus, store, log, contexts } = setup({ stack: { openStack: [] }, bkg_2: { openBackground: [] }, crd_3: { openCard: [] } });
    store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    bus.openCurrentStack();
    await settle();
    expect(log).toEqual(["stk_1.openStack", "bkg_2.openBackground", "crd_3.openCard"]);
    expect(contexts.size).toBe(3); // three posted top-level dispatches
    expect(bus.isRunning()).toBe(false);
  });

  it("aborts a suspended dispatch and drops previously queued messages", async () => {
    const { bus, log, errors, pendingAnswers } = setup({ crd_1: { mouseUp: [answer], keyDown: [], ...openers } });
    bus.post(msg("mouseUp", "crd_1"));
    bus.post(msg("keyDown", "crd_1", "a"));
    await settle();
    expect(bus.isRunning()).toBe(true);
    expect(bus.pendingCount()).toBe(1);

    bus.openCurrentStack();
    await settle();
    pendingAnswers.splice(0).forEach((release) => release()); // a late answer changes nothing
    await settle();
    expect(log).toEqual(["crd_1.mouseUp", "crd_1.openStack", "crd_1.openBackground", "crd_1.openCard"]);
    expect(errors).toEqual([]);
    expect(bus.isRunning()).toBe(false);
    expect(bus.pendingCount()).toBe(0);
  });

  it("runs automatically after store.replaceStack without closeCard/openCard for the switch", async () => {
    const { bus, store, log, errors } = setup({ crd_1: { mouseUp: [answer], keyDown: [] } });
    store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    bus.post(msg("mouseUp", "crd_1"));
    bus.post(msg("keyDown", "crd_1", "a")); // queued for the old stack: dropped
    await settle();

    store.replaceStack(makeStack({ crd_1: lifecycle, crd_3: lifecycle, bkg_1: lifecycle, stack: lifecycle }));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual(["crd_1.mouseUp", "crd_1.openStack", "crd_1.openBackground", "crd_1.openCard"]);
    expect(bus.backHistory()).toEqual([]);
    expect(errors).toEqual([]);
    expect(bus.isRunning()).toBe(false);
  });

  it("skips the original card's openBackground and openCard when an openStack handler runs go", async () => {
    const { bus, store, log, errors } = setup({ stack: { openStack: [goNext] }, crd_2: cardLifecycle, crd_3: cardLifecycle });
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    bus.openCurrentStack();
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_3");
    expect(log).toEqual([
      "stk_1.openStack", "crd_2.closeCard", "crd_2.closeBackground", "crd_3.openBackground", "crd_3.openCard",
    ]);
    expect(errors).toEqual([]);
    expect(bus.isRunning()).toBe(false);
    expect(bus.pendingCount()).toBe(0);
  });

  it("skips the original card's openCard when an openBackground handler runs go", async () => {
    const { bus, store, log } = setup({ stack: { openStack: [] }, bkg_1: { openBackground: [goNext] }, crd_1: cardOpenClose, crd_2: cardOpenClose });
    bus.openCurrentStack();
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    expect(log).toEqual(["stk_1.openStack", "bkg_1.openBackground", "crd_1.closeCard", "crd_2.openCard"]);
  });

  it("skips the rest of the sequence when go leaves the card and comes back", async () => {
    const { bus, store, log } = setup({ stack: { openStack: [goNext] }, crd_1: { openCard: [] }, crd_2: { openCard: [goBack] } });
    bus.openCurrentStack();
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual(["stk_1.openStack", "crd_2.openCard", "crd_1.openCard"]); // no second crd_1.openCard
  });

  it("skips the rest of the sequence after store.replaceStack when a handler runs go", async () => {
    const { bus, store, log, errors } = setup({});
    store.replaceStack(makeStack({ stack: { openStack: [goNext] }, crd_1: cardLifecycle, crd_2: cardLifecycle }));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    expect(log).toEqual(["stk_1.openStack", "crd_1.closeCard", "crd_2.openCard"]);
    expect(bus.backHistory()).toEqual(["crd_1"]);
    expect(errors).toEqual([]);
  });

  it("stops opening replaced stacks after dispose", async () => {
    const { bus, store, log } = setup({});
    bus.dispose();
    store.replaceStack(makeStack({ crd_1: openers, stack: openers }));
    await settle();
    expect(log).toEqual([]);
    expect(bus.pendingCount()).toBe(0);
  });
});
