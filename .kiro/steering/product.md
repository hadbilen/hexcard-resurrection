---
inclusion: always
---

# Product Overview: HexCard

HexCard is a modern web-based resurrection of Apple's 1987 HyperCard, built for the Kiroween 2026 Hackathon (Primary Category: **Resurrection**, Secondary: **Costume Contest** & **Frankenstein**). It empowers users to build interactive micro-apps, retro adventure games, sound synthesizers, and data dashboards using a stack of cards without compilation steps.

## Core Architectural Pillars
1. **5-Layer HyperCard Hierarchy:** Every application is a `HexStack` containing shared `HexBackground` templates and individual `HexCard` instances. Cards inherit bitmap graphics, parts (buttons/fields), and scripts from their linked background.
2. **SharedText Semantics:** Background text fields (`HexFieldPart`) support `sharedText: boolean`. When `false`, text is stored per-card in `HexCard.bgFieldContents[fieldId]`. When `true`, text is stored once on the background and shared across all cards.
3. **Deterministic Message Passing Path:** UI and lifecycle events (`mouseUp`, `mouseDown`, `openCard`, `closeCard`, `idle`) bubble strictly through: `HexPart -> HexCard -> HexBackground -> HexStack -> HexRuntimeBuiltIns`.
4. **Immediate-Mode Authoring:** Selecting the `browse` (Hand) tool makes the stack immediately live and interactive. Selecting `button`, `field`, or paint tools switches immediately to live authoring mode. Toggling `Edit Background` (`Cmd/Ctrl+B`) routes all paint and part edits directly to the active `HexBackground`.
5. **Hallucination-Free AI Scripting (HexAI Spellcaster):** Users can write classic `HexTalk` scripts or describe behaviors in natural language, which compile deterministically into a sandboxed `HexScriptAST` virtual machine.