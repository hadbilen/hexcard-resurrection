import { describe, expect, it } from "vitest";
import type { HexButtonPart, HexFieldPart, HexStack } from "../schema.ts";
import { validateStack } from "../stackValidator.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function makeButton(overrides: Partial<HexButtonPart> = {}): HexButtonPart {
  return {
    id: "prt_btn",
    name: "Next",
    type: "button",
    layerScope: "card",
    rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true,
    enabled: true,
    scriptSource: "on mouseUp\n  go next card\nend mouseUp",
    style: "roundRect",
    title: "Next",
    showName: true,
    autoHilite: true,
    hilite: false,
    ...overrides,
  };
}

function makeField(overrides: Partial<HexFieldPart> = {}): HexFieldPart {
  return {
    id: "prt_fld",
    name: "Notes",
    type: "field",
    layerScope: "background",
    rect: { x: 10, y: 40, width: 200, height: 100 },
    visible: true,
    enabled: true,
    scriptSource: "",
    style: "scrolling",
    content: "",
    sharedText: false,
    lockText: false,
    dontWrap: false,
    showLines: true,
    textAlign: "left",
    textFont: "System",
    textSize: 12,
    textStyle: ["bold"],
    ...overrides,
  };
}

function makeStack(): HexStack {
  return {
    id: "stk_1",
    schemaVersion: "2.0.0",
    name: "Test Stack",
    author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      {
        id: "bkg_1",
        name: "Main",
        bitmap: emptyBitmap,
        parts: [makeField()],
        scriptSource: "",
        cantDelete: false,
      },
    ],
    cards: [
      {
        id: "crd_1",
        name: "First",
        backgroundId: "bkg_1",
        bitmap: emptyBitmap,
        parts: [makeButton({ iconId: "ico_1", family: 3, naturalLanguagePrompt: "go next" })],
        bgFieldContents: { prt_fld: "Hello" },
        marked: false,
        cantDelete: false,
        dontSearch: false,
        scriptSource: "",
      },
      {
        id: "crd_2",
        name: "Second",
        backgroundId: "bkg_1",
        bitmap: emptyBitmap,
        parts: [],
        bgFieldContents: {},
        marked: true,
        cantDelete: false,
        dontSearch: true,
        scriptSource: "",
      },
    ],
    customIcons: { ico_1: "AAAA" },
    scriptSource: "on openStack\nend openStack",
  };
}

/** Recursively freezes a value so any mutation attempt throws (ES modules run in strict mode). */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function expectRejected(input: unknown, errorPattern: RegExp): void {
  const result = validateStack(input);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toMatch(errorPattern);
}

describe("validateStack: valid stacks (Requirement 6.1)", () => {
  it("accepts a well-formed stack and returns a deep-equal copy", () => {
    const input = makeStack();
    const result = validateStack(input);
    expect(result).toEqual({ ok: true, stack: input });
  });

  it("accepts lowercase hex palette colours and negative part x/y (Requirement 6.7)", () => {
    const input = makeStack();
    input.themePalette = { name: "AmberCRT", darkBitHex: "#1a1000", lightBitHex: "#ffB000" };
    input.cards[0].parts[0].rect = { x: -5, y: -12, width: 0, height: 0 };
    expect(validateStack(input)).toEqual({ ok: true, stack: input });
  });

  it("returns a stack that shares no objects with the input", () => {
    const input = makeStack();
    const result = validateStack(input);
    if (!result.ok) throw new Error(result.error);
    expect(result.stack).not.toBe(input);
    expect(result.stack.cards).not.toBe(input.cards);
    expect(result.stack.cards[0].parts[0]).not.toBe(input.cards[0].parts[0]);
    expect(result.stack.backgrounds[0]).not.toBe(input.backgrounds[0]);
  });
});

describe("validateStack: rejection reasons (Requirements 6.2, 6.3)", () => {
  it.each([
    ["1.0.0"],
    ["2.0"],
    [2],
    [undefined],
  ])("rejects schemaVersion %j", (version) => {
    const input = { ...makeStack(), schemaVersion: version };
    expectRejected(input, /^schemaVersion: unsupported schema version .*expected "2\.0\.0"$/);
  });

  it("reports the schema version before any other error", () => {
    const input = { schemaVersion: "1.0.0", cards: "not an array" };
    expectRejected(input, /^schemaVersion: /);
  });

  it("rejects a card that references a missing background", () => {
    const input = makeStack();
    input.cards[1].backgroundId = "bkg_missing";
    expectRejected(input, /^cards\[1\]\.backgroundId: references missing background "bkg_missing"$/);
  });

  it("rejects a card part whose layerScope is background", () => {
    const input = makeStack();
    input.cards[0].parts[0].layerScope = "background";
    expectRejected(input, /^cards\[0\]\.parts\[0\]\.layerScope: expected "card" but got "background"$/);
  });

  it("rejects a background part whose layerScope is card", () => {
    const input = makeStack();
    input.backgrounds[0].parts[0].layerScope = "card";
    expectRejected(input, /^backgrounds\[0\]\.parts\[0\]\.layerScope: expected "background" but got "card"$/);
  });

  it.each([
    ["null", null],
    ["a string", "{}"],
    ["an array", []],
  ])("rejects %s as the stack root", (_label, input) => {
    expectRejected(input, /^stack: /);
  });

  it("rejects a structurally invalid field and reports only the first error with its path", () => {
    const input = makeStack() as unknown as { cards: Array<{ marked: unknown; name: unknown }> };
    input.cards[1].marked = "yes";
    input.cards[1].name = 42;
    const result = validateStack(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^cards\[1\]\.(name|marked): /);
      expect(result.error).not.toContain("\n");
    }
  });

  it("rejects a part type other than button or field", () => {
    const input = makeStack() as unknown as { cards: Array<{ parts: Array<{ type: string }> }> };
    input.cards[0].parts[0].type = "slider";
    expectRejected(input, /^cards\[0\]\.parts\[0\]\.type: /);
  });

  it("rejects a persisted AST or any other unknown key (Requirement 4.5)", () => {
    const withCardAst = makeStack();
    Object.assign(withCardAst.cards[0], { ast: { type: "Script", handlers: [] } });
    expectRejected(withCardAst, /^cards\[0\]: .*ast/);

    const withPartAst = makeStack();
    Object.assign(withPartAst.cards[0].parts[0], { compiledAst: {} });
    expectRejected(withPartAst, /compiledAst/);
  });

  it("rejects an out-of-range radio button family", () => {
    const input = makeStack();
    input.cards[0].parts[0] = makeButton({ family: 16 });
    expectRejected(input, /^cards\[0\]\.parts\[0\]\.family: /);
  });
});

describe("validateStack: empty stacks (Requirement 6.4)", () => {
  it("rejects a stack with no cards", () => {
    const input = { ...makeStack(), cards: [] };
    expectRejected(input, /^cards: must contain at least one card$/);
  });

  it("rejects a stack with no backgrounds", () => {
    const input = { ...makeStack(), backgrounds: [] };
    expectRejected(input, /^backgrounds: must contain at least one background$/);
  });
});

describe("validateStack: duplicate ids (Requirement 6.5)", () => {
  it("rejects two cards with the same id, reporting the second occurrence", () => {
    const input = makeStack();
    input.cards[1].id = "crd_1";
    expectRejected(input, /^cards\[1\]\.id: duplicate id "crd_1"$/);
  });

  it("rejects the same part id on a background and a card", () => {
    const input = makeStack();
    input.cards[0].parts[0].id = "prt_fld";
    expectRejected(input, /^cards\[0\]\.parts\[0\]\.id: duplicate id "prt_fld"$/);
  });

  it("rejects a card id equal to a part id", () => {
    const input = makeStack();
    input.cards[1].id = "prt_btn";
    input.cards[1].parts = [];
    expectRejected(input, /^cards\[1\]\.id: duplicate id "prt_btn"$/);
  });

  it("rejects a background id equal to the stack id", () => {
    const input = makeStack();
    input.backgrounds[0].id = "stk_1";
    for (const card of input.cards) card.backgroundId = "stk_1";
    expectRejected(input, /^backgrounds\[0\]\.id: duplicate id "stk_1"$/);
  });
});

describe("validateStack: fixed 512x342 size (Requirement 6.6)", () => {
  it("rejects stack dimensions other than 512 wide", () => {
    const input = makeStack();
    input.dimensions = { width: 640, height: 342 };
    expectRejected(input, /^dimensions\.width: expected 512 \(the only width supported in schema 2\.0\.0\)$/);
  });

  it("rejects stack dimensions other than 342 high", () => {
    const input = makeStack();
    input.dimensions = { width: 512, height: 480 };
    expectRejected(input, /^dimensions\.height: expected 342 \(the only height supported in schema 2\.0\.0\)$/);
  });

  it("rejects a background bitmap of the wrong width", () => {
    const input = makeStack();
    input.backgrounds[0].bitmap = { ...emptyBitmap, width: 256 };
    expectRejected(input, /^backgrounds\[0\]\.bitmap\.width: expected 512 /);
  });

  it("rejects a card bitmap of the wrong height", () => {
    const input = makeStack();
    input.cards[1].bitmap = { ...emptyBitmap, height: 341 };
    expectRejected(input, /^cards\[1\]\.bitmap\.height: expected 342 /);
  });
});

describe("validateStack: palette colours and part rects (Requirement 6.7)", () => {
  it.each([
    ["darkBitHex", "#00000"],
    ["darkBitHex", "000000"],
    ["lightBitHex", "#FFFFFG"],
    ["lightBitHex", "#FFF"],
    ["lightBitHex", "white"],
  ] as const)("rejects themePalette.%s %j", (key, colour) => {
    const input = makeStack();
    input.themePalette = { ...input.themePalette, [key]: colour };
    expectRejected(input, new RegExp(`^themePalette\\.${key}: expected a #RRGGBB hex colour$`));
  });

  it.each([["x"], ["y"], ["width"], ["height"]] as const)("rejects a non-integer rect.%s", (key) => {
    const input = makeStack();
    const part = input.cards[0].parts[0];
    part.rect = { ...part.rect, [key]: 10.5 };
    expectRejected(input, new RegExp(`^cards\\[0\\]\\.parts\\[0\\]\\.rect\\.${key}: expected an integer$`));
  });

  it.each([["width"], ["height"]] as const)("rejects a negative rect.%s", (key) => {
    const input = makeStack();
    const part = input.backgrounds[0].parts[0];
    part.rect = { ...part.rect, [key]: -1 };
    expectRejected(input, new RegExp(`^backgrounds\\[0\\]\\.parts\\[0\\]\\.rect\\.${key}: expected a non-negative integer$`));
  });
});

describe("validateStack: rejection leaves the current stack unchanged (Requirement 6.2)", () => {
  // Minimal load gate in the shape the store will use: only a validated stack replaces the current one.
  function load(current: HexStack, input: unknown): { stack: HexStack; error?: string } {
    const result = validateStack(input);
    return result.ok ? { stack: result.stack } : { stack: current, error: result.error };
  }

  it("keeps the current stack and never mutates the rejected input", () => {
    const current = deepFreeze(makeStack());
    const currentSnapshot = structuredClone(current);

    const bad = makeStack();
    bad.cards[0].backgroundId = "bkg_missing";
    deepFreeze(bad);
    const badSnapshot = structuredClone(bad);

    const outcome = load(current, bad);
    expect(outcome.stack).toBe(current);
    expect(outcome.error).toMatch(/backgroundId/);
    expect(current).toEqual(currentSnapshot);
    expect(bad).toEqual(badSnapshot);
  });

  it("returns no stack on failure", () => {
    const result = validateStack({ ...makeStack(), schemaVersion: "1.0.0" });
    expect(result).not.toHaveProperty("stack");
  });

  it("does not mutate a valid input either", () => {
    const input = deepFreeze(makeStack());
    expect(() => validateStack(input)).not.toThrow();
    expect(validateStack(input).ok).toBe(true);
  });
});
