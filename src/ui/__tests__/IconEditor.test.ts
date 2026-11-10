/**
 * Spec 06 task 3.2, Requirements 10.1-10.12, 11.3, 13.2: the Icon Editor window. The component is
 * rendered to static markup; its rules (initial choice, enabled states, the command behind each
 * button) are pure functions tested directly against a real store and history.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHistory } from "../../core/history.ts";
import { BLANK_ICON, createCopyIconCommand, createNewIconCommand, createRenameIconCommand, encodeIcon, ICON_PIXELS } from "../../core/icons.ts";
import { THEME_PALETTES, type HexButtonPart, type HexStack } from "../../core/schema.ts";
import { createHexStore } from "../../core/store.ts";
import { BUILT_IN_ICONS } from "../../presets/builtInIcons.ts";
import {
  BUILT_IN_HEADING,
  ICON_EDITOR_BUTTONS,
  ICON_EDITOR_TITLE,
  IconEditor,
  cellLine,
  createUseIconCommand,
  iconDataOf,
  iconEditorEnabled,
  initialIconChoice,
  scrollTopToShowRow,
  selectedButton,
  validIconChoice,
  type IconChoice,
} from "../IconEditor.tsx";
import { createStudioWindows } from "../ObjectInspector.tsx";
import { createModalManager } from "../System7Shell.tsx";

const emptyBitmap = { width: 512, height: 342, rleData: "" };
const STAR = BUILT_IN_ICONS.find((icon) => icon.name === "hex-star")!;
const dot = (() => {
  const pixels = new Uint8Array(ICON_PIXELS);
  pixels[0] = 1;
  return encodeIcon(pixels);
})();

function button(id: string, extra: Partial<HexButtonPart> = {}): HexButtonPart {
  return {
    id, name: id, type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 60, height: 60 }, visible: true,
    enabled: true, scriptSource: "", style: "rectangle", title: id, showName: false, autoHilite: false,
    hilite: false, ...extra,
  };
}

function makeStack(customIcons: Record<string, string> = {}, iconId?: string): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Icons", author: "", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", ...THEME_PALETTES.ClassicPaper },
    backgrounds: [{ id: "bkg_1", name: "Bg", bitmap: emptyBitmap, scriptSource: "", cantDelete: false, parts: [] }],
    cards: [{
      id: "crd_1", name: "One", backgroundId: "bkg_1", bitmap: emptyBitmap, bgFieldContents: {}, marked: false,
      cantDelete: false, dontSearch: false, scriptSource: "",
      parts: [button("prt_b1", iconId === undefined ? {} : { iconId })],
    }],
    customIcons,
    scriptSource: "",
  };
}

function setup(customIcons: Record<string, string> = {}, iconId?: string, select = true) {
  const store = createHexStore({ stack: makeStack(customIcons, iconId), compile: () => ({ ast: { handlers: {} }, errors: [] }) });
  const history = createHistory(store);
  if (select) {
    store.setTool("button");
    store.setSelectedPart("prt_b1");
  }
  return { store, history, modals: createModalManager() };
}

const stackChoice = (name: string): IconChoice => ({ kind: "stack", name });
const builtInChoice = (name: string): IconChoice => ({ kind: "builtIn", name });

function visibleText(html: string): string {
  return html.replace(/<[^>]*>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
}

describe("Icon Editor window", () => {
  it("is a studio window, so the message bus treats it as modal", () => {
    const windows = createStudioWindows();
    windows.openIconEditor();
    expect(windows.getSnapshot()?.kind).toBe("iconEditor");
    expect(windows.isOpen()).toBe(true);
  });

  it("renders the title, both lists, the grid and all eight buttons in printable ASCII (Requirements 10.1, 13.2)", () => {
    const t = setup({ "My Icon": dot });
    const html = renderToStaticMarkup(createElement(IconEditor, { ...t, onClose: () => {} }));
    const text = visibleText(html);
    expect(text).toMatch(/^[\x20-\x7e]*$/);
    expect(text).toContain(ICON_EDITOR_TITLE);
    expect(text).toContain(BUILT_IN_HEADING);
    expect(text).toContain("My Icon");
    for (const icon of BUILT_IN_ICONS) expect(text).toContain(icon.name);
    for (const label of ICON_EDITOR_BUTTONS) expect(text).toContain(label);
    expect(html.match(/role="option"/g)).toHaveLength(1 + BUILT_IN_ICONS.length);
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(html).toMatch(/<canvas[^>]*width="256" height="256"/);
    expect(text).toContain("My Icon");
    expect(html).not.toContain("(built-in)");
  });

  it("marks a selected built-in icon as built-in and draws a 50% dim over disabled buttons", () => {
    const t = setup({}, undefined, false);
    const html = renderToStaticMarkup(createElement(IconEditor, { ...t, onClose: () => {} }));
    expect(visibleText(html)).toContain(`${BUILT_IN_ICONS[0].name} (built-in)`);
    // No stack icons, no selected button, nothing to undo: Rename, Delete, Use for Button, No Icon, Undo.
    expect(html.match(/disabled=""/g)).toHaveLength(5);
    expect(html.match(/class="s7-dim"/g)).toHaveLength(5);
  });
});

describe("initial choice (Requirement 10.2)", () => {
  it("selects the selected button's icon, else the first stack icon, else the first built-in icon", () => {
    const withIcon = setup({ a: BLANK_ICON, b: dot }, "b");
    expect(initialIconChoice(withIcon.store.getSnapshot())).toEqual(stackChoice("b"));

    const buttonWithout = setup({ a: BLANK_ICON, b: dot });
    expect(initialIconChoice(buttonWithout.store.getSnapshot())).toEqual(stackChoice("a"));

    const noSelection = setup({ a: BLANK_ICON, b: dot }, "b", false);
    expect(initialIconChoice(noSelection.store.getSnapshot())).toEqual(stackChoice("a"));

    const none = setup({}, undefined, false);
    expect(initialIconChoice(none.store.getSnapshot())).toEqual(builtInChoice(BUILT_IN_ICONS[0].name));
    expect(selectedButton(withIcon.store.getSnapshot())?.id).toBe("prt_b1");
    expect(selectedButton(noSelection.store.getSnapshot())).toBeUndefined();
  });
});

describe("enabled states (Requirements 10.9, 10.11, 10.12)", () => {
  it("with a stack icon and a selected button without that icon", () => {
    const { store } = setup({ a: BLANK_ICON });
    expect(iconEditorEnabled(store.getSnapshot(), stackChoice("a"), false)).toEqual({
      New: true, Duplicate: true, "Rename...": true, Delete: true, "Add to Stack": false,
      "Use for Button": true, "No Icon": false, Undo: false,
    });
  });

  it("disables Use for Button when the button already has the icon, and enables No Icon", () => {
    const { store } = setup({ a: BLANK_ICON, b: dot }, "a");
    const state = store.getSnapshot();
    expect(iconEditorEnabled(state, stackChoice("a"), true)).toMatchObject({ "Use for Button": false, "No Icon": true, Undo: true });
    expect(iconEditorEnabled(state, stackChoice("b"), true)).toMatchObject({ "Use for Button": true, "No Icon": true });
  });

  it("disables Rename and Delete for a built-in icon, enables Add to Stack, and keeps Use for Button on", () => {
    const { store } = setup({ a: BLANK_ICON }, "a");
    expect(iconEditorEnabled(store.getSnapshot(), builtInChoice(STAR.name), false)).toEqual({
      New: true, Duplicate: true, "Rename...": false, Delete: false, "Add to Stack": true,
      "Use for Button": true, "No Icon": true, Undo: false,
    });
  });

  it("disables Use for Button and No Icon without a selected button", () => {
    const { store } = setup({ a: BLANK_ICON }, "a", false);
    expect(iconEditorEnabled(store.getSnapshot(), stackChoice("a"), false)).toMatchObject({ "Use for Button": false, "No Icon": false });
    expect(iconEditorEnabled(store.getSnapshot(), builtInChoice(STAR.name), false)).toMatchObject({ "Use for Button": false });
  });

  it("disables Duplicate, Rename, Delete and Use for Button while no icon is selected", () => {
    const { store } = setup({ a: BLANK_ICON });
    expect(iconEditorEnabled(store.getSnapshot(), null, false)).toEqual({
      New: true, Duplicate: false, "Rename...": false, Delete: false, "Add to Stack": false,
      "Use for Button": false, "No Icon": false, Undo: false,
    });
  });
});

describe("choice after Undo and Delete (Requirement 10.10)", () => {
  it("falls back to the initial choice when the chosen stack icon disappears, and returns when it comes back", () => {
    const { store, history } = setup({ a: BLANK_ICON });
    const created = createNewIconCommand(store.getSnapshot().stack);
    history.execute(created);
    const chosen = stackChoice(created.name!);
    expect(validIconChoice(store.getSnapshot(), chosen)).toEqual(chosen);

    history.undo();
    expect(validIconChoice(store.getSnapshot(), chosen)).toEqual(stackChoice("a"));
    history.redo();
    expect(validIconChoice(store.getSnapshot(), chosen)).toEqual(chosen);
  });

  it("falls back after Delete, and follows a rename", () => {
    const { store, history } = setup({ a: BLANK_ICON, b: dot });
    history.execute(createRenameIconCommand(store.getSnapshot().stack, "b", "Bee"));
    expect(validIconChoice(store.getSnapshot(), stackChoice("b"))).toEqual(stackChoice("a"));
    expect(validIconChoice(store.getSnapshot(), stackChoice("Bee"))).toEqual(stackChoice("Bee"));
  });

  it("keeps a built-in choice, and chooses the initial choice for no choice", () => {
    const { store } = setup({ a: BLANK_ICON });
    expect(validIconChoice(store.getSnapshot(), builtInChoice(STAR.name))).toEqual(builtInChoice(STAR.name));
    expect(validIconChoice(store.getSnapshot(), null)).toEqual(stackChoice("a"));
    expect(validIconChoice(store.getSnapshot(), builtInChoice("hex-gone"))).toEqual(stackChoice("a"));
  });
});

describe("built-in icons in the commands (Requirements 10.5, 10.8, 10.9)", () => {
  it("Duplicate of a built-in icon whose name is free gives '<name> 2'", () => {
    const { store, history } = setup({ a: BLANK_ICON });
    const data = iconDataOf(store.getSnapshot().stack, builtInChoice(STAR.name))!;
    expect(data).toBe(STAR.data);
    const command = createCopyIconCommand(store.getSnapshot().stack, STAR.name, data, "Duplicate Icon");
    expect(command.name).toBe(`${STAR.name} 2`);
    history.execute(command);
    expect(store.getSnapshot().stack.customIcons[`${STAR.name} 2`]).toBe(STAR.data);
    expect(history.undoLabel()).toBe("Duplicate Icon");
  });

  it("Add to Stack keeps the built-in name when it is free", () => {
    const { store, history } = setup();
    const command = createCopyIconCommand(store.getSnapshot().stack, STAR.name, STAR.data, "Add Icon");
    history.execute(command);
    expect(Object.keys(store.getSnapshot().stack.customIcons)).toEqual([STAR.name]);
  });

  it("Use for Button copies a built-in icon into the stack and sets it, as one command", () => {
    const { store, history } = setup({ a: BLANK_ICON });
    const command = createUseIconCommand(store.getSnapshot().stack, "prt_b1", builtInChoice(STAR.name));
    expect(command.name).toBe(STAR.name);
    history.execute(command);
    const after = store.getSnapshot().stack;
    expect(Object.keys(after.customIcons)).toEqual(["a", STAR.name]);
    expect(selectedButton(store.getSnapshot())?.iconId).toBe(STAR.name);
    expect(history.undoLabel()).toBe("Set Icon");
    history.undo();
    expect(Object.keys(store.getSnapshot().stack.customIcons)).toEqual(["a"]);
    expect(selectedButton(store.getSnapshot())?.iconId).toBeUndefined();
  });

  it("Use for Button with a built-in icon whose name is already a stack icon adds '<name> 2' and sets it", () => {
    const { store, history } = setup({ [STAR.name]: dot });
    const command = createUseIconCommand(store.getSnapshot().stack, "prt_b1", builtInChoice(STAR.name));
    expect(command.name).toBe(`${STAR.name} 2`);
    history.execute(command);
    const after = store.getSnapshot().stack;
    expect(Object.keys(after.customIcons)).toEqual([STAR.name, `${STAR.name} 2`]);
    expect(after.customIcons[STAR.name]).toBe(dot);
    expect(after.customIcons[`${STAR.name} 2`]).toBe(STAR.data);
    expect(selectedButton(store.getSnapshot())?.iconId).toBe(`${STAR.name} 2`);
  });

  it("Use for Button with a stack icon only sets the icon", () => {
    const { store, history } = setup({ a: BLANK_ICON, b: dot });
    history.execute(createUseIconCommand(store.getSnapshot().stack, "prt_b1", stackChoice("b")));
    expect(Object.keys(store.getSnapshot().stack.customIcons)).toEqual(["a", "b"]);
    expect(selectedButton(store.getSnapshot())?.iconId).toBe("b");
  });
});

describe("cellLine (Requirement 10.3: no cell the pointer passed over is skipped)", () => {
  const at = (x: number, y: number): number => y * 32 + x;

  it("is the single cell when both ends are the same cell", () => {
    expect(cellLine(at(5, 7), at(5, 7))).toEqual([at(5, 7)]);
    expect(cellLine(0, 0)).toEqual([0]);
    expect(cellLine(1023, 1023)).toEqual([1023]);
  });

  it("covers a horizontal line in both directions, including the row ends", () => {
    expect(cellLine(at(2, 3), at(6, 3))).toEqual([at(2, 3), at(3, 3), at(4, 3), at(5, 3), at(6, 3)]);
    expect(cellLine(at(6, 3), at(2, 3))).toEqual([at(6, 3), at(5, 3), at(4, 3), at(3, 3), at(2, 3)]);
    expect(cellLine(0, 31)).toEqual(Array.from({ length: 32 }, (_, x) => x));
    expect(cellLine(at(31, 31), at(0, 31))).toEqual(Array.from({ length: 32 }, (_, x) => at(31 - x, 31)));
  });

  it("covers a vertical line in both directions, including the column ends", () => {
    expect(cellLine(at(4, 1), at(4, 4))).toEqual([at(4, 1), at(4, 2), at(4, 3), at(4, 4)]);
    expect(cellLine(at(4, 4), at(4, 1))).toEqual([at(4, 4), at(4, 3), at(4, 2), at(4, 1)]);
    expect(cellLine(at(0, 0), at(0, 31))).toEqual(Array.from({ length: 32 }, (_, y) => at(0, y)));
  });

  it("covers a 45-degree diagonal in all four directions", () => {
    expect(cellLine(at(1, 1), at(4, 4))).toEqual([at(1, 1), at(2, 2), at(3, 3), at(4, 4)]);
    expect(cellLine(at(4, 4), at(1, 1))).toEqual([at(4, 4), at(3, 3), at(2, 2), at(1, 1)]);
    expect(cellLine(at(4, 1), at(1, 4))).toEqual([at(4, 1), at(3, 2), at(2, 3), at(1, 4)]);
    expect(cellLine(at(1, 4), at(4, 1))).toEqual([at(1, 4), at(2, 3), at(3, 2), at(4, 1)]);
    expect(cellLine(0, 1023)).toEqual(Array.from({ length: 32 }, (_, i) => at(i, i)));
  });

  it("steps once per column on a shallow line and once per row on a steep line", () => {
    const shallow = cellLine(at(0, 0), at(10, 3));
    expect(shallow).toHaveLength(11);
    expect(shallow.map((cell) => cell % 32)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(shallow[0]).toBe(at(0, 0));
    expect(shallow.at(-1)).toBe(at(10, 3));

    const steep = cellLine(at(0, 0), at(3, 10));
    expect(steep).toHaveLength(11);
    expect(steep.map((cell) => Math.floor(cell / 32))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(steep[0]).toBe(at(0, 0));
    expect(steep.at(-1)).toBe(at(3, 10));
  });

  it("gives the reverse cells for the reverse line (shallow and steep, up and down)", () => {
    for (const [from, to] of [[at(0, 0), at(10, 3)], [at(0, 0), at(3, 10)], [at(20, 25), at(2, 4)], [at(3, 28), at(29, 1)]]) {
      const forward = cellLine(from, to);
      const back = cellLine(to, from);
      expect(back).toHaveLength(forward.length);
      for (const line of [forward, back]) {
        // Consecutive cells touch: they differ by at most one column and one row.
        for (let i = 1; i < line.length; i++) {
          expect(Math.abs((line[i] % 32) - (line[i - 1] % 32))).toBeLessThanOrEqual(1);
          expect(Math.abs(Math.floor(line[i] / 32) - Math.floor(line[i - 1] / 32))).toBeLessThanOrEqual(1);
        }
      }
      expect(forward[0]).toBe(from);
      expect(forward.at(-1)).toBe(to);
      expect(back[0]).toBe(to);
      expect(back.at(-1)).toBe(from);
    }
  });

  it("leaves no gap in a fast drag along row 0 (the review finding: cells 0, 3, 6, 9 and 14 only)", () => {
    const painted = new Set<number>();
    let last = 0;
    painted.add(0);
    for (const next of [3, 6, 9, 14]) {
      for (const cell of cellLine(last, next)) painted.add(cell);
      last = next;
    }
    expect([...painted].sort((a, b) => a - b)).toEqual(Array.from({ length: 15 }, (_, x) => x));
  });
});

describe("scrollTopToShowRow (selected row fully visible)", () => {
  // A 100 px high view of rows 20 px high.
  it("keeps scrollTop when the row is already inside, touching either edge included", () => {
    expect(scrollTopToShowRow(40, 100, 60, 20)).toBe(40);
    expect(scrollTopToShowRow(40, 100, 40, 20)).toBe(40);
    expect(scrollTopToShowRow(40, 100, 120, 20)).toBe(40);
    expect(scrollTopToShowRow(0, 100, 0, 20)).toBe(0);
  });

  it("scrolls up to the row's top when the row is above the view or partly cut at the top", () => {
    expect(scrollTopToShowRow(200, 100, 60, 20)).toBe(60);
    expect(scrollTopToShowRow(50, 100, 40, 20)).toBe(40);
    expect(scrollTopToShowRow(200, 100, 0, 20)).toBe(0);
  });

  it("scrolls down so the row's bottom meets the view's bottom when it is below or partly cut", () => {
    expect(scrollTopToShowRow(0, 100, 400, 20)).toBe(320);
    expect(scrollTopToShowRow(0, 100, 90, 20)).toBe(10);
    expect(scrollTopToShowRow(40, 100, 121, 20)).toBe(41);
  });

  it("rounds fractional positions outward and never returns a negative value", () => {
    expect(scrollTopToShowRow(100, 100, 40.5, 20)).toBe(40);
    expect(scrollTopToShowRow(0, 100, 90.25, 20)).toBe(11);
    expect(scrollTopToShowRow(5, 100, -3, 20)).toBe(0);
    expect(scrollTopToShowRow(0, 100, 0, 150)).toBe(50);
  });
});
