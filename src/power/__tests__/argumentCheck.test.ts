// Spec 07 task 3.1: argumentCheck.ts (Requirements 4.5, 5.3, 5.7). The bounds of each tool's own
// inputSchema are added with the tools (tasks 3.2, 4.2, 5.1); this file tests the checker on a
// schema that uses every keyword of the subset.
import { describe, expect, it } from "vitest";
import { checkArguments, formatArgPath, type ArgSchema } from "../argumentCheck.ts";

const rect: ArgSchema = {
  type: "object",
  properties: {
    op: { type: "string", const: "rect" },
    x: { type: "integer", minimum: 0, maximum: 511 },
    filled: { type: "boolean", default: false },
  },
  required: ["op", "x"],
  additionalProperties: false,
};
const sprite: ArgSchema = {
  type: "object",
  properties: {
    op: { type: "string", const: "sprite" },
    rows: { type: "array", items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[#.]+$" }, minItems: 1, maxItems: 64 },
  },
  required: ["op", "rows"],
  additionalProperties: false,
};
const text: ArgSchema = {
  type: "object",
  properties: {
    op: { type: "string", const: "text" },
    style: { type: "array", items: { type: "string", enum: ["bold", "italic"] }, uniqueItems: true },
  },
  required: ["op"],
  additionalProperties: false,
};

const SCHEMA: Extract<ArgSchema, { type: "object" }> = {
  type: "object",
  properties: {
    layer: { type: "string", enum: ["card", "background"], description: "card or background" },
    commands: { type: "array", items: { oneOf: [rect, sprite, text] }, minItems: 1, maxItems: 3 },
    card: { anyOf: [{ type: "integer", minimum: 1, maximum: 100000 }, { type: "string", maxLength: 256 }] },
    scale: { type: "integer", enum: [1, 2], default: 1 },
    stack: { type: "string", maxLength: 10 },
    hexstack: { type: "boolean", default: false },
  },
  required: ["layer", "commands"],
  additionalProperties: false,
};

const valid = { layer: "card", commands: [{ op: "rect", x: 0 }] };
const check = (value: unknown, options?: Parameters<typeof checkArguments>[2]): string[] =>
  checkArguments(SCHEMA, value, options);

describe("formatArgPath", () => {
  it("writes names with dots and indexes in brackets", () => {
    expect(formatArgPath(["commands", 3, "rows", 1])).toBe("commands[3].rows[1]");
    expect(formatArgPath(["stack"])).toBe("stack");
    expect(formatArgPath([])).toBe("arguments");
  });
});

describe("checkArguments", () => {
  it("returns no entry for conforming arguments", () => {
    expect(check(valid)).toEqual([]);
    expect(
      check({
        layer: "background",
        commands: [{ op: "sprite", rows: ["#.", ".#"] }, { op: "text", style: ["bold", "italic"] }, { op: "rect", x: 511, filled: true }],
        card: 100000,
        scale: 2,
        stack: "0123456789",
        hexstack: false,
      }),
    ).toEqual([]);
    expect(check({ ...valid, card: "x".repeat(256) })).toEqual([]);
  });

  it("names a non-object value at the path arguments", () => {
    expect(check([])).toEqual(["arguments: must be an object"]);
    expect(check(null)).toEqual(["arguments: must be an object"]);
  });

  it("lists unknown arguments first, in input order, then each declared property in schema order", () => {
    expect(check({ zeta: 1, commands: "x", alpha: 2, scale: "1" })).toEqual([
      "zeta: is not an allowed argument",
      "alpha: is not an allowed argument",
      "layer: is required",
      "commands: must be an array",
      "scale: must be an integer",
    ]);
  });

  it("does not treat inherited names as declared or present", () => {
    expect(check({ ...valid, toString: 1, constructor: 2 })).toEqual([
      "toString: is not an allowed argument",
      "constructor: is not an allowed argument",
    ]);
    expect(check(JSON.parse('{"__proto__": 1, "layer": "card", "commands": [{"op":"rect","x":0}]}'))).toEqual([
      "__proto__: is not an allowed argument",
    ]);
  });

  it("writes each type rule", () => {
    expect(check({ layer: 1, commands: [5], hexstack: "true", stack: 3 })).toEqual([
      "layer: must be a string",
      "commands[0]: must be an object",
      "stack: must be a string",
      "hexstack: must be a boolean",
    ]);
    expect(check({ ...valid, scale: 1.5 })).toEqual(["scale: must be an integer"]);
  });

  it("checks enums, integer ranges and string lengths", () => {
    expect(check({ ...valid, layer: "Card" })).toEqual(["layer: must be one of card, background"]);
    expect(check({ ...valid, scale: 3 })).toEqual(["scale: must be one of 1, 2"]);
    expect(check({ layer: "card", commands: [{ op: "rect", x: 512 }] })).toEqual(["commands[0].x: must be from 0 to 511"]);
    expect(check({ layer: "card", commands: [{ op: "rect", x: -1 }] })).toEqual(["commands[0].x: must be from 0 to 511"]);
    expect(check({ ...valid, stack: "x".repeat(11) })).toEqual(["stack: must have at most 10 characters"]);
  });

  it("counts lengths in UTF-16 code units", () => {
    expect(check({ ...valid, stack: "\u{1F600}".repeat(5) })).toEqual([]);
    expect(check({ ...valid, stack: `${"\u{1F600}".repeat(5)}a` })).toEqual(["stack: must have at most 10 characters"]);
  });

  it("checks array lengths, then each item in order", () => {
    expect(check({ layer: "card", commands: [] })).toEqual(["commands: must have 1 to 3 entries"]);
    const four = Array.from({ length: 4 }, (_, x) => ({ op: "rect", x: x === 3 ? 600 : x }));
    expect(check({ layer: "card", commands: four })).toEqual([
      "commands: must have 1 to 3 entries",
      "commands[3].x: must be from 0 to 511",
    ]);
  });

  it("checks string length and pattern of nested items with full paths", () => {
    expect(check({ layer: "card", commands: [{ op: "sprite", rows: ["#.", "", "#x", "#".repeat(65)] }] })).toEqual([
      "commands[0].rows[1]: must have 1 to 64 characters",
      "commands[0].rows[1]: must contain only # and .",
      "commands[0].rows[2]: must contain only # and .",
      "commands[0].rows[3]: must have 1 to 64 characters",
    ]);
  });

  it("checks uniqueItems with the property's name", () => {
    expect(check({ layer: "card", commands: [{ op: "text", style: ["bold", "bold"] }] })).toEqual([
      "commands[0].style: must list each style at most once",
    ]);
  });

  it("picks the oneOf branch by its op and names unknown fields below the top level", () => {
    expect(check({ layer: "card", commands: [{ op: "oval" }, { x: 1 }, { op: "rect", rows: [] }] })).toEqual([
      "commands[0].op: must be one of rect, sprite, text",
      "commands[1].op: must be one of rect, sprite, text",
      "commands[2].rows: is not an allowed field",
      "commands[2].x: is required",
    ]);
  });

  it("writes one message for an anyOf value that no branch accepts", () => {
    const rule = "card: must be an integer from 1 to 100000 or a string of at most 256 characters";
    expect(check({ ...valid, card: 0 })).toEqual([rule]);
    expect(check({ ...valid, card: 100001 })).toEqual([rule]);
    expect(check({ ...valid, card: "x".repeat(257) })).toEqual([rule]);
    expect(check({ ...valid, card: true })).toEqual([rule]);
    expect(check({ ...valid, card: 1 })).toEqual([]);
  });

  it("leaves the maxLength of a read-limited argument to the tool", () => {
    const long = { ...valid, stack: "x".repeat(11) };
    expect(check(long, { readLimited: ["stack"] })).toEqual([]);
    expect(check({ ...valid, stack: 5 }, { readLimited: ["stack"] })).toEqual(["stack: must be a string"]);
  });

  it("shortens an unknown key longer than 80 characters (Requirement 5.7)", () => {
    const key = "k".repeat(500);
    expect(check({ ...valid, [key]: 1 })).toEqual([`${"k".repeat(77)}...: is not an allowed argument`]);
    const spaced = "a key with spaces ".repeat(10);
    const [entry] = check({ ...valid, [spaced]: 1 });
    expect(entry).toBe(`${spaced.slice(0, 77)}...: is not an allowed argument`);
  });

  it("throws on a keyword outside the subset, at any depth", () => {
    expect(() => checkArguments({ type: "string", format: "uri" } as unknown as ArgSchema, "x")).toThrow(/unknown keyword format/);
    const nested = {
      type: "object",
      properties: { a: { type: "array", items: { type: "integer", exclusiveMinimum: 0 } } },
      additionalProperties: false,
    } as unknown as ArgSchema;
    expect(() => checkArguments(nested, {})).toThrow(/unknown keyword exclusiveMinimum/);
    expect(() => checkArguments({ type: "number" } as unknown as ArgSchema, 1)).toThrow(/unknown type/);
    expect(() =>
      checkArguments({ type: "object", properties: {} } as unknown as ArgSchema, {}),
    ).toThrow(/additionalProperties/);
    expect(() => checkArguments({ type: "string", pattern: "^a.*$" }, "a")).toThrow(/unsupported pattern/);
  });
});
