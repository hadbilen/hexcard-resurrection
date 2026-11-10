import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fc from "fast-check";
import type { HexScriptAST } from "../ast.ts";
import type { HexButtonPart, HexFieldPart, HexStack } from "../schema.ts";
import { validateStack } from "../stackValidator.ts";
import {
  createHexStore,
  createScriptCache,
  HexMutationError,
  readFieldText,
  resolveEditTarget,
  resolveVisibleContent,
  type CompiledScript,
  type HexStoreOptions,
} from "../store.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function makeField(overrides: Partial<HexFieldPart> & Pick<HexFieldPart, "id">): HexFieldPart {
  return {
    name: "Field",
    type: "field",
    layerScope: "background",
    rect: { x: 10, y: 40, width: 200, height: 100 },
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
    textFont: "System",
    textSize: 12,
    textStyle: [],
    ...overrides,
  };
}

function makeButton(overrides: Partial<HexButtonPart> & Pick<HexButtonPart, "id">): HexButtonPart {
  return {
    name: "Button",
    type: "button",
    layerScope: "card",
    rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true,
    enabled: true,
    scriptSource: "on mouseUp\n  go next card\nend mouseUp",
    style: "roundRect",
    title: "Next",
    showName: true,
    autoHilite: true,
    hilite: false,
    ...overrides,
  };
}

/** Two backgrounds; crd_1 and crd_2 share bkg_1, crd_3 uses bkg_2. */
function makeStack(): HexStack {
  return {
    id: "stk_1",
    schemaVersion: "2.0.0",
    name: "Test Stack",
    author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      {
        id: "bkg_1",
        name: "Main",
        bitmap: { width: 512, height: 342, rleData: "BG" },
        parts: [
          makeField({ id: "prt_unshared", sharedText: false, content: "ignored" }),
          makeField({ id: "prt_shared", sharedText: true, content: "Shared" }),
        ],
        scriptSource: "on openBackground\nend openBackground",
        cantDelete: false,
      },
      { id: "bkg_2", name: "Other", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false },
    ],
    cards: [
      {
        id: "crd_1",
        name: "First",
        backgroundId: "bkg_1",
        bitmap: { width: 512, height: 342, rleData: "CD" },
        parts: [
          makeField({ id: "prt_card_fld", layerScope: "card", content: "Card text" }),
          makeButton({ id: "prt_btn" }),
        ],
        bgFieldContents: { prt_unshared: "One" },
        marked: false,
        cantDelete: false,
        dontSearch: false,
        scriptSource: "on openCard\nend openCard",
      },
      {
        id: "crd_2",
        name: "Second",
        backgroundId: "bkg_1",
        bitmap: emptyBitmap,
        parts: [],
        bgFieldContents: {},
        marked: false,
        cantDelete: false,
        dontSearch: false,
        scriptSource: "",
      },
      {
        id: "crd_3",
        name: "Third",
        backgroundId: "bkg_2",
        bitmap: emptyBitmap,
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

/** Number of script owners in makeStack(): stack + 2 backgrounds + 3 cards + 4 parts. */
const SCRIPT_OWNER_COUNT = 10;

/**
 * Small deterministic stand-in for parseHexTalk (spec 02 is not implemented yet): one handler per
 * "on <name>" line; the word "BROKEN" produces a compile error, "CRASH" makes the compiler throw.
 */
function testCompile(source: string): CompiledScript {
  if (source.includes("CRASH")) throw new Error("compiler crashed");
  const handlers: HexScriptAST["handlers"] = {};
  for (const line of source.split("\n")) {
    const match = /^on (\w+)/.exec(line.trim());
    if (match) handlers[match[1].toLowerCase()] = { eventName: match[1], params: [], body: [] };
  }
  if (source.includes("BROKEN")) {
    return { ast: { handlers }, errors: [{ line: 2, column: 3, message: "Expected end" }] };
  }
  return { ast: { handlers }, errors: [] };
}

function setup(overrides: Partial<HexStoreOptions> = {}) {
  const compile = vi.fn(testCompile);
  const autoSave = vi.fn<(stack: HexStack) => void>();
  const store = createHexStore({ stack: makeStack(), compile, autoSave, ...overrides });
  return { store, compile, autoSave };
}

describe("setFieldText / readFieldText sharedText matrix (Requirements 1.2, 1.3)", () => {
  it("card fields read and write their own content", () => {
    const { store } = setup();
    store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "card", partId: "prt_card_fld", text: "New" });
    const { stack } = store.getSnapshot();
    expect(stack.cards[0].parts[0]).toMatchObject({ content: "New" });
    expect(readFieldText(stack, "crd_1", "card", "prt_card_fld")).toBe("New");
  });

  it("unshared background fields use bgFieldContents of that card only", () => {
    const { store } = setup();
    const before = store.getSnapshot().stack;
    expect(readFieldText(before, "crd_1", "background", "prt_unshared")).toBe("One");
    expect(readFieldText(before, "crd_2", "background", "prt_unshared")).toBe(""); // missing entry

    store.applyRuntime({ type: "setFieldText", cardId: "crd_2", layer: "background", partId: "prt_unshared", text: "Two" });
    const after = store.getSnapshot().stack;
    expect(after.cards[1].bgFieldContents).toEqual({ prt_unshared: "Two" });
    expect(readFieldText(after, "crd_2", "background", "prt_unshared")).toBe("Two");
    expect(readFieldText(after, "crd_1", "background", "prt_unshared")).toBe("One");
    expect(after.backgrounds[0].parts[0]).toMatchObject({ content: "ignored" });
    expect(after.backgrounds).toBe(before.backgrounds);
  });

  it("shared background fields write HexFieldPart.content on the background for every card", () => {
    const { store } = setup();
    store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "background", partId: "prt_shared", text: "Hi all" });
    const { stack } = store.getSnapshot();
    expect(stack.backgrounds[0].parts[1]).toMatchObject({ content: "Hi all" });
    expect(readFieldText(stack, "crd_1", "background", "prt_shared")).toBe("Hi all");
    expect(readFieldText(stack, "crd_2", "background", "prt_shared")).toBe("Hi all");
    expect(stack.cards[0].bgFieldContents).toEqual({ prt_unshared: "One" });
    expect(stack.cards[1].bgFieldContents).toEqual({});
  });

  it("matches a per-card / per-background model for any sequence of writes", () => {
    const write = fc.record({
      cardId: fc.constantFrom("crd_1", "crd_2"),
      partId: fc.constantFrom("prt_unshared", "prt_shared"),
      text: fc.string({ maxLength: 8 }),
    });
    fc.assert(
      fc.property(fc.array(write, { maxLength: 30 }), (writes) => {
        const { store } = setup();
        let shared = "Shared";
        const unshared: Record<string, string> = { crd_1: "One", crd_2: "" };
        for (const w of writes) {
          store.applyRuntime({ type: "setFieldText", layer: "background", ...w });
          if (w.partId === "prt_shared") shared = w.text;
          else unshared[w.cardId] = w.text;
        }
        const { stack } = store.getSnapshot();
        for (const cardId of ["crd_1", "crd_2"]) {
          expect(readFieldText(stack, cardId, "background", "prt_shared")).toBe(shared);
          expect(readFieldText(stack, cardId, "background", "prt_unshared")).toBe(unshared[cardId]);
          expect(Object.keys(stack.cards.find((c) => c.id === cardId)!.bgFieldContents)).not.toContain("prt_shared");
        }
        expect(stack.backgrounds[0].parts[0]).toMatchObject({ content: "ignored" }); // unshared content untouched
        expect(stack.backgrounds[0].parts[1]).toMatchObject({ content: shared });
        expect(validateStack(structuredClone(stack)).ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it("rejects unknown fields, buttons and fields of another background without changing state", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    expect(() => store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "card", partId: "prt_btn", text: "x" }))
      .toThrow(HexMutationError);
    expect(() => store.applyRuntime({ type: "setFieldText", cardId: "crd_3", layer: "background", partId: "prt_shared", text: "x" }))
      .toThrow(HexMutationError);
    expect(() => store.applyRuntime({ type: "setFieldText", cardId: "crd_9", layer: "card", partId: "prt_card_fld", text: "x" }))
      .toThrow(HexMutationError);
    expect(store.getSnapshot()).toBe(before);
  });
});

describe("snapshots (Requirement 4.1)", () => {
  it("returns a new frozen snapshot per change, shares untouched objects and keeps old snapshots intact", () => {
    const { store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    const beforeCopy = structuredClone(before);

    store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "card", partId: "prt_card_fld", text: "Changed" });
    const after = store.getSnapshot();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(after).not.toBe(before);
    expect(after.stack).not.toBe(before.stack);
    expect(after.stack.cards[0]).not.toBe(before.stack.cards[0]);
    expect(after.stack.cards[0].parts[1]).toBe(before.stack.cards[0].parts[1]);
    expect(after.stack.cards[1]).toBe(before.stack.cards[1]);
    expect(after.stack.backgrounds).toBe(before.stack.backgrounds);
    expect(after.stack.themePalette).toBe(before.stack.themePalette);
    expect(before).toEqual(beforeCopy);

    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.stack.cards[0].parts[0])).toBe(true);
    expect(() => {
      (after.stack.cards[0] as { name: string }).name = "Hacked";
    }).toThrow(TypeError);
  });

  it("keeps the same snapshot and does not notify for no-op writes", () => {
    const { store, autoSave } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    const before = store.getSnapshot();
    store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "card", partId: "prt_card_fld", text: "Card text" });
    store.applyRuntime({ type: "setFieldText", cardId: "crd_2", layer: "background", partId: "prt_unshared", text: "" });
    store.applyRuntime({ type: "setPartProperty", partId: "prt_btn", property: "rect", value: "10,10,90,30" });
    store.applyRuntime({ type: "goToCard", cardId: "crd_1" });
    expect(store.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    expect(autoSave).not.toHaveBeenCalled();
  });

  it("does not let the caller's stack object affect the store", () => {
    const stack = makeStack();
    const store = createHexStore({ stack, compile: testCompile });
    stack.name = "Mutated outside";
    expect(store.getSnapshot().stack.name).toBe("Test Stack");
    expect(Object.isFrozen(stack)).toBe(false);
  });

  it("unsubscribe stops notifications", () => {
    const { store } = setup();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("runtime mutations", () => {
  it("goToCard changes the current card without touching the stack", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    expect(store.getSnapshot().currentCardId).toBe("crd_3");
    expect(store.getSnapshot().stack).toBe(before.stack);
    expect(() => store.applyRuntime({ type: "goToCard", cardId: "crd_404" })).toThrow(HexMutationError);
  });

  it("converts rect and location strings to HexRect", () => {
    const { store } = setup();
    store.applyRuntime({ type: "setPartProperty", partId: "prt_btn", property: "rect", value: "20,30,120,60" });
    expect(store.getSnapshot().stack.cards[0].parts[1].rect).toEqual({ x: 20, y: 30, width: 100, height: 30 });
    store.applyRuntime({ type: "setPartProperty", partId: "prt_btn", property: "location", value: "200, 100" });
    expect(store.getSnapshot().stack.cards[0].parts[1].rect).toEqual({ x: 150, y: 85, width: 100, height: 30 });
  });

  it("coerces booleans, enums and text styles", () => {
    const { store } = setup();
    store.applyRuntime({ type: "setPartProperty", partId: "prt_btn", property: "hilite", value: "TRUE" });
    store.applyRuntime({ type: "setPartProperty", partId: "prt_btn", property: "style", value: "roundrect" });
    store.applyRuntime({ type: "setPartProperty", partId: "prt_shared", property: "textSize", value: "18" });
    store.applyRuntime({ type: "setPartProperty", partId: "prt_shared", property: "textStyle", value: "Bold, italic,bold" });
    store.applyRuntime({ type: "setCardProperty", cardId: "crd_2", property: "marked", value: true });
    store.applyRuntime({ type: "setBackgroundProperty", backgroundId: "bkg_2", property: "name", value: "Renamed" });
    store.applyRuntime({ type: "setStackProperty", property: "name", value: "My Stack" });
    const { stack } = store.getSnapshot();
    expect(stack.cards[0].parts[1]).toMatchObject({ hilite: true, style: "roundRect" });
    expect(stack.backgrounds[0].parts[1]).toMatchObject({ textSize: 18, textStyle: ["bold", "italic"] });
    expect(stack.cards[1].marked).toBe(true);
    expect(stack.backgrounds[1].name).toBe("Renamed");
    expect(stack.name).toBe("My Stack");
    expect(validateStack(stack).ok).toBe(true);
  });

  it("rejects invalid property/object combinations and values without changing state", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    const invalid = [
      { partId: "prt_btn", property: "lockText", value: true },
      { partId: "prt_card_fld", property: "hilite", value: true },
      { partId: "prt_btn", property: "marked", value: true },
      { partId: "prt_btn", property: "rect", value: "10,10,5,5" },
      { partId: "prt_btn", property: "visible", value: "maybe" },
      { partId: "prt_card_fld", property: "textSize", value: 13 },
      { partId: "prt_missing", property: "name", value: "x" },
    ] as const;
    for (const m of invalid) {
      expect(() => store.applyRuntime({ type: "setPartProperty", ...m })).toThrow(HexMutationError);
    }
    expect(store.getSnapshot()).toBe(before);
  });
});

describe("visible content and Edit Background routing (Requirements 1.1, 1.4)", () => {
  it("returns the background bitmap and parts beneath the card's in §5.6 order", () => {
    const { store } = setup();
    const { stack } = store.getSnapshot();
    const content = resolveVisibleContent(stack, "crd_1");
    expect(content.background.id).toBe("bkg_1");
    expect(content.layers.map((l) => `${l.layer}:${l.kind}`)).toEqual([
      "background:bitmap", "background:parts", "card:bitmap", "card:parts",
    ]);
    expect(content.layers[0]).toMatchObject({ bitmap: { rleData: "BG" } });
    expect(content.layers[1]).toMatchObject({ parts: stack.backgrounds[0].parts });
    expect(content.layers[2]).toMatchObject({ bitmap: { rleData: "CD" } });
    expect(content.layers[3]).toMatchObject({ parts: stack.cards[0].parts });
  });

  it("routes authoring targets to the current card's background while Edit Background is on", () => {
    const { store, autoSave } = setup();
    expect(resolveEditTarget(store.getSnapshot())).toMatchObject({ layer: "card", owner: { id: "crd_1" } });

    store.setEditLayer("background");
    expect(store.getSnapshot().editLayer).toBe("background");
    expect(resolveEditTarget(store.getSnapshot())).toMatchObject({ layer: "background", owner: { id: "bkg_1" } });

    store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    expect(resolveEditTarget(store.getSnapshot())).toMatchObject({ layer: "background", owner: { id: "bkg_2" } });

    store.setTool("pencil");
    expect(store.getSnapshot().tool).toBe("pencil");
    expect(autoSave).not.toHaveBeenCalled();
  });
});

describe("ScriptCache (Requirements 4.4, 4.5)", () => {
  it("compiles every object on load and serves the ASTs by id", () => {
    const { store, compile } = setup();
    expect(compile).toHaveBeenCalledTimes(SCRIPT_OWNER_COUNT);
    expect(Object.keys(store.getCompiled("prt_btn").ast.handlers)).toEqual(["mouseup"]);
    expect(Object.keys(store.getCompiled("bkg_1").ast.handlers)).toEqual(["openbackground"]);
    expect(store.getCompiled("stk_1")).toEqual({ ast: { handlers: {} }, errors: [] });
    expect(store.getCompiled("prt_unknown")).toEqual({ ast: { handlers: {} }, errors: [] });
  });

  it("stores an empty AST plus errors for failing scripts and keeps loading", () => {
    const stack = makeStack();
    stack.cards[0].scriptSource = "on openCard\n  BROKEN";
    stack.cards[1].scriptSource = "CRASH";
    const { store } = setup({ stack });

    expect(store.getCompiled("crd_1")).toEqual({
      ast: { handlers: {} },
      errors: [{ line: 2, column: 3, message: "Expected end" }],
    });
    const crashed = store.getCompiled("crd_2");
    expect(crashed.ast).toEqual({ handlers: {} });
    expect(crashed.errors).toEqual([{ line: 1, column: 1, message: "Script could not be compiled: compiler crashed" }]);
    expect(Object.keys(store.getCompiled("prt_btn").ast.handlers)).toEqual(["mouseup"]);
    expect(store.getSnapshot().stack.cards).toHaveLength(3);
  });

  it("never puts an AST into the stack snapshot", () => {
    const { store } = setup();
    store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "card", partId: "prt_card_fld", text: "x" });
    const { stack } = store.getSnapshot();
    expect(validateStack(structuredClone(stack))).toMatchObject({ ok: true }); // strict schema: no extra keys
    expect(JSON.stringify(stack)).not.toContain("handlers");
  });

  it("replaceStack recompiles everything and resets the card and edit layer", () => {
    const { store, compile } = setup();
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    store.setEditLayer("background");
    store.setTool("button");
    compile.mockClear();

    const replacement = makeStack();
    replacement.cards[2].scriptSource = "on openCard\nend openCard";
    store.replaceStack(replacement);

    expect(compile).toHaveBeenCalledTimes(SCRIPT_OWNER_COUNT);
    expect(Object.keys(store.getCompiled("crd_3").ast.handlers)).toEqual(["opencard"]);
    expect(store.getSnapshot()).toMatchObject({ currentCardId: "crd_1", editLayer: "card", tool: "button" });
  });

  it("sync recompiles only objects whose scriptSource changed and drops removed ones", () => {
    const compile = vi.fn(testCompile);
    const cache = createScriptCache(compile);
    const stack = makeStack();
    cache.rebuild(stack);
    compile.mockClear();

    const edited = structuredClone(stack);
    edited.cards[1].scriptSource = "on closeCard\nend closeCard";
    edited.cards.pop();
    cache.sync(edited);

    expect(compile).toHaveBeenCalledTimes(1);
    expect(compile).toHaveBeenCalledWith("on closeCard\nend closeCard");
    expect(Object.keys(cache.get("crd_2").ast.handlers)).toEqual(["closecard"]);
    expect(cache.get("crd_3")).toEqual({ ast: { handlers: {} }, errors: [] });
  });
});

describe("auto-save (Requirement 4.3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("debounces runtime writes by 500 ms and saves the latest stack once", () => {
    const { store, autoSave } = setup();
    for (const text of ["a", "ab", "abc"]) {
      store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "card", partId: "prt_card_fld", text });
      vi.advanceTimersByTime(300);
    }
    expect(autoSave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(autoSave).toHaveBeenCalledTimes(1);
    expect(autoSave).toHaveBeenCalledWith(store.getSnapshot().stack);
    expect(readFieldText(autoSave.mock.calls[0][0], "crd_1", "card", "prt_card_fld")).toBe("abc");
  });

  it("does not save for navigation or UI state changes", () => {
    const { store, autoSave } = setup();
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    store.setEditLayer("background");
    store.setTool("field");
    vi.advanceTimersByTime(1000);
    expect(autoSave).not.toHaveBeenCalled();
  });

  it("flushes a pending save of the old stack before replaceStack", () => {
    const { store, autoSave } = setup();
    store.applyRuntime({ type: "setStackProperty", property: "name", value: "Unsaved" });
    store.replaceStack(makeStack());
    expect(autoSave).toHaveBeenCalledTimes(1);
    expect(autoSave.mock.calls[0][0].name).toBe("Unsaved");
    vi.advanceTimersByTime(1000);
    expect(autoSave).toHaveBeenCalledTimes(1);
  });
});

describe("applyAuthoring (Requirements 4.2, 4.4)", () => {
  it("recompiles only changed scripts, compiles added objects and drops removed ones", () => {
    const { store, compile } = setup();
    compile.mockClear();
    const current = store.getSnapshot().stack;
    const card1 = current.cards[0];
    const next: HexStack = {
      ...current,
      cards: [
        { ...card1, scriptSource: "on closeCard\nend closeCard", parts: [card1.parts[0], makeButton({ id: "prt_new", scriptSource: "on mouseDown" })] },
        current.cards[1],
        { ...current.cards[2], name: "Renamed" },
      ],
    };
    store.applyAuthoring(next);

    expect(compile.mock.calls.map(([source]) => source).sort()).toEqual(["on closeCard\nend closeCard", "on mouseDown"]);
    expect(Object.keys(store.getCompiled("crd_1").ast.handlers)).toEqual(["closecard"]);
    expect(Object.keys(store.getCompiled("prt_new").ast.handlers)).toEqual(["mousedown"]);
    expect(store.getCompiled("prt_btn")).toEqual({ ast: { handlers: {} }, errors: [] }); // removed
  });

  it("stores an empty AST plus errors when an edited script fails to compile", () => {
    const { store } = setup();
    const current = store.getSnapshot().stack;
    store.applyAuthoring({ ...current, scriptSource: "on openStack\n  BROKEN" });
    expect(store.getCompiled("stk_1")).toEqual({
      ast: { handlers: {} },
      errors: [{ line: 2, column: 3, message: "Expected end" }],
    });
  });

  it("publishes a frozen, structurally shared snapshot and notifies listeners", () => {
    const { store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    const current = store.getSnapshot().stack;
    store.applyAuthoring({ ...current, cards: [{ ...current.cards[0], name: "Edited" }, ...current.cards.slice(1)] });

    const { stack } = store.getSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(stack.cards[0].name).toBe("Edited");
    expect(Object.isFrozen(stack.cards[0])).toBe(true);
    expect(Object.isFrozen(stack.cards)).toBe(true);
    expect(stack.backgrounds).toBe(current.backgrounds);
    expect(stack.cards[1]).toBe(current.cards[1]);

    store.applyAuthoring(stack); // same stack: no-op
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("keeps the card position when the current card is removed and rejects removing every card", () => {
    const { store } = setup();
    store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    const current = store.getSnapshot().stack;
    store.applyAuthoring({ ...current, cards: current.cards.slice(0, 2) });
    expect(store.getSnapshot().currentCardId).toBe("crd_2");

    const before = store.getSnapshot();
    expect(() => store.applyAuthoring({ ...before.stack, cards: [] })).toThrow(HexMutationError);
    expect(store.getSnapshot()).toBe(before);
  });

  it("schedules a debounced auto-save", () => {
    vi.useFakeTimers();
    try {
      const { store, autoSave } = setup();
      const current = store.getSnapshot().stack;
      store.applyAuthoring({ ...current, name: "Authored" });
      vi.advanceTimersByTime(500);
      expect(autoSave).toHaveBeenCalledTimes(1);
      expect(autoSave.mock.calls[0][0].name).toBe("Authored");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("applyAuthoring with a current card (spec 05 Requirements 13.2, 13.3)", () => {
  it("makes the given card current in the same published state", () => {
    const { store } = setup();
    const listener = vi.fn();
    store.subscribe(listener);
    const current = store.getSnapshot().stack;
    store.applyAuthoring({ ...current, name: "Authored" }, "crd_3");
    expect(store.getSnapshot()).toMatchObject({ currentCardId: "crd_3", stack: { name: "Authored" } });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("rejects a card that is not in the result before anything is published", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    const current = before.stack;
    expect(() => store.applyAuthoring({ ...current, cards: current.cards.slice(1) }, "crd_1")).toThrow(HexMutationError);
    expect(store.getSnapshot()).toBe(before);
  });

  it("switches the current card for an unchanged stack without an auto-save", () => {
    vi.useFakeTimers();
    try {
      const { store, autoSave } = setup();
      const { stack } = store.getSnapshot();
      store.applyAuthoring(stack, "crd_2");
      expect(store.getSnapshot()).toMatchObject({ stack, currentCardId: "crd_2" });
      const before = store.getSnapshot();
      store.applyAuthoring(stack, "crd_2"); // nothing changes
      expect(store.getSnapshot()).toBe(before);
      vi.advanceTimersByTime(500);
      expect(autoSave).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("part selection (spec 05 Requirements 10.1, 10.2, 14.1)", () => {
  it("starts empty and is set only for a part of the active part tool's type on the edit target", () => {
    const { store } = setup();
    expect(store.getSnapshot().selectedPartId).toBeNull();
    expect(() => store.setSelectedPart("prt_btn")).toThrow(HexMutationError); // Browse tool

    store.setTool("button");
    store.setSelectedPart("prt_btn");
    expect(store.getSnapshot().selectedPartId).toBe("prt_btn");

    const before = store.getSnapshot();
    expect(() => store.setSelectedPart("prt_card_fld")).toThrow(HexMutationError); // a field, Button tool
    expect(() => store.setSelectedPart("prt_shared")).toThrow(HexMutationError); // background layer
    expect(() => store.setSelectedPart("prt_missing")).toThrow(HexMutationError);
    expect(store.getSnapshot()).toBe(before);
    store.setSelectedPart("prt_btn"); // same selection: no new snapshot
    expect(store.getSnapshot()).toBe(before);

    store.setSelectedPart(null);
    expect(store.getSnapshot().selectedPartId).toBeNull();
  });

  it("selects background parts only in Edit Background mode", () => {
    const { store } = setup();
    store.setTool("field");
    expect(() => store.setSelectedPart("prt_shared")).toThrow(HexMutationError);
    store.setSelectedPart("prt_card_fld");
    store.setEditLayer("background");
    expect(store.getSnapshot().selectedPartId).toBeNull();
    expect(() => store.setSelectedPart("prt_card_fld")).toThrow(HexMutationError);
    store.setSelectedPart("prt_shared");
    expect(store.getSnapshot().selectedPartId).toBe("prt_shared");
  });

  it("is cleared when the tool, the current card or the edit layer changes, and by replaceStack", () => {
    const { store } = setup();
    const select = () => {
      store.setTool("button");
      store.setEditLayer("card");
      if (store.getSnapshot().currentCardId !== "crd_1") store.applyRuntime({ type: "goToCard", cardId: "crd_1" });
      store.setSelectedPart("prt_btn");
      expect(store.getSnapshot().selectedPartId).toBe("prt_btn");
    };

    select();
    store.setTool("field");
    expect(store.getSnapshot().selectedPartId).toBeNull();

    select();
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    expect(store.getSnapshot().selectedPartId).toBeNull();

    select();
    store.setEditLayer("background");
    expect(store.getSnapshot().selectedPartId).toBeNull();

    select();
    store.applyAuthoring(store.getSnapshot().stack, "crd_2"); // current card changed by an authoring step
    expect(store.getSnapshot().selectedPartId).toBeNull();

    select();
    store.replaceStack(makeStack());
    expect(store.getSnapshot()).toMatchObject({ tool: "button", currentCardId: "crd_1", selectedPartId: null });
  });

  it("follows the part through stack changes and is cleared once the part is gone (e.g. after Undo)", () => {
    const { store } = setup();
    store.setTool("button");
    store.setSelectedPart("prt_btn");

    store.applyRuntime({ type: "setPartProperty", partId: "prt_btn", property: "rect", value: "0,0,50,20" });
    const moved = store.getSnapshot().stack;
    store.applyAuthoring({ ...moved, name: "Edited" });
    expect(store.getSnapshot().selectedPartId).toBe("prt_btn");

    const current = store.getSnapshot().stack;
    const [first, ...rest] = current.cards;
    store.applyAuthoring({ ...current, cards: [{ ...first, parts: first.parts.filter((p) => p.id !== "prt_btn") }, ...rest] });
    expect(store.getSnapshot().selectedPartId).toBeNull();
  });

  it("is cleared when the selected id now names a part of another type", () => {
    const { store } = setup();
    store.setTool("button");
    store.setSelectedPart("prt_btn");
    const current = store.getSnapshot().stack;
    const [first, ...rest] = current.cards;
    const asField = { ...first.parts[0], id: "prt_btn" };
    store.applyAuthoring({ ...current, cards: [{ ...first, parts: [asField] }, ...rest] });
    expect(store.getSnapshot().selectedPartId).toBeNull();
  });

  it("is never saved", () => {
    vi.useFakeTimers();
    try {
      const { store, autoSave } = setup();
      store.setTool("button");
      store.setSelectedPart("prt_btn");
      vi.advanceTimersByTime(500);
      expect(autoSave).not.toHaveBeenCalled();
      store.applyAuthoring({ ...store.getSnapshot().stack, name: "Saved" });
      vi.advanceTimersByTime(500);
      expect(autoSave).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(autoSave.mock.calls[0][0])).not.toContain("selectedPartId");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("found text (spec 06 Requirements 4.8, 4.9, 12.2)", () => {
  const onCard = { cardId: "crd_1", layer: "card" as const, partId: "prt_card_fld", start: 5, end: 9, text: "Card text" };
  const onBackground = { cardId: "crd_1", layer: "background" as const, partId: "prt_unshared", start: 0, end: 3, text: "One" };

  it("starts empty and accepts a found text on a visible field of the current card", () => {
    const { store } = setup();
    expect(store.getSnapshot().found).toBeNull();
    store.setFound(onCard);
    expect(store.getSnapshot().found).toEqual(onCard);
    expect(Object.isFrozen(store.getSnapshot().found)).toBe(true);
    store.setFound(onBackground);
    expect(store.getSnapshot().found).toEqual(onBackground);
    const before = store.getSnapshot();
    store.setFound({ ...onBackground }); // equal value: no new snapshot
    expect(store.getSnapshot()).toBe(before);
    store.setFound(null);
    expect(store.getSnapshot().found).toBeNull();
  });

  it("rejects a found text that is not on the current card, not a visible field, not its text or out of range", () => {
    const { store } = setup();
    const before = store.getSnapshot();
    const invalid = [
      { ...onCard, cardId: "crd_2" },
      { ...onCard, partId: "prt_btn" },
      { ...onCard, partId: "prt_gone" },
      { ...onCard, layer: "background" as const },
      { ...onCard, text: "Other text" },
      { ...onCard, start: 4, end: 4 },
      { ...onCard, start: -1 },
      { ...onCard, end: 10 },
      { ...onCard, start: 1.5 },
      { ...onBackground, partId: "prt_shared", text: "One" },
    ];
    for (const found of invalid) expect(() => store.setFound(found), JSON.stringify(found)).toThrow(HexMutationError);
    store.applyRuntime({ type: "setPartProperty", partId: "prt_card_fld", property: "visible", value: false });
    expect(() => store.setFound(onCard)).toThrow(HexMutationError);
    expect(store.getSnapshot().found).toBeNull();
    expect(before.found).toBeNull();
  });

  it("is cleared when the current card changes, the field's text changes, the field is hidden or removed, or a stack is loaded", () => {
    const { store } = setup();
    store.setFound(onCard);
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    expect(store.getSnapshot().found).toBeNull();
    store.applyRuntime({ type: "goToCard", cardId: "crd_1" });
    expect(store.getSnapshot().found).toBeNull(); // coming back does not restore it

    store.setFound(onCard);
    store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "card", partId: "prt_card_fld", text: "Card texts" });
    expect(store.getSnapshot().found).toBeNull();

    store.setFound(onBackground);
    store.applyRuntime({ type: "setPartProperty", partId: "prt_unshared", property: "visible", value: false });
    expect(store.getSnapshot().found).toBeNull();

    store.setFound({ ...onCard, text: "Card texts", end: 10 });
    const stack = store.getSnapshot().stack;
    store.applyAuthoring({ ...stack, cards: stack.cards.map((card) => (card.id === "crd_1" ? { ...card, parts: [] } : card)) });
    expect(store.getSnapshot().found).toBeNull();

    const fresh = setup();
    fresh.store.setFound(onCard);
    fresh.store.replaceStack(makeStack());
    expect(fresh.store.getSnapshot().found).toBeNull();
  });

  it("is kept across tool changes, Edit Background and unrelated stack changes", () => {
    const { store } = setup();
    store.setFound(onCard);
    store.setTool("button");
    store.setEditLayer("background");
    store.applyRuntime({ type: "setFieldText", cardId: "crd_1", layer: "background", partId: "prt_unshared", text: "Changed" });
    store.applyRuntime({ type: "setStackProperty", property: "name", value: "Renamed" });
    expect(store.getSnapshot().found).toEqual(onCard);
  });
});
