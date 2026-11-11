// Spec 07 task 3.2: compile_hextalk (Requirements 5.3, 5.6, 5.7, 7.1-7.6, 17.1).
import { describe, expect, it } from "vitest";
import { parseHexTalk, printHexTalk } from "../../core/parser.ts";
import { makeCaller } from "./toolFixtures.ts";

const { call } = makeCaller();
const compile = (source: string) => call("compile_hextalk", { source });

describe("compile_hextalk: accepted scripts (Requirements 7.3, 7.4)", () => {
  it("returns the canonical form that printHexTalk gives, the handler names in source order and no note", async () => {
    const source = "-- greet\non MOUSEUP\n go next\nend MOUSEUP\n\non openCard\n  go prev\nend openCard\n";
    const result = await compile(source);
    expect(result.isError).toBe(false);
    expect(result.json.ok).toBe(true);
    expect(result.json.canonical).toBe(printHexTalk(parseHexTalk(source).ast));
    expect(result.json.handlers).toEqual(["MOUSEUP", "openCard"]);
    expect(result.json.notes).toEqual([]);
    expect(Object.keys(result.json)).toEqual(["ok", "canonical", "handlers", "notes"]);
  });

  it("returns a canonical form unchanged when it is compiled again, with the same handler names", async () => {
    const first = await compile("on mouseUp\n  go next\n  visual effect dissolve\nend mouseUp\non idle\n  go prev\nend idle");
    const second = await compile(first.json.canonical);
    expect(second.json).toEqual(first.json);
  });

  it("returns a canonical form longer than 80 characters whole, and handler names whole", async () => {
    const longName = `h${"a".repeat(120)}`;
    const source = `on ${longName}\n  put "${"x".repeat(150)}" into card field "Out"\nend ${longName}`;
    const result = await compile(source);
    expect(result.json.ok).toBe(true);
    expect(result.json.canonical.length).toBeGreaterThan(80);
    expect(result.json.canonical).toContain("x".repeat(150));
    expect(result.json.handlers).toEqual([longName]);
    expect(result.json.canonical).toBe(printHexTalk(parseHexTalk(source).ast));
  });

  it.each(["", "   \n\n", "-- only a comment\n\n"])("returns an empty canonical form and the note for %j (Requirement 7.5)", async (source) => {
    const result = await compile(source);
    expect(result.json).toEqual({ ok: true, canonical: "", handlers: [], notes: ["The script has no handlers."] });
  });

  it("never runs the script: wait, repeat forever, play, go and fetch compile like any other (Requirement 7.6)", async () => {
    const source = [
      "on mouseUp",
      "  repeat forever",
      "    wait 10 ticks",
      '    play harpsichord "c4q"',
      "  end repeat",
      "end mouseUp",
    ].join("\n");
    const result = await compile(source);
    expect(result.json.ok).toBe(true);
    expect(result.json.handlers).toEqual(["mouseUp"]);
  });
});

describe("compile_hextalk: compile errors (Requirement 7.2)", () => {
  it("returns ok false as a normal result with line, column and message, and the handlers that compiled", async () => {
    const source = "on mouseUp\n  go next\nend mouseUp\non foo\n  zzz\nend foo";
    const parsed = parseHexTalk(source);
    const result = await compile(source);
    expect(result.isError).toBe(false);
    expect(result.json).toEqual({
      ok: false,
      compileErrors: parsed.errors.map((e) => ({ line: e.line, column: e.column, message: e.message })),
      handlers: ["mouseUp"],
      notes: [],
    });
    expect(result.json.compileErrors[0]).toMatchObject({ line: 5, column: 3 });
    expect(result.json.canonical).toBeUndefined();
  });

  it("passes the source to the parser unchanged: CRLF line endings and leading white space keep their lines and columns", async () => {
    const source = "\r\n  on mouseUp\r\n    go next\r\n  end mouseUp\r\non foo\r\n  zzz\r\nend foo\r\n";
    const parsed = parseHexTalk(source);
    expect(parsed.errors).not.toEqual([]);
    const result = await compile(source);
    expect(result.json.compileErrors.map((e: { line: number; column: number }) => [e.line, e.column]))
      .toEqual(parsed.errors.map((e) => [e.line, e.column]));
    expect(result.json.compileErrors[0].line).toBe(6);
  });

  it("returns an empty handler list when no handler compiled", async () => {
    const result = await compile("nonsense");
    expect(result.json.ok).toBe(false);
    expect(result.json.handlers).toEqual([]);
  });

  it("shortens a long token quoted in a message to 77 characters and ... (Requirement 5.7)", async () => {
    const token = "q".repeat(200);
    const result = await compile(`on mouseUp\n  ${token} here\nend mouseUp`);
    const [error] = result.json.compileErrors;
    expect(error.message).toBe(`unknown command "${"q".repeat(77)}..."`);
    expect(result.text).not.toContain("q".repeat(81));
  });

  it("shows 100 errors whole and 101 as the first 100 and the count 1 (Requirement 5.6)", async () => {
    const script = (count: number): string => Array.from({ length: count }, (_, i) => `on h${i}\n  nonsense here\nend h${i}\n`).join("");
    const hundred = (await compile(script(100))).json;
    expect(hundred.compileErrors).toHaveLength(100);
    expect(hundred.compileErrorsNotShown).toBeUndefined();
    const more = (await compile(script(101))).json;
    expect(more.compileErrors).toHaveLength(100);
    expect(more.compileErrorsNotShown).toBe(1);
    expect(more.compileErrors[99].line).toBe(2 + 99 * 3);
  });
});

describe("compile_hextalk: arguments (Requirement 4.5)", () => {
  it("rejects a missing, non-string or unknown argument", async () => {
    expect((await call("compile_hextalk", {})).json.errors).toEqual(["source: is required"]);
    expect((await call("compile_hextalk", { source: 1 })).json.errors).toEqual(["source: must be a string"]);
    expect((await call("compile_hextalk", { source: "", other: 1 })).json.errors).toEqual(["other: is not an allowed argument"]);
  });
});
