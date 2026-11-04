import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
