/**
 * Spec 04 task 3: card viewport logic (pointer mapping, Browse forwarding, field editing rules,
 * part move/resize), the starter stack, the UI store view and server rendering of the viewport.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createHistory } from "../../core/history.ts";
import { createMessageBus, type HexMessage } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import type { HexButtonPart, HexFieldPart, HexStack } from "../../core/schema.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { createHexStore, type HexStore } from "../../core/store.ts";
import type { HexValue } from "../../core/vm.ts";
import { createPaintController, DEFAULT_PAINT_SETTINGS } from "../../engine/graphics/paintTools.ts";
import { createUiStoreView } from "../App.tsx";
import {
  CardViewport,
  clientToCardPoint,
  createBrowseInput,
  createPartRectCommand,
  dragRect,
  editableField,
  fieldExitMessage,
  handleAt,
  hitTestLayerPart,
  MIN_PART_SIZE,
} from "../CardViewport.tsx";
import { createStarterStack } from "../starterStack.ts";
import { createModalManager } from "../System7Shell.tsx";
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

describe("CardViewport markup", () => {
  it("renders one 512x342 canvas and the hidden, labelled textarea", () => {
    const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
    const history = createHistory(store);
    const html = renderToStaticMarkup(createElement(CardViewport, {
      store: createUiStoreView(store),
      history,
      bus: { post: () => undefined, abort: () => undefined },
      painter: createPaintController({ store, history, getSettings: () => DEFAULT_PAINT_SETTINGS }),
      effects: createEffectStage(),
      mouse: createMouseTracker(),
      isModalOpen: () => false,
    }));
    expect(html.match(/<canvas/g)).toHaveLength(1);
    expect(html).toContain('width="512"');
    expect(html).toContain('height="342"');
    expect(html).toContain('class="hc-hidden-input"');
    expect(html).toContain('aria-label="Card field"');
    expect(html).not.toContain("part-selection");
  });
});
