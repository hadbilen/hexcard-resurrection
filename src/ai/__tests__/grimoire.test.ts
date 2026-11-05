/**
 * Spec 04 task 5.1: the 24-entry Grimoire (Requirement 4.1). Every entry's AST passes the AST
 * validator and the full acceptance pipeline, and its prompt conjures exactly that AST.
 */
import { describe, expect, it } from "vitest";
import { validateAst } from "../../core/astValidator.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { parseNoteSequence } from "../../engine/audio/synth.ts";
import { GRIMOIRE } from "../grimoire.ts";
import { acceptAst, astEqual, conjureLocally } from "../spellcaster.ts";

describe("Grimoire", () => {
  it("has 24 distinct ASCII prompts", () => {
    expect(GRIMOIRE).toHaveLength(24);
    expect(new Set(GRIMOIRE.map((entry) => entry.prompt.toLowerCase())).size).toBe(24);
    for (const entry of GRIMOIRE) expect(entry.prompt).toMatch(/^[\x20-\x7e]+$/);
  });

  it.each(GRIMOIRE.map((entry) => [entry.prompt, entry] as const))("%s: validated AST, compiling HexTalk", (_prompt, entry) => {
    expect(validateAst(entry.ast)).toMatchObject({ ok: true });
    const accepted = acceptAst(entry.ast);
    if (!accepted.ok) throw new Error(accepted.reason);
    const parsed = parseHexTalk(accepted.hexTalk);
    expect(parsed.errors).toEqual([]);
    expect(astEqual(parsed.ast, entry.ast)).toBe(true);
    // Every note string is valid synth notation.
    const notes = JSON.stringify(entry.ast).match(/"notes":"[^"]*"/g) ?? [];
    for (const match of notes) expect(parseNoteSequence(match.slice(9, -1)).invalid).toEqual([]);
  });

  it("conjures each entry's own AST from its prompt, whatever the case and final punctuation", () => {
    for (const entry of GRIMOIRE) {
      for (const prompt of [entry.prompt, `${entry.prompt.toUpperCase()}.`]) {
        const result = conjureLocally(prompt, { objectKind: "button" });
        expect(result.ok && astEqual(result.ast, entry.ast)).toBe(true);
      }
    }
  });
});
