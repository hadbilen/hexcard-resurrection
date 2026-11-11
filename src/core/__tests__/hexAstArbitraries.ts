/**
 * Shared AST generators (fast-check) of the parser round-trip tests, moved unchanged apart from
 * being exported from `parser.roundtrip.test.ts` (spec 07 Requirement 14.3, design D17).
 * `parser.roundtrip.test.ts` (spec 02 Property 1) and the power's Property 2 import them.
 */
import fc from "fast-check";
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
import { HEX_RESERVED_WORDS } from "../astValidator.ts";

export type BinaryOp = Extract<HexExprNode, { kind: "BinaryOp" }>["op"];
export const isFree = (word: string): boolean => !HEX_RESERVED_WORDS.has(word.toLowerCase());
export const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

/** Lowercase, non-reserved identifiers (variables, params, globals, loop variables). */
export const identifierArb = fc.oneof(
  fc.constantFrom("it", "x", "score", "i", "a_1", "item2", "constructor", "tostring"),
  fc.stringMatching(/^[a-z][a-z0-9_]{0,7}$/),
).filter(isFree);

/** Handler names keep their spelling. */
export const eventNameArb = fc.oneof(
  fc.constantFrom("mouseUp", "openCard", "idle", "MouseDown", "x", "hasOwnProperty"),
  fc.stringMatching(/^[A-Za-z][A-Za-z0-9_]{0,7}$/),
).filter(isFree);

/** String literal contents: anything except `"` and line breaks (validateAst rule). */
export const stringArb = fc.oneof(
  fc.constantFrom("", "Hello", "a--b", "-- no comment", "x & y", "tab\there", "(1 + 2)", "end if", "é日🎃"),
  fc.string({ maxLength: 10 }),
  fc.string({ unit: "binary", maxLength: 10 }),
).map((s) => s.replace(/["\r\n]/g, ""));

/** Non-negative numbers whose JS string form is a HexTalk NumberLiteral (validateAst rule). */
export const numberArb = fc.oneof(
  fc.nat({ max: 1000 }),
  fc.constantFrom(0.5, 2.25, 0.000001, 1e20, 0.1 + 0.2),
  fc.double({ min: 0, max: 1e9, noNaN: true }),
).filter((n) => !Object.is(n, -0) && PLAIN_DECIMAL.test(String(n)));

export const layerArb = fc.constantFrom("card", "background");
export const propertyArb = fc.constantFrom(
  "name", "visible", "enabled", "hilite", "title", "showName", "autoHilite", "location", "rect",
  "style", "lockText", "textAlign", "textFont", "textSize", "textStyle", "marked",
);
export const functionArb = fc.constantFrom("random", "round", "trunc", "abs", "length", "min", "max");
export const voiceArb = fc.constantFrom("harpsichord", "boing", "flute", "square8bit", "click");
export const effectArb = fc.constantFrom(
  "cut", "dissolve", "venetianBlinds", "checkerboard", "irisOpen", "irisClose",
  "wipeLeft", "wipeRight", "wipeUp", "wipeDown", "barnDoorOpen", "barnDoorClose",
);
export const binaryOpArb = fc.constantFrom<BinaryOp>(
  "or", "and", "=", "<>", "<", ">", "<=", ">=", "contains", "&", "&&", "+", "-", "*", "/", "div", "mod",
);

// ----- valid ASTs (Property 1) ---------------------------------------------------------------

export const leafExprArb: fc.Arbitrary<HexExprNode> = fc.oneof(
  fc.record({ kind: fc.constant("Literal"), value: fc.oneof(stringArb, numberArb, fc.boolean()) }),
  fc.record({ kind: fc.constant("Constant"), name: fc.constantFrom("empty", "quote", "return", "space", "tab") }),
  fc.record({ kind: fc.constant("Variable"), name: identifierArb }),
  fc.record({
    kind: fc.constant("BuiltIn"),
    name: fc.constantFrom("date", "time", "ticks", "seconds", "mouseH", "mouseV", "numberOfCards", "cardNumber"),
  }),
);

export type FieldTarget = Extract<HexContainerTarget, { scope: "field" }>;

export const exprTree = fc.letrec<{
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
export const exprArb = exprTree.expr;

export const containerArb: fc.Arbitrary<HexContainerTarget> = fc.oneof(
  fc.record({ scope: fc.constant("variable"), name: identifierArb }),
  exprTree.field,
);

export const cardTargetArb: fc.Arbitrary<HexCardTarget> = fc.oneof(
  fc.record({ type: fc.constant("relative"), dir: fc.constantFrom("next", "prev", "first", "last", "back") }),
  fc.record({ type: fc.constant("id"), value: exprArb }),
  fc.record({ type: fc.constant("auto"), value: exprArb }),
);

export const repeatHeadArb: fc.Arbitrary<HexRepeatHead> = fc.oneof(
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
export const PASS_PLACEHOLDER = "";

export const simpleStatementArb: fc.Arbitrary<HexStatementNode> = fc.oneof(
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

export const statementTree = fc.letrec<{ statement: HexStatementNode; block: HexStatementNode[] }>((tie) => ({
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
export function namePasses(statements: readonly HexStatementNode[], key: string): HexStatementNode[] {
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

export const astArb: fc.Arbitrary<HexScriptAST> = fc.uniqueArray(
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
