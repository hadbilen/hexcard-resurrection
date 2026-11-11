/// <reference types="node" />
// Spec 07 task 3.2: validate_stack (Requirements 5.2, 5.6, 5.7, 6.1-6.7, 14.1, 17.1).
import { describe, expect, it } from "vitest";
import { BLANK_ICON } from "../../core/icons.ts";
import type { HexStack } from "../../core/schema.ts";
import { encodeBitmapRLE, TOTAL_PIXELS } from "../../engine/graphics/rleCodec.ts";
import { decodeStackFile } from "../../storage/stackFile.ts";
import { checkStack } from "../../storage/stackLoader.ts";
import { MAX_STACK_TEXT } from "../stackText.ts";
import { GOOD_SCRIPT, button, clone, field, makeCaller, makeStack, toHexstack } from "./toolFixtures.ts";

// Per-test budget for the heavy test, so CPU contention in the parallel suite cannot time it out.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

/** Valid Base64 whose PackBits stream does not give 512 x 342 pixels. */
const BAD_LAYER = "AAAA";
const DARK_LAYER = encodeBitmapRLE(new Uint8Array(TOTAL_PIXELS).fill(2));
/**
 * Valid data for a dark layer that is not the codec's own output: it decodes to the same pixels but
 * encodes differently. A leading PackBits no-op byte (0x80) does that.
 */
const NON_CANONICAL_LAYER = Buffer.concat([Buffer.from([0x80]), Buffer.from(DARK_LAYER, "base64")]).toString("base64");
const { call } = makeCaller();
const validate = (stack: string, extra: Record<string, unknown> = {}) => call("validate_stack", { stack, ...extra });

describe("validate_stack: accepted stacks (Requirements 6.3, 6.5)", () => {
  it("returns ok, no errors, no script errors, no notes, the name and the counts, in this key order", async () => {
    const result = await validate(JSON.stringify(makeStack()));
    expect(result.isError).toBe(false);
    expect(result.contentTypes).toEqual(["text"]);
    expect(result.json).toEqual({
      ok: true, errors: [], scriptErrors: [], notes: [], stack: { name: "Fixture", cards: 2, backgrounds: 1 },
    });
    expect(Object.keys(result.json)).toEqual(["ok", "errors", "scriptErrors", "notes", "stack"]);
  });

  it("quotes a stack name longer than 80 characters (Requirement 5.7)", async () => {
    const stack = makeStack();
    stack.name = `${"n".repeat(77)}tail-of-the-name`;
    const result = await validate(JSON.stringify(stack));
    expect(result.json.stack.name).toBe(`${"n".repeat(77)}...`);
    stack.name = "m".repeat(80);
    expect((await validate(JSON.stringify(stack))).json.stack.name).toBe("m".repeat(80));
  });

  it("reads JSON text with white space around it, and a leading { after white space (Requirement 6.1)", async () => {
    const text = `  \n\t${JSON.stringify(makeStack())}\r\n `;
    expect((await validate(text)).json.ok).toBe(true);
  });

  it("is not a gate result for a stack that looks like a URL: it is read as .hexstack text (Requirement 5.1)", async () => {
    const result = await validate("https://example.com/a.hexstack");
    expect(result.isError).toBe(true);
    expect(result.json).toEqual({ ok: false, errors: ["stack: The data is not valid Base64URL"] });
  });
});

describe("validate_stack: both text forms (Requirement 6.7)", () => {
  it("returns the same result for a JSON text and for its .hexstack text", async () => {
    const stack = makeStack();
    stack.scriptSource = "on openStack\n  go next\n"; // a script error
    stack.cards[0].bitmap.rleData = NON_CANONICAL_LAYER;
    stack.backgrounds[0].bitmap.rleData = DARK_LAYER;
    const json = JSON.stringify(stack);
    expect((await validate(json)).json.notes).toHaveLength(1);
    for (const extra of [{}, { hexstack: true }]) {
      const fromJson = await validate(json, extra);
      const fromFile = await validate(await toHexstack(stack), extra);
      expect(fromFile).toEqual(fromJson);
      expect(fromJson.json.ok).toBe(true);
    }
    // Also for a rejected stack.
    const broken = clone(stack);
    broken.cards[1].backgroundId = "bkg_missing";
    expect(await validate(await toHexstack(broken))).toEqual(await validate(JSON.stringify(broken)));
  });

  it("reads a .hexstack text with white space around it", async () => {
    const text = `\n ${await toHexstack(makeStack())}\n`;
    expect((await validate(text)).json.ok).toBe(true);
  });
});

describe("validate_stack: read errors (Requirement 6.2)", () => {
  it("answers invalid JSON with one error at the path stack", async () => {
    const result = await validate('{"a": xzzzzzzzzz');
    expect(result.isError).toBe(true);
    expect(result.json.ok).toBe(false);
    expect(result.json.errors).toHaveLength(1);
    expect(result.json.errors[0]).toMatch(/^stack: The stack is not valid JSON: /);
  });

  it.each(["", "   \n", "not base64!", "A"])("reads %j as .hexstack text and rejects it as one stack error", async (text) => {
    const result = await validate(text);
    expect(result.isError).toBe(true);
    expect(result.json.errors).toHaveLength(1);
    expect(result.json.errors[0]).toMatch(/^stack: /);
  });

  it("names the failed check for text that is Base64URL but not deflate-raw", async () => {
    const result = await validate("AAAAAAAA");
    expect(result.isError).toBe(true);
    expect(result.json.errors).toEqual([expect.stringMatching(/^stack: The data is not valid deflate-raw/)]);
  });

  it("names the failed check for deflate-raw data that is not JSON", async () => {
    const stream = new Blob([new TextEncoder().encode("this is not json")]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    const payload = Buffer.from(bytes).toString("base64url");
    const result = await validate(payload);
    expect(result.json.errors).toEqual(["stack: The stack is not valid JSON"]);
  });

  it("rejects a decompressed JSON over 4194304 bytes, naming the limit", async () => {
    const big = new TextEncoder().encode(`{"x":"${" ".repeat(MAX_STACK_TEXT)}"}`);
    const stream = new Blob([big]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const payload = Buffer.from(await new Response(stream).arrayBuffer()).toString("base64url");
    expect(payload.length).toBeLessThan(MAX_STACK_TEXT);
    const result = await validate(payload);
    expect(result.isError).toBe(true);
    expect(result.json.errors).toEqual([`stack: The decompressed stack is larger than ${MAX_STACK_TEXT} bytes`]);
  });

  it("accepts a stack text of exactly 4194304 characters as an argument and rejects one more as a read error", async () => {
    const atLimit = await validate(`{${" ".repeat(MAX_STACK_TEXT - 1)}`);
    expect(atLimit.json.errors[0]).toMatch(/^stack: The stack is not valid JSON/);
    const pastLimit = await validate(`{${" ".repeat(MAX_STACK_TEXT)}`);
    expect(pastLimit.isError).toBe(true);
    expect(pastLimit.json).toEqual({ ok: false, errors: [`stack: The stack text has more than ${MAX_STACK_TEXT} characters`] });
  });

  it("keeps no more than 80 characters of the text in a JSON read error", async () => {
    const result = await validate(`{"a": ${"x".repeat(5000)}`);
    expect(result.json.errors[0].length).toBeLessThan(200);
    expect(result.json.errors[0]).not.toContain("x".repeat(81));
  });
});

describe("validate_stack: gate errors (Requirements 6.3, 6.4)", () => {
  const firstOf = (value: unknown): string => {
    const checked = checkStack(value);
    if (checked.ok) throw new Error("the stack was accepted");
    return checked.error;
  };

  const kinds: Array<[string, RegExp, (s: any) => unknown]> = [
    ["a wrong schemaVersion", /^schemaVersion: /, (s) => ({ ...s, schemaVersion: "1.0.0" })],
    ["a schema issue", /^cards\[0\]\.parts\[0\]\.rect\.width: /, (s) => { s.cards[0].parts[0].rect.width = 1.5; return s; }],
    ["a layer scope error", /^cards\[0\]\.parts\[0\]\.layerScope: /, (s) => { s.cards[0].parts[0].layerScope = "background"; return s; }],
    ["a background reference error", /^cards\[1\]\.backgroundId: /, (s) => { s.cards[1].backgroundId = "bkg_gone"; return s; }],
    ["a duplicate id", /: duplicate id /, (s) => { s.cards[1].id = s.cards[0].id; return s; }],
    ["an icon reference error", /iconId: /, (s) => { s.cards[0].parts[0].iconId = "ico_gone"; return s; }],
    ["an undecodable layer", /^cards\[1\]\.bitmap\.rleData: /, (s) => { s.cards[1].bitmap.rleData = BAD_LAYER; return s; }],
  ];

  it.each(kinds)("returns ok false with the gate error for %s as a normal result", async (_name, pattern, change) => {
    const value = change(clone(makeStack()));
    const result = await validate(JSON.stringify(value));
    expect(result.isError).toBe(false);
    expect(result.json.ok).toBe(false);
    expect(result.json.errors[0]).toMatch(pattern);
    expect(result.json.errors[0]).toBe(firstOf(value));
    // Only the errors: no script errors, notes, name, counts or .hexstack text (Requirement 6.4).
    expect(Object.keys(result.json)).toEqual(["ok", "errors"]);
  });

  it("returns a __proto__ icon key as a gate error", async () => {
    const text = JSON.stringify(makeStack()).replace('"customIcons":{}', `"customIcons":{"__proto__":"${BLANK_ICON}"}`);
    expect(text).toContain('"__proto__"');
    const result = await validate(text, { hexstack: true });
    expect(result.json.ok).toBe(false);
    expect(result.json.errors[0]).toMatch(/^customIcons\.__proto__: /);
    expect(result.json.hexstack).toBeUndefined();
  });

  it("returns every error in one pass, in gate order", async () => {
    const value = clone(makeStack());
    value.cards[0].backgroundId = "bkg_x";
    value.cards[1].bitmap.rleData = BAD_LAYER;
    const result = await validate(JSON.stringify(value));
    expect(result.json.errors).toEqual([
      'cards[0].backgroundId: references missing background "bkg_x"',
      expect.stringMatching(/^cards\[1\]\.bitmap\.rleData: /),
    ]);
  });

  it("shows 100 errors without a count, and 101 as the first 100 and the count 1 (Requirement 5.6)", async () => {
    const withLayers = (count: number): string => {
      const value = clone(makeStack());
      value.cards = [];
      for (let i = 0; i < count; i++) {
        value.cards.push({ ...clone(makeStack().cards[0]), id: `crd_${i}`, parts: [], bitmap: { width: 512, height: 342, rleData: BAD_LAYER } });
      }
      return JSON.stringify(value);
    };
    const hundred = (await validate(withLayers(100))).json;
    expect(hundred.errors).toHaveLength(100);
    expect(hundred.errorsNotShown).toBeUndefined();
    const more = (await validate(withLayers(101))).json;
    expect(more.errors).toHaveLength(100);
    expect(more.errorsNotShown).toBe(1);
    expect(more.errors[0]).toMatch(/^cards\[0\]\.bitmap\.rleData: /);
  });

  it("shortens a record key longer than 80 characters in a gate error path (Requirements 5.7, 6.4)", async () => {
    const value = clone(makeStack());
    const key = `k${"y".repeat(100)}`;
    value.cards[0].bgFieldContents = { [key]: 5 };
    const result = await validate(JSON.stringify(value));
    expect(result.json.ok).toBe(false);
    expect(result.json.errors[0]).toContain(`${key.slice(0, 77)}...`);
    expect(result.json.errors[0]).not.toContain(key.slice(0, 81));
  });
});

describe("validate_stack: script errors (Requirement 6.5)", () => {
  it("lists the errors of every script with its gate path, in stack, background, part, card, part order", async () => {
    const stack = makeStack();
    const bad = (n: number): string => `on mouseUp\n  nonsense${n} here\nend mouseUp`;
    stack.cards[0].parts[0].scriptSource = bad(5);
    stack.cards[0].scriptSource = bad(4);
    stack.cards[1].scriptSource = GOOD_SCRIPT;
    stack.backgrounds[0].parts[0].scriptSource = bad(3);
    stack.backgrounds[0].scriptSource = bad(2);
    stack.scriptSource = bad(1);
    const result = await validate(JSON.stringify(stack));
    expect(result.json.ok).toBe(true);
    const paths = result.json.scriptErrors.map((e: string) => e.split(" line ")[0]);
    expect(paths).toEqual([
      "scriptSource",
      "backgrounds[0].scriptSource",
      "backgrounds[0].parts[0].scriptSource",
      "cards[0].scriptSource",
      "cards[0].parts[0].scriptSource",
    ]);
    expect(result.json.scriptErrors[0]).toMatch(/^scriptSource line 2, column \d+: .+/);
  });

  it("returns the script errors and the .hexstack text of a stack with script errors", async () => {
    const stack = makeStack();
    stack.cards[0].parts[0].scriptSource = "on mouseUp\n  nonsense here\nend mouseUp";
    const result = await validate(JSON.stringify(stack), { hexstack: true });
    expect(result.json.ok).toBe(true);
    expect(result.json.scriptErrors).toHaveLength(1);
    expect(typeof result.json.hexstack).toBe("string");
  });

  it("caps script errors at 100 and counts the rest", async () => {
    const stack = makeStack();
    // One unknown command in each of 101 handlers: one error each.
    stack.scriptSource = Array.from({ length: 101 }, (_, i) => `on h${i}\n  nonsense here\nend h${i}\n`).join("");
    const result = await validate(JSON.stringify(stack));
    expect(result.json.scriptErrors).toHaveLength(100);
    expect(result.json.scriptErrorsNotShown).toBe(1);
  });

  it("shortens a long token in a script error message (Requirement 5.7)", async () => {
    const stack = makeStack();
    const token = "q".repeat(200);
    stack.scriptSource = `on mouseUp\n  ${token} here\nend mouseUp`;
    const result = await validate(JSON.stringify(stack));
    expect(result.json.scriptErrors.length).toBeGreaterThan(0);
    for (const error of result.json.scriptErrors) expect(error).not.toContain("q".repeat(81));
  });
});

describe("validate_stack: notes on layers (Requirement 6.5)", () => {
  it("names each non-canonical layer, backgrounds before cards, and none for \"\" or canonical data", async () => {
    const stack = makeStack();
    stack.backgrounds[0].bitmap.rleData = DARK_LAYER;
    stack.cards[0].bitmap.rleData = DARK_LAYER;
    stack.cards[1].bitmap.rleData = "";
    expect((await validate(JSON.stringify(stack))).json.notes).toEqual([]);

    stack.cards[0].bitmap.rleData = NON_CANONICAL_LAYER;
    stack.backgrounds[0].bitmap.rleData = NON_CANONICAL_LAYER;
    const result = await validate(JSON.stringify(stack));
    expect(result.json.ok).toBe(true);
    expect(result.json.notes).toEqual([
      'backgrounds[0].bitmap.rleData: this rleData decodes but is not canonical; replace it with draw_layer output or ""',
      'cards[0].bitmap.rleData: this rleData decodes but is not canonical; replace it with draw_layer output or ""',
    ]);
  });

  it("caps notes at 100 and counts the rest", async () => {
    const stack = makeStack();
    stack.cards = Array.from({ length: 101 }, (_, i) => ({
      ...clone(stack.cards[0]), id: `crd_${i}`, parts: [], bitmap: { width: 512, height: 342, rleData: NON_CANONICAL_LAYER },
    }));
    const result = await validate(JSON.stringify(stack));
    expect(result.json.notes).toHaveLength(100);
    expect(result.json.notesNotShown).toBe(1);
  }, HEAVY_TEST_TIMEOUT_MS);
});

describe("validate_stack: the hexstack output (Requirement 6.6)", () => {
  it("returns no .hexstack text unless hexstack is true", async () => {
    const text = JSON.stringify(makeStack());
    expect("hexstack" in (await validate(text)).json).toBe(false);
    expect("hexstack" in (await validate(text, { hexstack: false })).json).toBe(false);
  });

  it("returns a .hexstack text that opens again, validates again and holds the checked stack", async () => {
    const stack = makeStack();
    stack.cards[0].parts[0] = button("prt_button", { title: "T".repeat(300) });
    stack.backgrounds[0].parts[0] = field("prt_field", { content: "c".repeat(300) });
    const result = await validate(JSON.stringify(stack), { hexstack: true });
    const hexstack = result.json.hexstack as string;
    expect(hexstack.length).toBeGreaterThan(80); // a tool product is returned whole
    const reopened = await decodeStackFile(hexstack);
    const checked = checkStack(reopened);
    expect(checked.ok).toBe(true);
    expect((checked as { stack: HexStack }).stack).toEqual(stack);
    expect((await validate(hexstack, { hexstack: true })).json).toEqual(result.json);
    expect(Object.keys(result.json)).toEqual(["ok", "errors", "scriptErrors", "notes", "stack", "hexstack"]);
  });
});

describe("validate_stack: arguments (Requirement 4.5)", () => {
  it("rejects a missing stack, a non-string stack, an unknown argument and a non-boolean hexstack", async () => {
    expect((await call("validate_stack", {})).json.errors).toEqual(["stack: is required"]);
    expect((await call("validate_stack", { stack: 5 })).json.errors).toEqual(["stack: must be a string"]);
    expect((await call("validate_stack", { stack: "{}", extra: 1 })).json.errors).toEqual(["extra: is not an allowed argument"]);
    expect((await call("validate_stack", { stack: "{}", hexstack: "yes" })).json.errors).toEqual(["hexstack: must be a boolean"]);
  });
});
