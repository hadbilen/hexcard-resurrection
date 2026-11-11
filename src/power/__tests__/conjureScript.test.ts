// Spec 07 task 3.2: conjure_script (Requirements 5.3, 5.7, 8.1-8.5, 17.1).
import { describe, expect, it } from "vitest";
import { GRIMOIRE } from "../../ai/grimoire.ts";
import { conjureLocally, handlerHint, mergeSpell, type SpellObjectKind } from "../../ai/spellcaster.ts";
import { TIER1_CORPUS } from "../../ai/__tests__/tier1Corpus.ts";
import { makeCaller } from "./toolFixtures.ts";

// Per-test budget for the heavy test, so CPU contention in the parallel suite cannot time it out.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

const KINDS: SpellObjectKind[] = ["button", "field", "card", "background", "stack"];
const { call } = makeCaller();
const conjure = (prompt: string, objectKind?: string) => call("conjure_script", objectKind === undefined ? { prompt } : { prompt, objectKind });

describe("conjure_script: accepted prompts (Requirements 8.1, 8.2)", () => {
  it.each(KINDS)("returns the HexTalk of an accepted prompt for the object kind %s", async (kind) => {
    const result = await conjure("go to the next card", kind);
    const direct = conjureLocally("go to the next card", { objectKind: kind });
    expect(direct.ok).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.json).toEqual({ ok: true, hexTalk: (direct as { hexTalk: string }).hexTalk, notes: [] });
    expect(Object.keys(result.json)).toEqual(["ok", "hexTalk", "notes"]);
  });

  it("uses the object kind button when objectKind is omitted", async () => {
    const prompt = "when the card opens, play a spooky harpsichord tune";
    const omitted = await conjure(prompt);
    const explicit = await conjure(prompt, "button");
    expect(omitted.json).toEqual(explicit.json);
    expect(omitted.json.notes).toHaveLength(1); // handlerHint for a button with an openCard handler
    const direct = conjureLocally(prompt, { objectKind: "button" });
    if (!direct.ok) throw new Error("the prompt was refused");
    expect(omitted.json.notes).toEqual([handlerHint(direct.ast, "button")]);
    // The same prompt for a card has no note.
    expect((await conjure(prompt, "card")).json.notes).toEqual([]);
  });

  it("returns an accepted HexTalk longer than 80 characters whole", async () => {
    const result = await conjure("Dissolve to next card and play a harpsichord fanfare", "button");
    expect(result.json.ok).toBe(true);
    expect(result.json.hexTalk.length).toBeGreaterThan(80);
    const direct = conjureLocally("Dissolve to next card and play a harpsichord fanfare", { objectKind: "button" });
    if (!direct.ok) throw new Error("the prompt was refused");
    expect(result.json.hexTalk).toBe(direct.hexTalk);
  });
});

describe("conjure_script: refused prompts (Requirement 8.3)", () => {
  it.each(KINDS)("returns ok false with the reason and 1 to 3 suggested prompts for the object kind %s", async (kind) => {
    const prompt = "zorp the flibbertigibbet quantum sideways";
    const direct = conjureLocally(prompt, { objectKind: kind });
    expect(direct.ok).toBe(false);
    const result = await conjure(prompt, kind);
    expect(result.isError).toBe(false);
    expect(result.json.ok).toBe(false);
    expect(result.json.reason).toBe((direct as { reason: string }).reason);
    expect(result.json.suggestions).toEqual((direct as { suggestions: { prompt: string }[] }).suggestions.map((s) => s.prompt));
    expect(result.json.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(result.json.suggestions.length).toBeLessThanOrEqual(3);
    expect(result.json.hexTalk).toBeUndefined();
    expect(Object.keys(result.json)).toEqual(["ok", "reason", "suggestions"]);
  });

  it.each(["", "   \n\t"])("refuses the empty or blank prompt %j as a normal result", async (prompt) => {
    const result = await conjure(prompt);
    expect(result.isError).toBe(false);
    expect(result.json.ok).toBe(false);
    expect(result.json.reason).toBe("Type what the script should do, or pick a spell from the Grimoire.");
  });

  it("shortens a quoted part of the prompt in a reason to 77 characters and ... (Requirement 5.7)", async () => {
    const prompt = `play the ${"q".repeat(200)}`;
    const direct = conjureLocally(prompt, { objectKind: "button" });
    expect(direct.ok).toBe(false);
    expect((direct as { reason: string }).reason).toContain("q".repeat(200)); // the studio quotes it whole
    const result = await conjure(prompt);
    expect(result.json.reason).toBe(`I did not understand "play", "${"q".repeat(77)}..." in that spell.`);
    expect(result.text).not.toContain("q".repeat(81));
  });

  it("quotes a text of exactly 80 characters whole", async () => {
    const result = await conjure(`play the ${"q".repeat(80)}`);
    expect(result.json.reason).toBe(`I did not understand "play", "${"q".repeat(80)}" in that spell.`);
  });
});

describe("conjure_script: parity with the studio's Spellcaster tab (Requirement 8.4)", () => {
  /** What the Spellcaster tab applies to an object with an empty script: mergeSpell("", ast).source. */
  const studioSource = (prompt: string, kind: SpellObjectKind): string | null => {
    const spell = conjureLocally(prompt, { objectKind: kind });
    if (!spell.ok) return null;
    const merged = mergeSpell("", spell.ast);
    return merged.ok ? merged.source : null;
  };

  it("shows for every Grimoire prompt the HexTalk that mergeSpell gives for an empty script, and compile_hextalk returns it unchanged", async () => {
    for (const entry of GRIMOIRE) {
      const result = await conjure(entry.prompt, "button");
      expect(result.json.ok, entry.prompt).toBe(true);
      expect(result.json.hexTalk, entry.prompt).toBe(studioSource(entry.prompt, "button"));
      const compiled = await call("compile_hextalk", { source: result.json.hexTalk });
      expect(compiled.json.ok, entry.prompt).toBe(true);
      expect(compiled.json.canonical, entry.prompt).toBe(result.json.hexTalk);
    }
  });

  it("matches the Spellcaster for every prompt of the Tier 1 corpus", async () => {
    for (const entry of TIER1_CORPUS) {
      const kind = entry.kind ?? "button";
      const result = await conjure(entry.prompt, kind);
      const spell = conjureLocally(entry.prompt, { objectKind: kind });
      if (spell.ok) {
        expect(result.json.ok, entry.prompt).toBe(true);
        expect(result.json.hexTalk, entry.prompt).toBe(studioSource(entry.prompt, kind));
        expect(result.json.notes, entry.prompt).toEqual(handlerHint(spell.ast, kind) === undefined ? [] : [handlerHint(spell.ast, kind)]);
        const compiled = await call("compile_hextalk", { source: result.json.hexTalk });
        expect(compiled.json.canonical, entry.prompt).toBe(result.json.hexTalk);
      } else {
        expect(result.json.ok, entry.prompt).toBe(false);
        expect(result.json.reason.length, entry.prompt).toBeGreaterThan(0);
        expect(result.json.suggestions, entry.prompt).toEqual(spell.suggestions.map((s) => s.prompt));
      }
    }
  }, HEAVY_TEST_TIMEOUT_MS);
});

describe("conjure_script: arguments (Requirements 4.5, 8.5)", () => {
  it("accepts only prompt and objectKind", async () => {
    expect((await call("conjure_script", {})).json.errors).toEqual(["prompt: is required"]);
    expect((await call("conjure_script", { prompt: "go next", tier: 2 })).json.errors).toEqual(["tier: is not an allowed argument"]);
    expect((await call("conjure_script", { prompt: "go next", apiKey: "k" })).json.errors).toEqual(["apiKey: is not an allowed argument"]);
    expect((await call("conjure_script", { prompt: "go next", objectKind: "part" })).json.errors)
      .toEqual(["objectKind: must be one of button, field, card, background, stack"]);
  });

  it("gives a prompt of more than 600 characters the argument error, not the studio's refusal", async () => {
    const result = await conjure("a".repeat(601));
    expect(result.isError).toBe(true);
    expect(result.json.errors).toEqual(["prompt: must have at most 600 characters"]);
  });
});
