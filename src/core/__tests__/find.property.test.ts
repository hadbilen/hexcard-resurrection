/**
 * Spec 06 task 4.2, Property 3: Find respects the search rules and cycles.
 *
 * **Validates: Requirements 4.4, 4.5, 4.6, 4.7, 4.11**
 *
 * Random stacks (1-6 cards on 1-3 backgrounds, card and background fields with random `visible`,
 * `sharedText`, `content` and `bgFieldContents`, random `dontSearch`), a random needle and a random
 * start card; repeated find commands run from the Message Box runner through a real store, history
 * and message bus with a recording handler runner. The results are compared with a brute-force
 * reference search written independently of find.ts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createHistory } from "../history.ts";
import { createMessageBoxRunner, NOT_FOUND } from "../messageBox.ts";
import { createMessageBus, type HandlerRunner } from "../messageBus.ts";
import { parseHexTalk } from "../parser.ts";
import type { HexBackground, HexCard, HexFieldPart, HexStack } from "../schema.ts";
import { createHexStore } from "../store.ts";
import type { HexHost } from "../vm.ts";

const WORDS = ["lamp", "Lamp", "lamplight", "clamp", "oil", "brass lamp", "LAMP-post", "a9lamp", "x_lamp", "", "oil-lamp"];
const NEEDLES = ["lamp", "LAMP", "oil", "la", "lamp oil", "zzz"];

interface FieldSpec { visible: boolean; sharedText: boolean; content: string }
interface CardSpec { bg: number; dontSearch: boolean; fields: FieldSpec[]; bgTexts: (string | null)[] }
interface StackSpec { backgrounds: FieldSpec[][]; cards: CardSpec[] }

const textArb = fc.array(fc.constantFrom(...WORDS), { maxLength: 3 }).map((words) => words.join(" "));
const fieldArb: fc.Arbitrary<FieldSpec> = fc.record({ visible: fc.boolean(), sharedText: fc.boolean(), content: textArb });
const stackArb: fc.Arbitrary<StackSpec> = fc.record({
  backgrounds: fc.array(fc.array(fieldArb, { maxLength: 2 }), { minLength: 1, maxLength: 3 }),
  cards: fc.array(
    fc.record({
      bg: fc.nat(),
      dontSearch: fc.boolean(),
      fields: fc.array(fieldArb, { maxLength: 2 }),
      bgTexts: fc.array(fc.option(textArb, { nil: null }), { minLength: 2, maxLength: 2 }),
    }),
    { minLength: 1, maxLength: 6 },
  ),
});

const emptyBitmap = { width: 512, height: 342, rleData: "" };
const LIFECYCLE = ["openCard", "closeCard", "openBackground", "closeBackground"];

function fieldPart(id: string, layerScope: "card" | "background", spec: FieldSpec, y: number): HexFieldPart {
  return {
    id, name: id, type: "field", layerScope, rect: { x: 10, y, width: 200, height: 40 }, visible: spec.visible, enabled: true,
    scriptSource: "", style: "rectangle", content: spec.content, sharedText: layerScope === "background" && spec.sharedText,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "System", textSize: 12, textStyle: [],
  };
}

function buildStack(spec: StackSpec): HexStack {
  const backgrounds: HexBackground[] = spec.backgrounds.map((fields, b) => ({
    id: `bkg_${b}`, name: `B${b}`, bitmap: emptyBitmap, cantDelete: false, scriptSource: "",
    parts: fields.map((field, f) => fieldPart(`prt_b${b}f${f}`, "background", field, 10 + f * 50)),
  }));
  const cards: HexCard[] = spec.cards.map((card, c) => {
    const b = card.bg % backgrounds.length;
    const bgFieldContents: Record<string, string> = {};
    backgrounds[b].parts.forEach((part, f) => {
      const text = card.bgTexts[f];
      if (text !== null && text !== undefined) bgFieldContents[part.id] = text;
    });
    return {
      id: `crd_${c}`, name: `C${c}`, backgroundId: backgrounds[b].id, bitmap: emptyBitmap, bgFieldContents, marked: false,
      cantDelete: false, dontSearch: card.dontSearch, scriptSource: "",
      parts: card.fields.map((field, f) => fieldPart(`prt_c${c}f${f}`, "card", field, 120 + f * 50)),
    };
  });
  return {
    id: "stk_p", schemaVersion: "2.0.0", name: "Property", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds, cards, customIcons: {},
    scriptSource: LIFECYCLE.map((name) => `on ${name}\nend ${name}`).join("\n"),
  };
}

interface RefMatch { cardIndex: number; cardId: string; partId: string; start: number }

/** Brute-force reference of Requirements 4.4-4.6, independent of find.ts. */
function referenceMatches(stack: HexStack, needle: string): RefMatch[] {
  const result: RefMatch[] = [];
  const wanted = needle.toLowerCase();
  stack.cards.forEach((card, cardIndex) => {
    if (card.dontSearch) return;
    const background = stack.backgrounds.find((b) => b.id === card.backgroundId)!;
    const fields: { id: string; text: string }[] = [];
    for (const part of background.parts) {
      if (part.type !== "field" || !part.visible) continue;
      fields.push({ id: part.id, text: part.sharedText ? part.content : card.bgFieldContents[part.id] ?? "" });
    }
    for (const part of card.parts) if (part.type === "field" && part.visible) fields.push({ id: part.id, text: part.content });
    for (const { id, text } of fields) {
      for (let i = 0; i + needle.length <= text.length; i++) {
        const wordStart = i === 0 || !/[\p{L}\p{N}]/u.test(text[i - 1]); // the word list is ASCII only
        if (wordStart && text.slice(i, i + needle.length).toLowerCase() === wanted) result.push({ cardIndex, cardId: card.id, partId: id, start: i });
      }
    }
  });
  return result;
}

async function settle(bus: { isRunning(): boolean; pendingCount(): number }): Promise<void> {
  for (let i = 0; i < 1000 && (bus.isRunning() || bus.pendingCount() > 0); i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("Property 3: Find respects the search rules and cycles", () => {
  it("never goes to a dontSearch card or a hidden field, visits the reference matches in order and wraps around", async () => {
    await fc.assert(
      fc.asyncProperty(stackArb, fc.constantFrom(...NEEDLES), fc.nat(), async (spec, needle, startPick) => {
        const stack = buildStack(spec);
        const store = createHexStore({ stack, compile: parseHexTalk });
        const history = createHistory(store);
        const startCard = stack.cards[startPick % stack.cards.length];
        store.applyRuntime({ type: "goToCard", cardId: startCard.id });

        const lifecycle: string[] = [];
        const runner: HandlerRunner = async (handler) => {
          lifecycle.push(handler.eventName);
          return "handled";
        };
        const errors: unknown[] = [];
        const bus = createMessageBus({
          store, host: {} as HexHost, runHandler: runner, isPageVisible: () => true, isModalOpen: () => false,
          scheduleInterval: () => () => {}, onError: (error) => void errors.push(error), warn: () => {},
        });
        await settle(bus);

        const visitedCards: string[] = [];
        let previousCard = store.getSnapshot().currentCardId;
        const unsubscribe = store.subscribe(() => {
          const now = store.getSnapshot();
          if (now.currentCardId !== previousCard) visitedCards.push(now.currentCardId);
          previousCard = now.currentCardId;
        });

        const sounds: string[] = [];
        const host = { playSound: (voice: string) => void sounds.push(voice) } as unknown as HexHost;
        const raw = `find "${needle}"`;
        const io = { current: raw, line: () => io.current, setLine: (line: string) => void (io.current = line), alert: () => {} };
        const run = createMessageBoxRunner({ store, bus, host, io });

        const reference = referenceMatches(stack, needle);
        const startIndex = stack.cards.indexOf(startCard);
        const first = Math.max(0, reference.findIndex((m) => m.cardIndex >= startIndex));
        const rounds = reference.length + 1;
        const stackBefore = store.getSnapshot().stack;
        const dontSearch = new Set(stack.cards.filter((c) => c.dontSearch).map((c) => c.id));
        const hidden = new Set([...stack.backgrounds.flatMap((b) => b.parts), ...stack.cards.flatMap((c) => c.parts)]
          .filter((p) => !p.visible).map((p) => p.id));

        for (let round = 0; round < rounds; round++) {
          io.current = raw;
          run(raw);
          await settle(bus);
          const state = store.getSnapshot();
          if (reference.length === 0) {
            expect(io.current).toBe(NOT_FOUND);
            expect(state.found).toBeNull();
            expect(state.currentCardId).toBe(startCard.id);
            continue;
          }
          const expected = reference[(first + round) % reference.length];
          expect(state.found).not.toBeNull();
          expect(hidden.has(state.found!.partId)).toBe(false);
          expect([state.found!.cardId, state.found!.partId, state.found!.start, state.found!.end])
            .toEqual([expected.cardId, expected.partId, expected.start, expected.start + needle.length]);
          expect(state.currentCardId).toBe(expected.cardId);
          expect(io.current).toBe(raw);
        }
        unsubscribe();
        bus.dispose();

        expect(errors).toEqual([]);
        for (const cardId of visitedCards) expect(dontSearch.has(cardId)).toBe(false);
        expect(sounds).toEqual(reference.length === 0 ? Array(rounds).fill("click") : []);
        expect(store.getSnapshot().stack).toBe(stackBefore); // Requirement 4.12: no stack change
        expect(history.canUndo()).toBe(false); // and no history entry
      }),
      { numRuns: 100 },
    );
  }, 60_000);
});
