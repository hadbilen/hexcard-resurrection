# Bugfix Requirements Document

## Introduction

`npx vitest --run` sometimes fails when the whole suite runs in parallel, because tests exceed Vitest's default 5,000 ms per-test timeout. The GitHub Pages deploy (`.github/workflows/deploy.yml`) runs only if the tests pass, so a timeout blocks deploys.

In the observed failing run (`Test Files 1 failed | 31 passed (32)`, `Tests 2 failed | 818 passed (820)`), two tests in the `disabled parts` block of `src/engine/graphics/__tests__/partRenderer.test.ts` timed out:

- "dims a pressed button's title inside the inverted interior"
- "dims field text and keeps the frame, rules and scrollbar"

The file passes on its own (32/32 in about 12 s), and the next full run passed (820/820). The cause is the test helper `expectDimmed`, which calls `expect(...).toBe(...)` once per pixel (512 × 342 = 175,104 calls per test). This is a test-only fix: no product code changes.

## Bug Analysis

### Current Behavior (Defect)

1.1 WHEN the full suite runs in parallel and a `disabled parts` test calls `expectDimmed` THEN the system makes one `expect` call per pixel of the frame (175,104 calls per call of the helper), and the test can exceed 5,000 ms and fail with a timeout although every pixel is correct

1.2 WHEN the full suite runs in parallel and one of the heavy tests runs (the `disabled parts` tests, the two property tests in `partRenderer.test.ts`, "Property 1" and "Property 2" in `parser.roundtrip.test.ts`, and the 200-run "property: the mask holds only 0/2 and rendering is deterministic" in `textRaster.test.ts`) THEN the system gives it only the default 5,000 ms budget, so CPU contention alone can make it fail

### Expected Behavior (Correct)

2.1 WHEN a `disabled parts` test calls `expectDimmed` THEN the system SHALL compare the enabled, disabled and blank frames pixel by pixel in plain code, without any `expect` call inside the loop, and SHALL then assert once that the list of mismatches is empty (the list keeps at most 20 entries, each with index, x, y, expected and actual), plus the two existing `toBeGreaterThan(0)` checks on the counts of kept and dropped ink pixels

2.2 WHEN one of the heavy tests listed in 1.2 runs THEN the system SHALL give it an explicit 30,000 ms per-test timeout, passed as the third argument to `it(...)` from one named constant per file (for example `HEAVY_TEST_TIMEOUT_MS = 30_000`)

2.3 WHEN `npx vitest --run` is run three times in a row on the fixed code THEN the system SHALL pass all tests in each run

### Unchanged Behavior (Regression Prevention)

3.1 WHEN a disabled part's rendering differs from the enabled rendering at a pixel where the enabled and blank frames agree (frame, chrome, border, mark, rules, scrollbar, background) THEN `expectDimmed` SHALL CONTINUE TO fail

3.2 WHEN a text-ink pixel (enabled and blank frames differ) is wrong in the disabled rendering, that is, it is not kept on a checker pixel (`((x + y) & 1) === 0`) or not dropped to the blank value on a non-checker pixel, THEN `expectDimmed` SHALL CONTINUE TO fail

3.3 WHEN a rendering keeps no text ink or drops no text ink THEN `expectDimmed` SHALL CONTINUE TO fail

3.4 WHEN any test other than the edited ones runs THEN the system SHALL CONTINUE TO run it unchanged, with the same assertions, the same `numRuns` and the default timeout; the edited property tests SHALL CONTINUE TO use their current `numRuns` (60, default, 300, 300 and 200)

3.5 WHEN the suite is configured THEN the system SHALL CONTINUE TO use the current `vite.config.ts` test settings (no global `testTimeout` change) and the current product code under `src/`, with only the three test files changing
