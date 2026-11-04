/**
 * Spec 04 Requirement 2.9: checkBox / radioButton auto-hilite on a Browse-tool click, applied
 * with store.applyRuntime before mouseUp is delivered.
 */
import { describe, expect, it } from "vitest";
import { createMessageBus } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import type { ButtonStyle, HexButtonPart, HexStack } from "../../core/schema.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { createHexStore } from "../../core/store.ts";
import type { HexValue } from "../../core/vm.ts";
import { autoHiliteMutations, createBrowseInput } from "../CardViewport.tsx";
import { createModalManager } from "../System7Shell.tsx";
import { createVmHost } from "../vmHost.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

/** mouseUp logs "<name>=<hilite>," so the test sees the hilite the handler reads. */
const MOUSE_UP_SCRIPT = [
  "on mouseUp",
  "  global log",
  '  put the name of me & "=" & the hilite of me & "," after log',
  "end mouseUp",
].join("\n");

let nextY = 0;
function button(id: string, style: ButtonStyle, extra: Partial<HexButtonPart> = {}, layer: "card" | "background" = "card"): HexButtonPart {
  const y = nextY;
  nextY += 20;
  return {
    id, name: id, type: "button", layerScope: layer, rect: { x: 10, y, width: 100, height: 16 },
    visible: true, enabled: true, scriptSource: MOUSE_UP_SCRIPT, style, title: "", showName: true,
    autoHilite: true, hilite: false, ...extra,
  };
}

function makeStack(): HexStack {
  nextY = 0;
  const cardParts = [
    button("chk", "checkBox"),
    button("chk_manual", "checkBox", { autoHilite: false }),
    button("chk_disabled", "checkBox", { enabled: false }),
    button("r1a", "radioButton", { family: 1 }),
    button("r1b", "radioButton", { family: 1, hilite: true }),
    button("r1c", "radioButton", { family: 1, hilite: true, autoHilite: false, enabled: false }),
    button("r2", "radioButton", { family: 2, hilite: true }),
    button("rnone", "radioButton"),
    button("rnone2", "radioButton", { hilite: true }),
    button("plain", "roundRect"),
  ];
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{
      id: "bkg_1", name: "Main", bitmap: emptyBitmap, scriptSource: "", cantDelete: false,
      parts: [
        { ...button("bg1a", "radioButton", { family: 1 }, "background"), rect: { x: 300, y: 0, width: 100, height: 16 } },
        { ...button("bg1b", "radioButton", { family: 1, hilite: true }, "background"), rect: { x: 300, y: 20, width: 100, height: 16 } },
      ],
    }],
    cards: [
      {
        id: "crd_1", name: "First", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: cardParts,
        bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
      {
        id: "crd_2", name: "Second", backgroundId: "bkg_1", bitmap: emptyBitmap,
        parts: [{ ...button("c2r", "radioButton", { family: 1, hilite: true }), rect: { x: 10, y: 300, width: 100, height: 16 } }],
        bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
    ],
    customIcons: {}, scriptSource: "",
  };
}

function setup() {
  const validated = validateStack(makeStack());
  if (!validated.ok) throw new Error(validated.error);
  const store = createHexStore({ stack: validated.stack, compile: parseHexTalk });
  expect(store.getCompiled("chk").errors).toEqual([]);
  const globals = new Map<string, HexValue>();
  const errors: unknown[] = [];
  let bus: ReturnType<typeof createMessageBus> | undefined;
  const host = createVmHost({ store, bus: () => bus!, dialogs: createModalManager() });
  bus = createMessageBus({
    store, host, globals,
    isPageVisible: () => true, isModalOpen: () => false,
    scheduleInterval: () => () => undefined,
    onError: (error) => errors.push(error), warn: () => undefined,
  });
  const browse = createBrowseInput({ store, bus: bus });
  const idle = async (): Promise<void> => {
    do await new Promise((resolve) => setTimeout(resolve, 0));
    while (bus!.isRunning() || bus!.pendingCount() > 0);
  };

  const find = (id: string): HexButtonPart => {
    const { stack } = store.getSnapshot();
    const part = [...stack.backgrounds.flatMap((b) => b.parts), ...stack.cards.flatMap((c) => c.parts)].find((p) => p.id === id);
    if (!part || part.type !== "button") throw new Error(`no button ${id}`);
    return part;
  };
  const hilite = (id: string): boolean => find(id).hilite;
  /** Press and release in the middle of the button. */
  const click = async (id: string): Promise<void> => {
    const { x, y, width, height } = find(id).rect;
    browse.pointerDown(x + width / 2, y + height / 2);
    browse.pointerUp(x + width / 2, y + height / 2);
    await idle();
  };
  const log = (): string => String(globals.get("log") ?? "");
  return { store, browse, errors, idle, hilite, click, find, log };
}

describe("checkBox auto-hilite", () => {
  it("toggles hilite on and off, and mouseUp already reads the new value", async () => {
    const { hilite, click, log, errors } = setup();
    await click("chk");
    expect(hilite("chk")).toBe(true);
    await click("chk");
    expect(hilite("chk")).toBe(false);
    expect(errors).toEqual([]);
    expect(log()).toBe("chk=true,chk=false,");
  });

  it("the hilite is already in the store when mouseUp is posted", () => {
    const { store, find } = setup();
    const seen: string[] = [];
    const browse = createBrowseInput({
      store,
      bus: {
        post: (msg) => {
          if (msg.name === "mouseUp") seen.push(`${msg.targetId}=${String(find(msg.targetId).hilite)}`);
        },
      },
    });
    const { x, y } = find("chk").rect;
    browse.pointerDown(x + 1, y + 1);
    expect(find("chk").hilite).toBe(false); // nothing changes on press
    browse.pointerUp(x + 1, y + 1);
    expect(seen).toEqual(["chk=true"]);
  });

  it("leaves a checkBox without autoHilite, a disabled one and a plain button unchanged", async () => {
    const { hilite, click, log } = setup();
    await click("chk_manual");
    await click("chk_disabled");
    await click("plain");
    expect(hilite("chk_manual")).toBe(false);
    expect(hilite("chk_disabled")).toBe(false);
    expect(hilite("plain")).toBe(false);
    expect(log()).toBe("chk_manual=false,plain=false,"); // the disabled button gets no mouseUp
  });

  it("releasing outside the button changes nothing", async () => {
    const { browse, find, hilite, idle, log } = setup();
    const { x, y } = find("chk").rect;
    browse.pointerDown(x + 1, y + 1);
    browse.pointerUp(500, 340);
    await idle();
    expect(hilite("chk")).toBe(false);
    expect(log()).toBe("");
  });
});

describe("radioButton auto-hilite", () => {
  it("hilites the clicked radio and clears only its family on the same layer of the current card", async () => {
    const { hilite, click, log } = setup();
    await click("r1a");
    expect(hilite("r1a")).toBe(true);
    expect(hilite("r1b")).toBe(false);
    expect(hilite("r1c")).toBe(false); // same family: cleared even though disabled and not autoHilite
    expect(hilite("r2")).toBe(true); // other family
    expect(hilite("bg1b")).toBe(true); // same family number, background layer
    expect(hilite("c2r")).toBe(true); // same family, other card
    expect(log()).toBe("r1a=true,");
  });

  it("a background radio clears its family among the background's parts only", async () => {
    const { hilite, click } = setup();
    await click("bg1a");
    expect(hilite("bg1a")).toBe(true);
    expect(hilite("bg1b")).toBe(false);
    expect(hilite("r1b")).toBe(true);
    expect(hilite("c2r")).toBe(true);
  });

  it("clicking a hilited radio keeps it hilited", async () => {
    const { hilite, click } = setup();
    await click("r1b");
    await click("r1b");
    expect(hilite("r1b")).toBe(true);
  });

  it("a radio without a family is in no group", async () => {
    const { hilite, click } = setup();
    await click("rnone");
    expect(hilite("rnone")).toBe(true);
    expect(hilite("rnone2")).toBe(true);
  });
});

describe("autoHiliteMutations", () => {
  it("returns no mutation for an unknown, disabled, invisible or non-auto-hilite part", () => {
    const { store } = setup();
    const state = store.getSnapshot();
    expect(autoHiliteMutations(state, "missing")).toEqual([]);
    expect(autoHiliteMutations(state, "chk_disabled")).toEqual([]);
    expect(autoHiliteMutations(state, "chk_manual")).toEqual([]);
    expect(autoHiliteMutations(state, "c2r")).toEqual([]); // not on the current card
    store.applyRuntime({ type: "setPartProperty", partId: "chk", property: "visible", value: false });
    expect(autoHiliteMutations(store.getSnapshot(), "chk")).toEqual([]);
  });

  it("describes a radio click as setPartProperty hilite writes", () => {
    const { store } = setup();
    expect(autoHiliteMutations(store.getSnapshot(), "r1a")).toEqual([
      { type: "setPartProperty", partId: "r1a", property: "hilite", value: true },
      { type: "setPartProperty", partId: "r1b", property: "hilite", value: false },
      { type: "setPartProperty", partId: "r1c", property: "hilite", value: false },
    ]);
  });
});
