/**
 * End-to-end `go` through the spec 01 message bus with the real parser, store and VM
 * (spec 02 task 5; Requirements 5.7, 4.2, 4.3; design spec §3.2 rules 5–7).
 */
import { describe, expect, it } from "vitest";
import { createMessageBus, resolveRelativeCard, type HexMessage, type MessageBus } from "../messageBus.ts";
import { parseHexTalk } from "../parser.ts";
import type { HexButtonPart, HexCard, HexStack } from "../schema.ts";
import { createHexStore, readFieldText, type HexStore } from "../store.ts";
import {
  HexScriptError,
  HexVmGasLimitError,
  resolveObjectTarget,
  toText,
  type HexHost,
  type HexValue,
  type PendingEffect,
} from "../vm.ts";

// ---------------------------------------------------------------------------------------------
// Fixture: "First" and "Second" use bkg_1, "Third" uses bkg_2. Scripts are HexTalk source.
// ---------------------------------------------------------------------------------------------

interface Scripts {
  stack?: string;
  crd_3?: string;
  prt_btn?: string;
}

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function card(id: string, name: string, backgroundId: string, scriptSource = "", parts: HexCard["parts"] = []): HexCard {
  return {
    id, name, backgroundId, bitmap: emptyBitmap, parts, bgFieldContents: {}, marked: false,
    cantDelete: false, dontSearch: false, scriptSource,
  };
}

function makeStack(scripts: Scripts): HexStack {
  const button: HexButtonPart = {
    id: "prt_btn", name: "Go", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true, enabled: true, scriptSource: scripts.prt_btn ?? "", style: "roundRect", title: "Go", showName: true,
    autoHilite: true, hilite: false,
  };
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      { id: "bkg_1", name: "Main", bitmap: emptyBitmap, scriptSource: "", cantDelete: false, parts: [] },
      { id: "bkg_2", name: "Other", bitmap: emptyBitmap, scriptSource: "", cantDelete: false, parts: [] },
    ],
    cards: [
      card("crd_1", "First", "bkg_1", "", [button]),
      card("crd_2", "Second", "bkg_1"),
      card("crd_3", "Third", "bkg_2", scripts.crd_3 ?? ""),
    ],
    customIcons: {}, scriptSource: scripts.stack ?? "",
  };
}

/** Appends `entry,` to the runtime global `log`, the same way the scripts below do. */
function appendLog(globals: Map<string, HexValue>, entry: string): void {
  globals.set("log", toText(globals.get("log") ?? "") + `${entry},`);
}

/**
 * Real store (compiled with `parseHexTalk`), real bus and the bus's default VM `runHandler`. The
 * host resolves `go` targets against the current snapshot and changes card through
 * `bus.changeCard`; a pending visual effect becomes the transition, which logs what it plays.
 */
function setup(scripts: Scripts) {
  const store: HexStore = createHexStore({ stack: makeStack(scripts), compile: parseHexTalk });
  for (const id of ["stk_1", "crd_3", "prt_btn"]) expect(store.getCompiled(id).errors).toEqual([]);

  const globals = new Map<string, HexValue>();
  const errors: unknown[] = [];
  const effects: (PendingEffect | null)[] = [];
  let bus: MessageBus | undefined;

  const host: HexHost = {
    readField: (ref) => readFieldText(store.getSnapshot().stack, ref.cardId, ref.layer, ref.partId),
    applyRuntime: (m) => store.applyRuntime(m),
    resolveObject: (t, me) => resolveObjectTarget(store.getSnapshot(), t, me),
    goToCard: async (target, effect, ctx) => {
      effects.push(effect);
      const state = store.getSnapshot();
      let cardId: string;
      const transition = effect
        ? () => {
          appendLog(globals, `effect ${effect.effect} ${effect.speed} to ${store.getSnapshot().currentCardId}`);
          return Promise.resolve();
        }
        : undefined;
      // `go back` is resolved by the bus, which owns the back history (spec 01 Requirement 2.7).
      if (target.type === "relative") {
        const { dir } = target;
        if (dir === "back") return bus!.changeCard({ type: "relative", dir }, ctx, transition);
        cardId = resolveRelativeCard(state, dir);
      } else {
        const found = resolveObjectTarget(state, { objectType: "card", selector: { by: target.type, value: target.value } }, state.currentCardId);
        if (found.kind !== "card") throw new HexScriptError("not a card");
        cardId = found.card.id;
      }
      await bus!.changeCard(cardId, ctx, transition);
    },
    playSound: () => undefined,
    showAnswer: (_prompt, buttons) => Promise.resolve(buttons[0]),
    showAsk: (_prompt, defaultAnswer) => Promise.resolve(defaultAnswer),
    fetchJson: () => Promise.resolve({ ok: false, reason: "blocked url" }),
    now: () => ({ date: "1/1/26", time: "12:00 PM", ticks: 0, seconds: 0, mouseH: 0, mouseV: 0 }),
  };

  bus = createMessageBus({
    store,
    host,
    globals,
    isPageVisible: () => true,
    isModalOpen: () => false,
    scheduleInterval: () => () => undefined,
    onError: (error) => errors.push(error),
    warn: () => undefined,
  });

  /** Posts the messages and waits until the bus has run all of them. */
  const run = async (...messages: HexMessage[]): Promise<void> => {
    for (const msg of messages) bus!.post(msg);
    do await new Promise((resolve) => setTimeout(resolve, 0));
    while (bus!.isRunning() || bus!.pendingCount() > 0);
  };

  return { store, bus, globals, errors, effects, run };
}

const click = (name = "mouseUp"): HexMessage => ({ name, params: [], targetId: "prt_btn" });

const lifecycleLogger = (name: string): string => [
  `on ${name}`,
  "  global log",
  `  put "${name} " & the name of this card & "," after log`,
  `end ${name}`,
].join("\n");

const LIFECYCLE_STACK_SCRIPT = ["closeCard", "closeBackground", "openBackground", "openCard"].map(lifecycleLogger).join("\n\n");

// ---------------------------------------------------------------------------------------------

describe("go through the message bus", () => {
  it.each([
    [
      "another background",
      "Third",
      "closeCard First,closeBackground First,effect dissolve fast to crd_3,openBackground Third,openCard Third,after 3,",
    ],
    [
      "the same background",
      "Second",
      "closeCard First,effect dissolve fast to crd_2,openCard Second,after 2,",
    ],
  ])("to %s sends the lifecycle messages in order and plays the pending effect", async (_label, destination, expected) => {
    const { store, globals, errors, effects, run } = setup({
      stack: LIFECYCLE_STACK_SCRIPT,
      prt_btn: [
        "on mouseUp",
        "  global log",
        "  visual effect dissolve fast",
        `  go to card "${destination}"`,
        '  put "after " & the number of this card & "," after log', // sees the new card (§3.2 rule 6)
        "end mouseUp",
      ].join("\n"),
    });

    await run(click());

    expect(errors).toEqual([]);
    expect(globals.get("log")).toBe(expected);
    expect(effects).toEqual([{ effect: "dissolve", speed: "fast" }]);
    expect(store.getSnapshot().currentCardId).toBe(destination === "Third" ? "crd_3" : "crd_2");
  });

  it("go back returns to the departed card with lifecycle messages and the effect, then does nothing", async () => {
    const { store, bus, globals, errors, effects, run } = setup({
      stack: LIFECYCLE_STACK_SCRIPT,
      prt_btn: [
        "on mouseUp",
        '  go to card "Third"',
        "end mouseUp",
      ].join("\n"),
      crd_3: [
        "on mouseUp",
        "  global log",
        "  visual effect dissolve fast",
        "  go back",
        '  put "after back " & the number of this card & "," after log',
        "end mouseUp",
      ].join("\n"),
    });

    await run(click());
    expect(bus.backHistory()).toEqual(["crd_1"]);
    globals.set("log", "");

    await run({ name: "mouseUp", params: [], targetId: "crd_3" });
    expect(errors).toEqual([]);
    expect(globals.get("log")).toBe(
      "closeCard Third,closeBackground Third,effect dissolve fast to crd_1,openBackground First,openCard First,after back 1,",
    );
    expect(effects).toEqual([null, { effect: "dissolve", speed: "fast" }]);
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(bus.backHistory()).toEqual([]); // go back pushed nothing

    // Empty history: the same handler's go back sends no lifecycle messages, plays no effect, and
    // the script continues on card 1.
    globals.set("log", "");
    await run({ name: "mouseUp", params: [], targetId: "crd_3" });
    expect(errors).toEqual([]);
    expect(globals.get("log")).toBe("after back 1,");
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
  });

  it("discards a visual effect that no go consumed when its dispatch ends", async () => {
    const { globals, errors, effects, run } = setup({
      prt_btn: [
        "on mouseDown",
        "  visual effect iris open",
        "end mouseDown",
        "",
        "on mouseUp",
        "  go next",
        "end mouseUp",
      ].join("\n"),
    });

    await run(click("mouseDown"), click("mouseUp"));

    expect(errors).toEqual([]);
    expect(effects).toEqual([null]);
    expect(globals.has("log")).toBe(false); // no transition was played
  });

  it("charges nested lifecycle handlers to the gas budget of the dispatch that ran go", async () => {
    const { store, globals, errors, run } = setup({
      // ~6,006 steps before go, ~6,003 in openCard: each fits the budget alone, together they do not.
      prt_btn: [
        "on mouseUp",
        "  global log",
        "  repeat 6000 times",
        "  end repeat",
        '  go to card "Third"',
        '  put "after," after log',
        "end mouseUp",
      ].join("\n"),
      crd_3: [
        "on openCard",
        "  repeat 6000 times",
        "  end repeat",
        "end openCard",
      ].join("\n"),
    });

    await run(click());

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(HexVmGasLimitError);
    expect(errors[0]).toMatchObject({ objectId: "crd_3", handler: "openCard", line: 2 });
    expect(store.getSnapshot().currentCardId).toBe("crd_3"); // the card change is kept
    expect(globals.has("log")).toBe(false); // the dispatch stopped inside go

    // A fresh top-level dispatch has a fresh budget: openCard alone completes.
    await run({ name: "openCard", params: [], targetId: "crd_3" });
    expect(errors).toHaveLength(1);
  });
});
