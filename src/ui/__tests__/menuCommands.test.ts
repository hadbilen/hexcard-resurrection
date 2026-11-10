import { describe, expect, it } from "vitest";
import { createHistory, type HexHistory } from "../../core/history.ts";
import { createMessageBus, type HandlerRunner, type MessageBus } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import type { HexBackground, HexButtonPart, HexCard, HexFieldPart, HexPart, HexStack } from "../../core/schema.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { createHexStore, type HexRuntimeState, type HexStore } from "../../core/store.ts";
import { HexScriptError, type DispatchContext, type HexHost } from "../../core/vm.ts";
import { createStackLoader } from "../../storage/stackLoader.ts";
import type { ImageFileLike } from "../../engine/graphics/imageImport.ts";
import { TOOLS } from "../FloatingTools.tsx";
import { CANCEL_BUTTON, createChangeTracker, createFileCommands, DONT_SAVE_BUTTON } from "../fileCommands.ts";
import {
  ABOUT_MESSAGE,
  buildMenus,
  createMenuHandlers,
  detectPlatform,
  FIND_CARET,
  FIND_TEMPLATE,
  handleShortcutKey,
  isEnabled,
  isReservedCommand,
  isTextInputTarget,
  MENU_TOOLS,
  RESERVED_BROWSER_SHORTCUTS,
  RESERVED_COMMANDS,
  runMenuCommand,
  SHORTCUTS,
  shortcutCommand,
  shortcutLabel,
  type KeyLike,
  type MenuCommand,
  type MenuContext,
  type MenuEntry,
  type MenuHandlerDeps,
  type MenuHandlers,
  type MenuModel,
} from "../menuCommands.ts";
import { createMessageBox, type MessageBoxController } from "../MessageBox.tsx";
import { createStarterStack } from "../starterStack.ts";

// ---------------------------------------------------------------------------------------------
// Fixtures: crd_1 and crd_2 on bkg_1, crd_3 on bkg_2. The stack script handles every lifecycle
// message, so the recording runner below logs each one as `<message>@<current card>`.
// ---------------------------------------------------------------------------------------------

const LIFECYCLE = ["openStack", "openBackground", "openCard", "closeCard", "closeBackground", "newCard", "deleteCard"];
const handlersFor = (names: readonly string[]): string => names.map((name) => `on ${name}\nend ${name}`).join("\n");
const STACK_SCRIPT = handlersFor(LIFECYCLE);

const bitmap = () => ({ width: 512, height: 342, rleData: "" });

function button(id: string, name: string, layerScope: HexPart["layerScope"] = "card"): HexButtonPart {
  return {
    id, name, type: "button", layerScope, rect: { x: 10, y: 10, width: 80, height: 20 }, visible: true, enabled: true,
    scriptSource: "", style: "roundRect", title: name, showName: true, autoHilite: true, hilite: false,
  };
}

function field(id: string, name: string, layerScope: HexPart["layerScope"] = "background"): HexFieldPart {
  return {
    id, name, type: "field", layerScope, rect: { x: 10, y: 40, width: 200, height: 100 }, visible: true, enabled: true,
    scriptSource: "", style: "rectangle", content: "", sharedText: false, lockText: false, dontWrap: false,
    showLines: false, textAlign: "left", textFont: "Sans", textSize: 12, textStyle: [],
  };
}

function background(id: string, options: { cantDelete?: boolean; parts?: HexPart[] } = {}): HexBackground {
  return { id, name: id, bitmap: bitmap(), parts: options.parts ?? [], scriptSource: "", cantDelete: options.cantDelete ?? false };
}

function card(id: string, backgroundId: string, options: { cantDelete?: boolean; parts?: HexPart[]; script?: string } = {}): HexCard {
  return {
    id, name: id, backgroundId, bitmap: bitmap(), parts: options.parts ?? [], bgFieldContents: {}, marked: false,
    cantDelete: options.cantDelete ?? false, dontSearch: false, scriptSource: options.script ?? "",
  };
}

function makeStack(backgrounds: HexBackground[], cards: HexCard[]): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds, cards, customIcons: {}, scriptSource: STACK_SCRIPT,
  };
}

interface StackOptions {
  bkg2CantDelete?: boolean;
  crd2CantDelete?: boolean;
  /** Card scripts by card id. */
  scripts?: Partial<Record<"crd_1" | "crd_2" | "crd_3", string>>;
}

/** Three cards on two backgrounds, a card button on crd_1 and a background field on bkg_1. */
function threeCards(options: StackOptions = {}): HexStack {
  const scripts = options.scripts ?? {};
  return makeStack(
    [background("bkg_1", { parts: [field("prt_f1", "Notes")] }), background("bkg_2", { cantDelete: options.bkg2CantDelete })],
    [
      card("crd_1", "bkg_1", { parts: [button("prt_b1", "Go")], script: scripts.crd_1 }),
      card("crd_2", "bkg_1", { cantDelete: options.crd2CantDelete, script: scripts.crd_2 }),
      card("crd_3", "bkg_2", { script: scripts.crd_3 }),
    ],
  );
}

function oneCard(): HexStack {
  return makeStack([background("bkg_1")], [card("crd_1", "bkg_1", { parts: [button("prt_b1", "Go")] })]);
}

/** A handler's behaviour, keyed `<object id>.<message, lower case>`; the object needs a handler in its script. */
type Behaviour = (ctx: DispatchContext, bus: MessageBus) => Promise<"handled" | "passed">;

/** Lets every pending promise chain (dispatches, loads) run to completion. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};

interface Harness {
  store: HexStore;
  history: HexHistory;
  bus: MessageBus;
  log: string[];
  errors: unknown[];
  /** Studio window and file-command calls, in order. */
  calls: string[];
  alerts: string[];
  palette: { visible: boolean };
  /** Spec 06: the real Message Box controller the Go > Message Box handler opens. */
  messageBox: MessageBoxController;
  handlers: MenuHandlers;
  context(): MenuContext;
  /** Runs `command` like a menu choice (only when enabled) and waits for its dispatch. */
  choose(command: MenuCommand): Promise<boolean>;
}

/** Real store, history and message bus; recording studio windows, file commands and alerts. */
function setup(
  stack: HexStack,
  behaviours: Record<string, Behaviour> = {},
  files?: MenuHandlerDeps["files"],
  pickedImage?: ImageFileLike,
): Harness {
  const store = createHexStore({ stack, compile: parseHexTalk });
  const history = createHistory(store);
  const log: string[] = [];
  const errors: unknown[] = [];
  const calls: string[] = [];
  const alerts: string[] = [];
  const palette = { visible: false };
  const messageBox = createMessageBox();
  let bus: MessageBus | undefined;

  const runner: HandlerRunner = async (handler, _params, me, ctx) => {
    const name = handler.eventName.toLowerCase();
    const snapshot = store.getSnapshot();
    if (me === snapshot.stack.id) {
      log.push(`${handler.eventName}@${snapshot.currentCardId}`);
      return "handled";
    }
    const behaviour = behaviours[`${me}.${name}`];
    return behaviour ? behaviour(ctx, bus!) : "passed";
  };
  bus = createMessageBus({
    store,
    host: {} as HexHost, // the recording runner never runs the VM
    runHandler: runner,
    isPageVisible: () => true,
    isModalOpen: () => false,
    scheduleInterval: () => () => {},
    onError: (error) => errors.push(error),
    warn: () => {},
  });

  const loader = createStackLoader({ store, history, alert: (message) => alerts.push(message) });
  const recordingFiles: MenuHandlerDeps["files"] = files ?? {
    replaceStackFrom: async (read) => {
      calls.push("replaceStackFrom");
      return loader.loadFrom(read);
    },
    openStackFile: async () => void calls.push("openStackFile"),
    saveStackFile: async () => {
      calls.push("saveStackFile");
      return true;
    },
    copyShareLink: async () => void calls.push("copyShareLink"),
    exportStandaloneHtml: async () => {
      calls.push("exportStandaloneHtml");
      return true;
    },
    pickImageFile: async () => {
      calls.push("pickImageFile");
      return pickedImage;
    },
  };

  let seed = 0;
  const shell = createMenuHandlers({
    store,
    history,
    bus,
    windows: {
      openInspector: (objectId, tab = "properties") => void calls.push(`inspector:${objectId}:${tab}`),
      openStackGraph: () => void calls.push("stackGraph"),
      openShowcaseChooser: () => void calls.push("showcaseChooser"),
      openIconEditor: () => void calls.push("iconEditor"),
    },
    files: recordingFiles,
    images: {
      importFile: async (file) => {
        calls.push(`importFile:${file.type}`);
        return true;
      },
    },
    messageBox,
    modals: {
      alert: async (message) => {
        alerts.push(message);
        return "OK";
      },
    },
    random: () => ((seed = (seed * 9301 + 49297) % 233280) / 233280),
  });
  const handlers: MenuHandlers = { ...shell, "paint.togglePalette": () => void (palette.visible = !palette.visible) };
  const readyBus = bus;
  const context = (): MenuContext => ({
    state: store.getSnapshot(), history, backHistory: readyBus.backHistory(), paletteVisible: palette.visible,
  });

  return {
    store, history, bus: readyBus, log, errors, calls, alerts, palette, messageBox, handlers, context,
    async choose(command) {
      const ran = runMenuCommand(command, context(), handlers);
      await settle();
      return ran;
    },
  };
}

function items(menus: readonly MenuModel[]): Extract<MenuEntry, { kind: "item" }>[] {
  return menus.flatMap((menu) => menu.entries.filter((entry): entry is Extract<MenuEntry, { kind: "item" }> => entry.kind === "item"));
}

function findItem(context: MenuContext, command: MenuCommand) {
  const found = items(buildMenus(context, "other")).find((entry) => entry.command === command);
  if (!found) throw new Error(`No menu item ${command}`);
  return found;
}

/** A plain MenuContext without a store, for the enabling rules. */
function contextOf(stack: HexStack, overrides: Partial<HexRuntimeState> = {}, extra: Partial<Omit<MenuContext, "state">> = {}): MenuContext {
  return {
    state: { stack, currentCardId: stack.cards[0].id, editLayer: "card", tool: "browse", selectedPartId: null, found: null, ...overrides },
    history: { canUndo: () => false, canRedo: () => false, undoLabel: () => undefined, redoLabel: () => undefined },
    backHistory: [],
    paletteVisible: false,
    ...extra,
  };
}

const cardIds = (t: Harness): string[] => t.store.getSnapshot().stack.cards.map((c) => c.id);
const current = (t: Harness): string => t.store.getSnapshot().currentCardId;

// ---------------------------------------------------------------------------------------------
// Layout and labels (Requirements 1.5, 1.7, 1.8, 2.2, 2.3)
// ---------------------------------------------------------------------------------------------

const SEP = "---";
const EXPECTED_LAYOUT: Record<string, string[]> = {
  Hex: ["About HexCard...", SEP, "ClassicPaper", "AmberCRT", "GreenPhosphor", "MidnightHex"],
  File: [
    "New Stack", "Open Showcase Stack...", SEP, "Open Stack File...", "Save Stack File", SEP, "Import Image...", SEP,
    "Copy Share Link", "Export Standalone HTML",
  ],
  Edit: ["Undo", "Redo", SEP, "Edit Background", SEP, "Icon Editor..."],
  Go: ["Back", "Recent...", SEP, "First", "Prev", "Next", "Last", SEP, "Find...", "Message Box...", SEP, "Stack Graph..."],
  Tools: ["Browse", "Button", "Field", "Select", "Lasso", "Pencil", "Brush", "Eraser", "Line", "Spray", "Rectangle", "Paint Bucket"],
  Objects: [
    "Object Info...", "Card Info...", "Background Info...", "Stack Info...", SEP, "New Button", "New Field", "Delete Part", SEP,
    "New Card", "Delete Card", "New Background",
  ],
  Paint: ["Show Tools Palette"],
  "AI Conjure": ["Conjure Script...", SEP, "Conjure Stack...", "Oracle Settings..."],
};

describe("menu layout", () => {
  const menus = buildMenus(contextOf(threeCards()), "other");

  it("has the eight menus in order with the exact labels and separators of design §6.1", () => {
    const layout = Object.fromEntries(
      menus.map((menu) => [menu.label, menu.entries.map((entry) => (entry.kind === "separator" ? SEP : entry.label))]),
    );
    expect(Object.keys(layout)).toEqual(Object.keys(EXPECTED_LAYOUT));
    expect(layout).toEqual(EXPECTED_LAYOUT);
  });

  it("ends exactly the items that open a window or dialog with '...' (Requirement 1.8)", () => {
    const withDots = items(menus).filter((entry) => entry.label.endsWith("...")).map((entry) => entry.label.slice(0, -3));
    expect(withDots.sort()).toEqual([
      "About HexCard", "Open Showcase Stack", "Open Stack File", "Import Image", "Icon Editor", "Recent", "Find",
      "Message Box", "Stack Graph", "Object Info", "Card Info", "Background Info", "Stack Info", "Conjure Script",
      "Conjure Stack", "Oracle Settings",
    ].sort());
    expect(items(menus).every((entry) => !entry.label.includes("\u2026"))).toBe(true);
  });

  it("writes every label and shortcut label in printable ASCII (Requirement 1.7)", () => {
    for (const platform of ["mac", "other"] as const) {
      for (const menu of buildMenus(contextOf(threeCards()), platform)) {
        expect(menu.label).toMatch(/^[\x20-\x7e]+$/);
        for (const entry of items([menu])) {
          expect(entry.label).toMatch(/^[\x20-\x7e]+$/);
          if (entry.shortcut !== undefined) expect(entry.shortcut).toMatch(/^[\x20-\x7e]+$/);
        }
      }
    }
  });

  it("shows the reserved items disabled and without a shortcut label (Requirement 1.5)", () => {
    const reserved = items(menus).filter((entry) => isReservedCommand(entry.command));
    expect(reserved.map((entry) => entry.command).sort()).toEqual([...RESERVED_COMMANDS].sort());
    for (const entry of reserved) {
      expect(entry.disabled).toBe(true);
      expect(entry.shortcut).toBeUndefined();
    }
  });

  it("labels Undo and Redo with the history labels and the palette item with its state", () => {
    const context = contextOf(threeCards(), {}, {
      history: { canUndo: () => true, canRedo: () => true, undoLabel: () => "New Card", redoLabel: () => "Delete Part" },
      paletteVisible: true,
    });
    expect(findItem(context, "edit.undo").label).toBe("Undo New Card");
    expect(findItem(context, "edit.redo").label).toBe("Redo Delete Part");
    expect(findItem(context, "paint.togglePalette").label).toBe("Hide Tools Palette");
  });

  it("checks the current theme, the current tool and Edit Background", () => {
    const context = contextOf(threeCards(), { tool: "field", editLayer: "background" });
    const checked = items(buildMenus(context, "other")).filter((entry) => entry.checked).map((entry) => entry.command);
    expect(checked).toEqual(["theme:ClassicPaper", "edit.background", "tool:field"]);
    expect(findItem(context, "objects.newCard").checked).toBeUndefined();
  });

  it("lists the tools in the palette order with the palette labels", () => {
    expect(MENU_TOOLS).toEqual(TOOLS.map(({ id, label }) => ({ id, label })));
  });

  it("gives only Edit Background, Undo, Redo, Find and (except on macOS) Message Box a shortcut label (Requirements 2.2, 2.3)", () => {
    const labelled = (platform: "mac" | "other") =>
      items(buildMenus(contextOf(threeCards()), platform))
        .filter((entry) => entry.shortcut !== undefined)
        .map((entry) => [entry.command, entry.shortcut]);
    // Spec 06 Requirements 1.4-1.6: Go > Find has Cmd+F / Ctrl+F; Go > Message Box has Ctrl+M everywhere
    // but macOS, which gets no label.
    expect(labelled("mac")).toEqual([
      ["edit.undo", "Cmd+Z"], ["edit.redo", "Cmd+Shift+Z"], ["edit.background", "Cmd+B"], ["go.find", "Cmd+F"],
    ]);
    expect(labelled("other")).toEqual([
      ["edit.undo", "Ctrl+Z"], ["edit.redo", "Ctrl+Shift+Z"], ["edit.background", "Ctrl+B"], ["go.find", "Ctrl+F"],
      ["go.messageBox", "Ctrl+M"],
    ]);
    expect(shortcutLabel({ key: "Z", shift: true }, "mac")).toBe("Cmd+Shift+Z");
    expect(shortcutLabel({ key: "B", shift: false }, "other")).toBe("Ctrl+B");
  });
});

// ---------------------------------------------------------------------------------------------
// Enabling rules (Requirements 3.5, 4.4, 5.4, 6.1, 7.2, 7.4, 9.4, 10.3, 11.4, 12.2)
// ---------------------------------------------------------------------------------------------

describe("enabling rules", () => {
  const ALWAYS: MenuCommand[] = [
    "hex.about", "theme:AmberCRT", "file.newStack", "file.openShowcase", "file.openStackFile", "file.saveStackFile",
    "file.copyShareLink", "file.exportHtml", "edit.background", "go.stackGraph", "tool:pencil", "objects.cardInfo",
    "objects.backgroundInfo", "objects.stackInfo", "objects.newButton", "objects.newField", "objects.newCard",
    "objects.newBackground", "paint.togglePalette", "ai.conjure",
  ];

  it("keeps the always-enabled items enabled in Browse, authoring tools and Edit Background mode", () => {
    const contexts = [
      contextOf(oneCard()),
      contextOf(threeCards(), { tool: "button", selectedPartId: "prt_b1" }),
      contextOf(threeCards(), { tool: "brush", editLayer: "background", currentCardId: "crd_3" }),
    ];
    for (const context of contexts) {
      for (const command of ALWAYS) expect(isEnabled(command, context), command).toBe(true);
    }
  });

  it("never enables a reserved item", () => {
    const context = contextOf(threeCards(), { tool: "button", selectedPartId: "prt_b1" }, { backHistory: ["crd_2"] });
    for (const command of RESERVED_COMMANDS) expect(isEnabled(command, context)).toBe(false);
  });

  it("enables Undo and Redo from the history", () => {
    const history = { canUndo: () => true, canRedo: () => false, undoLabel: () => "Theme", redoLabel: () => undefined };
    const context = contextOf(threeCards(), {}, { history });
    expect(isEnabled("edit.undo", context)).toBe(true);
    expect(isEnabled("edit.redo", context)).toBe(false);
    expect(isEnabled("edit.undo", contextOf(threeCards()))).toBe(false);
  });

  it("enables First only off the first card, Last only off the last card, Prev and Next with more than one card", () => {
    const first = contextOf(threeCards(), { currentCardId: "crd_1" });
    const middle = contextOf(threeCards(), { currentCardId: "crd_2" });
    const last = contextOf(threeCards(), { currentCardId: "crd_3" });
    const single = contextOf(oneCard());
    expect([first, middle, last, single].map((c) => isEnabled("go.first", c))).toEqual([false, true, true, false]);
    expect([first, middle, last, single].map((c) => isEnabled("go.last", c))).toEqual([true, true, false, false]);
    for (const command of ["go.previous", "go.next"] as const) {
      expect([first, middle, last, single].map((c) => isEnabled(command, c))).toEqual([true, true, true, false]);
    }
  });

  it("enables Back only while the back history names a card of the stack other than the current one", () => {
    const stack = threeCards();
    expect(isEnabled("go.back", contextOf(stack, {}, { backHistory: [] }))).toBe(false);
    expect(isEnabled("go.back", contextOf(stack, {}, { backHistory: ["crd_1"] }))).toBe(false);
    expect(isEnabled("go.back", contextOf(stack, {}, { backHistory: ["crd_gone", "crd_1"] }))).toBe(false);
    expect(isEnabled("go.back", contextOf(stack, {}, { backHistory: ["crd_2", "crd_1"] }))).toBe(true);
  });

  it("enables Object Info and Delete Part only while a part is selected", () => {
    for (const command of ["objects.objectInfo", "objects.deletePart"] as const) {
      expect(isEnabled(command, contextOf(threeCards(), { tool: "button" }))).toBe(false);
      expect(isEnabled(command, contextOf(threeCards(), { tool: "button", selectedPartId: "prt_b1" }))).toBe(true);
    }
  });

  it("enables Delete Card by the HyperCard rule (Requirement 6.1)", () => {
    expect(isEnabled("objects.deleteCard", contextOf(threeCards()))).toBe(true);
    expect(isEnabled("objects.deleteCard", contextOf(oneCard()))).toBe(false);
    expect(isEnabled("objects.deleteCard", contextOf(threeCards({ crd2CantDelete: true }), { currentCardId: "crd_2" }))).toBe(false);
    expect(isEnabled("objects.deleteCard", contextOf(threeCards({ bkg2CantDelete: true }), { currentCardId: "crd_3" }))).toBe(false);
    expect(isEnabled("objects.deleteCard", contextOf(threeCards({ bkg2CantDelete: true }), { currentCardId: "crd_1" }))).toBe(true);
  });

  it("enables Import Image only while a paint tool is active (spec 06 Requirement 1.3)", () => {
    const paint = ["select", "lasso", "pencil", "brush", "eraser", "line", "spray", "rect", "paintBucket"];
    for (const { id } of MENU_TOOLS) {
      for (const editLayer of ["card", "background"] as const) {
        const context = contextOf(threeCards(), { tool: id, editLayer });
        expect(isEnabled("file.importImage", context), `${id} ${editLayer}`).toBe(paint.includes(id));
        expect(findItem(context, "file.importImage").disabled).toBe(!paint.includes(id));
      }
    }
    expect(isReservedCommand("file.importImage")).toBe(false);
    expect(findItem(contextOf(threeCards(), { tool: "pencil" }), "file.importImage")).toMatchObject({ label: "Import Image..." });
    expect(findItem(contextOf(threeCards(), { tool: "pencil" }), "file.importImage").shortcut).toBeUndefined();
  });

  it("draws the item disabled exactly when its rule fails", () => {
    const context = contextOf(threeCards(), { currentCardId: "crd_1" });
    for (const entry of items(buildMenus(context, "mac"))) expect(entry.disabled).toBe(!isEnabled(entry.command, context));
  });
});

// ---------------------------------------------------------------------------------------------
// Coverage over representative states (Requirements 1.1, 1.2, 15.3)
// ---------------------------------------------------------------------------------------------

interface RepresentativeState {
  name: string;
  stack: () => HexStack;
  prepare?: (t: Harness) => Promise<void> | void;
}

const STATES: RepresentativeState[] = [
  { name: "starter stack in Browse", stack: createStarterStack },
  { name: "one card", stack: oneCard },
  { name: "current card with cantDelete", stack: () => threeCards({ crd2CantDelete: true }), prepare: (t) => t.store.applyRuntime({ type: "goToCard", cardId: "crd_2" }) },
  { name: "last card of a background with cantDelete", stack: () => threeCards({ bkg2CantDelete: true }), prepare: (t) => t.store.applyRuntime({ type: "goToCard", cardId: "crd_3" }) },
  {
    name: "Button tool with a selected part",
    stack: threeCards,
    prepare: (t) => {
      t.store.setTool("button");
      t.store.setSelectedPart("prt_b1");
    },
  },
  {
    name: "Edit Background mode with a selected background field",
    stack: threeCards,
    prepare: (t) => {
      t.store.setEditLayer("background");
      t.store.setTool("field");
      t.store.setSelectedPart("prt_f1");
    },
  },
  { name: "Pencil tool (spec 06: Import Image enabled)", stack: threeCards, prepare: (t) => t.store.setTool("pencil") },
  {
    name: "non-empty back history",
    stack: threeCards,
    prepare: (t) => {
      t.store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
      t.store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    },
  },
  {
    name: "history with undo and redo entries",
    stack: threeCards,
    prepare: async (t) => {
      await t.choose("theme:AmberCRT");
      await t.choose("theme:GreenPhosphor");
      await t.choose("edit.undo");
    },
  },
];

function observe(t: Harness) {
  return {
    state: t.store.getSnapshot(),
    undo: `${t.history.canUndo()}:${t.history.undoLabel()}`,
    redo: `${t.history.canRedo()}:${t.history.redoLabel()}`,
    back: t.bus.backHistory().join(","),
    calls: t.calls.length,
    alerts: t.alerts.length,
    palette: t.palette.visible,
    // Spec 06 Requirement 1.10: opening, closing, focusing the Message Box or changing its line.
    messageBox: t.messageBox.getSnapshot(),
  };
}

describe("menu coverage (Requirement 15.3)", () => {
  for (const representative of STATES) {
    it(`connects every enabled item to a handler with an observable effect: ${representative.name}`, async () => {
      const fresh = async (): Promise<Harness> => {
        const t = setup(representative.stack());
        await representative.prepare?.(t);
        return t;
      };
      const probe = await fresh();
      const entries = items(buildMenus(probe.context(), "other"));
      expect(entries.length).toBeGreaterThan(40);
      for (const entry of entries) {
        if (isReservedCommand(entry.command)) {
          expect(entry.disabled, entry.command).toBe(true);
          continue;
        }
        expect(typeof probe.handlers[entry.command], entry.command).toBe("function");
        if (entry.disabled || entry.checked) continue;
        const t = await fresh();
        const before = observe(t);
        expect(await t.choose(entry.command), entry.command).toBe(true);
        expect(observe(t), `${entry.command} in "${representative.name}"`).not.toEqual(before);
      }
    });
  }

  it("ignores a disabled item: runMenuCommand neither runs nor reports it", async () => {
    const t = setup(oneCard());
    const before = observe(t);
    for (const command of ["objects.deleteCard", "go.next", "edit.undo", "objects.deletePart", "go.recent"] as const) {
      expect(await t.choose(command)).toBe(false);
    }
    expect(observe(t)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Shortcuts and text inputs (Requirements 2.1-2.6, 16.1, 16.2, 16.5)
// ---------------------------------------------------------------------------------------------

interface FakeElement {
  tagName: string;
  attributes: ReadonlySet<string>;
  parent?: FakeElement;
  closest(selector: string): FakeElement | null;
}

/** Just enough of `Element.closest` for tag and `[attribute]` selector lists. */
function element(tag: string, attributes: string[] = [], parent?: FakeElement): FakeElement {
  const matches = (node: FakeElement, selector: string): boolean =>
    selector.split(",").map((part) => part.trim()).some((part) =>
      part.startsWith("[") ? node.attributes.has(part.slice(1, -1)) : node.tagName === part.toUpperCase());
  const self: FakeElement = {
    tagName: tag.toUpperCase(),
    attributes: new Set(attributes),
    parent,
    closest(selector) {
      for (let node: FakeElement | undefined = self; node; node = node.parent) if (matches(node, selector)) return node;
      return null;
    },
  };
  return self;
}

const body = element("body");
const desktop = element("div", [], body);

interface Press extends KeyLike {
  prevented: boolean;
  preventDefault(): void;
}

function press(init: Partial<KeyLike> & { key: string }, target: unknown = desktop): Press {
  const event: Press = {
    code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init,
    target: target as EventTarget | null,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  return event;
}

const ctrl = (code: "KeyB" | "KeyZ" | "KeyM" | "KeyF", shiftKey = false, extra: Partial<KeyLike> = {}) =>
  ({ key: code.slice(3).toLowerCase(), code, ctrlKey: true, shiftKey, ...extra });
const cmd = (code: "KeyB" | "KeyZ" | "KeyM" | "KeyF", shiftKey = false) => ({ key: code.slice(3).toLowerCase(), code, metaKey: true, shiftKey });

/** Records every handler call; every command is enabled except what the context rules out. */
function recordingHandlers(): { handlers: MenuHandlers; ran: MenuCommand[] } {
  const ran: MenuCommand[] = [];
  const handlers = new Proxy({} as MenuHandlers, {
    get: (_target, command) => () => void ran.push(command as MenuCommand),
  });
  return { handlers, ran };
}

const enabledEverything = (): MenuContext =>
  contextOf(threeCards(), { tool: "button", selectedPartId: "prt_b1" }, {
    history: { canUndo: () => true, canRedo: () => true, undoLabel: () => "Theme", redoLabel: () => "Theme" },
  });

describe("shortcuts", () => {
  it("assigns no shortcut that browsers reserve (Requirement 2.1)", () => {
    expect(SHORTCUTS).toHaveLength(5);
    // Spec 06 Requirement 1.9: no new shortcut collides with a reserved combination either.
    for (const { shortcut } of SHORTCUTS) {
      const clash = RESERVED_BROWSER_SHORTCUTS.find((reserved) => reserved.key === shortcut.key && reserved.shift === shortcut.shift);
      expect(clash).toBeUndefined();
    }
    for (const key of ["N", "T", "W", "Q", "Tab"]) {
      expect(RESERVED_BROWSER_SHORTCUTS.some((r) => r.key === key && !r.shift)).toBe(true);
    }
  });

  it("maps Cmd and Ctrl + B / Z / Shift+Z by physical key on every platform, and prevents the default", () => {
    const context = enabledEverything();
    for (const make of [ctrl, cmd]) {
      expect(shortcutCommand(press(make("KeyB")), context, "other")).toEqual({ command: "edit.background", preventDefault: true });
      expect(shortcutCommand(press(make("KeyZ")), context, "other")).toEqual({ command: "edit.undo", preventDefault: true });
      expect(shortcutCommand(press(make("KeyZ", true)), context, "other")).toEqual({ command: "edit.redo", preventDefault: true });
    }
    // Another keyboard layout: the key value differs, the physical key is the same.
    expect(shortcutCommand(press({ key: "y", code: "KeyZ", ctrlKey: true }), context, "other")?.command).toBe("edit.undo");
  });

  it("maps nothing else: no Alt combinations, no Shift+B, no digits, no arrows, no abort shortcut", () => {
    const context = enabledEverything();
    const unmapped = [
      ctrl("KeyB", false, { altKey: true }), ctrl("KeyZ", false, { altKey: true }), ctrl("KeyB", true),
      { key: "1", code: "Digit1", ctrlKey: true }, { key: "n", code: "KeyN", metaKey: true },
      { key: "b", code: "KeyB" }, { key: "ArrowLeft", code: "ArrowLeft" }, { key: "ArrowRight", code: "ArrowRight" },
      { key: ".", code: "Period", metaKey: true }, { key: ".", code: "Period", ctrlKey: true },
    ];
    for (const init of unmapped) expect(shortcutCommand(press(init), context, "other"), JSON.stringify(init)).toBeUndefined();
  });

  it("runs the menu handler of an enabled shortcut and prevents the default (Requirement 2.4)", () => {
    const { handlers, ran } = recordingHandlers();
    const event = press(ctrl("KeyZ", true));
    expect(handleShortcutKey(event, enabledEverything(), handlers, "other")).toBe("edit.redo");
    expect(ran).toEqual(["edit.redo"]);
    expect(event.prevented).toBe(true);
  });

  it("prevents a disabled shortcut but does not run it", () => {
    const { handlers, ran } = recordingHandlers();
    const event = press(cmd("KeyZ"));
    expect(handleShortcutKey(event, contextOf(threeCards()), handlers, "other")).toBeUndefined();
    expect(ran).toEqual([]);
    expect(event.prevented).toBe(true);
  });

  it("maps Delete and Backspace to Delete Part only while a part is selected (Requirement 2.5)", () => {
    for (const key of ["Delete", "Backspace"]) {
      const { handlers, ran } = recordingHandlers();
      const selected = press({ key, code: key });
      expect(handleShortcutKey(selected, enabledEverything(), handlers, "other")).toBe("objects.deletePart");
      expect(selected.prevented).toBe(true);
      expect(ran).toEqual(["objects.deletePart"]);

      const unselected = press({ key, code: key });
      expect(handleShortcutKey(unselected, contextOf(threeCards(), { tool: "button" }), handlers, "other")).toBeUndefined();
      expect(unselected.prevented).toBe(false);
      for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"] as const) {
        expect(shortcutCommand(press({ key, code: key, [modifier]: true }), enabledEverything(), "other")).toBeUndefined();
      }
    }
  });

  it("fires no studio shortcut and prevents nothing inside a text input (Requirements 16.1, 16.2, 16.5)", () => {
    const inspector = element("div", [], body);
    const editable = element("div", ["contenteditable"], body);
    const targets: Record<string, FakeElement> = {
      "hidden card textarea": element("textarea", [], element("div", [], body)),
      "Object Inspector text box": element("input", [], inspector),
      "script editor": element("textarea", [], inspector),
      "Spellcaster prompt": element("textarea", [], inspector),
      "ask dialog text box": element("input", [], element("div", [], body)),
      // Spec 06 Requirement 15.3: the Message Box text box is a text input too.
      "Message Box text box": element("input", [], element("div", [], body)),
      "select box": element("select", [], inspector),
      "contenteditable element": editable,
      "inside a contenteditable element": element("span", [], editable),
    };
    const shortcuts = [ctrl("KeyB"), cmd("KeyB"), ctrl("KeyZ"), cmd("KeyZ"), ctrl("KeyZ", true), cmd("KeyZ", true),
      ctrl("KeyM"), cmd("KeyM"), ctrl("KeyF"), cmd("KeyF"), { key: "Delete", code: "Delete" }, { key: "Backspace", code: "Backspace" }];
    for (const [name, target] of Object.entries(targets)) {
      expect(isTextInputTarget(target as unknown as EventTarget), name).toBe(true);
      for (const init of shortcuts) {
        const { handlers, ran } = recordingHandlers();
        const event = press(init, target);
        expect(shortcutCommand(event, enabledEverything(), "other"), `${name} ${init.key}`).toBeUndefined();
        expect(handleShortcutKey(event, enabledEverything(), handlers, "other")).toBeUndefined();
        expect(ran).toEqual([]);
        expect(event.prevented, `${name} ${init.key}`).toBe(false);
      }
    }
  });

  it("maps Cmd and Ctrl + M to Go > Message Box except on macOS, where it maps and prevents nothing (spec 06 Requirements 1.4-1.7)", () => {
    const context = enabledEverything();
    for (const make of [ctrl, cmd]) {
      expect(shortcutCommand(press(make("KeyM")), context, "other")).toEqual({ command: "go.messageBox", preventDefault: true });
      expect(shortcutCommand(press(make("KeyM")), context, "mac")).toBeUndefined();
      expect(shortcutCommand(press(make("KeyM", true)), context, "other")).toBeUndefined(); // no Shift variant
      expect(shortcutCommand(press({ ...make("KeyM"), altKey: true }), context, "other")).toBeUndefined();

      const { handlers, ran } = recordingHandlers();
      const onMac = press(make("KeyM"));
      expect(handleShortcutKey(onMac, context, handlers, "mac")).toBeUndefined();
      expect(onMac.prevented).toBe(false);
      const elsewhere = press(make("KeyM"));
      expect(handleShortcutKey(elsewhere, context, handlers, "other")).toBe("go.messageBox");
      expect(elsewhere.prevented).toBe(true);
      expect(ran).toEqual(["go.messageBox"]);
    }
    // The other shortcuts are the same on both platforms.
    expect(shortcutCommand(press(cmd("KeyB")), context, "mac")).toEqual({ command: "edit.background", preventDefault: true });
    expect(shortcutCommand(press(ctrl("KeyZ", true)), context, "mac")).toEqual({ command: "edit.redo", preventDefault: true });
  });

  it("maps Cmd and Ctrl + F to Go > Find on every platform and prevents the default (spec 06 Requirements 1.4, 1.6, 1.7)", () => {
    const context = enabledEverything();
    for (const platform of ["mac", "other"] as const) {
      for (const make of [ctrl, cmd]) {
        expect(shortcutCommand(press(make("KeyF")), context, platform)).toEqual({ command: "go.find", preventDefault: true });
        expect(shortcutCommand(press(make("KeyF", true)), context, platform)).toBeUndefined(); // no Shift variant
        expect(shortcutCommand(press({ ...make("KeyF"), altKey: true }), context, platform)).toBeUndefined();
        const { handlers, ran } = recordingHandlers();
        const event = press(make("KeyF"));
        expect(handleShortcutKey(event, context, handlers, platform)).toBe("go.find");
        expect(event.prevented).toBe(true);
        expect(ran).toEqual(["go.find"]);
      }
    }
    // Another keyboard layout: the physical key decides.
    expect(shortcutCommand(press({ key: "u", code: "KeyF", ctrlKey: true }), context, "other")?.command).toBe("go.find");
  });

  it("assigns no reserved combination on either platform (spec 06 Requirement 1.9)", () => {
    for (const platform of ["mac", "other"] as const) {
      for (const reserved of RESERVED_BROWSER_SHORTCUTS) {
        if (reserved.key.length !== 1) continue;
        const code = `Key${reserved.key}`;
        for (const modifier of reserved.modifier === "ctrl" ? ["ctrlKey"] as const : ["ctrlKey", "metaKey"] as const) {
          const event = press({ key: reserved.key.toLowerCase(), code, [modifier]: true, shiftKey: reserved.shift });
          expect(shortcutCommand(event, enabledEverything(), platform), `${platform} ${code}`).toBeUndefined();
        }
      }
    }
  });

  it("does not treat other targets as text inputs", () => {
    expect(isTextInputTarget(null)).toBe(false);
    expect(isTextInputTarget(desktop as unknown as EventTarget)).toBe(false);
    expect(isTextInputTarget(element("button", [], body) as unknown as EventTarget)).toBe(false);
    expect(isTextInputTarget({} as EventTarget)).toBe(false); // window or document: no closest()
  });

  it("detects the platform from userAgentData, then navigator.platform", () => {
    expect(detectPlatform({ userAgentData: { platform: "macOS" }, platform: "Win32" })).toBe("mac");
    expect(detectPlatform({ userAgentData: { platform: "Windows" }, platform: "MacIntel" })).toBe("other");
    expect(detectPlatform({ userAgentData: { platform: "" }, platform: "MacIntel" })).toBe("mac");
    expect(detectPlatform({ platform: "Linux x86_64" })).toBe("other");
    expect(detectPlatform({})).toBe("other");
  });
});

// ---------------------------------------------------------------------------------------------
// Command dispatches end to end (Requirements 4.2, 4.3, 5.2, 6.2, 6.4, 6.5, 11, 13.4, 13.5)
// ---------------------------------------------------------------------------------------------

/** A handler that runs `go` to crd_3 once (its own closeCard during that `go` passes). */
const goOnce = (): Behaviour => {
  let done = false;
  return async (ctx, bus) => {
    if (done) return "passed";
    done = true;
    await bus.changeCard("crd_3", ctx);
    return "handled";
  };
};
const fail: Behaviour = async () => {
  throw new HexScriptError("boom");
};
const abort: Behaviour = async (_ctx, bus) => {
  bus.abort();
  return "handled";
};

describe("New Card", () => {
  it("inserts the card after the current one in one dispatch: closeCard, newCard, openCard (Requirement 4.2)", async () => {
    const t = setup(threeCards());
    expect(await t.choose("objects.newCard")).toBe(true);
    const created = cardIds(t)[1];
    expect(cardIds(t)).toEqual(["crd_1", created, "crd_2", "crd_3"]);
    expect(current(t)).toBe(created);
    expect(t.log).toEqual(["closeCard@crd_1", `newCard@${created}`, `openCard@${created}`]);
    expect(t.bus.backHistory()).toEqual(["crd_1"]);
    expect(t.history.undoLabel()).toBe("New Card");
    expect(validateStack(t.store.getSnapshot().stack).ok).toBe(true);
  });

  it("works in an authoring tool and in Edit Background mode (Requirement 4.4)", async () => {
    const t = setup(threeCards());
    t.store.setTool("brush");
    t.store.setEditLayer("background");
    await t.choose("objects.newCard");
    expect(cardIds(t)).toHaveLength(4);
    expect(t.log).toHaveLength(3);
  });

  it("is not inserted when a closeCard handler fails, goes elsewhere or aborts (Requirement 4.3)", async () => {
    const script = handlersFor(["closeCard"]);
    const cases: [string, Behaviour, number][] = [["error", fail, 1], ["go", goOnce(), 0], ["abort", abort, 0]];
    for (const [name, behaviour, errorCount] of cases) {
      const t = setup(threeCards({ scripts: { crd_1: script } }), { "crd_1.closecard": behaviour });
      const before = t.store.getSnapshot().stack;
      await t.choose("objects.newCard");
      expect(t.store.getSnapshot().stack, name).toBe(before);
      expect(t.history.canUndo(), name).toBe(false);
      expect(t.log.filter((entry) => entry.startsWith("newCard")), name).toEqual([]);
      expect(t.errors, name).toHaveLength(errorCount);
    }
  });

  it("undoes and redoes without any message, restoring the current card (Requirements 13.4, 13.5)", async () => {
    const t = setup(threeCards());
    t.store.setTool("pencil");
    await t.choose("objects.newCard");
    const created = current(t);
    t.log.length = 0;
    await t.choose("edit.undo");
    expect(cardIds(t)).toEqual(["crd_1", "crd_2", "crd_3"]);
    expect(current(t)).toBe("crd_1");
    await t.choose("edit.redo");
    expect(current(t)).toBe(created);
    expect(t.log).toEqual([]);
    expect(t.store.getSnapshot().tool).toBe("pencil");
    expect(t.store.getSnapshot().editLayer).toBe("card");
  });
});

describe("New Background", () => {
  it("sends closeCard, closeBackground, newCard, openBackground, openCard (Requirement 5.2)", async () => {
    const t = setup(threeCards());
    await t.choose("objects.newBackground");
    const { stack, currentCardId } = t.store.getSnapshot();
    const created = stack.cards[1];
    expect(created.id).toBe(currentCardId);
    expect(stack.backgrounds.map((b) => b.id).slice(0, 2)).toEqual(["bkg_1", "bkg_2"]);
    expect(stack.backgrounds[2].id).toBe(created.backgroundId);
    expect(stack.backgrounds[2].name).toBe("Background 1");
    expect(t.log).toEqual([
      "closeCard@crd_1", "closeBackground@crd_1", `newCard@${created.id}`, `openBackground@${created.id}`, `openCard@${created.id}`,
    ]);
    expect(t.history.undoLabel()).toBe("New Background");
  });

  it("is not created when a closeBackground handler fails (Requirement 5.3)", async () => {
    const t = setup(threeCards({ scripts: { crd_1: handlersFor(["closeBackground"]) } }), { "crd_1.closebackground": fail });
    const before = t.store.getSnapshot().stack;
    await t.choose("objects.newBackground");
    expect(t.store.getSnapshot().stack).toBe(before);
    expect(t.errors).toHaveLength(1);
  });
});

describe("Delete Card", () => {
  it("sends deleteCard, closeCard, closeBackground, openBackground, openCard when the background changes (Requirement 6.2)", async () => {
    const t = setup(threeCards());
    t.store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    await t.choose("objects.deleteCard");
    expect(cardIds(t)).toEqual(["crd_1", "crd_3"]);
    expect(current(t)).toBe("crd_3");
    expect(t.log).toEqual(["deleteCard@crd_2", "closeCard@crd_2", "closeBackground@crd_2", "openBackground@crd_3", "openCard@crd_3"]);
    expect(t.history.undoLabel()).toBe("Delete Card");
  });

  it("sends no background messages on the same background", async () => {
    const t = setup(threeCards());
    await t.choose("objects.deleteCard");
    expect(current(t)).toBe("crd_2");
    expect(t.log).toEqual(["deleteCard@crd_1", "closeCard@crd_1", "openCard@crd_2"]);
  });

  it("goes to the previous card from the last one and removes its background; Undo restores both (Requirement 6.3)", async () => {
    const t = setup(threeCards());
    t.store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    const before = t.store.getSnapshot().stack;
    await t.choose("objects.deleteCard");
    expect(current(t)).toBe("crd_2");
    expect(t.store.getSnapshot().stack.backgrounds.map((b) => b.id)).toEqual(["bkg_1"]);
    await t.choose("edit.undo");
    expect(t.store.getSnapshot().stack).toEqual(before);
    expect(current(t)).toBe("crd_3");
  });

  it("leaves the stack unchanged when a deleteCard handler goes elsewhere or fails (Requirement 6.4)", async () => {
    for (const behaviour of [goOnce(), fail]) {
      const t = setup(threeCards({ scripts: { crd_1: handlersFor(["deleteCard"]) } }), { "crd_1.deletecard": behaviour });
      await t.choose("objects.deleteCard");
      expect(cardIds(t)).toEqual(["crd_1", "crd_2", "crd_3"]);
      expect(t.history.canUndo()).toBe(false);
    }
  });

  it("keeps Go > Back working: the deleted card is skipped (Requirement 6.5)", async () => {
    const t = setup(threeCards());
    await t.choose("go.next"); // crd_2, back: crd_1
    await t.choose("go.next"); // crd_3, back: crd_1, crd_2
    t.store.applyRuntime({ type: "goToCard", cardId: "crd_2" }); // back: crd_1, crd_2, crd_3
    await t.choose("objects.deleteCard"); // crd_2 deleted, destination crd_3
    expect(current(t)).toBe("crd_3");
    expect(isEnabled("go.back", t.context())).toBe(true);
    await t.choose("go.back");
    expect(current(t)).toBe("crd_1");
  });

  it("alerts 'Delete Card is not available now.' when the rule fails as its dispatch starts (Requirement 1.6)", async () => {
    const t = setup(makeStack([background("bkg_1")], [card("crd_1", "bkg_1"), card("crd_2", "bkg_1")]));
    const context = t.context();
    runMenuCommand("objects.deleteCard", context, t.handlers);
    runMenuCommand("objects.deleteCard", context, t.handlers);
    await settle();
    expect(cardIds(t)).toEqual(["crd_2"]);
    expect(t.alerts).toEqual(["Delete Card is not available now."]);
  });
});

describe("Go menu", () => {
  it("goes with the lifecycle messages of go in any tool, wrapping Prev and Next (Requirements 11.1, 11.2)", async () => {
    const t = setup(threeCards());
    t.store.setTool("button");
    await t.choose("go.next");
    expect(current(t)).toBe("crd_2");
    expect(t.log).toEqual(["closeCard@crd_1", "openCard@crd_2"]);
    t.log.length = 0;
    await t.choose("go.last");
    expect(t.log).toEqual(["closeCard@crd_2", "closeBackground@crd_2", "openBackground@crd_3", "openCard@crd_3"]);
    await t.choose("go.next");
    expect(current(t)).toBe("crd_1");
    await t.choose("go.previous");
    expect(current(t)).toBe("crd_3");
    await t.choose("go.first");
    expect(current(t)).toBe("crd_1");
  });

  it("goes back through the message bus (Requirement 11.3)", async () => {
    const t = setup(threeCards());
    await t.choose("go.last");
    t.log.length = 0;
    await t.choose("go.back");
    expect(current(t)).toBe("crd_1");
    expect(t.log).toEqual(["closeCard@crd_3", "closeBackground@crd_3", "openBackground@crd_1", "openCard@crd_1"]);
  });

  it("resolves the destination when the dispatch starts (Requirement 11.5)", async () => {
    const t = setup(threeCards());
    const context = t.context();
    runMenuCommand("go.next", context, t.handlers);
    runMenuCommand("go.next", context, t.handlers);
    await settle();
    expect(current(t)).toBe("crd_3");
  });

  it("alerts '<label> is not available now.' when the rule no longer holds (Requirement 1.6)", async () => {
    const t = setup(threeCards());
    t.store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    const context = t.context();
    runMenuCommand("go.first", context, t.handlers);
    runMenuCommand("go.first", context, t.handlers);
    await settle();
    expect(current(t)).toBe("crd_1");
    expect(t.alerts).toEqual(["First is not available now."]);
  });

  it("is not recorded in the undo history (Requirement 11.6)", async () => {
    const t = setup(threeCards());
    await t.choose("theme:AmberCRT");
    await t.choose("edit.undo");
    await t.choose("go.next");
    await t.choose("go.last");
    expect(t.history.undoLabel()).toBeUndefined();
    expect(t.history.redoLabel()).toBe("Theme");
    expect(findItem(t.context(), "edit.redo").label).toBe("Redo Theme");
  });
});

// ---------------------------------------------------------------------------------------------
// Parts, inspector and Spellcaster items (Requirements 7, 9.3, 10.3, 10.5, 12.1)
// ---------------------------------------------------------------------------------------------

describe("parts", () => {
  it("New Button adds a button on the card, selects the Button tool and the new part, and sends nothing (Requirements 9.3, 10.5)", async () => {
    const t = setup(threeCards());
    await t.choose("objects.newButton");
    const { stack, tool, selectedPartId } = t.store.getSnapshot();
    const parts = stack.cards[0].parts;
    expect(parts.map((p) => p.name)).toEqual(["Go", "New Button"]);
    expect(tool).toBe("button");
    expect(selectedPartId).toBe(parts[1].id);
    expect(t.history.undoLabel()).toBe("New Button");
    expect(t.log).toEqual([]);
  });

  it("New Field in Edit Background mode adds a background field and selects the Field tool", async () => {
    const t = setup(threeCards());
    t.store.setEditLayer("background");
    await t.choose("objects.newField");
    const { stack, tool, selectedPartId } = t.store.getSnapshot();
    const added = stack.backgrounds[0].parts[1];
    expect(added).toMatchObject({ type: "field", name: "New Field", layerScope: "background" });
    expect(tool).toBe("field");
    expect(selectedPartId).toBe(added.id);
  });

  it("Delete Part removes the selected part as one command and clears the selection (Requirement 10.3)", async () => {
    const t = setup(threeCards());
    t.store.setTool("button");
    t.store.setSelectedPart("prt_b1");
    await t.choose("objects.deletePart");
    expect(t.store.getSnapshot().stack.cards[0].parts).toEqual([]);
    expect(t.store.getSnapshot().selectedPartId).toBeNull();
    expect(t.history.undoLabel()).toBe("Delete Part");
    expect(t.log).toEqual([]);
    await t.choose("edit.undo");
    expect(t.store.getSnapshot().stack.cards[0].parts.map((p) => p.id)).toEqual(["prt_b1"]);
  });

  it("opens the inspector on the selected part, the card, its background and the stack (Requirements 7.1, 7.3)", async () => {
    const t = setup(threeCards());
    t.store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    await t.choose("objects.cardInfo");
    await t.choose("objects.backgroundInfo");
    await t.choose("objects.stackInfo");
    t.store.applyRuntime({ type: "goToCard", cardId: "crd_1" });
    t.store.setTool("button");
    t.store.setSelectedPart("prt_b1");
    await t.choose("objects.objectInfo");
    expect(t.calls).toEqual([
      "inspector:crd_3:properties", "inspector:bkg_2:properties", "inspector:stk_1:properties", "inspector:prt_b1:properties",
    ]);
  });

  it("Conjure Script opens the Spellcaster tab for the selected part, else the current card (Requirement 12.1)", async () => {
    const t = setup(threeCards());
    await t.choose("ai.conjure");
    t.store.setTool("button");
    t.store.setSelectedPart("prt_b1");
    await t.choose("ai.conjure");
    expect(t.calls).toEqual(["inspector:crd_1:spellcaster", "inspector:prt_b1:spellcaster"]);
  });

  it("About HexCard shows the About alert", async () => {
    const t = setup(threeCards());
    await t.choose("hex.about");
    expect(t.alerts).toEqual([ABOUT_MESSAGE]);
  });
});

// ---------------------------------------------------------------------------------------------
// File > Import Image (spec 06 Requirements 1.1, 1.3, 6.1)
// ---------------------------------------------------------------------------------------------

describe("File > Import Image", () => {
  const png: ImageFileLike = { type: "image/png", size: 8, arrayBuffer: async () => new ArrayBuffer(8) };

  it("opens the file chooser, then imports the chosen file, and sends no message", async () => {
    const t = setup(threeCards(), {}, undefined, png);
    t.store.setTool("brush");
    expect(await t.choose("file.importImage")).toBe(true);
    expect(t.calls).toEqual(["pickImageFile", "importFile:image/png"]);
    expect(t.log).toEqual([]);
  });

  it("imports nothing when the chooser is cancelled", async () => {
    const t = setup(threeCards());
    t.store.setTool("pencil");
    expect(await t.choose("file.importImage")).toBe(true);
    expect(t.calls).toEqual(["pickImageFile"]);
  });

  it("does not run without a paint tool", async () => {
    const t = setup(threeCards(), {}, undefined, png);
    expect(await t.choose("file.importImage")).toBe(false);
    t.store.setTool("button");
    expect(await t.choose("file.importImage")).toBe(false);
    expect(t.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Edit > Icon Editor (spec 06 Requirements 1.1, 1.3, 10.1)
// ---------------------------------------------------------------------------------------------

describe("Go > Message Box (spec 06 Requirements 1.1, 1.3, 2.1, 2.2)", () => {
  it("is a real item labelled Message Box..., enabled with every tool and edit layer", () => {
    expect(isReservedCommand("go.messageBox")).toBe(false);
    for (const { id } of MENU_TOOLS) {
      for (const editLayer of ["card", "background"] as const) {
        const context = contextOf(threeCards(), { tool: id, editLayer });
        expect(isEnabled("go.messageBox", context), `${id} ${editLayer}`).toBe(true);
        expect(findItem(context, "go.messageBox")).toMatchObject({ label: "Message Box...", disabled: false, shortcut: "Ctrl+M" });
      }
    }
    const onMac = items(buildMenus(contextOf(threeCards()), "mac")).find((entry) => entry.command === "go.messageBox");
    expect(onMac?.shortcut).toBeUndefined();
  });

  it("opens with the caret at the end, then selects the whole line while open; sends no message", async () => {
    const t = setup(threeCards());
    t.messageBox.setLine("put 1 into x");
    expect(await t.choose("go.messageBox")).toBe(true);
    const first = t.messageBox.getSnapshot();
    expect(first).toMatchObject({ open: true, line: "put 1 into x", focus: { select: "end" } });
    expect(await t.choose("go.messageBox")).toBe(true);
    const second = t.messageBox.getSnapshot();
    expect(second).toMatchObject({ open: true, line: "put 1 into x", focus: { select: "all" } });
    expect(second.focus!.id).not.toBe(first.focus!.id);
    expect(t.log).toEqual([]);
    expect(t.history.canUndo()).toBe(false);
  });
});

describe("Go > Find (spec 06 Requirements 1.1, 1.3, 4.1)", () => {
  it("is a real item labelled Find..., enabled with every tool and edit layer, with Cmd+F / Ctrl+F", () => {
    expect(isReservedCommand("go.find")).toBe(false);
    expect(RESERVED_COMMANDS.has("go.find")).toBe(false);
    for (const { id } of MENU_TOOLS) {
      for (const editLayer of ["card", "background"] as const) {
        const context = contextOf(threeCards(), { tool: id, editLayer });
        expect(isEnabled("go.find", context), `${id} ${editLayer}`).toBe(true);
        expect(findItem(context, "go.find")).toMatchObject({ label: "Find...", disabled: false, shortcut: "Ctrl+F" });
      }
    }
    expect(items(buildMenus(contextOf(threeCards()), "mac")).find((entry) => entry.command === "go.find")?.shortcut).toBe("Cmd+F");
  });

  it('opens the Message Box with find "" and the caret between the quotes, replacing the line; sends no message', async () => {
    const t = setup(threeCards());
    t.messageBox.setLine("put 1 into x");
    expect(await t.choose("go.find")).toBe(true);
    const first = t.messageBox.getSnapshot();
    expect(first).toMatchObject({ open: true, line: 'find ""', focus: { select: { start: 6, end: 6 } } });
    expect(FIND_TEMPLATE.slice(0, FIND_CARET)).toBe('find "');
    t.messageBox.setLine('find "lamp"');
    expect(await t.choose("go.find")).toBe(true); // already open: the line is replaced again
    const second = t.messageBox.getSnapshot();
    expect(second).toMatchObject({ open: true, line: 'find ""', focus: { select: { start: 6, end: 6 } } });
    expect(second.focus!.id).not.toBe(first.focus!.id);
    expect(t.log).toEqual([]);
    expect(t.history.canUndo()).toBe(false);
  });
});

describe("Edit > Icon Editor", () => {
  it("is a real item with its label, no shortcut, enabled with every tool and edit layer", () => {
    expect(isReservedCommand("edit.iconEditor")).toBe(false);
    expect(RESERVED_COMMANDS.has("edit.iconEditor")).toBe(false);
    for (const { id } of MENU_TOOLS) {
      for (const editLayer of ["card", "background"] as const) {
        const context = contextOf(threeCards(), { tool: id, editLayer });
        expect(isEnabled("edit.iconEditor", context), `${id} ${editLayer}`).toBe(true);
        expect(findItem(context, "edit.iconEditor")).toMatchObject({ label: "Icon Editor...", disabled: false });
      }
    }
    expect(findItem(contextOf(threeCards()), "edit.iconEditor").shortcut).toBeUndefined();
  });

  it("opens the Icon Editor window and sends no message", async () => {
    const t = setup(threeCards());
    expect(await t.choose("edit.iconEditor")).toBe(true);
    expect(t.calls).toEqual(["iconEditor"]);
    expect(t.log).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// File > New Stack (Requirements 3.1, 3.4, 3.5)
// ---------------------------------------------------------------------------------------------

describe("File > New Stack", () => {
  function withRealFiles(stack: HexStack, choice: string) {
    const holder: { t?: Harness } = {};
    const asked: string[] = [];
    const lazyStore = {
      getSnapshot: () => holder.t!.store.getSnapshot(),
      onReplaceStack: (listener: () => void) => holder.t!.store.onReplaceStack(listener),
    };
    const files = {
      replaceStackFrom: (read: () => unknown) => real().replaceStackFrom(read),
      openStackFile: () => real().openStackFile(),
      saveStackFile: () => real().saveStackFile(),
      copyShareLink: () => real().copyShareLink(),
      exportStandaloneHtml: () => real().exportStandaloneHtml(),
      pickImageFile: () => real().pickImageFile(),
    };
    let commands: ReturnType<typeof createFileCommands> | undefined;
    const real = () => {
      if (commands) return commands;
      const t = holder.t!;
      const loader = createStackLoader({ store: t.store, history: t.history, alert: (message) => t.alerts.push(message) });
      commands = createFileCommands({
        getStack: () => t.store.getSnapshot().stack,
        loader,
        modals: {
          alert: async (message) => {
            asked.push(message);
            return choice;
          },
        },
        browser: {
          download: () => {},
          pickFile: async () => undefined,
          pickImage: async () => undefined,
          copyText: async () => {},
          pageUrl: () => "https://example.com/",
        },
        changes: createChangeTracker(lazyStore),
      });
      return commands;
    };
    holder.t = setup(stack, {}, files);
    real(); // the change tracker takes the initial stack as its baseline
    return { t: holder.t, asked };
  }

  it("loads a blank stack through the stack loader, selects Browse and opens it (Requirements 3.2-3.4)", async () => {
    const { t, asked } = withRealFiles(threeCards(), DONT_SAVE_BUTTON);
    t.store.setEditLayer("background");
    t.store.setTool("button");
    await t.choose("theme:AmberCRT");
    expect(isEnabled("file.newStack", t.context())).toBe(true);
    await t.choose("file.newStack");
    const { stack, tool, editLayer, currentCardId } = t.store.getSnapshot();
    expect(asked).toEqual(["Save changes to a file first?"]);
    expect(stack.name).toBe("Untitled");
    expect(stack.id).toMatch(/^stk_/);
    expect(stack.cards.map((c) => c.name)).toEqual(["Card 1"]);
    expect(validateStack(stack).ok).toBe(true);
    expect(tool).toBe("browse");
    expect(editLayer).toBe("card");
    expect(t.history.canUndo()).toBe(false);
    expect(currentCardId).toBe(stack.cards[0].id);
    expect(t.bus.backHistory()).toEqual([]);
  });

  it("leaves the current stack unchanged when the unsaved-changes guard is cancelled (Requirement 3.1)", async () => {
    const { t, asked } = withRealFiles(threeCards(), CANCEL_BUTTON);
    await t.choose("theme:AmberCRT");
    const before = t.store.getSnapshot();
    await t.choose("file.newStack");
    expect(asked).toEqual(["Save changes to a file first?"]);
    expect(t.store.getSnapshot()).toBe(before);
  });
});
