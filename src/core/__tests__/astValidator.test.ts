import { describe, expect, it } from "vitest";
import type { HexExprNode, HexScriptAST, HexStatementNode } from "../ast.ts";
import { validateAst } from "../astValidator.ts";

const lit = (value: string | number | boolean): HexExprNode => ({ kind: "Literal", value });

function script(body: HexStatementNode[], eventName = "mouseUp"): HexScriptAST {
  return { handlers: { [eventName.toLowerCase()]: { eventName, params: [], body } } };
}

function reasonOf(input: unknown): string {
  const result = validateAst(input);
  if (result.ok) throw new Error("expected the AST to be rejected");
  return result.reason;
}

/** Covers every statement kind and most expression/target shapes. */
const fullAst: HexScriptAST = {
  handlers: {
    mouseup: {
      eventName: "mouseUp",
      params: [],
      loc: { line: 1, column: 1 },
      body: [
        { kind: "DeclareGlobal", names: ["score"] },
        { kind: "QueueVisualEffect", effect: "dissolve", speed: "fast" },
        { kind: "GoToCard", target: { type: "relative", dir: "next" }, loc: { line: 3, column: 3 } },
        { kind: "GoToCard", target: { type: "id", value: lit("crd_1") } },
        {
          kind: "PutValue",
          mode: "into",
          value: { kind: "BinaryOp", op: "&&", left: lit("Hello"), right: { kind: "Variable", name: "it" } },
          destination: { scope: "field", layer: "background", selector: { by: "auto", value: lit("Name") } },
        },
        { kind: "GetValue", value: { kind: "BuiltIn", name: "numberOfCards" } },
        {
          kind: "MathMutation",
          op: "add",
          amount: { kind: "UnaryOp", op: "-", operand: lit(2.5) },
          destination: { scope: "variable", name: "score" },
        },
        {
          kind: "SetProperty",
          property: "hilite",
          target: { objectType: "button", layer: "card", selector: { by: "id", value: lit("prt_1") } },
          value: lit(true),
        },
        { kind: "PlaySound", voice: "harpsichord", tempo: 120, notes: "c4e d5q" },
        { kind: "ShowAnswerDialog", prompt: lit("Ready?"), buttons: [lit("Yes"), lit("No"), lit("Maybe")] },
        { kind: "ShowAskDialog", prompt: lit("Name?"), defaultAnswer: { kind: "Constant", name: "empty" } },
        { kind: "Wait", amount: lit(2), unit: "seconds" },
        {
          kind: "FetchJson",
          url: lit("https://api.example.com/data"),
          jsonPath: "daily.time[0]",
          destination: { scope: "variable", name: "weather" },
        },
        {
          kind: "IfCondition",
          condition: {
            kind: "BinaryOp",
            op: "contains",
            left: { kind: "ReadContainer", source: { scope: "field", layer: "card", selector: { by: "auto", value: lit(1) } } },
            right: lit("x"),
          },
          thenBranch: [{ kind: "ExitHandler" }],
          elseBranch: [{ kind: "PassEvent", eventName: "mouseup" }],
        },
        {
          kind: "RepeatLoop",
          head: { type: "range", varName: "i", start: lit(1), end: lit(10), direction: "down" },
          body: [
            { kind: "NextRepeat" },
            { kind: "ExitRepeat" },
            {
              kind: "SetProperty",
              property: "name",
              target: { objectType: "card" },
              value: { kind: "FunctionCall", name: "random", args: [lit(6)] },
            },
          ],
        },
        {
          kind: "GetValue",
          value: { kind: "ReadProperty", property: "marked", target: { objectType: "stack" } },
        },
      ],
    },
    opencard: { eventName: "openCard", params: ["a", "b_2"], body: [] },
  },
};

describe("validateAst", () => {
  it("accepts a valid AST and returns a copy that shares no objects with the input", () => {
    const result = validateAst(fullAst);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ast).toEqual(fullAst);
    expect(result.ast).not.toBe(fullAst);
    expect(result.ast.handlers.mouseup.body).not.toBe(fullAst.handlers.mouseup.body);
  });

  it("accepts an empty script and boundary tempos", () => {
    expect(validateAst({ handlers: {} }).ok).toBe(true);
    for (const tempo of [20, 400]) {
      expect(validateAst(script([{ kind: "PlaySound", voice: "click", tempo, notes: "c" }])).ok).toBe(true);
    }
  });

  it("rejects non-object input", () => {
    expect(validateAst(null).ok).toBe(false);
    expect(validateAst("on mouseUp").ok).toBe(false);
  });

  describe("string literal rule", () => {
    it('rejects a literal containing "', () => {
      const reason = reasonOf(script([{ kind: "GetValue", value: lit('say "hi"') }]));
      expect(reason).toBe("ast.handlers.mouseup.body[0].value.value: string literal must not contain a double quote (use the constant quote)");
    });

    it("rejects a literal containing a newline", () => {
      expect(reasonOf(script([{ kind: "GetValue", value: lit("a\nb") }]))).toMatch(/must not contain a newline/);
      expect(reasonOf(script([{ kind: "GetValue", value: lit("a\rb") }]))).toMatch(/must not contain a newline/);
    });

    it("applies to PlaySound notes and FetchJson jsonPath", () => {
      expect(reasonOf(script([{ kind: "PlaySound", voice: "flute", tempo: 120, notes: 'c"' }])))
        .toMatch(/^ast\.handlers\.mouseup\.body\[0\]\.notes: .*double quote/);
      expect(reasonOf(script([{
        kind: "FetchJson", url: lit("https://x.test"), jsonPath: "a\nb", destination: { scope: "variable", name: "it" },
      }]))).toMatch(/^ast\.handlers\.mouseup\.body\[0\]\.jsonPath: .*newline/);
    });
  });

  it("rejects an unknown property name", () => {
    const ast = script([{
      kind: "SetProperty", property: "colour" as never, target: { objectType: "me" }, value: lit(1),
    }]);
    expect(reasonOf(ast)).toBe('ast.handlers.mouseup.body[0].property: unknown property "colour"');
  });

  it("rejects an unknown voice name", () => {
    const ast = script([{ kind: "PlaySound", voice: "piano" as never, tempo: 120, notes: "c" }]);
    expect(reasonOf(ast)).toBe('ast.handlers.mouseup.body[0].voice: unknown voice "piano"');
  });

  it("rejects an unknown visual effect name", () => {
    const ast = script([{ kind: "QueueVisualEffect", effect: "zoomOpen" as never, speed: "slow" }]);
    expect(reasonOf(ast)).toBe('ast.handlers.mouseup.body[0].effect: unknown visual effect "zoomOpen"');
  });

  describe("pass rule", () => {
    it("rejects pass naming a foreign message", () => {
      const reason = reasonOf(script([{ kind: "PassEvent", eventName: "opencard" }]));
      expect(reason).toBe('ast.handlers.mouseup.body[0].eventName: pass names "opencard" but the enclosing handler is "mouseup"');
    });

    it("finds a foreign pass nested in if and repeat blocks", () => {
      const ast = script([{
        kind: "RepeatLoop",
        head: { type: "forever" },
        body: [{
          kind: "IfCondition",
          condition: lit(true),
          thenBranch: [],
          elseBranch: [{ kind: "PassEvent", eventName: "keydown" }],
        }],
      }]);
      expect(reasonOf(ast)).toMatch(/^ast\.handlers\.mouseup\.body\[0\]\.body\[0\]\.elseBranch\[0\]\.eventName: pass names "keydown"/);
    });

    it("rejects pass with a non-lowercase name", () => {
      expect(reasonOf(script([{ kind: "PassEvent", eventName: "mouseUp" }]))).toMatch(/expected a lowercase identifier/);
    });
  });

  it("rejects PlaySound.tempo outside 20..400", () => {
    for (const tempo of [19, 401, 0, -120]) {
      const reason = reasonOf(script([{ kind: "PlaySound", voice: "boing", tempo, notes: "c" }]));
      expect(reason).toBe("ast.handlers.mouseup.body[0].tempo: tempo must be between 20 and 400");
    }
    expect(validateAst(script([{ kind: "PlaySound", voice: "boing", tempo: Number.NaN, notes: "c" }])).ok).toBe(false);
  });

  describe("round-trip safety rules", () => {
    it("rejects unknown object keys", () => {
      const ast = script([{ kind: "ExitRepeat", extra: 1 } as never]);
      expect(reasonOf(ast)).toMatch(/^ast\.handlers\.mouseup\.body\[0\]: Unrecognized key/);
    });

    it("rejects an unknown statement kind", () => {
      expect(reasonOf(script([{ kind: "Eval" } as never]))).toBe('ast.handlers.mouseup.body[0].kind: unknown statement kind "Eval"');
    });

    it("rejects a handler key that is not the lowercased eventName", () => {
      const ast = { handlers: { mousedown: { eventName: "mouseUp", params: [], body: [] } } };
      expect(reasonOf(ast)).toBe('ast.handlers.mousedown: handler key must be "mouseup" (the lowercased eventName)');
    });

    it("rejects a __proto__ handler key", () => {
      const input: unknown = JSON.parse('{"handlers":{"__proto__":{"eventName":"x","params":[],"body":[]}}}');
      expect(reasonOf(input)).toBe("ast.handlers.__proto__: handler key must be a lowercase identifier");
    });

    it("rejects reserved words and malformed identifiers", () => {
      expect(reasonOf(script([{ kind: "GetValue", value: { kind: "Variable", name: "card" } }]))).toMatch(/"card" is a reserved word/);
      expect(reasonOf(script([], "Repeat"))).toMatch(/"Repeat" is a reserved word/);
      expect(reasonOf(script([{ kind: "DeclareGlobal", names: ["2x"] }]))).toMatch(/expected a lowercase identifier/);
    });

    it("rejects number literals HexTalk cannot spell", () => {
      for (const value of [-1, -0, 1e21, Number.POSITIVE_INFINITY]) {
        expect(validateAst(script([{ kind: "GetValue", value: lit(value) }])).ok).toBe(false);
      }
    });

    it("rejects more than 3 answer buttons", () => {
      const ast = script([{ kind: "ShowAnswerDialog", prompt: lit("?"), buttons: [lit("a"), lit("b"), lit("c"), lit("d")] }]);
      expect(reasonOf(ast)).toBe("ast.handlers.mouseup.body[0].buttons: at most 3 answer buttons");
    });
  });
});
