/**
 * Spec 06 task 4.2: Find matching and search order (Requirements 4.4-4.6).
 */
import { describe, expect, it } from "vitest";
import { findNext, isWordStart, matchStarts, searchableFields } from "../find.ts";
import type { HexCard, HexFieldPart, HexStack } from "../schema.ts";
import type { FoundText } from "../store.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function field(id: string, overrides: Partial<HexFieldPart> = {}): HexFieldPart {
  return {
    id, name: id, type: "field", layerScope: "card", rect: { x: 10, y: 40, width: 200, height: 100 }, visible: true, enabled: true,
    scriptSource: "", style: "rectangle", content: "", sharedText: false, lockText: false, dontWrap: false, showLines: false,
    textAlign: "left", textFont: "System", textSize: 12, textStyle: [], ...overrides,
  };
}

function card(id: string, parts: HexFieldPart[], overrides: Partial<HexCard> = {}): HexCard {
  return {
    id, name: id, backgroundId: "bkg_1", bitmap: emptyBitmap, parts, bgFieldContents: {}, marked: false, cantDelete: false,
    dontSearch: false, scriptSource: "", ...overrides,
  };
}

function stackOf(cards: HexCard[], backgroundParts: HexFieldPart[] = []): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: emptyBitmap, parts: backgroundParts, scriptSource: "", cantDelete: false }],
    cards, customIcons: {}, scriptSource: "",
  };
}

const foundAt = (stack: HexStack, m: { cardId: string; layer: "card" | "background"; partId: string; start: number; end: number }): FoundText => {
  const fields = searchableFields(stack, stack.cards.find((c) => c.id === m.cardId)!);
  return { ...m, text: fields.find((f) => f.part.id === m.partId && f.layer === m.layer)!.text };
};

describe("isWordStart and matchStarts (Requirement 4.5)", () => {
  it("matches only at word starts", () => {
    expect(matchStarts("lamp", "lamp")).toEqual([0]);
    expect(matchStarts("a lamp, the lamplight; oil-lamp", "lamp")).toEqual([2, 12, 27]);
    expect(matchStarts("clamp blamp", "lamp")).toEqual([]);
    expect(matchStarts("x9lamp 9 lamp_lamp", "lamp")).toEqual([9, 14]); // "_" is neither a letter nor a digit
    expect(matchStarts("anything", "")).toEqual([]);
    expect(matchStarts("lam", "lamp")).toEqual([]);
  });

  it("folds case without a locale", () => {
    expect(matchStarts("LAMP Lamp lamp", "lAmP")).toEqual([0, 5, 10]);
    expect(matchStarts("ÉCLAIR éclair", "éclair")).toEqual([0, 7]);
  });

  it("treats Unicode letters and digits as word characters", () => {
    expect(matchStarts("élamp ölamp ١lamp", "lamp")).toEqual([]); // Latin letters and an Arabic-Indic digit
    expect(matchStarts("日lamp", "lamp")).toEqual([]);
    expect(matchStarts("«lamp» —lamp", "lamp")).toEqual([1, 8]);
  });

  it("reads the code point before the index across surrogate pairs", () => {
    // U+1D400 MATHEMATICAL BOLD CAPITAL A is a letter; U+1F600 is an emoji (not a letter or digit).
    expect(matchStarts("\u{1D400}lamp", "lamp")).toEqual([]);
    expect(matchStarts("\u{1F600}lamp", "lamp")).toEqual([2]);
    expect(isWordStart("\u{1F600}x", 1)).toBe(false); // between the two halves of one pair
    expect(isWordStart("\u{1F600}x", 2)).toBe(true);
    expect(isWordStart("\u{1D400}x", 2)).toBe(false);
    expect(isWordStart("ab", 0)).toBe(true);
  });

  it("allows at most one match per word for repeated letters", () => {
    expect(matchStarts("aaa aa", "aa")).toEqual([0, 4]);
  });
});

describe("searchableFields (Requirement 4.4)", () => {
  it("lists visible background fields in background order, then visible card fields; none on a dontSearch card", () => {
    const shared = field("prt_bs", { layerScope: "background", sharedText: true, content: "shared" });
    const unshared = field("prt_bu", { layerScope: "background", sharedText: false, content: "ignored" });
    const hiddenBg = field("prt_bh", { layerScope: "background", visible: false, content: "hidden" });
    const c = card("crd_1", [field("prt_c2", { content: "two" }), field("prt_ch", { visible: false, content: "x" }), field("prt_c1", { content: "one" })], {
      bgFieldContents: { prt_bu: "own" },
    });
    const stack = stackOf([c, card("crd_2", [], { dontSearch: true })], [unshared, hiddenBg, shared]);
    expect(searchableFields(stack, c).map((f) => [f.layer, f.part.id, f.text])).toEqual([
      ["background", "prt_bu", "own"],
      ["background", "prt_bs", "shared"],
      ["card", "prt_c2", "two"],
      ["card", "prt_c1", "one"],
    ]);
    expect(searchableFields(stack, stack.cards[1])).toEqual([]);
    // An unshared background field without an entry reads "".
    expect(searchableFields(stackOf([card("crd_3", [])], [unshared]), card("crd_3", []))[0].text).toBe("");
  });
});

describe("findNext (Requirements 4.4-4.6)", () => {
  it("starts at the current card and wraps around to the first match", () => {
    const stack = stackOf([
      card("crd_1", [field("prt_1", { content: "lamp" })]),
      card("crd_2", [field("prt_2", { content: "nothing" })]),
      card("crd_3", [field("prt_3", { content: "old lamp" })]),
    ]);
    expect(findNext(stack, "crd_1", null, "lamp")).toEqual({ cardId: "crd_1", layer: "card", partId: "prt_1", start: 0, end: 4 });
    expect(findNext(stack, "crd_2", null, "lamp")).toMatchObject({ cardId: "crd_3", start: 4 });
    const third = findNext(stack, "crd_3", null, "lamp")!;
    expect(third).toMatchObject({ cardId: "crd_3" });
    expect(findNext(stack, "crd_3", foundAt(stack, third), "lamp")).toMatchObject({ cardId: "crd_1" });
    expect(findNext(stack, "crd_1", null, "zzz")).toBeNull();
    expect(findNext(stack, "crd_1", null, "")).toBeNull();
  });

  it("orders by card, then field order, then start index, strictly after the found text", () => {
    const bg = field("prt_bg", { layerScope: "background", sharedText: true, content: "key" });
    const stack = stackOf([card("crd_1", [field("prt_a", { content: "key key" }), field("prt_b", { content: "key" })])], [bg]);
    const visits: string[] = [];
    let found: FoundText | null = null;
    for (let i = 0; i < 5; i++) {
      const match = findNext(stack, "crd_1", found, "key")!;
      visits.push(`${match.partId}@${match.start}`);
      found = foundAt(stack, match);
    }
    expect(visits).toEqual(["prt_bg@0", "prt_a@0", "prt_a@4", "prt_b@0", "prt_bg@0"]);
  });

  it("skips dontSearch cards, the current one included, and hidden fields", () => {
    const stack = stackOf([
      card("crd_1", [field("prt_1", { content: "lamp" })], { dontSearch: true }),
      card("crd_2", [field("prt_2", { content: "lamp", visible: false }), field("prt_3", { content: "lamp" })]),
    ]);
    expect(findNext(stack, "crd_1", null, "lamp")).toMatchObject({ cardId: "crd_2", partId: "prt_3" });
    expect(findNext(stackOf([card("crd_1", [field("prt_1", { content: "lamp" })], { dontSearch: true })]), "crd_1", null, "lamp")).toBeNull();
  });

  it("searches shared background text once per card and unshared text per card", () => {
    const shared = field("prt_s", { layerScope: "background", sharedText: true, content: "lamp" });
    const unshared = field("prt_u", { layerScope: "background", sharedText: false });
    const stack = stackOf([
      card("crd_1", []),
      card("crd_2", [], { bgFieldContents: { prt_u: "lamp" } }),
    ], [unshared, shared]);
    const order: string[] = [];
    let found: FoundText | null = null;
    for (let i = 0; i < 4; i++) {
      const match = findNext(stack, "crd_1", found, "lamp")!;
      order.push(`${match.cardId}:${match.partId}`);
      found = foundAt(stack, match);
    }
    expect(order).toEqual(["crd_1:prt_s", "crd_2:prt_u", "crd_2:prt_s", "crd_1:prt_s"]);
  });

  it("treats a found text whose field is no longer searchable as no found text", () => {
    const stack = stackOf([card("crd_1", [field("prt_1", { content: "lamp lamp" })])]);
    const stale: FoundText = { cardId: "crd_1", layer: "card", partId: "prt_gone", start: 5, end: 9, text: "lamp lamp" };
    expect(findNext(stack, "crd_1", stale, "lamp")).toMatchObject({ partId: "prt_1", start: 0 });
  });
});
