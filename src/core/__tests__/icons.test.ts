import { describe, expect, it } from "vitest";
import {
  BLANK_ICON,
  ICON_DATA_LENGTH,
  ICON_NAME_INVALID,
  ICON_PIXELS,
  createButtonIconCommand,
  createCopyIconCommand,
  createDeleteIconCommand,
  createEditIconCommand,
  createNewIconCommand,
  createRenameIconCommand,
  decodeIcon,
  encodeIcon,
  freeIconName,
  iconFromRows,
  iconNameError,
  isIconData,
  isIconName,
  type IconCommand,
} from "../icons.ts";
import { createHistory } from "../history.ts";
import type { HexButtonPart, HexStack } from "../schema.ts";
import { validateStack } from "../stackValidator.ts";
import { HexMutationError, createHexStore, type CompiledScript } from "../store.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function pixelsWith(...dark: number[]): Uint8Array {
  const pixels = new Uint8Array(ICON_PIXELS);
  for (const i of dark) pixels[i] = 1;
  return pixels;
}

const TOP_LEFT = encodeIcon(pixelsWith(0));
const LAST = encodeIcon(pixelsWith(ICON_PIXELS - 1));

function button(id: string, layerScope: "card" | "background", extra: Partial<HexButtonPart> = {}): HexButtonPart {
  return {
    id, name: id, type: "button", layerScope, rect: { x: 0, y: 0, width: 40, height: 40 }, visible: true,
    enabled: true, scriptSource: "", style: "rectangle", title: id, showName: false, autoHilite: false,
    hilite: false, ...extra,
  };
}

/** Icons "a", "b", "c" in that order; buttons naming "b" on a card and on the background. */
function makeStack(): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Icons", author: "", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{
      id: "bkg_1", name: "Bg", bitmap: emptyBitmap, scriptSource: "", cantDelete: false,
      parts: [button("prt_bg", "background", { iconId: "b" })],
    }],
    cards: [
      {
        id: "crd_1", name: "One", backgroundId: "bkg_1", bitmap: emptyBitmap, bgFieldContents: {}, marked: false,
        cantDelete: false, dontSearch: false, scriptSource: "",
        parts: [button("prt_c1", "card", { iconId: "b" }), button("prt_c2", "card", { iconId: "a" }), button("prt_c3", "card")],
      },
      {
        id: "crd_2", name: "Two", backgroundId: "bkg_1", bitmap: emptyBitmap, bgFieldContents: {}, marked: false,
        cantDelete: false, dontSearch: false, scriptSource: "", parts: [],
      },
    ],
    customIcons: { a: BLANK_ICON, b: TOP_LEFT, c: LAST },
    scriptSource: "",
  };
}

const compile = (): CompiledScript => ({ ast: { handlers: {} }, errors: [] });

function setup(stack: HexStack = makeStack()) {
  const store = createHexStore({ stack, compile });
  const history = createHistory(store);
  return { store, history, stack: () => store.getSnapshot().stack };
}

/** Applies through the history, checks validity, Undo (deep-equal to before), Redo (deep-equal to after). */
function roundTrip(command: IconCommand, initial: HexStack = makeStack()): { before: HexStack; after: HexStack } {
  const { history, stack } = setup(initial);
  const before = structuredClone(stack());
  history.execute(command);
  expect(history.undoLabel()).toBe(command.label);
  const after = structuredClone(stack());
  expect(after).not.toEqual(before);
  expect(validateStack(after).ok).toBe(true);
  history.undo();
  expect(stack()).toEqual(before);
  history.redo();
  expect(stack()).toEqual(after);
  return { before, after };
}

const iconIds = (stack: HexStack) =>
  [...stack.backgrounds, ...stack.cards].flatMap((owner) => owner.parts).map((part) => (part.type === "button" ? part.iconId : "-"));

describe("icon data (Requirements 8.1, 8.5)", () => {
  it("encodes known images", () => {
    expect(encodeIcon(new Uint8Array(ICON_PIXELS))).toBe(BLANK_ICON);
    expect(BLANK_ICON).toBe("A".repeat(171) + "=");
    expect(TOP_LEFT).toBe("g" + "A".repeat(170) + "=");
    const topRow = encodeIcon(pixelsWith(...Array.from({ length: 32 }, (_, x) => x)));
    expect(topRow.startsWith("/////w")).toBe(true);
    expect(LAST).toBe("A".repeat(170) + "E=");
    for (const data of [BLANK_ICON, TOP_LEFT, topRow, LAST]) {
      expect(data).toHaveLength(ICON_DATA_LENGTH);
      expect(isIconData(data)).toBe(true);
    }
  });

  it("decodes known images back to their pixels", () => {
    expect([...decodeIcon(TOP_LEFT)].map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([0]);
    expect([...decodeIcon(LAST)].map((v, i) => (v ? i : -1)).filter((i) => i >= 0)).toEqual([ICON_PIXELS - 1]);
    expect(decodeIcon(BLANK_ICON).every((v) => v === 0)).toBe(true);
  });

  it.each([
    ["short", "A".repeat(170) + "="],
    ["long", "A".repeat(172) + "="],
    ["unpadded", "A".repeat(172)],
    ["URL-safe", "_" + "A".repeat(170) + "="],
    ["non-canonical", "A".repeat(170) + "F="],
    ["empty", ""],
  ])("rejects %s strings", (_label, data) => {
    expect(isIconData(data)).toBe(false);
    expect(() => decodeIcon(data)).toThrow(RangeError);
  });

  it("refuses pixel arrays of the wrong length or with other values", () => {
    expect(() => encodeIcon(new Uint8Array(1023))).toThrow(RangeError);
    expect(() => encodeIcon(pixelsWith().fill(2, 5, 6))).toThrow(RangeError);
  });

  it("builds icon data from rows of # and .", () => {
    const rows = Array.from({ length: 32 }, (_, y) => (y === 0 ? "#" + ".".repeat(31) : ".".repeat(32)));
    expect(iconFromRows(rows)).toBe(TOP_LEFT);
    expect(() => iconFromRows(rows.slice(1))).toThrow(RangeError);
    expect(() => iconFromRows([...rows.slice(1), ".".repeat(31)])).toThrow(RangeError);
    expect(() => iconFromRows([...rows.slice(1), "x".repeat(32)])).toThrow(RangeError);
  });
});

describe("icon names (Requirements 8.2, 10.4-10.6)", () => {
  it.each([["a"], ["Icon 1"], ["x".repeat(32)], ["~!@ #"], ["constructor"]])("accepts %j", (name) => {
    expect(isIconName(name)).toBe(true);
  });

  it.each([[""], [" a"], ["a "], ["x".repeat(33)], ["__proto__"], ["\u00e9"], ["a\nb"]])("rejects %j", (name) => {
    expect(isIconName(name)).toBe(false);
  });

  it("freeIconName keeps a free base, else numbers it case-insensitively and shortens long bases", () => {
    expect(freeIconName("Star", ["moon"])).toBe("Star");
    expect(freeIconName("Star", ["star"])).toBe("Star 2");
    expect(freeIconName("Star", ["Star", "STAR 2", "star 3"])).toBe("Star 4");
    const long = "x".repeat(32);
    expect(freeIconName(long, [long])).toBe("x".repeat(30) + " 2");
    expect(freeIconName(long, [long, "x".repeat(30) + " 2"])).toBe("x".repeat(30) + " 3");
  });

  it("iconNameError reports invalid and taken names, except the icon being renamed", () => {
    const stack = makeStack();
    expect(iconNameError(stack, " x")).toBe(ICON_NAME_INVALID);
    expect(iconNameError(stack, "B")).toBe('An icon named "B" already exists.');
    expect(iconNameError(stack, "B", "b")).toBeUndefined();
    expect(iconNameError(stack, "d")).toBeUndefined();
  });
});

describe("icon commands (Requirements 8.4, 10.3-10.10)", () => {
  it("New Icon adds a blank 'Icon N' at the end and records one command", () => {
    const stack = makeStack();
    stack.customIcons = { ...stack.customIcons, "ICON 1": BLANK_ICON };
    const command = createNewIconCommand(stack);
    expect(command.name).toBe("Icon 2");
    const { after } = roundTrip(command, stack);
    expect(Object.keys(after.customIcons)).toEqual(["a", "b", "c", "ICON 1", "Icon 2"]);
    expect(after.customIcons["Icon 2"]).toBe(BLANK_ICON);
  });

  it("Duplicate Icon always numbers the copy; Add Icon keeps a free name and numbers a taken one from 2", () => {
    const duplicate = createCopyIconCommand(makeStack(), "b", TOP_LEFT, "Duplicate Icon");
    expect(duplicate.name).toBe("b 2");
    expect(roundTrip(duplicate).after.customIcons["b 2"]).toBe(TOP_LEFT);

    // The base is not in the stack (a built-in icon), yet the copy is still numbered.
    const builtIn = createCopyIconCommand(makeStack(), "hex-star", LAST, "Duplicate Icon");
    expect(builtIn.name).toBe("hex-star 2");

    const add = createCopyIconCommand(makeStack(), "hex-star", LAST, "Add Icon");
    expect(add.name).toBe("hex-star");
    expect(Object.keys(roundTrip(add).after.customIcons)).toEqual(["a", "b", "c", "hex-star"]);

    const taken = createCopyIconCommand(makeStack(), "B", LAST, "Add Icon");
    expect(taken.name).toBe("B 2");
  });

  it("Rename Icon renames in place and rewrites iconId on card and background buttons", () => {
    const command = createRenameIconCommand(makeStack(), "b", "Bee");
    expect(command.name).toBe("Bee");
    const { before, after } = roundTrip(command);
    expect(Object.keys(after.customIcons)).toEqual(["a", "Bee", "c"]);
    expect(after.customIcons.Bee).toBe(TOP_LEFT);
    expect(iconIds(before)).toEqual(["b", "b", "a", undefined]);
    expect(iconIds(after)).toEqual(["Bee", "Bee", "a", undefined]);
    // Key order of the part object is kept.
    expect(Object.keys(after.cards[0].parts[0])).toEqual(Object.keys(before.cards[0].parts[0]));
  });

  it("Rename Icon refuses invalid and taken names, but allows a change of case", () => {
    expect(() => createRenameIconCommand(makeStack(), "b", "A")).toThrow(HexMutationError);
    expect(() => createRenameIconCommand(makeStack(), "b", "b ")).toThrow(HexMutationError);
    expect(() => createRenameIconCommand(makeStack(), "zz", "y")).toThrow(HexMutationError);
    expect(Object.keys(roundTrip(createRenameIconCommand(makeStack(), "b", "B")).after.customIcons)).toEqual(["a", "B", "c"]);
  });

  it("Delete Icon removes the icon and the iconId key of every button naming it", () => {
    const command = createDeleteIconCommand(makeStack(), "b");
    expect(command.name).toBeUndefined();
    const { after } = roundTrip(command);
    expect(Object.keys(after.customIcons)).toEqual(["a", "c"]);
    expect(iconIds(after)).toEqual([undefined, undefined, "a", undefined]);
    expect(after.backgrounds[0].parts[0]).not.toHaveProperty("iconId");
    expect(after.cards[0].parts[0]).not.toHaveProperty("iconId");
  });

  it("Edit Icon replaces the data in place and refuses a stale 'before'", () => {
    const command = createEditIconCommand("a", BLANK_ICON, LAST);
    const { after } = roundTrip(command);
    expect(Object.keys(after.customIcons)).toEqual(["a", "b", "c"]);
    expect(after.customIcons.a).toBe(LAST);

    const { history, stack } = setup();
    const before = stack();
    expect(() => history.execute(createEditIconCommand("a", TOP_LEFT, LAST))).toThrow(HexMutationError);
    expect(stack()).toBe(before);
    expect(history.canUndo()).toBe(false);
  });

  it("Set Icon sets iconId, copying a built-in icon first; Remove Icon removes the key", () => {
    const set = createButtonIconCommand(makeStack(), "prt_c3", "c");
    expect([set.label, set.name]).toEqual(["Set Icon", "c"]);
    expect(iconIds(roundTrip(set).after)).toEqual(["b", "b", "a", "c"]);

    const copied = createButtonIconCommand(makeStack(), "prt_bg", "hex-key", { name: "hex-key", data: LAST });
    const { after } = roundTrip(copied);
    expect(Object.keys(after.customIcons)).toEqual(["a", "b", "c", "hex-key"]);
    expect(iconIds(after)).toEqual(["hex-key", "b", "a", undefined]);

    const remove = createButtonIconCommand(makeStack(), "prt_c2", undefined);
    expect([remove.label, remove.name]).toEqual(["Remove Icon", undefined]);
    const removed = roundTrip(remove).after;
    expect(removed.cards[0].parts[1]).not.toHaveProperty("iconId");
  });

  it("records nothing for a command that changes nothing", () => {
    const { history, stack } = setup();
    const before = stack();
    history.execute(createButtonIconCommand(before, "prt_c1", "b"));
    history.execute(createButtonIconCommand(before, "prt_c3", undefined));
    history.execute(createEditIconCommand("a", BLANK_ICON, BLANK_ICON));
    history.execute(createRenameIconCommand(before, "a", "a"));
    expect(stack()).toBe(before);
    expect(history.canUndo()).toBe(false);
  });

  it("refuses a button that does not exist and an icon that does not exist", () => {
    const stack = makeStack();
    expect(() => createButtonIconCommand(stack, "prt_missing", "a")).toThrow(HexMutationError);
    expect(() => createButtonIconCommand(stack, "prt_c1", "zz")).toThrow(HexMutationError);
    expect(() => createButtonIconCommand(stack, "prt_c1", "constructor")).toThrow(HexMutationError);
    expect(() => createDeleteIconCommand(stack, "toString")).toThrow(HexMutationError);
    expect(() => createButtonIconCommand(stack, "prt_c1", "a", { name: "b", data: LAST })).toThrow(HexMutationError);
  });

  it("re-applies with the same names after Undo, and undo restores the same objects", () => {
    const { history, stack } = setup();
    const before = stack();
    history.execute(createNewIconCommand(before));
    const first = structuredClone(stack());
    history.undo();
    expect(stack().customIcons).toBe(before.customIcons);
    history.redo();
    expect(stack()).toEqual(first);
    expect(Object.keys(stack().customIcons)).toContain("Icon 1");
  });
});
