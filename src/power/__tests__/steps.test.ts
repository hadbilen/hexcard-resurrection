// Spec 07 tasks 3.2 and 5.1: the steps of Requirement 5.4 (the gate, the script compiler and the
// drawing-command check) with throwing test doubles, each followed by a correct answer to the next
// call (Requirements 5.4, 5.5, 17.1).
import { describe, expect, it } from "vitest";
import { parseHexTalk } from "../../core/parser.ts";
import { listStackErrors } from "../../storage/stackLoader.ts";
import { checkDrawCommands } from "../tools/drawLayer.ts";
import { GOOD_SCRIPT, makeCaller, makeStack, toHexstack } from "./toolFixtures.ts";

const stackText = JSON.stringify(makeStack());

/** A double that throws `thrown` on its first call and delegates to the real step afterwards. */
function throwOnce<A extends unknown[], R>(real: (...args: A) => R, thrown: unknown): (...args: A) => R {
  let calls = 0;
  return (...args) => {
    if (calls++ === 0) throw thrown;
    return real(...args);
  };
}

describe("listStackErrors throws (Requirement 5.4)", () => {
  it("answers validate_stack with an error result naming stack, then answers the next call correctly", async () => {
    const { call } = makeCaller({ steps: { listStackErrors: throwOnce(listStackErrors, new RangeError("Maximum call stack size exceeded")) } });
    const failed = await call("validate_stack", { stack: stackText });
    expect(failed.isError).toBe(true);
    expect(failed.json).toEqual({ ok: false, errors: ["stack: The stack could not be checked: Maximum call stack size exceeded"] });
    const next = await call("validate_stack", { stack: stackText });
    expect(next.isError).toBe(false);
    expect(next.json.ok).toBe(true);
  });

  it("does the same for a .hexstack text and for a thrown value that is not an Error", async () => {
    const { call } = makeCaller({ steps: { listStackErrors: throwOnce(listStackErrors, "plain value") } });
    const failed = await call("validate_stack", { stack: await toHexstack(makeStack()) });
    expect(failed.json.errors).toEqual(["stack: The stack could not be checked: plain value"]);
    expect((await call("validate_stack", { stack: stackText })).json.ok).toBe(true);
  });

  it("keeps at most 80 consecutive characters of the thrown message (Requirement 5.7)", async () => {
    const { call } = makeCaller({ steps: { listStackErrors: throwOnce(listStackErrors, new Error("e".repeat(300))) } });
    const failed = await call("validate_stack", { stack: stackText });
    expect(failed.isError).toBe(true);
    expect(failed.json.errors).toEqual([`stack: The stack could not be checked: ${"e".repeat(77)}...`]);
  });

  it("is not used for a stack text that cannot be read", async () => {
    let calls = 0;
    const { call } = makeCaller({ steps: { listStackErrors: (input) => { calls++; return listStackErrors(input); } } });
    expect((await call("validate_stack", { stack: "{ not json" })).isError).toBe(true);
    expect(calls).toBe(0);
  });
});

describe("parseHexTalk throws (Requirement 5.4)", () => {
  it("answers compile_hextalk with an error result naming source, then answers the next call correctly", async () => {
    const { call } = makeCaller({ steps: { parseHexTalk: throwOnce(parseHexTalk, new RangeError("Maximum call stack size exceeded")) } });
    const failed = await call("compile_hextalk", { source: GOOD_SCRIPT });
    expect(failed.isError).toBe(true);
    expect(failed.json).toEqual({ ok: false, errors: ["source: The script could not be compiled: Maximum call stack size exceeded"] });
    const next = await call("compile_hextalk", { source: GOOD_SCRIPT });
    expect(next.isError).toBe(false);
    expect(next.json.ok).toBe(true);
    expect(next.json.handlers).toEqual(["mouseUp"]);
  });

  it("answers validate_stack with an error result naming stack when a script in the stack cannot be compiled", async () => {
    const stack = makeStack();
    stack.cards[0].scriptSource = GOOD_SCRIPT;
    const text = JSON.stringify(stack);
    const { call } = makeCaller({ steps: { parseHexTalk: throwOnce(parseHexTalk, new Error("boom")) } });
    const failed = await call("validate_stack", { stack: text });
    expect(failed.isError).toBe(true);
    expect(failed.json).toEqual({ ok: false, errors: ["stack: A script in the stack could not be compiled: boom"] });
    const next = await call("validate_stack", { stack: text });
    expect(next.isError).toBe(false);
    expect(next.json.ok).toBe(true);
  });

  it("keeps at most 80 consecutive characters of the thrown message (Requirement 5.7)", async () => {
    const { call } = makeCaller({ steps: { parseHexTalk: throwOnce(parseHexTalk, new Error("p".repeat(300))) } });
    const failed = await call("compile_hextalk", { source: "" });
    expect(failed.json.errors).toEqual([`source: The script could not be compiled: ${"p".repeat(77)}...`]);
  });

  it("does not stop the server: a throwing step in one tool leaves the other tools working", async () => {
    const { call } = makeCaller({
      steps: {
        parseHexTalk: () => { throw new Error("always"); },
        listStackErrors: () => { throw new Error("always"); },
      },
    });
    expect((await call("compile_hextalk", { source: "" })).isError).toBe(true);
    expect((await call("validate_stack", { stack: stackText })).isError).toBe(true);
    expect((await call("conjure_script", { prompt: "go to the next card" })).json.ok).toBe(true);
  });
});

describe("checkDrawCommands throws (Requirement 5.4)", () => {
  const commands = [{ op: "rect", x: 2, y: 2, width: 4, height: 3, filled: true }];

  it("answers draw_layer with an error result naming commands, then answers the next call correctly", async () => {
    const { call } = makeCaller({ steps: { checkDrawCommands: throwOnce(checkDrawCommands, new RangeError("Maximum call stack size exceeded")) } });
    const failed = await call("draw_layer", { layer: "card", commands });
    expect(failed.isError).toBe(true);
    expect(failed.json).toEqual({ ok: false, errors: ["commands: The drawing commands could not be checked: Maximum call stack size exceeded"] });
    expect(failed.json).not.toHaveProperty("rleData");
    const next = await call("draw_layer", { layer: "card", commands });
    expect(next.isError).toBe(false);
    expect(next.json).toMatchObject({ ok: true, layer: "card", darkPixels: 12 });
    expect(next.json.rleData).not.toBe("");
  });

  it("does the same for a thrown value that is not an Error, and keeps at most 80 consecutive characters of the message (Requirement 5.7)", async () => {
    const plain = makeCaller({ steps: { checkDrawCommands: throwOnce(checkDrawCommands, "plain value") } });
    expect((await plain.call("draw_layer", { layer: "card", commands })).json.errors).toEqual(["commands: The drawing commands could not be checked: plain value"]);
    expect((await plain.call("draw_layer", { layer: "card", commands })).json.ok).toBe(true);
    const long = makeCaller({ steps: { checkDrawCommands: throwOnce(checkDrawCommands, new Error("d".repeat(300))) } });
    const failed = await long.call("draw_layer", { layer: "card", commands });
    expect(failed.json.errors).toEqual([`commands: The drawing commands could not be checked: ${"d".repeat(77)}...`]);
  });

  it("answers with that one entry when the step throws for a later command, whatever the earlier commands reported", async () => {
    let calls = 0;
    const { call } = makeCaller({
      steps: { checkDrawCommands: (list) => { if (calls++ === 1) throw new Error("second"); return checkDrawCommands(list); } },
    });
    const bad = { op: "rect", x: 511, y: 0, width: 5, height: 1 };
    const failed = await call("draw_layer", { layer: "card", commands: [bad, bad, bad] });
    expect(failed.json.errors).toEqual(["commands: The drawing commands could not be checked: second"]);
  });

  it("is used once per command that passed the inputSchema, and not for one that failed it", async () => {
    let calls = 0;
    const { call } = makeCaller({ steps: { checkDrawCommands: (list) => { calls++; return checkDrawCommands(list); } } });
    await call("draw_layer", { layer: "card", commands: [commands[0], { op: "rect", x: -1, y: 0, width: 1, height: 1 }, commands[0]] });
    expect(calls).toBe(2);
    calls = 0;
    await call("draw_layer", { layer: "paper", commands: "none" });
    expect(calls).toBe(0);
  });

  it("does not stop the server: a throwing step in draw_layer leaves the other tools working", async () => {
    const { call } = makeCaller({ steps: { checkDrawCommands: () => { throw new Error("always"); } } });
    expect((await call("draw_layer", { layer: "card", commands })).isError).toBe(true);
    expect((await call("compile_hextalk", { source: GOOD_SCRIPT })).json.ok).toBe(true);
    expect((await call("render_card", { stack: stackText })).json.ok).toBe(true);
  });
});

describe("no state between calls (Requirement 5.5)", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["validate_stack", { stack: stackText }],
    ["validate_stack", { stack: stackText, hexstack: true }],
    ["validate_stack", { stack: "{ not json" }],
    ["validate_stack", { stack: JSON.stringify({ ...makeStack(), schemaVersion: "1.0.0" }) }],
    ["compile_hextalk", { source: GOOD_SCRIPT }],
    ["compile_hextalk", { source: "on mouseUp\n  zzz\nend mouseUp" }],
    ["compile_hextalk", { source: "" }],
    ["conjure_script", { prompt: "go to the next card" }],
    ["conjure_script", { prompt: "zorp the flibbertigibbet" }],
    ["conjure_script", { prompt: "when the card opens, play a spooky harpsichord tune", objectKind: "button" }],
    ["render_card", { stack: stackText }],
    ["render_card", { stack: stackText, card: 2, scale: 2 }],
    ["render_card", { stack: stackText, card: 9 }],
    ["draw_layer", { layer: "card", commands: [{ op: "rect", x: 2, y: 2, width: 40, height: 30, pattern: 7, filled: true }, { op: "text", x: 4, y: 4, text: "Same", width: 20, height: 10 }] }],
    ["draw_layer", { layer: "background", commands: [{ op: "sprite", x: 9, y: 9, rows: ["#.#", ".#."] }, { op: "line", x1: 0, y1: 0, x2: 200, y2: 90 }] }],
    ["draw_layer", { layer: "background", commands: [{ op: "rect", x: 0, y: 0, width: 4, height: 4, pattern: 0 }] }],
    ["draw_layer", { layer: "card", commands: [{ op: "rect", x: 511, y: 0, width: 5, height: 1 }] }],
  ];

  it("returns for each call the text that a newly created server returns, whatever came before, for all five tools", async () => {
    expect(new Set(calls.map(([name]) => name))).toEqual(new Set(["validate_stack", "compile_hextalk", "conjure_script", "render_card", "draw_layer"]));
    const fresh: string[] = [];
    for (const [name, args] of calls) fresh.push((await makeCaller().call(name, args)).text);

    const shared = makeCaller();
    // Forward, backward and repeated, on one instance.
    for (const order of [calls.map((_, i) => i), calls.map((_, i) => calls.length - 1 - i), calls.map((_, i) => i)]) {
      for (const i of order) {
        const [name, args] = calls[i];
        expect((await shared.call(name, args)).text, `${name} ${i}`).toBe(fresh[i]);
      }
    }
  });
});
