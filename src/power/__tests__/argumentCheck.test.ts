// Spec 07 task 3.1: argumentCheck.ts (Requirements 4.5, 5.3, 5.7). The bounds of each tool's own
// inputSchema are added with the tools (tasks 3.2, 4.2, 5.1); this file tests the checker on a
// schema that uses every keyword of the subset.
import { describe, expect, it } from "vitest";
import { checkArguments, formatArgPath, type ArgSchema } from "../argumentCheck.ts";
import { MAX_STACK_TEXT } from "../stackText.ts";
import { createPowerTools } from "../tools/index.ts";
import { FONTS, makeCaller } from "./toolFixtures.ts";

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

// ---------------------------------------------------------------------------------------------
// Task 3.2: the bounds of Requirement 5.3 for validate_stack, compile_hextalk and conjure_script,
// checked the way the protocol handler checks them (the tool's own checkArguments, else the
// generic checker on its inputSchema).
// ---------------------------------------------------------------------------------------------
describe("Requirement 5.3: argument bounds of validate_stack, compile_hextalk, conjure_script, render_card and draw_layer", () => {
  const tools = createPowerTools({ fonts: FONTS });
  const problems = (name: string, args: Record<string, unknown>): string[] => {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`no tool ${name}`);
    return tool.checkArguments ? tool.checkArguments(args) : checkArguments(tool.inputSchema, args);
  };

  it("lists exactly the five tools, in order", () => {
    expect(tools.map((tool) => tool.name)).toEqual(["validate_stack", "compile_hextalk", "conjure_script", "render_card", "draw_layer"]);
  });

  describe("validate_stack", () => {
    it("accepts a stack of 4194304 characters, and treats one more as a read error, not an argument error", async () => {
      expect(problems("validate_stack", { stack: "x".repeat(MAX_STACK_TEXT) })).toEqual([]);
      expect(problems("validate_stack", { stack: "x".repeat(MAX_STACK_TEXT + 1) })).toEqual([]);
      const { call } = makeCaller();
      const past = await call("validate_stack", { stack: "x".repeat(MAX_STACK_TEXT + 1) });
      expect(past.isError).toBe(true);
      expect(past.json.errors).toEqual([`stack: The stack text has more than ${MAX_STACK_TEXT} characters`]);
    });

    it("counts the stack length in UTF-16 code units", async () => {
      const { call } = makeCaller();
      // 2,097,152 emoji are 4,194,304 code units; one more emoji is 4,194,306.
      const emoji = "\u{1F600}";
      expect((await call("validate_stack", { stack: emoji.repeat(MAX_STACK_TEXT / 2) })).json.errors[0]).not.toMatch(/more than/);
      expect((await call("validate_stack", { stack: emoji.repeat(MAX_STACK_TEXT / 2 + 1) })).json.errors[0]).toMatch(/more than/);
    });

    it("requires a string stack, allows only a boolean hexstack, and rejects other arguments", () => {
      expect(problems("validate_stack", {})).toEqual(["stack: is required"]);
      expect(problems("validate_stack", { stack: 1 })).toEqual(["stack: must be a string"]);
      expect(problems("validate_stack", { stack: "" })).toEqual([]);
      expect(problems("validate_stack", { stack: "{}", hexstack: true })).toEqual([]);
      expect(problems("validate_stack", { stack: "{}", hexstack: false })).toEqual([]);
      expect(problems("validate_stack", { stack: "{}", hexstack: 1 })).toEqual(["hexstack: must be a boolean"]);
      expect(problems("validate_stack", { stack: "{}", hexstack: "true" })).toEqual(["hexstack: must be a boolean"]);
      expect(problems("validate_stack", { stack: "{}", url: "https://example.com" })).toEqual(["url: is not an allowed argument"]);
    });
  });

  describe("compile_hextalk", () => {
    it("accepts a source of 65536 characters and rejects 65537", () => {
      expect(problems("compile_hextalk", { source: "x".repeat(65536) })).toEqual([]);
      expect(problems("compile_hextalk", { source: "x".repeat(65537) })).toEqual(["source: must have at most 65536 characters"]);
    });

    it("counts UTF-16 code units, accepts the empty source, and requires a string source", () => {
      expect(problems("compile_hextalk", { source: "\u{1F600}".repeat(32768) })).toEqual([]);
      expect(problems("compile_hextalk", { source: "\u{1F600}".repeat(32769) })).toEqual(["source: must have at most 65536 characters"]);
      expect(problems("compile_hextalk", { source: "" })).toEqual([]);
      expect(problems("compile_hextalk", {})).toEqual(["source: is required"]);
      expect(problems("compile_hextalk", { source: null })).toEqual(["source: must be a string"]);
      expect(problems("compile_hextalk", { source: "", extra: true })).toEqual(["extra: is not an allowed argument"]);
    });
  });

  describe("conjure_script", () => {
    it("accepts a prompt of 600 characters and rejects 601", () => {
      expect(problems("conjure_script", { prompt: "x".repeat(600) })).toEqual([]);
      expect(problems("conjure_script", { prompt: "x".repeat(601) })).toEqual(["prompt: must have at most 600 characters"]);
      expect(problems("conjure_script", { prompt: "\u{1F600}".repeat(300) })).toEqual([]);
      expect(problems("conjure_script", { prompt: "\u{1F600}".repeat(301) })).toEqual(["prompt: must have at most 600 characters"]);
    });

    it("accepts each of the five object kinds, and rejects any value outside the set", () => {
      for (const objectKind of ["button", "field", "card", "background", "stack"]) {
        expect(problems("conjure_script", { prompt: "go next", objectKind })).toEqual([]);
      }
      const rule = ["objectKind: must be one of button, field, card, background, stack"];
      for (const objectKind of ["Button", "part", "", "cards", " button"]) {
        expect(problems("conjure_script", { prompt: "go next", objectKind })).toEqual(rule);
      }
      expect(problems("conjure_script", { prompt: "go next", objectKind: 1 })).toEqual(["objectKind: must be a string"]);
    });

    it("requires a string prompt and allows no other argument", () => {
      expect(problems("conjure_script", {})).toEqual(["prompt: is required"]);
      expect(problems("conjure_script", { prompt: "" })).toEqual([]);
      expect(problems("conjure_script", { prompt: 5 })).toEqual(["prompt: must be a string"]);
      expect(problems("conjure_script", { prompt: "go next", tier: 3 })).toEqual(["tier: is not an allowed argument"]);
    });
  });

  describe("render_card", () => {
    it("treats the stack like validate_stack: a string, read-limited at 4194304 characters", async () => {
      expect(problems("render_card", {})).toEqual(["stack: is required"]);
      expect(problems("render_card", { stack: 1 })).toEqual(["stack: must be a string"]);
      expect(problems("render_card", { stack: "x".repeat(MAX_STACK_TEXT) })).toEqual([]);
      expect(problems("render_card", { stack: "x".repeat(MAX_STACK_TEXT + 1) })).toEqual([]);
      const { call } = makeCaller();
      const past = await call("render_card", { stack: "x".repeat(MAX_STACK_TEXT + 1) });
      expect(past.isError).toBe(true);
      expect(past.json.errors).toEqual([`stack: The stack text has more than ${MAX_STACK_TEXT} characters`]);
    });
    it("accepts card positions 1 and 100000 and rejects 0 and 100001, 1.5 and a boolean", () => {
      const rule = ["card: must be an integer from 1 to 100000 or a string of at most 256 characters"];
      expect(problems("render_card", { stack: "{}", card: 1 })).toEqual([]);
      expect(problems("render_card", { stack: "{}", card: 100000 })).toEqual([]);
      expect(problems("render_card", { stack: "{}", card: 0 })).toEqual(rule);
      expect(problems("render_card", { stack: "{}", card: 100001 })).toEqual(rule);
      expect(problems("render_card", { stack: "{}", card: -3 })).toEqual(rule);
      expect(problems("render_card", { stack: "{}", card: 1.5 })).toEqual(rule);
      expect(problems("render_card", { stack: "{}", card: true })).toEqual(rule);
      expect(problems("render_card", { stack: "{}", card: null })).toEqual(rule);
    });
    it("accepts a card string of 256 characters (UTF-16 code units) and rejects 257", () => {
      const rule = ["card: must be an integer from 1 to 100000 or a string of at most 256 characters"];
      expect(problems("render_card", { stack: "{}", card: "x".repeat(256) })).toEqual([]);
      expect(problems("render_card", { stack: "{}", card: "x".repeat(257) })).toEqual(rule);
      expect(problems("render_card", { stack: "{}", card: "\u{1F600}".repeat(128) })).toEqual([]);
      expect(problems("render_card", { stack: "{}", card: "\u{1F600}".repeat(129) })).toEqual(rule);
      expect(problems("render_card", { stack: "{}", card: "" })).toEqual([]);
    });
    it("accepts scale 1 and 2 and rejects every other value", () => {
      expect(problems("render_card", { stack: "{}", scale: 1 })).toEqual([]);
      expect(problems("render_card", { stack: "{}", scale: 2 })).toEqual([]);
      for (const scale of [0, 3, -1]) {
        expect(problems("render_card", { stack: "{}", scale })).toEqual(["scale: must be one of 1, 2"]);
      }
      expect(problems("render_card", { stack: "{}", scale: 1.5 })).toEqual(["scale: must be an integer"]);
      expect(problems("render_card", { stack: "{}", scale: "1" })).toEqual(["scale: must be an integer"]);
    });
    it("allows no other argument", () => {
      expect(problems("render_card", { stack: "{}", layer: "card" })).toEqual(["layer: is not an allowed argument"]);
    });
  });
  describe("draw_layer", () => {
    const rect = { op: "rect", x: 0, y: 0, width: 1, height: 1 };
    const line = { op: "line", x1: 0, y1: 0, x2: 1, y2: 1 };
    const sprite = { op: "sprite", x: 0, y: 0, rows: ["#"] };
    const text = { op: "text", x: 0, y: 0, text: "x" };
    const draw = (command: Record<string, unknown>) => problems("draw_layer", { layer: "card", commands: [command] });
    /** Each bound accepted (no entry), one past it rejected with exactly this rule. */
    const bound = (base: Record<string, unknown>, field: string, accepted: unknown[], rejected: unknown[], rule: string) => {
      for (const value of accepted) expect(draw({ ...base, [field]: value }), `${field} ${String(value)}`).toEqual([]);
      for (const value of rejected) expect(draw({ ...base, [field]: value }), `${field} ${String(value)}`).toEqual([`commands[0].${field}: ${rule}`]);
    };

    it("requires layer and commands, allows nothing else, and takes only card or background", () => {
      expect(problems("draw_layer", {})).toEqual(["layer: is required", "commands: is required"]);
      expect(problems("draw_layer", { layer: "card", commands: [rect], stack: "{}" })).toEqual(["stack: is not an allowed argument"]);
      for (const layer of ["card", "background"]) expect(problems("draw_layer", { layer, commands: [rect] })).toEqual([]);
      for (const layer of ["Card", "stack", "", "cards"]) {
        expect(problems("draw_layer", { layer, commands: [rect] })).toEqual(["layer: must be one of card, background"]);
      }
      expect(problems("draw_layer", { layer: 1, commands: [rect] })).toEqual(["layer: must be a string"]);
    });

    it("accepts 1 to 256 commands and rejects 0 and 257", () => {
      const many = (n: number) => Array.from({ length: n }, () => rect);
      expect(problems("draw_layer", { layer: "card", commands: many(1) })).toEqual([]);
      expect(problems("draw_layer", { layer: "card", commands: many(256) })).toEqual([]);
      expect(problems("draw_layer", { layer: "card", commands: many(0) })).toEqual(["commands: must have 1 to 256 entries"]);
      expect(problems("draw_layer", { layer: "card", commands: many(257) })).toEqual(["commands: must have 1 to 256 entries"]);
      expect(problems("draw_layer", { layer: "card", commands: {} })).toEqual(["commands: must be an array"]);
    });

    it("takes only the four ops, each with its required fields and no other field", () => {
      for (const command of [rect, line, sprite, text]) expect(draw(command)).toEqual([]);
      expect(draw({ op: "oval", x: 0, y: 0 })).toEqual(["commands[0].op: must be one of rect, line, sprite, text"]);
      expect(draw({ x: 0, y: 0 })).toEqual(["commands[0].op: must be one of rect, line, sprite, text"]);
      expect(draw({ op: "Rect", x: 0, y: 0 })).toEqual(["commands[0].op: must be one of rect, line, sprite, text"]);
      expect(draw({ op: "rect" })).toEqual(["commands[0].x: is required", "commands[0].y: is required", "commands[0].width: is required", "commands[0].height: is required"]);
      expect(draw({ op: "line", x1: 0 })).toEqual(["commands[0].y1: is required", "commands[0].x2: is required", "commands[0].y2: is required"]);
      expect(draw({ op: "sprite", x: 0, y: 0 })).toEqual(["commands[0].rows: is required"]);
      expect(draw({ op: "text", x: 0, y: 0 })).toEqual(["commands[0].text: is required"]);
      expect(draw({ ...rect, color: "red" })).toEqual(["commands[0].color: is not an allowed field"]);
      expect(draw({ ...line, width: 3 })).toEqual(["commands[0].width: is not an allowed field"]);
      expect(draw({ ...sprite, pattern: 1 })).toEqual(["commands[0].pattern: is not an allowed field"]);
      expect(draw({ ...text, rows: ["#"] })).toEqual(["commands[0].rows: is not an allowed field"]);
    });

    it("keeps every coordinate an integer inside the layer: x, x1, x2 from 0 to 511 and y, y1, y2 from 0 to 341", () => {
      const columns = "must be from 0 to 511";
      const rows = "must be from 0 to 341";
      bound(rect, "x", [0, 511], [-1, 512], columns);
      bound(rect, "y", [0, 341], [-1, 342], rows);
      bound({ ...sprite, rows: ["#"] }, "x", [0, 511], [-1, 512], columns);
      bound(sprite, "y", [0, 341], [-1, 342], rows);
      bound(text, "x", [0, 511], [-1, 512], columns);
      bound(text, "y", [0, 341], [-1, 342], rows);
      bound(line, "x1", [0, 511], [-1, 512], columns);
      bound(line, "x2", [0, 511], [-1, 512], columns);
      bound(line, "y1", [0, 341], [-1, 342], rows);
      bound(line, "y2", [0, 341], [-1, 342], rows);
      for (const bad of [1.5, "1", null, true]) bound(rect, "x", [], [bad], "must be an integer");
    });

    it("keeps the width and height of a rectangle from 1 to 512 and 1 to 342, and of a text box the same", () => {
      bound(rect, "width", [1, 512], [0, 513, -4], "must be from 1 to 512");
      bound(rect, "height", [1, 342], [0, 343], "must be from 1 to 342");
      bound(text, "width", [1, 512], [0, 513], "must be from 1 to 512");
      bound(text, "height", [1, 342], [0, 343], "must be from 1 to 342");
      bound(rect, "width", [], [2.5, "3"], "must be an integer");
    });

    it("keeps the pattern of a rectangle and of a line an integer from 0 to 37, and filled a boolean", () => {
      bound(rect, "pattern", [0, 1, 37], [-1, 38], "must be from 0 to 37");
      bound(line, "pattern", [0, 1, 37], [-1, 38], "must be from 0 to 37");
      bound(rect, "pattern", [], [1.5, "1"], "must be an integer");
      bound(rect, "filled", [true, false], [1, "true", null], "must be a boolean");
    });

    it("keeps the rows of a sprite at 1 to 64 rows of 1 to 64 characters, each # or .", () => {
      const rows = (n: number, length = 1) => Array.from({ length: n }, () => "#".repeat(length));
      for (const value of [rows(1), rows(64), rows(1, 64), rows(64, 64), ["#.#", "..."]]) expect(draw({ ...sprite, rows: value })).toEqual([]);
      bound(sprite, "rows", [], [rows(0), rows(65)], "must have 1 to 64 entries");
      expect(draw({ ...sprite, rows: ["#".repeat(65)] })).toEqual(["commands[0].rows[0]: must have 1 to 64 characters"]);
      expect(draw({ ...sprite, rows: ["#", "#".repeat(65)] })).toEqual(["commands[0].rows[1]: must have 1 to 64 characters"]);
      expect(draw({ ...sprite, rows: [""] })).toContain("commands[0].rows[0]: must have 1 to 64 characters");
      for (const row of ["x", " ", "0", "#x#", "#,"]) {
        expect(draw({ ...sprite, rows: [row] }), row).toEqual(["commands[0].rows[0]: must contain only # and ."]);
      }
      expect(draw({ ...sprite, rows: "#" })).toEqual(["commands[0].rows: must be an array"]);
      expect(draw({ ...sprite, rows: [1] })).toEqual(["commands[0].rows[0]: must be a string"]);
    });

    it("keeps the text of a text command at 1 to 256 characters, counted in UTF-16 code units", () => {
      for (const value of ["x", "x".repeat(256), "\u{1F600}".repeat(128)]) expect(draw({ ...text, text: value })).toEqual([]);
      for (const value of ["", "x".repeat(257), "\u{1F600}".repeat(129)]) {
        expect(draw({ ...text, text: value })).toEqual(["commands[0].text: must have 1 to 256 characters"]);
      }
      bound(text, "text", [], [5, null], "must be a string");
    });

    it("takes font, size, style, align, wrap and ink only from their sets", () => {
      bound(text, "font", ["System", "Sans", "Mono", "Serif"], ["sans", "Monaco", ""], "must be one of System, Sans, Mono, Serif");
      bound(text, "size", [9, 10, 12, 14, 18, 24], [8, 11, 13, 0, 25], "must be one of 9, 10, 12, 14, 18, 24");
      bound(text, "align", ["left", "center", "right"], ["justify", "Left"], "must be one of left, center, right");
      bound(text, "ink", ["dark", "light"], ["gray", "Dark", ""], "must be one of dark, light");
      bound(text, "wrap", [true, false], ["yes", 0], "must be a boolean");
      const styles = ["bold", "italic", "underline", "outline", "shadow", "condense"];
      for (const value of [[], ["bold"], styles]) expect(draw({ ...text, style: value })).toEqual([]);
      expect(draw({ ...text, style: ["bold", "bold"] })).toEqual(["commands[0].style: must list each style at most once"]);
      expect(draw({ ...text, style: ["bold", "italic", "italic"] })).toEqual(["commands[0].style: must list each style at most once"]);
      expect(draw({ ...text, style: ["underlined"] })).toEqual(["commands[0].style[0]: must be one of bold, italic, underline, outline, shadow, condense"]);
      expect(draw({ ...text, style: "bold" })).toEqual(["commands[0].style: must be an array"]);
    });

    it("keeps the sprite rows and texts of one call to 65536 characters in all, the last entry", () => {
      const sprite4096 = { op: "sprite", x: 0, y: 0, rows: Array.from({ length: 64 }, () => "#".repeat(64)) };
      const sixteen = Array.from({ length: 16 }, () => sprite4096);
      const long = "this call adds up to more than the limit";
      expect(problems("draw_layer", { layer: "card", commands: sixteen })).toEqual([]);
      expect(problems("draw_layer", { layer: "card", commands: [...sixteen, text] })).toEqual([
        "commands: the sprite rows and texts have 65537 characters in all, more than 65536",
      ]);
      // Texts count as well as rows, and the entry comes after the entry of a broken command.
      const texts = Array.from({ length: 16 }, () => ({ ...text, text: "x".repeat(256) }));
      expect(problems("draw_layer", { layer: "card", commands: [...Array.from({ length: 15 }, () => sprite4096), ...texts] })).toEqual([]);
      expect(problems("draw_layer", { layer: "card", commands: [...Array.from({ length: 15 }, () => sprite4096), ...texts, text] })).toEqual([
        "commands: the sprite rows and texts have 65537 characters in all, more than 65536",
      ]);
      expect(problems("draw_layer", { layer: "card", commands: [{ ...rect, x: 600 }, ...sixteen, { ...text, text: long }] })).toEqual([
        "commands[0].x: must be from 0 to 511",
        `commands: the sprite rows and texts have ${65536 + long.length} characters in all, more than 65536`,
      ]);
    });
  });
});
