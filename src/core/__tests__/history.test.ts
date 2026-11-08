import { describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import {
  createHistory,
  HISTORY_LIMIT,
  PaintStrokeCommand,
  type BitmapCodec,
  type HexCommand,
  type PixelState,
} from "../history.ts";
import type { HexButtonPart, HexPart, HexStack } from "../schema.ts";
import { validateStack } from "../stackValidator.ts";
import {
  createHexStore,
  HexMutationError,
  resolveEditTarget,
  type CompiledScript,
  type HexEditTarget,
} from "../store.ts";

const WIDTH = 512;
const HEIGHT = 342;

function makeStack(): HexStack {
  return {
    id: "stk_1",
    schemaVersion: "2.0.0",
    name: "Start",
    author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: WIDTH, height: HEIGHT },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      { id: "bkg_1", name: "Main", bitmap: { width: WIDTH, height: HEIGHT, rleData: "" }, parts: [], scriptSource: "", cantDelete: false },
    ],
    cards: [
      {
        id: "crd_1",
        name: "First",
        backgroundId: "bkg_1",
        bitmap: { width: WIDTH, height: HEIGHT, rleData: "" },
        parts: [],
        bgFieldContents: {},
        marked: false,
        cantDelete: false,
        dontSearch: false,
        scriptSource: "",
      },
    ],
    customIcons: {},
    scriptSource: "",
  };
}

const compile = (): CompiledScript => ({ ast: { handlers: {} }, errors: [] });

function setup() {
  const stack = makeStack();
  expect(validateStack(stack).ok).toBe(true);
  const store = createHexStore({ stack, compile });
  const history = createHistory(store);
  return { store, history };
}

/** Renames the stack; remembers the previous name on apply so revert restores it. */
function renameStack(name: string): HexCommand {
  let previous: string | undefined;
  return {
    label: `Rename to ${name}`,
    apply(stack) {
      previous = stack.name;
      return { ...stack, name };
    },
    revert(stack) {
      return { ...stack, name: previous ?? stack.name };
    },
  };
}

/**
 * Stand-in for encodeBitmapRLE/decodeBitmapRLE (spec 03): all-transparent encodes to "" like the
 * real codec, everything else to "F" followed by one digit per pixel.
 */
const fakeCodec: BitmapCodec = {
  encode: (pixels) => (pixels.every((p) => p === 0) ? "" : `F${pixels.join("")}`),
  decode(rleData, emptyFill: PixelState) {
    if (rleData === "") return new Uint8Array(WIDTH * HEIGHT).fill(emptyFill);
    return Uint8Array.from(rleData.slice(1), Number);
  },
};

describe("history ring buffer (Requirement 5.1)", () => {
  it("keeps only the last 50 of 60 commands", () => {
    const { store, history } = setup();
    for (let i = 1; i <= 60; i++) history.execute(renameStack(`n${i}`));
    expect(store.getSnapshot().stack.name).toBe("n60");

    let undone = 0;
    while (history.undo()) undone++;
    expect(undone).toBe(HISTORY_LIMIT);
    expect(store.getSnapshot().stack.name).toBe("n10"); // commands 1-10 were discarded
    expect(history.canUndo()).toBe(false);
  });

  it("execute clears the redo list", () => {
    const { store, history } = setup();
    history.execute(renameStack("a"));
    history.execute(renameStack("b"));
    history.undo();
    expect(history.canRedo()).toBe(true);
    history.execute(renameStack("c"));
    expect(history.canRedo()).toBe(false);
    expect(history.redo()).toBe(false);
    expect(store.getSnapshot().stack.name).toBe("c");
  });

  it("does not record a command that throws or changes nothing", () => {
    const { store, history } = setup();
    const before = store.getSnapshot();
    expect(() => history.execute({ label: "Bad", apply: () => { throw new HexMutationError("nope"); }, revert: (s) => s }))
      .toThrow(HexMutationError);
    history.execute({ label: "No-op", apply: (s) => s, revert: (s) => s });
    expect(history.canUndo()).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });

  it("exposes Undo/Redo labels and clear()", () => {
    const { history } = setup();
    history.execute(renameStack("a"));
    expect(history.undoLabel()).toBe("Rename to a");
    history.undo();
    expect(history.redoLabel()).toBe("Rename to a");
    history.clear();
    expect(history.canUndo() || history.canRedo()).toBe(false);
  });
});

describe("undo/redo (Requirements 4.2, 4.3, 5.2)", () => {
  it("undo and redo restore deep-equal prior and later stacks", () => {
    const { store, history } = setup();
    const s0 = store.getSnapshot().stack;
    history.execute(renameStack("a"));
    const s1 = store.getSnapshot().stack;
    history.undo();
    expect(store.getSnapshot().stack).toEqual(s0);
    history.redo();
    expect(store.getSnapshot().stack).toEqual(s1);
  });

  it("runtime mutations never enter the history", () => {
    const { store, history } = setup();
    store.applyRuntime({ type: "setCardProperty", cardId: "crd_1", property: "name", value: "Runtime" });
    expect(history.canUndo()).toBe(false);
    history.execute(renameStack("a"));
    history.undo();
    expect(store.getSnapshot().stack.cards[0].name).toBe("Runtime");
    expect(history.undo()).toBe(false);
  });

  it("matches a model of past/present/future for any execute/undo/redo sequence", () => {
    const op = fc.constantFrom("execute", "undo", "redo");
    fc.assert(
      fc.property(fc.array(op, { maxLength: 120 }), (ops) => {
        const { store, history } = setup();
        const past: HexStack[] = [];
        const future: HexStack[] = [];
        let present = store.getSnapshot().stack;
        ops.forEach((kind, i) => {
          if (kind === "execute") {
            history.execute(renameStack(`n${i}`));
            past.push(present);
            if (past.length > HISTORY_LIMIT) past.shift();
            future.length = 0;
            present = store.getSnapshot().stack;
          } else if (kind === "undo") {
            expect(history.undo()).toBe(past.length > 0);
            if (past.length > 0) {
              future.push(present);
              present = past.pop()!;
            }
          } else {
            expect(history.redo()).toBe(future.length > 0);
            if (future.length > 0) {
              past.push(present);
              present = future.pop()!;
            }
          }
          expect(store.getSnapshot().stack).toEqual(present);
        });
      }),
      { numRuns: 100 },
    );
  });
});

describe("currentCardAfter (spec 05 Requirements 13.2, 13.3, 13.4)", () => {
  /** Inserts card `crd_new` after crd_1 and makes it current; revert removes it and returns to crd_1. */
  function addCard(steps: string[] = []): HexCommand {
    return {
      label: "New Card",
      apply(stack) {
        steps.push("apply");
        const [first, ...rest] = stack.cards;
        return { ...stack, cards: [first, { ...first, id: "crd_new", name: "Card 2" }, ...rest] };
      },
      revert(stack) {
        steps.push("revert");
        return { ...stack, cards: stack.cards.filter((card) => card.id !== "crd_new") };
      },
      currentCardAfter(step) {
        steps.push(`currentCardAfter:${step}`);
        return step === "apply" ? "crd_new" : "crd_1";
      },
    };
  }

  /** setup() with a second card crd_2 after crd_1. */
  function setupTwoCards() {
    const stack = makeStack();
    stack.cards.push({ ...stack.cards[0], id: "crd_2", name: "Second" });
    expect(validateStack(stack).ok).toBe(true);
    const store = createHexStore({ stack, compile });
    return { store, history: createHistory(store) };
  }

  it("makes the command's card current after execute, undo and redo, reading it right after each step", () => {
    const steps: string[] = [];
    const { store, history } = setupTwoCards();
    store.setTool("button");
    store.setEditLayer("background");
    const s0 = store.getSnapshot().stack;

    history.execute(addCard(steps));
    const s1 = store.getSnapshot().stack;
    expect(store.getSnapshot().currentCardId).toBe("crd_new");

    store.applyRuntime({ type: "goToCard", cardId: "crd_2" }); // the user navigates away meanwhile
    history.undo();
    expect(store.getSnapshot()).toMatchObject({ currentCardId: "crd_1", tool: "button", editLayer: "background" });
    expect(store.getSnapshot().stack).toEqual(s0);

    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    history.redo();
    expect(store.getSnapshot()).toMatchObject({ currentCardId: "crd_new", tool: "button", editLayer: "background" });
    expect(store.getSnapshot().stack).toEqual(s1);

    expect(steps).toEqual([
      "apply", "currentCardAfter:apply",
      "revert", "currentCardAfter:revert",
      "apply", "currentCardAfter:apply",
    ]);
  });

  it("publishes the stack and the current card in one state change", () => {
    const { store, history } = setupTwoCards();
    const listener = vi.fn();
    store.subscribe(listener);
    history.execute(addCard());
    expect(listener).toHaveBeenCalledTimes(1);
    history.undo();
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("leaves the current card alone for commands without it, or when it returns undefined", () => {
    const { store, history } = setupTwoCards();
    const applyAuthoring = vi.spyOn(store, "applyAuthoring");
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });

    history.execute(renameStack("a"));
    history.undo();
    history.redo();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    for (const call of applyAuthoring.mock.calls) expect(call).toHaveLength(1); // today's one-argument call

    history.execute({ ...renameStack("b"), currentCardAfter: () => undefined });
    history.undo();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
  });

  it("does not record a command whose card is missing from its result", () => {
    const { store, history } = setupTwoCards();
    const before = store.getSnapshot();
    expect(() => history.execute({ ...renameStack("a"), currentCardAfter: () => "crd_missing" }))
      .toThrow(HexMutationError);
    expect(history.canUndo()).toBe(false);
    expect(store.getSnapshot()).toBe(before);
  });
});

describe("PaintStrokeCommand (Requirement 5.3)", () => {
  const rect = { x: 510, y: 340, width: 2, height: 2 }; // bottom-right corner
  const pixelAt = (pixels: Uint8Array, x: number, y: number) => pixels[y * WIDTH + x];

  it("records a whole stroke as one command and restores the identical card layer", () => {
    const { store, history } = setup();
    const before = store.getSnapshot().stack;
    history.execute(new PaintStrokeCommand(
      { layer: "card", layerOwnerId: "crd_1", rect, before: new Uint8Array(4), after: Uint8Array.of(2, 0, 1, 2) },
      fakeCodec,
    ));
    const painted = store.getSnapshot().stack;
    const pixels = fakeCodec.decode(painted.cards[0].bitmap.rleData, 0);
    expect([pixelAt(pixels, 510, 340), pixelAt(pixels, 511, 340), pixelAt(pixels, 510, 341), pixelAt(pixels, 511, 341)])
      .toEqual([2, 0, 1, 2]);
    expect(pixels.reduce((sum, p) => sum + p, 0)).toBe(5); // nothing outside the rect changed
    expect(painted.backgrounds).toBe(before.backgrounds);

    expect(history.undo()).toBe(true);
    expect(store.getSnapshot().stack).toEqual(before);
    expect(history.redo()).toBe(true);
    expect(store.getSnapshot().stack).toEqual(painted);
  });

  it("restores an empty background layer exactly although it re-encodes as all-light", () => {
    const { store, history } = setup();
    const command = new PaintStrokeCommand(
      { layer: "background", layerOwnerId: "bkg_1", rect, before: Uint8Array.of(1, 1, 1, 1), after: Uint8Array.of(2, 2, 2, 2) },
      fakeCodec,
    );
    history.execute(command);
    const pixels = fakeCodec.decode(store.getSnapshot().stack.backgrounds[0].bitmap.rleData, 1);
    expect(pixelAt(pixels, 0, 0)).toBe(1);
    expect(pixelAt(pixels, 511, 341)).toBe(2);
    history.undo();
    expect(store.getSnapshot().stack.backgrounds[0].bitmap.rleData).toBe("");
  });

  it("re-patches pixels when the layer changed after the stroke", () => {
    const stack = makeStack();
    const command = new PaintStrokeCommand(
      { layer: "card", layerOwnerId: "crd_1", rect: { x: 0, y: 0, width: 1, height: 1 }, before: Uint8Array.of(0), after: Uint8Array.of(2) },
      fakeCodec,
    );
    const painted = command.apply(stack);
    // Another stroke elsewhere changes the layer; undo must keep it and only restore pixel (0, 0).
    const other = fakeCodec.decode(painted.cards[0].bitmap.rleData, 0);
    other[WIDTH + 1] = 2;
    const edited = { ...painted, cards: [{ ...painted.cards[0], bitmap: { ...painted.cards[0].bitmap, rleData: fakeCodec.encode(other) } }] };
    const reverted = fakeCodec.decode(command.revert(edited).cards[0].bitmap.rleData, 0);
    expect(pixelAt(reverted, 0, 0)).toBe(0);
    expect(pixelAt(reverted, 1, 1)).toBe(2);
  });

  it("rejects mismatched pixel buffers, out-of-layer rects and unknown owners", () => {
    const stroke = { layer: "card" as const, layerOwnerId: "crd_1", rect, before: new Uint8Array(4), after: new Uint8Array(4) };
    expect(() => new PaintStrokeCommand({ ...stroke, after: new Uint8Array(3) }, fakeCodec)).toThrow(HexMutationError);
    expect(() => new PaintStrokeCommand({ ...stroke, rect: { ...rect, x: 0.5 } }, fakeCodec)).toThrow(HexMutationError);
    expect(() => new PaintStrokeCommand({ ...stroke, rect: { ...rect, x: 511 } }, fakeCodec).apply(makeStack()))
      .toThrow(HexMutationError);
    expect(() => new PaintStrokeCommand({ ...stroke, layerOwnerId: "crd_9" }, fakeCodec).apply(makeStack()))
      .toThrow(HexMutationError);
  });

  it("keeps private copies of the stroke buffers", () => {
    const after = Uint8Array.of(2, 2, 2, 2);
    const command = new PaintStrokeCommand({ layer: "card", layerOwnerId: "crd_1", rect, before: new Uint8Array(4), after }, fakeCodec);
    after.fill(0);
    const pixels = fakeCodec.decode(command.apply(makeStack()).cards[0].bitmap.rleData, 0);
    expect(pixelAt(pixels, 511, 341)).toBe(2);
  });
});

describe("Edit Background routing of authoring commands (Requirement 1.4)", () => {
  /** Part creation as an authoring tool would build it: the part goes to resolveEditTarget's owner. */
  function newButtonCommand(target: HexEditTarget): HexCommand {
    const part: HexButtonPart = {
      id: "prt_new", name: "New", type: "button", layerScope: target.layer, rect: { x: 0, y: 0, width: 80, height: 20 },
      visible: true, enabled: true, scriptSource: "", style: "roundRect", title: "New", showName: true,
      autoHilite: true, hilite: false,
    };
    const add = <T extends { id: string; parts: HexPart[] }>(owner: T): T =>
      owner.id === target.owner.id ? { ...owner, parts: [...owner.parts, part] } : owner;
    const remove = <T extends { id: string; parts: HexPart[] }>(owner: T): T =>
      owner.id === target.owner.id ? { ...owner, parts: owner.parts.filter((p) => p.id !== part.id) } : owner;
    return {
      label: "New Button",
      apply: (stack) => ({ ...stack, cards: stack.cards.map(add), backgrounds: stack.backgrounds.map(add) }),
      revert: (stack) => ({ ...stack, cards: stack.cards.map(remove), backgrounds: stack.backgrounds.map(remove) }),
    };
  }

  it("sends paint strokes and new parts to the current card's background in Edit Background mode", () => {
    const { store, history } = setup();
    store.setEditLayer("background");
    const target = resolveEditTarget(store.getSnapshot());
    const before = store.getSnapshot().stack;

    history.execute(new PaintStrokeCommand(
      { layer: target.layer, layerOwnerId: target.owner.id, rect: { x: 0, y: 0, width: 1, height: 1 }, before: Uint8Array.of(1), after: Uint8Array.of(2) },
      fakeCodec,
    ));
    history.execute(newButtonCommand(target));

    const { stack } = store.getSnapshot();
    expect(fakeCodec.decode(stack.backgrounds[0].bitmap.rleData, 1)[0]).toBe(2);
    expect(stack.cards[0].bitmap).toBe(before.cards[0].bitmap);
    expect(stack.backgrounds[0].parts.map((p) => [p.id, p.layerScope])).toEqual([["prt_new", "background"]]);
    expect(stack.cards[0].parts).toEqual([]);
    expect(validateStack(structuredClone(stack)).ok).toBe(true);
  });

  it("sends them to the card when Edit Background is off", () => {
    const { store, history } = setup();
    history.execute(newButtonCommand(resolveEditTarget(store.getSnapshot())));
    const { stack } = store.getSnapshot();
    expect(stack.cards[0].parts.map((p) => [p.id, p.layerScope])).toEqual([["prt_new", "card"]]);
    expect(stack.backgrounds[0].parts).toEqual([]);
    expect(validateStack(structuredClone(stack)).ok).toBe(true);
  });
});

describe("history wiring", () => {
  it("hands every result to store.applyAuthoring", () => {
    const { store } = setup();
    const applyAuthoring = vi.spyOn(store, "applyAuthoring");
    const history = createHistory(store);
    history.execute(renameStack("a"));
    history.undo();
    history.redo();
    expect(applyAuthoring).toHaveBeenCalledTimes(3);
  });
});
