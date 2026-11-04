# partrenderer-test-timeouts Bugfix Design

## Overview

Under parallel load, `npx vitest --run` occasionally fails because tests in the `disabled parts` block of `src/engine/graphics/__tests__/partRenderer.test.ts` run past Vitest's default 5,000 ms timeout. A failed run blocks the GitHub Pages deploy.

The approved fix ("Fast expectDimmed + 30 s timeouts") changes only test code:

1. Rewrite the helper `expectDimmed` so that its per-pixel loop compares in plain code and asserts once at the end, instead of calling `expect` 175,104 times.
2. Give the heavy tests an explicit 30,000 ms per-test timeout through one named constant per file. `numRuns` values stay as they are, and the global configuration in `vite.config.ts` is not touched.

Product code under `src/` (everything outside `__tests__/`) does not change.

## Glossary

- **Bug_Condition (C)**: a test is a heavy test and either makes `expect` calls per pixel or runs with only the default 5,000 ms timeout.
- **Property (P)**: every heavy test has a 30,000 ms timeout, and one call of `expectDimmed` makes at most 3 `expect` matcher calls.
- **Preservation**: `expectDimmed` accepts and rejects exactly the same frame triples as before, and all other tests keep their assertions, `numRuns` and timeout.
- **`expectDimmed(enabledPart, extra)`**: helper in `partRenderer.test.ts`, inside `describe("disabled parts")`. It draws three frames with the `draw` helper: `on` (the enabled part), `off` (the same part with `enabled: false`) and `blank` (the enabled part with an empty title or content). It then checks the dimming rule pixel by pixel.
- **Dimming rule**: for each pixel `i` at `(x, y)`:
  - where `on[i] === blank[i]` (frame, chrome, background), `off[i]` must equal `on[i]`;
  - otherwise (text ink) on checker pixels, `((x + y) & 1) === 0`, `off[i]` must equal `on[i]` and counts as `inkKept`;
  - otherwise `off[i]` must equal `blank[i]` and counts as `inkDropped`.
  Both `inkKept` and `inkDropped` must be greater than 0.
- **Heavy tests**: the set `HEAVY_TESTS` defined in Bug Details.
- **`HEAVY_TEST_TIMEOUT_MS`**: per-file constant `30_000`, passed as the third argument of `it(name, fn, timeout)`. Vitest 5.1 accepts a number in that position (`TestCollectorCallable`: `(name, fn?, options?: number)`).
- **`expect.getState().assertionCalls`**: Vitest's counter of matcher calls in the current test, used to measure how many `expect` calls the helper makes.

## Bug Details

### Bug Condition

`expectDimmed` calls `expect(off[i]).toBe(...)` for every one of the `TOTAL_PIXELS` = 512 × 342 = 175,104 pixels. Each matcher call has a fixed Vitest overhead, so each test that uses the helper takes seconds. With 32 test files competing for CPU, some of those tests go past 5,000 ms. The heavy property tests in the other files have no explicit timeout either, so they rely on the same 5,000 ms budget under the same load.

**Formal Specification:**
```
HEAVY_TESTS :=
  partRenderer.test.ts, describe "disabled parts": every it(...) in the block
      (4 tests that call expectDimmed, "dims field text but draws the caret normally",
       "leaves the enabled rendering unchanged", and the new tests added by this spec)
  partRenderer.test.ts: "property: writes only states 1/2 and only inside the part rect" (numRuns 60)
  partRenderer.test.ts: "property: hitting pointer (x*k + dx, y*k + dy) equals hitting frame pixel (x, y)" (default numRuns)
  parser.roundtrip.test.ts: "Property 1: parse(print(A)) deep-equals A ..." (numRuns 300)
  parser.roundtrip.test.ts: "Property 2: parse(print(parse(S))) deep-equals parse(S) ..." (numRuns 300)
  textRaster.test.ts: "property: the mask holds only 0/2 and rendering is deterministic" (numRuns 200)

FUNCTION isBugCondition(T)
  INPUT: T, a test case of the Vitest suite
  OUTPUT: boolean

  RETURN T IN HEAVY_TESTS
         AND ( T.timeout = 5000                          // default budget only
               OR expectCallsPerExpectDimmed(T) > 3 )    // per-pixel expect calls
END FUNCTION
```

On the unfixed code, every test in `HEAVY_TESTS` satisfies the condition, and `expectCallsPerExpectDimmed` is 175,104 + 2.

### Examples

- "dims a pressed button's title inside the inverted interior" draws three frames and makes 175,106 `expect` calls. In the observed parallel run it exceeded 5,000 ms and failed, although every pixel was correct. Expected: it passes, making 3 `expect` calls.
- "dims field text and keeps the frame, rules and scrollbar" failed the same way in the same run.
- `partRenderer.test.ts` alone passes 32/32 in about 12 s, and the next full run passed 820/820. The failure depends on load, not on the rendering.
- Edge case: "Property 1" in `parser.roundtrip.test.ts` (300 runs) has not timed out yet, but it runs with the same 5,000 ms budget under the same load. Expected: it runs with a 30,000 ms budget and keeps `numRuns: 300`.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- `expectDimmed` still fails when a disabled part's chrome differs from the enabled rendering (Requirement 3.1).
- `expectDimmed` still fails when text ink is not dimmed on the checkerboard: a checker ink pixel is not kept, or a non-checker ink pixel is not dropped to the blank value (Requirement 3.2).
- `expectDimmed` still fails when no ink is kept or no ink is dropped (Requirement 3.3).
- Every other test keeps its assertions, its `numRuns` and the default timeout. The edited property tests keep their `numRuns` of 60, default, 300, 300 and 200 (Requirement 3.4).
- `vite.config.ts` and all product code stay unchanged (Requirement 3.5).

**Scope:**
Tests outside `HEAVY_TESTS` are not touched. This includes:
- all other tests in `partRenderer.test.ts`, `parser.roundtrip.test.ts` and `textRaster.test.ts`;
- the 100-run property tests in `messageBus`, `history` and `store`, which passed in every observed run;
- every other test file.

**Risk check (done before this spec):** no other test file calls `expect` per pixel across the whole frame. `paintTools.test.ts` checks only the painted pixels, and `transitions.test.ts` throws instead of calling `expect`.

## Hypothesized Root Cause

1. **Per-pixel `expect` calls in `expectDimmed`**: the loop makes 175,104 matcher calls per test. Each call does matcher lookup, state bookkeeping and `assertionCalls` accounting. That cost far exceeds the rendering work, which is three frames per test.
2. **No explicit timeout on heavy tests**: the `disabled parts` tests and the large property tests run with the 5,000 ms default. On a contended machine (parallel workers, CI runners) wall-clock time grows while the work stays the same, so these tests fail now and then.

The first cause was confirmed by the investigation: the two failing tests are both `expectDimmed` tests, and the file passes on its own. The second cause is a risk shared by all heavy tests.

## Correctness Properties

Property 1: Bug Condition - Heavy tests have a 30 s budget and expectDimmed asserts in constant count

_For any_ test T where isBugCondition(T) holds on the unfixed code (T is in HEAVY_TESTS), the fixed test file SHALL declare T with the per-file `HEAVY_TEST_TIMEOUT_MS` (30,000 ms) as the third argument of `it(...)`, and any single call of `expectDimmed` SHALL make at most 3 `expect` matcher calls (`expect(mismatches).toEqual([])` and the two `toBeGreaterThan(0)` checks), whatever the part configuration.

**Validates: Requirements 2.1, 2.2, 2.3**

Property 2: Preservation - Same verdicts from expectDimmed and unchanged other tests

_For any_ frame triple (on, off, blank), the fixed helper SHALL pass exactly when the original helper passes. In particular, it SHALL fail for a disabled frame with a changed chrome pixel, a checker ink pixel that was not kept, a non-checker ink pixel that was not dropped, or no kept or dropped ink at all. _For any_ test T where isBugCondition(T) does not hold, the fixed suite SHALL run T exactly as before, with the same assertions, `numRuns` and timeout.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Assuming the root cause analysis is correct:

**File**: `src/engine/graphics/__tests__/partRenderer.test.ts`

**Function**: `expectDimmed` (inside `describe("disabled parts")`)

**Specific Changes**:
1. **Timeout constant**: add `const HEAVY_TEST_TIMEOUT_MS = 30_000;` at module level, next to the other constants.
2. **Split the helper** (done in the preservation task, before the fix, with no change in behavior): `expectDimmed(enabledPart, extra)` draws `on`, `off` and `blank` as now and calls `expectDimmedFrames(on, off, blank)`, which holds the comparison. The preservation tests can then pass deliberately wrong frames to `expectDimmedFrames`.
3. **Fast comparison** in `expectDimmedFrames`: for each `i`, compute `x`, `y` and the expected value from the dimming rule, and update `inkKept` / `inkDropped` as now. When `off[i] !== expected`, push `{ index: i, x, y, expected, actual: off[i] }` while the list holds fewer than 20 entries (`MAX_REPORTED_MISMATCHES = 20`). After the loop, call `expect(mismatches).toEqual([])`, then `expect(inkKept).toBeGreaterThan(0)` and `expect(inkDropped).toBeGreaterThan(0)`. The loop makes no `expect` call. A single wrong pixel still produces a non-empty list. A short `off` array still fails, because `off[i]` is `undefined` and differs from every expected value. So the helper is exactly as strict as before.
4. **Timeouts**: pass `HEAVY_TEST_TIMEOUT_MS` as the third argument to every `it(...)` in `describe("disabled parts")`, to "property: writes only states 1/2 and only inside the part rect", and to the `hitTest` property test. Do not change any `numRuns`.

**File**: `src/core/__tests__/parser.roundtrip.test.ts`

**Specific Changes**:
5. Add `const HEAVY_TEST_TIMEOUT_MS = 30_000;` and pass it as the third argument to "Property 1: ..." and "Property 2: ...". Keep `numRuns: 300` in both.

**File**: `src/engine/graphics/__tests__/textRaster.test.ts`

**Specific Changes**:
6. Add `const HEAVY_TEST_TIMEOUT_MS = 30_000;` and pass it as the third argument to "property: the mask holds only 0/2 and rendering is deterministic". Keep `numRuns: 200`.

**Not changed**: `vite.config.ts` (no global `testTimeout`), any product module, any other test, any spec document.

## Testing Strategy

### Validation Approach

First, show on the unfixed code that `expectDimmed` makes about 175k `expect` calls. That count is deterministic, so it is a stable measure of the bug, unlike timing. Then pin the helper's verdicts with deliberately wrong frames. Then apply the fix and check that both pass, and that the full suite passes three runs in a row.

### Exploratory Bug Condition Checking

**Goal**: Show the per-pixel `expect` cost on the unfixed code and confirm the root cause.

**Test Plan**: Add a test to `describe("disabled parts")` that reads `expect.getState().assertionCalls`, calls `expectDimmed(button())`, reads the counter again, and asserts that the difference is at most 3. Give it `HEAVY_TEST_TIMEOUT_MS`, so that on the unfixed code it fails on the assertion and not on a timeout. Run it on the unfixed code.

**Test Cases**:
1. **Assertion count for a push button**: `expectDimmed(button())` makes at most 3 `expect` calls (will fail on unfixed code: about 175,106).

**Expected Counterexamples**:
- `expected 175106 to be less than or equal to 3` (the exact number is `TOTAL_PIXELS + 2`).
- If the count is already small, the root cause is refuted and the timeouts must be investigated again.

### Fix Checking

**Goal**: Every heavy test has the 30 s budget, and `expectDimmed` asserts a constant number of times.

**Pseudocode:**
```
FOR ALL T IN HEAVY_TESTS DO
  ASSERT T.timeout = HEAVY_TEST_TIMEOUT_MS = 30000
END FOR
FOR ALL config IN { push button, pressed button, checkbox, scrolling field } DO
  before := expect.getState().assertionCalls
  expectDimmed(config)
  ASSERT expect.getState().assertionCalls - before <= 3
END FOR
```

The timeouts are checked by reading the three diffs. The count is checked by the exploration test for the push button. The other three configurations use the same code path.

### Preservation Checking

**Goal**: The fixed helper accepts and rejects exactly the frame triples the original accepted and rejected, and nothing outside `HEAVY_TESTS` changes.

**Pseudocode:**
```
FOR ALL (on, off, blank) DO
  ASSERT passes(expectDimmedFrames_original, on, off, blank)
       = passes(expectDimmedFrames_fixed, on, off, blank)
END FOR
FOR ALL T WHERE NOT isBugCondition(T) DO
  ASSERT T_original = T_fixed      // same source, numRuns and timeout
END FOR
```

**Testing Approach**: Property-based testing over mutations of real renderings. The frames come from the four existing `expectDimmed` configurations. Each mutation flips one pixel of the valid `off` frame (`3 - v`, since frames drawn on `lightFrame()` hold only states 1 and 2) at a pixel of a chosen kind. Every such mutation must make `expectDimmedFrames` throw. On the unfixed code the original helper throws at the first wrong pixel. Candidate pixels are taken in index order, so the wrong pixel sits near the top of the part and each run stays cheap.

**Test Plan**: Before the fix, split the helper into `expectDimmed` and `expectDimmedFrames` without changing behavior. Then write the tests below and confirm that they pass on the unfixed code.

**Test Cases**:
1. **Chrome change is rejected**: flipping one pixel where `on[i] === blank[i]` makes the check throw (Requirement 3.1).
2. **Kept ink is required**: flipping one checker ink pixel makes the check throw (Requirement 3.2).
3. **Dropped ink is required**: flipping one non-checker ink pixel makes the check throw (Requirement 3.2).
4. **No ink is rejected**: `expectDimmedFrames(f, f, f)` with three identical frames throws on `inkKept > 0` (Requirement 3.3).
5. **Valid frames are accepted**: the four existing `expectDimmed` tests keep passing (Requirement 3.4).

### Unit Tests

- Exploration test: the assertion count of `expectDimmed(button())` is at most 3.
- No-ink example: `expectDimmedFrames(f, f, f)` throws.
- The existing `disabled parts` example tests stay as they are (apart from the added timeout) and pass.

### Property-Based Tests

- Preservation property: for any configuration among the four, any mutation kind (chrome, kept ink, dropped ink) and any `k` in 0..4 (the k-th candidate pixel of that kind in index order), flipping that pixel in `off` makes `expectDimmedFrames` throw. Use `numRuns: 20` and `HEAVY_TEST_TIMEOUT_MS`.
- The existing property tests in `HEAVY_TESTS` keep their `numRuns` and generators. They only gain the timeout argument.

### Integration Tests

- `npx tsc -b` passes once.
- `npx vitest --run` passes in three runs in a row, with no failed test and no timeout. All three summary lines (`Test Files …` and `Tests …`) are recorded.
