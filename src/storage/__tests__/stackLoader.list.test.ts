/**
 * Spec 07 task 2: `listStackErrors` (design §stackLoader.ts), Requirements 6.4 and 14.2.
 * `checkStack` is compared with the pre-spec-07 copy in `checkStackOracle.ts`.
 */
import { describe, expect, it } from "vitest";
import type { HexStack } from "../../core/schema.ts";
import { formatGateError } from "../../core/stackValidator.ts";
import { encodeBitmapRLE, TOTAL_PIXELS } from "../../engine/graphics/rleCodec.ts";
import { SHOWCASE_STACKS } from "../../presets/index.ts";
import { checkStack, listStackErrors } from "../stackLoader.ts";
import { checkStack as oracleCheckStack } from "./checkStackOracle.ts";

/** Valid Base64 whose PackBits stream does not give 512 x 342 pixels. */
const BAD_LAYER = "AAAA";
const DARK_LAYER = encodeBitmapRLE(new Uint8Array(TOTAL_PIXELS).fill(2));

function makeStack(): HexStack {
  const bitmap = { width: 512, height: 342, rleData: "" };
  const card = (id: string, backgroundId: string): HexStack["cards"][number] => ({
    id, name: id, backgroundId, bitmap: { ...bitmap }, parts: [], bgFieldContents: {},
    marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
  });
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Test", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      { id: "bkg_1", name: "A", bitmap: { ...bitmap }, parts: [], scriptSource: "", cantDelete: false },
      { id: "bkg_2", name: "B", bitmap: { ...bitmap }, parts: [], scriptSource: "", cantDelete: false },
    ],
    cards: [card("crd_1", "bkg_1"), card("crd_2", "bkg_2")],
    customIcons: {},
    scriptSource: "",
  };
}

const formatted = (input: unknown): string[] => listStackErrors(input).errors.map((e) => formatGateError(e));
const decodeMessage = (): string => {
  const checked = oracleCheckStack({ ...makeStack(), cards: [{ ...makeStack().cards[0], bitmap: { width: 512, height: 342, rleData: BAD_LAYER } }], backgrounds: [makeStack().backgrounds[0]] });
  if (checked.ok) throw new Error("BAD_LAYER decodes");
  return checked.error.slice("cards[0].bitmap.rleData: ".length);
};

describe("listStackErrors (Requirement 6.4)", () => {
  it("accepts a valid stack and returns the parsed stack", () => {
    const stack = makeStack();
    stack.backgrounds[1].bitmap.rleData = DARK_LAYER;
    expect(listStackErrors(stack)).toEqual({ errors: [], stack });
  });

  it("lists every undecodable layer, backgrounds before cards, as one fixed message piece", () => {
    const stack = makeStack();
    stack.cards[0].bitmap.rleData = BAD_LAYER;
    stack.cards[1].bitmap.rleData = BAD_LAYER;
    stack.backgrounds[1].bitmap.rleData = BAD_LAYER;
    const report = listStackErrors(stack);
    const message = decodeMessage();
    expect(report.errors).toEqual([
      { path: ["backgrounds", 1, "bitmap", "rleData"], message: [message] },
      { path: ["cards", 0, "bitmap", "rleData"], message: [message] },
      { path: ["cards", 1, "bitmap", "rleData"], message: [message] },
    ]);
    expect(report.stack).not.toBeNull();
  });

  it("puts the layer errors after the validation errors", () => {
    const stack = makeStack();
    stack.backgrounds[0].bitmap.rleData = BAD_LAYER;
    stack.cards[1].backgroundId = "bkg_9";
    expect(formatted(stack)).toEqual([
      'cards[1].backgroundId: references missing background "bkg_9"',
      `backgrounds[0].bitmap.rleData: ${decodeMessage()}`,
    ]);
  });

  it("decodes no layer when the schema reports an issue", () => {
    const stack: any = makeStack();
    stack.backgrounds[0].bitmap.rleData = BAD_LAYER;
    stack.name = 3;
    const report = listStackErrors(stack);
    expect(report.errors.map((e) => e.path)).toEqual([["name"]]);
    expect(report.stack).toBeNull();
  });
});

describe("checkStack is unchanged (Requirement 14.2)", () => {
  const changed = (change: (s: any) => void): unknown => {
    const s: any = JSON.parse(JSON.stringify(makeStack()));
    change(s);
    return s;
  };
  const corpus: Array<[string, unknown]> = [
    ["valid", makeStack()],
    ["null", null],
    ["wrong version", changed((s) => { s.schemaVersion = "3"; })],
    ["schema issue", changed((s) => { s.cards = []; })],
    ["structural and layer", changed((s) => { s.cards[0].backgroundId = "x"; s.cards[0].bitmap.rleData = BAD_LAYER; })],
    ["background layer", changed((s) => { s.backgrounds[1].bitmap.rleData = BAD_LAYER; })],
    ["card layer", changed((s) => { s.cards[1].bitmap.rleData = BAD_LAYER; })],
    ["both layers", changed((s) => { s.cards[0].bitmap.rleData = BAD_LAYER; s.backgrounds[1].bitmap.rleData = "!!"; })],
    ["dark layer", changed((s) => { s.cards[0].bitmap.rleData = DARK_LAYER; })],
    ...SHOWCASE_STACKS.map((entry): [string, unknown] => [entry.id, entry.create()]),
  ];

  it.each(corpus)("returns the same value as before spec 07: %s", (_name, input) => {
    expect(checkStack(input)).toEqual(oracleCheckStack(input));
  });
});
