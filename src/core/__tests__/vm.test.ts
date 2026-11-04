import { describe, expect, it } from "vitest";
import type {
  HexBinaryOp,
  HexContainerTarget,
  HexExprNode,
  HexHandlerNode,
  HexObjectTarget,
  HexPropertyName,
  HexStatementNode,
} from "../ast.ts";
import type { HexButtonPart, HexFieldPart, HexStack } from "../schema.ts";
import { createHexStore, readFieldText, type HexStore } from "../store.ts";
import {
  createDispatchContext,
  GAS_LIMIT,
  HexAbortError,
  HexScriptError,
  HexVmGasLimitError,
  resolveObjectTarget,
  runHandler,
  type DispatchContext,
  type FetchResult,
  type HexHost,
  type HexValue,
} from "../vm.ts";

// ---------------------------------------------------------------------------------------------
// Fixture: crd_1 and crd_2 share bkg_1; "Score" is an unshared background field.
// ---------------------------------------------------------------------------------------------

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function field(overrides: Partial<HexFieldPart> & Pick<HexFieldPart, "id" | "name">): HexFieldPart {
  return {
    type: "field", layerScope: "background", rect: { x: 10, y: 40, width: 200, height: 100 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "System",
    textSize: 12, textStyle: [], ...overrides,
  };
}

const button: HexButtonPart = {
  id: "prt_btn", name: "Go", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
  visible: true, enabled: true, scriptSource: "", style: "roundRect", title: "Go", showName: true,
  autoHilite: true, hilite: false,
};

function makeStack(): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{
      id: "bkg_1", name: "Main", bitmap: emptyBitmap, scriptSource: "", cantDelete: false,
      parts: [field({ id: "prt_score", name: "Score" }), field({ id: "prt_title", name: "Title", sharedText: true, content: "Hello" })],
    }],
    cards: [
      {
        id: "crd_1", name: "First", backgroundId: "bkg_1", bitmap: emptyBitmap,
        parts: [button, field({ id: "prt_notes", name: "Notes", layerScope: "card", content: "abc" })],
        bgFieldContents: { prt_score: "1" }, marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
      },
      {
        id: "crd_2", name: "Second", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [],
        bgFieldContents: { prt_score: "2" }, marked: true, cantDelete: false, dontSearch: false, scriptSource: "",
      },
    ],
    customIcons: {}, scriptSource: "",
  };
}

interface TestHost extends HexHost {
  answerCalls: { prompt: string; buttons: string[] }[];
}

/** Store-backed host; dialogs and fetch return scripted results. */
function createHost(store: HexStore, scripted: Partial<Pick<HexHost, "showAnswer" | "showAsk" | "fetchJson" | "readField">> = {}): TestHost {
  const host: TestHost = {
    answerCalls: [],
    readField: (ref) => readFieldText(store.getSnapshot().stack, ref.cardId, ref.layer, ref.partId),
    applyRuntime: (m) => store.applyRuntime(m),
    resolveObject: (t, me) => resolveObjectTarget(store.getSnapshot(), t, me),
    goToCard: () => Promise.reject(new Error("not used")),
    playSound: () => undefined,
    showAnswer: (prompt, buttons) => {
      host.answerCalls.push({ prompt, buttons });
      return Promise.resolve(buttons[0]);
    },
    showAsk: (_prompt, defaultAnswer) => Promise.resolve(defaultAnswer),
    fetchJson: () => Promise.resolve({ ok: false, reason: "blocked url" }),
    now: () => ({ date: "1/1/26", time: "12:00 PM", ticks: 600, seconds: 10, mouseH: 3, mouseV: 4 }),
    ...scripted,
  };
  return host;
}

function setup(scripted?: Parameters<typeof createHost>[1]) {
  const store = createHexStore({ stack: makeStack(), compile: () => ({ ast: { handlers: {} }, errors: [] }) });
  const host = createHost(store, scripted);
  const globals = new Map<string, HexValue>();
  const controller = new AbortController();
  const newCtx = (): DispatchContext => createDispatchContext({ abortSignal: controller.signal, globals });
  return { store, host, globals, controller, newCtx };
}

// ---------------------------------------------------------------------------------------------
// AST builders
// ---------------------------------------------------------------------------------------------

const lit = (value: string | number | boolean): HexExprNode => ({ kind: "Literal", value });
const ref = (name: string): HexExprNode => ({ kind: "Variable", name });
const bin = (op: HexBinaryOp, left: HexExprNode, right: HexExprNode): HexExprNode => ({ kind: "BinaryOp", op, left, right });
const call = (name: Extract<HexExprNode, { kind: "FunctionCall" }>["name"], ...args: HexExprNode[]): HexExprNode =>
  ({ kind: "FunctionCall", name, args });
const toVar = (name: string): HexContainerTarget => ({ scope: "variable", name });
const toField = (layer: "card" | "background", name: string): Extract<HexContainerTarget, { scope: "field" }> =>
  ({ scope: "field", layer, selector: { by: "auto", value: lit(name) } });
const readField = (layer: "card" | "background", name: string): HexExprNode => ({ kind: "ReadContainer", source: toField(layer, name) });
const prop = (property: HexPropertyName, target: HexObjectTarget): HexExprNode => ({ kind: "ReadProperty", property, target });
const cardButton = (name: string | number): HexObjectTarget => ({ objectType: "button", layer: "card", selector: { by: "auto", value: lit(name) } });
const cardField = (name: string): HexObjectTarget => ({ objectType: "field", layer: "card", selector: { by: "auto", value: lit(name) } });

const at = (line: number, statement: HexStatementNode): HexStatementNode => ({ ...statement, loc: { line, column: 3 } });
const put = (value: HexExprNode, destination: HexContainerTarget, mode: "into" | "after" | "before" = "into"): HexStatementNode =>
  ({ kind: "PutValue", mode, value, destination });
const global = (...names: string[]): HexStatementNode => ({ kind: "DeclareGlobal", names });
const set = (property: HexPropertyName, target: HexObjectTarget, value: HexExprNode): HexStatementNode =>
  ({ kind: "SetProperty", property, target, value });
const ifThen = (condition: HexExprNode, ...thenBranch: HexStatementNode[]): HexStatementNode =>
  ({ kind: "IfCondition", condition, thenBranch });
const repeat = (head: Extract<HexStatementNode, { kind: "RepeatLoop" }>["head"], ...body: HexStatementNode[]): HexStatementNode =>
  ({ kind: "RepeatLoop", head, body });
const range = (varName: string, start: number, end: number, direction: "up" | "down" = "up") =>
  ({ type: "range" as const, varName, start: lit(start), end: lit(end), direction });

function handler(eventName: string, body: HexStatementNode[], params: string[] = []): HexHandlerNode {
  return { eventName, params, body, loc: { line: 1, column: 1 } };
}

/** Evaluates `expr` in a fresh handler and returns the value stored into the global `result`. */
async function evaluate(expr: HexExprNode): Promise<HexValue | undefined> {
  const { host, globals, newCtx } = setup();
  await runHandler(handler("test", [global("result"), put(expr, toVar("result"))]), [], "prt_btn", newCtx(), host);
  return globals.get("result");
}

// ---------------------------------------------------------------------------------------------
// Gas (Requirements 4.2, 4.3)
// ---------------------------------------------------------------------------------------------

describe("gas limit", () => {
  it("charges exactly one step per evaluated statement and expression node", async () => {
    const { host, newCtx } = setup();
    const ctx = newCtx();
    // PutValue + BinaryOp + 2 Literals
    await runHandler(handler("test", [put(bin("+", lit(1), lit(2)), toVar("x"))]), [], "prt_btn", ctx, host);
    expect(ctx.stepCount).toBe(4);
  });

  it("stops repeat forever with HexVmGasLimitError, keeps applied mutations and reports object, handler and line", async () => {
    const { store, host, newCtx } = setup();
    const ctx = newCtx();
    const add: HexStatementNode = { kind: "MathMutation", op: "add", amount: lit(1), destination: toField("background", "Score") };
    const loop = at(2, repeat({ type: "forever" }, at(3, add)));

    const error = await runHandler(handler("mouseUp", [loop]), [], "prt_btn", ctx, host).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(HexVmGasLimitError);
    expect(error).toMatchObject({ message: "Loop exceeded 10,000 steps", objectId: "prt_btn", handler: "mouseUp", line: 3 });
    expect(ctx.stepCount).toBe(GAS_LIMIT + 1);
    // 1 step for the repeat node, then 4 per iteration (loop, add, amount, field selector):
    // iteration 2500 overflows on its last step, before its write, so 2499 adds were kept.
    expect(readFieldText(store.getSnapshot().stack, "crd_1", "background", "prt_score")).toBe("2500");
  });

  it("stops a repeat loop with an empty body", async () => {
    const { host, newCtx } = setup();
    await expect(runHandler(handler("idle", [repeat({ type: "forever" })]), [], "crd_1", newCtx(), host))
      .rejects.toBeInstanceOf(HexVmGasLimitError);
  });

  it("shares one budget across handler runs on the same dispatch context", async () => {
    const { host, newCtx } = setup();
    const ctx = newCtx();
    // repeat node + count literal + 4001 iteration checks = 4003 steps
    const busy = handler("openCard", [repeat({ type: "count", times: lit(4000) })]);
    await runHandler(busy, [], "crd_1", ctx, host);
    await runHandler(busy, [], "crd_1", ctx, host);
    expect(ctx.stepCount).toBe(8006);
    await expect(runHandler(busy, [], "crd_1", ctx, host)).rejects.toBeInstanceOf(HexVmGasLimitError);
    // a fresh dispatch has a fresh budget
    await expect(runHandler(busy, [], "crd_1", newCtx(), host)).resolves.toBe("handled");
  });
});

// ---------------------------------------------------------------------------------------------
// Control flow (Requirement 5.6) and pass
// ---------------------------------------------------------------------------------------------

describe("control flow", () => {
  it("pass ends the handler and reports passed", async () => {
    const { host, globals, newCtx } = setup();
    const body = [global("log"), put(lit("before"), toVar("log")), { kind: "PassEvent", eventName: "MOUSEUP" } as HexStatementNode, put(lit("after"), toVar("log"))];
    await expect(runHandler(handler("mouseUp", body), [], "prt_btn", newCtx(), host)).resolves.toBe("passed");
    expect(globals.get("log")).toBe("before");
  });

  it("rejects pass with a foreign message name", async () => {
    const { host, newCtx } = setup();
    const body = [at(2, { kind: "PassEvent", eventName: "openCard" })];
    await expect(runHandler(handler("mouseUp", body), [], "prt_btn", newCtx(), host))
      .rejects.toMatchObject({ name: "HexScriptError", line: 2 });
  });

  it("exit <handler> ends the handler as handled", async () => {
    const { host, globals, newCtx } = setup();
    const body = [global("log"), put(lit("a"), toVar("log")), { kind: "ExitHandler" } as HexStatementNode, put(lit("b"), toVar("log"))];
    await expect(runHandler(handler("mouseUp", body), [], "prt_btn", newCtx(), host)).resolves.toBe("handled");
    expect(globals.get("log")).toBe("a");
  });

  it("next repeat continues and exit repeat leaves the innermost loop", async () => {
    const { host, globals, newCtx } = setup();
    const inner = repeat(range("j", 1, 3),
      ifThen(bin("=", ref("j"), lit(2)), { kind: "ExitRepeat" }),
      put(lit("."), toVar("log"), "after"));
    const outer = repeat(range("i", 1, 10),
      ifThen(bin("=", ref("i"), lit(3)), { kind: "NextRepeat" }),
      ifThen(bin("=", ref("i"), lit(6)), { kind: "ExitRepeat" }),
      put(ref("i"), toVar("log"), "after"),
      inner);
    await runHandler(handler("test", [global("log"), outer, put(lit("!"), toVar("log"), "after")]), [], "prt_btn", newCtx(), host);
    expect(globals.get("log")).toBe("1.2.4.5.!");
  });

  it("supports down to, count, while and until loops", async () => {
    const { host, globals, newCtx } = setup();
    const body = [
      global("down", "count", "w", "u"),
      repeat(range("i", 3, 1, "down"), put(ref("i"), toVar("down"), "after")),
      repeat({ type: "count", times: lit("3") }, put(lit("x"), toVar("count"), "after")),
      put(lit(0), toVar("w")),
      repeat({ type: "while", condition: bin("<", ref("w"), lit(4)) }, { kind: "MathMutation", op: "add", amount: lit(1), destination: toVar("w") }),
      put(lit(10), toVar("u")),
      repeat({ type: "until", condition: bin("<=", ref("u"), lit(7)) }, { kind: "MathMutation", op: "subtract", amount: lit(1), destination: toVar("u") }),
    ];
    await runHandler(handler("test", body), [], "prt_btn", newCtx(), host);
    expect(Object.fromEntries(globals)).toEqual({ down: "321", count: "xxx", w: 4, u: 7 });
  });

  it("reports exit repeat outside a loop as a script error", async () => {
    const { host, newCtx } = setup();
    await expect(runHandler(handler("test", [at(4, { kind: "ExitRepeat" })]), [], "prt_btn", newCtx(), host))
      .rejects.toMatchObject({ name: "HexScriptError", line: 4 });
  });
});

// ---------------------------------------------------------------------------------------------
// Values (Requirement 5.4)
// ---------------------------------------------------------------------------------------------

describe("value rules", () => {
  it.each<[string, HexExprNode, HexValue]>([
    ['"10" = 10.0 compares numerically', bin("=", lit("10"), lit(10.0)), true],
    ['" 5 " = 5 ignores surrounding spaces', bin("=", lit(" 5 "), lit(5)), true],
    ['"abc" = "ABC" is case-insensitive', bin("=", lit("abc"), lit("ABC")), true],
    ['"5a" <> 5 compares as text', bin("<>", lit("5a"), lit(5)), true],
    ['empty = 0 is false', bin("=", { kind: "Constant", name: "empty" }, lit(0)), false],
    ['"10" < "9" is numeric', bin("<", lit("10"), lit("9")), false],
    ['"b" > "A" is case-insensitive text order', bin(">", lit("b"), lit("A")), true],
    ['true = "TRUE"', bin("=", lit(true), lit("TRUE")), true],
    ["contains is case-insensitive", bin("contains", lit("Hello World"), lit("WORLD")), true],
    ['"2" + "3" converts numeric strings', bin("+", lit("2"), lit("3")), 5],
    ['"1.5" * 2', bin("*", lit("1.5"), lit(2)), 3],
    ["7 div 2", bin("div", lit(7), lit(2)), 3],
    ["-7 div 2 truncates", bin("div", lit(-7), lit(2)), -3],
    ["7 mod 3", bin("mod", lit(7), lit(3)), 1],
    ["1/3 prints with 6 decimals", bin("&", bin("/", lit(1), lit(3)), lit("")), "0.333333"],
    ['"a" && "b" inserts a space', bin("&&", lit("a"), lit("b")), "a b"],
    ['true and "TRUE" coerces strings in conditions', bin("and", lit(true), lit("TRUE")), true],
    ['not "false"', { kind: "UnaryOp", op: "not", operand: lit("false") }, true],
    ['-"4"', { kind: "UnaryOp", op: "-", operand: lit("4") }, -4],
    ["round(2.5)", call("round", lit(2.5)), 3],
    ["round(-2.5)", call("round", lit(-2.5)), -3],
    ["trunc(-1.7)", call("trunc", lit(-1.7)), -1],
    ["abs(-3)", call("abs", lit(-3)), 3],
    ['length("hello")', call("length", lit("hello")), 5],
    ["min(3, 1, 2)", call("min", lit(3), lit(1), lit(2)), 1],
    ['max("3", 10)', call("max", lit("3"), lit(10)), 10],
    ["quote constant", { kind: "Constant", name: "quote" }, "\""],
    ["unset variable is empty", ref("nothing"), ""],
    ["the ticks", { kind: "BuiltIn", name: "ticks" }, 600],
    ["the number of cards", { kind: "BuiltIn", name: "numberOfCards" }, 2],
    ["the number of this card", { kind: "BuiltIn", name: "cardNumber" }, 1],
  ])("%s", async (_label, expr, expected) => {
    expect(await evaluate(expr)).toEqual(expected);
  });

  it("short-circuits and/or", async () => {
    // the right side would be a type error if it were evaluated
    expect(await evaluate(bin("or", lit(true), bin("+", lit("x"), lit(1))))).toBe(true);
    expect(await evaluate(bin("and", lit(false), bin("+", lit("x"), lit(1))))).toBe(false);
  });

  it("random stays within 1..n", async () => {
    for (let i = 0; i < 20; i++) {
      const value = await evaluate(call("random", lit(6)));
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
    }
  });

  it.each<[string, HexExprNode, RegExp]>([
    ['"abc" + 1', bin("+", lit("abc"), lit(1)), /Expected a number but found "abc"/],
    ["empty + 1", bin("+", { kind: "Constant", name: "empty" }, lit(1)), /Expected a number/],
    ["1 / 0", bin("/", lit(1), lit(0)), /Division by zero/],
    ["5 mod 0", bin("mod", lit(5), lit(0)), /Division by zero/],
    ["not 1", { kind: "UnaryOp", op: "not", operand: lit(1) }, /Expected true or false/],
    ["abs()", call("abs"), /abs expects 1 argument, got 0/],
  ])("%s is a HexScriptError", async (_label, expr, message) => {
    const error = await evaluate(expr).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HexScriptError);
    expect((error as Error).message).toMatch(message);
  });

  it("requires a boolean condition in if", async () => {
    const { host, newCtx } = setup();
    await expect(runHandler(handler("test", [at(5, ifThen(lit("yes")))]), [], "prt_btn", newCtx(), host))
      .rejects.toMatchObject({ name: "HexScriptError", objectId: "prt_btn", handler: "test", line: 5 });
  });
});

// ---------------------------------------------------------------------------------------------
// Containers, properties and card context (Requirements 4.4, 5.3, 5.5)
// ---------------------------------------------------------------------------------------------

describe("containers and properties", () => {
  it("put into/after/before fields writes through the store", async () => {
    const { store, host, newCtx } = setup();
    const body = [
      put(lit("X"), toField("card", "Notes"), "after"),
      put(lit(">"), toField("card", "Notes"), "before"),
      put(lit("new"), toField("background", "Title")),
      { kind: "MathMutation", op: "multiply", amount: lit(7), destination: toField("background", "Score") } as HexStatementNode,
    ];
    await runHandler(handler("test", body), [], "prt_btn", newCtx(), host);
    const { stack } = store.getSnapshot();
    expect(readFieldText(stack, "crd_1", "card", "prt_notes")).toBe(">abcX");
    expect(readFieldText(stack, "crd_1", "background", "prt_title")).toBe("new");
    expect(readFieldText(stack, "crd_1", "background", "prt_score")).toBe("7");
    expect(readFieldText(stack, "crd_2", "background", "prt_score")).toBe("2"); // unshared text untouched
  });

  it("resolves field references against the current card at evaluation time; me stays bound", async () => {
    const { store, host, globals, newCtx } = setup();
    const read = handler("test", [global("score", "who"), put(readField("background", "Score"), toVar("score")), put(prop("name", { objectType: "me" }), toVar("who"))]);
    await runHandler(read, [], "prt_btn", newCtx(), host);
    expect(globals.get("score")).toBe("1");
    store.applyRuntime({ type: "goToCard", cardId: "crd_2" });
    await runHandler(read, [], "prt_btn", newCtx(), host);
    expect(globals.get("score")).toBe("2");
    expect(globals.get("who")).toBe("Go");
  });

  it("reads and writes properties using the store's location and rect conversions", async () => {
    const { store, host, globals, newCtx } = setup();
    const body = [
      global("loc", "rect", "style", "marked"),
      put(prop("location", cardButton("Go")), toVar("loc")),
      set("location", cardButton("Go"), lit("100,100")),
      put(prop("rect", cardButton(1)), toVar("rect")),
      set("hilite", cardButton("go"), lit("true")),
      put(prop("textStyle", cardField("Notes")), toVar("style")),
      set("name", { objectType: "card" }, lit(42)),
      put(prop("marked", { objectType: "card", selector: { by: "auto", value: lit(2) } }), toVar("marked")),
    ];
    await runHandler(handler("test", body), [], "prt_btn", newCtx(), host);
    expect(Object.fromEntries(globals)).toEqual({ loc: "50,20", rect: "60,90,140,110", style: "plain", marked: true });
    const card = store.getSnapshot().stack.cards[0];
    expect(card.name).toBe("42");
    expect(card.parts[0]).toMatchObject({ hilite: true, rect: { x: 60, y: 90, width: 80, height: 20 } });
  });

  it.each<[string, HexStatementNode]>([
    ["set hilite of a field", set("hilite", cardField("Notes"), lit(true))],
    ["set textFont of me (a button)", set("textFont", { objectType: "me" }, lit("Mono"))],
    ["set visible of this card", set("visible", { objectType: "card" }, lit(false))],
    ["set marked of this background", set("marked", { objectType: "background" }, lit(true))],
    ["get the marked of a button", { kind: "GetValue", value: prop("marked", cardButton("Go")) }],
    ["get the lockText of this stack", { kind: "GetValue", value: prop("lockText", { objectType: "stack" }) }],
  ])("%s is a HexScriptError", async (_label, statement) => {
    const { store, host, newCtx } = setup();
    const before = store.getSnapshot().stack;
    const error = await runHandler(handler("mouseUp", [at(7, statement)]), [], "prt_btn", newCtx(), host).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HexScriptError);
    expect(error).toMatchObject({ objectId: "prt_btn", handler: "mouseUp", line: 7, message: expect.stringMatching(/does not apply to a/) });
    expect(store.getSnapshot().stack).toBe(before);
  });

  it("reports invalid property values from the store as HexScriptError", async () => {
    const { host, newCtx } = setup();
    const error = await runHandler(handler("test", [at(2, set("textSize", cardField("Notes"), lit(13)))]), [], "prt_btn", newCtx(), host)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HexScriptError);
    expect(error).toMatchObject({ line: 2, message: expect.stringMatching(/Invalid textSize 13/) });
  });

  it("reports a missing part as HexScriptError", async () => {
    const { host, newCtx } = setup();
    await expect(runHandler(handler("test", [at(3, put(readField("card", "Nope"), toVar("x")))]), [], "prt_btn", newCtx(), host))
      .rejects.toMatchObject({ name: "HexScriptError", line: 3, message: 'No such card field "Nope"' });
  });
});

// ---------------------------------------------------------------------------------------------
// it, globals and parameters (Requirements 5.1, 5.2)
// ---------------------------------------------------------------------------------------------

describe("variables", () => {
  it("binds parameters, presets it to empty and lets get write it", async () => {
    const { host, globals, newCtx } = setup();
    const body = [global("first", "second", "initial", "got"), put(ref("it"), toVar("initial")), put(ref("a"), toVar("first")), put(ref("b"), toVar("second")),
      { kind: "GetValue", value: bin("*", ref("a"), lit(2)) } as HexStatementNode, put(ref("it"), toVar("got"))];
    await runHandler(handler("keyDown", body, ["a", "b"]), [21], "crd_1", newCtx(), host);
    expect(Object.fromEntries(globals)).toEqual({ initial: "", first: 21, second: "", got: 42 });
  });

  it("answer, ask and fetch write their result into it", async () => {
    const fetches: FetchResult[] = [{ ok: true, value: "21.5" }, { ok: false, reason: "timeout" }];
    const { store, host, globals, newCtx } = setup({
      showAsk: () => Promise.resolve("Ada"),
      fetchJson: () => Promise.resolve(fetches.shift()!),
    });
    const body = [
      global("answered", "asked", "fetched", "failed"),
      { kind: "ShowAnswerDialog", prompt: lit("Sure?"), buttons: [lit("Yes"), lit("No")] } as HexStatementNode,
      put(ref("it"), toVar("answered")),
      { kind: "ShowAnswerDialog", prompt: lit("Done"), buttons: [] } as HexStatementNode,
      { kind: "ShowAskDialog", prompt: lit("Name?") } as HexStatementNode,
      put(ref("it"), toVar("asked")),
      { kind: "FetchJson", url: lit("https://api.example.com/x"), jsonPath: "a.b", destination: toField("card", "Notes") } as HexStatementNode,
      put(ref("it"), toVar("fetched")),
      { kind: "FetchJson", url: lit("https://api.example.com/y"), destination: toField("background", "Score") } as HexStatementNode,
      put(ref("it"), toVar("failed")),
    ];
    await runHandler(handler("test", body), [], "prt_btn", newCtx(), host);
    expect(Object.fromEntries(globals)).toEqual({ answered: "Yes", asked: "Ada", fetched: "21.5", failed: "error: timeout" });
    expect(host.answerCalls[1]).toEqual({ prompt: "Done", buttons: ["OK"] });
    const { stack } = store.getSnapshot();
    expect(readFieldText(stack, "crd_1", "card", "prt_notes")).toBe("21.5");
    expect(readFieldText(stack, "crd_1", "background", "prt_score")).toBe("1"); // unchanged on failure
  });

  it("shares declared globals across handler calls and keeps undeclared names local", async () => {
    const { host, globals, newCtx } = setup();
    await runHandler(handler("a", [global("g"), put(lit(1), toVar("g"))]), [], "crd_1", newCtx(), host);
    await runHandler(handler("b", [put(lit(2), toVar("g"))]), [], "crd_1", newCtx(), host); // local g
    await runHandler(handler("c", [global("g", "seen"), put(ref("g"), toVar("seen"))]), [], "crd_1", newCtx(), host);
    expect(globals.get("seen")).toBe(1);
  });

  it("keeps locals per handler call", async () => {
    const { host, globals, newCtx } = setup();
    await runHandler(handler("a", [put(lit("secret"), toVar("x"))]), [], "crd_1", newCtx(), host);
    await runHandler(handler("b", [global("seen"), put(ref("x"), toVar("seen"))]), [], "crd_1", newCtx(), host);
    expect(globals.get("seen")).toBe("");
  });
});

// ---------------------------------------------------------------------------------------------
// Abort (Requirement 4.5)
// ---------------------------------------------------------------------------------------------

describe("abort", () => {
  it("stops at the next statement boundary", async () => {
    const env = setup({
      readField: (ref) => {
        env.controller.abort(); // abort arrives while the first statement runs
        return readFieldText(env.store.getSnapshot().stack, ref.cardId, ref.layer, ref.partId);
      },
    });
    const body = [global("first", "second"), put(readField("background", "Score"), toVar("first")), put(lit("ran"), toVar("second"))];
    await expect(runHandler(handler("test", body), [], "prt_btn", env.newCtx(), env.host)).rejects.toBeInstanceOf(HexAbortError);
    expect(env.globals.get("first")).toBe("1"); // the running statement completed
    expect(env.globals.has("second")).toBe(false);
  });

  it("stops a suspended dialog when the signal fires", async () => {
    const { host, controller, globals, newCtx } = setup({ showAsk: () => new Promise<string>(() => undefined) });
    const body = [global("after"), { kind: "ShowAskDialog", prompt: lit("Name?") } as HexStatementNode, put(lit("ran"), toVar("after"))];
    const running = runHandler(handler("test", body), [], "prt_btn", newCtx(), host);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let the dialog open first
    controller.abort();
    await expect(running).rejects.toBeInstanceOf(HexAbortError);
    expect(globals.has("after")).toBe(false);
  });
});
