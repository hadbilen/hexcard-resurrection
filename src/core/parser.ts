/**
 * HexTalk parser and printer: `parseHexTalk(source) -> { ast, errors }` and
 * `printHexTalk(ast) -> source`.
 * Canonical contracts: grammar hexcard_design_spec.md §4.1, AST and parser/printer contract §4.2
 * (`ast.ts`).
 *
 * - Lexer: hand-written and line-aware. Words are case-folded (the original spelling is kept for
 *   handler names), `--` comments are dropped, blank lines are ignored, and every token carries a
 *   1-based line and column.
 * - Statements: recursive descent, one method per grammar rule.
 * - Expressions: precedence climbing, `or` < `and` < comparison < concatenation < additive <
 *   multiplicative < unary < primary. Comparison is non-associative.
 * - Errors: `parseHexTalk` never throws. An error inside a handler is recorded, the parser skips to
 *   the line `end <handlerName>` and continues with the next handler. Only handlers without errors
 *   are returned.
 * - Nesting: every parse method receives the depth of the node it builds (convention in `ast.ts`),
 *   and "script is nested too deeply" is reported at the first token that proves a node beyond
 *   `HEX_MAX_DEPTH`. That also bounds the parser's recursion, so the limit never depends on the
 *   size of the JS call stack.
 *
 * Every AST returned without errors passes `validateAst`: identifiers are checked against
 * `HEX_RESERVED_WORDS`, and the parser also reports what the validator would reject (a tempo outside
 * 20..400, more than 3 answer buttons, number literals that a JS number cannot print as plain
 * decimals).
 *
 * - Printer: prints the canonical form of §4.2 (synonyms normalised, block `if`, explicit layer
 *   words, 2-space indentation, only the parentheses precedence requires), so that
 *   `parseHexTalk(printHexTalk(A))` deep-equals `A` (ignoring `loc`) for every valid AST.
 *
 * Pure TypeScript: no DOM, no React, no dynamic code execution.
 */
import type {
  HexBinaryOp,
  HexCardTarget,
  HexCompileError,
  HexContainerTarget,
  HexExprNode,
  HexHandlerNode,
  HexObjectTarget,
  HexPartSelector,
  HexPropertyName,
  HexRepeatHead,
  HexScriptAST,
  HexSourceLoc,
  HexStatementNode,
  HexVoice,
} from "./ast.ts";
import { HEX_MAX_DEPTH } from "./ast.ts";
import { HEX_RESERVED_WORDS, MAX_ANSWER_BUTTONS, MAX_TEMPO, MIN_TEMPO } from "./astValidator.ts";
import type { VisualEffectSpeed, VisualEffectType } from "./schema.ts";

/** Result of `parseHexTalk`; structurally a spec 01 `CompiledScript`. */
export interface HexParseResult {
  ast: HexScriptAST;
  errors: HexCompileError[];
}

/** `play` without `tempo` (§4.2: tempo defaults to 120). */
const DEFAULT_TEMPO = 120;
/** `visual effect` without a speed word (not fixed by §4.1/§4.2; decided for spec 02 task 2). */
const DEFAULT_VISUAL_EFFECT_SPEED: VisualEffectSpeed = "normal";
/** How the validator requires number literals to print (§4.1 NumberLiteral). */
const PLAIN_DECIMAL = /^[0-9]+(\.[0-9]+)?$/;

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

type TokenType = "word" | "number" | "string" | "op" | "newline" | "eof" | "invalid";

interface Token {
  readonly type: TokenType;
  /** word: lowercase; number: its digits; string: contents without quotes; op: the operator; invalid: error message */
  readonly value: string;
  /** The source text of the token, in its original spelling. */
  readonly text: string;
  readonly line: number;   // 1-based
  readonly column: number; // 1-based, in UTF-16 code units
}

/** Longest first, so `&&`, `<>`, `<=` and `>=` win over their one-character prefixes. */
const OPERATORS = ["&&", "<>", "<=", ">=", "&", "+", "-", "*", "/", "=", "<", ">", "(", ")", ","] as const;

const isLetter = (c: string): boolean => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

function describeCharacter(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  if (code > 0x20 && code < 0x7f) return `"${ch}"`;
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

/**
 * Splits a script into tokens. A newline token ends every line that has at least one token, so
 * blank and comment-only lines produce none. Lexical errors become `invalid` tokens that the parser
 * reports where it meets them. The last token is always `eof`.
 */
function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let line = 1;
  let lineStart = 0;
  let i = 0;
  const push = (type: TokenType, value: string, text: string, start: number): void => {
    tokens.push({ type, value, text, line, column: start - lineStart + 1 });
  };

  while (i < source.length) {
    const c = source.charAt(i);
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      if (tokens.length > 0 && tokens[tokens.length - 1].type !== "newline") push("newline", "\n", c, i);
      i += c === "\r" && source.charAt(i + 1) === "\n" ? 2 : 1;
      line++;
      lineStart = i;
      continue;
    }
    if (c === "-" && source.charAt(i + 1) === "-") {
      while (i < source.length && source.charAt(i) !== "\n" && source.charAt(i) !== "\r") i++;
      continue;
    }

    const start = i;
    if (isLetter(c)) {
      i++;
      while (isLetter(source.charAt(i)) || isDigit(source.charAt(i)) || source.charAt(i) === "_") i++;
      const text = source.slice(start, i);
      push("word", text.toLowerCase(), text, start);
    } else if (isDigit(c)) {
      while (isDigit(source.charAt(i))) i++;
      if (source.charAt(i) === "." && isDigit(source.charAt(i + 1))) {
        i++;
        while (isDigit(source.charAt(i))) i++;
      }
      const text = source.slice(start, i);
      push("number", text, text, start);
    } else if (c === '"') {
      i++;
      while (i < source.length && source.charAt(i) !== '"' && source.charAt(i) !== "\n" && source.charAt(i) !== "\r") i++;
      if (source.charAt(i) === '"') {
        i++;
        push("string", source.slice(start + 1, i - 1), source.slice(start, i), start);
      } else {
        push("invalid", 'unterminated string (a string must end with " on the same line)', source.slice(start, i), start);
      }
    } else {
      const op = OPERATORS.find((candidate) => source.startsWith(candidate, i));
      if (op !== undefined) {
        i += op.length;
        push("op", op, op, start);
      } else {
        const ch = String.fromCodePoint(source.codePointAt(i) ?? 0);
        i += ch.length;
        push("invalid", `unexpected character ${describeCharacter(ch)}`, ch, start);
      }
    }
  }
  push("eof", "", "", i);
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Word tables (keys are lowercase; Maps, so words such as "constructor" never hit prototypes)
// ---------------------------------------------------------------------------------------------

type ConstantName = Extract<HexExprNode, { kind: "Constant" }>["name"];
type BuiltInName = Extract<HexExprNode, { kind: "BuiltIn" }>["name"];
type FunctionName = Extract<HexExprNode, { kind: "FunctionCall" }>["name"];
type RelativeCard = Extract<HexCardTarget, { type: "relative" }>["dir"];
type PutMode = Extract<HexStatementNode, { kind: "PutValue" }>["mode"];
type WaitUnit = Extract<HexStatementNode, { kind: "Wait" }>["unit"];
type FieldTarget = Extract<HexContainerTarget, { scope: "field" }>;
type PartTarget = Extract<HexObjectTarget, { objectType: "button" | "field" }>;
type Layer = FieldTarget["layer"];

/** Maps each name's lowercase form to the name itself (e.g. "showname" -> "showName"). */
function byLowercase<T extends string>(names: readonly T[]): ReadonlyMap<string, T> {
  return new Map(names.map((name) => [name.toLowerCase(), name]));
}

const PROPERTY_NAMES = byLowercase<HexPropertyName>([
  "name", "visible", "enabled", "hilite", "title", "showName", "autoHilite", "location", "rect",
  "style", "lockText", "textAlign", "textFont", "textSize", "textStyle", "marked",
]);
const FUNCTION_NAMES = byLowercase<FunctionName>(["random", "round", "trunc", "abs", "length", "min", "max"]);
const BUILT_INS = byLowercase<BuiltInName>(["date", "time", "ticks", "seconds", "mouseH", "mouseV"]);
const CONSTANTS = byLowercase<ConstantName>(["empty", "quote", "return", "space", "tab"]);
const VOICES = byLowercase<HexVoice>(["harpsichord", "boing", "flute", "square8bit", "click"]);
const PUT_MODES = byLowercase<PutMode>(["into", "after", "before"]);
const SPEEDS = byLowercase<VisualEffectSpeed>(["slow", "normal", "fast"]); // "very slow" is two words

const RELATIVE_CARDS: ReadonlyMap<string, RelativeCard> = new Map([
  ["next", "next"], ["prev", "prev"], ["previous", "prev"], ["first", "first"], ["last", "last"],
]);
const WAIT_UNITS: ReadonlyMap<string, WaitUnit> = new Map([
  ["tick", "ticks"], ["ticks", "ticks"], ["second", "seconds"], ["seconds", "seconds"],
]);
const IRIS_EFFECTS: ReadonlyMap<string, VisualEffectType> = new Map([["open", "irisOpen"], ["close", "irisClose"]]);
const BARN_DOOR_EFFECTS: ReadonlyMap<string, VisualEffectType> = new Map([
  ["open", "barnDoorOpen"], ["close", "barnDoorClose"],
]);
const WIPE_EFFECTS: ReadonlyMap<string, VisualEffectType> = new Map([
  ["left", "wipeLeft"], ["right", "wipeRight"], ["up", "wipeUp"], ["down", "wipeDown"],
]);

const CARD_WORDS: ReadonlySet<string> = new Set(["card", "cd"]);
const BG_WORDS: ReadonlySet<string> = new Set(["background", "bkgnd", "bg"]);
const FIELD_WORDS: ReadonlySet<string> = new Set(["field", "fld"]);
const BUTTON_WORDS: ReadonlySet<string> = new Set(["button", "btn"]);

// Binary operators and their precedence levels (§4.1). Unary and primary bind tighter than all.
const PREC_OR = 1;
const PREC_COMPARE = 3;
const PREC_CONCAT = 4;
const PREC_UNARY = 7;
const PREC_PRIMARY = 8;
const PRECEDENCE: Readonly<Record<HexBinaryOp, number>> = {
  or: PREC_OR,
  and: 2,
  "=": PREC_COMPARE, "<>": PREC_COMPARE, "<": PREC_COMPARE, ">": PREC_COMPARE,
  "<=": PREC_COMPARE, ">=": PREC_COMPARE, contains: PREC_COMPARE,
  "&": PREC_CONCAT, "&&": PREC_CONCAT,
  "+": 5, "-": 5,
  "*": 6, "/": 6, div: 6, mod: 6,
};
const SYMBOL_OPERATORS: ReadonlyMap<string, HexBinaryOp> = new Map<string, HexBinaryOp>([
  ["&", "&"], ["&&", "&&"], ["+", "+"], ["-", "-"], ["*", "*"], ["/", "/"],
  ["=", "="], ["<>", "<>"], ["<", "<"], [">", ">"], ["<=", "<="], [">=", ">="],
]);
const WORD_OPERATORS: ReadonlyMap<string, HexBinaryOp> = new Map<string, HexBinaryOp>([
  ["or", "or"], ["and", "and"], ["contains", "contains"], ["div", "div"], ["mod", "mod"],
]);

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

const NESTED_TOO_DEEPLY = "script is nested too deeply";

/** Internal: aborts the current handler. Never escapes `parseHexTalk`. */
class CompileFailure extends Error {
  readonly line: number;
  readonly column: number;
  constructor(token: Token, message: string) {
    super(message);
    this.line = token.line;
    this.column = token.column;
  }
}

const isWord = (t: Token, word: string): boolean => t.type === "word" && t.value === word;
const isWordIn = (t: Token, words: ReadonlySet<string>): boolean => t.type === "word" && words.has(t.value);
const isOp = (t: Token, op: string): boolean => t.type === "op" && t.value === op;
const isIdentifier = (t: Token): boolean => t.type === "word" && !HEX_RESERVED_WORDS.has(t.value);
const at = (t: Token): HexSourceLoc => ({ line: t.line, column: t.column });

function describe(t: Token): string {
  switch (t.type) {
    case "newline": return "the end of the line";
    case "eof": return "the end of the script";
    case "string": return t.text;
    default: return `"${t.text}"`;
  }
}

/** Describes what follows an `end` keyword, e.g. `"end mouseDown"`. */
function describeEnd(t: Token): string {
  return t.type === "word" ? `"end ${t.text}"` : `"end" followed by ${describe(t)}`;
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  private readonly handlers: Record<string, HexHandlerNode> = {};
  private readonly errors: HexCompileError[] = [];
  /** Lowercase names of every handler header seen so far (duplicates are errors). */
  private readonly declared = new Set<string>();
  /** The handler being parsed: lowercase key and original spelling. */
  private handlerKey = "";
  private handlerName = "";
  /**
   * Deepest node entered since the innermost running `parseBinary` started. Wrapping that call's
   * left operand in a new BinaryOp pushes all of these nodes one level deeper.
   */
  private deepest = 0;
  /** Token index where the content of the last opened parenthesis group starts. */
  private groupContentStart = -1;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  // Script ::= { Handler }
  parse(): HexParseResult {
    for (;;) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (t.type === "newline") {
        this.advance();
      } else if (isWord(t, "on")) {
        this.parseHandler();
      } else {
        this.report(this.unexpected(t, '"on <handlerName>"'));
        this.skipToNextHandler();
      }
    }
    return { ast: { handlers: this.handlers }, errors: this.errors };
  }

  // ----- token access ------------------------------------------------------------------------

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private advance(): Token {
    const t = this.peek();
    if (t.type !== "eof") this.pos++;
    return t;
  }

  private acceptWord(word: string): boolean {
    if (!isWord(this.peek(), word)) return false;
    this.advance();
    return true;
  }

  private expectWord(word: string): Token {
    const t = this.peek();
    if (!isWord(t, word)) throw this.unexpected(t, `"${word}"`);
    return this.advance();
  }

  private acceptOp(op: string): boolean {
    if (!isOp(this.peek(), op)) return false;
    this.advance();
    return true;
  }

  private expectOp(op: string): Token {
    const t = this.peek();
    if (!isOp(t, op)) throw this.unexpected(t, `"${op}"`);
    return this.advance();
  }

  /** Consumes a word listed in `table` and returns its AST value. */
  private expectFrom<T>(table: ReadonlyMap<string, T>, expected: string): T {
    const t = this.peek();
    const value = t.type === "word" ? table.get(t.value) : undefined;
    if (value === undefined) throw this.unexpected(t, expected);
    this.advance();
    return value;
  }

  private expectIdentifier(what: string): Token {
    const t = this.peek();
    if (isIdentifier(t)) return this.advance();
    throw this.identifierError(t, what);
  }

  private atEndOfLine(): boolean {
    const t = this.peek();
    return t.type === "newline" || t.type === "eof";
  }

  /** A newline ends a statement; the end of the script ends the last one. */
  private expectEndOfLine(): void {
    const t = this.peek();
    if (t.type === "newline") this.advance();
    else if (t.type !== "eof") throw this.unexpected(t, "the end of the line");
  }

  // ----- errors and recovery -----------------------------------------------------------------

  private fail(t: Token, message: string): CompileFailure {
    return new CompileFailure(t, message);
  }

  private unexpected(t: Token, expected: string): CompileFailure {
    return this.fail(t, t.type === "invalid" ? t.value : `expected ${expected} but found ${describe(t)}`);
  }

  private identifierError(t: Token, what: string): CompileFailure {
    return t.type === "word"
      ? this.fail(t, `"${t.text}" is a reserved word and cannot be used as ${what}`)
      : this.unexpected(t, what);
  }

  /** Starts a node of depth `depth` at token `t` (see `HEX_MAX_DEPTH`). */
  private enter(t: Token, depth: number): void {
    if (depth > HEX_MAX_DEPTH) throw this.fail(t, NESTED_TOO_DEEPLY);
    if (depth > this.deepest) this.deepest = depth;
  }

  private report(failure: CompileFailure): void {
    this.errors.push({ line: failure.line, column: failure.column, message: failure.message });
  }

  /**
   * Design §2 recovery: starting at the line of the error, skip to the line `end <handlerName>`
   * and continue after it. Without such a line, everything up to the end of the script is skipped.
   */
  private skipPastHandlerEnd(fromLine: number): void {
    const { tokens } = this;
    let k = this.pos;
    while (k > 0 && tokens[k - 1].line >= fromLine) k--;
    while (tokens[k].type !== "eof") {
      const isEndLine = isWord(tokens[k], "end")
        && tokens[k + 1].type === "word" && tokens[k + 1].value === this.handlerKey;
      while (tokens[k].type !== "newline" && tokens[k].type !== "eof") k++;
      if (tokens[k].type === "newline") k++;
      if (isEndLine) break;
    }
    this.pos = k;
  }

  /** Skips the rest of the current line, then every line that does not start with `on`. */
  private skipToNextHandler(): void {
    const { tokens } = this;
    let k = this.pos;
    for (;;) {
      while (tokens[k].type !== "newline" && tokens[k].type !== "eof") k++;
      if (tokens[k].type === "eof") break;
      k++;
      if (isWord(tokens[k], "on")) break;
    }
    this.pos = k;
  }

  // ----- handlers ----------------------------------------------------------------------------

  // Handler ::= "on" Identifier [ Identifier { "," Identifier } ] Newline StatementList "end" Identifier
  private parseHandler(): void {
    const onToken = this.advance();
    const nameToken = this.peek();
    if (!isIdentifier(nameToken)) {
      this.report(this.identifierError(nameToken, "a handler name"));
      this.skipToNextHandler();
      return;
    }
    this.advance();
    this.handlerKey = nameToken.value;
    this.handlerName = nameToken.text;

    try {
      if (this.declared.has(this.handlerKey)) {
        throw this.fail(nameToken, `handler "${nameToken.text}" is already defined in this script`);
      }
      this.declared.add(this.handlerKey);
      const params = this.parseParams();
      this.expectEndOfLine();
      this.deepest = 0;
      const body = this.parseStatementList(1); // the handler is depth 0
      this.parseHandlerEnd(onToken);
      this.handlers[this.handlerKey] = { eventName: nameToken.text, params, body, loc: at(onToken) };
    } catch (error) {
      let failure: CompileFailure;
      if (error instanceof CompileFailure) failure = error;
      // Backstop only: the depth checks bound the recursion well below the engine's stack size.
      else if (error instanceof RangeError) failure = this.fail(this.peek(), NESTED_TOO_DEEPLY);
      else throw error;
      this.report(failure);
      this.skipPastHandlerEnd(failure.line);
    }
  }

  private parseParams(): string[] {
    const params: string[] = [];
    if (this.atEndOfLine()) return params;
    params.push(this.expectIdentifier("a parameter name").value);
    while (this.acceptOp(",")) params.push(this.expectIdentifier("a parameter name").value);
    return params;
  }

  /** `"end" Identifier`: the closing name must equal the opening name (Requirement 1.4). */
  private parseHandlerEnd(onToken: Token): void {
    const t = this.peek();
    if (t.type === "eof") {
      throw this.fail(t, `missing "end ${this.handlerName}" for the handler on line ${onToken.line}`);
    }
    if (isWord(t, "else")) throw this.fail(t, '"else" without a matching "if"');
    this.advance(); // "end": parseStatementList stops only at "end", "else" or the end of the script
    const closing = this.peek();
    if (closing.type !== "word" || closing.value !== this.handlerKey) {
      throw this.fail(closing, `expected "end ${this.handlerName}" but found ${describeEnd(closing)}`);
    }
    this.advance();
    this.expectEndOfLine();
  }

  // ----- statements --------------------------------------------------------------------------

  // StatementList ::= { Statement Newline }
  // `depth` is the depth of the statements in the list (convention in `ast.ts`).
  private parseStatementList(depth: number): HexStatementNode[] {
    const statements: HexStatementNode[] = [];
    for (;;) {
      const t = this.peek();
      if (t.type === "eof" || isWord(t, "end") || isWord(t, "else")) return statements;
      statements.push(this.parseStatement(depth));
      this.expectEndOfLine();
    }
  }

  private parseStatement(depth: number): HexStatementNode {
    const t = this.peek();
    this.enter(t, depth);
    if (t.type === "word") {
      switch (t.value) {
        case "go": return this.parseGo(depth);
        case "visual": return this.parseVisual();
        case "put": return this.parsePut(depth);
        case "get": return this.parseGet(depth);
        case "add":
        case "subtract":
        case "multiply":
        case "divide": return this.parseMath(depth);
        case "set": return this.parseSet(depth);
        case "play": return this.parsePlay();
        case "answer": return this.parseAnswer(depth);
        case "ask": return this.parseAsk(depth);
        case "wait": return this.parseWait(depth);
        case "fetch": return this.parseFetch(depth);
        case "global": return this.parseGlobal();
        case "if": return this.parseIf(depth);
        case "repeat": return this.parseRepeat(depth);
        case "pass": return this.parsePass();
        case "exit": return this.parseExit();
        case "next": return this.parseNextRepeat();
        case "on": throw this.fail(t, `missing "end ${this.handlerName}" before the next handler`);
        default: throw this.fail(t, `unknown command "${t.text}"`);
      }
    }
    throw this.unexpected(t, "a command");
  }

  // GoCmd ::= "go" [ "to" ] ( ( "next" | "prev" | "previous" | "first" | "last" ) [ "card" ]
  //                        | "back" | "card" "id" Primary | "card" Primary )
  private parseGo(depth: number): HexStatementNode {
    const loc = at(this.advance());
    this.acceptWord("to");
    const t = this.peek();
    const dir = t.type === "word" ? RELATIVE_CARDS.get(t.value) : undefined;
    let target: HexCardTarget;
    if (dir !== undefined) {
      this.advance();
      this.acceptWord("card");
      target = { type: "relative", dir };
    } else if (isWord(t, "back")) {
      this.advance();
      target = { type: "relative", dir: "back" };
    } else if (isWord(t, "card")) {
      this.advance();
      target = this.acceptWord("id")
        ? { type: "id", value: this.parsePrimary(depth + 1) }
        : { type: "auto", value: this.parsePrimary(depth + 1) };
    } else {
      throw this.unexpected(t, '"next", "prev", "first", "last", "back" or "card"');
    }
    return { kind: "GoToCard", target, loc };
  }

  // VisualCmd ::= "visual" [ "effect" ] EffectName [ SpeedName ]
  private parseVisual(): HexStatementNode {
    const loc = at(this.advance());
    this.acceptWord("effect");
    const effect = this.parseEffectName();
    const speed = this.parseSpeedName();
    return { kind: "QueueVisualEffect", effect, speed, loc };
  }

  private parseEffectName(): VisualEffectType {
    const t = this.peek();
    const expected = "a visual effect (cut, dissolve, venetian blinds, checkerboard, iris, wipe or barn door)";
    if (t.type !== "word") throw this.unexpected(t, expected);
    switch (t.value) {
      case "cut":
      case "dissolve":
      case "checkerboard":
        this.advance();
        return t.value;
      case "venetian":
        this.advance();
        this.expectWord("blinds");
        return "venetianBlinds";
      case "iris":
        this.advance();
        return this.expectFrom(IRIS_EFFECTS, '"open" or "close"');
      case "wipe":
        this.advance();
        return this.expectFrom(WIPE_EFFECTS, '"left", "right", "up" or "down"');
      case "barn":
        this.advance();
        this.expectWord("door");
        return this.expectFrom(BARN_DOOR_EFFECTS, '"open" or "close"');
      default:
        throw this.unexpected(t, expected);
    }
  }

  private parseSpeedName(): VisualEffectSpeed {
    if (this.acceptWord("very")) {
      this.expectWord("slow");
      return "verySlow";
    }
    const t = this.peek();
    const speed = t.type === "word" ? SPEEDS.get(t.value) : undefined;
    if (speed === undefined) return DEFAULT_VISUAL_EFFECT_SPEED;
    this.advance();
    return speed;
  }

  // PutCmd ::= "put" Expression ( "into" | "after" | "before" ) Container
  private parsePut(depth: number): HexStatementNode {
    const loc = at(this.advance());
    const value = this.parseExpression(depth + 1);
    const mode = this.expectFrom(PUT_MODES, '"into", "after" or "before"');
    const destination = this.parseContainer(depth + 1);
    return { kind: "PutValue", mode, value, destination, loc };
  }

  // GetCmd ::= "get" Expression
  private parseGet(depth: number): HexStatementNode {
    const loc = at(this.advance());
    return { kind: "GetValue", value: this.parseExpression(depth + 1), loc };
  }

  // MathCmd ::= "add" Expression "to" Container | "subtract" Expression "from" Container
  //           | "multiply" Container "by" Expression | "divide" Container "by" Expression
  private parseMath(depth: number): HexStatementNode {
    const t = this.advance();
    const loc = at(t);
    if (t.value === "add" || t.value === "subtract") {
      const amount = this.parseExpression(depth + 1);
      this.expectWord(t.value === "add" ? "to" : "from");
      const destination = this.parseContainer(depth + 1);
      return { kind: "MathMutation", op: t.value, amount, destination, loc };
    }
    const op = t.value === "multiply" ? "multiply" : "divide";
    const destination = this.parseContainer(depth + 1);
    this.expectWord("by");
    const amount = this.parseExpression(depth + 1);
    return { kind: "MathMutation", op, amount, destination, loc };
  }

  // SetCmd ::= "set" [ "the" ] PropertyName "of" ObjectRef "to" Expression
  private parseSet(depth: number): HexStatementNode {
    const loc = at(this.advance());
    this.acceptWord("the");
    const property = this.expectFrom(PROPERTY_NAMES, "a property name");
    this.expectWord("of");
    const target = this.parseObjectRef(depth + 1);
    this.expectWord("to");
    const value = this.parseExpression(depth + 1);
    return { kind: "SetProperty", property, target, value, loc };
  }

  // PlayCmd ::= "play" ( VoiceName | '"' VoiceName '"' ) [ "tempo" NumberLiteral ] StringLiteral
  private parsePlay(): HexStatementNode {
    const loc = at(this.advance());
    const voiceToken = this.peek();
    const voice = voiceToken.type === "word" || voiceToken.type === "string"
      ? VOICES.get(voiceToken.value.replace(/[A-Z]/g, (c) => c.toLowerCase()))
      : undefined;
    if (voice === undefined) throw this.unexpected(voiceToken, "a voice (harpsichord, boing, flute, square8bit or click)");
    this.advance();

    let tempo = DEFAULT_TEMPO;
    if (this.acceptWord("tempo")) {
      const n = this.peek();
      if (n.type !== "number") throw this.unexpected(n, "a tempo number");
      tempo = Number(n.value);
      if (tempo < MIN_TEMPO || tempo > MAX_TEMPO) {
        throw this.fail(n, `tempo must be between ${MIN_TEMPO} and ${MAX_TEMPO}`);
      }
      this.advance();
    }

    const notes = this.peek();
    if (notes.type !== "string") throw this.unexpected(notes, "a string of notes");
    this.advance();
    return { kind: "PlaySound", voice, tempo, notes: notes.value, loc };
  }

  // AnswerCmd ::= "answer" Expression [ "with" ConcatExpr [ "or" ConcatExpr [ "or" ConcatExpr ] ] ]
  // Buttons are parsed at ConcatExpr level so that "or" separates them (Requirement 1.5).
  private parseAnswer(depth: number): HexStatementNode {
    const loc = at(this.advance());
    const prompt = this.parseExpression(depth + 1);
    const buttons: HexExprNode[] = [];
    if (this.acceptWord("with")) {
      buttons.push(this.parseBinary(PREC_CONCAT, depth + 1));
      while (isWord(this.peek(), "or")) {
        if (buttons.length === MAX_ANSWER_BUTTONS) {
          throw this.fail(this.peek(), `answer accepts at most ${MAX_ANSWER_BUTTONS} buttons`);
        }
        this.advance();
        buttons.push(this.parseBinary(PREC_CONCAT, depth + 1));
      }
    }
    return { kind: "ShowAnswerDialog", prompt, buttons, loc };
  }

  // AskCmd ::= "ask" Expression [ "with" Expression ]
  private parseAsk(depth: number): HexStatementNode {
    const loc = at(this.advance());
    const prompt = this.parseExpression(depth + 1);
    if (!this.acceptWord("with")) return { kind: "ShowAskDialog", prompt, loc };
    return { kind: "ShowAskDialog", prompt, defaultAnswer: this.parseExpression(depth + 1), loc };
  }

  // WaitCmd ::= "wait" Expression [ "tick" | "ticks" | "second" | "seconds" ]   (default: ticks)
  private parseWait(depth: number): HexStatementNode {
    const loc = at(this.advance());
    const amount = this.parseExpression(depth + 1);
    const t = this.peek();
    const unit = t.type === "word" ? WAIT_UNITS.get(t.value) : undefined;
    if (unit !== undefined) this.advance();
    return { kind: "Wait", amount, unit: unit ?? "ticks", loc };
  }

  // FetchCmd ::= "fetch" Expression [ "at" StringLiteral ] "into" Container
  private parseFetch(depth: number): HexStatementNode {
    const loc = at(this.advance());
    const url = this.parseExpression(depth + 1);
    let jsonPath: string | undefined;
    if (this.acceptWord("at")) {
      const path = this.peek();
      if (path.type !== "string") throw this.unexpected(path, "a JSON path string");
      this.advance();
      jsonPath = path.value;
    }
    this.expectWord("into");
    const destination = this.parseContainer(depth + 1);
    return jsonPath === undefined
      ? { kind: "FetchJson", url, destination, loc }
      : { kind: "FetchJson", url, jsonPath, destination, loc };
  }

  // GlobalCmd ::= "global" Identifier { "," Identifier }
  private parseGlobal(): HexStatementNode {
    const loc = at(this.advance());
    const names = [this.expectIdentifier("a variable name").value];
    while (this.acceptOp(",")) names.push(this.expectIdentifier("a variable name").value);
    return { kind: "DeclareGlobal", names, loc };
  }

  // IfStmt ::= "if" Expression "then" ( Statement
  //          | Newline StatementList [ "else" Newline StatementList ] "end" "if" )
  private parseIf(depth: number): HexStatementNode {
    const ifToken = this.advance();
    const loc = at(ifToken);
    const condition = this.parseExpression(depth + 1);
    this.expectWord("then");
    if (!this.atEndOfLine()) {
      return { kind: "IfCondition", condition, thenBranch: [this.parseStatement(depth + 1)], loc };
    }
    this.expectEndOfLine();
    const thenBranch = this.parseStatementList(depth + 1);
    let elseBranch: HexStatementNode[] | undefined;
    if (this.acceptWord("else")) {
      if (!this.atEndOfLine()) {
        throw this.fail(this.peek(), '"else" must be followed by a new line (a statement on the same line is not supported)');
      }
      this.expectEndOfLine();
      elseBranch = this.parseStatementList(depth + 1);
    }
    this.expectBlockEnd("if", ifToken);
    return elseBranch === undefined
      ? { kind: "IfCondition", condition, thenBranch, loc }
      : { kind: "IfCondition", condition, thenBranch, elseBranch, loc };
  }

  // RepeatBlock ::= "repeat" [ RepeatHead ] Newline StatementList "end" "repeat"
  private parseRepeat(depth: number): HexStatementNode {
    const repeatToken = this.advance();
    const head = this.parseRepeatHead(depth + 1);
    this.expectEndOfLine();
    const body = this.parseStatementList(depth + 1);
    this.expectBlockEnd("repeat", repeatToken);
    return { kind: "RepeatLoop", head, body, loc: at(repeatToken) };
  }

  // RepeatHead ::= "with" Identifier "=" Expression ( "to" | "down" "to" ) Expression
  //              | "while" Expression | "until" Expression | "forever" | [ "for" ] Expression [ "times" ]
  // The head is not a node: `depth` is the depth of its expressions.
  private parseRepeatHead(depth: number): HexRepeatHead {
    if (this.atEndOfLine()) return { type: "forever" }; // bare "repeat"
    if (this.acceptWord("forever")) return { type: "forever" };
    if (this.acceptWord("while")) return { type: "while", condition: this.parseExpression(depth) };
    if (this.acceptWord("until")) return { type: "until", condition: this.parseExpression(depth) };
    if (this.acceptWord("with")) {
      const varName = this.expectIdentifier("a loop variable name").value;
      this.expectOp("=");
      const start = this.parseExpression(depth);
      let direction: "up" | "down";
      if (this.acceptWord("to")) {
        direction = "up";
      } else if (this.acceptWord("down")) {
        this.expectWord("to");
        direction = "down";
      } else {
        throw this.unexpected(this.peek(), '"to" or "down to"');
      }
      const end = this.parseExpression(depth);
      return { type: "range", varName, start, end, direction };
    }
    this.acceptWord("for");
    const times = this.parseExpression(depth);
    this.acceptWord("times");
    return { type: "count", times };
  }

  /** `"end" "if"` / `"end" "repeat"` closing the block opened by `open`. */
  private expectBlockEnd(word: "if" | "repeat", open: Token): void {
    const t = this.peek();
    if (t.type === "eof") throw this.fail(t, `missing "end ${word}" for the "${word}" on line ${open.line}`);
    if (!isWord(t, "end")) throw this.unexpected(t, `"end ${word}"`);
    this.advance();
    const closing = this.peek();
    if (!isWord(closing, word)) throw this.fail(closing, `expected "end ${word}" but found ${describeEnd(closing)}`);
    this.advance();
  }

  // PassCmd ::= "pass" Identifier   (must equal the enclosing handler's name, Requirement 1.4)
  private parsePass(): HexStatementNode {
    const loc = at(this.advance());
    const name = this.expectIdentifier("a handler name");
    if (name.value !== this.handlerKey) {
      throw this.fail(name, `pass must name the enclosing handler "${this.handlerName}", not "${name.text}"`);
    }
    return { kind: "PassEvent", eventName: name.value, loc };
  }

  // ExitCmd ::= "exit" ( "repeat" | Identifier )   ("exit <handlerName>" ends the handler)
  private parseExit(): HexStatementNode {
    const loc = at(this.advance());
    if (this.acceptWord("repeat")) return { kind: "ExitRepeat", loc };
    const name = this.peek();
    if (!isIdentifier(name)) throw this.unexpected(name, `"repeat" or "${this.handlerName}"`);
    if (name.value !== this.handlerKey) {
      throw this.fail(name, `exit must name the enclosing handler "${this.handlerName}" or "repeat", not "${name.text}"`);
    }
    this.advance();
    return { kind: "ExitHandler", loc };
  }

  // NextRepeatCmd ::= "next" "repeat"
  private parseNextRepeat(): HexStatementNode {
    const loc = at(this.advance());
    this.expectWord("repeat");
    return { kind: "NextRepeat", loc };
  }

  // ----- containers and object references ----------------------------------------------------

  // Container ::= Identifier | FieldRef
  // Containers, part references, selectors and object references are not nodes: in these methods
  // `depth` is the depth of the selector expression they hold.
  private parseContainer(depth: number): HexContainerTarget {
    const t = this.peek();
    if (isIdentifier(t)) {
      this.advance();
      return { scope: "variable", name: t.value };
    }
    if (this.atPartRef(false)) return this.parseFieldRef(depth);
    throw this.unexpected(t, "a variable or a field");
  }

  /** True at the start of a FieldRef (or, with `buttons`, a ButtonRef). */
  private atPartRef(buttons: boolean): boolean {
    const isPartWord = (t: Token): boolean => isWordIn(t, FIELD_WORDS) || (buttons && isWordIn(t, BUTTON_WORDS));
    const t = this.peek();
    if (isPartWord(t)) return true;
    return (isWordIn(t, CARD_WORDS) || isWordIn(t, BG_WORDS)) && isPartWord(this.peek(1));
  }

  // FieldRef  ::= [ CardWord | BgWord ] ( "field" | "fld" ) PartSelector    (default layer: background)
  // ButtonRef ::= [ CardWord | BgWord ] ( "button" | "btn" ) PartSelector   (default layer: card)
  private parsePartRef(depth: number): PartTarget {
    let layer: Layer | undefined;
    if (isWordIn(this.peek(), CARD_WORDS)) {
      this.advance();
      layer = "card";
    } else if (isWordIn(this.peek(), BG_WORDS)) {
      this.advance();
      layer = "background";
    }
    const t = this.peek();
    let objectType: PartTarget["objectType"];
    if (isWordIn(t, FIELD_WORDS)) objectType = "field";
    else if (isWordIn(t, BUTTON_WORDS)) objectType = "button";
    else throw this.unexpected(t, '"field" or "button"');
    this.advance();
    const selector = this.parsePartSelector(depth);
    return { objectType, layer: layer ?? (objectType === "field" ? "background" : "card"), selector };
  }

  /** Called only where `atPartRef(false)` holds, so the reference is a field. */
  private parseFieldRef(depth: number): FieldTarget {
    const { layer, selector } = this.parsePartRef(depth);
    return { scope: "field", layer, selector };
  }

  // PartSelector ::= "id" Primary | Primary
  private parsePartSelector(depth: number): HexPartSelector {
    if (this.acceptWord("id")) return { by: "id", value: this.parsePrimary(depth) };
    return { by: "auto", value: this.parsePrimary(depth) };
  }

  // ObjectRef ::= "me" | ButtonRef | FieldRef | "this" "card" | "card" PartSelector
  //             | "this" ( "background" | "bg" ) | "this" "stack"
  // "card field ..." / "card button ..." is the card-layer part, not a card selected by a field.
  private parseObjectRef(depth: number): HexObjectTarget {
    const t = this.peek();
    if (this.acceptWord("me")) return { objectType: "me" };
    if (this.acceptWord("this")) {
      if (this.acceptWord("card")) return { objectType: "card" };
      if (this.acceptWord("background") || this.acceptWord("bg")) return { objectType: "background" };
      if (this.acceptWord("stack")) return { objectType: "stack" };
      throw this.unexpected(this.peek(), '"card", "background", "bg" or "stack"');
    }
    if (this.atPartRef(true)) return this.parsePartRef(depth);
    if (this.acceptWord("card")) return { objectType: "card", selector: this.parsePartSelector(depth) };
    throw this.unexpected(t, "an object (me, a button, a field, a card, this card, this background or this stack)");
  }

  // ----- expressions ---------------------------------------------------------------------------

  // Expression ::= AndExpr { "or" AndExpr }
  // In the expression methods `depth` is the depth of the node they return.
  private parseExpression(depth: number): HexExprNode {
    return this.parseBinary(PREC_OR, depth);
  }

  /**
   * Precedence climbing over the binary levels of §4.1. All levels are left-associative except
   * comparison, where a second comparison operator is a syntax error.
   *
   * The left operand is parsed as if it stood at `depth`; each operator of the loop wraps
   * everything parsed so far in a new BinaryOp at `depth`, one level deeper. For a left-deep chain
   * such as `1 + 1 + ... + 1`, the operator whose wrap would push a node beyond `HEX_MAX_DEPTH` is
   * the first token beyond the limit. A left operand that is a nested group was already parsed one
   * level deeper (`parseGroup`), so the first wrap adds no level.
   */
  private parseBinary(minPrecedence: number, depth: number): HexExprNode {
    const outerDeepest = this.deepest;
    this.deepest = 0;
    let leftCounted = this.atNestedGroup();
    let left = this.parseUnary(depth);
    for (;;) {
      const operator = this.peekBinaryOperator();
      if (operator === null) break;
      const precedence = PRECEDENCE[operator.op];
      if (precedence < minPrecedence) break;
      const opToken = this.peek();
      if (leftCounted) {
        leftCounted = false;
      } else {
        if (this.deepest + 1 > HEX_MAX_DEPTH) throw this.fail(opToken, NESTED_TOO_DEEPLY);
        this.deepest += 1;
      }
      this.pos += operator.width;
      const right = this.parseBinary(precedence + 1, depth + 1);
      left = { kind: "BinaryOp", op: operator.op, left, right, loc: at(opToken) };
      if (precedence === PREC_COMPARE) {
        const next = this.peekBinaryOperator();
        if (next !== null && PRECEDENCE[next.op] === PREC_COMPARE) {
          throw this.fail(this.peek(), "comparisons cannot be chained; use parentheses");
        }
      }
    }
    this.deepest = Math.max(outerDeepest, this.deepest);
    return left;
  }

  /** `is not` and `is` are recognised with one token of look-ahead. */
  private peekBinaryOperator(): { op: HexBinaryOp; width: 1 | 2 } | null {
    const t = this.peek();
    let op: HexBinaryOp | undefined;
    if (t.type === "op") {
      op = SYMBOL_OPERATORS.get(t.value);
    } else if (isWord(t, "is")) {
      return isWord(this.peek(1), "not") ? { op: "<>", width: 2 } : { op: "=", width: 1 };
    } else if (t.type === "word") {
      op = WORD_OPERATORS.get(t.value);
    }
    return op === undefined ? null : { op, width: 1 };
  }

  // UnaryExpr ::= ( "not" | "-" ) UnaryExpr | Primary
  private parseUnary(depth: number): HexExprNode {
    const t = this.peek();
    if (isWord(t, "not") || isOp(t, "-")) {
      this.enter(t, depth);
      this.advance();
      return { kind: "UnaryOp", op: t.type === "op" ? "-" : "not", operand: this.parseUnary(depth + 1), loc: at(t) };
    }
    return this.parsePrimary(depth);
  }

  /** True at a `(` that is the first token of the last opened group's content, as in `((`. */
  private atNestedGroup(): boolean {
    return this.pos === this.groupContentStart && isOp(this.peek(), "(");
  }

  /**
   * `"(" Expression ")"`. Parentheses create no node, so the content normally keeps `depth`.
   *
   * A group directly inside another group (`((`) is parsed one level deeper. Either an operator
   * follows it, and it is the left operand of a BinaryOp in the outer group, so that level is real
   * (`parseBinary` then adds none for its first wrap); or the outer pair wraps exactly this group,
   * and the redundant pair counts as one extra level. The printer only parenthesises a BinaryOp or
   * UnaryOp, so it never prints a redundant pair and its parentheses never add a level; the rule
   * only bounds the recursion of sources such as `((((1))))`.
   */
  private parseGroup(depth: number): HexExprNode {
    const open = this.peek();
    const contentDepth = this.atNestedGroup() ? depth + 1 : depth;
    if (contentDepth > HEX_MAX_DEPTH) throw this.fail(open, NESTED_TOO_DEEPLY);
    this.advance();
    this.groupContentStart = this.pos;
    const inner = this.parseExpression(contentDepth);
    this.expectOp(")");
    return inner;
  }

  // Primary ::= NumberLiteral | StringLiteral | Constant | "(" Expression ")"
  //           | FunctionName "(" [ Expression { "," Expression } ] ")" | "the" ... | FieldRef | Identifier
  private parsePrimary(depth: number): HexExprNode {
    const t = this.peek();
    if (isOp(t, "(")) return this.parseGroup(depth);
    this.enter(t, depth);
    const loc = at(t);
    switch (t.type) {
      case "number": {
        const value = Number(t.value);
        if (!PLAIN_DECIMAL.test(String(value))) throw this.fail(t, `number ${t.text} is outside the supported range`);
        this.advance();
        return { kind: "Literal", value, loc };
      }
      case "string":
        this.advance();
        return { kind: "Literal", value: t.value, loc };
      case "word": {
        if (t.value === "true" || t.value === "false") {
          this.advance();
          return { kind: "Literal", value: t.value === "true", loc };
        }
        const constant = CONSTANTS.get(t.value);
        if (constant !== undefined) {
          this.advance();
          return { kind: "Constant", name: constant, loc };
        }
        const fn = FUNCTION_NAMES.get(t.value);
        if (fn !== undefined) {
          this.advance();
          return { kind: "FunctionCall", name: fn, args: this.parseArguments(depth + 1), loc };
        }
        if (t.value === "the") return this.parseTheExpr(depth);
        if (this.atPartRef(false)) return { kind: "ReadContainer", source: this.parseFieldRef(depth + 1), loc };
        if (isIdentifier(t)) {
          this.advance();
          return { kind: "Variable", name: t.value, loc };
        }
        break;
      }
      default:
        break;
    }
    throw this.unexpected(t, "an expression");
  }

  /** A call's argument list; `depth` is the depth of the arguments. */
  private parseArguments(depth: number): HexExprNode[] {
    this.expectOp("(");
    const args: HexExprNode[] = [];
    if (this.acceptOp(")")) return args;
    do args.push(this.parseExpression(depth)); while (this.acceptOp(","));
    this.expectOp(")");
    return args;
  }

  // "the" FunctionName "of" Primary | "the" BuiltInName | "the" PropertyName "of" ObjectRef
  // Called by parsePrimary, which has already entered the node at "the".
  private parseTheExpr(depth: number): HexExprNode {
    const loc = at(this.advance());
    const t = this.peek();
    if (t.type === "word") {
      const fn = FUNCTION_NAMES.get(t.value);
      if (fn !== undefined) {
        this.advance();
        this.expectWord("of");
        return { kind: "FunctionCall", name: fn, args: [this.parsePrimary(depth + 1)], loc };
      }
      const builtIn = BUILT_INS.get(t.value);
      if (builtIn !== undefined) {
        this.advance();
        return { kind: "BuiltIn", name: builtIn, loc };
      }
      if (t.value === "number") {
        this.advance();
        this.expectWord("of");
        if (this.acceptWord("cards")) return { kind: "BuiltIn", name: "numberOfCards", loc };
        if (this.acceptWord("this")) {
          this.expectWord("card");
          return { kind: "BuiltIn", name: "cardNumber", loc };
        }
        throw this.unexpected(this.peek(), '"cards" or "this card"');
      }
      const property = PROPERTY_NAMES.get(t.value);
      if (property !== undefined) {
        this.advance();
        this.expectWord("of");
        return { kind: "ReadProperty", property, target: this.parseObjectRef(depth + 1), loc };
      }
    }
    throw this.unexpected(t, 'a function, built-in or property name after "the"');
  }
}

/**
 * Parses HexTalk source (§4.1) into a HexScriptAST (§4.2). Never throws: syntax and semantic
 * errors are returned in `errors` (1-based line and column), and `ast` holds every handler that
 * parsed without errors.
 */
export function parseHexTalk(source: string): HexParseResult {
  return new Parser(source).parse();
}

// ---------------------------------------------------------------------------------------------
// Printer
// ---------------------------------------------------------------------------------------------

/** One indentation level (§4.2: the printer indents with 2 spaces). */
const INDENT = "  ";

/** Explicit layer words; §4.2 normalises `bkgnd`/`background` to `bg` (and `cd` prints as `card`). */
const LAYER_WORDS: Readonly<Record<Layer, string>> = { card: "card", background: "bg" };

const EFFECT_WORDS: Readonly<Record<VisualEffectType, string>> = {
  cut: "cut",
  dissolve: "dissolve",
  venetianBlinds: "venetian blinds",
  checkerboard: "checkerboard",
  irisOpen: "iris open",
  irisClose: "iris close",
  wipeLeft: "wipe left",
  wipeRight: "wipe right",
  wipeUp: "wipe up",
  wipeDown: "wipe down",
  barnDoorOpen: "barn door open",
  barnDoorClose: "barn door close",
};

const SPEED_WORDS: Readonly<Record<VisualEffectSpeed, string>> = {
  verySlow: "very slow", slow: "slow", normal: "normal", fast: "fast",
};

const BUILT_IN_WORDS: Readonly<Record<BuiltInName, string>> = {
  date: "the date",
  time: "the time",
  ticks: "the ticks",
  seconds: "the seconds",
  mouseH: "the mouseH",
  mouseV: "the mouseV",
  numberOfCards: "the number of cards",
  cardNumber: "the number of this card",
};

type SimpleStatement = Exclude<HexStatementNode, { kind: "IfCondition" | "RepeatLoop" }>;

function precedenceOf(e: HexExprNode): number {
  if (e.kind === "BinaryOp") return PRECEDENCE[e.op];
  if (e.kind === "UnaryOp") return PREC_UNARY;
  return PREC_PRIMARY;
}

/**
 * Prints `e` where the grammar expects an expression of precedence `minPrecedence` or higher
 * (e.g. `PREC_PRIMARY` for a PartSelector, `PREC_CONCAT` for an answer button), adding parentheses
 * only when `e` binds more loosely than that.
 */
function printOperand(e: HexExprNode, minPrecedence: number): string {
  const text = printExpr(e);
  return precedenceOf(e) < minPrecedence ? `(${text})` : text;
}

function printExpr(e: HexExprNode): string {
  switch (e.kind) {
    case "Literal":
      // Valid ASTs hold no `"`/newline in strings and only plain non-negative decimals (validateAst).
      return typeof e.value === "string" ? `"${e.value}"` : String(e.value);
    case "Constant":
    case "Variable":
      return e.name;
    case "BuiltIn":
      return BUILT_IN_WORDS[e.name];
    case "FunctionCall":
      // Always the call form; `the random of 6` parses to the same node as `random(6)`.
      return `${e.name}(${e.args.map(printExpr).join(", ")})`;
    case "ReadContainer":
      return printFieldRef(e.source);
    case "ReadProperty":
      return `the ${e.property} of ${printObjectRef(e.target)}`;
    case "BinaryOp": {
      const precedence = PRECEDENCE[e.op];
      // Left-associative levels accept an equal-precedence left operand. Comparison is
      // non-associative, so both of its operands must bind tighter.
      const leftMin = precedence === PREC_COMPARE ? precedence + 1 : precedence;
      return `${printOperand(e.left, leftMin)} ${e.op} ${printOperand(e.right, precedence + 1)}`;
    }
    case "UnaryOp": {
      const operand = printOperand(e.operand, PREC_UNARY);
      if (e.op === "not") return `not ${operand}`;
      return operand.startsWith("-") ? `- ${operand}` : `-${operand}`; // "--" would start a comment
    }
  }
}

function printSelector(selector: HexPartSelector): string {
  const value = printOperand(selector.value, PREC_PRIMARY);
  return selector.by === "id" ? `id ${value}` : value;
}

function printFieldRef(ref: FieldTarget): string {
  return `${LAYER_WORDS[ref.layer]} field ${printSelector(ref.selector)}`;
}

function printContainer(container: HexContainerTarget): string {
  return container.scope === "variable" ? container.name : printFieldRef(container);
}

function printObjectRef(target: HexObjectTarget): string {
  switch (target.objectType) {
    case "me":
      return "me";
    case "button":
    case "field":
      return `${LAYER_WORDS[target.layer]} ${target.objectType} ${printSelector(target.selector)}`;
    case "card":
      // A selector value always prints with its layer word (`card bg field 1`), so it can never
      // be read back as the card-layer part `card field 1` (§4.1 grammar notes).
      return target.selector === undefined ? "this card" : `card ${printSelector(target.selector)}`;
    case "background":
      return "this bg";
    case "stack":
      return "this stack";
  }
}

function printCardTarget(target: HexCardTarget): string {
  switch (target.type) {
    case "relative":
      return target.dir === "back" ? "go back" : `go to ${target.dir} card`;
    case "id":
      return `go to card id ${printOperand(target.value, PREC_PRIMARY)}`;
    case "auto":
      return `go to card ${printOperand(target.value, PREC_PRIMARY)}`;
  }
}

function printRepeatHead(head: HexRepeatHead): string {
  switch (head.type) {
    case "forever":
      return "repeat forever";
    case "count":
      return `repeat ${printExpr(head.times)} times`;
    case "while":
      return `repeat while ${printExpr(head.condition)}`;
    case "until":
      return `repeat until ${printExpr(head.condition)}`;
    case "range": {
      const to = head.direction === "up" ? "to" : "down to";
      return `repeat with ${head.varName} = ${printExpr(head.start)} ${to} ${printExpr(head.end)}`;
    }
  }
}

/** One-line statements. `pass` and `exit` print the enclosing handler's spelling of its name. */
function printSimpleStatement(s: SimpleStatement, handler: HexHandlerNode): string {
  switch (s.kind) {
    case "GoToCard":
      return printCardTarget(s.target);
    case "QueueVisualEffect":
      return `visual effect ${EFFECT_WORDS[s.effect]} ${SPEED_WORDS[s.speed]}`;
    case "PutValue":
      return `put ${printExpr(s.value)} ${s.mode} ${printContainer(s.destination)}`;
    case "GetValue":
      return `get ${printExpr(s.value)}`;
    case "MathMutation": {
      const amount = printExpr(s.amount);
      const destination = printContainer(s.destination);
      switch (s.op) {
        case "add": return `add ${amount} to ${destination}`;
        case "subtract": return `subtract ${amount} from ${destination}`;
        case "multiply": return `multiply ${destination} by ${amount}`;
        case "divide": return `divide ${destination} by ${amount}`;
      }
      break;
    }
    case "SetProperty":
      return `set the ${s.property} of ${printObjectRef(s.target)} to ${printExpr(s.value)}`;
    case "PlaySound":
      return `play ${s.voice} tempo ${String(s.tempo)} "${s.notes}"`;
    case "ShowAnswerDialog": {
      const prompt = `answer ${printExpr(s.prompt)}`;
      if (s.buttons.length === 0) return prompt;
      // Buttons are ConcatExpr-level (Requirement 1.5): looser expressions need parentheses.
      return `${prompt} with ${s.buttons.map((button) => printOperand(button, PREC_CONCAT)).join(" or ")}`;
    }
    case "ShowAskDialog":
      return s.defaultAnswer === undefined
        ? `ask ${printExpr(s.prompt)}`
        : `ask ${printExpr(s.prompt)} with ${printExpr(s.defaultAnswer)}`;
    case "Wait":
      return `wait ${printExpr(s.amount)} ${s.unit}`;
    case "FetchJson": {
      const at = s.jsonPath === undefined ? "" : ` at "${s.jsonPath}"`;
      return `fetch ${printExpr(s.url)}${at} into ${printContainer(s.destination)}`;
    }
    case "DeclareGlobal":
      return `global ${s.names.join(", ")}`;
    case "PassEvent":
      return `pass ${s.eventName === handler.eventName.toLowerCase() ? handler.eventName : s.eventName}`;
    case "ExitHandler":
      return `exit ${handler.eventName}`;
    case "ExitRepeat":
      return "exit repeat";
    case "NextRepeat":
      return "next repeat";
  }
}

function printStatements(
  statements: readonly HexStatementNode[],
  indent: string,
  handler: HexHandlerNode,
  out: string[],
): void {
  for (const s of statements) {
    if (s.kind === "IfCondition") {
      // Always the block form (§4.2), even for a single-line `if` in the source.
      out.push(`${indent}if ${printExpr(s.condition)} then`);
      printStatements(s.thenBranch, indent + INDENT, handler, out);
      if (s.elseBranch !== undefined) {
        out.push(`${indent}else`);
        printStatements(s.elseBranch, indent + INDENT, handler, out);
      }
      out.push(`${indent}end if`);
    } else if (s.kind === "RepeatLoop") {
      out.push(indent + printRepeatHead(s.head));
      printStatements(s.body, indent + INDENT, handler, out);
      out.push(`${indent}end repeat`);
    } else {
      out.push(indent + printSimpleStatement(s, handler));
    }
  }
}

/**
 * Prints a HexScriptAST as canonical HexTalk (§4.2 parser/printer contract): synonyms are
 * normalised (`is` -> `=`, `previous` -> `prev`, `bkgnd` -> `bg`, `fld` -> `field`, ...), `if` is
 * always printed in block form, layer words are always explicit, blocks are indented with 2 spaces
 * and only the parentheses that precedence requires are added. Every line ends with `\n` and
 * handlers are separated by one blank line; an AST without handlers prints as `""`. `loc` is ignored.
 *
 * The input must be an AST accepted by `validateAst` (every AST `parseHexTalk` returns is). For
 * those, `parseHexTalk(printHexTalk(ast))` returns no errors and an AST deep-equal to `ast`,
 * ignoring `loc`. Handlers are printed from their `eventName`; the record keys are not read.
 */
export function printHexTalk(ast: HexScriptAST): string {
  const out: string[] = [];
  for (const handler of Object.values(ast.handlers)) {
    if (out.length > 0) out.push("");
    const params = handler.params.length === 0 ? "" : ` ${handler.params.join(", ")}`;
    out.push(`on ${handler.eventName}${params}`);
    printStatements(handler.body, INDENT, handler, out);
    out.push(`end ${handler.eventName}`);
  }
  return out.map((line) => `${line}\n`).join("");
}
