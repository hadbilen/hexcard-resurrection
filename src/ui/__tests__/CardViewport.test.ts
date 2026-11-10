/**
 * Spec 04 task 3: card viewport logic (pointer mapping, Browse forwarding, field editing rules,
 * part move/resize), the starter stack, the UI store view and server rendering of the viewport.
 */
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHistory } from "../../core/history.ts";
import { createMessageBus, type HexMessage } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import type { HexButtonPart, HexFieldPart, HexStack } from "../../core/schema.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { createHexStore, type HexStore } from "../../core/store.ts";
import type { HexValue } from "../../core/vm.ts";
import { createPaintController, DEFAULT_PAINT_SETTINGS } from "../../engine/graphics/paintTools.ts";
import { FATBITS_START, insetRect } from "../../engine/graphics/fatBits.ts";
import { decodeBitmapRLE } from "../../engine/graphics/rleCodec.ts";
import { createUiStoreView } from "../App.tsx";
import { importDroppedImage } from "../../engine/graphics/imageImport.ts";
import {
  CardViewport,
  cardDragOver,
  cardDrop,
  PartSelection,
  SelectionMarquee,
  cardRectStyle,
  clientToCardPoint,
  createBrowseInput,
  createPartRectCommand,
  dragRect,
  editableField,
  fieldExitMessage,
  fatBitsKeyAction,
  fatBitsPaintPoint,
  foundOptions,
  handleAt,
  scrollTargetForFound,
  hitTestLayerPart,
  HANDLE_SIZE,
  MIN_PART_SIZE,
} from "../CardViewport.tsx";
import { CARD_FRAME_WIDTH, computeUiScale, menuBarHeight } from "../FloatingTools.tsx";
import { createStarterStack } from "../starterStack.ts";
import { createModalManager, guardFileDrag, System7Shell } from "../System7Shell.tsx";
import { buildMenus, isReservedCommand, type MenuContext, type ShellMenuHandlers } from "../menuCommands.ts";

// Read as plain text: Vitest's CSS handling turns `system7.css?raw` into "".
const SHELL_CSS = readFileSync(new URL("../system7.css", import.meta.url), "utf8");
import { createEffectStage, createMouseTracker, createVmHost } from "../vmHost.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

/** Appends the message name to the global `log`. */
const logger = (...names: string[]): string => names.map((name) => [
  `on ${name}`,
  "  global log",
  `  put "${name} " & the name of me & "," after log`,
  `end ${name}`,
].join("\n")).join("\n\n");

function makeStack(): HexStack {
  const buttonScript = logger("mouseDown", "mouseUp", "mouseEnter", "mouseLeave", "mouseDoubleClick", "mouseStillDown");
  const button: HexButtonPart = {
    id: "prt_btn", name: "Btn", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true, enabled: true, scriptSource: buttonScript, style: "rectangle", title: "", showName: true,
    autoHilite: true, hilite: false,
  };
  const field = (id: string, layer: "card" | "background", lockText: boolean, rect: HexFieldPart["rect"]): HexFieldPart => ({
    id, name: id, type: "field", layerScope: layer, rect, visible: true, enabled: true, scriptSource: logger("mouseDown", "mouseUp"),
    style: "rectangle", content: "", sharedText: false, lockText, dontWrap: false, showLines: false, textAlign: "left",
    textFont: "System", textSize: 12, textStyle: [],
  });
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{
      id: "bkg_1", name: "Main", bitmap: emptyBitmap, scriptSource: "", cantDelete: false,
      parts: [field("prt_bgf", "background", false, { x: 300, y: 10, width: 100, height: 40 })],
    }],
    cards: [
      {
        id: "crd_1", name: "First", backgroundId: "bkg_1", bitmap: emptyBitmap,
        parts: [button, field("prt_locked", "card", true, { x: 10, y: 100, width: 100, height: 40 }), field("prt_open", "card", false, { x: 10, y: 200, width: 100, height: 40 })],
        bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: logger("mouseDown", "mouseUp"),
      },
      {
        id: "crd_2", name: "Second", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [], bgFieldContents: {},
        marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
    ],
    customIcons: {}, scriptSource: "",
  };
}

/** Real store, VM host and bus; the Browse input posts to the bus. */
function setup() {
  const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
  for (const id of ["prt_btn", "prt_locked", "crd_1"]) expect(store.getCompiled(id).errors).toEqual([]);
  const modals = createModalManager();
  const globals = new Map<string, HexValue>();
  const errors: unknown[] = [];
  let bus: ReturnType<typeof createMessageBus> | undefined;
  const host = createVmHost({ store, bus: () => bus!, dialogs: modals });
  bus = createMessageBus({
    store, host, globals,
    isPageVisible: () => true, isModalOpen: () => false,
    scheduleInterval: () => () => undefined,
    onError: (error) => errors.push(error), warn: () => undefined,
  });
  const posted: HexMessage[] = [];
  const recordingBus = { post: (msg: HexMessage) => { posted.push(msg); bus!.post(msg); } };
  const browse = createBrowseInput({ store, bus: recordingBus });
  const idle = async (): Promise<void> => {
    do await new Promise((resolve) => setTimeout(resolve, 0));
    while (bus!.isRunning() || bus!.pendingCount() > 0);
  };
  const log = (): string => String(globals.get("log") ?? "");
  return { store, browse, posted, errors, idle, log };
}

describe("clientToCardPoint", () => {
  it("floors client positions to card pixels at any integer scale", () => {
    for (const k of [1, 2, 3]) {
      const rect = { left: 40, top: 30, width: 512 * k, height: 342 * k };
      expect(clientToCardPoint(40, 30, rect)).toEqual({ x: 0, y: 0 });
      expect(clientToCardPoint(40 + 10 * k + (k - 1), 30 + 5 * k, rect)).toEqual({ x: 10, y: 5 });
      expect(clientToCardPoint(40 + 512 * k - 1, 30 + 342 * k - 1, rect)).toEqual({ x: 511, y: 341 });
      expect(clientToCardPoint(39, 29, rect)).toEqual({ x: -1, y: -1 });
    }
  });
});

describe("createBrowseInput", () => {
  it("a click on a button sends mouseEnter, mouseDown and mouseUp to it, and draws it pressed meanwhile", async () => {
    const { browse, errors, idle, log } = setup();
    expect(browse.pointerDown(20, 15)).toEqual({ action: "send", targetId: "prt_btn" });
    expect(browse.pressedPartId()).toBe("prt_btn");
    browse.pointerUp(21, 16);
    expect(browse.pressedPartId()).toBeUndefined();
    await idle();
    expect(errors).toEqual([]);
    expect(log()).toBe("mouseEnter Btn,mouseDown Btn,mouseUp Btn,");
  });

  it("releasing outside the pressed button sends no mouseUp and unpresses it while outside", async () => {
    const { browse, idle, log } = setup();
    browse.pointerDown(20, 15);
    browse.pointerMove(200, 300);
    expect(browse.pressedPartId()).toBeUndefined();
    browse.pointerUp(200, 300);
    await idle();
    expect(log()).toBe("mouseEnter Btn,mouseDown Btn,mouseLeave Btn,");
  });

  it("a click on empty card space goes to the card", async () => {
    const { browse, idle, log } = setup();
    expect(browse.pointerDown(300, 300)).toEqual({ action: "send", targetId: "crd_1" });
    browse.pointerUp(400, 320);
    await idle();
    expect(log()).toBe("mouseDown First,mouseUp First,");
  });

  it("a click in an unlocked field opens it for editing and sends no mouse message; a locked field gets them", async () => {
    const { browse, posted, idle, log } = setup();
    expect(browse.pointerDown(20, 210)).toEqual({ action: "editField", partId: "prt_open", layer: "card" });
    browse.pointerUp(20, 210);
    expect(browse.pointerDown(320, 20)).toEqual({ action: "editField", partId: "prt_bgf", layer: "background" });
    browse.pointerUp(320, 20);
    expect(posted.filter((msg) => /^mouse(Down|Up)$/.test(msg.name))).toEqual([]);

    browse.pointerDown(20, 110);
    browse.pointerUp(20, 110);
    await idle();
    expect(log()).toBe("mouseDown prt_locked,mouseUp prt_locked,");
  });

  it("tick sends mouseStillDown while pressed and mouseWithin while hovering; double-click and keys are forwarded", () => {
    const { browse, posted } = setup();
    browse.pointerMove(20, 15);
    browse.tick();
    browse.pointerDown(20, 15);
    browse.tick();
    browse.pointerUp(20, 15);
    browse.doubleClick(20, 15);
    browse.keyDown("Shift");
    browse.keyDown("a");
    browse.pointerLeave();
    expect(posted.map((msg) => [msg.name, msg.targetId, ...msg.params])).toEqual([
      ["mouseEnter", "prt_btn"],
      ["mouseWithin", "prt_btn"],
      ["mouseDown", "prt_btn"],
      ["mouseStillDown", "prt_btn"],
      ["mouseWithin", "prt_btn"],
      ["mouseUp", "prt_btn"],
      ["mouseDoubleClick", "prt_btn"],
      ["keyDown", "crd_1", "a"],
      ["mouseLeave", "prt_btn"],
    ]);
  });

  it("keyDown ArrowRight reaches the built-in handler and goes to the next card", async () => {
    const { store, browse, idle } = setup();
    browse.keyDown("ArrowRight");
    await idle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
  });
});

describe("field editing rules", () => {
  it("only an enabled, visible, unlocked field of the current card can be edited, with the Browse tool", () => {
    const { store } = setup();
    const target = { cardId: "crd_1", layer: "card" as const, partId: "prt_open" };
    expect(editableField(store.getSnapshot(), target)?.id).toBe("prt_open");
    expect(editableField(store.getSnapshot(), { ...target, partId: "prt_locked" })).toBeNull();
    expect(editableField(store.getSnapshot(), { cardId: "crd_1", layer: "background", partId: "prt_bgf" })?.id).toBe("prt_bgf");
    store.applyRuntime({ type: "setPartProperty", partId: "prt_open", property: "enabled", value: false });
    expect(editableField(store.getSnapshot(), target)).toBeNull();
    store.applyRuntime({ type: "setPartProperty", partId: "prt_open", property: "enabled", value: true });
    store.setTool("pencil");
    expect(editableField(store.getSnapshot(), target)).toBeNull();
    store.setTool("browse");
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    expect(editableField(store.getSnapshot(), target)).toBeNull();
  });

  it("closing sends closeField after a change and exitField otherwise", () => {
    expect(fieldExitMessage("abc", "abcd")).toBe("closeField");
    expect(fieldExitMessage("abc", "abc")).toBe("exitField");
  });
});

describe("part selection, move and resize", () => {
  it("hit-tests only parts of the tool's type on the edit layer", () => {
    const { store } = setup();
    expect(hitTestLayerPart(store.getSnapshot(), "button", 20, 15)?.id).toBe("prt_btn");
    expect(hitTestLayerPart(store.getSnapshot(), "field", 20, 15)).toBeNull();
    expect(hitTestLayerPart(store.getSnapshot(), "field", 320, 20)).toBeNull(); // background field, card layer
    store.setEditLayer("background");
    expect(hitTestLayerPart(store.getSnapshot(), "field", 320, 20)?.id).toBe("prt_bgf");
    expect(hitTestLayerPart(store.getSnapshot(), "button", 20, 15)).toBeNull();
  });

  it("finds corner handles inside the rect", () => {
    const rect = { x: 10, y: 10, width: 80, height: 20 };
    expect(handleAt(rect, 10, 10)).toBe("nw");
    expect(handleAt(rect, 89, 10)).toBe("ne");
    expect(handleAt(rect, 10, 29)).toBe("sw");
    expect(handleAt(rect, 89, 29)).toBe("se");
    expect(handleAt(rect, 50, 20)).toBeNull();
    expect(handleAt(rect, 90, 30)).toBeNull();
  });

  it("moves keep the size; resizes move two edges and never go below the minimum size", () => {
    const start = { x: 10, y: 10, width: 80, height: 20 };
    expect(dragRect(start, "move", 5, -3)).toEqual({ x: 15, y: 7, width: 80, height: 20 });
    expect(dragRect(start, "se", 10, 5)).toEqual({ x: 10, y: 10, width: 90, height: 25 });
    expect(dragRect(start, "nw", 10, 5)).toEqual({ x: 20, y: 15, width: 70, height: 15 });
    expect(dragRect(start, "ne", -200, -200)).toEqual({ x: 10, y: -190, width: MIN_PART_SIZE, height: 220 });
    expect(dragRect(start, "sw", 200, -200)).toEqual({ x: 90 - MIN_PART_SIZE, y: 10, width: MIN_PART_SIZE, height: MIN_PART_SIZE });
  });

  it("one drag is one undoable command", () => {
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const history = createHistory(store);
    const before = { x: 10, y: 10, width: 80, height: 20 };
    const after = { x: 30, y: 40, width: 80, height: 20 };
    const command = createPartRectCommand("prt_btn", before, after);
    expect(command.label).toBe("Move");
    expect(createPartRectCommand("prt_btn", before, { ...after, width: 90 }).label).toBe("Resize");

    history.execute(command);
    const rectOf = (): unknown => store.getSnapshot().stack.cards[0].parts[0].rect;
    expect(rectOf()).toEqual(after);
    expect(history.undoLabel()).toBe("Move");
    history.undo();
    expect(rectOf()).toEqual(before);
    history.redo();
    expect(rectOf()).toEqual(after);

    const stack = store.getSnapshot().stack;
    expect(command.apply(stack)).toBe(stack); // already there: nothing to record
  });
});

describe("starter stack and UI store view", () => {
  it("the starter stack validates and its scripts compile without errors", () => {
    const result = validateStack(createStarterStack());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [card] = result.stack.cards;
    expect(result.stack.backgrounds).toHaveLength(1);
    expect(result.stack.cards).toHaveLength(1);
    expect(card.parts.map((part) => part.type)).toEqual(["field", "button"]);
    const field = card.parts[0];
    expect(field.type === "field" && field.content).toBe("Welcome to HexCard");
    const store = createHexStore({ stack: result.stack, compile: parseHexTalk });
    for (const part of card.parts) expect(store.getCompiled(part.id).errors).toEqual([]);
  });

  it("the Hello button plays a harpsichord phrase before the answer dialog", () => {
    const stack = createStarterStack();
    const store = createHexStore({ stack, compile: parseHexTalk });
    const compiled = store.getCompiled("prt_hello");
    expect(compiled.errors).toEqual([]);
    expect(compiled.ast.handlers.mouseup.body.map((statement) => statement.kind)).toEqual(["PlaySound", "ShowAnswerDialog"]);
    expect(compiled.ast.handlers.mouseup.body[0]).toMatchObject({
      kind: "PlaySound",
      voice: "harpsichord",
      tempo: 140,
      notes: "c4e e4e g4e c5q",
    });
  });

  it("the UI store view has no applyAuthoring or replaceStack at run time", () => {
    const store: HexStore = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const view = createUiStoreView(store);
    expect("applyAuthoring" in view).toBe(false);
    expect("replaceStack" in view).toBe(false);
    view.setTool("pencil");
    expect(view.getSnapshot()).toBe(store.getSnapshot());
    expect(store.getSnapshot().tool).toBe("pencil");
  });
});

function viewportElement(store: HexStore) {
  const history = createHistory(store);
  return createElement(CardViewport, {
    store: createUiStoreView(store),
    history,
    bus: { post: () => undefined, abort: () => undefined },
    painter: createPaintController({ store, history, getSettings: () => DEFAULT_PAINT_SETTINGS }),
    effects: createEffectStage(),
    mouse: createMouseTracker(),
    isModalOpen: () => false,
  });
}

/** Content size and frame (border) width of the rendered `.hc-viewport`, in CSS px. */
function viewportBox(html: string): { width: number; height: number; frame: number } {
  const match = html.match(/<div class="hc-viewport" style="width:(\d+)px;height:(\d+)px;border-width:(\d+)px"/);
  expect(match).not.toBeNull();
  const [, width, height, frame] = match!.map(Number);
  return { width, height, frame };
}

/** Renders `child` inside a System7Shell with a fixed UI scale k. */
function renderInShell(store: HexStore, k: number, child: ReactNode): string {
  return renderToStaticMarkup(createElement(System7Shell, {
    store: createUiStoreView(store),
    history: createHistory(store),
    modals: createModalManager(),
    patternIndex: 1,
    onPatternChange: () => undefined,
    handlers: noMenuHandlers(),
    backHistory: () => [],
    platform: "other",
    scale: k,
  }, child));
}

/** A handler for every non-reserved menu command except the shell-owned palette toggle; none is run here. */
function noMenuHandlers(): ShellMenuHandlers {
  const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
  const context: MenuContext = { state: store.getSnapshot(), history: createHistory(store), backHistory: [], paletteVisible: false };
  const commands = buildMenus(context, "other")
    .flatMap((menu) => menu.entries.flatMap((entry) => (entry.kind === "item" ? [entry.command] : [])))
    .filter((command) => !isReservedCommand(command) && command !== "paint.togglePalette");
  return Object.fromEntries(commands.map((command) => [command, () => undefined])) as ShellMenuHandlers;
}

describe("part selection through the store (spec 05 Requirements 10.1, 10.2, 14.1)", () => {
  const VIEWPORT_SOURCE = readFileSync(new URL("../CardViewport.tsx", import.meta.url), "utf8");

  it("draws the handles of the store's selected part and follows the store", () => {
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    store.setTool("button");
    expect(renderToStaticMarkup(viewportElement(store))).not.toContain("hc-handle");
    store.setSelectedPart("prt_btn");
    const html = renderToStaticMarkup(viewportElement(store));
    // prt_btn's rect is 10,10 80x20 at k = 1.
    expect(html).toContain('style="left:10px;top:10px;width:80px;height:20px"');
    expect(html.match(/class="hc-handle hc-handle-(nw|ne|sw|se)"/g)).toHaveLength(4);
    store.setTool("field"); // the store clears the selection
    expect(store.getSnapshot().selectedPartId).toBeNull();
    expect(renderToStaticMarkup(viewportElement(store))).not.toContain("hc-handle");
  });

  it("keeps no selection state of its own: presses select through store.setSelectedPart", () => {
    expect(VIEWPORT_SOURCE).toContain("store.setSelectedPart(hit?.id ?? null)");
    expect(VIEWPORT_SOURCE).not.toMatch(/useState<HexID \| null>/);
    expect(VIEWPORT_SOURCE).not.toMatch(/setSelectedPartId/);
  });
});

describe("image drops (spec 06 Requirements 6.2, 6.3)", () => {
  interface Drag {
    defaultPrevented: boolean;
    dataTransfer: { types: string[]; dropEffect: string; files: unknown[] } | null;
    preventDefault(): void;
  }
  const png = { type: "image/png", size: 4, arrayBuffer: async () => new ArrayBuffer(4) };
  const drag = (types: string[], files: unknown[] = []): Drag => {
    const event: Drag = {
      defaultPrevented: false,
      dataTransfer: { types, dropEffect: "none", files },
      preventDefault() {
        event.defaultPrevented = true;
      },
    };
    return event;
  };

  it("accepts a file drag over the card as a copy and leaves other drags alone", () => {
    const files = drag(["Files"]);
    cardDragOver(files);
    expect(files.defaultPrevented).toBe(true);
    expect(files.dataTransfer?.dropEffect).toBe("copy");
    const text = drag(["text/plain"]);
    cardDragOver(text);
    expect(text.defaultPrevented).toBe(false);
  });

  it("hands the first dropped file on, and prevents the drop even while a window is open", () => {
    const dropped: unknown[] = [];
    const onDropImage = (file: unknown) => void dropped.push(file);
    const event = drag(["Files"], [png, { type: "image/gif" }]);
    expect(cardDrop(event, { isModalOpen: () => false, onDropImage })).toBe(true);
    expect(dropped).toEqual([png]);
    expect(event.defaultPrevented).toBe(true);

    const blocked = drag(["Files"], [png]);
    expect(cardDrop(blocked, { isModalOpen: () => true, onDropImage })).toBe(false);
    expect(blocked.defaultPrevented).toBe(true);
    expect(dropped).toHaveLength(1);
    expect(cardDrop(drag(["text/plain"]), { isModalOpen: () => false, onDropImage })).toBe(false);
  });

  it("the shell guard refuses file drags elsewhere and leaves drags the card already took", () => {
    const elsewhere = drag(["Files"]);
    expect(guardFileDrag(elsewhere)).toBe(true);
    expect(elsewhere.defaultPrevented).toBe(true);
    expect(elsewhere.dataTransfer?.dropEffect).toBe("none");

    const onCard = drag(["Files"]);
    cardDragOver(onCard);
    expect(guardFileDrag(onCard)).toBe(false);
    expect(onCard.dataTransfer?.dropEffect).toBe("copy");
    expect(guardFileDrag(drag(["text/plain"]))).toBe(false);
    expect(guardFileDrag({ defaultPrevented: false, dataTransfer: null, preventDefault: () => {} })).toBe(false);
  });

  it("a drop with the Browse tool alerts and changes nothing (end to end with importDroppedImage)", async () => {
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const history = createHistory(store);
    const alerts: string[] = [];
    const before = store.getSnapshot();
    const results: Promise<boolean>[] = [];
    cardDrop(drag(["Files"], [png]), {
      isModalOpen: () => false,
      onDropImage: (file) => void results.push(importDroppedImage(file, { store, history, alert: (m) => void alerts.push(m) })),
    });
    expect(await Promise.all(results)).toEqual([false]);
    expect(alerts).toEqual(["Choose a paint tool to import an image."]);
    expect(store.getSnapshot()).toBe(before);
    expect(history.canUndo()).toBe(false);
  });

  it("puts the drop handlers on the viewport wrapper and the guard on window dragover and drop", () => {
    const viewport = readFileSync(new URL("../CardViewport.tsx", import.meta.url), "utf8");
    expect(viewport).toContain("onDragOver={(event) => cardDragOver(event)}");
    expect(viewport).toContain("onDrop={(event) => void cardDrop(event, { isModalOpen, onDropImage })}");
    const shell = readFileSync(new URL("../System7Shell.tsx", import.meta.url), "utf8");
    expect(shell).toContain('window.addEventListener("dragover", guard)');
    expect(shell).toContain('window.addEventListener("drop", guard)');
  });
});

describe("CardViewport markup", () => {
  it("renders one 512x342 canvas and the hidden, labelled textarea", () => {
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const html = renderToStaticMarkup(viewportElement(store));
    expect(html.match(/<canvas/g)).toHaveLength(1);
    expect(html).toContain('width="512"');
    expect(html).toContain('height="342"');
    expect(html).toContain('class="hc-hidden-input"');
    expect(html).toContain('aria-label="Card field"');
    expect(html).not.toContain("part-selection");
  });
});

describe("UI scale k (Requirement 2.10)", () => {
  it("shows the canvas at 512k x 342k CSS pixels inside a CARD_FRAME_WIDTH * k frame; the backing store stays 512x342", () => {
    for (const k of [1, 3]) {
      const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
      const html = renderInShell(store, k, viewportElement(store));
      const size = `width:${512 * k}px;height:${342 * k}px`;
      expect(html).toMatch(new RegExp(`<canvas class="hc-card-canvas" width="512" height="342" style="${size}"`));
      const box = viewportBox(html);
      expect(box).toEqual({ width: 512 * k, height: 342 * k, frame: CARD_FRAME_WIDTH * k });
      // Content-box sizing (asserted on the CSS below): the border adds to the canvas size.
      expect(box.width + 2 * box.frame).toBe((512 + 4) * k);
      expect(box.height + 2 * box.frame).toBe((342 + 4) * k);
    }
  });

  it("the framed card plus the 20k menu bar exactly fills the exact-fit window of computeUiScale", () => {
    const [windowWidth, windowHeight] = [1548, 1098];
    const k = computeUiScale(windowWidth, windowHeight);
    expect(k).toBe(3);
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const box = viewportBox(renderInShell(store, k, viewportElement(store)));
    expect(box.width + 2 * box.frame).toBe(windowWidth);
    expect(box.height + 2 * box.frame + menuBarHeight(k)).toBe(windowHeight);
  });

  it("draws the selection marquee as k-scaled crisp SVG pixel art at the selection rect", () => {
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const rect = { x: 10, y: 20, width: 80, height: 30 };
    for (const k of [1, 3]) {
      const html = renderInShell(store, k, createElement(SelectionMarquee, { rect }));
      expect(html).toContain(`class="hc-marquee" style="left:${10 * k}px;top:${20 * k}px;width:${80 * k}px;height:${30 * k}px"`);
      expect(html).toContain(`<svg class="hc-marquee-art" width="${80 * k}" height="${30 * k}" shape-rendering="crispEdges"`);
      expect(html).toMatch(new RegExp(`<pattern [^>]*width="2" height="2" patternUnits="userSpaceOnUse" patternTransform="scale\\(${k}\\)"`));
      expect(html).toContain('fill="var(--light-bit)"');
      expect(html).toContain('fill="var(--dark-bit)"');
      // Four 1x-wide edges: top, bottom, left, right.
      expect(html).toContain(`<rect x="0" y="${29 * k}" width="${80 * k}" height="${k}"`);
      expect(html).toContain(`<rect x="${79 * k}" y="0" width="${k}" height="${30 * k}"`);
      expect(html.match(/fill="url\(#/g)).toHaveLength(4);
      expect(html).not.toMatch(/dashed|dotted/);
    }
  });

  it("sizes the selection frame and handles with k", () => {
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const rect = { x: 10, y: 20, width: 80, height: 30 };
    for (const k of [1, 3]) {
      const html = renderInShell(store, k, createElement(PartSelection, { rect }));
      expect(html).toContain(`style="left:${10 * k}px;top:${20 * k}px;width:${80 * k}px;height:${30 * k}px"`);
      const handle = `width:${HANDLE_SIZE * k}px;height:${HANDLE_SIZE * k}px`;
      expect(html.match(new RegExp(`class="hc-handle hc-handle-(nw|ne|sw|se)" style="${handle}"`, "g"))).toHaveLength(4);
    }
  });

  it("places the editing textarea over the field's k-scaled rect", () => {
    const rect = { x: 10, y: 200, width: 100, height: 40 };
    expect(cardRectStyle(rect, 1)).toEqual({ left: 10, top: 200, width: 100, height: 40 });
    expect(cardRectStyle(rect, 3)).toEqual({ left: 30, top: 600, width: 300, height: 120 });
  });

  it("maps pointer positions on a 512k x 342k canvas back to card pixels", () => {
    const rect = { left: 0, top: 60, width: 512 * 3, height: 342 * 3 };
    expect(clientToCardPoint(3 * 10 + 2, 60 + 3 * 200 + 2, rect)).toEqual({ x: 10, y: 200 });
  });

  it("keeps the .hc-* rules 1-bit: solid lines only, no blur, gradient, filter or partial opacity, lengths in var(--px)", () => {
    const viewportRules = SHELL_CSS.slice(SHELL_CSS.indexOf("/* Card viewport")).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(viewportRules).toMatch(/\.hc-viewport \{[^}]*box-sizing: content-box;[^}]*border: 0 solid var\(--dark-bit\);/);
    expect(viewportRules).not.toMatch(/\boutline\b/);
    expect(viewportRules).toMatch(/\.hc-card-canvas \{[^}]*image-rendering: pixelated;/);
    expect(viewportRules).toMatch(/\.hc-handle \{[^}]*border: calc\(1 \* var\(--px\)\) solid/);
    expect(viewportRules).toMatch(/\.hc-marquee-art \{[^}]*shape-rendering: crispEdges;/);
    expect(viewportRules).not.toMatch(/dashed|dotted|border-radius|gradient|blur|filter|transform/);
    for (const [, value] of viewportRules.matchAll(/opacity:\s*([\d.]+)/g)) expect(["0", "1"]).toContain(value);
    const bare = viewportRules.match(/\b\d+(\.\d+)?px\b/g) ?? [];
    expect(bare.filter((value) => value !== "0px")).toEqual([]);
  });
});

describe("found text in the viewport (spec 06 Requirements 4.8, 4.10)", () => {
  /** Fixed 6-px advance, no ink: enough for line layout in Node. */
  const stubText = { measureText: (text: string) => [...text].length * 6, drawText: (_t: string, _c: string, _x: number, _b: number, w: number, h: number) => new Uint8Array(w * h) };
  function scrollingStack(style: HexFieldPart["style"]): HexStack {
    const stack = makeStack();
    const notes: HexFieldPart = {
      id: "prt_notes", name: "Notes", type: "field", layerScope: "card", rect: { x: 10, y: 100, width: 200, height: 40 },
      visible: true, enabled: true, scriptSource: "", style, content: "one\ntwo\nthree\nfour\nfive lamp", sharedText: false,
      lockText: true, dontWrap: false, showLines: false, textAlign: "left", textFont: "System", textSize: 12, textStyle: [],
    };
    return { ...stack, cards: stack.cards.map((card, i) => (i === 0 ? { ...card, parts: [...card.parts, notes] } : card)) };
  }

  it("passes the found range to composeFrame only on its card", () => {
    const store = createHexStore({ stack: scrollingStack("rectangle"), compile: parseHexTalk });
    expect(foundOptions(store.getSnapshot())).toBeUndefined();
    const text = "one\ntwo\nthree\nfour\nfive lamp";
    store.setFound({ cardId: store.getSnapshot().currentCardId, layer: "card", partId: "prt_notes", start: 24, end: 28, text });
    expect(foundOptions(store.getSnapshot())).toEqual({ partId: "prt_notes", start: 24, end: 28 });
    expect(foundOptions({ ...store.getSnapshot(), currentCardId: "elsewhere" })).toBeUndefined();
  });

  it("scrolls a scrolling field so the match's line is visible, and leaves other fields alone", () => {
    const text = "one\ntwo\nthree\nfour\nfive lamp";
    for (const style of ["scrolling", "rectangle"] as const) {
      const store = createHexStore({ stack: scrollingStack(style), compile: parseHexTalk });
      store.setFound({ cardId: store.getSnapshot().currentCardId, layer: "card", partId: "prt_notes", start: 24, end: 28, text });
      const target = scrollTargetForFound(store.getSnapshot(), 0, stubText);
      if (style === "rectangle") {
        expect(target).toBeUndefined();
        continue;
      }
      // Text rect height 36 shows two 16-px lines; "five lamp" is line 4 (top 64), maxScroll 80 - 36 = 44.
      expect(target).toEqual({ partId: "prt_notes", scroll: 44 });
      expect(scrollTargetForFound(store.getSnapshot(), 44, stubText)).toBeUndefined(); // already visible
    }
  });
});

describe("FatBits in the viewport (spec 06 Requirements 7.5-7.9)", () => {
  const VIEWPORT_SOURCE = readFileSync(new URL("../CardViewport.tsx", import.meta.url), "utf8");
  const view = { x: 224, y: 149 };
  const press = (key: string, extra: Partial<Parameters<typeof fatBitsKeyAction>[1]> = {}, blocked = false, fatBits: typeof view | null = view) =>
    fatBitsKeyAction(fatBits, { key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: null, ...extra }, blocked);
  const textInput = { closest: (selector: string) => (selector.includes("input") ? {} : null) } as unknown as EventTarget;

  it("maps a press, move or release to the card pixel of the cell under it, and leaves points alone when FatBits is off", () => {
    expect(fatBitsPaintPoint({ fatBits: null }, { x: 300, y: 200 }, true)).toEqual({ x: 300, y: 200 });
    expect(fatBitsPaintPoint({ fatBits: view }, { x: 200, y: 100 }, true)).toEqual({ x: 224 + 25, y: 149 + 12 });
    expect(fatBitsPaintPoint({ fatBits: view }, { x: 511, y: 341 }, true)).toEqual({ x: 224 + 63, y: 149 + 42 });
    expect(fatBitsPaintPoint({ fatBits: view }, { x: 200, y: 100 }, false)).toEqual({ x: 249, y: 161 });
  });
  it("starts no stroke from a press inside the inset, at either corner, but maps a later move over it", () => {
    expect(fatBitsPaintPoint({ fatBits: view }, { x: 0, y: 0 }, true)).toBeNull();
    expect(fatBitsPaintPoint({ fatBits: view }, { x: 67, y: 46 }, true)).toBeNull();
    expect(fatBitsPaintPoint({ fatBits: view }, { x: 68, y: 46 }, true)).not.toBeNull();
    expect(fatBitsPaintPoint({ fatBits: view }, { x: 10, y: 10 }, false)).toEqual({ x: 225, y: 150 });
    const corner = { x: 0, y: 0 };
    expect(insetRect(corner).x).toBe(444);
    expect(fatBitsPaintPoint({ fatBits: corner }, { x: 450, y: 10 }, true)).toBeNull();
    expect(fatBitsPaintPoint({ fatBits: corner }, { x: 10, y: 10 }, true)).toEqual({ x: 1, y: 1 });
  });
  it("pans by 8 card pixels with the arrow keys, clamped to x 0..448 and y 0..299", () => {
    expect(press("ArrowRight")).toEqual({ view: { x: 232, y: 149 } });
    expect(press("ArrowLeft")).toEqual({ view: { x: 216, y: 149 } });
    expect(press("ArrowDown")).toEqual({ view: { x: 224, y: 157 } });
    expect(press("ArrowUp")).toEqual({ view: { x: 224, y: 141 } });
    expect(press("ArrowLeft", {}, false, { x: 3, y: 0 })).toEqual({ view: { x: 0, y: 0 } });
    expect(press("ArrowUp", {}, false, { x: 3, y: 5 })).toEqual({ view: { x: 3, y: 0 } });
    expect(press("ArrowRight", {}, false, { x: 445, y: 0 })).toEqual({ view: { x: 448, y: 0 } });
    expect(press("ArrowDown", {}, false, { x: 0, y: 296 })).toEqual({ view: { x: 0, y: 299 } });
    expect(press("ArrowRight", {}, false, { x: 448, y: 299 })).toEqual({ view: { x: 448, y: 299 } });
  });
  it("turns FatBits off with Escape", () => {
    expect(press("Escape")).toEqual({ view: null });
  });
  it("ignores keys while FatBits is off, with a modifier, in a dialog or studio window, or in a text input", () => {
    expect(press("ArrowRight", {}, false, null)).toBeUndefined();
    expect(press("Escape", {}, false, null)).toBeUndefined();
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey"] as const) {
      expect(press("ArrowRight", { [modifier]: true }), modifier).toBeUndefined();
      expect(press("Escape", { [modifier]: true }), modifier).toBeUndefined();
    }
    expect(press("ArrowRight", {}, true)).toBeUndefined();
    expect(press("Escape", {}, true)).toBeUndefined();
    expect(press("ArrowRight", { target: textInput })).toBeUndefined();
    expect(press("Escape", { target: textInput })).toBeUndefined();
    expect(press("a")).toBeUndefined();
    expect(press("Enter")).toBeUndefined();
  });
  it("handles the keys in the window listener before the Browse-only checks and draws renderFatBits after composing", () => {
    expect(VIEWPORT_SOURCE).toMatch(/fatBitsKeyAction\(store\.getSnapshot\(\)\.fatBits, event, isModalOpen\(\)\)/);
    expect(VIEWPORT_SOURCE.indexOf("fatBitsKeyAction(store.getSnapshot()")).toBeLessThan(VIEWPORT_SOURCE.indexOf('store.getSnapshot().tool !== "browse" || isModalOpen()'));
    expect(VIEWPORT_SOURCE).toContain("store.setFatBits(fat.view)");
    expect(VIEWPORT_SOURCE.indexOf("composeFrame(")).toBeLessThan(VIEWPORT_SOURCE.indexOf("renderFatBits(frame, snapshot.fatBits)"));
    expect(VIEWPORT_SOURCE.indexOf("renderFatBits(frame, snapshot.fatBits)")).toBeLessThan(VIEWPORT_SOURCE.indexOf("frameToImageData(shown"));
  });

  function paintSetup(tool: "pencil" | "eraser", cardRle = "") {
    const stack = makeStack();
    const store = createHexStore({
      stack: { ...stack, cards: stack.cards.map((card, i) => (i === 0 ? { ...card, bitmap: { ...card.bitmap, rleData: cardRle } } : card)) },
      compile: parseHexTalk,
    });
    const history = createHistory(store);
    const painter = createPaintController({
      store,
      history,
      getSettings: () => ({ ...DEFAULT_PAINT_SETTINGS, ...(store.getSnapshot().fatBits ? { eraserSize: 1 } : {}) }),
    });
    store.setTool(tool);
    store.setFatBits({ ...FATBITS_START });
    const cardPixels = () => decodeBitmapRLE(store.getSnapshot().stack.cards[0].bitmap.rleData, 0);
    /** One stroke through the same mapping the pointer handlers use. */
    const stroke = (points: Array<[number, number]>) => {
      const snapshot = store.getSnapshot();
      const [first, ...rest] = points;
      const start = fatBitsPaintPoint(snapshot, { x: first[0], y: first[1] }, true)!;
      expect(painter.begin(start.x, start.y)).toBe(true);
      for (const [x, y] of rest) {
        const target = fatBitsPaintPoint(snapshot, { x, y }, false)!;
        painter.move(target.x, target.y);
      }
      const last = rest.at(-1) ?? first;
      const end = fatBitsPaintPoint(snapshot, { x: last[0], y: last[1] }, false)!;
      painter.end(end.x, end.y);
    };
    return { store, history, stroke, cardPixels };
  }
  const idx = (x: number, y: number): number => y * 512 + x;

  it("draws one card pixel per Pencil press, each press one Undo step (Requirement 7.6)", () => {
    const t = paintSetup("pencil");
    t.stroke([[100, 100]]); // cell (12, 12) -> card pixel (236, 161)
    t.stroke([[200, 100]]); // cell (25, 12) -> (249, 161)
    t.stroke([[100, 200]]); // cell (12, 25) -> (236, 174)
    const pixels = t.cardPixels();
    for (const [x, y] of [[236, 161], [249, 161], [236, 174]]) expect(pixels[idx(x, y)], `${x},${y}`).toBe(2);
    expect(pixels.filter((value) => value === 2)).toHaveLength(3);
    void t.history.undo();
    expect(t.cardPixels().filter((value) => value === 2)).toHaveLength(2);
    void t.history.undo();
    void t.history.undo();
    expect(t.cardPixels().filter((value) => value === 2)).toHaveLength(0);
  });
  it("erases exactly one card pixel per pointer position with the Eraser (Requirement 7.6)", () => {
    const seed = paintSetup("pencil");
    for (const [x, y] of [[100, 100], [108, 100], [116, 100], [100, 108]]) seed.stroke([[x, y]]);
    const rle = seed.store.getSnapshot().stack.cards[0].bitmap.rleData;
    expect(seed.cardPixels().filter((value) => value === 2)).toHaveLength(4);
    const t = paintSetup("eraser", rle);
    t.stroke([[108, 100]]); // the cell of card pixel (237, 161)
    const pixels = t.cardPixels();
    expect(pixels[idx(237, 161)]).toBe(0);
    expect(pixels.filter((value) => value === 2)).toHaveLength(3);
    expect(pixels[idx(236, 161)]).toBe(2);
    expect(pixels[idx(238, 161)]).toBe(2);
  });
  it("keeps a drag as one stroke whose points follow the cells", () => {
    const t = paintSetup("pencil");
    t.stroke([[100, 100], [108, 100], [116, 100]]); // three adjacent cells
    expect(t.cardPixels().filter((value) => value === 2)).toHaveLength(3);
    void t.history.undo();
    expect(t.cardPixels().filter((value) => value === 2)).toHaveLength(0);
  });
});
