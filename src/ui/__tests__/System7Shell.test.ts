import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHistory } from "../../core/history.ts";
import { THEME_PALETTES, type HexStack } from "../../core/schema.ts";
import { createHexStore } from "../../core/store.ts";
import { validateStack } from "../../core/stackValidator.ts";
import {
  System7Shell,
  THEME_NAMES,
  TEAR_OFF_DISTANCE,
  buildMenus,
  createModalManager,
  createThemeCommand,
  isEditBackgroundShortcut,
  shouldTearOff,
  themeCssVariables,
  type MenuState,
} from "../System7Shell.tsx";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function makeStack(): HexStack {
  return {
    id: "stk_1",
    schemaVersion: "2.0.0",
    name: "Test",
    author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", ...THEME_PALETTES.ClassicPaper },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false }],
    cards: [
      {
        id: "crd_1", name: "One", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [], bgFieldContents: {},
        marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
    ],
    customIcons: {},
    scriptSource: "",
  };
}

function setup() {
  const stack = makeStack();
  expect(validateStack(stack).ok).toBe(true);
  const store = createHexStore({ stack, compile: () => ({ ast: { handlers: {} }, errors: [] }) });
  const history = createHistory(store);
  const modals = createModalManager();
  return { store, history, modals };
}

function render(parts: ReturnType<typeof setup>): string {
  return renderToStaticMarkup(
    createElement(System7Shell, { ...parts, patternIndex: 1, onPatternChange: () => {} }),
  );
}

const baseState: MenuState = {
  tool: "browse", editLayer: "card", themeName: "ClassicPaper",
  canUndo: false, canRedo: false, paletteVisible: false,
};

describe("menus", () => {
  it("has the eight menus of design spec §7 in order", () => {
    expect(buildMenus(baseState).map((menu) => menu.label)).toEqual([
      "Hex", "File", "Edit", "Go", "Tools", "Objects", "Paint", "AI Conjure",
    ]);
  });

  it("lists the 12 tools in the Tools menu and checks the current one", () => {
    const tools = buildMenus({ ...baseState, tool: "spray" }).find((menu) => menu.id === "tools")!;
    expect(tools.entries).toHaveLength(12);
    const checked = tools.entries.filter((entry) => entry.kind === "item" && entry.checked);
    expect(checked).toMatchObject([{ command: "tool:spray" }]);
  });

  it("offers the four themes and checks the current one", () => {
    const hex = buildMenus({ ...baseState, themeName: "AmberCRT" }).find((menu) => menu.id === "hex")!;
    const themes = hex.entries.filter((entry) => entry.kind === "item" && entry.command.startsWith("theme:"));
    expect(themes.map((entry) => entry.kind === "item" && entry.command)).toEqual(THEME_NAMES.map((name) => `theme:${name}`));
    expect(themes.filter((entry) => entry.kind === "item" && entry.checked)).toMatchObject([{ command: "theme:AmberCRT" }]);
  });

  it("checks Edit Background in background mode and disables Undo without history", () => {
    const edit = buildMenus({ ...baseState, editLayer: "background" }).find((menu) => menu.id === "edit")!;
    expect(edit.entries).toMatchObject([
      { command: "edit.undo", disabled: true },
      { command: "edit.redo", disabled: true },
      { kind: "separator" },
      { command: "edit.background", checked: true, shortcut: "Ctrl+B" },
    ]);
  });
});

describe("shortcut and tear-off helpers", () => {
  const key = { key: "b", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false };

  it("accepts Cmd+B and Ctrl+B only", () => {
    expect(isEditBackgroundShortcut({ ...key, ctrlKey: true })).toBe(true);
    expect(isEditBackgroundShortcut({ ...key, metaKey: true, key: "B" })).toBe(true);
    expect(isEditBackgroundShortcut(key)).toBe(false);
    expect(isEditBackgroundShortcut({ ...key, ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isEditBackgroundShortcut({ ...key, ctrlKey: true, key: "n" })).toBe(false);
  });

  it("tears off only after the pointer is dragged below the menu bar", () => {
    expect(shouldTearOff(24, 24)).toBe(false);
    expect(shouldTearOff(24 + TEAR_OFF_DISTANCE, 24)).toBe(false);
    expect(shouldTearOff(24 + TEAR_OFF_DISTANCE + 1, 24)).toBe(true);
  });
});

describe("themes", () => {
  it("maps each palette to the --dark-bit / --light-bit variables", () => {
    for (const name of THEME_NAMES) {
      expect(themeCssVariables(THEME_PALETTES[name])).toEqual({
        "--dark-bit": THEME_PALETTES[name].darkBitHex,
        "--light-bit": THEME_PALETTES[name].lightBitHex,
      });
    }
  });

  it("writes the palette of the stack into the shell's inline style", () => {
    const parts = setup();
    expect(render(parts)).toContain("--dark-bit:#000000;--light-bit:#FFFFFF");
    parts.history.execute(createThemeCommand("AmberCRT"));
    const html = render(parts);
    expect(html).toContain("--dark-bit:#1A1000;--light-bit:#FFB000");
    expect(html).toContain('data-theme="AmberCRT"');
  });

  it("switches the theme through the history and Undo restores it", () => {
    const { store, history } = setup();
    history.execute(createThemeCommand("MidnightHex"));
    expect(store.getSnapshot().stack.themePalette).toEqual({ name: "MidnightHex", ...THEME_PALETTES.MidnightHex });
    history.undo();
    expect(store.getSnapshot().stack.themePalette.name).toBe("ClassicPaper");
    history.redo();
    expect(store.getSnapshot().stack.themePalette.name).toBe("MidnightHex");
  });

  it("records nothing when the theme is already active", () => {
    const { history } = setup();
    history.execute(createThemeCommand("ClassicPaper"));
    expect(history.canUndo()).toBe(false);
  });
});

describe("Edit Background stripes", () => {
  it("appear only while Edit Background mode is active", () => {
    const parts = setup();
    expect(render(parts)).not.toContain("edit-background-stripes");
    parts.store.setEditLayer("background");
    const html = render(parts);
    expect(html).toContain("edit-background-stripes");
    expect(html).toContain('data-edit-background="true"');
    parts.store.setEditLayer("card");
    expect(render(parts)).not.toContain("edit-background-stripes");
  });
});

describe("modal manager", () => {
  it("shows requests one at a time in arrival order", async () => {
    const modals = createModalManager();
    expect(modals.isOpen()).toBe(false);
    const first = modals.answer("Pick", ["No", "Yes"]);
    const second = modals.alert("Careful");
    expect(modals.getSnapshot().map((request) => request.kind)).toEqual(["answer", "alert"]);
    modals.settle(modals.getSnapshot()[0].id, "Yes");
    await expect(first).resolves.toBe("Yes");
    expect(modals.isOpen()).toBe(true);
    modals.settle(modals.getSnapshot()[0].id, "OK");
    await expect(second).resolves.toBe("OK");
    expect(modals.isOpen()).toBe(false);
  });

  it("notifies subscribers and hands out a new snapshot on each change", () => {
    const modals = createModalManager();
    let calls = 0;
    const unsubscribe = modals.subscribe(() => calls++);
    const before = modals.getSnapshot();
    void modals.bomb("Sorry, a script error occurred: Loop exceeded 10,000 steps");
    expect(calls).toBe(1);
    expect(modals.getSnapshot()).not.toBe(before);
    unsubscribe();
    modals.settle(modals.getSnapshot()[0].id, "OK");
    expect(calls).toBe(1);
  });

  it("falls back to an OK button and resolves ask with the typed text", async () => {
    const modals = createModalManager();
    void modals.answer("Hi", []);
    expect(modals.getSnapshot()[0]).toMatchObject({ buttons: ["OK"] });
    modals.settle(modals.getSnapshot()[0].id, "OK");
    const asked = modals.ask("Name?", "Ada");
    expect(modals.getSnapshot()[0]).toMatchObject({ kind: "ask", defaultAnswer: "Ada" });
    modals.settle(modals.getSnapshot()[0].id, "Grace");
    await expect(asked).resolves.toBe("Grace");
  });

  it("renders the first request as a dialog with a default (last) button", () => {
    const parts = setup();
    void parts.modals.alert("Script error", { buttons: ["Script", "OK"], details: ["Button 'Go'", "line 3"] });
    const html = render(parts);
    expect(html).toContain("Script error");
    expect(html).toContain("line 3");
    expect(html).toMatch(/class="s7-button s7-button-default"[^>]*>OK</);
  });

  it("renders the bomb dialog with its icon", () => {
    const parts = setup();
    void parts.modals.bomb("Sorry, a script error occurred: Loop exceeded 10,000 steps");
    const html = render(parts);
    expect(html).toContain("s7-dialog-bomb");
    expect(html).toContain("s7-icon");
  });
});
