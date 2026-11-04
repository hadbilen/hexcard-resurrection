/**
 * Spec 02 task 2: lexer and parser (`parseHexTalk`), Requirements 1.1-1.5.
 * Golden tests: one describe block per §4.1 grammar rule, source -> expected AST (loc ignored).
 * Every AST that parses without errors is also checked with `validateAst`.
 */
import { describe, expect, it } from "vitest";
import type {
  HexCompileError,
  HexContainerTarget,
  HexExprNode,
  HexScriptAST,
  HexStatementNode,
} from "../ast.ts";
import { validateAst } from "../astValidator.ts";
import { parseHexTalk } from "../parser.ts";
import type { ScriptCompiler } from "../store.ts";

// The store's injected compiler accepts parseHexTalk as is.
const compilerContract: ScriptCompiler = parseHexTalk;
void compilerContract;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

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

function expectValid(ast: HexScriptAST): void {
  const result = validateAst(ast);
  expect(result.ok ? "valid" : result.reason).toBe("valid");
}

/** Parses a script that must compile cleanly; the AST must also pass validateAst. */
function parseOk(source: string): HexScriptAST {
  const { ast, errors } = parseHexTalk(source);
  expect(errors).toEqual([]);
  expectValid(ast);
  return stripLoc(ast);
}

const body = (lines: string, handler = "mouseUp"): HexStatementNode[] =>
  parseOk(`on ${handler}\n${lines}\nend ${handler}`).handlers[handler.toLowerCase()].body;

function stmt(line: string): HexStatementNode {
  const statements = body(line);
  expect(statements).toHaveLength(1);
  return statements[0];
}

function expr(source: string): HexExprNode {
  const statement = stmt(`get ${source}`);
  if (statement.kind !== "GetValue") throw new Error("expected a GetValue statement");
  return statement.value;
}

const errorsOf = (source: string): HexCompileError[] => parseHexTalk(source).errors;
const bodyErrors = (lines: string): HexCompileError[] => errorsOf(`on mouseUp\n${lines}\nend mouseUp`);

const lit = (value: string | number | boolean): HexExprNode => ({ kind: "Literal", value });
const v = (name: string): HexExprNode => ({ kind: "Variable", name });
const bin = (op: Extract<HexExprNode, { kind: "BinaryOp" }>["op"], left: HexExprNode, right: HexExprNode): HexExprNode =>
  ({ kind: "BinaryOp", op, left, right });
const field = (layer: "card" | "background", value: HexExprNode, by: "auto" | "id" = "auto"): Extract<HexContainerTarget, { scope: "field" }> =>
  ({ scope: "field", layer, selector: { by, value } });
const varTarget = (name: string): HexContainerTarget => ({ scope: "variable", name });

// ---------------------------------------------------------------------------------------------
// Script and Handler
// ---------------------------------------------------------------------------------------------

describe("Script / Handler", () => {
  it("parses an empty or comment-only script to no handlers", () => {
    expect(parseOk("")).toEqual({ handlers: {} });
    expect(parseOk("-- just a comment\n\n   \n")).toEqual({ handlers: {} });
  });

  it("keys handlers in lowercase, keeps eventName spelling and lowercases params", () => {
    const source = [
      "-- card script",
      "on mouseUp",
      "  get 1 -- trailing comment",
      "",
      "end mouseUp",
      "",
      "on keyDown theKey, Shift",
      "end keyDown",
    ].join("\n");
    expect(parseOk(source)).toEqual({
      handlers: {
        mouseup: { eventName: "mouseUp", params: [], body: [{ kind: "GetValue", value: lit(1) }] },
        keydown: { eventName: "keyDown", params: ["thekey", "shift"], body: [] },
      },
    });
  });

  it("accepts CRLF and CR line endings", () => {
    expect(parseOk("on openCard\r\n  get 1\r\nend openCard\r\n")).toEqual(parseOk("on openCard\n  get 1\nend openCard"));
    expect(parseOk("on openCard\r  get 1\rend openCard")).toEqual(parseOk("on openCard\n  get 1\nend openCard"));
  });

  it("records 1-based source locations on handlers, statements and expressions", () => {
    const { ast } = parseHexTalk("\non mouseUp\n  put a + 1 into x\nend mouseUp");
    const handler = ast.handlers.mouseup;
    expect(handler.loc).toEqual({ line: 2, column: 1 });
    const put = handler.body[0];
    expect(put.loc).toEqual({ line: 3, column: 3 });
    if (put.kind !== "PutValue") throw new Error("expected PutValue");
    expect(put.value.loc).toEqual({ line: 3, column: 9 }); // the "+" operator
    if (put.value.kind !== "BinaryOp") throw new Error("expected BinaryOp");
    expect(put.value.left.loc).toEqual({ line: 3, column: 7 });
  });
});

// ---------------------------------------------------------------------------------------------
// Case folding (Requirement 1.3)
// ---------------------------------------------------------------------------------------------

describe("case-insensitivity (Requirement 1.3)", () => {
  it("folds keywords, identifiers and handler names; eventName keeps the opening spelling", () => {
    const ast = parseOk([
      "ON MouseUp Who",
      "  PUT Who & \"Hi\" INTO Score",
      "  IF Score IS NOT EMPTY THEN PASS MOUSEUP",
      "  Set The ShowName Of Card BTN \"OK\" To TRUE",
      "END mouseup",
    ].join("\n"));
    expect(Object.keys(ast.handlers)).toEqual(["mouseup"]);
    const handler = ast.handlers.mouseup;
    expect(handler.eventName).toBe("MouseUp");
    expect(handler.params).toEqual(["who"]);
    expect(handler.body).toEqual([
      { kind: "PutValue", mode: "into", value: bin("&", v("who"), lit("Hi")), destination: varTarget("score") },
      {
        kind: "IfCondition",
        condition: bin("<>", v("score"), { kind: "Constant", name: "empty" }),
        thenBranch: [{ kind: "PassEvent", eventName: "mouseup" }],
      },
      {
        kind: "SetProperty",
        property: "showName",
        target: { objectType: "button", layer: "card", selector: { by: "auto", value: lit("OK") } },
        value: lit(true),
      },
    ]);
  });

  it("keeps string literal contents unchanged", () => {
    expect(expr('"MiXeD Case -- not a comment"')).toEqual(lit("MiXeD Case -- not a comment"));
  });
});

// ---------------------------------------------------------------------------------------------
// Statements, one rule at a time
// ---------------------------------------------------------------------------------------------

describe("GoCmd", () => {
  it.each([
    ["go next", "next"], ["go to next card", "next"], ["go prev", "prev"], ["go previous card", "prev"],
    ["go to first", "first"], ["go last card", "last"], ["go back", "back"], ["go to back", "back"],
  ] as const)("%s", (source, dir) => {
    expect(stmt(source)).toEqual({ kind: "GoToCard", target: { type: "relative", dir } });
  });

  it("parses card id, position, name and expression targets", () => {
    expect(stmt('go to card id "crd_2"')).toEqual({ kind: "GoToCard", target: { type: "id", value: lit("crd_2") } });
    expect(stmt("go card 3")).toEqual({ kind: "GoToCard", target: { type: "auto", value: lit(3) } });
    expect(stmt('go to card "Intro"')).toEqual({ kind: "GoToCard", target: { type: "auto", value: lit("Intro") } });
    expect(stmt("go card dest")).toEqual({ kind: "GoToCard", target: { type: "auto", value: v("dest") } });
    expect(stmt("go card field 1")).toEqual({
      kind: "GoToCard",
      target: { type: "auto", value: { kind: "ReadContainer", source: field("background", lit(1)) } },
    });
  });
});

describe("VisualCmd", () => {
  it.each([
    ["cut", "cut"], ["dissolve", "dissolve"], ["venetian blinds", "venetianBlinds"],
    ["checkerboard", "checkerboard"], ["iris open", "irisOpen"], ["iris close", "irisClose"],
    ["wipe left", "wipeLeft"], ["wipe right", "wipeRight"], ["wipe up", "wipeUp"], ["wipe down", "wipeDown"],
    ["barn door open", "barnDoorOpen"], ["barn door close", "barnDoorClose"],
  ] as const)("visual effect %s", (words, effect) => {
    expect(stmt(`visual effect ${words}`)).toEqual({ kind: "QueueVisualEffect", effect, speed: "normal" });
  });

  it.each([
    ["very slow", "verySlow"], ["slow", "slow"], ["normal", "normal"], ["fast", "fast"],
  ] as const)("speed %s; the word effect is optional", (words, speed) => {
    expect(stmt(`visual dissolve ${words}`)).toEqual({ kind: "QueueVisualEffect", effect: "dissolve", speed });
  });
});

describe("PutCmd and Container / FieldRef", () => {
  it.each(["into", "after", "before"] as const)("put ... %s", (mode) => {
    expect(stmt(`put "x" ${mode} it`)).toEqual({ kind: "PutValue", mode, value: lit("x"), destination: varTarget("it") });
  });

  it.each([
    ['field "Name"', field("background", lit("Name"))],
    ["fld 2", field("background", lit(2))],
    ["bg field x", field("background", v("x"))],
    ["bkgnd fld 1", field("background", lit(1))],
    ['background field "a"', field("background", lit("a"))],
    ["card field 1", field("card", lit(1))],
    ['cd fld id "prt_7"', field("card", lit("prt_7"), "id")],
  ] as const)("field container %s", (ref, destination) => {
    expect(stmt(`put 1 into ${ref}`)).toEqual({ kind: "PutValue", mode: "into", value: lit(1), destination });
  });
});

describe("GetCmd", () => {
  it("parses get Expression", () => {
    expect(stmt("get 1 + 2")).toEqual({ kind: "GetValue", value: bin("+", lit(1), lit(2)) });
  });
});

describe("MathCmd", () => {
  it("parses add, subtract, multiply and divide", () => {
    expect(body([
      "add 5 to score",
      'subtract 1 from field "Lives"',
      "multiply x by 2 + 1",
      "divide card field 1 by 3",
    ].join("\n"))).toEqual([
      { kind: "MathMutation", op: "add", amount: lit(5), destination: varTarget("score") },
      { kind: "MathMutation", op: "subtract", amount: lit(1), destination: field("background", lit("Lives")) },
      { kind: "MathMutation", op: "multiply", amount: bin("+", lit(2), lit(1)), destination: varTarget("x") },
      { kind: "MathMutation", op: "divide", amount: lit(3), destination: field("card", lit(1)) },
    ]);
  });
});

describe("SetCmd and ObjectRef", () => {
  const set = (target: unknown, property = "name", value: HexExprNode = lit("x")) =>
    ({ kind: "SetProperty", property, target, value });

  it("parses every ObjectRef form", () => {
    expect(stmt('set the name of me to "x"')).toEqual(set({ objectType: "me" }));
    expect(stmt("set hilite of button 1 to true")).toEqual(
      set({ objectType: "button", layer: "card", selector: { by: "auto", value: lit(1) } }, "hilite", lit(true)));
    expect(stmt('set the visible of bg btn "Next" to false')).toEqual(
      set({ objectType: "button", layer: "background", selector: { by: "auto", value: lit("Next") } }, "visible", lit(false)));
    expect(stmt('set the textFont of fld id "prt_3" to "x"')).toEqual(
      set({ objectType: "field", layer: "background", selector: { by: "id", value: lit("prt_3") } }, "textFont"));
    expect(stmt("set the marked of this card to true")).toEqual(set({ objectType: "card" }, "marked", lit(true)));
    expect(stmt('set the name of card 2 to "x"')).toEqual(set({ objectType: "card", selector: { by: "auto", value: lit(2) } }));
    expect(stmt('set the name of card id "crd_1" to "x"')).toEqual(
      set({ objectType: "card", selector: { by: "id", value: lit("crd_1") } }));
    expect(stmt('set the name of this background to "x"')).toEqual(set({ objectType: "background" }));
    expect(stmt('set the name of this bg to "x"')).toEqual(set({ objectType: "background" }));
    expect(stmt('set the name of this stack to "x"')).toEqual(set({ objectType: "stack" }));
  });

  it('reads "card field ..." as the card-layer field and "card bg field ..." as a card selected by a field', () => {
    expect(stmt('set the textSize of card field 1 to 12')).toEqual(
      set({ objectType: "field", layer: "card", selector: { by: "auto", value: lit(1) } }, "textSize", lit(12)));
    expect(stmt('set the name of card bg field 1 to "x"')).toEqual(set({
      objectType: "card",
      selector: { by: "auto", value: { kind: "ReadContainer", source: field("background", lit(1)) } },
    }));
  });

  it("maps every property name to its camelCase AST name", () => {
    const names = [
      "name", "visible", "enabled", "hilite", "title", "showName", "autoHilite", "location", "rect",
      "style", "lockText", "textAlign", "textFont", "textSize", "textStyle", "marked",
    ];
    for (const name of names) {
      const statement = stmt(`set the ${name.toLowerCase()} of me to 1`);
      expect(statement).toMatchObject({ kind: "SetProperty", property: name });
    }
  });
});

describe("PlayCmd", () => {
  it("defaults the tempo to 120 and accepts quoted voice names", () => {
    expect(stmt('play harpsichord "c d e"')).toEqual({ kind: "PlaySound", voice: "harpsichord", tempo: 120, notes: "c d e" });
    expect(stmt('play "Boing" tempo 200 "c4q"')).toEqual({ kind: "PlaySound", voice: "boing", tempo: 200, notes: "c4q" });
  });

  it("accepts the tempo bounds 20 and 400", () => {
    expect(stmt('play square8bit tempo 20 "a"')).toMatchObject({ tempo: 20 });
    expect(stmt('play flute tempo 400 "a"')).toMatchObject({ tempo: 400 });
    expect(stmt('play click tempo 99.5 ""')).toMatchObject({ tempo: 99.5, notes: "" });
  });
});

describe("AnswerCmd (Requirement 1.5)", () => {
  it("parses a prompt without buttons", () => {
    expect(stmt('answer "Hi"')).toEqual({ kind: "ShowAnswerDialog", prompt: lit("Hi"), buttons: [] });
  });

  it('uses "or" to separate up to three ConcatExpr buttons', () => {
    expect(stmt('answer "Ready?" with "Yes" or "No" or "Maybe"')).toEqual({
      kind: "ShowAnswerDialog", prompt: lit("Ready?"), buttons: [lit("Yes"), lit("No"), lit("Maybe")],
    });
    expect(stmt('answer "Q" with "a" & x or ("b" or "c")')).toEqual({
      kind: "ShowAnswerDialog", prompt: lit("Q"), buttons: [bin("&", lit("a"), v("x")), bin("or", lit("b"), lit("c"))],
    });
  });

  it('treats "or" in the prompt as the boolean operator', () => {
    expect(stmt('answer a or b with "OK"')).toEqual({ kind: "ShowAnswerDialog", prompt: bin("or", v("a"), v("b")), buttons: [lit("OK")] });
  });
});

describe("AskCmd", () => {
  it("parses ask with and without a default answer", () => {
    expect(stmt('ask "Name?"')).toEqual({ kind: "ShowAskDialog", prompt: lit("Name?") });
    expect(stmt('ask "Name?" with "Bob" or x')).toEqual({ kind: "ShowAskDialog", prompt: lit("Name?"), defaultAnswer: bin("or", lit("Bob"), v("x")) });
  });
});

describe("WaitCmd", () => {
  it.each([
    ["wait 10", "ticks"], ["wait 1 tick", "ticks"], ["wait 5 ticks", "ticks"],
    ["wait 1 second", "seconds"], ["wait 2 seconds", "seconds"],
  ] as const)("%s", (source, unit) => {
    expect(stmt(source)).toMatchObject({ kind: "Wait", unit });
  });
});

describe("FetchCmd", () => {
  it("parses fetch with and without a JSON path", () => {
    expect(stmt('fetch "https://api.example.com" into weather')).toEqual({
      kind: "FetchJson", url: lit("https://api.example.com"), destination: varTarget("weather"),
    });
    expect(stmt('fetch base & "/v1" at "daily.time[0]" into card field "Temp"')).toEqual({
      kind: "FetchJson", url: bin("&", v("base"), lit("/v1")), jsonPath: "daily.time[0]", destination: field("card", lit("Temp")),
    });
  });
});

describe("GlobalCmd", () => {
  it("lowercases every declared name", () => {
    expect(stmt("global score, Lives")).toEqual({ kind: "DeclareGlobal", names: ["score", "lives"] });
  });
});

describe("IfStmt", () => {
  it("parses the single-line form without else", () => {
    expect(stmt("if x then go next")).toEqual({
      kind: "IfCondition", condition: v("x"), thenBranch: [{ kind: "GoToCard", target: { type: "relative", dir: "next" } }],
    });
  });

  it("parses the block form with and without else", () => {
    expect(body("if x then\n  get 1\n  get 2\nend if")).toEqual([
      { kind: "IfCondition", condition: v("x"), thenBranch: [{ kind: "GetValue", value: lit(1) }, { kind: "GetValue", value: lit(2) }] },
    ]);
    expect(body("if x then\n  get 1\nelse\n  get 2\nend if")).toEqual([{
      kind: "IfCondition", condition: v("x"),
      thenBranch: [{ kind: "GetValue", value: lit(1) }], elseBranch: [{ kind: "GetValue", value: lit(2) }],
    }]);
    expect(body("if x then\nelse\nend if")).toEqual([{ kind: "IfCondition", condition: v("x"), thenBranch: [], elseBranch: [] }]);
  });

  it("binds else to the enclosing block when the inner if is single-line", () => {
    expect(body("if a then\n  if b then get 1\nelse\n  get 2\nend if")).toEqual([{
      kind: "IfCondition", condition: v("a"),
      thenBranch: [{ kind: "IfCondition", condition: v("b"), thenBranch: [{ kind: "GetValue", value: lit(1) }] }],
      elseBranch: [{ kind: "GetValue", value: lit(2) }],
    }]);
  });

  it("allows a block statement as the single-line branch", () => {
    expect(body("if a then repeat 2\n  get 1\nend repeat")).toEqual([{
      kind: "IfCondition", condition: v("a"),
      thenBranch: [{ kind: "RepeatLoop", head: { type: "count", times: lit(2) }, body: [{ kind: "GetValue", value: lit(1) }] }],
    }]);
  });
});

describe("RepeatBlock / RepeatHead", () => {
  const loop = (head: string) => {
    const statement = stmt(`repeat ${head}\n  next repeat\nend repeat`);
    if (statement.kind !== "RepeatLoop") throw new Error("expected RepeatLoop");
    expect(statement.body).toEqual([{ kind: "NextRepeat" }]);
    return statement.head;
  };

  it("parses every head form", () => {
    expect(loop("")).toEqual({ type: "forever" });
    expect(loop("forever")).toEqual({ type: "forever" });
    expect(loop("5")).toEqual({ type: "count", times: lit(5) });
    expect(loop("5 times")).toEqual({ type: "count", times: lit(5) });
    expect(loop("for n times")).toEqual({ type: "count", times: v("n") });
    expect(loop("while x < 3")).toEqual({ type: "while", condition: bin("<", v("x"), lit(3)) });
    expect(loop("until done")).toEqual({ type: "until", condition: v("done") });
    expect(loop("with i = 1 to 10")).toEqual({ type: "range", varName: "i", start: lit(1), end: lit(10), direction: "up" });
    expect(loop("with I = n down to 1")).toEqual({ type: "range", varName: "i", start: v("n"), end: lit(1), direction: "down" });
  });
});

describe("PassCmd, ExitCmd, NextRepeatCmd", () => {
  it("parses pass, exit repeat, exit <handler> and next repeat", () => {
    expect(body("repeat\n  exit repeat\n  next repeat\nend repeat\nexit MouseUp\npass mouseUP")).toEqual([
      { kind: "RepeatLoop", head: { type: "forever" }, body: [{ kind: "ExitRepeat" }, { kind: "NextRepeat" }] },
      { kind: "ExitHandler" },
      { kind: "PassEvent", eventName: "mouseup" },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------------------------

describe("Expression precedence and associativity", () => {
  it.each([
    ["1 + 2 * 3", bin("+", lit(1), bin("*", lit(2), lit(3)))],
    ["(1 + 2) * 3", bin("*", bin("+", lit(1), lit(2)), lit(3))],
    ["1 - 2 - 3", bin("-", bin("-", lit(1), lit(2)), lit(3))],
    ["8 / 4 div 2 mod 3", bin("mod", bin("div", bin("/", lit(8), lit(4)), lit(2)), lit(3))],
    ['"a" & "b" && "c"', bin("&&", bin("&", lit("a"), lit("b")), lit("c"))],
    ["x & y + 1", bin("&", v("x"), bin("+", v("y"), lit(1)))],
    ["a contains b & c", bin("contains", v("a"), bin("&", v("b"), v("c")))],
    ["a or b and c", bin("or", v("a"), bin("and", v("b"), v("c")))],
    ["a = 1 or b < 2 and c >= 3", bin("or", bin("=", v("a"), lit(1)), bin("and", bin("<", v("b"), lit(2)), bin(">=", v("c"), lit(3))))],
    ["not a and b", bin("and", { kind: "UnaryOp", op: "not", operand: v("a") }, v("b"))],
    ["- 5 * 2", bin("*", { kind: "UnaryOp", op: "-", operand: lit(5) }, lit(2))],
    ["4 - -x", bin("-", lit(4), { kind: "UnaryOp", op: "-", operand: v("x") })],
    ["not not x", { kind: "UnaryOp", op: "not", operand: { kind: "UnaryOp", op: "not", operand: v("x") } }],
    ["(a = b) = c", bin("=", bin("=", v("a"), v("b")), v("c"))],
  ] as const)("%s", (source, expected) => {
    expect(expr(source)).toEqual(expected);
  });

  it.each([
    ["a = b", "="], ["a is b", "="], ["a <> b", "<>"], ["a is not b", "<>"], ["a < b", "<"],
    ["a > b", ">"], ["a <= b", "<="], ["a >= b", ">="], ["a contains b", "contains"],
  ] as const)("comparison %s", (source, op) => {
    expect(expr(source)).toEqual(bin(op, v("a"), v("b")));
  });

  it('reads "is not" as one operator and "= not" as equality with a negation', () => {
    expect(expr("a is not b")).toEqual(bin("<>", v("a"), v("b")));
    expect(expr("a = not b")).toEqual(bin("=", v("a"), { kind: "UnaryOp", op: "not", operand: v("b") }));
  });
});

describe("Primary", () => {
  it("parses literals and constants", () => {
    expect(expr("42")).toEqual(lit(42));
    expect(expr("007.50")).toEqual(lit(7.5));
    expect(expr('""')).toEqual(lit(""));
    expect(expr("true")).toEqual(lit(true));
    expect(expr("FALSE")).toEqual(lit(false));
    for (const name of ["empty", "quote", "return", "space", "tab"]) {
      expect(expr(name)).toEqual({ kind: "Constant", name });
    }
  });

  it("parses function calls in both forms", () => {
    expect(expr("random(6)")).toEqual({ kind: "FunctionCall", name: "random", args: [lit(6)] });
    expect(expr("max(1, 2, x)")).toEqual({ kind: "FunctionCall", name: "max", args: [lit(1), lit(2), v("x")] });
    expect(expr("min()")).toEqual({ kind: "FunctionCall", name: "min", args: [] });
    expect(expr("the random of 6")).toEqual({ kind: "FunctionCall", name: "random", args: [lit(6)] });
    expect(expr('the length of field "Name"')).toEqual({
      kind: "FunctionCall", name: "length", args: [{ kind: "ReadContainer", source: field("background", lit("Name")) }],
    });
    expect(expr("the abs of x + 1")).toEqual(bin("+", { kind: "FunctionCall", name: "abs", args: [v("x")] }, lit(1)));
    for (const name of ["round", "trunc"]) {
      expect(expr(`${name}(1.5)`)).toEqual({ kind: "FunctionCall", name, args: [lit(1.5)] });
    }
  });

  it("parses built-ins", () => {
    for (const name of ["date", "time", "ticks", "seconds", "mouseH", "mouseV"]) {
      expect(expr(`the ${name}`)).toEqual({ kind: "BuiltIn", name });
    }
    expect(expr("the number of cards")).toEqual({ kind: "BuiltIn", name: "numberOfCards" });
    expect(expr("the number of this card")).toEqual({ kind: "BuiltIn", name: "cardNumber" });
  });

  it("parses property reads, field reads and variables", () => {
    expect(expr("the name of me")).toEqual({ kind: "ReadProperty", property: "name", target: { objectType: "me" } });
    expect(expr("the location of card button 2")).toEqual({
      kind: "ReadProperty", property: "location",
      target: { objectType: "button", layer: "card", selector: { by: "auto", value: lit(2) } },
    });
    expect(expr("field 1 & card fld id x")).toEqual(bin("&",
      { kind: "ReadContainer", source: field("background", lit(1)) },
      { kind: "ReadContainer", source: field("card", v("x"), "id") }));
    expect(expr("It")).toEqual(v("it"));
  });
});

// ---------------------------------------------------------------------------------------------
// Errors (Requirements 1.1, 1.2, 1.4)
// ---------------------------------------------------------------------------------------------

describe("compile errors and recovery (Requirement 1.2)", () => {
  it("returns errors with 1-based line and column instead of throwing", () => {
    expect(errorsOf("on mouseUp\n  put 1 into\nend mouseUp")).toEqual([
      { line: 2, column: 13, message: "expected a variable or a field but found the end of the line" },
    ]);
  });

  it("drops the failing handler, recovers at its end line and keeps the others", () => {
    const source = [
      "on openCard",          // 1
      "  get 1",              // 2
      "end openCard",         // 3
      "on mouseUp",           // 4
      "  beep",               // 5: unknown command
      "  if x then",          // 6
      "end mouseUp",          // 7
      "on closeCard",         // 8
      "  get 2 +",            // 9: missing operand
      "end closeCard",        // 10
      "on idle",              // 11
      "  get 3",              // 12
      "end idle",             // 13
    ].join("\n");
    const { ast, errors } = parseHexTalk(source);
    expect(errors).toEqual([
      { line: 5, column: 3, message: 'unknown command "beep"' },
      { line: 9, column: 10, message: "expected an expression but found the end of the line" },
    ]);
    expect(Object.keys(ast.handlers)).toEqual(["opencard", "idle"]);
    expectValid(ast);
  });

  it("recovers at the handler's own end line when a block is not closed", () => {
    const { ast, errors } = parseHexTalk("on mouseUp\n  if x then\n    get 1\nend mouseUp\non idle\nend idle");
    expect(errors).toEqual([{ line: 4, column: 5, message: 'expected "end if" but found "end mouseUp"' }]);
    expect(Object.keys(ast.handlers)).toEqual(["idle"]);
  });

  it("reports text outside handlers and continues at the next on line", () => {
    const { ast, errors } = parseHexTalk('put 1 into x\nget 2\non idle\nend idle\nend idle');
    expect(errors).toEqual([
      { line: 1, column: 1, message: 'expected "on <handlerName>" but found "put"' },
      { line: 5, column: 1, message: 'expected "on <handlerName>" but found "end"' },
    ]);
    expect(Object.keys(ast.handlers)).toEqual(["idle"]);
  });

  it("reports a missing end at the end of the script", () => {
    expect(errorsOf("on mouseUp\n  get 1\n")).toEqual([
      { line: 3, column: 1, message: 'missing "end mouseUp" for the handler on line 1' },
    ]);
    expect(errorsOf("on mouseUp\n  get 1\non idle\nend idle")).toEqual([
      { line: 3, column: 1, message: 'missing "end mouseUp" before the next handler' },
    ]);
  });

  it("reports bad handler headers", () => {
    expect(errorsOf("on if\nend if")[0]).toEqual({ line: 1, column: 4, message: '"if" is a reserved word and cannot be used as a handler name' });
    expect(errorsOf("on mouseUp a b\nend mouseUp")[0]).toMatchObject({ line: 1, column: 14 });
    expect(errorsOf("on mouseUp a,\nend mouseUp")[0]).toMatchObject({ line: 1, column: 14 });
  });

  it("reports a duplicate handler at the second on line", () => {
    const { ast, errors } = parseHexTalk("on mouseUp\n  get 1\nend mouseUp\non MOUSEUP\n  get 2\nend MOUSEUP");
    expect(errors).toEqual([{ line: 4, column: 4, message: 'handler "MOUSEUP" is already defined in this script' }]);
    expect(stripLoc(ast.handlers.mouseup.body)).toEqual([{ kind: "GetValue", value: lit(1) }]);
  });

  it("reports lexical errors", () => {
    expect(bodyErrors('  put "abc into x')[0]).toEqual({
      line: 2, column: 7, message: 'unterminated string (a string must end with " on the same line)',
    });
    expect(bodyErrors("  put 1 % 2 into x")[0]).toEqual({ line: 2, column: 9, message: 'unexpected character "%"' });
    expect(bodyErrors("  put _x into y")[0]).toMatchObject({ message: 'unexpected character "_"' });
    expect(bodyErrors("  put 1. into y")[0]).toMatchObject({ message: 'unexpected character "."' });
  });

  it("rejects reserved words as identifiers", () => {
    expect(bodyErrors("  put 1 into name")[0]).toMatchObject({ message: 'expected a variable or a field but found "name"' });
    expect(bodyErrors("  global card")[0]).toMatchObject({ message: '"card" is a reserved word and cannot be used as a variable name' });
    expect(bodyErrors("  get into")[0]).toMatchObject({ message: 'expected an expression but found "into"' });
  });

  it("rejects the unsupported else forms", () => {
    expect(bodyErrors("  if x then get 1 else get 2")[0]).toMatchObject({ line: 2, column: 19, message: 'expected the end of the line but found "else"' });
    expect(bodyErrors("  if x then\n    get 1\n  else get 2\n  end if")[0]).toMatchObject({ line: 4, column: 8 });
    expect(bodyErrors("  else")[0]).toMatchObject({ line: 2, column: 3, message: '"else" without a matching "if"' });
  });

  it("never throws on deeply nested or malformed input", () => {
    const deep = `on a\n  get ${"(".repeat(50_000)}1${")".repeat(50_000)}\nend a\non b\nend b`;
    const result = parseHexTalk(deep);
    expect(result.errors).toEqual([expect.objectContaining({ line: 2, message: "script is nested too deeply" })]);
    expect(Object.keys(result.ast.handlers)).toEqual(["b"]);
    for (const junk of ["end", "on", "on mouseUp\nend", "\"", "on x\n  if\nend x", "on x\n  repeat with\nend x", "))((", "on x\n  play\nend x"]) {
      expect(() => parseHexTalk(junk)).not.toThrow();
      expect(parseHexTalk(junk).errors.length).toBeGreaterThan(0);
    }
  });
});

describe("handler-name, pass and exit checks (Requirement 1.4)", () => {
  it("reports a closing name that differs from the opening name at that line", () => {
    const { ast, errors } = parseHexTalk("on mouseUp\n  get 1\nend mouseDown");
    expect(errors).toEqual([{ line: 3, column: 5, message: 'expected "end mouseUp" but found "end mouseDown"' }]);
    expect(ast.handlers).toEqual({});
  });

  it("reports pass naming a foreign message at that line", () => {
    expect(bodyErrors("  get 1\n  pass mouseDown")).toEqual([
      { line: 3, column: 8, message: 'pass must name the enclosing handler "mouseUp", not "mouseDown"' },
    ]);
    expect(errorsOf("on openCard\n  if x then\n    pass closeCard\n  end if\nend openCard")).toEqual([
      { line: 3, column: 10, message: 'pass must name the enclosing handler "openCard", not "closeCard"' },
    ]);
  });

  it("reports exit naming a foreign handler at that line", () => {
    expect(bodyErrors("  exit foo")).toEqual([
      { line: 2, column: 8, message: 'exit must name the enclosing handler "mouseUp" or "repeat", not "foo"' },
    ]);
  });
});

describe("comparison is non-associative", () => {
  it.each(["a = b = c", "a < b is c", "a contains b <> c", "a = b & c = d", "x and a is not b = c"])("%s", (source) => {
    expect(bodyErrors(`  get ${source}`)).toEqual([
      expect.objectContaining({ line: 2, message: "comparisons cannot be chained; use parentheses" }),
    ]);
  });

  it("allows comparisons separated by and/or or parentheses", () => {
    expect(expr("a = b and c = d")).toEqual(bin("and", bin("=", v("a"), v("b")), bin("=", v("c"), v("d"))));
    expect(expr("a = (b = c)")).toEqual(bin("=", v("a"), bin("=", v("b"), v("c"))));
  });
});

describe("answer button limits (Requirement 1.5)", () => {
  it("rejects a fourth button", () => {
    expect(bodyErrors('  answer "Q" with "a" or "b" or "c" or "d"')).toEqual([
      { line: 2, column: 37, message: "answer accepts at most 3 buttons" },
    ]);
  });

  it("rejects a comparison as a button without parentheses", () => {
    expect(bodyErrors('  answer "Q" with a = b')).toEqual([
      expect.objectContaining({ message: 'expected the end of the line but found "="' }),
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Parser output always passes the AST validator
// ---------------------------------------------------------------------------------------------

describe("every AST parsed without errors passes validateAst", () => {
  const corpus = [
    [
      "on mouseUp",
      "  global score",
      "  visual effect dissolve fast",
      "  go to next card",
      '  put "Hello" && it into field "Name"',
      "  add -2.5 to score",
      '  set the hilite of button id "prt_1" to true',
      '  play harpsichord tempo 140 "c4e d5q"',
      '  answer "Ready?" with "Yes" or "No"',
      '  ask "Name?" with empty',
      "  wait 2 seconds",
      '  fetch "https://api.example.com/data" at "daily.time[0]" into weather',
      '  if card field 1 contains "x" then',
      "    exit mouseUp",
      "  else",
      "    pass mouseUp",
      "  end if",
      "  repeat with i = 10 down to 1",
      "    if i mod 2 = 0 then next repeat",
      "    set the name of this card to the random of 6 & quote",
      "  end repeat",
      "end mouseUp",
    ].join("\n"),
    "on constructor\n  get the number of this card\nend constructor\non toString x\n  put x into toString\nend toString",
    "on idle\n  repeat while the mouseH < 10\n    multiply bg field 2 by -1\n  end repeat\nend idle",
    `on big\n  get 99999999999999999999 + 0.0001\nend big`,
  ];

  it.each(corpus.map((source, index) => [index, source] as const))("corpus script %i", (_index, source) => {
    const { ast, errors } = parseHexTalk(source);
    expect(errors).toEqual([]);
    expectValid(ast);
  });

  it("reports what the validator would reject instead of returning it", () => {
    expect(bodyErrors('  play boing tempo 19 "c"')).toEqual([{ line: 2, column: 20, message: "tempo must be between 20 and 400" }]);
    expect(bodyErrors('  play boing tempo 400.5 "c"')).toEqual([{ line: 2, column: 20, message: "tempo must be between 20 and 400" }]);
    expect(bodyErrors(`  get 1${"0".repeat(21)}`)).toEqual([
      { line: 2, column: 7, message: `number 1${"0".repeat(21)} is outside the supported range` },
    ]);
    expect(bodyErrors("  get 0.0000001")).toEqual([{ line: 2, column: 7, message: "number 0.0000001 is outside the supported range" }]);
  });

  it("keeps the partial AST of a script with errors valid", () => {
    const { ast, errors } = parseHexTalk("on a\n  get 1\nend a\non b\n  get (\nend b");
    expect(errors).toHaveLength(1);
    expectValid(ast);
  });
});
