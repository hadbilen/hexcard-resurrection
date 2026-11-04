/**
 * Spec 02 task 3: `printHexTalk` and the round-trip guarantees of hexcard_design_spec.md §4.2
 * (Requirements 2.1-2.3).
 * - Golden tests for the canonical form: normalisation table, block layout, minimal parentheses.
 * - Property tests (fast-check):
 *   1. every AST accepted by `validateAst`: `parse(print(A))` deep-equals `A` (ignoring `loc`);
 *   2. every source `S` that parses without errors: `parse(print(parse(S)))` deep-equals `parse(S)`.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type {
  HexCardTarget,
  HexContainerTarget,
  HexExprNode,
  HexHandlerNode,
  HexObjectTarget,
  HexPartSelector,
  HexRepeatHead,
  HexScriptAST,
  HexStatementNode,
} from "../ast.ts";
import { HEX_RESERVED_WORDS, validateAst } from "../astValidator.ts";
import { parseHexTalk, printHexTalk } from "../parser.ts";

// Per-test budget for the heavy property tests, so CPU contention in the parallel suite cannot time them out.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

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

function parseOk(source: string): HexScriptAST {
  const { ast, errors } = parseHexTalk(source);
  expect(errors).toEqual([]);
  return stripLoc(ast);
}

/** The canonical form of a source that must compile cleanly. */
const canonical = (source: string): string => printHexTalk(parseHexTalk(source).ast);

const script = (body: HexStatementNode[]): HexScriptAST =>
  ({ handlers: { h: { eventName: "h", params: [], body } } });

/** Prints one statement inside `on h`, checks that it parses back unchanged, returns its line. */
function printedStatement(statement: HexStatementNode): string {
  const source = printHexTalk(script([statement]));
  expect(parseOk(source)).toEqual(script([statement]));
  const lines = source.split("\n");
  expect(lines).toHaveLength(4); // "on h", the statement, "end h", ""
  return lines[1].slice(2);
}

const printedExpr = (e: HexExprNode): string => printedStatement({ kind: "GetValue", value: e }).slice("get ".length);

type BinaryOp = Extract<HexExprNode, { kind: "BinaryOp" }>["op"];
const lit = (value: string | number | boolean): HexExprNode => ({ kind: "Literal", value });
const v = (name: string): HexExprNode => ({ kind: "Variable", name });
const bin = (op: BinaryOp, left: HexExprNode, right: HexExprNode): HexExprNode => ({ kind: "BinaryOp", op, left, right });
const un = (op: "not" | "-", operand: HexExprNode): HexExprNode => ({ kind: "UnaryOp", op, operand });
const read = (layer: "card" | "background", value: HexExprNode): HexExprNode =>
  ({ kind: "ReadContainer", source: { scope: "field", layer, selector: { by: "auto", value } } });

// ---------------------------------------------------------------------------------------------
// Golden tests: canonical form (Requirement 2.1)
// ---------------------------------------------------------------------------------------------

describe("printHexTalk canonical form (Requirement 2.1)", () => {
  it("prints an empty script as an empty string", () => {
    expect(printHexTalk({ handlers: {} })).toBe("");
  });

  it("normalises synonyms, optional words and defaults", () => {
    const source = [
      "on mouseUp",
      "  if x is 1 then go previous",
      "  if x is not 1 then go to Back",
      "  go next",
      "  put fld 1 into bkgnd field 2",
      '  put background fld "a" after cd field 3',
      "  set hilite of btn 1 to true",
      '  set the name of this background to "B"',
      "  visual dissolve",
      '  play "Boing" "c"',
      "  wait 5 tick",
      "  wait 1 second",
      "  wait 2",
      "  repeat for 3",
      "  end repeat",
      "  repeat",
      "  end repeat",
      "  get the random of 6",
      "end MOUSEUP",
    ].join("\n");
    expect(canonical(source)).toBe([
      "on mouseUp",
      "  if x = 1 then",
      "    go to prev card",
      "  end if",
      "  if x <> 1 then",
      "    go back",
      "  end if",
      "  go to next card",
      "  put bg field 1 into bg field 2",
      '  put bg field "a" after card field 3',
      "  set the hilite of card button 1 to true",
      '  set the name of this bg to "B"',
      "  visual effect dissolve normal",
      '  play boing tempo 120 "c"',
      "  wait 5 ticks",
      "  wait 1 seconds",
      "  wait 2 ticks",
      "  repeat 3 times",
      "  end repeat",
      "  repeat forever",
      "  end repeat",
      "  get random(6)",
      "end mouseUp",
      "",
    ].join("\n"));
  });

  it("lays out handlers and nested blocks with 2-space indentation", () => {
    const source = [
      "on openCard",
      "end openCard",
      "-- a comment",
      "",
      "on MouseDown a,b",
      "  global g, h",
      "  repeat with i = 10 down to 1",
      "    if i mod 2 = 0 then",
      "      next repeat",
      "    else",
      "      exit repeat",
      "    end if",
      "  end repeat",
      '  fetch "https://x.test/a" at "a.b[0]" into it',
      '  answer "Q?" with "Yes" or "No"',
      '  ask "Name?" with empty',
      "  pass mousedown",
      "  exit MOUSEDOWN",
      "end mousedown",
    ].join("\n");
    expect(canonical(source)).toBe([
      "on openCard",
      "end openCard",
      "",
      "on MouseDown a, b",
      "  global g, h",
      "  repeat with i = 10 down to 1",
      "    if i mod 2 = 0 then",
      "      next repeat",
      "    else",
      "      exit repeat",
      "    end if",
      "  end repeat",
      '  fetch "https://x.test/a" at "a.b[0]" into it',
      '  answer "Q?" with "Yes" or "No"',
      '  ask "Name?" with empty',
      "  pass MouseDown",
      "  exit MouseDown",
      "end MouseDown",
      "",
    ].join("\n"));
  });

  it("prints every visual effect, speed, built-in and object reference", () => {
    expect(printedStatement({ kind: "QueueVisualEffect", effect: "barnDoorClose", speed: "verySlow" }))
      .toBe("visual effect barn door close very slow");
    expect(printedStatement({ kind: "QueueVisualEffect", effect: "venetianBlinds", speed: "fast" }))
      .toBe("visual effect venetian blinds fast");
    expect(printedExpr({ kind: "BuiltIn", name: "numberOfCards" })).toBe("the number of cards");
    expect(printedExpr({ kind: "BuiltIn", name: "cardNumber" })).toBe("the number of this card");
    expect(printedExpr({ kind: "BuiltIn", name: "mouseH" })).toBe("the mouseH");
    const property = (target: HexObjectTarget): string =>
      printedExpr({ kind: "ReadProperty", property: "textSize", target });
    expect(property({ objectType: "me" })).toBe("the textSize of me");
    expect(property({ objectType: "card" })).toBe("the textSize of this card");
    expect(property({ objectType: "background" })).toBe("the textSize of this bg");
    expect(property({ objectType: "stack" })).toBe("the textSize of this stack");
    expect(property({ objectType: "button", layer: "background", selector: { by: "id", value: lit("prt_1") } }))
      .toBe('the textSize of bg button id "prt_1"');
  });

  it("keeps the layer word of a field that selects a card by its text", () => {
    const setName = (value: HexExprNode): string => printedStatement({
      kind: "SetProperty",
      property: "name",
      target: { objectType: "card", selector: { by: "auto", value } },
      value: lit(1),
    });
    expect(setName(read("background", lit(1)))).toBe("set the name of card bg field 1 to 1");
    expect(setName(read("card", lit(1)))).toBe("set the name of card card field 1 to 1");
    expect(printedStatement({ kind: "GoToCard", target: { type: "auto", value: read("card", lit(2)) } }))
      .toBe("go to card card field 2");
  });

  it("prints literals verbatim", () => {
    expect(printedExpr(bin("&&", bin("&", bin("&", lit("a--b"), lit(0.5)), lit(1e20)), lit(true))))
      .toBe('"a--b" & 0.5 & 100000000000000000000 && true');
    expect(printedStatement({ kind: "PlaySound", voice: "square8bit", tempo: 99.5, notes: "c4e -- d" }))
      .toBe('play square8bit tempo 99.5 "c4e -- d"');
  });

  const a = v("a");
  const b = v("b");
  const c = v("c");
  const d = v("d");
  const parenthesisation: [string, HexExprNode][] = [
    ["(1 + 2) * 3", bin("*", bin("+", lit(1), lit(2)), lit(3))],
    ["1 * 2 + 3", bin("+", bin("*", lit(1), lit(2)), lit(3))],
    ["1 - 2 - 3", bin("-", bin("-", lit(1), lit(2)), lit(3))],
    ["1 - (2 - 3)", bin("-", lit(1), bin("-", lit(2), lit(3)))],
    ["a or b and c", bin("or", a, bin("and", b, c))],
    ["(a or b) and c", bin("and", bin("or", a, b), c)],
    ["a = b and c <> d", bin("and", bin("=", a, b), bin("<>", c, d))],
    ["(a = b) = c", bin("=", bin("=", a, b), c)],
    ["a < (b contains c)", bin("<", a, bin("contains", b, c))],
    ["a & b = c && d", bin("=", bin("&", a, b), bin("&&", c, d))],
    ["(a & b) + c", bin("+", bin("&", a, b), c)],
    ["a & b + c", bin("&", a, bin("+", b, c))],
    ["not (a and b)", un("not", bin("and", a, b))],
    ["not not a", un("not", un("not", a))],
    ["not a = b", bin("=", un("not", a), b)],
    ["-(1 + 2) * 3", bin("*", un("-", bin("+", lit(1), lit(2))), lit(3))],
    ["- -a", un("-", un("-", a))],
    ["1 - -2", bin("-", lit(1), un("-", lit(2)))],
    ["abs(a or b, -1)", { kind: "FunctionCall", name: "abs", args: [bin("or", a, b), un("-", lit(1))] }],
    ["bg field (1 + 1) & card field (-1)", bin("&", read("background", bin("+", lit(1), lit(1))), read("card", un("-", lit(1))))],
  ];

  it.each(parenthesisation)("adds only the parentheses precedence requires: %s", (expected, e) => {
    expect(printedExpr(e)).toBe(expected);
  });

  it("parenthesises answer buttons below concatenation level (Requirement 1.5)", () => {
    expect(printedStatement({
      kind: "ShowAnswerDialog",
      prompt: bin("or", a, b),
      buttons: [bin("or", a, b), bin("=", c, d), bin("&", a, b)],
    })).toBe("answer a or b with (a or b) or (c = d) or a & b");
  });
});

// ---------------------------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------------------------

const isFree = (word: string): boolean => !HEX_RESERVED_WORDS.has(word.toLowerCase());
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** Lowercase, non-reserved identifiers (variables, params, globals, loop variables). */
const identifierArb = fc.oneof(
  fc.constantFrom("it", "x", "score", "i", "a_1", "item2", "constructor", "tostring"),
  fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/),
).filter(isFree);

/** Handler names keep their spelling. */
const eventNameArb = fc.oneof(
  fc.constantFrom("mouseUp", "openCard", "idle", "MouseDown", "x", "hasOwnProperty"),
  fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,7}$/),
).filter(isFree);

/** String literal contents: anything except `"` and line breaks (validateAst rule). */
const stringArb = fc.oneof(
  fc.constantFrom("", "Hello", "a--b", "-- no comment", "x & y", "tab\there", "(1 + 2)", "end if", "é日🎃"),
  fc.string({ maxLength: 10 }),
  fc.string({ unit: "binary", maxLength: 10 }),
).map((s) => s.replace(/["\r\n]/g, ""));

/** Non-negative numbers whose JS string form is a HexTalk NumberLiteral (validateAst rule). */
const numberArb = fc.oneof(
  fc.nat({ max: 1000 }),
  fc.constantFrom(0.5, 2.25, 0.000001, 1e20, 0.1 + 0.2),
  fc.double({ min: 0, max: 1e9, noNaN: true }),
).filter((n) => !Object.is(n, -0) && PLAIN_DECIMAL.test(String(n)));

const layerArb = fc.constantFrom("card", "background");
const propertyArb = fc.constantFrom(
  "name", "visible", "enabled", "hilite", "title", "showName", "autoHilite", "location", "rect",
  "style", "lockText", "textAlign", "textFont", "textSize", "textStyle", "marked",
);
const functionArb = fc.constantFrom("random", "round", "trunc", "abs", "length", "min", "max");
const voiceArb = fc.constantFrom("harpsichord", "boing", "flute", "square8bit", "click");
const effectArb = fc.constantFrom(
  "cut", "dissolve", "venetianBlinds", "checkerboard", "irisOpen", "irisClose",
  "wipeLeft", "wipeRight", "wipeUp", "wipeDown", "barnDoorOpen", "barnDoorClose",
);
const binaryOpArb = fc.constantFrom<BinaryOp>(
  "or", "and", "=", "<>", "<", ">", "<=", ">=", "contains", "&", "&&", "+", "-", "*", "/", "div", "mod",
);

// ----- valid ASTs (Property 1) ---------------------------------------------------------------

const leafExprArb: fc.Arbitrary<HexExprNode> = fc.oneof(
  fc.record({ kind: fc.constant("Literal"), value: fc.oneof(stringArb, numberArb, fc.boolean()) }),
  fc.record({ kind: fc.constant("Constant"), name: fc.constantFrom("empty", "quote", "return", "space", "tab") }),
  fc.record({ kind: fc.constant("Variable"), name: identifierArb }),
  fc.record({
    kind: fc.constant("BuiltIn"),
    name: fc.constantFrom("date", "time", "ticks", "seconds", "mouseH", "mouseV", "numberOfCards", "cardNumber"),
  }),
);

type FieldTarget = Extract<HexContainerTarget, { scope: "field" }>;

const exprTree = fc.letrec<{
  expr: HexExprNode;
  selector: HexPartSelector;
  field: FieldTarget;
  object: HexObjectTarget;
}>((tie) => ({
  expr: fc.oneof(
    { maxDepth: 3, depthSize: "small" },
    leafExprArb,
    fc.record({ kind: fc.constant("BinaryOp"), op: binaryOpArb, left: tie("expr"), right: tie("expr") }),
    fc.record({ kind: fc.constant("UnaryOp"), op: fc.constantFrom("not", "-"), operand: tie("expr") }),
    fc.record({ kind: fc.constant("FunctionCall"), name: functionArb, args: fc.array(tie("expr"), { maxLength: 3 }) }),
    fc.record({ kind: fc.constant("ReadContainer"), source: tie("field") }),
    fc.record({ kind: fc.constant("ReadProperty"), property: propertyArb, target: tie("object") }),
  ),
  selector: fc.oneof(
    fc.record({ by: fc.constant("id"), value: tie("expr") }),
    fc.record({ by: fc.constant("auto"), value: tie("expr") }),
  ),
  field: fc.record({ scope: fc.constant("field"), layer: layerArb, selector: tie("selector") }),
  object: fc.oneof(
    fc.constant({ objectType: "me" }),
    fc.record({ objectType: fc.constantFrom("button", "field"), layer: layerArb, selector: tie("selector") }),
    fc.constant({ objectType: "card" }),
    fc.record({ objectType: fc.constant("card"), selector: tie("selector") }),
    fc.constant({ objectType: "background" }),
    fc.constant({ objectType: "stack" }),
  ),
}));
const exprArb = exprTree.expr;

const containerArb: fc.Arbitrary<HexContainerTarget> = fc.oneof(
  fc.record({ scope: fc.constant("variable"), name: identifierArb }),
  exprTree.field,
);

const cardTargetArb: fc.Arbitrary<HexCardTarget> = fc.oneof(
  fc.record({ type: fc.constant("relative"), dir: fc.constantFrom("next", "prev", "first", "last", "back") }),
  fc.record({ type: fc.constant("id"), value: exprArb }),
  fc.record({ type: fc.constant("auto"), value: exprArb }),
);

const repeatHeadArb: fc.Arbitrary<HexRepeatHead> = fc.oneof(
  fc.constant({ type: "forever" }),
  fc.record({ type: fc.constant("count"), times: exprArb }),
  fc.record({ type: fc.constant("while"), condition: exprArb }),
  fc.record({ type: fc.constant("until"), condition: exprArb }),
  fc.record({
    type: fc.constant("range"),
    varName: identifierArb,
    start: exprArb,
    end: exprArb,
    direction: fc.constantFrom("up", "down"),
  }),
);

/** `pass` may only name the enclosing handler; the placeholder is replaced per handler. */
const PASS_PLACEHOLDER = "";

const simpleStatementArb: fc.Arbitrary<HexStatementNode> = fc.oneof(
  fc.record({ kind: fc.constant("GoToCard"), target: cardTargetArb }),
  fc.record({
    kind: fc.constant("QueueVisualEffect"),
    effect: effectArb,
    speed: fc.constantFrom("verySlow", "slow", "normal", "fast"),
  }),
  fc.record({
    kind: fc.constant("PutValue"),
    mode: fc.constantFrom("into", "after", "before"),
    value: exprArb,
    destination: containerArb,
  }),
  fc.record({ kind: fc.constant("GetValue"), value: exprArb }),
  fc.record({
    kind: fc.constant("MathMutation"),
    op: fc.constantFrom("add", "subtract", "multiply", "divide"),
    amount: exprArb,
    destination: containerArb,
  }),
  fc.record({ kind: fc.constant("SetProperty"), property: propertyArb, target: exprTree.object, value: exprArb }),
  fc.record({
    kind: fc.constant("PlaySound"),
    voice: voiceArb,
    tempo: fc.oneof(fc.integer({ min: 20, max: 400 }), fc.double({ min: 20, max: 400, noNaN: true })),
    notes: stringArb,
  }),
  fc.record({ kind: fc.constant("ShowAnswerDialog"), prompt: exprArb, buttons: fc.array(exprArb, { maxLength: 3 }) }),
  fc.record(
    { kind: fc.constant("ShowAskDialog"), prompt: exprArb, defaultAnswer: exprArb },
    { requiredKeys: ["kind", "prompt"] },
  ),
  fc.record({ kind: fc.constant("Wait"), amount: exprArb, unit: fc.constantFrom("ticks", "seconds") }),
  fc.record(
    {
      kind: fc.constant("FetchJson"),
      url: exprArb,
      jsonPath: fc.oneof(fc.constantFrom("current.temperature_2m", "daily.time[0]"), stringArb),
      destination: containerArb,
    },
    { requiredKeys: ["kind", "url", "destination"] },
  ),
  fc.record({ kind: fc.constant("DeclareGlobal"), names: fc.array(identifierArb, { minLength: 1, maxLength: 3 }) }),
  fc.constant({ kind: "PassEvent", eventName: PASS_PLACEHOLDER }),
  fc.constant({ kind: "ExitHandler" }),
  fc.constant({ kind: "ExitRepeat" }),
  fc.constant({ kind: "NextRepeat" }),
);

const statementTree = fc.letrec<{ statement: HexStatementNode; block: HexStatementNode[] }>((tie) => ({
  statement: fc.oneof(
    { maxDepth: 2, depthSize: "small" },
    simpleStatementArb,
    fc.record(
      { kind: fc.constant("IfCondition"), condition: exprArb, thenBranch: tie("block"), elseBranch: tie("block") },
      { requiredKeys: ["kind", "condition", "thenBranch"] },
    ),
    fc.record({ kind: fc.constant("RepeatLoop"), head: repeatHeadArb, body: tie("block") }),
  ),
  block: fc.array(tie("statement"), { maxLength: 4 }),
}));

/** Points every `pass` at the enclosing handler (without mutating shared generator values). */
function namePasses(statements: readonly HexStatementNode[], key: string): HexStatementNode[] {
  return statements.map((s): HexStatementNode => {
    switch (s.kind) {
      case "PassEvent":
        return { ...s, eventName: key };
      case "IfCondition":
        return s.elseBranch === undefined
          ? { ...s, thenBranch: namePasses(s.thenBranch, key) }
          : { ...s, thenBranch: namePasses(s.thenBranch, key), elseBranch: namePasses(s.elseBranch, key) };
      case "RepeatLoop":
        return { ...s, body: namePasses(s.body, key) };
      default:
        return s;
    }
  });
}

const astArb: fc.Arbitrary<HexScriptAST> = fc.uniqueArray(
  fc.record({
    eventName: eventNameArb,
    params: fc.array(identifierArb, { maxLength: 3 }),
    body: fc.array(statementTree.statement, { maxLength: 5 }),
  }),
  { selector: (handler) => handler.eventName.toLowerCase(), minLength: 1, maxLength: 3 },
).map((handlers) => ({
  handlers: Object.fromEntries(handlers.map((handler): [string, HexHandlerNode] => {
    const key = handler.eventName.toLowerCase();
    return [key, { ...handler, body: namePasses(handler.body, key) }];
  })),
}));

// ----- valid HexTalk sources (Property 2) ----------------------------------------------------
// Sources are written in lowercase with every synonym, optional word, omitted default, redundant
// parenthesis and the single-line `if`; comments, blank lines, CRLF and letter case are varied last.

const opt = (text: string): fc.Arbitrary<string> => fc.constantFrom("", text);

const COMPARE_WORDS: ReadonlySet<string> = new Set(["=", "is", "<>", "is not", "<", ">", "<=", ">=", "contains"]);
const LOGIC_WORDS: ReadonlySet<string> = new Set(["and", "or"]);
const CONCAT_LEVEL_WORDS = ["&", "&&", "+", "-", "*", "/", "div", "mod"] as const;
const OPERATOR_WORDS = [...LOGIC_WORDS, ...COMPARE_WORDS, ...CONCAT_LEVEL_WORDS];
const LAYER_PREFIXES = ["", "card ", "cd ", "bg ", "bkgnd ", "background "] as const;

/**
 * Joins unary operands with binary operators. Comparison is non-associative (§4.1): a comparison
 * that would follow another one without an intervening `and`/`or` is replaced by `&`.
 */
function joinOperands(first: string, rest: readonly (readonly [string, string])[]): string {
  let text = first;
  let comparisonOpen = false;
  for (const [op, operand] of rest) {
    let word = op;
    if (LOGIC_WORDS.has(op)) {
      comparisonOpen = false;
    } else if (COMPARE_WORDS.has(op)) {
      if (comparisonOpen) word = "&";
      comparisonOpen = true;
    }
    text += ` ${word} ${operand}`;
  }
  return text;
}

const sourceLeafArb = fc.oneof(
  fc.stringMatching(/^[0-9]{1,6}(\.[0-9]{1,4})?$/),
  stringArb.map((s) => `"${s}"`),
  fc.constantFrom("empty", "true", "false", "quote", "return", "space", "tab"),
  identifierArb,
  fc.constantFrom(
    "the date", "the time", "the ticks", "the seconds", "the mouseH", "the mouseV",
    "the number of cards", "the number of this card",
  ),
);

const sourceTree = fc.letrec<{
  expr: string;
  concat: string;
  unary: string;
  primary: string;
  selector: string;
  fieldRef: string;
  objectRef: string;
}>((tie) => ({
  primary: fc.oneof(
    { maxDepth: 5, depthSize: "small", depthIdentifier: "source-expr" },
    sourceLeafArb,
    tie("expr").map((e) => `(${e})`),
    fc.tuple(functionArb, fc.array(tie("expr"), { maxLength: 3 })).map(([f, args]) => `${f}(${args.join(", ")})`),
    fc.tuple(functionArb, tie("primary")).map(([f, p]) => `the ${f} of ${p}`),
    fc.tuple(propertyArb, tie("objectRef")).map(([p, o]) => `the ${p} of ${o}`),
    tie("fieldRef"),
  ),
  unary: fc.oneof(
    { maxDepth: 5, depthSize: "small", depthIdentifier: "source-expr" },
    tie("primary"),
    tie("unary").map((u) => `not ${u}`),
    tie("unary").map((u) => (u.startsWith("-") ? `- ${u}` : `-${u}`)), // "--" would start a comment
  ),
  expr: fc.tuple(tie("unary"), fc.array(fc.tuple(fc.constantFrom(...OPERATOR_WORDS), tie("unary")), { maxLength: 3 }))
    .map(([first, rest]) => joinOperands(first, rest)),
  concat: fc.tuple(tie("unary"), fc.array(fc.tuple(fc.constantFrom(...CONCAT_LEVEL_WORDS), tie("unary")), { maxLength: 2 }))
    .map(([first, rest]) => joinOperands(first, rest)),
  selector: fc.tuple(opt("id "), tie("primary")).map(([id, p]) => id + p),
  fieldRef: fc.tuple(fc.constantFrom(...LAYER_PREFIXES), fc.constantFrom("field", "fld"), tie("selector"))
    .map(([layer, word, selector]) => `${layer}${word} ${selector}`),
  objectRef: fc.oneof(
    fc.constantFrom("me", "this card", "this background", "this bg", "this stack"),
    fc.tuple(fc.constantFrom(...LAYER_PREFIXES), fc.constantFrom("button", "btn"), tie("selector"))
      .map(([layer, word, selector]) => `${layer}${word} ${selector}`),
    tie("fieldRef"),
    tie("selector").map((selector) => `card ${selector}`),
  ),
}));

/** Replaced by the handler's name in `pass` and `exit`. */
const HANDLER = "$H";
const containerSourceArb = fc.oneof(identifierArb, sourceTree.fieldRef);
const effectSourceArb = fc.constantFrom(
  "cut", "dissolve", "venetian blinds", "checkerboard", "iris open", "iris close",
  "wipe left", "wipe right", "wipe up", "wipe down", "barn door open", "barn door close",
);
const voiceSourceArb = fc.oneof(
  voiceArb,
  voiceArb.map((voice) => `"${voice}"`),
  voiceArb.map((voice) => `"${voice.toUpperCase()}"`),
);
const { expr: exprSource, primary: primarySource } = sourceTree;

const simpleSourceArb: fc.Arbitrary<string> = fc.oneof(
  fc.tuple(opt("to "), fc.constantFrom("next", "prev", "previous", "first", "last"), opt(" card"))
    .map(([to, dir, card]) => `go ${to}${dir}${card}`),
  opt("to ").map((to) => `go ${to}back`),
  fc.tuple(opt("to "), opt("id "), primarySource).map(([to, id, p]) => `go ${to}card ${id}${p}`),
  fc.tuple(opt("effect "), effectSourceArb, fc.constantFrom("", " very slow", " slow", " normal", " fast"))
    .map(([word, effect, speed]) => `visual ${word}${effect}${speed}`),
  fc.tuple(exprSource, fc.constantFrom("into", "after", "before"), containerSourceArb)
    .map(([value, mode, container]) => `put ${value} ${mode} ${container}`),
  exprSource.map((e) => `get ${e}`),
  fc.tuple(exprSource, containerSourceArb).map(([e, container]) => `add ${e} to ${container}`),
  fc.tuple(exprSource, containerSourceArb).map(([e, container]) => `subtract ${e} from ${container}`),
  fc.tuple(fc.constantFrom("multiply", "divide"), containerSourceArb, exprSource)
    .map(([op, container, e]) => `${op} ${container} by ${e}`),
  fc.tuple(opt("the "), propertyArb, sourceTree.objectRef, exprSource)
    .map(([the, property, target, e]) => `set ${the}${property} of ${target} to ${e}`),
  fc.tuple(voiceSourceArb, fc.option(fc.integer({ min: 20, max: 400 }), { nil: undefined }), stringArb)
    .map(([voice, tempo, notes]) => `play ${voice}${tempo === undefined ? "" : ` tempo ${tempo}`} "${notes}"`),
  fc.tuple(exprSource, fc.array(sourceTree.concat, { maxLength: 3 }))
    .map(([prompt, buttons]) => (buttons.length === 0 ? `answer ${prompt}` : `answer ${prompt} with ${buttons.join(" or ")}`)),
  fc.tuple(exprSource, fc.option(exprSource, { nil: undefined }))
    .map(([prompt, answer]) => (answer === undefined ? `ask ${prompt}` : `ask ${prompt} with ${answer}`)),
  fc.tuple(exprSource, fc.constantFrom("", " tick", " ticks", " second", " seconds")).map(([e, unit]) => `wait ${e}${unit}`),
  fc.tuple(exprSource, fc.constantFrom("", ' at "current.temperature_2m"', ' at "daily.time[0]"', ' at ""'), containerSourceArb)
    .map(([url, path, container]) => `fetch ${url}${path} into ${container}`),
  fc.array(identifierArb, { minLength: 1, maxLength: 3 }).map((names) => `global ${names.join(", ")}`),
  fc.constantFrom(`pass ${HANDLER}`, `exit ${HANDLER}`, "exit repeat", "next repeat"),
);

const repeatHeadSourceArb = fc.oneof(
  fc.constantFrom("", " forever"),
  exprSource.map((e) => ` while ${e}`),
  exprSource.map((e) => ` until ${e}`),
  fc.tuple(identifierArb, exprSource, fc.constantFrom("to", "down to"), exprSource)
    .map(([name, start, to, end]) => ` with ${name} = ${start} ${to} ${end}`),
  fc.tuple(opt("for "), exprSource, opt(" times")).map(([word, e, times]) => ` ${word}${e}${times}`),
);

const indentArb = fc.constantFrom("", "  ", "    ", "\t");

const statementSourceTree = fc.letrec<{ statement: string[]; block: string[] }>((tie) => ({
  statement: fc.oneof(
    { maxDepth: 2, depthSize: "small" },
    simpleSourceArb.map((line) => [line]),
    fc.tuple(exprSource, simpleSourceArb).map(([condition, line]) => [`if ${condition} then ${line}`]),
    fc.tuple(exprSource, tie("block"), fc.option(tie("block"), { nil: undefined }))
      .map(([condition, then, otherwise]) => [
        `if ${condition} then`, ...then, ...(otherwise === undefined ? [] : ["else", ...otherwise]), "end if",
      ]),
    fc.tuple(repeatHeadSourceArb, tie("block")).map(([head, body]) => [`repeat${head}`, ...body, "end repeat"]),
  ),
  block: fc.tuple(indentArb, fc.array(tie("statement"), { maxLength: 4 }))
    .map(([indent, statements]) => statements.flat().map((line) => indent + line)),
}));

type LetterCase = "lower" | "upper" | "title";

/** Re-cases every word outside string literals (keywords, identifiers and handler names are case-insensitive). */
function recase(source: string, cases: readonly LetterCase[]): string {
  let i = 0;
  return source.replace(/"[^"\r\n]*"|[A-Za-z][A-Za-z0-9_]*/g, (token) => {
    if (token.startsWith('"')) return token;
    const letterCase = cases[i++ % cases.length];
    if (letterCase === "upper") return token.toUpperCase();
    if (letterCase === "title") return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    return token.toLowerCase();
  });
}

const sourceArb: fc.Arbitrary<string> = fc.tuple(
  fc.uniqueArray(
    fc.tuple(eventNameArb, fc.array(identifierArb, { maxLength: 3 }), statementSourceTree.block),
    { selector: ([name]) => name.toLowerCase(), minLength: 1, maxLength: 3 },
  ),
  fc.array(fc.nat({ max: 9 }), { minLength: 1, maxLength: 16 }),
  fc.array(fc.constantFrom<LetterCase>("lower", "upper", "title"), { minLength: 1, maxLength: 8 }),
  fc.constantFrom("\n", "\r\n"),
).map(([handlers, noise, cases, newline]) => {
  const lines = handlers.flatMap(([name, params, body]) => [
    params.length === 0 ? `on ${name}` : `on ${name} ${params.join(", ")}`,
    ...body.map((line) => line.replaceAll(HANDLER, name)),
    `end ${name}`,
  ]);
  const out: string[] = [];
  lines.forEach((line, index) => {
    const n = noise[index % noise.length];
    if (n === 0) out.push("");
    if (n === 1) out.push("-- a comment line");
    out.push(n === 2 ? `${line} -- trailing comment` : line);
  });
  return recase(out.join(newline), cases);
});

// ---------------------------------------------------------------------------------------------
// Round-trip properties
// ---------------------------------------------------------------------------------------------

describe("round-trip guarantees (§4.2)", () => {
  /** **Validates: Requirements 2.2** */
  it("Property 1: parse(print(A)) deep-equals A for every AST accepted by validateAst", () => {
    fc.assert(
      fc.property(astArb, (ast) => {
        const checked = validateAst(ast);
        expect(checked.ok ? "valid" : checked.reason).toBe("valid");
        const { ast: reparsed, errors } = parseHexTalk(printHexTalk(ast));
        expect(errors).toEqual([]);
        expect(stripLoc(reparsed)).toEqual(stripLoc(ast));
      }),
      { numRuns: 300 },
    );
  }, HEAVY_TEST_TIMEOUT_MS);

  /** **Validates: Requirements 2.3** */
  it("Property 2: parse(print(parse(S))) deep-equals parse(S) for every source that parses without errors", () => {
    fc.assert(
      fc.property(sourceArb, (source) => {
        const first = parseHexTalk(source);
        expect(first.errors).toEqual([]);
        const printed = printHexTalk(first.ast);
        const second = parseHexTalk(printed);
        expect(second.errors).toEqual([]);
        expect(stripLoc(second.ast)).toEqual(stripLoc(first.ast));
        expect(printHexTalk(second.ast)).toBe(printed); // the printed form is canonical
      }),
      { numRuns: 300 },
    );
  }, HEAVY_TEST_TIMEOUT_MS);
});