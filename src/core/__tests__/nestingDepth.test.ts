/**
 * Spec 02 task 3 follow-up: the shared nesting limit `HEX_MAX_DEPTH` of hexcard_design_spec.md §4.2
 * (parser/printer contract; Requirements 2.2, 2.3). `validateAst` and `parseHexTalk` count depth
 * the same way (convention in ast.ts), so an AST at the limit round-trips, and an AST one level
 * deeper is rejected by both, the parser reporting the first token beyond the limit.
 */
import { describe, expect, it } from "vitest";
import { HEX_MAX_DEPTH } from "../ast.ts";
import type { HexExprNode, HexScriptAST, HexStatementNode } from "../ast.ts";
import { validateAst } from "../astValidator.ts";
import { parseHexTalk, printHexTalk } from "../parser.ts";

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const TOO_DEEP = "script is nested too deeply";
const VALIDATOR_REASON = `ast.handlers.h: AST is nested too deeply (the maximum depth is ${HEX_MAX_DEPTH})`;

type BinaryOp = Extract<HexExprNode, { kind: "BinaryOp" }>["op"];
const lit = (value: string | number | boolean): HexExprNode => ({ kind: "Literal", value });
const v = (name: string): HexExprNode => ({ kind: "Variable", name });
const bin = (op: BinaryOp, left: HexExprNode, right: HexExprNode): HexExprNode => ({ kind: "BinaryOp", op, left, right });
const un = (op: "not" | "-", operand: HexExprNode): HexExprNode => ({ kind: "UnaryOp", op, operand });
const script = (body: HexStatementNode[]): HexScriptAST => ({ handlers: { h: { eventName: "h", params: [], body } } });
const get = (value: HexExprNode): HexScriptAST => script([{ kind: "GetValue", value }]);

/** Deep copy without `loc` keys: AST equality ignores source locations (§4.2). */
function stripLoc<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item: unknown) => stripLoc(item)) as T;
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) if (key !== "loc") out[key] = stripLoc(item);
    return out as T;
  }
  return value;
}

/** Reference depth for the builders below: each object with a `kind` is one level (ast.ts convention). */
function astDepth(value: unknown): number {
  if (Array.isArray(value)) return Math.max(0, ...value.map(astDepth));
  if (typeof value !== "object" || value === null) return 0;
  const self = typeof (value as { kind?: unknown }).kind === "string" ? 1 : 0;
  return self + Math.max(0, ...Object.values(value).map(astDepth));
}

/** 1-based line and column of `source[index]`. */
function position(source: string, index: number): { line: number; column: number } {
  expect(index).toBeGreaterThanOrEqual(0);
  const before = source.slice(0, index);
  return { line: before.split("\n").length, column: index - before.lastIndexOf("\n") };
}

// ---------------------------------------------------------------------------------------------
// Path shapes. `build(d)` returns an AST whose deepest node is at depth `d`; `errorAt` locates,
// in the printed depth-257 AST, the first token beyond the limit.
// ---------------------------------------------------------------------------------------------

interface Shape {
  name: string;
  build(depth: number): HexScriptAST;
  errorAt(printed: string): { line: number; column: number };
}

/** `-((((((x or v) and v) = v) & v) + v) * v)`: 7 levels, printed with a run of 6 `(`. */
const ladder = (x: HexExprNode): HexExprNode =>
  un("-", bin("*", bin("+", bin("&", bin("=", bin("and", bin("or", x, v("v")), v("v")), v("v")), v("v")), v("v")), v("v")));

/** One level each; applied inside out, so the node next to the leaf is always `not`. */
const MIXED: readonly ((x: HexExprNode) => HexExprNode)[] = [
  (x) => un("not", x),
  (x) => ({ kind: "FunctionCall", name: "max", args: [x, lit(2)] }),
  (x) => ({ kind: "ReadContainer", source: { scope: "field", layer: "background", selector: { by: "auto", value: x } } }),
  (x) => ({ kind: "ReadProperty", property: "name", target: { objectType: "card", selector: { by: "id", value: x } } }),
  (x) => bin("&", lit("a"), x),
  (x) => ({
    kind: "ReadProperty",
    property: "textSize",
    target: { objectType: "field", layer: "card", selector: { by: "auto", value: x } },
  }),
];

/** Odd depths are `if` blocks (then or else branch), even depths `repeat forever`. */
function block(depth: number, body: HexStatementNode[]): HexStatementNode {
  if (depth % 2 === 0) return { kind: "RepeatLoop", head: { type: "forever" }, body };
  return depth % 4 === 1
    ? { kind: "IfCondition", condition: lit(true), thenBranch: body }
    : { kind: "IfCondition", condition: lit(true), thenBranch: [], elseBranch: body };
}

const MIXED_BLOCKS = 100;

const SHAPES: Shape[] = [
  {
    name: "expressions: right-nested 1 - (1 - (...))",
    build(depth) {
      let e = lit(1);
      for (let i = 0; i < depth - 2; i++) e = bin("-", lit(1), e); // get = 1, first "-" = 2
      return get(e);
    },
    // The innermost "-" puts its left operand beyond the limit.
    errorAt: (printed) => position(printed, printed.lastIndexOf(" - ") + 1),
  },
  {
    name: "expressions: unary chain - not - not ...",
    build(depth) {
      let e = lit(1);
      for (let i = 0; i < depth - 2; i++) e = un(i % 2 === 0 ? "-" : "not", e);
      return get(e);
    },
    errorAt: (printed) => position(printed, printed.lastIndexOf("1")),
  },
  {
    name: "expressions: left-deep 1 + 1 + ... + 1",
    build(depth) {
      let e = lit(1);
      for (let i = 0; i < depth - 2; i++) e = bin("+", e, lit(1));
      return get(e);
    },
    // The last "+" wraps the chain once more and pushes the first literal beyond the limit.
    errorAt: (printed) => position(printed, printed.lastIndexOf("+")),
  },
  {
    name: "expressions: precedence ladder printed with runs of parentheses",
    build(depth) {
      const ladders = Math.floor((depth - 2) / 7);
      let e = v("v");
      for (let i = 0; i < ladders; i++) e = ladder(e);
      for (let i = 0; i < depth - 2 - 7 * ladders; i++) e = un("not", e);
      return get(e);
    },
    // Each inner ladder is the left operand of an "or" and only becomes one level deeper when that
    // "or" is read. Before the outermost "or" (printed last), the source could still continue as a
    // shallower expression, so that "or" is the first token that proves the limit is exceeded.
    errorAt: (printed) => position(printed, printed.lastIndexOf(" or ") + 1),
  },
  {
    name: "statement blocks: nested if/else/repeat",
    build(depth) {
      let body: HexStatementNode[] = [{ kind: "ExitRepeat" }];
      for (let k = depth - 1; k >= 1; k--) body = [block(k, body)];
      return script(body);
    },
    errorAt: (printed) => position(printed, printed.indexOf("exit repeat")),
  },
  {
    name: "mixed: blocks, then put with selectors, calls, properties and operators",
    build(depth) {
      let e = lit("deep");
      for (let i = 0; i < depth - MIXED_BLOCKS - 2; i++) e = MIXED[i % MIXED.length](e);
      let body: HexStatementNode[] = [{
        kind: "PutValue",
        mode: "into",
        value: e,
        destination: { scope: "field", layer: "card", selector: { by: "id", value: lit(1) } },
      }];
      for (let k = MIXED_BLOCKS; k >= 1; k--) {
        body = [k % 2 === 1
          ? { kind: "RepeatLoop", head: { type: "range", varName: "i", start: lit(1), end: v("n"), direction: "up" }, body }
          : { kind: "IfCondition", condition: v("x"), thenBranch: body }];
      }
      return script(body);
    },
    errorAt: (printed) => position(printed, printed.indexOf('"deep"')),
  },
];

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe(`HEX_MAX_DEPTH = ${HEX_MAX_DEPTH}: validator and parser agree (§4.2, Requirements 2.2, 2.3)`, () => {
  describe.each(SHAPES)("$name", (shape) => {
    it(`depth ${HEX_MAX_DEPTH}: validateAst accepts it and parse(print(A)) deep-equals A`, () => {
      const ast = shape.build(HEX_MAX_DEPTH);
      expect(astDepth(ast)).toBe(HEX_MAX_DEPTH);
      const checked = validateAst(ast);
      expect(checked.ok ? "valid" : checked.reason).toBe("valid");
      const { ast: reparsed, errors } = parseHexTalk(printHexTalk(ast));
      expect(errors).toEqual([]);
      expect(stripLoc(reparsed)).toEqual(ast);
    });

    it(`depth ${HEX_MAX_DEPTH + 1}: validateAst rejects it and parseHexTalk rejects its printed source`, () => {
      const ast = shape.build(HEX_MAX_DEPTH + 1);
      expect(astDepth(ast)).toBe(HEX_MAX_DEPTH + 1);
      expect(validateAst(ast)).toEqual({ ok: false, reason: VALIDATOR_REASON });
      const printed = printHexTalk(ast);
      const { ast: parsed, errors } = parseHexTalk(`${printed}on b\nend b\n`);
      expect(errors).toEqual([{ ...shape.errorAt(printed), message: TOO_DEEP }]);
      expect(Object.keys(parsed.handlers)).toEqual(["b"]); // recovers at "end h"
    });
  });
});

describe("parseHexTalk nesting limit", () => {
  it("counts a parenthesis pair directly around another pair as one extra level", () => {
    // `get` is depth 1 and its expression depth 2; each further redundant pair adds one level.
    const nested = (pairs: number): string => `on h\n  get ${"(".repeat(pairs)}1${")".repeat(pairs)}\nend h\n`;
    const accepted = parseHexTalk(nested(HEX_MAX_DEPTH - 1));
    expect(accepted.errors).toEqual([]);
    expect(stripLoc(accepted.ast)).toEqual(get(lit(1)));
    // The 256th "(" (column 7 + 255) would open content at depth 257.
    expect(parseHexTalk(nested(HEX_MAX_DEPTH)).errors).toEqual([{ line: 2, column: 7 + 255, message: TOO_DEEP }]);
  });

  it("reports the same first token however far the source goes beyond the limit", () => {
    const unary = parseHexTalk(`on h\n  get ${"- ".repeat(100_000)}1\nend h\n`);
    expect(unary.errors).toEqual([{ line: 2, column: 7 + 2 * (HEX_MAX_DEPTH - 1), message: TOO_DEEP }]);
    const blocks = parseHexTalk(`on h\n${"repeat\n".repeat(100_000)}end h\non b\nend b\n`);
    expect(blocks.errors).toEqual([{ line: HEX_MAX_DEPTH + 2, column: 1, message: TOO_DEEP }]);
    expect(Object.keys(blocks.ast.handlers)).toEqual(["b"]);
    const chain = parseHexTalk(`on h\n  get 1${" + 1".repeat(100_000)}\nend h\n`);
    expect(chain.errors).toEqual([{ line: 2, column: 9 + 4 * (HEX_MAX_DEPTH - 2), message: TOO_DEEP }]);
  });
});

describe("validateAst nesting limit", () => {
  it("rejects input far beyond the limit with the depth reason, not the stack-overflow backstop", () => {
    let e = lit(1);
    for (let i = 0; i < 100_000; i++) e = un("-", e);
    expect(validateAst(get(e))).toEqual({ ok: false, reason: VALIDATOR_REASON });
  });

  it("rejects a cyclic AST without throwing", () => {
    const cyclic: { kind: "UnaryOp"; op: "-"; operand: unknown } = { kind: "UnaryOp", op: "-", operand: null };
    cyclic.operand = cyclic;
    expect(validateAst(get(cyclic as HexExprNode))).toEqual({ ok: false, reason: VALIDATOR_REASON });
  });
});
