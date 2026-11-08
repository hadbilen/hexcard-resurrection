import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  canDeleteCard,
  createDeleteCardCommand,
  createDeletePartCommand,
  createNewBackgroundCommand,
  createNewCardCommand,
  createNewPartCommand,
  type RandomSource,
} from "../authoringCommands.ts";
import { createHistory } from "../history.ts";
import type { HexBackground, HexCard, HexFieldPart, HexStack } from "../schema.ts";
import { validateStack } from "../stackValidator.ts";
import { createHexStore, resolveEditTarget, type CompiledScript } from "../store.ts";
import { SHOWCASE_STACKS } from "../../presets/index.ts";
import { createStarterStack } from "../../ui/starterStack.ts";

const ACTIONS = [
  "newCard", "deleteCard", "newBackground", "newButton", "newField", "deletePart", "toggleEditBackground", "undo", "redo",
] as const;
type ActionKind = (typeof ACTIONS)[number];

interface Action {
  kind: ActionKind;
  pick: number;
}

const compile = (): CompiledScript => ({ ast: { handlers: {} }, errors: [] });
const bitmap = () => ({ width: 512, height: 342, rleData: "" });

/** Small deterministic generator so a failing run replays from the fast-check seed. */
function mulberry32(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bgField(id: string): HexFieldPart {
  return {
    id, name: "Notes", type: "field", layerScope: "background", rect: { x: 8, y: 8, width: 80, height: 20 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "Sans", textSize: 12, textStyle: [],
  };
}

interface StackShape {
  backgroundCount: number;
  cardCount: number;
  cantDeleteBackgrounds: boolean[];
  cantDeleteCards: boolean[];
  backgroundFields: boolean[];
}

/** 1-4 cards on 1-3 backgrounds (every background has a card), some with cantDelete and a background field. */
const generatedStack: fc.Arbitrary<HexStack> = fc
  .record({
    cardCount: fc.integer({ min: 1, max: 4 }),
    backgroundWish: fc.integer({ min: 1, max: 3 }),
    cantDeleteBackgrounds: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
    cantDeleteCards: fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }),
    backgroundFields: fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
  })
  .map(({ backgroundWish, ...rest }): StackShape => ({ ...rest, backgroundCount: Math.min(backgroundWish, rest.cardCount) }))
  .map((shape) => {
    const backgrounds: HexBackground[] = Array.from({ length: shape.backgroundCount }, (_, i) => ({
      id: `bkg_g${i}`, name: `Background ${i + 1}`, bitmap: bitmap(),
      parts: shape.backgroundFields[i] ? [bgField(`prt_bf${i}`)] : [],
      scriptSource: "", cantDelete: shape.cantDeleteBackgrounds[i],
    }));
    const cards: HexCard[] = Array.from({ length: shape.cardCount }, (_, i) => {
      const backgroundIndex = i % shape.backgroundCount;
      return {
        id: `crd_g${i}`, name: `Card ${i + 1}`, backgroundId: backgrounds[backgroundIndex].id, bitmap: bitmap(),
        parts: [], bgFieldContents: shape.backgroundFields[backgroundIndex] ? { [`prt_bf${backgroundIndex}`]: `text ${i}` } : {},
        marked: false, cantDelete: shape.cantDeleteCards[i], dontSearch: false, scriptSource: "",
      };
    });
    return {
      id: "stk_gen", schemaVersion: "2.0.0", name: "Generated", author: "",
      createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      dimensions: { width: 512, height: 342 },
      themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
      backgrounds, cards, customIcons: {}, scriptSource: "",
    } satisfies HexStack;
  });

const initialStacks: fc.Arbitrary<HexStack> = fc.oneof(
  { weight: 4, arbitrary: generatedStack },
  { weight: 1, arbitrary: fc.constant(null).map(() => createStarterStack()) },
  ...SHOWCASE_STACKS.map((entry) => ({ weight: 1, arbitrary: fc.constant(null).map(() => entry.create()) })),
);

const actions: fc.Arbitrary<Action[]> = fc.array(
  fc.record({ kind: fc.constantFrom(...ACTIONS), pick: fc.nat(1000) }),
  { maxLength: 50 },
);

describe("structural commands: random action sequences", () => {
  it("keep the stack valid, and full undo restores the original stack and current card", () => {
    // **Validates: Requirements 15.2, 13.2, 13.3, 14.3**
    fc.assert(
      fc.property(initialStacks, actions, fc.nat(), (initial, sequence, seed) => {
        const random = mulberry32(seed);
        expect(validateStack(initial).ok).toBe(true);
        const store = createHexStore({ stack: initial, compile });
        const history = createHistory(store);
        const originalStack = store.getSnapshot().stack;
        const originalCardId = store.getSnapshot().currentCardId;

        for (const { kind, pick } of sequence) {
          const state = store.getSnapshot();
          switch (kind) {
            case "newCard":
              history.execute(createNewCardCommand(state.stack, state.currentCardId, random));
              break;
            case "newBackground":
              history.execute(createNewBackgroundCommand(state.stack, state.currentCardId, random));
              break;
            case "deleteCard":
              if (canDeleteCard(state.stack, state.currentCardId)) {
                history.execute(createDeleteCardCommand(state.stack, state.currentCardId));
              }
              break;
            case "newButton":
            case "newField": {
              const type = kind === "newButton" ? "button" : "field";
              const command = createNewPartCommand(state, type, random);
              history.execute(command);
              store.setTool(type);
              store.setSelectedPart(command.partId);
              break;
            }
            case "deletePart": {
              const { owner } = resolveEditTarget(state);
              if (owner.parts.length === 0) break;
              const part = owner.parts[pick % owner.parts.length];
              store.setTool(part.type);
              store.setSelectedPart(part.id);
              history.execute(createDeletePartCommand(store.getSnapshot(), part.id));
              expect(store.getSnapshot().selectedPartId).toBeNull();
              break;
            }
            case "toggleEditBackground":
              store.setEditLayer(state.editLayer === "card" ? "background" : "card");
              break;
            case "undo":
              if (history.canUndo()) history.undo();
              break;
            case "redo":
              if (history.canRedo()) history.redo();
              break;
          }

          const after = store.getSnapshot();
          const result = validateStack(after.stack);
          expect(result.ok, result.ok ? "" : result.error).toBe(true);
          expect(after.stack.cards.length).toBeGreaterThanOrEqual(1);
          expect(after.stack.cards.some((card) => card.id === after.currentCardId)).toBe(true);
        }

        while (history.canUndo()) history.undo();
        expect(store.getSnapshot().stack).toEqual(originalStack);
        expect(store.getSnapshot().currentCardId).toBe(originalCardId);
      }),
      { numRuns: 100 },
    );
  });
});
