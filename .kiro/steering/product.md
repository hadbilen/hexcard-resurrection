---
inclusion: always
---

# Product Overview: HexCard

HexCard is a modern web-based resurrection of Apple's 1987 HyperCard, built for the Kiroween 2026 Hackathon in the **Resurrection** category. (The Official Rules allow exactly one main category per submission; a bonus category, if any, is chosen separately at submission time.) It empowers users to build interactive micro-apps, retro adventure games, sound synthesizers, and data dashboards using a stack of cards without compilation steps.

The master reference is `hexcard_design_spec.md`. It is canonical for the persisted schema (§2.1), the runtime concurrency model (§3.2), the HexTalk grammar and AST (§4.1–4.2), VM semantics (§4.3) and the bitmap codec (§5.4).

## Core Architectural Pillars
1. **5-Layer HyperCard Hierarchy:** Every application is a `HexStack` containing shared `HexBackground` templates and individual `HexCard` instances. Cards inherit bitmap graphics, parts (buttons/fields), and scripts from their linked background.
2. **SharedText Semantics:** Background text fields (`HexFieldPart`) support `sharedText: boolean`. When `false`, text is stored per-card in `HexCard.bgFieldContents[fieldId]`. When `true`, text is stored once on the background and shared across all cards.
3. **Deterministic Message Passing Path:** UI and lifecycle events (`mouseUp`, `mouseDown`, `openCard`, `closeCard`, `idle`) bubble strictly through: `HexPart -> HexCard -> HexBackground -> HexStack -> HexRuntimeBuiltIns`, one dispatch at a time (single-threaded runtime with a message queue).
4. **Immediate-Mode Authoring:** Selecting the `browse` (Hand) tool makes the stack immediately live and interactive. Selecting `button`, `field`, or paint tools switches immediately to live authoring mode. Toggling `Edit Background` (`Cmd/Ctrl+B`) routes all paint and part edits directly to the active `HexBackground`.
5. **Sandbox-Safe, Schema-Validated AI Scripting (HexAI Spellcaster):** Users can write classic `HexTalk` scripts or describe behaviors in natural language. The AI layer produces only a `HexScriptAST`, which must pass schema validation; the HexTalk shown to the user is printed from it. Scripts run only inside the gas-limited VM. The guarantee is safety, not correctness: generated scripts are always previewed before they are applied.

## Terminology
- **Dispatch:** delivery of one message along the message path until a handler handles it.
- **Part:** a button or a field. These are the only two part kinds.
- **Layer:** `card` or `background`; every part and bitmap belongs to exactly one.
- **Authoring mutation:** a change made with an authoring tool; undoable through the 50-step history.
- **Runtime mutation:** a change made by a script or by typing in Browse mode; auto-saved, not undoable.
