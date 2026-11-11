/**
 * Spec 07 task 2: `listStackValidationErrors` and `formatGateError` (design §stackValidator.ts),
 * Requirements 6.4 and 14.2. `validateStack` is compared with the pre-spec-07 copy in
 * `stackValidatorOracle.ts`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { SHOWCASE_STACKS } from "../../presets/index.ts";
import { BLANK_ICON } from "../icons.ts";
import type { HexButtonPart, HexFieldPart, HexStack } from "../schema.ts";
import {
  formatGateError,
  listStackValidationErrors,
  validateStack,
  type GateError,
} from "../stackValidator.ts";
import { validateStack as oracleValidateStack } from "./stackValidatorOracle.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function button(id: string, extra: Partial<HexButtonPart> = {}): HexButtonPart {
  return {
    id, name: "B", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true, enabled: true, scriptSource: "", style: "roundRect", title: "Go", showName: true,
    autoHilite: true, hilite: false, ...extra,
  };
}

function field(id: string, extra: Partial<HexFieldPart> = {}): HexFieldPart {
  return {
    id, name: "F", type: "field", layerScope: "background", rect: { x: 10, y: 40, width: 200, height: 100 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "System", textSize: 12,
    textStyle: [], ...extra,
  };
}

function makeStack(): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Test", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [
      { id: "bkg_1", name: "Main", bitmap: emptyBitmap, parts: [field("prt_f1")], scriptSource: "", cantDelete: false },
      { id: "bkg_2", name: "Other", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false },
    ],
    cards: [
      {
        id: "crd_1", name: "One", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [button("prt_b1", { iconId: "ico_1" })],
        bgFieldContents: { prt_f1: "Hello" }, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
      {
        id: "crd_2", name: "Two", backgroundId: "bkg_2", bitmap: emptyBitmap, parts: [button("prt_b2")],
        bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
    ],
    customIcons: { ico_1: BLANK_ICON },
    scriptSource: "",
  };
}

/** A JSON round trip gives a plain, independent value that the test may change freely. */
const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));
const formatted = (errors: readonly GateError[]): string[] => errors.map((e) => formatGateError(e));

describe("listStackValidationErrors: error kinds (Requirement 6.4)", () => {
  it("accepts a valid stack with no errors and returns the parsed stack", () => {
    const report = listStackValidationErrors(makeStack());
    expect(report.errors).toEqual([]);
    expect(report.stack).toEqual(makeStack());
  });

  it("reports an unsupported string schemaVersion alone, its value as a fromValue piece", () => {
    const input = { ...clone(makeStack()), schemaVersion: "1.0.0", name: 5 };
    expect(listStackValidationErrors(input)).toEqual({
      errors: [{ path: ["schemaVersion"], message: ['unsupported schema version "', { fromValue: "1.0.0" }, '", expected "2.0.0"'] }],
      stack: null,
    });
  });

  it("shows a missing or non-string schemaVersion with String(version)", () => {
    const { schemaVersion: _omit, ...rest } = clone(makeStack());
    expect(listStackValidationErrors(rest).errors).toEqual([
      { path: ["schemaVersion"], message: ["unsupported schema version ", { fromValue: "undefined" }, ', expected "2.0.0"'] },
    ]);
    expect(formatted(listStackValidationErrors({ ...rest, schemaVersion: 2 }).errors))
      .toEqual(['schemaVersion: unsupported schema version 2, expected "2.0.0"']);
  });

  it("reports a __proto__ icon key first, then every schema issue", () => {
    const text = JSON.stringify(makeStack()).replace('"customIcons":{', `"customIcons":{"__proto__":"${BLANK_ICON}",`);
    const input = JSON.parse(text);
    input.name = 7;
    const report = listStackValidationErrors(input);
    expect(formatted(report.errors)[0]).toMatch(/^customIcons\.__proto__: expected an icon name/);
    expect(report.errors[1].path).toEqual(["name"]);
    expect(report.errors).toHaveLength(2);
    expect(report.stack).toBeNull();
  });

  it("keeps the parsed stack when only the __proto__ error is found, and still runs the structural checks", () => {
    const text = JSON.stringify(makeStack()).replace('"customIcons":{', `"customIcons":{"__proto__":"${BLANK_ICON}",`);
    const input = JSON.parse(text);
    input.cards[1].backgroundId = "bkg_missing";
    const report = listStackValidationErrors(input);
    expect(formatted(report.errors)).toEqual([
      expect.stringMatching(/^customIcons\.__proto__: /),
      'cards[1].backgroundId: references missing background "bkg_missing"',
    ]);
    expect(report.stack).not.toBeNull();
  });

  it("lists every schema issue in Zod's order, with the stack null", () => {
    const input = clone(makeStack());
    input.cards[0].parts[0].rect.width = -1;
    input.cards[1].parts[0].rect.x = 1.5;
    input.themePalette.darkBitHex = "black";
    const report = listStackValidationErrors(input);
    expect(formatted(report.errors)).toEqual([
      "themePalette.darkBitHex: expected a #RRGGBB hex colour",
      "cards[0].parts[0].rect.width: expected a non-negative integer",
      "cards[1].parts[0].rect.x: expected an integer",
    ]);
    expect(report.stack).toBeNull();
  });

  it("splits an unrecognized_keys message at each key", () => {
    const input = clone(makeStack());
    input.cards[0].ast = {};
    input.cards[0]['we"ird'] = 1;
    const [error] = listStackValidationErrors(input).errors;
    expect(error).toEqual({
      path: ["cards", 0],
      message: ['Unrecognized keys: "', { fromValue: "ast" }, '", "', { fromValue: 'we"ird' }, '"'],
    });
    expect(formatGateError(error)).toBe(`cards[0]: Unrecognized keys: "ast", "we"ird"`);
  });

  it("writes the other issue messages of this schema without text of the value", () => {
    const S = "ZZSENTINEL";
    const input = clone(makeStack());
    Object.assign(input, { name: { [S]: S }, author: [S] });
    input.themePalette.name = S;
    input.themePalette.lightBitHex = S;
    input.backgrounds[0].parts[0].textFont = S;
    input.backgrounds[0].parts[0].textSize = S;
    input.backgrounds[0].parts[0].textStyle = [S];
    input.backgrounds[0].bitmap.width = S;
    input.cards[0].parts[0].type = S;
    input.cards[1].parts[0].style = S;
    input.cards[1].parts[0].family = S;
    input.cards[1].bgFieldContents = { a: { [S]: S } };
    input.customIcons = { [` ${S}`]: BLANK_ICON, ok: S };
    const { errors } = listStackValidationErrors(input);
    expect(errors.length).toBeGreaterThanOrEqual(12);
    for (const error of errors) {
      expect(error.message.every((piece) => typeof piece === "string")).toBe(true);
      expect(error.message.join("")).not.toContain(S);
    }
  });

  describe("with another unrecognized_keys message format", () => {
    afterEach(() => {
      z.config({ customError: undefined });
    });

    it("keeps the whole message as one fromValue piece when a key is not found in it", () => {
      z.config({ customError: (issue) => (issue.code === "unrecognized_keys" ? "keys not allowed here" : undefined) });
      const input = clone(makeStack());
      input.cards[0].ast = {};
      expect(listStackValidationErrors(input).errors).toEqual([
        { path: ["cards", 0], message: [{ fromValue: "keys not allowed here" }] },
      ]);
    });
  });

  it("lists the structural errors in check order, with the stack set", () => {
    const input = clone(makeStack());
    input.backgrounds[0].parts.push(field("prt_f2", { layerScope: "card" }), field("prt_f3", { layerScope: "card" }));
    input.backgrounds[1].parts.push(field("prt_f4", { layerScope: "card" }));
    input.cards[0].backgroundId = "bkg_x";
    input.cards[0].parts.push(button("prt_b3", { layerScope: "background" }));
    input.cards[1].backgroundId = "bkg_y";
    input.cards[1].parts[0].layerScope = "background";
    input.cards[1].id = "crd_1";
    input.cards[1].parts[0].id = "prt_b1";
    input.backgrounds[1].parts[0].id = "prt_b1";
    input.cards[1].parts[0].iconId = "ico_missing";
    input.backgrounds[0].parts.push(button("prt_bb", { layerScope: "background", iconId: "ico_bg_missing" }));
    const report = listStackValidationErrors(input);
    expect(formatted(report.errors)).toEqual([
      'backgrounds[0].parts[1].layerScope: expected "background" but got "card"',
      'backgrounds[0].parts[2].layerScope: expected "background" but got "card"',
      'backgrounds[1].parts[0].layerScope: expected "background" but got "card"',
      'cards[0].backgroundId: references missing background "bkg_x"',
      'cards[0].parts[1].layerScope: expected "card" but got "background"',
      'cards[1].backgroundId: references missing background "bkg_y"',
      'cards[1].parts[0].layerScope: expected "card" but got "background"',
      'cards[0].parts[0].id: duplicate id "prt_b1"',
      'cards[1].id: duplicate id "crd_1"',
      'cards[1].parts[0].id: duplicate id "prt_b1"',
      'backgrounds[0].parts[3].iconId: no icon named "ico_bg_missing" in customIcons',
      'cards[1].parts[0].iconId: no icon named "ico_missing" in customIcons',
    ]);
    expect(report.stack).not.toBeNull();
    expect(report.errors[3].message).toEqual(['references missing background "', { fromValue: "bkg_x" }, '"']);
    expect(report.errors[0].message).toEqual(['expected "background" but got "', { fromValue: "card" }, '"']);
    expect(report.errors[7].message).toEqual(['duplicate id "', { fromValue: "prt_b1" }, '"']);
    expect(report.errors[11].message).toEqual(['no icon named "', { fromValue: "ico_missing" }, '" in customIcons']);
  });

  it("reports every occurrence of a repeated id after its first, the stack id included", () => {
    const input = clone(makeStack());
    input.backgrounds[1].id = "stk_1";
    input.cards[0].id = "stk_1";
    input.cards[1].id = "stk_1";
    input.cards[1].backgroundId = "stk_1";
    expect(formatted(listStackValidationErrors(input).errors)).toEqual([
      'backgrounds[1].id: duplicate id "stk_1"',
      'cards[0].id: duplicate id "stk_1"',
      'cards[1].id: duplicate id "stk_1"',
    ]);
  });

  it("never mutates its input", () => {
    const input = clone(makeStack());
    input.cards[0].ast = {};
    const before = JSON.stringify(input);
    listStackValidationErrors(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("formatGateError", () => {
  const error: GateError = {
    path: ["cards", 3, "bgFieldContents", "prt_key", "x"],
    message: ["no icon named \"", { fromValue: "abc" }, "\" here"],
  };

  it("gives the old error text without quote", () => {
    expect(formatGateError(error)).toBe('cards[3].bgFieldContents.prt_key.x: no icon named "abc" here');
    expect(formatGateError({ path: [], message: ["m"] })).toBe("stack: m");
    expect(formatGateError({ path: [0, "a"], message: [] })).toBe("[0].a: ");
  });

  it("applies quote to every string path key and every fromValue piece, never to indexes or fixed text", () => {
    const quote = (text: string): string => `<${text}>`;
    expect(formatGateError(error, quote)).toBe('<cards>[3].<bgFieldContents>.<prt_key>.<x>: no icon named "<abc>" here');
  });
});

describe("validateStack is unchanged (Requirement 14.2)", () => {
  const withProto = (): unknown =>
    JSON.parse(JSON.stringify(makeStack()).replace('"customIcons":{', `"customIcons":{"__proto__":"${BLANK_ICON}",`));
  const changed = (change: (s: any) => void): unknown => {
    const s = clone(makeStack());
    change(s);
    return s;
  };
  const corpus: Array<[string, unknown]> = [
    ["valid", makeStack()],
    ["null", null],
    ["array", []],
    ["number", 5],
    ["string", "stack"],
    ["empty object", {}],
    ["wrong version", changed((s) => { s.schemaVersion = "1.0"; })],
    ["object version", changed((s) => { s.schemaVersion = { a: 1 }; })],
    ["__proto__ icon", withProto()],
    ["schema issue", changed((s) => { s.cards[0].parts[0].rect.width = -1; })],
    ["unknown key", changed((s) => { s.backgrounds[0].ast = {}; })],
    ["no cards", changed((s) => { s.cards = []; })],
    ["layer scope", changed((s) => { s.cards[1].parts[0].layerScope = "background"; })],
    ["missing background", changed((s) => { s.cards[1].backgroundId = "bkg_9"; })],
    ["duplicate id", changed((s) => { s.cards[1].parts[0].id = "prt_b1"; })],
    ["missing icon", changed((s) => { s.cards[0].parts[0].iconId = "nope"; })],
    ["several structural", changed((s) => {
      s.cards[1].backgroundId = "bkg_9";
      s.cards[0].id = "bkg_1";
      s.cards[0].parts[0].iconId = "nope";
    })],
    ...SHOWCASE_STACKS.map((entry): [string, unknown] => [entry.id, entry.create()]),
  ];

  it.each(corpus)("returns the same value as before spec 07: %s", (_name, input) => {
    expect(validateStack(input)).toEqual(oracleValidateStack(input));
  });
});
