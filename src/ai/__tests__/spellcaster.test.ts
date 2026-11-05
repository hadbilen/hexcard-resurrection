/**
 * Spec 04 task 5.1: Tier 1 Spellcaster and the acceptance pipeline.
 * - Requirement 4.1: zero-config prompts compile locally with no network call.
 * - Requirement 4.2: every result passes AST validation, printing, re-parsing and the deep-equal
 *   check before it is previewed (the Apply step is tested in ui/__tests__/ObjectInspector.test.ts).
 * - Requirement 4.3: an unmapped prompt is "not understood", with the closest Grimoire spells.
 * - Requirement 4.6: the 60+ prompt corpus in tier1Corpus.ts; every prompt has an expected outcome
 *   (a script or a refusal), Tier 1 matches 100% of them, and at least 75% expect a script.
 */
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HexScriptAST } from "../../core/ast.ts";
import { validateAst } from "../../core/astValidator.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { GRIMOIRE, lit, play, script } from "../grimoire.ts";
import {
  acceptAst,
  astEqual,
  compileTier1,
  conjureLocally,
  conjureScript,
  findGrimoireEntry,
  handlerHint,
  mergeSpell,
  suggestGrimoire,
} from "../spellcaster.ts";
import { TIER1_CORPUS } from "./tier1Corpus.ts";

const button = { objectKind: "button" } as const;

function parseExpected(source: string): HexScriptAST {
  const parsed = parseHexTalk(source);
  if (parsed.errors.length > 0) throw new Error(`bad expectation: ${JSON.stringify(parsed.errors)}\n${source}`);
  return parsed.ast;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("acceptance pipeline (Requirement 4.2)", () => {
  it("accepts a valid AST and returns it with its printed HexTalk", () => {
    const ast = script("mouseUp", [play("boing", "c4q")]);
    const result = acceptAst(ast);
    expect(result).toEqual({ ok: true, ast, hexTalk: 'on mouseUp\n  play boing tempo 120 "c4q"\nend mouseUp\n' });
  });

  it("rejects what the AST validator rejects, with its reason", () => {
    const badVoice = { handlers: { mouseup: { eventName: "mouseUp", params: [], body: [{ kind: "PlaySound", voice: "kazoo", tempo: 120, notes: "c4q" }] } } };
    const quote = script("mouseUp", [{ kind: "ShowAnswerDialog", prompt: lit('say "hi"'), buttons: [] }]);
    const unknownKey = { handlers: {}, extra: true };
    for (const output of [badVoice, quote, unknownKey, null, "on mouseUp", 42]) {
      const result = acceptAst(output);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toMatch(/^The spell did not pass the AST check \(ast/);
    }
  });

  it("compares ASTs ignoring loc and undefined optional keys", () => {
    const a = script("mouseUp", [{ kind: "ShowAskDialog", prompt: lit("Name?") }]);
    const b = { handlers: { mouseup: { ...a.handlers.mouseup, loc: { line: 1, column: 1 }, body: [{ kind: "ShowAskDialog", prompt: lit("Name?"), defaultAnswer: undefined, loc: { line: 2, column: 3 } }] } } };
    expect(astEqual(a, b)).toBe(true);
    expect(astEqual(a, script("mouseUp", [{ kind: "ShowAskDialog", prompt: lit("Age?") }]))).toBe(false);
    expect(astEqual([1, 2], [1, 2, 3])).toBe(false);
  });

  it("never throws and only returns scripts that survive the pipeline, for any prompt", () => {
    const vocabulary = ["go", "next", "card", "play", "boing", "add", "5", "to", "field", "'Score'", "if", "is", "then",
      "otherwise", "say", "'hi'", "hide", "this", "button", "when", "clicked", "and", "3", "times", "dissolve", "the", ",", "."];
    const prompt = fc.oneof(
      fc.string({ maxLength: 80 }),
      fc.array(fc.constantFrom(...vocabulary), { maxLength: 12 }).map((parts) => parts.join(" ")),
    );
    const kind = fc.constantFrom("button", "field", "card", "background", "stack" as const);
    fc.assert(fc.property(prompt, kind, (text, objectKind) => {
      const result = conjureLocally(text, { objectKind });
      if (result.ok) {
        expect(validateAst(result.ast).ok).toBe(true);
        const reparsed = parseHexTalk(result.hexTalk);
        expect(reparsed.errors).toEqual([]);
        expect(astEqual(reparsed.ast, result.ast)).toBe(true);
      } else {
        expect(result.reason.length).toBeGreaterThan(0);
        expect(result.suggestions.length).toBeGreaterThan(0);
      }
    }), { numRuns: 300 });
  });
});

describe("merging a spell into the current script (Apply)", () => {
  const existing = [
    "",
    "on mouseUp\n  go next\nend mouseUp",
    "-- notes\non openCard\n  answer \"Hi\"\nend openCard\n",
    "on MouseUp -- old\n  if field \"A\" = 1 then\n    go prev\n  end if\nend MouseUp\n\n-- trailing comment\non idle\n  put the time into field \"Clock\"\nend idle\n",
  ];

  it("keeps every other handler, swaps same-named ones, and the result passes the acceptance pipeline", () => {
    for (const source of existing) {
      const current = parseHexTalk(source);
      expect(current.errors).toEqual([]);
      for (const entry of GRIMOIRE) {
        const merge = mergeSpell(source, entry.ast);
        if (!merge.ok) throw new Error(`${entry.prompt}: ${merge.reason}`);
        const reparsed = parseHexTalk(merge.source);
        expect(reparsed.errors).toEqual([]);
        expect(astEqual(reparsed.ast, { handlers: { ...current.ast.handlers, ...entry.ast.handlers } })).toBe(true);
        expect(acceptAst(merge.ast).ok).toBe(true);
      }
    }
  });

  it("keeps the text of the other handlers character for character", () => {
    const source = existing[3];
    const merge = mergeSpell(source, script("mouseUp", [play("boing", "c4q")]));
    if (!merge.ok) throw new Error(merge.reason);
    expect(merge.source).toBe('on mouseUp\n  play boing tempo 120 "c4q"\nend mouseUp\n\n-- trailing comment\non idle\n  put the time into field "Clock"\nend idle\n');
    expect(merge).toMatchObject({ replaced: ["MouseUp"], added: [], kept: ["idle"] });
  });

  it("refuses a script that does not compile", () => {
    const merge = mergeSpell("on mouseUp\n  go\nend mouseUp\n", script("idle", []));
    expect(merge.ok).toBe(false);
  });
});

describe("zero-config Tier 1 (Requirement 4.1)", () => {
  it("compiles without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const prompts = [...TIER1_CORPUS.map((entry) => entry.prompt), ...GRIMOIRE.map((entry) => entry.prompt)];
    for (const prompt of prompts) await conjureScript(prompt, button);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the object's default handler when the prompt names no event", () => {
    const handlerOf = (kind: "button" | "field" | "card" | "background" | "stack") => {
      const result = compileTier1("go to the next card", { objectKind: kind });
      return result.ok ? Object.values(result.ast.handlers)[0].eventName : undefined;
    };
    expect(handlerOf("button")).toBe("mouseUp");
    expect(handlerOf("field")).toBe("mouseUp");
    expect(handlerOf("card")).toBe("openCard");
    expect(handlerOf("background")).toBe("openCard");
    expect(handlerOf("stack")).toBe("openStack");
  });

  it("refuses properties the object does not have (§4.3 property validity)", () => {
    expect(conjureLocally("hide this button", { objectKind: "card" }).ok).toBe(false);
    expect(conjureLocally("check me", { objectKind: "field" }).ok).toBe(false);
    expect(conjureLocally("lock button 'Go'", button).ok).toBe(false);
  });

  it("finds Grimoire spells regardless of case, spacing and final punctuation", () => {
    expect(findGrimoireEntry("  beep   THREE times! ")).toBe(GRIMOIRE.find((entry) => entry.prompt === "Beep three times"));
    expect(findGrimoireEntry("beep four times")).toBeUndefined();
  });

  it("notes when a handler is sent to the card rather than a part", () => {
    const ast = script("idle", []);
    expect(handlerHint(ast, "button")).toMatch(/^idle is sent to the card, not to a button/);
    expect(handlerHint(ast, "card")).toBeUndefined();
    expect(handlerHint(script("mouseUp", []), "field")).toBeUndefined();
  });
});

describe("not understood (Requirement 4.3)", () => {
  it("says which words it did not understand and suggests the closest Grimoire spells", () => {
    const result = conjureLocally("frobnicate the harpsichord fanfare", button);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('I did not understand "frobnicate" in that spell.');
    expect(result.suggestions.length).toBeGreaterThan(0);
    expect(result.suggestions[0].prompt).toBe("Dissolve to next card and play a harpsichord fanfare");
  });

  it("explains empty and over-long prompts", () => {
    const empty = conjureLocally("   ", button);
    expect(empty.ok === false && empty.reason).toMatch(/^Type what the script should do/);
    const long = conjureLocally("go next ".repeat(100), button);
    expect(long.ok === false && long.reason).toMatch(/too long/);
  });

  it("names the ambiguous unquoted word and suggests quotes or field X", () => {
    const counter = conjureLocally("put Score into field Total", button);
    expect(counter.ok === false && counter.reason).toBe(
      'Score is not in quotes and usually names a counter field, so it could be the text "Score" or a field. '
      + 'Write "Score" in quotes for the text, or field "Score" for the contents of the field.',
    );
    const named = conjureLocally("put Hello into field Hello and go to the next card", button);
    expect(named.ok === false && named.reason).toMatch(/^Hello is not in quotes and is also a name in this spell/);
  });

  it("always suggests up to three spells, closest first", () => {
    expect(suggestGrimoire("zzz qqq")).toHaveLength(3);
    expect(suggestGrimoire("flash the button").map((entry) => entry.prompt)).toContain("Flash this button three times");
  });
});

describe("Tier 1 corpus (Requirement 4.6)", () => {
  it("has at least 60 free-form prompts, none of them a Grimoire entry", () => {
    expect(TIER1_CORPUS.length).toBeGreaterThanOrEqual(60);
    for (const entry of TIER1_CORPUS) expect(findGrimoireEntry(entry.prompt)).toBeUndefined();
    expect(new Set(TIER1_CORPUS.map((entry) => entry.prompt)).size).toBe(TIER1_CORPUS.length);
  });

  it("gives every prompt an expected outcome, a script for at least 75% of them", () => {
    for (const entry of TIER1_CORPUS) {
      expect("expect" in entry).toBe(true);
      expect(entry.expect === null || typeof entry.expect === "string").toBe(true);
    }
    const scripts = TIER1_CORPUS.filter((entry) => typeof entry.expect === "string").length;
    expect(scripts / TIER1_CORPUS.length).toBeGreaterThanOrEqual(0.75);
  });

  it("matches the expected outcome of 100% of the prompts", () => {
    const mismatches = TIER1_CORPUS.filter((entry) => {
      const result = conjureLocally(entry.prompt, { objectKind: entry.kind ?? "button" });
      if (entry.expect === null) return result.ok || result.suggestions.length === 0;
      return !result.ok || !astEqual(result.ast, parseExpected(entry.expect));
    }).map((entry) => entry.prompt);
    expect(mismatches).toEqual([]);
  });

  it.each(TIER1_CORPUS.map((entry) => [entry.prompt, entry] as const))("%s", (_prompt, entry) => {
    const result = conjureLocally(entry.prompt, { objectKind: entry.kind ?? "button" });
    if (entry.expect === null) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.suggestions.length).toBeGreaterThan(0);
      return;
    }
    if (!result.ok) throw new Error(`not understood: ${result.reason}`);
    expect(validateAst(result.ast).ok).toBe(true);
    expect(astEqual(result.ast, parseExpected(entry.expect))).toBe(true);
  });
});
