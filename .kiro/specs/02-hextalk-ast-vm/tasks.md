# Implementation Plan: HexTalk Language, AST & Sandboxed VM

- [x] 1. Define AST types and the AST validator
  - Implement `src/core/ast.ts` exactly as `hexcard_design_spec.md` §4.2
  - Implement `src/core/astValidator.ts` (Zod) with the extra rejection rules
  - _Requirements: 3.1, 3.2_

- [ ] 2. Implement the lexer and parser
  - Lexer with line/column tracking, case folding and comments
  - Recursive-descent statements and precedence-climbing expressions per §4.1
  - Error reporting and recovery at `end <handler>`; handler-name and `pass` checks; `answer ... or` rule
  - Reuse `HEX_RESERVED_WORDS` from `astValidator.ts`; test that every AST `parseHexTalk` returns without errors passes `validateAst`
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5_

- [ ] 3. Implement the printer and round-trip tests
  - `printHexTalk` with the normalisation table and minimal parentheses
  - fast-check generators for valid ASTs; both round-trip properties
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 4. Implement the VM core
  - `runHandler`, `evalStatement`, `evalExpr`, `DispatchContext.tick()` with gas, abort and error types
  - Locals, `it`, globals, value coercion, property validity, control-flow sentinels
  - Define and export `DispatchContext` (`stepCount`, `depth`, `abortSignal`, `pendingVisualEffect`, `tick()`) in `src/core/vm.ts`; the spec 01 message bus imports it from there
  - Reuse the store's property conversion helpers (e.g. the `location` centre rule `x + floor(width/2)`) instead of reimplementing them
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

- [ ] 5. Implement suspending commands through the host interface
  - `wait`, `answer`, `ask`, `go` (with pending visual effect), `play`
  - _Requirements: 5.1, 5.7_

- [ ] 6. Implement the sandboxed fetch
  - `src/core/fetchPolicy.ts` with URL policy, timeout, size cap, JSON path, error reasons
  - _Requirements: 6.1, 6.2, 6.3_
