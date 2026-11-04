# Implementation Plan: Core Stack Engine

- [x] 1. Scaffold the project and the persisted schema
  - Initialize Vite + React 19 + TypeScript strict + Vitest + fast-check + Zod
  - Implement `src/core/schema.ts` exactly as `hexcard_design_spec.md` §2.1 (including `THEME_PALETTES`)
  - _Requirements: 1.5, 4.5_

- [x] 2. Implement stack validation
  - Implement `src/core/stackValidator.ts` (Zod) with schema-version, background-reference and layerScope checks
  - Reject empty stacks, duplicate ids, sizes other than 512x342, non-hex palette colours and non-integer/negative part rects
  - Unit-test valid stacks, each rejection reason, and that rejection leaves the current stack unchanged
  - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7_

- [ ] 3. Implement the runtime store
  - Implement `src/core/store.ts` with `subscribe`, `getSnapshot`, `applyRuntime`, `replaceStack`, `getCompiled`
  - Implement `setFieldText` sharedText semantics and the Edit Background `editLayer` routing
  - Wire `ScriptCache` recompilation through an injected `compile` function (spec 02 provides `parseHexTalk`)
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 4.1, 4.3, 4.4, 4.5_

- [ ] 4. Implement the 50-step undo history
  - Implement `src/core/history.ts` ring buffer and `HexCommand`
  - Implement `PaintStrokeCommand` (bounding-rect before/after pixels)
  - _Requirements: 4.2, 5.1, 5.2, 5.3_

- [ ] 5. Implement the message bus
  - Implement path building, handled rule, `pass` continuation and the arrow-key built-in
  - Implement the FIFO queue (32 entries, overflow warning), continuous-message coalescing and the gated 200 ms `idle` timer
  - Implement nested lifecycle dispatch for `go` (card and background changes) with shared `DispatchContext`, depth limit 16, and abort
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7_

- [ ] 6. Core test suite
  - Cover every acceptance criterion above with Vitest tests in `src/core/__tests__/`
  - _Requirements: 1.1–6.7_
