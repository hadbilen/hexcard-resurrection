/**
 * Spec 06 task 6: the Recent list (Requirements 5.1, 5.2, 5.3, 5.5) with a real store, history and
 * message bus. The recording handler runner logs the stack script's lifecycle messages.
 */
import { describe, expect, it } from "vitest";
import {
  createDeleteCardCommand,
  createNewBackgroundCommand,
  createNewCardCommand,
} from "../authoringCommands.ts";
import { createHistory } from "../history.ts";
import { createMessageBus, type HandlerRunner, type HexMessage } from "../messageBus.ts";
import { parseHexTalk } from "../parser.ts";
import { createRecentCards, goToRecentCard, RECENT_LIMIT } from "../recentCards.ts";
import type { HexBackground, HexCard, HexStack } from "../schema.ts";
import { createHexStore } from "../store.ts";
import type { HexHost } from "../vm.ts";

const bitmap = () => ({ width: 512, height: 342, rleData: "" });
const LIFECYCLE = ["openStack", "openBackground", "openCard", "closeCard", "closeBackground", "newCard", "deleteCard"];

function makeStack(cardCount: number, backgroundCount = 1, idPrefix = "crd"): HexStack {
  const backgrounds: HexBackground[] = Array.from({ length: backgroundCount }, (_, b) => ({
    id: `bkg_${b + 1}`, name: `bkg_${b + 1}`, bitmap: bitmap(), parts: [], scriptSource: "", cantDelete: false,
  }));
  const cards: HexCard[] = Array.from({ length: cardCount }, (_, c) => ({
    id: `${idPrefix}_${c + 1}`, name: `${idPrefix}_${c + 1}`, backgroundId: backgrounds[c % backgroundCount].id, bitmap: bitmap(),
    parts: [], bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
  }));
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds, cards, customIcons: {},
    scriptSource: LIFECYCLE.map((name) => `on ${name}\nend ${name}`).join("\n"),
  };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 3; i++) await new Promise((resolve) => setTimeout(resolve, 0));
};
const msg = (name: string, targetId: string, ...params: (string | number)[]): HexMessage => ({ name, params, targetId });

function setup(stack: HexStack, limit?: number) {
  const store = createHexStore({ stack, compile: parseHexTalk });
  const history = createHistory(store);
  const log: string[] = [];
  const runner: HandlerRunner = async (handler, _params, me) => {
    if (me === store.getSnapshot().stack.id) {
      log.push(`${handler.eventName}@${store.getSnapshot().currentCardId}`);
      return "handled";
    }
    return "passed";
  };
  const bus = createMessageBus({
    store,
    host: {} as HexHost,
    runHandler: runner,
    isPageVisible: () => true,
    isModalOpen: () => false,
    scheduleInterval: () => () => {},
    onError: (error) => {
      throw error;
    },
    warn: () => {},
  });
  const recent = createRecentCards(store, limit);
  const visit = (cardId: string): void => store.applyRuntime({ type: "goToCard", cardId });
  return { store, history, bus, log, recent, visit };
}

describe("createRecentCards (Requirement 5.1)", () => {
  it("starts with the current card only and exports the limit of 12", () => {
    const { recent } = setup(makeStack(3));
    expect(RECENT_LIMIT).toBe(12);
    expect(recent.list()).toEqual(["crd_1"]);
  });

  it("lists the cards newest first with the current card first", () => {
    const { recent, visit } = setup(makeStack(4));
    visit("crd_3");
    visit("crd_2");
    expect(recent.list()).toEqual(["crd_2", "crd_3", "crd_1"]);
    visit("crd_4");
    expect(recent.list()).toEqual(["crd_4", "crd_2", "crd_3", "crd_1"]);
  });

  it("lists each card once: a revisited card moves to the front", () => {
    const { recent, visit } = setup(makeStack(3));
    visit("crd_2");
    visit("crd_3");
    visit("crd_2");
    visit("crd_1");
    expect(recent.list()).toEqual(["crd_1", "crd_2", "crd_3"]);
    visit("crd_1"); // no change
    expect(recent.list()).toEqual(["crd_1", "crd_2", "crd_3"]);
  });

  it("keeps at most 12 cards and drops the oldest", () => {
    const { recent, visit } = setup(makeStack(15));
    for (let i = 2; i <= 15; i++) visit(`crd_${i}`);
    const list = recent.list();
    expect(list).toHaveLength(12);
    expect(list[0]).toBe("crd_15");
    expect(list[11]).toBe("crd_4");
    expect(list).not.toContain("crd_3");
    expect(list).not.toContain("crd_1");
  });

  it("honours another limit", () => {
    const { recent, visit } = setup(makeStack(5), 3);
    for (const id of ["crd_2", "crd_3", "crd_4", "crd_5"]) visit(id);
    expect(recent.list()).toEqual(["crd_5", "crd_4", "crd_3"]);
  });

  it("stops listening after dispose", () => {
    const { recent, visit, store } = setup(makeStack(3));
    recent.dispose();
    visit("crd_3");
    visit("crd_2");
    // crd_3 was never recorded; list() still puts the current card first.
    expect(recent.list()).toEqual(["crd_2", "crd_1"]);
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
  });
});

describe("every way a card becomes current (Requirement 5.1)", () => {
  it("go and the Go menu: bus.changeCard to a card, to the relative card and back", async () => {
    const { recent, bus } = setup(makeStack(4));
    bus.runCommand("Go", async (ctx) => {
      await bus.changeCard("crd_3", ctx);
      await bus.changeCard("crd_4", ctx);
      await bus.changeCard({ type: "relative", dir: "back" }, ctx); // go back: to crd_3
    });
    await settle();
    expect(recent.list()).toEqual(["crd_3", "crd_4", "crd_1"]);
  });

  it("the arrow keys", async () => {
    const { recent, bus, store } = setup(makeStack(3));
    bus.post(msg("keyDown", "crd_1", "ArrowRight"));
    await settle();
    bus.post(msg("keyDown", "crd_2", "ArrowRight"));
    await settle();
    bus.post(msg("keyDown", "crd_3", "ArrowLeft"));
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    expect(recent.list()).toEqual(["crd_2", "crd_3", "crd_1"]);
  });

  it("Find: a change of card through the bus, as the Find dispatch makes it", async () => {
    const { recent, bus } = setup(makeStack(3));
    bus.runCommand("Find", async (ctx) => {
      await bus.changeCard("crd_3", ctx);
    });
    await settle();
    expect(recent.list()).toEqual(["crd_3", "crd_1"]);
  });

  it("Recent: goToRecentCard", async () => {
    const { recent, bus, store, visit } = setup(makeStack(3));
    visit("crd_2");
    visit("crd_3");
    goToRecentCard(store, bus, "crd_1");
    await settle();
    expect(recent.list()).toEqual(["crd_1", "crd_3", "crd_2"]);
  });

  it("New Card, New Background, Delete Card, Undo and Redo", () => {
    const { recent, history, store } = setup(makeStack(2, 2));
    const current = () => store.getSnapshot().currentCardId;

    const newCard = createNewCardCommand(store.getSnapshot().stack, current());
    history.execute(newCard);
    expect(current()).toBe(newCard.cardId);
    expect(recent.list()).toEqual([newCard.cardId, "crd_1"]);

    const newBackground = createNewBackgroundCommand(store.getSnapshot().stack, current());
    history.execute(newBackground);
    expect(recent.list()).toEqual([newBackground.cardId, newCard.cardId, "crd_1"]);

    history.undo(); // New Background: back to the card that was current
    expect(current()).toBe(newCard.cardId);
    expect(recent.list()[0]).toBe(newCard.cardId);
    expect(recent.list()).not.toContain(newBackground.cardId); // the card no longer exists

    history.redo(); // New Background again
    expect(current()).toBe(newBackground.cardId);
    expect(recent.list()[0]).toBe(newBackground.cardId);

    const del = createDeleteCardCommand(store.getSnapshot().stack, current());
    history.execute(del);
    expect(current()).toBe(del.cardId);
    expect(recent.list()[0]).toBe(del.cardId);
    expect(recent.list()).not.toContain(newBackground.cardId);

    history.undo(); // Delete Card: the deleted card is current again
    expect(current()).toBe(newBackground.cardId);
    expect(recent.list()[0]).toBe(newBackground.cardId);
    expect(new Set(recent.list()).size).toBe(recent.list().length);
  });
});

describe("loading and deleted cards (Requirement 5.2)", () => {
  it("resets to the new current card when another stack is loaded, even with the same card ids", () => {
    const { recent, store, visit } = setup(makeStack(3));
    visit("crd_2");
    visit("crd_3");
    expect(recent.list()).toEqual(["crd_3", "crd_2", "crd_1"]);
    store.replaceStack(makeStack(2, 1, "crd")); // shares crd_1 and crd_2 with the old stack
    expect(recent.list()).toEqual(["crd_1"]);
    store.replaceStack(makeStack(2, 1, "new"));
    expect(recent.list()).toEqual(["new_1"]);
    store.applyRuntime({ type: "goToCard", cardId: "new_2" });
    expect(recent.list()).toEqual(["new_2", "new_1"]);
  });

  it("leaves out cards that no longer exist and does not let them use up a place", () => {
    const { recent, store, history, visit } = setup(makeStack(14), 12);
    for (let i = 2; i <= 12; i++) visit(`crd_${i}`);
    expect(recent.list()).toHaveLength(12);
    // Delete crd_5 (not the current card): visit it, delete it, and go on.
    visit("crd_5");
    history.execute(createDeleteCardCommand(store.getSnapshot().stack, "crd_5"));
    expect(recent.list()).not.toContain("crd_5");
    visit("crd_13");
    visit("crd_14");
    const list = recent.list();
    expect(list).not.toContain("crd_5");
    expect(list).toHaveLength(12);
    expect(list.slice(0, 2)).toEqual(["crd_14", "crd_13"]);
  });
});

describe("goToRecentCard (Requirement 5.5)", () => {
  it("goes to the card in one dispatch with the lifecycle messages of go", async () => {
    const { bus, store, log, visit } = setup(makeStack(3, 2));
    visit("crd_2");
    log.length = 0;
    goToRecentCard(store, bus, "crd_1");
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual(["closeCard@crd_2", "closeBackground@crd_2", "openBackground@crd_1", "openCard@crd_1"]);
    expect(bus.backHistory()).toContain("crd_2"); // the departed card is recorded, as for go
  });

  it("does nothing for the current card", async () => {
    const { bus, store, log } = setup(makeStack(3));
    goToRecentCard(store, bus, "crd_1");
    await settle();
    expect(store.getSnapshot().currentCardId).toBe("crd_1");
    expect(log).toEqual([]);
  });

  it("does nothing for a card that no longer exists when the dispatch starts", async () => {
    const { bus, store, log, history } = setup(makeStack(3));
    // Queue the Recent dispatch behind a running one that deletes the target first.
    bus.runCommand("Delete", async () => {
      history.execute(createDeleteCardCommand(store.getSnapshot().stack, "crd_3"));
    });
    goToRecentCard(store, bus, "crd_3");
    await settle();
    expect(store.getSnapshot().stack.cards.map((card) => card.id)).toEqual(["crd_1", "crd_2"]);
    expect(store.getSnapshot().currentCardId).not.toBe("crd_3");
    expect(log).toEqual([]);
  });

  it("runs after the dispatch that is already running (FIFO)", async () => {
    const { bus, store } = setup(makeStack(3));
    const order: string[] = [];
    bus.runCommand("First", async (ctx) => {
      await bus.changeCard("crd_2", ctx);
      order.push(`first ends on ${store.getSnapshot().currentCardId}`);
    });
    goToRecentCard(store, bus, "crd_3");
    await settle();
    expect(order).toEqual(["first ends on crd_2"]);
    expect(store.getSnapshot().currentCardId).toBe("crd_3");
  });
});
