// conjure_script (spec 07 Requirement 8; design §tools/conjureScript.ts). Tier 1 of the Spellcaster
// only: the tool imports conjureLocally, never conjureScript, so no tier, proxy or key is reachable.
// Pure TypeScript: no Node module, no DOM.

import { conjureLocally, handlerHint, type SpellObjectKind } from "../../ai/spellcaster.ts";
import { shortenMessage, toolResult, type CallToolResult } from "../results.ts";

export function runConjureScript(args: Record<string, unknown>): CallToolResult {
  const objectKind = (args.objectKind ?? "button") as SpellObjectKind;
  const spell = conjureLocally(args.prompt as string, { objectKind });
  if (!spell.ok) {
    return toolResult({
      ok: false,
      reason: shortenMessage(spell.reason),
      suggestions: spell.suggestions.map((suggestion) => suggestion.prompt),
    });
  }
  const hint = handlerHint(spell.ast, objectKind);
  return toolResult({ ok: true, hexTalk: spell.hexTalk, notes: hint === undefined ? [] : [hint] });
}
