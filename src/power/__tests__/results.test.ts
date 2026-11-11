/// <reference types="node" />
// Spec 07 task 3.1: results.ts (Requirements 5.6, 5.7).
import { describe, expect, it } from "vitest";
import { listStackValidationErrors, type GateError } from "../../core/stackValidator.ts";
import {
  LIST_LIMIT,
  QUOTE_LIMIT,
  cappedList,
  errorResult,
  quoteText,
  shortenGateError,
  shortenMessage,
  toolResult,
} from "../results.ts";

const text = (length: number, char = "a"): string => char.repeat(length);

describe("quoteText", () => {
  it("keeps a text of 80 characters whole", () => {
    expect(QUOTE_LIMIT).toBe(80);
    expect(quoteText(text(80))).toBe(text(80));
    expect(quoteText("")).toBe("");
  });

  it("shortens a text of 81 characters to its first 77 characters and ...", () => {
    const quoted = quoteText(`${text(77, "x")}yyyy`);
    expect(quoted).toBe(`${text(77, "x")}...`);
    expect(quoted).toHaveLength(80);
  });

  it("counts UTF-16 code units", () => {
    // 40 astral characters are 80 code units: whole. One more code unit: shortened.
    const astral = "\u{1F600}".repeat(40);
    expect(quoteText(astral)).toBe(astral);
    expect(quoteText(`${astral}a`)).toHaveLength(80);
  });
});

describe("shortenMessage", () => {
  it("leaves fixed text and short quotes unchanged", () => {
    const message = 'expected "end mouseUp" but found "end mouseDown"';
    expect(shortenMessage(message)).toBe(message);
  });

  it("shortens the inner text of a quoted pair longer than 80 characters", () => {
    const inner = `${"word ".repeat(30)}end`;
    expect(shortenMessage(`unexpected "${inner}" here`)).toBe(`unexpected "${quoteText(inner)}" here`);
  });

  it("keeps a quoted pair of exactly 80 characters", () => {
    const inner = `${"word ".repeat(15)}abcde`;
    expect(inner).toHaveLength(80);
    expect(shortenMessage(`a "${inner}" b`)).toBe(`a "${inner}" b`);
  });

  it("shortens a run of more than 80 characters without white space or quotes", () => {
    const run = text(200, "z");
    expect(shortenMessage(`unknown identifier ${run} at line 1`)).toBe(`unknown identifier ${quoteText(run)} at line 1`);
    expect(shortenMessage(`token ${text(80, "z")}`)).toBe(`token ${text(80, "z")}`);
  });

  it("leaves no more than 80 consecutive characters of a long quoted token", () => {
    const token = text(5000, "q");
    const out = shortenMessage(`Unexpected token "${token}"`);
    expect(out).toBe(`Unexpected token "${quoteText(token)}"`);
    expect(out).not.toContain(text(81, "q"));
  });
});

describe("shortenGateError", () => {
  const error = (path: PropertyKey[], ...message: GateError["message"]): GateError => ({ path, message });

  it("keeps an 80-character record key whole after fixed path text", () => {
    const key = text(80, "k");
    expect(shortenGateError(error(["cards", 3, "bgFieldContents", key], "expected string"))).toBe(
      `cards[3].bgFieldContents.${key}: expected string`,
    );
  });

  it("shortens an 81-character record key, also one with spaces", () => {
    const key = text(81, "k");
    expect(shortenGateError(error(["cards", 3, "bgFieldContents", key], "expected string"))).toBe(
      `cards[3].bgFieldContents.${quoteText(key)}: expected string`,
    );
    const spaced = `${"key with spaces ".repeat(5)}x`;
    expect(spaced).toHaveLength(81);
    expect(shortenGateError(error(["customIcons", spaced], "bad"))).toBe(`customIcons.${quoteText(spaced)}: bad`);
  });

  it("shortens a quoted id of 81 characters that contains spaces and quotes", () => {
    const id = `${'id "with" spaces '.repeat(4)}abcdefghijklm`;
    expect(id).toHaveLength(81);
    expect(shortenGateError(error(["cards", 0, "id"], 'duplicate id "', { fromValue: id }, '"'))).toBe(
      `cards[0].id: duplicate id "${quoteText(id)}"`,
    );
  });

  it("shortens a long String(version) of a non-string schemaVersion", () => {
    const version = Array.from({ length: 60 }, (_, i) => i);
    const [gate] = listStackValidationErrors({ schemaVersion: version }).errors;
    const shown = String(version);
    expect(shown.length).toBeGreaterThan(80);
    expect(shortenGateError(gate)).toBe(`schemaVersion: unsupported schema version ${quoteText(shown)}, expected "2.0.0"`);
  });

  it("equals the gate's own text when nothing is longer than 80 characters", () => {
    const [gate] = listStackValidationErrors({ schemaVersion: "1.0.0" }).errors;
    expect(shortenGateError(gate)).toBe('schemaVersion: unsupported schema version "1.0.0", expected "2.0.0"');
  });
});

describe("cappedList", () => {
  it("shows a list of 100 entries whole with no count", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    expect(LIST_LIMIT).toBe(100);
    expect(cappedList("errors", items)).toEqual({ errors: items });
  });

  it("shows the first 100 of 101 entries followed by the count 1", () => {
    const items = Array.from({ length: 101 }, (_, i) => `e${i}`);
    const capped = cappedList("errors", items);
    expect(capped).toEqual({ errors: items.slice(0, 100), errorsNotShown: 1 });
    expect(Object.keys(capped)).toEqual(["errors", "errorsNotShown"]);
  });
});

describe("toolResult and errorResult", () => {
  it("writes the payload as compact JSON text with isError false", () => {
    const result = toolResult({ ok: true, handlers: ["mouseUp"] });
    expect(result).toEqual({ content: [{ type: "text", text: '{"ok":true,"handlers":["mouseUp"]}' }], isError: false });
  });

  it("adds the PNG as standard Base64 image content after the text", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
    const result = toolResult({ ok: true }, png);
    expect(result.content).toEqual([
      { type: "text", text: '{"ok":true}' },
      { type: "image", data: Buffer.from(png).toString("base64"), mimeType: "image/png" },
    ]);
  });

  it("encodes a PNG larger than one Base64 chunk", () => {
    const png = Uint8Array.from({ length: 100_000 }, (_, i) => (i * 7) & 0xff);
    const image = toolResult({ ok: true }, png).content[1];
    expect(image.type === "image" && image.data).toBe(Buffer.from(png).toString("base64"));
  });

  it("writes an error result with ok false, the entries and the cap", () => {
    expect(errorResult(["stack: bad"])).toEqual({
      content: [{ type: "text", text: '{"ok":false,"errors":["stack: bad"]}' }],
      isError: true,
    });
    const many = Array.from({ length: 103 }, (_, i) => `e${i}`);
    const json = JSON.parse((errorResult(many).content[0] as { text: string }).text);
    expect(json.errors).toHaveLength(100);
    expect(json.errorsNotShown).toBe(3);
  });
});
