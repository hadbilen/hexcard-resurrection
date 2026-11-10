/**
 * Spec 06 Property 4: Import Image undo restores the layer.
 * **Validates: Requirements 6.7, 6.8, 6.9**
 *
 * For random stacks, either edit layer, a random existing layer (random pixels or "") and a random
 * RGBA image (1-64 pixels per side, any aspect ratio), the import command run through a real
 * store and history changes no pixel outside `importRect`, leaves only states 1 and 2 inside it,
 * restores the target layer's rleData exactly on Undo (every other layer untouched) and yields the
 * same rleData as the first apply on Redo.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createHistory } from "../../../core/history.ts";
import { parseHexTalk } from "../../../core/parser.ts";
import type { HexStack } from "../../../core/schema.ts";
import { createHexStore, type HexLayer } from "../../../core/store.ts";
import { importImageToBitmap, type RgbaImage } from "../atkinsonDither.ts";
import { createImportImageCommand, importRect } from "../imageImport.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, decodeBitmapRLE, encodeBitmapRLE, TOTAL_PIXELS } from "../rleCodec.ts";

const rectArb = fc.record({
  x: fc.integer({ min: 0, max: BITMAP_WIDTH - 1 }),
  y: fc.integer({ min: 0, max: BITMAP_HEIGHT - 1 }),
  width: fc.integer({ min: 1, max: 200 }),
  height: fc.integer({ min: 1, max: 200 }),
  state: fc.constantFrom(0, 1, 2),
});

/** "" or a base fill with a few random rectangles of random states. */
const layerArb = fc.oneof(
  fc.constant(""),
  fc.record({ fill: fc.constantFrom(0, 1, 2), rects: fc.array(rectArb, { maxLength: 4 }) }).map(({ fill, rects }) => {
    const pixels = new Uint8Array(TOTAL_PIXELS).fill(fill);
    for (const r of rects) {
      for (let y = r.y; y < Math.min(BITMAP_HEIGHT, r.y + r.height); y++) {
        pixels.fill(r.state, y * BITMAP_WIDTH + r.x, y * BITMAP_WIDTH + Math.min(BITMAP_WIDTH, r.x + r.width));
      }
    }
    return encodeBitmapRLE(pixels);
  }),
);

/** RGBA pixels from a seeded LCG, with a random share of transparent pixels. */
const imageArb = fc.record({
  width: fc.integer({ min: 1, max: 64 }),
  height: fc.integer({ min: 1, max: 64 }),
  seed: fc.integer({ min: 0, max: 0x7fffffff }),
}).map(({ width, height, seed }): RgbaImage => {
  const data = new Uint8Array(width * height * 4);
  let state = seed >>> 0;
  for (let i = 0; i < data.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    data[i] = state >>> 24;
  }
  return { width, height, data };
});

function makeStack(cardRle: string, backgroundRle: string, otherCardRle: string): HexStack {
  const bitmap = (rleData: string) => ({ width: 512, height: 342, rleData });
  const card = (id: string, rleData: string) => ({
    id, name: id, backgroundId: "bkg_1", bitmap: bitmap(rleData), parts: [], bgFieldContents: {},
    marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
  });
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: bitmap(backgroundRle), parts: [], scriptSource: "", cantDelete: false }],
    cards: [card("crd_1", cardRle), card("crd_2", otherCardRle)],
    customIcons: {}, scriptSource: "",
  };
}

const layerData = (stack: HexStack, layer: HexLayer): string =>
  layer === "card" ? stack.cards[0].bitmap.rleData : stack.backgrounds[0].bitmap.rleData;
const otherLayers = (stack: HexStack, layer: HexLayer): string[] =>
  layer === "card"
    ? [stack.backgrounds[0].bitmap.rleData, stack.cards[1].bitmap.rleData]
    : [stack.cards[0].bitmap.rleData, stack.cards[1].bitmap.rleData];

describe("Property 4: Import Image undo restores the layer", () => {
  it("changes only the image rectangle, writes states 1 and 2, and undoes and redoes exactly on both edit layers", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<HexLayer>("card", "background"),
        layerArb,
        layerArb,
        layerArb,
        imageArb,
        (editLayer, cardRle, backgroundRle, otherCardRle, image) => {
          const store = createHexStore({ stack: makeStack(cardRle, backgroundRle, otherCardRle), compile: parseHexTalk });
          store.setTool("pencil");
          store.setEditLayer(editLayer);
          const history = createHistory(store);
          const emptyFill = editLayer === "card" ? 0 : 1;

          const before = store.getSnapshot().stack;
          const beforeData = layerData(before, editLayer);
          const beforePixels = decodeBitmapRLE(beforeData, emptyFill);
          const rect = importRect(image.width, image.height);
          const imported = importImageToBitmap(image);
          const command = createImportImageCommand(store.getSnapshot(), imported, rect);
          const inRect = (i: number): boolean => {
            const x = i % BITMAP_WIDTH;
            const y = (i - x) / BITMAP_WIDTH;
            return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
          };

          if (command === null) {
            // No-op import: the rectangle already holds exactly the imported pixels.
            for (let i = 0; i < TOTAL_PIXELS; i++) if (inRect(i) && beforePixels[i] !== imported[i]) return false;
            return true;
          }

          history.execute(command);
          expect(history.undoLabel()).toBe("Import Image");
          const applied = store.getSnapshot().stack;
          const appliedData = layerData(applied, editLayer);
          const after = decodeBitmapRLE(appliedData, emptyFill);
          for (let i = 0; i < TOTAL_PIXELS; i++) {
            if (inRect(i)) {
              if (after[i] !== 1 && after[i] !== 2) return false;
            } else if (after[i] !== beforePixels[i]) {
              return false;
            }
          }
          expect(otherLayers(applied, editLayer)).toEqual(otherLayers(before, editLayer));

          expect(history.undo()).toBe(true);
          const undone = store.getSnapshot().stack;
          expect(layerData(undone, editLayer)).toBe(beforeData);
          expect(otherLayers(undone, editLayer)).toEqual(otherLayers(before, editLayer));

          expect(history.redo()).toBe(true);
          expect(layerData(store.getSnapshot().stack, editLayer)).toBe(appliedData);
          return true;
        },
      ),
      { numRuns: 40 },
    );
  }, 120_000);
});
