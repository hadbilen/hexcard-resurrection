import { describe, expect, it } from "vitest";
import {
  NEW_BUTTON_RECT,
  NEW_FIELD_RECT,
  canDeleteCard,
  collectIds,
  createBlankStack,
  createDeleteCardCommand,
  createDeletePartCommand,
  createId,
  createNewBackgroundCommand,
  createNewCardCommand,
  createNewPartCommand,
  numberedName,
  partName,
} from "../authoringCommands.ts";
import { createHistory, type HexCommand } from "../history.ts";
import type { HexBackground, HexCard, HexFieldPart, HexStack } from "../schema.ts";
import { validateStack } from "../stackValidator.ts";
import { createHexStore, HexMutationError, type CompiledScript } from "../store.ts";

const bitmap = () => ({ width: 512, height: 342, rleData: "" });

function card(id: string, backgroundId: string, extra: Partial<HexCard> = {}): HexCard {
  return {
    id, name: id, backgroundId, bitmap: bitmap(), parts: [], bgFieldContents: {},
    marked: false, cantDelete: false, dontSearch: false, scriptSource: "", ...extra,
  };
}

function background(id: string, extra: Partial<HexBackground> = {}): HexBackground {
  return { id, name: id, bitmap: bitmap(), parts: [], scriptSource: "", cantDelete: false, ...extra };
}

function bgField(id: string): HexFieldPart {
  return {
    id, name: id, type: "field", layerScope: "background", rect: { x: 0, y: 0, width: 50, height: 20 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "Sans", textSize: 12, textStyle: [],
  };
}

function makeStack(): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "T", author: "", createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z", dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      background("bkg_a", { name: "Background 1", parts: [bgField("prt_bf")] }),
      background("bkg_b", { name: "Background 2" }),
    ],
    cards: [
      card("crd_1", "bkg_a", { name: "Card 1", bgFieldContents: { prt_bf: "one" } }),
      card("crd_2", "bkg_a", { name: "Card 2", bgFieldContents: { prt_bf: "two" } }),
      card("crd_3", "bkg_b", { name: "Card 3" }),
    ],
    customIcons: {}, scriptSource: "",
  };
}

const compile = (): CompiledScript => ({ ast: { handlers: {} }, errors: [] });

function setup(stack: HexStack = makeStack()) {
  expect(validateStack(stack).ok).toBe(true);
  const store = createHexStore({ stack, compile });
  const history = createHistory(store);
  return { store, history };
}

/** Runs apply, revert and re-apply directly and checks each result is valid and exactly reversible. */
function roundTrip(command: HexCommand, before: HexStack): HexStack {
  const after = command.apply(before);
  expect(validateStack(after).ok).toBe(true);
  expect(command.revert(after)).toEqual(before);
  const again = command.apply(before);
  expect(again).toEqual(after);
  return after;
}

/** A random source that replays `values` and then repeats the last one. */
function scripted(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

describe("ids", () => {
  it("builds prefix + 10 base-36 characters", () => {
    expect(createId("crd_", new Set())).toMatch(/^crd_[0-9a-z]{10}$/);
    expect(createId("prt_", new Set(), () => 0)).toBe("prt_0000000000");
    expect(createId("bkg_", new Set(), () => 0.999999)).toBe("bkg_zzzzzzzzzz");
  });

  it("draws again on a collision", () => {
    const taken = new Set(["stk_0000000000"]);
    // First 10 draws give the taken id, the next 10 give "1111111111".
    const random = scripted([...Array<number>(10).fill(0), ...Array<number>(10).fill(1 / 36)]);
    expect(createId("stk_", taken, random)).toBe("stk_1111111111");
  });

  it("collectIds covers stack, backgrounds, cards and parts", () => {
    expect([...collectIds(makeStack())].sort()).toEqual(
      ["bkg_a", "bkg_b", "crd_1", "crd_2", "crd_3", "prt_bf", "stk_1"],
    );
  });
});

describe("default names", () => {
  it("numberedName takes the lowest free N, case-insensitively", () => {
    expect(numberedName("Card", [])).toBe("Card 1");
    expect(numberedName("Card", ["Card 1", "card 2", "Card 4"])).toBe("Card 3");
    expect(numberedName("Background", ["BACKGROUND 1", "Other"])).toBe("Background 2");
  });

  it("partName starts with the bare name, then numbers from 2", () => {
    expect(partName("New Button", [])).toBe("New Button");
    expect(partName("New Button", ["new button"])).toBe("New Button 2");
    expect(partName("New Field", ["New Field", "New Field 2", "NEW FIELD 4"])).toBe("New Field 3");
  });
});

describe("createBlankStack", () => {
  it("passes validateStack and matches Requirement 3.2", () => {
    const now = new Date("2026-02-03T04:05:06.000Z");
    const stack = createBlankStack({ now });
    expect(validateStack(stack).ok).toBe(true);
    expect(stack).toMatchObject({
      schemaVersion: "2.0.0", name: "Untitled", author: "", createdAt: now.toISOString(), updatedAt: now.toISOString(),
      themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
      customIcons: {}, scriptSource: "",
    });
    expect(stack.id).toMatch(/^stk_/);
    expect(stack.backgrounds).toHaveLength(1);
    expect(stack.backgrounds[0]).toMatchObject({ name: "Background 1", parts: [], cantDelete: false });
    expect(stack.backgrounds[0].bitmap.rleData).toBe("");
    expect(stack.cards).toHaveLength(1);
    expect(stack.cards[0]).toMatchObject({
      name: "Card 1", backgroundId: stack.backgrounds[0].id, parts: [], bgFieldContents: {},
      marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
    });
    expect(stack.cards[0].id).toMatch(/^crd_/);
    expect(stack.backgrounds[0].id).toMatch(/^bkg_/);
  });

  it("gives distinct ids even with a constant random source", () => {
    const stack = createBlankStack({ random: () => 0 });
    expect(new Set([stack.id, stack.backgrounds[0].id, stack.cards[0].id]).size).toBe(3);
  });
});

describe("canDeleteCard", () => {
  it("is false for the only card", () => {
    expect(canDeleteCard(createBlankStack(), createBlankStack().cards[0].id)).toBe(false);
  });

  it("is false for a card with cantDelete", () => {
    const stack = makeStack();
    stack.cards[0] = { ...stack.cards[0], cantDelete: true };
    expect(canDeleteCard(stack, "crd_1")).toBe(false);
    expect(canDeleteCard(stack, "crd_2")).toBe(true);
  });

  it("is false for the last card of a background with cantDelete, true when another card shares it", () => {
    const stack = makeStack();
    stack.backgrounds[1] = { ...stack.backgrounds[1], cantDelete: true };
    expect(canDeleteCard(stack, "crd_3")).toBe(false);
    stack.backgrounds[0] = { ...stack.backgrounds[0], cantDelete: true };
    expect(canDeleteCard(stack, "crd_1")).toBe(true);
  });

  it("is false for an unknown card", () => {
    expect(canDeleteCard(makeStack(), "crd_nope")).toBe(false);
  });
});

describe("New Card", () => {
  it("inserts right after the current card on its background", () => {
    const before = makeStack();
    const command = createNewCardCommand(before, "crd_1");
    expect(command.label).toBe("New Card");
    expect(command.backgroundId).toBe("bkg_a");
    const after = roundTrip(command, before);
    expect(after.cards.map((c) => c.id)).toEqual(["crd_1", command.cardId, "crd_2", "crd_3"]);
    const created = after.cards[1];
    expect(created).toMatchObject({
      name: "Card 4", backgroundId: "bkg_a", parts: [], bgFieldContents: {},
      marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
    });
    expect(created.bitmap.rleData).toBe("");
    expect(created.id).toMatch(/^crd_[0-9a-z]{10}$/);
    expect(after.cards[0]).toBe(before.cards[0]);
    expect(command.currentCardAfter?.("apply")).toBe(command.cardId);
    expect(command.currentCardAfter?.("revert")).toBe("crd_1");
  });

  it("inserts after the last card too", () => {
    const before = makeStack();
    const after = roundTrip(createNewCardCommand(before, "crd_3"), before);
    expect(after.cards.at(-1)?.backgroundId).toBe("bkg_b");
  });

  it("throws for a missing current card and does not apply to a stack lacking it", () => {
    expect(() => createNewCardCommand(makeStack(), "crd_nope")).toThrow(HexMutationError);
    const command = createNewCardCommand(makeStack(), "crd_1");
    const other = { ...makeStack(), cards: [card("crd_x", "bkg_a")] };
    expect(() => command.apply(other)).toThrow(HexMutationError);
  });

  it("revert throws when the card is gone", () => {
    const before = makeStack();
    expect(() => createNewCardCommand(before, "crd_1").revert(before)).toThrow(HexMutationError);
  });
});

describe("New Background", () => {
  it("appends a background and inserts its card after the current card", () => {
    const before = makeStack();
    const command = createNewBackgroundCommand(before, "crd_2");
    expect(command.label).toBe("New Background");
    const after = roundTrip(command, before);
    expect(after.backgrounds.map((b) => b.id)).toEqual(["bkg_a", "bkg_b", command.backgroundId]);
    expect(after.backgrounds[2]).toMatchObject({ name: "Background 3", parts: [], scriptSource: "", cantDelete: false });
    expect(after.backgrounds[2].bitmap.rleData).toBe("");
    expect(after.cards.map((c) => c.id)).toEqual(["crd_1", "crd_2", command.cardId, "crd_3"]);
    expect(after.cards[2].backgroundId).toBe(command.backgroundId);
    expect(command.currentCardAfter?.("apply")).toBe(command.cardId);
    expect(command.currentCardAfter?.("revert")).toBe("crd_2");
  });

  it("uses different ids for background and card", () => {
    const command = createNewBackgroundCommand(makeStack(), "crd_1", () => 0);
    expect(command.cardId).not.toBe(command.backgroundId);
  });
});

describe("Delete Card", () => {
  it("destination is the next card in the first and middle position", () => {
    const before = makeStack();
    expect(createDeleteCardCommand(before, "crd_1").cardId).toBe("crd_2");
    expect(createDeleteCardCommand(before, "crd_2").cardId).toBe("crd_3");
  });

  it("destination is the previous card when the last card is deleted", () => {
    const command = createDeleteCardCommand(makeStack(), "crd_3");
    expect(command.cardId).toBe("crd_2");
    expect(command.backgroundId).toBe("bkg_a");
  });

  it("keeps the background while another card uses it", () => {
    const before = makeStack();
    const command = createDeleteCardCommand(before, "crd_1");
    expect(command.removesBackground).toBe(false);
    const after = roundTrip(command, before);
    expect(after.cards.map((c) => c.id)).toEqual(["crd_2", "crd_3"]);
    expect(after.backgrounds).toHaveLength(2);
    expect(command.currentCardAfter?.("apply")).toBe("crd_2");
    expect(command.currentCardAfter?.("revert")).toBe("crd_1");
  });

  it("removes the background with its last card and restores it at the same index", () => {
    const before = makeStack();
    const command = createDeleteCardCommand(before, "crd_3");
    expect(command.removesBackground).toBe(true);
    const after = roundTrip(command, before);
    expect(after.backgrounds.map((b) => b.id)).toEqual(["bkg_a"]);

    const first = { ...makeStack(), cards: [card("crd_1", "bkg_b"), card("crd_2", "bkg_a")] };
    const del = createDeleteCardCommand(first, "crd_1");
    expect(roundTrip(del, first).backgrounds.map((b) => b.id)).toEqual(["bkg_a"]);
  });

  it("restores runtime changes made to the card before the commit", () => {
    const before = makeStack();
    const command = createDeleteCardCommand(before, "crd_2");
    const edited: HexStack = {
      ...before,
      cards: before.cards.map((c) => (c.id === "crd_2" ? { ...c, bgFieldContents: { prt_bf: "edited" } } : c)),
    };
    const after = command.apply(edited);
    expect(command.revert(after)).toEqual(edited);
  });

  it("throws unless canDeleteCard", () => {
    const stack = makeStack();
    stack.cards[0] = { ...stack.cards[0], cantDelete: true };
    expect(() => createDeleteCardCommand(stack, "crd_1")).toThrow(HexMutationError);
    expect(() => createDeleteCardCommand(createBlankStack(), createBlankStack().cards[0].id)).toThrow(HexMutationError);
  });

  it("revert before apply throws", () => {
    const before = makeStack();
    expect(() => createDeleteCardCommand(before, "crd_1").revert(before)).toThrow(HexMutationError);
  });
});

describe("New Button / New Field", () => {
  const state = (stack: HexStack, editLayer: "card" | "background", currentCardId = "crd_1") =>
    ({ stack, currentCardId, editLayer });

  it("adds the default button at the end of the card's parts", () => {
    const before = makeStack();
    const command = createNewPartCommand(state(before, "card"), "button");
    expect(command).toMatchObject({ label: "New Button", partType: "button", layer: "card" });
    const after = roundTrip(command, before);
    const part = after.cards[0].parts.at(-1);
    expect(part).toEqual({
      id: command.partId, name: "New Button", type: "button", layerScope: "card", rect: NEW_BUTTON_RECT,
      visible: true, enabled: true, scriptSource: "", style: "roundRect", title: "New Button",
      showName: true, autoHilite: true, hilite: false,
    });
    expect(part).not.toHaveProperty("family");
    expect(part).not.toHaveProperty("iconId");
    expect(command.currentCardAfter?.("apply")).toBe("crd_1");
    expect(command.currentCardAfter?.("revert")).toBe("crd_1");
  });

  it("adds the default field to the background in Edit Background mode and leaves bgFieldContents alone", () => {
    const before = makeStack();
    const command = createNewPartCommand(state(before, "background", "crd_2"), "field");
    expect(command).toMatchObject({ label: "New Field", partType: "field", layer: "background" });
    const after = roundTrip(command, before);
    expect(after.backgrounds[0].parts.map((p) => p.id)).toEqual(["prt_bf", command.partId]);
    expect(after.backgrounds[0].parts[1]).toEqual({
      id: command.partId, name: "New Field", type: "field", layerScope: "background", rect: NEW_FIELD_RECT,
      visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
      lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "Sans", textSize: 12, textStyle: [],
    });
    expect(after.cards.map((c) => c.bgFieldContents)).toEqual(before.cards.map((c) => c.bgFieldContents));
  });

  it("numbers names per type and layer owner, and keeps the part new objects equal on redo", () => {
    const stack = makeStack();
    const first = createNewPartCommand(state(stack, "card"), "button");
    const s1 = first.apply(stack);
    const second = createNewPartCommand(state(s1, "card"), "button");
    expect(second.apply(s1).cards[0].parts.map((p) => p.name)).toEqual(["New Button", "New Button 2"]);
    // A field on the same card, or a button on another card, starts again at the bare name.
    expect(createNewPartCommand(state(s1, "card"), "field").apply(s1).cards[0].parts[1].name).toBe("New Field");
    expect(createNewPartCommand(state(s1, "card", "crd_2"), "button").apply(s1).cards[1].parts[0].name).toBe("New Button");
  });

  it("generates ids unused in the whole stack", () => {
    const stack = makeStack();
    const command = createNewPartCommand(state(stack, "card"), "button", () => 0);
    expect(command.partId).toBe("prt_0000000000");
    expect(collectIds(stack).has(command.partId)).toBe(false);
  });

  it("revert throws when the part is missing", () => {
    const before = makeStack();
    expect(() => createNewPartCommand(state(before, "card"), "button").revert(before)).toThrow(HexMutationError);
  });
});

describe("Delete Part", () => {
  it("removes a card part and restores it at its index", () => {
    const stack = makeStack();
    const b1 = createNewPartCommand({ stack, currentCardId: "crd_1", editLayer: "card" }, "button");
    const s1 = b1.apply(stack);
    const b2 = createNewPartCommand({ stack: s1, currentCardId: "crd_1", editLayer: "card" }, "field");
    const s2 = b2.apply(s1);
    const command = createDeletePartCommand({ stack: s2, currentCardId: "crd_1", editLayer: "card" }, b1.partId);
    expect(command.label).toBe("Delete Part");
    const after = roundTrip(command, s2);
    expect(after.cards[0].parts.map((p) => p.id)).toEqual([b2.partId]);
    expect(command.currentCardAfter?.("apply")).toBe("crd_1");
    expect(command.currentCardAfter?.("revert")).toBe("crd_1");
  });

  it("removes a background field's entries from every card and restores them", () => {
    const before = makeStack();
    const command = createDeletePartCommand({ stack: before, currentCardId: "crd_1", editLayer: "background" }, "prt_bf");
    const after = roundTrip(command, before);
    expect(after.backgrounds[0].parts).toEqual([]);
    expect(after.cards.every((c) => !("prt_bf" in c.bgFieldContents))).toBe(true);
    expect(command.revert(after).cards.map((c) => c.bgFieldContents)).toEqual([{ prt_bf: "one" }, { prt_bf: "two" }, {}]);
  });

  it("throws for a part that is not on the edit target", () => {
    const before = makeStack();
    expect(() => createDeletePartCommand({ stack: before, currentCardId: "crd_1", editLayer: "card" }, "prt_bf"))
      .toThrow(HexMutationError);
  });

  it("revert before apply throws", () => {
    const before = makeStack();
    const command = createDeletePartCommand({ stack: before, currentCardId: "crd_1", editLayer: "background" }, "prt_bf");
    expect(() => command.revert(before)).toThrow(HexMutationError);
  });
});

describe("through a real store and history (z-order, current card, labels)", () => {
  it("Undo / Redo of structural commands restore the stack and the current card", () => {
    const { store, history } = setup();
    const original = store.getSnapshot().stack;

    const newCard = createNewCardCommand(original, "crd_1");
    history.execute(newCard);
    expect(store.getSnapshot().currentCardId).toBe(newCard.cardId);
    expect(history.undoLabel()).toBe("New Card");

    const state = store.getSnapshot();
    const part = createNewPartCommand(state, "button");
    history.execute(part);
    const parts = store.getSnapshot().stack.cards[1].parts;
    expect(parts.at(-1)?.id).toBe(part.partId);

    const afterPart = store.getSnapshot().stack;
    history.undo();
    history.undo();
    expect(store.getSnapshot().stack).toEqual(original);
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(history.redoLabel()).toBe("New Card");

    history.redo();
    history.redo();
    expect(store.getSnapshot().stack).toEqual(afterPart);
    expect(store.getSnapshot().currentCardId).toBe(newCard.cardId);
  });

  it("Delete Card then Undo returns to the deleted card", () => {
    const { store, history } = setup();
    const original = store.getSnapshot().stack;
    store.applyRuntime({ type: "goToCard", cardId: "crd_3" });
    const command = createDeleteCardCommand(store.getSnapshot().stack, "crd_3");
    history.execute(command);
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    history.undo();
    expect(store.getSnapshot().currentCardId).toBe("crd_3");
    expect(store.getSnapshot().stack).toEqual(original);
  });

  it("every command result is a valid stack", () => {
    const { store, history } = setup();
    history.execute(createNewBackgroundCommand(store.getSnapshot().stack, "crd_1"));
    expect(validateStack(store.getSnapshot().stack).ok).toBe(true);
    history.execute(createNewCardCommand(store.getSnapshot().stack, store.getSnapshot().currentCardId));
    expect(validateStack(store.getSnapshot().stack).ok).toBe(true);
  });
});
