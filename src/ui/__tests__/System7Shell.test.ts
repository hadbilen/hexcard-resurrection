/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHistory } from "../../core/history.ts";
import { THEME_PALETTES, type HexStack } from "../../core/schema.ts";
import { createHexStore } from "../../core/store.ts";
import { validateStack } from "../../core/stackValidator.ts";
import fc from "fast-check";
import {
  CHECK_MARK,
  DEFAULT_RING_CORNER,
  DEFAULT_RING_LEFT_CAP,
  DEFAULT_RING_OUTSET,
  DEFAULT_RING_RIGHT_CAP,
  MenuDropdown,
  PUSH_BUTTON_CORNER,
  PUSH_BUTTON_HEIGHT,
  PUSH_BUTTON_LEFT_CAP,
  PUSH_BUTTON_MIN_WIDTH,
  PUSH_BUTTON_RIGHT_CAP,
  System7Shell,
  TEAR_OFF_DISTANCE,
  UiScaleContext,
  gridSnapOffset,
  pushButtonLabelPadding,
  createModalManager,
  defaultPalettePosition,
  shellShortcutKey,
  shouldTearOff,
  tearOffThreshold,
  themeCssVariables,
  useUiScale,
} from "../System7Shell.tsx";
import {
  MENU_THEMES,
  buildMenus,
  createThemeCommand,
  isReservedCommand,
  type MenuCommand,
  type MenuContext,
  type MenuHandlers,
  type ShellMenuHandlers,
} from "../menuCommands.ts";
import type { AuthoringTool, ThemePaletteName } from "../../core/schema.ts";
import type { HexLayer } from "../../core/store.ts";

// Read as plain text: Vitest's CSS handling turns `system7.css?raw` into "".
const SHELL_SOURCE = readFileSync(new URL("../System7Shell.tsx", import.meta.url), "utf8");
const SHELL_CSS = readFileSync(new URL("../system7.css", import.meta.url), "utf8");

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

/** A menu context on the test stack, with the given tool, edit layer and theme. */
function contextWith(
  options: { tool?: AuthoringTool; editLayer?: HexLayer; themeName?: ThemePaletteName; fatBits?: { x: number; y: number } | null } = {},
): MenuContext {
  const { store, history } = setup();
  const state = store.getSnapshot();
  const themeName = options.themeName ?? "ClassicPaper";
  return {
    state: {
      ...state,
      tool: options.tool ?? state.tool,
      editLayer: options.editLayer ?? state.editLayer,
      fatBits: options.fatBits ?? null,
      stack: { ...state.stack, themePalette: { name: themeName, ...THEME_PALETTES[themeName] } },
    },
    history,
    backHistory: [],
    paletteVisible: false,
  };
}

/** Every command of the menus in `context`, in menu order. */
function menuCommandsOf(context: MenuContext): MenuCommand[] {
  return buildMenus(context, "other").flatMap((menu) => menu.entries.flatMap((entry) => (entry.kind === "item" ? [entry.command] : [])));
}

/** Handlers that record the commands they run; `paint.togglePalette` included for `shellShortcutKey`. */
function recordingHandlers(): { handlers: MenuHandlers; ran: MenuCommand[] } {
  const ran: MenuCommand[] = [];
  const entries = menuCommandsOf(contextWith())
    .filter((command) => !isReservedCommand(command))
    .map((command) => [command, () => void ran.push(command)]);
  return { handlers: Object.fromEntries(entries) as MenuHandlers, ran };
}

function shellHandlers(): ShellMenuHandlers {
  const { "paint.togglePalette": _toggle, ...rest } = recordingHandlers().handlers;
  return rest;
}

function render(parts: ReturnType<typeof setup>, extra: { scale?: number; children?: unknown } = {}): string {
  const { children, ...props } = extra;
  return renderToStaticMarkup(
    createElement(System7Shell, {
      ...parts, ...props, patternIndex: 1, onPatternChange: () => {},
      handlers: shellHandlers(), backHistory: () => [], platform: "other",
    }, children as never),
  );
}

function ScaleProbe() {
  return createElement("output", null, `k=${useUiScale()}`);
}

describe("menus", () => {
  it("renders the eight menu titles of the menu model in order", () => {
    const html = render(setup());
    const titles = [...html.matchAll(/aria-haspopup="menu" aria-expanded="false">([^<]+)<\/button>/g)].map((match) => match[1]);
    expect(titles).toEqual(["Hex", "File", "Edit", "Go", "Tools", "Objects", "Paint", "AI Conjure"]);
  });

  it("lists the 12 tools in the Tools menu and checks the current one", () => {
    const tools = buildMenus(contextWith({ tool: "spray" }), "other").find((menu) => menu.id === "tools")!;
    expect(tools.entries).toHaveLength(12);
    const checked = tools.entries.filter((entry) => entry.kind === "item" && entry.checked);
    expect(checked).toMatchObject([{ command: "tool:spray" }]);
  });

  it("offers the four themes and checks the current one", () => {
    const hex = buildMenus(contextWith({ themeName: "AmberCRT" }), "other").find((menu) => menu.id === "hex")!;
    const themes = hex.entries.filter((entry) => entry.kind === "item" && entry.command.startsWith("theme:"));
    expect(themes.map((entry) => entry.kind === "item" && entry.command)).toEqual(MENU_THEMES.map((name) => `theme:${name}`));
    expect(themes.filter((entry) => entry.kind === "item" && entry.checked)).toMatchObject([{ command: "theme:AmberCRT" }]);
  });

  it("checks Edit Background in background mode and disables Undo without history (spec 05 layout)", () => {
    const edit = buildMenus(contextWith({ editLayer: "background" }), "other").find((menu) => menu.id === "edit")!;
    expect(edit.entries).toMatchObject([
      { command: "edit.undo", disabled: true, shortcut: "Ctrl+Z" },
      { command: "edit.redo", disabled: true, shortcut: "Ctrl+Shift+Z" },
      { kind: "separator" },
      { command: "edit.background", checked: true, shortcut: "Ctrl+B", disabled: false },
      { kind: "separator" },
      { command: "edit.iconEditor", label: "Icon Editor...", disabled: false },
    ]);
  });
});

describe("Paint menu (spec 06 Requirements 1.2, 1.3)", () => {
  const paintMenu = (context: MenuContext) => buildMenus(context, "other").find((menu) => menu.id === "paint")!;
  it("lists Show Tools Palette, a separator and FatBits", () => {
    expect(paintMenu(contextWith()).entries).toMatchObject([
      { command: "paint.togglePalette", label: "Show Tools Palette" },
      { kind: "separator" },
      { command: "paint.fatBits", label: "FatBits" },
    ]);
    const html = renderMenu(paintMenu(contextWith({ tool: "pencil" })));
    expect(html).toContain("FatBits");
    expect(html).toContain('role="separator"');
  });
  it("disables FatBits except with the Pencil or the Eraser, and dims it as every disabled item", () => {
    for (const tool of ["browse", "button", "brush", "select"] as const) {
      expect(paintMenu(contextWith({ tool })).entries[2], tool).toMatchObject({ disabled: true });
    }
    for (const tool of ["pencil", "eraser"] as const) {
      expect(paintMenu(contextWith({ tool })).entries[2], tool).toMatchObject({ disabled: false, checked: false });
    }
    const dimmed = renderMenu(paintMenu(contextWith({ tool: "browse" })));
    expect(dimmed.match(/class="s7-dim"/g)).toHaveLength(1);
    expect(renderMenu(paintMenu(contextWith({ tool: "pencil" }))).match(/class="s7-dim"/g)).toBeNull();
  });
  it("draws the check mark of FatBits while the view is on, and only then", () => {
    const off = renderMenu(paintMenu(contextWith({ tool: "pencil" })), 2);
    const on = renderMenu(paintMenu(contextWith({ tool: "pencil", fatBits: { x: 224, y: 149 } })), 2);
    expect(off).toContain('aria-checked="false"');
    expect(off).not.toContain('aria-checked="true"');
    expect(on).toMatch(/aria-checked="true"[^>]*><span class="s7-check" aria-hidden="true"><svg/);
    expect(on.match(/aria-checked="true"/g)).toHaveLength(1);
  });
});
describe("dimmed menu items (spec 05 Requirement 1.3, design §7)", () => {
  it("draw a k-scaled checkerboard of light 1x pixels over every disabled item, and nothing over enabled ones", () => {
    const context = contextWith();
    const objects = buildMenus(context, "other").find((menu) => menu.id === "objects")!;
    const disabled = objects.entries.filter((entry) => entry.kind === "item" && entry.disabled);
    expect(disabled.map((entry) => entry.kind === "item" && entry.command)).toEqual([
      "objects.objectInfo", "objects.deletePart", "objects.deleteCard",
    ]);
    for (const k of [1, 3]) {
      const html = renderMenu(objects, k);
      const overlays = html.match(/<svg class="s7-dim" width="100%" height="100%" shape-rendering="crispEdges" aria-hidden="true" focusable="false">/g) ?? [];
      expect(overlays).toHaveLength(disabled.length);
      expect(html.match(new RegExp(`<pattern id="[^"]+" width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="scale\\(${k}\\)"><path d="M0 0h1v1H0zM1 1h1v1H1z" fill="var\\(--light-bit\\)"`, "g")))
        .toHaveLength(disabled.length);
      // Each overlay is the last child of its disabled button, after the shortcut cell.
      expect(html.match(/<button type="button" class="s7-menu-item" role="menuitem" disabled="">[\s\S]*?<\/button>/g)!
        .every((button) => button.includes('class="s7-dim"'))).toBe(true);
      // Pattern ids are unique within the menu.
      const ids = [...html.matchAll(/<pattern id="([^"]+)"/g)].map((match) => match[1]);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("use no strike-through, opacity or grey: the overlay does the dimming", () => {
    const disabledRule = SHELL_RULES.match(/\.s7-menu-item:disabled \{[^}]*\}/)![0];
    expect(disabledRule).toContain("position: relative;");
    expect(disabledRule).toContain("color: var(--dark-bit);");
    expect(SHELL_RULES).not.toMatch(/line-through/);
    expect(disabledRule).not.toMatch(/opacity|grey|gray/i);
    expect(SHELL_RULES).toMatch(/\.s7-dim \{[^}]*position: absolute;[^}]*pointer-events: none;/);
    // Disabled items do not invert on hover.
    expect(SHELL_RULES).toMatch(/\.s7-menu-item:hover:not\(:disabled\) \{/);
  });
});

describe("shell shortcut listener (spec 05 Requirements 2.4, 2.5, 16)", () => {
  type Key = Parameters<typeof shellShortcutKey>[0] & { prevented: number };
  const press = (init: Partial<Key>): Key => {
    const event: Key = {
      key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, prevented: 0,
      preventDefault() {
        event.prevented++;
      },
      ...init,
    };
    return event;
  };
  /** A duck-typed element: `closest` finds a text input only when `textInput` is set. */
  const element = (textInput: boolean) => ({ closest: (selector: string) => (textInput && selector.includes("textarea") ? {} : null) }) as unknown as EventTarget;
  /** The Message Box text box: a text input that also matches the `.s7-message-box-input` class selector. */
  const messageBoxInput = { closest: (selector: string) => (selector.includes("textarea") || selector === ".s7-message-box-input" ? {} : null) } as unknown as EventTarget;

  it("runs Go > Find and Go > Message Box from the Message Box text box with the default prevented, and nothing else; a dialog or studio window still blocks (spec 06 Requirement 1.7)", () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const find = recordingHandlers();
      const findEvent = press({ key: "f", code: "KeyF", ...modifier, target: messageBoxInput });
      expect(shellShortcutKey(findEvent, { blocked: false, context: () => contextWith(), handlers: find.handlers, platform: "other" })).toBe("go.find");
      expect(find.ran).toEqual(["go.find"]);
      expect(findEvent.prevented).toBe(1);

      const box = recordingHandlers();
      const boxEvent = press({ key: "m", code: "KeyM", ...modifier, target: messageBoxInput });
      expect(shellShortcutKey(boxEvent, { blocked: false, context: () => contextWith(), handlers: box.handlers, platform: "other" })).toBe("go.messageBox");
      expect(box.ran).toEqual(["go.messageBox"]);
      expect(boxEvent.prevented).toBe(1);

      // Blocked by a dialog or a studio window: nothing, even with the focus still in the Message Box.
      const blocked = recordingHandlers();
      const blockedEvent = press({ key: "f", code: "KeyF", ...modifier, target: messageBoxInput });
      expect(shellShortcutKey(blockedEvent, { blocked: true, context: () => contextWith(), handlers: blocked.handlers, platform: "other" })).toBeUndefined();
      expect(blocked.ran).toEqual([]);
      expect(blockedEvent.prevented).toBe(0);
    }
    // Cmd+M and Ctrl+M on macOS stay the browser's, in the Message Box text box too.
    const mac = recordingHandlers();
    const onMac = press({ key: "m", code: "KeyM", metaKey: true, target: messageBoxInput });
    expect(shellShortcutKey(onMac, { blocked: false, context: () => contextWith(), handlers: mac.handlers, platform: "mac" })).toBeUndefined();
    expect(mac.ran).toEqual([]);
    expect(onMac.prevented).toBe(0);

    // On macOS only Command+F runs Find in the text box; Control+F (caret forward) is left to it.
    const macFind = recordingHandlers();
    const cmdF = press({ key: "f", code: "KeyF", metaKey: true, target: messageBoxInput });
    expect(shellShortcutKey(cmdF, { blocked: false, context: () => contextWith(), handlers: macFind.handlers, platform: "mac" })).toBe("go.find");
    expect(macFind.ran).toEqual(["go.find"]);
    expect(cmdF.prevented).toBe(1);
    const macCtrlFind = recordingHandlers();
    const ctrlF = press({ key: "f", code: "KeyF", ctrlKey: true, target: messageBoxInput });
    expect(shellShortcutKey(ctrlF, { blocked: false, context: () => contextWith(), handlers: macCtrlFind.handlers, platform: "mac" })).toBeUndefined();
    expect(macCtrlFind.ran).toEqual([]);
    expect(ctrlF.prevented).toBe(0);
  });

  it("runs Edit Background for Ctrl+B and Cmd+B and prevents the browser default", () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const { handlers, ran } = recordingHandlers();
      const event = press({ key: "b", code: "KeyB", ...modifier, target: element(false) });
      expect(shellShortcutKey(event, { blocked: false, context: () => contextWith(), handlers, platform: "other" })).toBe("edit.background");
      expect(ran).toEqual(["edit.background"]);
      expect(event.prevented).toBe(1);
    }
  });

  it("runs Go > Message Box for Ctrl+M except on macOS, where Cmd+M and Ctrl+M stay the browser's (spec 06 Requirements 1.4, 1.5)", () => {
    for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
      const other = recordingHandlers();
      const event = press({ key: "m", code: "KeyM", ...modifier, target: element(false) });
      expect(shellShortcutKey(event, { blocked: false, context: () => contextWith(), handlers: other.handlers, platform: "other" })).toBe("go.messageBox");
      expect(other.ran).toEqual(["go.messageBox"]);
      expect(event.prevented).toBe(1);

      const mac = recordingHandlers();
      const onMac = press({ key: "m", code: "KeyM", ...modifier, target: element(false) });
      expect(shellShortcutKey(onMac, { blocked: false, context: () => contextWith(), handlers: mac.handlers, platform: "mac" })).toBeUndefined();
      expect(mac.ran).toEqual([]);
      expect(onMac.prevented).toBe(0);
    }
  });

  it("runs Go > Find for Cmd+F and Ctrl+F on every platform and prevents the browser's find bar (spec 06 Requirements 1.4, 1.7)", () => {
    for (const platform of ["mac", "other"] as const) {
      for (const modifier of [{ ctrlKey: true }, { metaKey: true }]) {
        const { handlers, ran } = recordingHandlers();
        const event = press({ key: "f", code: "KeyF", ...modifier, target: element(false) });
        expect(shellShortcutKey(event, { blocked: false, context: () => contextWith(), handlers, platform })).toBe("go.find");
        expect(ran).toEqual(["go.find"]);
        expect(event.prevented).toBe(1);
      }
    }
  });

  it("prevents a disabled shortcut but does not run it (Undo without history)", () => {
    const { handlers, ran } = recordingHandlers();
    const event = press({ key: "z", code: "KeyZ", ctrlKey: true });
    expect(shellShortcutKey(event, { blocked: false, context: () => contextWith(), handlers, platform: "other" })).toBeUndefined();
    expect(ran).toEqual([]);
    expect(event.prevented).toBe(1);
  });

  it("does nothing while a dialog or studio window is open, whatever has the focus (Requirement 16.3)", () => {
    for (const target of [null, element(false)]) {
      const { handlers, ran } = recordingHandlers();
      let contextRead = false;
      const event = press({ key: "b", code: "KeyB", ctrlKey: true, target });
      const context = () => {
        contextRead = true;
        return contextWith();
      };
      expect(shellShortcutKey(event, { blocked: true, context, handlers, platform: "other" })).toBeUndefined();
      expect(ran).toEqual([]);
      expect(event.prevented).toBe(0);
      expect(contextRead).toBe(false);
    }
  });

  it("leaves every studio shortcut to a focused text input (Requirements 16.1, 16.2)", () => {
    const { handlers, ran } = recordingHandlers();
    const { store, history } = setup();
    store.setTool("button");
    const selected: MenuContext = { state: { ...store.getSnapshot(), selectedPartId: "prt_any" }, history, backHistory: [], paletteVisible: false };
    for (const init of [
      { key: "b", code: "KeyB", ctrlKey: true },
      { key: "z", code: "KeyZ", metaKey: true },
      { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true },
      { key: "m", code: "KeyM", ctrlKey: true },
      { key: "f", code: "KeyF", ctrlKey: true },
      { key: "f", code: "KeyF", metaKey: true },
      { key: "Delete", code: "Delete" },
      { key: "Backspace", code: "Backspace" },
    ]) {
      const event = press({ ...init, target: element(true) });
      expect(shellShortcutKey(event, { blocked: false, context: () => selected, handlers, platform: "other" })).toBeUndefined();
      expect(event.prevented).toBe(0);
    }
    expect(ran).toEqual([]);
  });

  it("maps Delete and Backspace to Delete Part only while a part is selected (Requirement 2.5)", () => {
    const { store, history } = setup();
    const none = contextWith();
    const selected: MenuContext = {
      state: { ...store.getSnapshot(), tool: "button", selectedPartId: "prt_any" }, history, backHistory: [], paletteVisible: false,
    };
    for (const key of ["Delete", "Backspace"]) {
      const idle = recordingHandlers();
      const free = press({ key, code: key });
      expect(shellShortcutKey(free, { blocked: false, context: () => none, handlers: idle.handlers, platform: "other" })).toBeUndefined();
      expect(free.prevented).toBe(0); // left to the Browse-mode keyDown forwarding
      const active = recordingHandlers();
      const event = press({ key, code: key });
      expect(shellShortcutKey(event, { blocked: false, context: () => selected, handlers: active.handlers, platform: "other" })).toBe("objects.deletePart");
      expect(active.ran).toEqual(["objects.deletePart"]);
      expect(event.prevented).toBe(1);
    }
  });

  it("leaves the arrow keys and the abort shortcut alone (Requirements 2.6, 16.4)", () => {
    const { handlers, ran } = recordingHandlers();
    for (const init of [
      { key: "ArrowLeft", code: "ArrowLeft" },
      { key: "ArrowRight", code: "ArrowRight" },
      { key: ".", code: "Period", metaKey: true },
      { key: ".", code: "Period", ctrlKey: true },
    ]) {
      const event = press(init);
      expect(shellShortcutKey(event, { blocked: false, context: () => contextWith(), handlers, platform: "other" })).toBeUndefined();
      expect(event.prevented).toBe(0);
    }
    expect(ran).toEqual([]);
  });

  it("is the shell's only keydown shortcut path: no other key test is left in the shell", () => {
    expect(SHELL_SOURCE).not.toMatch(/isEditBackgroundShortcut|onCommand|ForwardedCommand/);
    expect(SHELL_SOURCE.match(/addEventListener\("keydown"/g)).toHaveLength(2); // shortcuts + closing an open menu
  });
});

describe("tear-off helpers", () => {
  it("tears off only after the pointer is dragged below the menu bar", () => {
    expect(shouldTearOff(20, 1)).toBe(false);
    expect(shouldTearOff(20 + TEAR_OFF_DISTANCE, 1)).toBe(false);
    expect(shouldTearOff(20 + TEAR_OFF_DISTANCE + 1, 1)).toBe(true);
  });
});

describe("UI scale (Requirement 2.10)", () => {
  it("makes the menu bar 20k and derives the tear-off threshold from it", () => {
    expect(tearOffThreshold(1)).toBe(20 + TEAR_OFF_DISTANCE);
    expect(tearOffThreshold(3)).toBe(60 + 3 * TEAR_OFF_DISTANCE);
    expect(shouldTearOff(84, 3)).toBe(false);
    expect(shouldTearOff(85, 3)).toBe(true);
    expect(defaultPalettePosition(2)).toEqual({ x: 32, y: 40 + 32 });
  });

  it("writes k, one 1x pixel and the 20k menu bar height into the shell's style", () => {
    const parts = setup();
    const html = render(parts, { scale: 3 });
    expect(html).toContain("--k:3;--px:3px;--menubar-height:60px");
    expect(html).toContain('data-ui-scale="3"');
    // Node has no window: the computed scale falls back to 1.
    expect(render(parts)).toContain("--k:1;--px:1px;--menubar-height:20px");
  });

  it("sizes the menu bar from --menubar-height and every shell length from --px", () => {
    expect(SHELL_CSS).toMatch(/\.s7-menubar \{[^}]*height: var\(--menubar-height\);/);
    const shellRules = SHELL_CSS.slice(0, SHELL_CSS.indexOf("/* Canvases are always drawn"));
    // Outside the custom property defaults, no length is a bare px value except 0px shadow blurs.
    const bare = shellRules
      .split("\n")
      .filter((line) => !/^\s*--/.test(line))
      .flatMap((line) => line.match(/\b\d+px\b/g) ?? [])
      .filter((value) => value !== "0px");
    expect(bare).toEqual([]);
  });

  it("hands k to the children through useUiScale", () => {
    const html = render(setup(), { scale: 4, children: createElement(ScaleProbe) });
    expect(html).toContain("<output>k=4</output>");
    expect(renderToStaticMarkup(createElement(ScaleProbe))).toBe("<output>k=1</output>");
  });

  it("scales the bomb icon with k", () => {
    const parts = setup();
    void parts.modals.bomb("Sorry, a script error occurred: Loop exceeded 10,000 steps");
    expect(render(parts, { scale: 2 })).toMatch(/<svg class="s7-icon" width="64" height="64"/);
  });
});

describe("menu title focus", () => {
  it("focuses no menu button at mount", () => {
    const html = render(setup());
    expect(html).not.toMatch(/autofocus/i);
    expect(SHELL_SOURCE).not.toMatch(/autoFocus/);
    // The only .focus() calls are in the modal dialog (default button and Tab cycling).
    const outsideDialog = SHELL_SOURCE.slice(0, SHELL_SOURCE.indexOf("function ModalDialog"))
      + SHELL_SOURCE.slice(SHELL_SOURCE.indexOf("function ModalLayer"));
    expect(outsideDialog).not.toMatch(/\.focus\(/);
  });

  it("inverts a menu title for :focus-visible only, never for :focus or :hover", () => {
    expect(SHELL_CSS).toMatch(/\.s7-menu-title-open,\s*\.s7-shell \.s7-menu-title:focus-visible \{[^}]*background: var\(--dark-bit\);/);
    expect(SHELL_CSS.match(/:focus(?!-visible)/g)).toBeNull();
    expect(SHELL_CSS).not.toMatch(/\.s7-menu-title:hover/);
  });

  it("keeps the button reset from overriding the menu title padding", () => {
    expect(SHELL_CSS).toContain(":where(.s7-shell) button {");
    expect(SHELL_CSS).not.toMatch(/^\.s7-shell button \{/m);
    expect(SHELL_CSS).toMatch(/\.s7-menu-title \{[^}]*padding: 0 calc\(8 \* var\(--px\)\);/);
  });
});

describe("themes", () => {
  it("maps each palette to the --dark-bit / --light-bit variables", () => {
    for (const name of MENU_THEMES) {
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

// ---------------------------------------------------------------------------------------------
// 1-bit chrome (steering tech.md, 1-Bit Fidelity Rules 6)
// ---------------------------------------------------------------------------------------------

/** Shell rules only: everything before the card viewport (`.hc-*`, task 3), comments removed. */
const SHELL_RULES = SHELL_CSS.slice(0, SHELL_CSS.indexOf("/* Card viewport")).replace(/\/\*[\s\S]*?\*\//g, "");

/** Visible text of server-rendered markup (tags removed, entities decoded). */
function visibleText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Printable ASCII: covered by every bundled font (Pixel Operator, Pixel Operator 8, Fairfax). */
const COVERED_BY_BUNDLED_FONTS = /^[\x20-\x7e]*$/;

function renderMenu(menu: ReturnType<typeof buildMenus>[number], k = 1): string {
  return renderToStaticMarkup(
    createElement(UiScaleContext, { value: k }, createElement(MenuDropdown, { menu, onRun: () => {} })),
  );
}

describe("shell CSS draws only 1-bit pixels", () => {
  it("separates the shell rules from the card viewport section", () => {
    expect(SHELL_RULES).toContain(".s7-shell {");
    expect(SHELL_RULES).not.toContain(".hc-");
  });

  it("uses no rounded corners, dashed or dotted lines, gradients, blur, filters or partial opacity", () => {
    expect(SHELL_RULES).not.toMatch(/border-radius/);
    expect(SHELL_RULES).not.toMatch(/dashed|dotted/);
    expect(SHELL_RULES).not.toMatch(/gradient/);
    expect(SHELL_RULES).not.toMatch(/blur\(/);
    expect(SHELL_RULES).not.toMatch(/filter/); // also backdrop-filter
    for (const [, value] of SHELL_RULES.matchAll(/opacity:\s*([\d.]+)/g)) {
      const opacity = Number(value);
      expect(opacity <= 0.01 || opacity >= 0.99, `opacity ${value}`).toBe(true);
    }
  });

  it("gives every box-shadow a 0px blur", () => {
    for (const [, value] of SHELL_RULES.matchAll(/box-shadow:\s*([^;]+);/g)) {
      expect(value).toMatch(/^calc\(\d+ \* var\(--px\)\) calc\(\d+ \* var\(--px\)\) 0px var\(--dark-bit\)$/);
    }
  });

  it("inverts selected text instead of using the system highlight", () => {
    expect(SHELL_RULES).toMatch(/\.s7-shell ::selection \{[^}]*background: var\(--dark-bit\);[^}]*color: var\(--light-bit\);/);
  });
});

describe("menu check marks", () => {
  const menus = buildMenus(contextWith({ tool: "pencil", editLayer: "background", themeName: "GreenPhosphor" }), "mac");

  it("render only text the bundled fonts cover, and no U+2713", () => {
    for (const menu of menus) {
      const text = visibleText(renderMenu(menu));
      expect(text, menu.id).not.toContain("\u2713");
      expect(text, menu.id).toMatch(COVERED_BY_BUNDLED_FONTS);
    }
  });

  it("draw the check mark as k-scaled crisp pixel art and keep aria-checked", () => {
    const html = renderMenu(menus.find((menu) => menu.id === "tools")!, 3);
    expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(12);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html.match(/aria-checked="false"/g)).toHaveLength(11);
    const checks = html.match(/<span class="s7-check" aria-hidden="true">(.*?)<\/span>/g) ?? [];
    expect(checks).toHaveLength(12);
    const drawn = checks.filter((span) => span.includes("<svg"));
    expect(drawn).toHaveLength(1);
    expect(drawn[0]).toMatch(/<svg class="s7-icon" width="48" height="48" viewBox="0 0 16 16" shape-rendering="crispEdges" fill="currentColor"/);
    expect(html).toMatch(/aria-checked="true"[^>]*><span class="s7-check" aria-hidden="true"><svg/);
  });

  it("is a 16x16 glyph that sits above the baseline (row 13)", () => {
    expect(CHECK_MARK).toHaveLength(16);
    for (const row of CHECK_MARK) expect(row).toMatch(/^[.#]{16}$/);
    expect(CHECK_MARK.slice(13).join("")).not.toContain("#");
  });
});

describe("Tools menu tear-off line", () => {
  it("is an SVG pattern of alternating 1x pixels, scaled by k, not a border", () => {
    const tools = buildMenus(contextWith(), "other").find((menu) => menu.id === "tools")!;
    const html = renderMenu(tools, 2);
    expect(html).toMatch(/<div class="s7-tear-strip" aria-hidden="true"><svg class="s7-tear-strip-art" width="100%" height="2" shape-rendering="crispEdges"/);
    expect(html).toMatch(/<pattern [^>]*width="2" height="1" patternUnits="userSpaceOnUse" patternTransform="scale\(2\)"><rect width="1" height="1" fill="currentColor"/);
    expect(SHELL_RULES).toMatch(/\.s7-tear-strip \{[^}]*height: calc\(1 \* var\(--px\)\);/);
    expect(SHELL_RULES.match(/\.s7-tear-strip \{[^}]*\}/)![0]).not.toMatch(/border/);
    // Other menus have no tear-off line.
    expect(renderMenu(buildMenus(contextWith(), "other")[0])).not.toContain("s7-tear-strip");
  });
});

describe("push buttons", () => {
  it("draw the rounded frame as crisp pixel-art caps under the label", () => {
    const parts = setup();
    void parts.modals.alert("Script error", { buttons: ["Script", "OK"] });
    const html = render(parts, { scale: 2 });
    // The label stays the button's first child, in the bundled font.
    expect(html).toMatch(/<button type="button" class="s7-button">Script<span class="s7-button-art" aria-hidden="true"><svg class="s7-pixel-art" width="8" height="40" viewBox="0 0 4 20" shape-rendering="crispEdges"/);
    expect(html.match(/class="s7-button-art"/g)).toHaveLength(2);
    // Only the default button has the ring: 8x28 caps at 1x.
    expect(html.match(/class="s7-button-ring"/g)).toHaveLength(1);
    expect(html).toMatch(/class="s7-button s7-button-default">OK<span class="s7-button-art"[\s\S]*?<span class="s7-button-ring" aria-hidden="true"><svg class="s7-pixel-art" width="16" height="56" viewBox="0 0 8 28"/);
    expect(SHELL_RULES).toMatch(/\.s7-button \{[^}]*height: calc\(20 \* var\(--px\)\);/);
    expect(SHELL_RULES).toMatch(/\.s7-button-ring \{[^}]*inset: calc\(-4 \* var\(--px\)\);/);
  });

  it("have caps that are full-height, mirrored and join the straight edges", () => {
    expect(PUSH_BUTTON_LEFT_CAP).toHaveLength(PUSH_BUTTON_HEIGHT);
    expect(DEFAULT_RING_LEFT_CAP).toHaveLength(PUSH_BUTTON_HEIGHT + 2 * DEFAULT_RING_OUTSET);
    for (const [left, right] of [[PUSH_BUTTON_LEFT_CAP, PUSH_BUTTON_RIGHT_CAP], [DEFAULT_RING_LEFT_CAP, DEFAULT_RING_RIGHT_CAP]] as const) {
      expect(new Set(left.map((row) => row.length)).size).toBe(1);
      expect(right).toEqual(left.map((row) => [...row].reverse().join("")));
      expect(left).toEqual([...left].reverse()); // symmetric top / bottom
    }
    // Button: 1 px edges meet the cap's last column at the top and bottom row.
    expect(PUSH_BUTTON_CORNER[0].endsWith("#")).toBe(true);
    expect(PUSH_BUTTON_LEFT_CAP[1].endsWith("+")).toBe(true);
    // Ring: 3 px edges, then nothing (the 1 px gap and the button are not part of the ring).
    expect(DEFAULT_RING_CORNER.slice(0, 3).every((row) => row.endsWith("#"))).toBe(true);
    expect(DEFAULT_RING_CORNER[3].endsWith(".")).toBe(true);
    expect(DEFAULT_RING_LEFT_CAP[10]).toBe("###.....");
  });

  it("centre the label on the 1x pixel grid inside the 64k minimum width", () => {
    expect(pushButtonLabelPadding(16 * 3, 3)).toEqual({ left: 72, right: 72 }); // "OK" at 3x
    expect(pushButtonLabelPadding(15 * 3, 3)).toEqual({ left: 72, right: 75 }); // odd width: rounded down
    expect(pushButtonLabelPadding(45 * 2, 2)).toEqual({ left: 24, right: 24 }); // wider than the minimum
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 120 }), (k, glyphPixels) => {
        const width = glyphPixels * k;
        const { left, right } = pushButtonLabelPadding(width, k);
        expect(left % k).toBe(0);
        expect(left + width + right).toBe(Math.max(PUSH_BUTTON_MIN_WIDTH * k, width + 24 * k));
        expect(right - left).toBeGreaterThanOrEqual(0);
        expect(right - left).toBeLessThan(2 * k);
      }),
    );
  });

  it("snap the dialog onto the k-pixel grid", () => {
    expect(gridSnapOffset(10.5, 1)).toBe(-0.5);
    expect(gridSnapOffset(37, 3)).toBe(-1);
    expect(gridSnapOffset(36, 3)).toBe(0);
  });

  it("keep the inset focus-visible outline and drop the outline-drawn default ring", () => {
    expect(SHELL_RULES).toMatch(/\.s7-shell button:focus-visible,\s*\.s7-shell input:focus-visible \{[^}]*outline: calc\(2 \* var\(--px\)\) solid var\(--dark-bit\);/);
    expect(SHELL_RULES).not.toMatch(/\.s7-button-default \{/);
  });
});
