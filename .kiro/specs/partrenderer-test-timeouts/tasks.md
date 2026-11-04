# Implementation Plan

Test-only fix. Do not change product code, `vite.config.ts`, any `numRuns`, or any spec document. Never commit or push.

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Heavy tests have a 30 s budget and expectDimmed asserts in constant count
  - **CRITICAL**: This test MUST FAIL on unfixed code - failure confirms the bug exists
  - **DO NOT attempt to fix the test or the code when it fails**
  - **NOTE**: This test encodes the expected behavior - it will validate the fix when it passes after implementation
  - **GOAL**: Show that `expectDimmed` makes one `expect` call per pixel
  - **Scoped PBT Approach**: The bug is deterministic, so scope the property to one concrete case: `expectDimmed(button())`
  - In `src/engine/graphics/__tests__/partRenderer.test.ts`, add `const HEAVY_TEST_TIMEOUT_MS = 30_000;` at module level
  - In `describe("disabled parts")`, add a test "expectDimmed makes at most 3 expect calls": read `expect.getState().assertionCalls`, call `expectDimmed(button())`, read the counter again, then `expect(after - before).toBeLessThanOrEqual(3)`
  - Pass `HEAVY_TEST_TIMEOUT_MS` as the third argument of this new `it(...)`, so on unfixed code it fails on the assertion, not on a timeout
  - Bug condition from design: `isBugCondition(T)` holds when T is in HEAVY_TESTS and `expectCallsPerExpectDimmed(T) > 3` or `T.timeout = 5000`
  - Run `npx vitest --run src/engine/graphics/__tests__/partRenderer.test.ts` on UNFIXED code
  - **EXPECTED OUTCOME**: Test FAILS with a count of about `TOTAL_PIXELS + 2` = 175,106 (this proves the bug exists)
  - Document the counterexample in the task report
  - _Requirements: 1.1, 2.1_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Same verdicts from expectDimmed and unchanged other tests
  - **IMPORTANT**: Follow observation-first methodology
  - Split the helper without changing behavior: `expectDimmed(enabledPart, extra)` draws `on`, `off` and `blank` as now and calls a new `expectDimmedFrames(on, off, blank)`, which holds the current loop and the two `toBeGreaterThan(0)` checks unchanged (still one `expect` per pixel)
  - Observe on UNFIXED code: the four existing `expectDimmed` tests pass, and flipping one pixel of a valid `off` frame makes `expectDimmedFrames` throw
  - Add a property test in `describe("disabled parts")`: for any configuration among the four existing `expectDimmed` configurations, any mutation kind and any `k` in 0..4, flip (`3 - v`) the k-th pixel of that kind, in index order, in a copy of `off`, and assert `expect(() => expectDimmedFrames(on, bad, blank)).toThrow()`
    - Mutation kinds: chrome (inside the part rect, `on[i] === blank[i]`), kept ink (`on[i] !== blank[i]` and checker), dropped ink (`on[i] !== blank[i]` and not checker)
    - Use `numRuns: 20` and `HEAVY_TEST_TIMEOUT_MS` as the third argument
  - Add an example test: `expectDimmedFrames(f, f, f)` with three identical frames throws (no kept or dropped ink)
  - Run `npx vitest --run src/engine/graphics/__tests__/partRenderer.test.ts` on UNFIXED code
  - **EXPECTED OUTCOME**: The new preservation tests PASS, the four existing `expectDimmed` tests PASS, and the task 1 test still FAILS
  - _Requirements: 3.1, 3.2, 3.3, 3.4_

- [x] 3. Fix the test timeouts in the parallel suite

  - [x] 3.1 Implement the fix
    - In `expectDimmedFrames`, replace the per-pixel `expect` calls with plain comparisons: compute the expected value from the dimming rule, count `inkKept` / `inkDropped` as now, and push `{ index, x, y, expected, actual }` for each mismatch while the list holds fewer than `MAX_REPORTED_MISMATCHES = 20` entries
    - After the loop: `expect(mismatches).toEqual([])`, `expect(inkKept).toBeGreaterThan(0)`, `expect(inkDropped).toBeGreaterThan(0)`
    - In `partRenderer.test.ts`, pass `HEAVY_TEST_TIMEOUT_MS` as the third argument to every `it(...)` in `describe("disabled parts")`, to "property: writes only states 1/2 and only inside the part rect" and to the `hitTest` property test
    - In `src/core/__tests__/parser.roundtrip.test.ts`, add `const HEAVY_TEST_TIMEOUT_MS = 30_000;` and pass it to "Property 1: ..." and "Property 2: ..."
    - In `src/engine/graphics/__tests__/textRaster.test.ts`, add `const HEAVY_TEST_TIMEOUT_MS = 30_000;` and pass it to "property: the mask holds only 0/2 and rendering is deterministic"
    - Keep every `numRuns` (60, default, 300, 300, 200), every other test and `vite.config.ts` unchanged
    - _Bug_Condition: isBugCondition(T) from design (T in HEAVY_TESTS with default timeout or per-pixel expect calls)_
    - _Expected_Behavior: Property 1 from design (30,000 ms timeout on every heavy test; at most 3 expect calls per expectDimmed)_
    - _Preservation: Preservation Requirements from design (same helper verdicts; other tests, numRuns and config unchanged)_
    - _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 3.2 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Heavy tests have a 30 s budget and expectDimmed asserts in constant count
    - **IMPORTANT**: Re-run the SAME test from task 1 - do NOT write a new test
    - Run `npx vitest --run src/engine/graphics/__tests__/partRenderer.test.ts`
    - **EXPECTED OUTCOME**: The task 1 test PASSES (confirms the bug is fixed)
    - Check in the diff that every test listed in HEAVY_TESTS has `HEAVY_TEST_TIMEOUT_MS` as its third argument
    - _Requirements: 2.1, 2.2_

  - [x] 3.3 Verify preservation tests still pass
    - **Property 2: Preservation** - Same verdicts from expectDimmed and unchanged other tests
    - **IMPORTANT**: Re-run the SAME tests from task 2 - do NOT write new tests
    - Run the preservation tests from task 2 and the four existing `expectDimmed` tests
    - **EXPECTED OUTCOME**: Tests PASS (confirms no regressions)
    - Check in the diff that no `numRuns`, no other test and no file outside the three test files changed
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Checkpoint - Ensure all tests pass
  - Run `npx tsc -b` once
  - Run `npx vitest --run` three times in a row
  - Paste all three Vitest summary lines (`Test Files …` and `Tests …`) in the report
  - **EXPECTED OUTCOME**: Type check passes, and all three runs pass with no failed test and no timeout
  - Do not commit or push
  - Ask the user if questions arise
  - _Requirements: 2.3_
