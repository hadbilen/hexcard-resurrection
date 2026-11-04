/**
 * Spec 04 task 4: Object Inspector commands, script editor helpers, studio windows, script error
 * dialogs (bomb / alert with Script button) and server rendering of the inspector.
 * Requirements 3.1, 3.2, 3.3, 3.4.
 */
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHistory } from "../../core/history.ts";
import type { HexMessage } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { THEME_PALETTES, type HexButtonPart, type HexFieldPart, type HexStack } from "../../core/schema.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { createHexStore } from "../../core/store.ts";
import { HexScriptError, HexVmGasLimitError } from "../../core/vm.ts";
import { createUiStoreView } from "../App.tsx";
import { inspectablePartAt } from "../CardViewport.tsx";
import { computeUiScale, menuBarHeight } from "../FloatingTools.tsx";
import {
  CHECKBOX_ON,
  GAS_LIMIT_MESSAGE,
  INSPECTOR_HEIGHT,
  INSPECTOR_TABS,
  INSPECTOR_WIDTH,
  ObjectInspector,
  WINDOW_DESKTOP_MARGIN,
  SCRIPT_BUTTON,
  createPropertiesCommand,
  createScriptCommand,
  createScriptErrorReporter,
  createStudioWindows,
  describeObject,
  errorMarkers,
  findObject,
  lineSpan,
  offsetAt,
  parseInteger,
  visualColumn,
} from "../ObjectInspector.tsx";
import { UiScaleContext, createModalManager } from "../System7Shell.tsx";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

const button: HexButtonPart = {
  id: "prt_go", name: "Go", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
  visible: true, enabled: true, scriptSource: "on mouseUp\n  go next\nend mouseUp", style: "roundRect", title: "",
  showName: true, autoHilite: true, hilite: false,
};

const field: HexFieldPart = {
  id: "prt_score", name: "Score", type: "field", layerScope: "background", rect: { x: 200, y: 10, width: 100, height: 40 },
  visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false, lockText: false,
  dontWrap: false, showLines: false, textAlign: "left", textFont: "System", textSize: 12, textStyle: [],
};

function makeStack(): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Test", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", ...THEME_PALETTES.ClassicPaper },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: emptyBitmap, parts: [field], scriptSource: "", cantDelete: false }],
    cards: [
      { id: "crd_1", name: "Hall", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [button], bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "" },
      { id: "crd_2", name: "", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [], bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "" },
    ],
    customIcons: {},
    scriptSource: "",
  };
}

function setup() {
  const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
  const history = createHistory(store);
  return { store, history };
}

const message: HexMessage = { name: "mouseUp", params: [], targetId: "prt_go" };

describe("objects", () => {
  it("finds the stack, backgrounds, cards and parts by id", () => {
    const stack = makeStack();
    expect(findObject(stack, "stk_1")?.kind).toBe("stack");
    expect(findObject(stack, "bkg_1")?.kind).toBe("background");
    expect(findObject(stack, "crd_2")?.kind).toBe("card");
    expect(findObject(stack, "prt_score")?.object).toBe(field);
    expect(findObject(stack, "prt_missing")).toBeUndefined();
  });

  it("names objects HyperCard style, by id when they have no name", () => {
    const stack = makeStack();
    expect(describeObject(stack, "prt_go")).toBe('card button "Go"');
    expect(describeObject(stack, "prt_score")).toBe('bg field "Score"');
    expect(describeObject(stack, "crd_1")).toBe('card "Hall"');
    expect(describeObject(stack, "crd_2")).toBe("card id crd_2");
    expect(describeObject(stack, "bkg_1")).toBe('background "Main"');
    expect(describeObject(stack, "stk_1")).toBe('stack "Test"');
    expect(describeObject(stack, "nope")).toBeUndefined();
  });
});

describe("script save (Requirement 3.2)", () => {
  it("stores scriptSource through the history, recompiles it and keeps the errors for the editor", () => {
    const { store, history } = setup();
    expect(Object.keys(store.getCompiled("prt_go").ast.handlers)).toEqual(["mouseup"]);

    history.execute(createScriptCommand("prt_go", "on mouseUp\n  put 1 into\nend mouseUp"));
    expect(history.undoLabel()).toBe("Script");
    expect((findObject(store.getSnapshot().stack, "prt_go")?.object as HexButtonPart).scriptSource).toContain("put 1 into");
    const { errors } = store.getCompiled("prt_go");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0].line).toBe(2);

    history.undo();
    expect(store.getCompiled("prt_go").errors).toEqual([]);
    expect(validateStack(store.getSnapshot().stack).ok).toBe(true);
  });

  it("saves scripts of cards, backgrounds and the stack too", () => {
    const { store, history } = setup();
    for (const id of ["crd_2", "bkg_1", "stk_1"]) {
      history.execute(createScriptCommand(id, "on openCard\nend openCard"));
      expect(Object.keys(store.getCompiled(id).ast.handlers)).toEqual(["opencard"]);
    }
    expect(validateStack(store.getSnapshot().stack).ok).toBe(true);
  });

  it("records nothing when the script is unchanged or the object is missing", () => {
    const { history } = setup();
    history.execute(createScriptCommand("prt_go", button.scriptSource));
    history.execute(createScriptCommand("prt_missing", "on x\nend x"));
    expect(history.canUndo()).toBe(false);
  });
});

describe("properties commands", () => {
  it("applies one undoable change and restores the previous values", () => {
    const { store, history } = setup();
    history.execute(createPropertiesCommand("prt_go", { name: "Next", rect: { x: 1, y: 2, width: 30, height: 12 }, family: 3 }));
    let part = findObject(store.getSnapshot().stack, "prt_go")?.object as HexButtonPart;
    expect(part).toMatchObject({ name: "Next", rect: { x: 1, y: 2, width: 30, height: 12 }, family: 3 });
    expect(history.undoLabel()).toBe("Properties");
    expect(validateStack(store.getSnapshot().stack).ok).toBe(true);

    history.undo();
    part = findObject(store.getSnapshot().stack, "prt_go")?.object as HexButtonPart;
    expect(part).toEqual(button);
    expect("family" in part).toBe(false);
  });

  it("removes a key set to undefined (no radio family) and undo puts it back", () => {
    const { store, history } = setup();
    history.execute(createPropertiesCommand("prt_go", { family: 2 }));
    history.execute(createPropertiesCommand("prt_go", { family: undefined }));
    expect("family" in (findObject(store.getSnapshot().stack, "prt_go")?.object as object)).toBe(false);
    history.undo();
    expect((findObject(store.getSnapshot().stack, "prt_go")?.object as HexButtonPart).family).toBe(2);
  });

  it("edits background fields, cards and the stack with structural sharing", () => {
    const { store, history } = setup();
    const before = store.getSnapshot().stack;
    history.execute(createPropertiesCommand("prt_score", { sharedText: true, textStyle: ["bold"] }));
    const after = store.getSnapshot().stack;
    expect(after.cards).toBe(before.cards);
    expect(after.backgrounds[0].parts[0]).toMatchObject({ sharedText: true, textStyle: ["bold"] });
    history.execute(createPropertiesCommand("crd_2", { marked: true }));
    history.execute(createPropertiesCommand("stk_1", { name: "Renamed" }));
    expect(store.getSnapshot().stack.cards[1].marked).toBe(true);
    expect(store.getSnapshot().stack.name).toBe("Renamed");
    expect(validateStack(store.getSnapshot().stack).ok).toBe(true);
  });

  it("parses integer inputs within their range only", () => {
    expect(parseInteger(" 12 ", 1, 20)).toBe(12);
    expect(parseInteger("-3", -5, 5)).toBe(-3);
    expect(parseInteger("0", 1, 5)).toBeUndefined();
    expect(parseInteger("1.5", 0, 5)).toBeUndefined();
    expect(parseInteger("", 0, 5)).toBeUndefined();
  });
});

describe("script text helpers", () => {
  const source = "on mouseUp\n\tput 1 into\nend mouseUp";

  it("finds line spans and offsets, clamped to the text", () => {
    expect(lineSpan(source, 1)).toEqual({ start: 0, end: 10 });
    expect(source.slice(lineSpan(source, 2).start, lineSpan(source, 2).end)).toBe("\tput 1 into");
    expect(lineSpan(source, 9)).toEqual(lineSpan(source, 3));
    expect(offsetAt(source, 2, 2)).toBe(12);
    expect(offsetAt(source, 2, 99)).toBe(lineSpan(source, 2).end);
  });

  it("expands tabs to the editor's tab size when placing a column marker", () => {
    expect(visualColumn("\tput", 1)).toBe(0);
    expect(visualColumn("\tput", 2)).toBe(2);
    expect(visualColumn("a\tb", 3)).toBe(2);
    expect(visualColumn("ab", 5)).toBe(4); // an error past the end of the line
    expect(errorMarkers(source, [{ line: 2, column: 12, message: "x" }])).toEqual([{ row: 1, cell: 12 }]);
  });

  it("draws a checked box as an X inside the frame", () => {
    expect(CHECKBOX_ON).toHaveLength(16);
    expect(CHECKBOX_ON[3][3]).toBe("#");
    expect(CHECKBOX_ON[3][12]).toBe("#");
  });
});

describe("studio windows", () => {
  it("opens one window at a time and notifies subscribers", () => {
    const windows = createStudioWindows();
    let calls = 0;
    windows.subscribe(() => calls++);
    windows.openInspector("prt_go");
    expect(windows.getSnapshot()).toMatchObject({ kind: "inspector", objectId: "prt_go", tab: "properties" });
    windows.openInspector("crd_1", "script", 4);
    expect(windows.getSnapshot()).toMatchObject({ kind: "inspector", objectId: "crd_1", tab: "script", line: 4 });
    windows.openStackGraph();
    expect(windows.getSnapshot()?.kind).toBe("stackGraph");
    expect(windows.isOpen()).toBe(true);
    windows.close();
    windows.close();
    expect(windows.getSnapshot()).toBeNull();
    expect(calls).toBe(4);
  });
});

describe("double-click opens the inspector (Requirement 3.1)", () => {
  it("returns the part of the tool's type on the edit layer, and nothing in Browse or paint tools", () => {
    const { store } = setup();
    const state = store.getSnapshot();
    expect(inspectablePartAt({ ...state, tool: "button" }, 20, 15)?.id).toBe("prt_go");
    expect(inspectablePartAt({ ...state, tool: "field" }, 20, 15)).toBeNull();
    expect(inspectablePartAt({ ...state, tool: "field", editLayer: "background" }, 210, 20)?.id).toBe("prt_score");
    expect(inspectablePartAt({ ...state, tool: "browse" }, 20, 15)).toBeNull();
    expect(inspectablePartAt({ ...state, tool: "pencil" }, 20, 15)).toBeNull();
  });
});

describe("script error dialogs", () => {
  it("shows the bomb dialog with object, handler and line for the gas limit (Requirement 3.3)", async () => {
    const modals = createModalManager();
    const report = createScriptErrorReporter({ getStack: makeStack, modals, openScript: () => {} });
    const done = report(new HexVmGasLimitError({ objectId: "prt_go", handler: "mouseUp", line: 3 }), message);
    const [dialog] = modals.getSnapshot();
    expect(dialog).toMatchObject({
      kind: "bomb",
      message: GAS_LIMIT_MESSAGE,
      details: ['Object: card button "Go"', "Handler: mouseUp", "Line: 3"],
      buttons: ["OK"],
    });
    modals.settle(dialog.id, "OK");
    await done;
    expect(modals.isOpen()).toBe(false);
  });

  it("shows an alert whose Script button opens the editor at the error line (Requirement 3.4)", async () => {
    const modals = createModalManager();
    const opened: [string, number][] = [];
    const report = createScriptErrorReporter({ getStack: makeStack, modals, openScript: (id, line) => opened.push([id, line]) });
    const done = report(new HexScriptError("Expected a number but found \"x\"", { objectId: "crd_1", handler: "openCard", line: 7 }), message);
    const [dialog] = modals.getSnapshot();
    expect(dialog).toMatchObject({
      kind: "alert",
      message: 'Expected a number but found "x"',
      details: ['Object: card "Hall"', "Handler: openCard", "Line: 7"],
      buttons: [SCRIPT_BUTTON, "OK"],
    });
    modals.settle(dialog.id, SCRIPT_BUTTON);
    await done;
    expect(opened).toEqual([["crd_1", 7]]);
  });

  it("opens nothing on OK, and offers no Script button when the object is gone", async () => {
    const modals = createModalManager();
    const opened: string[] = [];
    const report = createScriptErrorReporter({ getStack: makeStack, modals, openScript: (id) => opened.push(id) });
    const first = report(new HexScriptError("boom", { objectId: "prt_go", handler: "mouseUp", line: 2 }), message);
    modals.settle(modals.getSnapshot()[0].id, "OK");
    await first;
    const second = report(new HexScriptError("boom", { objectId: "prt_removed", handler: "mouseUp", line: 2 }), message);
    const [dialog] = modals.getSnapshot();
    expect(dialog).toMatchObject({ buttons: ["OK"], details: ["Object: id prt_removed", "Handler: mouseUp", "Line: 2"] });
    modals.settle(dialog.id, "OK");
    await second;
    expect(opened).toEqual([]);
  });

  it("reports errors without a location and non-script errors in a plain alert", async () => {
    const modals = createModalManager();
    const logged: unknown[] = [];
    const report = createScriptErrorReporter({ getStack: makeStack, modals, openScript: () => {}, log: (error) => logged.push(error) });
    void report(new HexScriptError("lost"), message);
    void report(new Error("internal"), message);
    const [unlocated, internal] = modals.getSnapshot();
    expect(unlocated).toMatchObject({ details: ["Object: unknown", "Handler: unknown", "Line: unknown"], buttons: ["OK"] });
    expect(internal).toMatchObject({ kind: "alert", details: ["internal"], buttons: ["OK"] });
    expect(logged).toHaveLength(2);
  });
});

describe("ObjectInspector rendering", () => {
  const render = (objectId: string, tab: "properties" | "script" | "spellcaster", mutate?: (store: ReturnType<typeof setup>) => void) => {
    const ctx = setup();
    mutate?.(ctx);
    return renderToStaticMarkup(
      createElement(UiScaleContext, { value: 2 },
        createElement(ObjectInspector, {
          store: createUiStoreView(ctx.store),
          history: ctx.history,
          request: { id: 1, kind: "inspector", objectId, tab },
          onClose: () => {},
        })),
    );
  };

  it("has the three tabs and the object in its title", () => {
    const html = render("prt_go", "properties");
    for (const tab of INSPECTOR_TABS) expect(html).toContain(`>${tab.label}</button>`);
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('aria-selected="true">Properties<');
    expect(html).toContain("Object Inspector: card button &quot;Go&quot;");
    expect(html).toContain('role="radio" aria-checked="true">roundRect<');
    expect(html).not.toMatch(/<select|type="checkbox"/);
  });

  it("shows the field-only properties, Shared Text only for background fields", () => {
    expect(render("prt_score", "properties")).toContain("Shared Text");
    expect(render("crd_1", "properties")).toContain("Marked");
  });

  it("shows stored compile errors inline: gutter mark, column marker and list entry", () => {
    const html = render("prt_go", "script", ({ history }) =>
      history.execute(createScriptCommand("prt_go", "on mouseUp\n  put 1 into\nend mouseUp")));
    expect(html).toContain('class="s7-script-line s7-script-line-error">2<');
    expect(html.match(/s7-script-line-error/g)).toHaveLength(1);
    expect(html.match(/data-testid="compile-error-marker"/g)?.length).toBeGreaterThan(0);
    expect(html).toMatch(/>Line 2, column \d+: [^<]+<\/button>/);
    expect(html).toContain("compile error");
  });

  it("reports a clean script and keeps the Spellcaster tab as a placeholder", () => {
    expect(render("prt_go", "script")).toContain("Compiled without errors");
    expect(render("prt_go", "spellcaster")).toContain("The HexAI Spellcaster is not available yet.");
  });

  it("has the same fixed window size on every tab, the error state included", () => {
    const size = `width:${INSPECTOR_WIDTH * 2}px;height:${INSPECTOR_HEIGHT * 2}px`;
    const withError = render("prt_go", "script", ({ history }) =>
      history.execute(createScriptCommand("prt_go", "on mouseUp\n  put 1 into\nend mouseUp")));
    for (const html of [render("prt_go", "properties"), render("prt_go", "script"), render("prt_go", "spellcaster"), withError]) {
      expect(html).toContain(`class="s7-window s7-inspector" style="${size}"`);
    }
    expect(withError).toContain('class="s7-tab-panel s7-tab-panel-script"');
  });

  it("fits inside the desktop below the menu bar at the UI scale of every viewport the 1x UI fits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 516, max: 6000 }), fc.integer({ min: 366, max: 4000 }), (width, height) => {
        const k = computeUiScale(width, height);
        const desktopHeight = height - menuBarHeight(k);
        expect((INSPECTOR_WIDTH + WINDOW_DESKTOP_MARGIN) * k).toBeLessThanOrEqual(width);
        expect((INSPECTOR_HEIGHT + WINDOW_DESKTOP_MARGIN) * k).toBeLessThanOrEqual(desktopHeight);
      }),
    );
  });

  it("renders nothing for a missing object", () => {
    expect(render("prt_missing", "properties")).toBe("");
  });

  it("uses only text the bundled fonts cover", () => {
    const text = render("prt_score", "properties").replace(/<[^>]*>/g, "");
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  });
});
