/**
 * AST gate for untrusted HexScriptASTs (all AI tiers). Mirrors the AST types in `ast.ts`
 * (hexcard_design_spec.md §4.2) and adds the rules of spec 02 Requirement 3.2:
 * - string literals must not contain `"` or a newline,
 * - property, voice and effect names must be known,
 * - `pass` must name the enclosing handler,
 * - `PlaySound.tempo` must be within 20..400.
 *
 * Because §4.2 promises `parse(print(A))` deep-equals `A` for every accepted AST, the gate also
 * rejects values HexTalk cannot spell: identifiers that are malformed, not lowercase or reserved,
 * handler keys that differ from the lowercased `eventName`, number literals that are not
 * `Digit { Digit } [ "." Digit { Digit } ]`, and more than 3 answer buttons.
 *
 * Objects are strict: unknown keys are rejected.
 */
import { z } from "zod";
import type {
  HexExprNode,
  HexHandlerNode,
  HexScriptAST,
  HexStatementNode,
} from "./ast.ts";

export type ValidateAstResult =
  | { ok: true; ast: HexScriptAST }
  | { ok: false; reason: string };

/** Every quoted word of the §4.1 grammar, lowercase. Identifiers must not be one of these. */
export const HEX_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "abs", "add", "after", "and", "answer", "ask", "at", "autohilite", "back", "background", "barn",
  "before", "bg", "bkgnd", "blinds", "boing", "btn", "button", "by", "card", "cards", "cd",
  "checkerboard", "click", "close", "contains", "cut", "date", "dissolve", "div", "divide", "door",
  "down", "effect", "else", "empty", "enabled", "end", "exit", "false", "fast", "fetch", "field",
  "first", "fld", "flute", "for", "forever", "from", "get", "global", "go", "harpsichord", "hilite",
  "id", "if", "into", "iris", "is", "last", "left", "length", "location", "locktext", "marked", "max",
  "me", "min", "mod", "mouseh", "mousev", "multiply", "name", "next", "normal", "not", "number", "of",
  "on", "open", "or", "pass", "play", "prev", "previous", "put", "quote", "random", "rect", "repeat",
  "return", "right", "round", "second", "seconds", "set", "showname", "slow", "space", "square8bit",
  "stack", "style", "subtract", "tab", "tempo", "textalign", "textfont", "textsize", "textstyle",
  "the", "then", "this", "tick", "ticks", "time", "times", "title", "to", "true", "trunc", "until",
  "up", "venetian", "very", "visible", "visual", "wait", "while", "wipe", "with",
]);

export const MIN_TEMPO = 20;
export const MAX_TEMPO = 400;
export const MAX_ANSWER_BUTTONS = 3;

const PROPERTY_NAMES = [
  "name", "visible", "enabled", "hilite", "title", "showName", "autoHilite",
  "location", "rect", "style", "lockText", "textAlign", "textFont", "textSize",
  "textStyle", "marked",
] as const;
const VOICES = ["harpsichord", "boing", "flute", "square8bit", "click"] as const;
const EFFECTS = [
  "cut", "dissolve", "venetianBlinds", "checkerboard", "irisOpen", "irisClose",
  "wipeLeft", "wipeRight", "wipeUp", "wipeDown", "barnDoorOpen", "barnDoorClose",
] as const;
const SPEEDS = ["verySlow", "slow", "normal", "fast"] as const;

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;
const LOWERCASE_IDENTIFIER = /^[a-z][a-z0-9_]*$/;
const NUMBER_LITERAL = /^[0-9]+(\.[0-9]+)?$/;

function shown(value: unknown): string {
  return typeof value === "string" ? `"${value}"` : String(value);
}

function unknownName(what: string) {
  return { error: (issue: { input?: unknown }) => `unknown ${what} ${shown(issue.input)}` };
}

const propertyNameSchema = z.enum(PROPERTY_NAMES, unknownName("property"));
const voiceSchema = z.enum(VOICES, unknownName("voice"));
const effectSchema = z.enum(EFFECTS, unknownName("visual effect"));
const speedSchema = z.enum(SPEEDS, unknownName("visual effect speed"));

const locSchema = z.strictObject({
  line: z.number().int().positive(),
  column: z.number().int().positive(),
}).optional();

/** Rule: a HexTalk StringLiteral has no escapes, so `"` and newlines cannot be printed. */
function checkStringLiteral(value: string, ctx: z.RefinementCtx): void {
  if (value.includes('"')) {
    ctx.addIssue({ code: "custom", message: 'string literal must not contain a double quote (use the constant quote)' });
  } else if (/[\r\n]/.test(value)) {
    ctx.addIssue({ code: "custom", message: "string literal must not contain a newline (use the constant return)" });
  }
}

/** Rule: number literals must print as `Digit { Digit } [ "." Digit { Digit } ]` (negatives use UnaryOp "-"). */
function checkNumberLiteral(value: number, ctx: z.RefinementCtx): void {
  if (Object.is(value, -0) || !NUMBER_LITERAL.test(String(value))) {
    ctx.addIssue({
      code: "custom",
      message: `number literal ${String(value)} is not a non-negative decimal (use UnaryOp "-" for negatives)`,
    });
  }
}

const stringLiteralSchema = z.string().superRefine(checkStringLiteral);

function checkIdentifierWord(value: string, pattern: RegExp, expected: string, ctx: z.RefinementCtx): void {
  if (!pattern.test(value)) {
    ctx.addIssue({ code: "custom", message: `expected ${expected} but got ${shown(value)}` });
  } else if (HEX_RESERVED_WORDS.has(value.toLowerCase())) {
    ctx.addIssue({ code: "custom", message: `${shown(value)} is a reserved word` });
  }
}

/** Variables, params, globals, loop variables and `pass` names: stored lowercase (§4.1). */
const identifierSchema = z.string().superRefine((value, ctx) =>
  checkIdentifierWord(value, LOWERCASE_IDENTIFIER, "a lowercase identifier", ctx));

/** Handler `eventName` keeps its original spelling. */
const eventNameSchema = z.string().superRefine((value, ctx) =>
  checkIdentifierWord(value, IDENTIFIER, "an identifier", ctx));

// Recursive references; resolved lazily so the schemas below can be declared in any order.
const exprRef: z.ZodType<HexExprNode> = z.lazy(() => exprSchema);
const statementRef: z.ZodType<HexStatementNode> = z.lazy(() => statementSchema);

const partSelectorSchema = z.discriminatedUnion("by", [
  z.strictObject({ by: z.literal("id"), value: exprRef }),
  z.strictObject({ by: z.literal("auto"), value: exprRef }),
]);

const layerSchema = z.enum(["card", "background"]);

const fieldContainerSchema = z.strictObject({
  scope: z.literal("field"),
  layer: layerSchema,
  selector: partSelectorSchema,
});

const containerTargetSchema = z.discriminatedUnion("scope", [
  z.strictObject({ scope: z.literal("variable"), name: identifierSchema }),
  fieldContainerSchema,
]);

const objectTargetSchema = z.discriminatedUnion("objectType", [
  z.strictObject({ objectType: z.literal("me") }),
  z.strictObject({ objectType: z.enum(["button", "field"]), layer: layerSchema, selector: partSelectorSchema }),
  z.strictObject({ objectType: z.literal("card"), selector: partSelectorSchema.optional() }),
  z.strictObject({ objectType: z.literal("background") }),
  z.strictObject({ objectType: z.literal("stack") }),
]);

const cardTargetSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("relative"), dir: z.enum(["next", "prev", "first", "last", "back"]) }),
  z.strictObject({ type: z.literal("id"), value: exprRef }),
  z.strictObject({ type: z.literal("auto"), value: exprRef }),
]);

const repeatHeadSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("forever") }),
  z.strictObject({ type: z.literal("count"), times: exprRef }),
  z.strictObject({ type: z.literal("while"), condition: exprRef }),
  z.strictObject({ type: z.literal("until"), condition: exprRef }),
  z.strictObject({
    type: z.literal("range"),
    varName: identifierSchema,
    start: exprRef,
    end: exprRef,
    direction: z.enum(["up", "down"]),
  }),
]);

const literalValueSchema = z.union([z.string(), z.number(), z.boolean()]).superRefine((value, ctx) => {
  if (typeof value === "string") checkStringLiteral(value, ctx);
  else if (typeof value === "number") checkNumberLiteral(value, ctx);
});

const exprSchema: z.ZodType<HexExprNode> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("Literal"), value: literalValueSchema, loc: locSchema }),
  z.strictObject({
    kind: z.literal("Constant"),
    name: z.enum(["empty", "quote", "return", "space", "tab"], unknownName("constant")),
    loc: locSchema,
  }),
  z.strictObject({ kind: z.literal("Variable"), name: identifierSchema, loc: locSchema }),
  z.strictObject({
    kind: z.literal("BuiltIn"),
    name: z.enum(
      ["date", "time", "ticks", "seconds", "mouseH", "mouseV", "numberOfCards", "cardNumber"],
      unknownName("built-in"),
    ),
    loc: locSchema,
  }),
  z.strictObject({
    kind: z.literal("FunctionCall"),
    name: z.enum(["random", "round", "trunc", "abs", "length", "min", "max"], unknownName("function")),
    args: z.array(exprRef),
    loc: locSchema,
  }),
  z.strictObject({ kind: z.literal("ReadContainer"), source: fieldContainerSchema, loc: locSchema }),
  z.strictObject({
    kind: z.literal("ReadProperty"),
    property: propertyNameSchema,
    target: objectTargetSchema,
    loc: locSchema,
  }),
  z.strictObject({
    kind: z.literal("BinaryOp"),
    op: z.enum(
      ["or", "and", "=", "<>", "<", ">", "<=", ">=", "contains", "&", "&&", "+", "-", "*", "/", "div", "mod"],
      unknownName("operator"),
    ),
    left: exprRef,
    right: exprRef,
    loc: locSchema,
  }),
  z.strictObject({ kind: z.literal("UnaryOp"), op: z.enum(["not", "-"], unknownName("operator")), operand: exprRef, loc: locSchema }),
], { error: (issue) => `unknown expression kind ${shown((issue.input as { kind?: unknown } | undefined)?.kind)}` });

const statementListSchema = z.array(statementRef);

const statementSchema: z.ZodType<HexStatementNode> = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("GoToCard"), target: cardTargetSchema, loc: locSchema }),
  z.strictObject({ kind: z.literal("QueueVisualEffect"), effect: effectSchema, speed: speedSchema, loc: locSchema }),
  z.strictObject({
    kind: z.literal("PutValue"),
    mode: z.enum(["into", "after", "before"]),
    value: exprRef,
    destination: containerTargetSchema,
    loc: locSchema,
  }),
  z.strictObject({ kind: z.literal("GetValue"), value: exprRef, loc: locSchema }),
  z.strictObject({
    kind: z.literal("MathMutation"),
    op: z.enum(["add", "subtract", "multiply", "divide"]),
    amount: exprRef,
    destination: containerTargetSchema,
    loc: locSchema,
  }),
  z.strictObject({
    kind: z.literal("SetProperty"),
    property: propertyNameSchema,
    target: objectTargetSchema,
    value: exprRef,
    loc: locSchema,
  }),
  z.strictObject({
    kind: z.literal("PlaySound"),
    voice: voiceSchema,
    tempo: z.number()
      .min(MIN_TEMPO, { error: `tempo must be between ${MIN_TEMPO} and ${MAX_TEMPO}` })
      .max(MAX_TEMPO, { error: `tempo must be between ${MIN_TEMPO} and ${MAX_TEMPO}` }),
    notes: stringLiteralSchema,
    loc: locSchema,
  }),
  z.strictObject({
    kind: z.literal("ShowAnswerDialog"),
    prompt: exprRef,
    buttons: z.array(exprRef).max(MAX_ANSWER_BUTTONS, { error: `at most ${MAX_ANSWER_BUTTONS} answer buttons` }),
    loc: locSchema,
  }),
  z.strictObject({ kind: z.literal("ShowAskDialog"), prompt: exprRef, defaultAnswer: exprRef.optional(), loc: locSchema }),
  z.strictObject({ kind: z.literal("Wait"), amount: exprRef, unit: z.enum(["ticks", "seconds"]), loc: locSchema }),
  z.strictObject({
    kind: z.literal("FetchJson"),
    url: exprRef,
    jsonPath: stringLiteralSchema.optional(),
    destination: containerTargetSchema,
    loc: locSchema,
  }),
  z.strictObject({
    kind: z.literal("DeclareGlobal"),
    names: z.array(identifierSchema).min(1, { error: "global needs at least one name" }),
    loc: locSchema,
  }),
  z.strictObject({
    kind: z.literal("IfCondition"),
    condition: exprRef,
    thenBranch: statementListSchema,
    elseBranch: statementListSchema.optional(),
    loc: locSchema,
  }),
  z.strictObject({ kind: z.literal("RepeatLoop"), head: repeatHeadSchema, body: statementListSchema, loc: locSchema }),
  z.strictObject({ kind: z.literal("PassEvent"), eventName: identifierSchema, loc: locSchema }),
  z.strictObject({ kind: z.literal("ExitHandler"), loc: locSchema }),
  z.strictObject({ kind: z.literal("ExitRepeat"), loc: locSchema }),
  z.strictObject({ kind: z.literal("NextRepeat"), loc: locSchema }),
], { error: (issue) => `unknown statement kind ${shown((issue.input as { kind?: unknown } | undefined)?.kind)}` });

const handlerSchema = z.strictObject({
  eventName: eventNameSchema,
  params: z.array(identifierSchema),
  body: statementListSchema,
  loc: locSchema,
}) satisfies z.ZodType<HexHandlerNode>;

const scriptSchema = z.strictObject({
  // key === eventName.toLowerCase() is checked in validateAst. Zod silently drops a "__proto__"
  // record key, so validateAst rejects that key explicitly before parsing.
  handlers: z.record(
    z.string().regex(LOWERCASE_IDENTIFIER, { error: "handler key must be a lowercase identifier" }),
    handlerSchema,
  ),
}) satisfies z.ZodType<HexScriptAST>;

function formatPath(path: readonly PropertyKey[]): string {
  let out = "ast";
  for (const key of path) out += typeof key === "number" ? `[${key}]` : `.${String(key)}`;
  return out;
}

function fail(path: readonly PropertyKey[], message: string): ValidateAstResult {
  return { ok: false, reason: `${formatPath(path)}: ${message}` };
}

/** Rule: `pass` must name the enclosing handler (§3, `pass` semantics). Walks nested blocks. */
function checkPass(
  body: readonly HexStatementNode[],
  handlerKey: string,
  path: readonly PropertyKey[],
): ValidateAstResult | null {
  for (let i = 0; i < body.length; i++) {
    const statement = body[i];
    const at = [...path, i];
    let error: ValidateAstResult | null = null;
    if (statement.kind === "PassEvent" && statement.eventName !== handlerKey) {
      error = fail([...at, "eventName"],
        `pass names "${statement.eventName}" but the enclosing handler is "${handlerKey}"`);
    } else if (statement.kind === "IfCondition") {
      error = checkPass(statement.thenBranch, handlerKey, [...at, "thenBranch"])
        ?? (statement.elseBranch ? checkPass(statement.elseBranch, handlerKey, [...at, "elseBranch"]) : null);
    } else if (statement.kind === "RepeatLoop") {
      error = checkPass(statement.body, handlerKey, [...at, "body"]);
    }
    if (error) return error;
  }
  return null;
}

/**
 * Validates an untrusted value (for example AI output) as a HexScriptAST.
 * On success returns a freshly parsed AST that shares no objects with the input.
 * On failure returns the first problem as `"<path>: <message>"`; never throws.
 */
export function validateAst(input: unknown): ValidateAstResult {
  const handlers: unknown = typeof input === "object" && input !== null
    ? (input as Record<string, unknown>).handlers
    : undefined;
  if (typeof handlers === "object" && handlers !== null && Object.hasOwn(handlers, "__proto__")) {
    return fail(["handlers", "__proto__"], "handler key must be a lowercase identifier");
  }

  let parsed: ReturnType<typeof scriptSchema.safeParse>;
  try {
    parsed = scriptSchema.safeParse(input);
  } catch (error) {
    if (error instanceof RangeError) return fail([], "AST is nested too deeply");
    throw error;
  }
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return fail(issue.path, issue.message);
  }
  const ast: HexScriptAST = parsed.data;

  for (const [key, handler] of Object.entries(ast.handlers)) {
    const expectedKey = handler.eventName.toLowerCase();
    if (key !== expectedKey) {
      return fail(["handlers", key], `handler key must be "${expectedKey}" (the lowercased eventName)`);
    }
    const passError = checkPass(handler.body, key, ["handlers", key, "body"]);
    if (passError) return passError;
  }

  return { ok: true, ast };
}
