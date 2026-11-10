# Kiro usage log

This file records how Kiro was used to build HexCard, for the Kiroween 2026 write-up. It is built from the repository history (`git log`), the task records in `.kiro/specs/*/tasks.meta.json`, the spec documents, the hooks and the steering files, plus facts the developer supplied that the repository does not show. It lists what Kiro did and what the developer decided. Entries for later tasks are appended by workflow rule 6 in `.kiro/steering/workflow.md`.

All 57 commits (to 2026-11-10) are authored by the developer, who committed and pushed every change by hand. Kiro never committed.

## How a task was run

- Every spec task was started with Kiro's "Start task" button in the spec's `tasks.md`.
- Each task report was reviewed by the developer against the files on disk. The developer re-ran `npx tsc -b` and `npx vitest --run` and, for UI tasks, built the app and checked headless-Chrome screenshots for any pixel that is not one of the two theme colours.
- Spec documents are read-only during a task run (steering rule 3). Early in the build, some spec text was written outside Kiro (for example spec 01 requirements 6.4–6.7, added after the first run of spec 01 task 2). After that, spec changes were applied by Kiro from prompts marked "user-approved" (for example `4d61d54`, `c580993`, `afdc94e`).
- The model was chosen on purpose, not left on "Auto": Opus 5.5 at high effort for integration and correctness-critical tasks (store, message bus, VM, menu wiring), Sonnet 5.5 at high effort for well-scoped tasks. The repository does not record which model ran which task, so the log below does not either.

## Feature index

| Kiro feature | Status | Evidence |
|---|---|---|
| Spec-driven development | Used | `.kiro/specs/01-core-stack-engine`, `02-hextalk-ast-vm`, `03-1bit-canvas-dither`, `04-ui-audio-showcase`, `05-authoring-loop`, each with `requirements.md`, `design.md`, `tasks.md`. Specs 01-04 were written before implementation began (`2051051`, `b67efa2`, `f839d40`, `4766bdf`); their authorship is not attributed to Kiro. They were changed during the build (`8b7e062`, `3e3839f`, `6c675c6`, `a829c41`, `97ef062`, `becaed7`, `4d61d54`, plus spec edits inside `a686a8b`, `9265c80`, `fdb5658`, `4cc4cec`). Early in the build some spec text was written outside Kiro (for example spec 01 requirements 6.4–6.7, added after the first run of task 2); later changes were applied by Kiro from prompts marked "user-approved" (for example `4d61d54`). Applied by Kiro from user-approved prompts: `a829c41`, `becaed7`, `4d61d54`, the `design.md` part of `8b7e062`, and the spec edits inside `a686a8b` and `fdb5658`. Added by the developer by hand: the `tasks.md` lines in `8b7e062`, `3e3839f` and `6c675c6`. Not recorded: `97ef062` and the spec edits inside `9265c80` and `4cc4cec`. Spec 05 was generated with Kiro's spec workflow (requirements, then design, then tasks, with an approval at each stage) from a one-paragraph description (`67f0d80`, `.kiro/specs/05-authoring-loop/.config.kiro`: `requirements-first`, `feature`). Spec 05 was then changed by Kiro from user-approved prompts (`c580993`, `afdc94e`). |
| Task runner ("Start task") | Used | `tasks.meta.json` in all five numbered specs and in the bugfix spec. 33 numbered-spec tasks are ticked: 6 in spec 01, 6 in spec 02, 7 in spec 03, 8 in spec 04 (task 5 is ticked only as 5.1; 5.2 is unticked), 6 in spec 05. 15 of those 33 have more than one distinct execution ID, 18 have one. See the note on execution IDs below. |
| Bugfix workflow | Used | `.kiro/specs/partrenderer-test-timeouts/` (`bugfix.md`, `design.md`, `tasks.md`, `.config.kiro`: `requirements-first`, `bugfix`), committed in `2a8ad64`. Found during spec 04. |
| Steering | Used | `.kiro/steering/product.md`, `tech.md`, `structure.md` (first commit `2051051`), `workflow.md` (added in `5137dac`). All four use `inclusion: always`. `tech.md` and `structure.md` were edited after the first commit. |
| Agent hooks | Used | `.kiro/hooks/enforce-1bit-ui.json` and `.kiro/hooks/validate-ast-safety.json`, both `PostFileSave` hooks with an `agent` action (`2051051`, format fixed in `f839d40`). They audited every saved file during task runs. In spec 05 they reported no violations. |
| Custom agents | Planned | None. There is no `.kiro/agents/` directory. |
| MCP | Planned | None. There is no `.kiro/settings/mcp.json` in the workspace. |
| Powers | Planned | None. |
| Property-based testing | Used | `fast-check` in `package.json`; 18 test files under `src/` reference it. Parser round-trip (`src/core/__tests__/parser.roundtrip.test.ts`, spec 02 task 3), undo property over random sequences of structural commands (`src/core/__tests__/authoringCommands.property.test.ts`, spec 05 task 3), codec fuzz and property tests (spec 03 task 1). The bugfix spec records four property-test results in `pbtResults` (all `passed`); the `pbtResults` of specs 01-05 are empty. |
| Model selection | Used | Opus 5.5 and Sonnet 5.5, both at high effort, chosen per task. Not "Auto". No per-task record in the repository. |

Note on execution IDs: `tasks.meta.json` lists an `executionId` for each recorded run of a task. Four IDs appear under more than one task: `2762b3` (spec 01 task 5, spec 03 task 4), `242849` (spec 01 task 5, spec 04 task 3), `ffda34` (spec 01 task 5, spec 04 tasks 2 and 3), `1e1340` (spec 04 tasks 2 and 3). The counts below are the number of distinct IDs listed under each task, so spec 01 task 5 (5 IDs, 3 of them shared) may show more runs than it had retries. The bugfix spec has one ID for all its sub-tasks (`e77831c3`).

## Session log

Dates are commit dates (UTC+3). Times are from `tasks.meta.json` and are given only where they help to read a retry. Entries are in commit order. "Executions" is the number of distinct execution IDs in `tasks.meta.json` for that task. Lines changed come from `git show --shortstat`. Tags: [spec] spec-driven development, [task] a "Start task" run, [chat] a regular Kiro chat session (not "Start task"), [hook] agent hooks, [pbt] property-based testing, [bugfix] bugfix workflow, [steering] steering files.

### 2026-10-30 to 2026-11-03: specs, steering and hooks before implementation

- **[spec] [steering] [hook]** Commits `2051051` (9 files, +808: spec `01-hexcard-core`, steering `product.md`, `structure.md`, `tech.md`, both hooks, `hexcard_design_spec.md`), `2fe2770`, `b67efa2` (spec 04 added), `f839d40` (22 files: specs split into 01-04, hook format fixed, `LICENSE` added).
  - Asked: not recorded. This is the planning stage before the first task run.
  - Kiro: no Kiro task run is recorded for these commits. Authorship of the spec text is not attributed to Kiro.
  - Outcome: specs 01-04, three steering files and two hooks existed before the first task ran. Evidence: `f839d40`.

### 2026-11-04

- **[spec]** `4766bdf` (10:08, 1 file, +3 -1): "add bg/stack name mutations and injected codec to spec 01 design". Committed before the first task execution (10:12). Evidence: `4766bdf`.
- **[spec] [task]** Spec 01 task 1, scaffold and persisted schema.
  - Asked: Start task on "1. Scaffold the project and the persisted schema".
  - Kiro: scaffolded the project and the persisted schema. Executions: 1.
  - Outcome: `a6ed2b0`, 15 files, +2042 -3.
- **[spec] [task]** Spec 01 task 2, stack validation.
  - Asked: Start task on "2. Implement stack validation".
  - Kiro: implemented the Zod stack validator (requirements 6.1-6.7). Executions: 2.
  - Outcome: `9f5318f`, 6 files, +614 -4.
- **[spec] [task] [steering]** Spec 02 task 1, AST types and AST validator.
  - Asked: Start task on "1. Define AST types and the AST validator".
  - Kiro: implemented `ast.ts`, `HexCompileError` and `astValidator.ts` with `astValidator.test.ts`. Executions: 1. The same commit adds `.kiro/steering/workflow.md`.
  - Outcome: `5137dac`, 9 files, +742 -2.
- **[spec] [task]** Spec 01 task 3, runtime store.
  - Asked: Start task on "3. Implement the runtime store".
  - Kiro: implemented the store, sharedText semantics, ScriptCache and auto-save. Executions: 2, in 2 sessions. When the first run was stopped, the task checkbox was left ticked although `src/core/store.ts` did not exist yet. The developer unticked it by hand before the re-run.
  - Outcome: `efae190`, 4 files, +1100 -1.
- **[spec]** User-approved spec edit `8b7e062`: defines `store.applyAuthoring` and the history wiring for spec 01 task 4 (`design.md` +4, `tasks.md`). Kiro applied the `design.md` part from a user-approved prompt. The `tasks.md` line was added by the developer by hand.
- **[spec] [task] [pbt]** Spec 01 task 4, 50-step undo history.
  - Asked: Start task on "4. Implement the 50-step undo history".
  - Kiro: implemented the 50-step history, `PaintStrokeCommand` and `store.applyAuthoring`, with `history.test.ts` (fast-check is used in that file). Executions: 1.
  - Outcome: `31f5d3f`, 6 files, +654 -1.
- **[spec]** User-approved spec edit `3e3839f`: pins the `DispatchContext` location and the property helpers for spec 02 task 4 (`tasks.md` +2). The `tasks.md` lines were added by the developer by hand.
- **[spec] [task]** Spec 02 task 4, VM core.
  - Asked: Start task on "4. Implement the VM core".
  - Kiro: implemented the gas-limited VM core, `DispatchContext` and shared property helpers. Executions: 2.
  - Outcome: `a9284eb`, 5 files, +1490 -7.
- **[spec] [task]** Follow-up to spec 02 task 4: empty-as-0 arithmetic, loop-iteration gas, evaluated host targets.
  - Kiro: changed `vm.ts` and `vm.test.ts`; the commit also changes spec 02 `design.md` (30 lines changed) and `requirements.md`, and `hexcard_design_spec.md`. Kiro applied the spec edits of this commit from a user-approved prompt before changing the code.
  - Outcome: `a686a8b`, 6 files, +71 -11.
- **[spec] [task]** Spec 01 task 5, message bus.
  - Asked: Start task on "5. Implement the message bus".
  - Kiro: implemented the message bus, FIFO queue, idle timer, nested lifecycle dispatch and abort. Executions: 5 (3 shared with other tasks, see the note above).
  - Outcome: `c45ca15`, 4 files, +825 -1.
- **[spec] [task]** Spec 01 task 6, core test suite.
  - Asked: Start task on "6. Core test suite".
  - Kiro: wrote the core test suite with requirement traceability. Executions: 3. The first dispatch failed with a service error ("unexpectedly high load"; Sonnet 5.5 was under high traffic) and wrote no files. The task was re-run with Opus 5.5.
  - Outcome: `b59562f`, 5 files, +281 -20. Phase 1 (spec 01) complete.
- **[spec]** User-approved spec edit `6c675c6`: ties the parser to the `astValidator` reserved words for spec 02 task 2 (`tasks.md` +1). The `tasks.md` line was added by the developer by hand.
- **[spec] [task]** Spec 02 task 2, lexer and parser.
  - Asked: Start task on "2. Implement the lexer and parser".
  - Kiro: implemented the HexTalk lexer and parser and grammar notes for parser decisions. Executions: 1.
  - Outcome: `c13029e`, 5 files, +1780 -1.
- **[spec] [task] [pbt]** Spec 02 task 3, printer and round-trip tests.
  - Asked: Start task on "3. Implement the printer and round-trip tests".
  - Kiro: implemented the HexTalk printer and the round-trip property tests in `parser.roundtrip.test.ts`. Executions: 3.
  - Outcome: `d72fb51`, 4 files, +968 -3.
- **[spec] [task]** Shared `HEX_MAX_DEPTH` nesting limit in the parser and the AST validator.
  - Kiro: changed `ast.ts`, `astValidator.ts`, `parser.ts`, added `nestingDepth.test.ts` (230 lines); the commit also changes spec 02 `tasks.md`, `tasks.meta.json` and `hexcard_design_spec.md`.
  - Outcome: `9265c80`, 7 files, +554 -100.
- **[spec] [task]** Spec 02 task 5, suspending commands.
  - Asked: Start task on "5. Implement suspending commands through the host interface".
  - Kiro: implemented `go`, `wait` and `play` through the host, with an end-to-end `go` test. Executions: 1.
  - Outcome: `490e0d1`, 5 files, +407 -10.
- **[spec] [task]** `go back` with bounded card history (requirement 2.7) and `store.onReplaceStack`.
  - Kiro: changed `messageBus.ts`, `store.ts` and tests; the commit also changes spec 01 `requirements.md`, `design.md` and `tasks.md`. Kiro applied these spec edits from a user-approved prompt before changing the code.
  - Outcome: `fdb5658`, 8 files, +340 -23.
- **[spec] [task]** Spec 02 task 6, sandboxed fetch.
  - Asked: Start task on "6. Implement the sandboxed fetch".
  - Kiro: implemented `fetchPolicy.ts` and its tests. Executions: 1.
  - Outcome: `21476e4`, 5 files, +448 -2. Spec 02 complete.
- **[spec] [task] [pbt]** Spec 03 task 1, bitmap codec.
  - Asked: Start task on "1. Implement the bitmap codec".
  - Kiro: integrated the 2-bit PackBits codec following the reference implementation in `hexcard_design_spec.md` §5.4, which was written before the task, and added the fuzz and property tests. Executions: 1.
  - Outcome: `d47412d`, 4 files, +385 -1.
- **[spec] [task]** Spec 03 task 2, frame composition.
  - Asked: Start task on "2. Implement frame composition".
  - Kiro: implemented frame composition, palette mapping and integer scale. Executions: 1.
  - Outcome: `c6297fb`, 5 files, +450 -2.
- **[spec] [task]** Spec 03 task 3, crisp text and fonts.
  - Asked: Start task on "3. Implement crisp text rendering and fonts".
  - Kiro: implemented the 1-bit text rasterizer and added CC0/OFL pixel fonts with an integer-multiple size table. Executions: 2.
  - Outcome: `372908c`, 17 files, +1261 -3.
- **[spec] [task]** Spec 03 task 4, part rendering and hit testing.
  - Asked: Start task on "4. Implement part rendering and hit testing".
  - Kiro: implemented the part renderer, hit testing and dimmed disabled parts; disabled parts get no mouse messages (requirement 2.8). Executions: 3 (1 shared, see the note above).
  - Outcome: `64df4d6`, 15 files, +1266 -17.
- **[spec] [task]** Spec 03 task 5, Atkinson import.
  - Asked: Start task on "5. Implement Atkinson image import".
  - Kiro: implemented Atkinson import with aspect-fit resampling. Executions: 1.
  - Outcome: `686e01f`, 4 files, +317 -1.
- **[spec] [task]** Spec 03 task 6, visual effects.
  - Asked: Start task on "6. Implement visual effects".
  - Kiro: implemented the LFSR dissolve and 11 pixel-buffer transitions with abort. Executions: 1.
  - Outcome: `e4b6a01`, 6 files, +565 -2.
- **[spec] [task]** Spec 03 task 7, paint tools and patterns.
  - Asked: Start task on "7. Implement paint tools and patterns".
  - Kiro: implemented 38 patterns, paint tools and selection. Executions: 1.
  - Outcome: `9dd0b00`, 6 files, +1274 -1. Spec 03 complete.
- **[spec]** User-approved spec edit `a829c41`: spec 04 loader, store view, font and paint wiring, composition root and starter stack (spec 04 `design.md` +5, `requirements.md` +4, `tasks.md`). Kiro applied it from a user-approved prompt. The `src/core/history.ts` change in the same commit (+4 -1) is the doc comment of `clear()`, corrected as part of that prompt.
- **[spec] [task]** Spec 04 task 2, System 7 shell and tools palette.
  - Asked: Start task on "2. Build the System 7 shell and tools palette".
  - Kiro: built the shell, menus, themes, modal manager and tear-off tools palette. Executions: 3, in 2 sessions (19:46 to 23:23; 2 IDs shared).
  - Outcome: `5d969f6`, 7 files, +1802 -1.
- **[spec] [task]** Spec 04 task 3, card viewport and VM host.
  - Asked: Start task on "3. Build the card viewport and VM host".
  - Kiro: built the card viewport, VM host, composition root and startup messages (requirement 2.9) and auto-hilite. Executions: 5, in 2 sessions (22:00 on 11-04 to 00:59 on 11-05; 3 IDs shared).
  - Outcome: `e9bb9ae`, 20 files, +2468 -16. Follow-up commits for this area: `d5e438b` (uniform integer UI scale, requirement 2.10; 16 files, +635 -179) and `91a766a` (pure 1-bit chrome, frame-aware UI scale; 9 files, +701 -79, also edits `tech.md`).
- **[chat] [hook]** `431aa22`: GitHub Pages deploy workflow, 4 files, +99 -2.
  - Asked: set up the GitHub Pages deploy, in a regular chat session (not "Start task").
  - Kiro: set up the GitHub Pages workflow (`.github/workflows/deploy.yml`): the build job runs typecheck, tests and the `BASE_PATH` build, and the deploy job (`needs: build`) only starts if the build passed. It added `assetUrls.test.ts`, which on its first run flagged Kiro's own doc comment; Kiro reworded the comment. The `PostFileSave` hook audited the saved files.
  - Outcome: `431aa22`.

### 2026-11-05

- **[chat] [hook]** `1dddf5d`: polish pass, 4 files, +44 -4.
  - Asked: a small polish pass, in a regular chat session (not "Start task").
  - Kiro: made a 1-bit favicon (`public/favicon.svg`), a page reset and palette title spacing. It reported a bug it found outside the task: on windows smaller than the 1x card, part of the card could not be scrolled into view. That was then fixed with `safe center` alignment. The hook audit of `system7.css` found no violations.
  - Outcome: `1dddf5d`.
- **[spec] [task] [bugfix] [pbt]** Spec 04 task 6, persistence and sharing, and the bugfix spec `partrenderer-test-timeouts`.
  - Asked: Start task on "6. Implement persistence and sharing" (executions: 1, 00:10 to 00:21). During the full-suite runs, two `disabled parts` tests in `partRenderer.test.ts` timed out (`Test Files 1 failed | 31 passed (32)`, `Tests 2 failed | 818 passed (820)`). A bugfix spec was then created with Kiro's bugfix workflow.
  - Kiro: for the task, implemented the safe stack loader, auto-save, `.hexstack` files and share links. For the bugfix, the workflow produced `bugfix.md`, `design.md` and `tasks.md`, and Kiro ran the tasks in one execution (00:31 to 00:43, ID `e77831c3`). The exploration test counted 175,106 `expect` calls for one `expectDimmed(button())` call (175,104 per-pixel calls plus 2 `toBeGreaterThan` checks), which was the cause of the slow tests. The fix replaced the per-pixel `expect` calls with plain comparisons and one assertion on a list of at most 20 mismatches, so one `expectDimmed` call makes at most 3 `expect` calls. A preservation property test (`numRuns: 20`) flips one pixel in a valid frame and requires `expectDimmedFrames` to throw, which shows the check is still as strict. The heavy tests got an explicit 30,000 ms timeout from a `HEAVY_TEST_TIMEOUT_MS` constant in each of the three test files.
  - Outcome: `2a8ad64`, 25 files, +1750 -23. All bugfix tasks are ticked. `pbtResults` in `partrenderer-test-timeouts/tasks.meta.json` has four entries, all with status `passed`. The first holds the failing example from unfixed code (`expected 175106 to be less than or equal to 3`).
- **[spec] [task]** Spec 04 task 1, WebAudio synthesizer.
  - Asked: Start task on "1. Implement the WebAudio synthesizer".
  - Kiro: implemented the synth with five voices and the note parser, and wired it into the studio. Executions: 1.
  - Outcome: `05fa20f`, 8 files, +905 -2.
- **[spec] [task]** Spec 04 task 4, Object Inspector, error dialogs and Stack Graph.
  - Asked: Start task on "4. Build the Object Inspector, error dialogs and Stack Graph".
  - Kiro: built the Object Inspector, script editor with inline errors, bomb and script-error dialogs and the Stack Graph. Executions: 2.
  - Outcome: `25fb4e7`, 11 files, +2320 -13.
- **[spec]** User-approved spec edit `97ef062`: first-launch showcase, showcase chooser, preset art script, Open-Meteo (spec 04 `design.md`, `requirements.md`, `tasks.md`, `structure.md`, `tsconfig.node.json`).
- **[spec] [task]** Spec 04 task 8, showcase stacks.
  - Asked: Start task on "8. Create the three showcase stacks".
  - Kiro: built the Haunted Stack, HexSynth Sequencer and HexOracle, the first-launch showcase, the chooser, the unsaved-changes guard and the fetch cache. Executions: 3.
  - Outcome: `01c92ee`, 29 files, +3814 -50.
- **[spec]** User-approved spec edit `becaed7`: splits the Spellcaster task into 5.1 and 5.2 and adds requirement 4.6, a corpus of at least 60 prompts where at least 80% must compile correctly. Kiro applied it from a user-approved prompt.
- **[spec] [task] [pbt]** Spec 04 task 5.1, Tier 1 Spellcaster.
  - Asked: Start task on "5.1 Tier 1 local compiler, 24-entry Grimoire, acceptance pipeline and the Spellcaster tab preview/Apply flow". Executions: 4 (02:38 to 08:15).
  - Kiro: built the Tier 1 local compiler, the 24-entry Grimoire, the acceptance pipeline and the preview/Apply flow (`aff5889`, 10 files, +3163 -10). Then added handler-level merge on Apply, five new phrasing families and a 156-prompt corpus (`8f821c2`, 7 files, +1020 -108). The first corpus metric counted intentionally refused prompts as failures. It was replaced by requirement 4.6: 100% expected-outcome match, with at least 75% of the corpus expecting a compilable script. Kiro also made the compiler refuse ambiguous unquoted value words (`207edb5`, 5 files, +766 -46, which edits spec 04 `requirements.md`).
  - Outcome: `aff5889`, `8f821c2`, `207edb5`. Task 5.2 (optional Tier 2 proxy and Tier 3 BYOK) is unticked.

### 2026-11-08

- **[spec] [task]** Spec 04 task 7, player build and standalone HTML export.
  - Asked: Start task on "7. Implement the player build and standalone HTML export".
  - Kiro: built the browse-only player bundle with embedded fonts and the standalone HTML export through a lazy virtual module (`src/player/embedded.ts`, `src/player/main.ts`, `src/storage/htmlExporter.ts`). Executions: 2 (10:04 and 10:12 to 10:24).
  - Outcome: `4cc4cec`, 21 files, +1351 -240.
- **[spec] [steering]** User-approved edit `4d61d54`: standalone export escape wording changed to `\u003c` in `tech.md` and spec 04 (`design.md`, `requirements.md`).
- **[spec]** Spec 05, authoring loop, generated with Kiro's spec workflow.
  - Asked: a one-paragraph description of the feature. Kiro produced requirements, then design, then tasks, and the developer approved each stage.
  - Kiro: wrote `requirements.md` (191 lines), `design.md` (320 lines in the commit) and `tasks.md` (39 lines in the commit, 6 tasks). The commit also edits `hexcard_design_spec.md` (§3.2 and §8, per the commit message) and `structure.md`.
  - Outcome: `67f0d80`, 6 files, +570 -10.
- **[spec] [task]** Spec 05 task 1, store and history.
  - Asked: Start task on "1. Extend the store and the history for part selection and the restored current card".
  - Kiro: added part selection to the store, `applyAuthoring` with a current card, and `currentCardAfter` in the history. Executions: 1.
  - Outcome: `6165bcf`, 9 files, +346 -15.
- **[spec] [task]** Spec 05 task 2, message bus command dispatches.
  - Asked: Start task on "2. Extend the message bus with command dispatches".
  - Kiro: added queued command dispatches and `changeCardBy` with structural message orders. Executions: 1.
  - Outcome: `efc79ca`, 4 files, +435 -18.
- **[spec] [task] [pbt]** Spec 05 task 3, structural commands.
  - Asked: Start task on "3. Implement the structural commands".
  - Kiro: implemented the structural commands, default names and ids, the blank stack, and a fast-check undo property (`authoringCommands.property.test.ts`). Executions: 1.
  - Outcome: `d1963b8`, 5 files, +1106 -1.
- **[spec] [task]** Spec 05 task 4, menu model.
  - Asked: Start task on "4. Implement the menu model, menu handlers and shortcuts".
  - Kiro: the first run could not start because the session had no task-status tools. A fresh session fixed it. The run then produced `menuCommands.ts` (619 lines) and `menuCommands.test.ts` (1061 lines): menu layout, enabling rules, handlers and shortcuts. Executions: 1 (16:34 to 16:46).
  - Outcome: `196c774`, 4 files, +1693 -1.
- **[spec]** The review of task 4 found that task 5 would need to change `src/ui/fileCommands.ts`, which the design did not list. A user-approved spec change was made before task 5 ran: task 5 also removes `FileCommands.run` and moves `createThemeCommand` to `menuCommands.ts`.
  - Outcome: `c580993`, 3 files, +5 -2 (spec 05 `design.md`, `tasks.md`, `structure.md`).
- **[spec] [task]** Spec 05 task 5, studio wiring.
  - Asked: Start task on "5. Wire the menus, shortcuts and selection into the studio".
  - Kiro: rendered the studio menus from `menuCommands.ts`, added one shortcut listener and the dim overlay, and moved part selection into the store. It added an `isWindowOpen` check because the design assumed that studio windows stop key events, which only holds while the focus is inside the window, and requirement 16.3 also covers focus outside it. Executions: 1 (16:51 to 17:01).
  - Outcome: `c90a0a0`, 12 files, +413 -303.

- **[spec] [task]** Spec 05 task 6, authoring loop in headless Chrome, first run (17:08).
  - Asked: Start task on "6. Check the authoring loop in headless Chrome".
  - Kiro: did not work around the spec. It stopped and reported two gaps. (1) The step order contradicted requirement 10.2: Go > Prev clears the selection, so Delete Part was disabled. (2) Chrome 157's LCD sub-pixel text rendering on the host put about 1,690 non-black/white pixels per screenshot into the text of the DOM menus.
  - Outcome: no commit for this run. The spec was changed afterwards (next entry).

### 2026-11-10

- **[spec]** User-approved spec change for task 6: Delete Part moves before the Go steps (step order is now New Card, New Button, New Field, Delete Part, Undo, Go > Prev, Go > Next), and the headless Chrome command gets `--disable-lcd-text`.
  - Outcome: `afdc94e` (14:25), 3 files, +10 -3 (spec 05 `design.md`, `requirements.md`, `tasks.meta.json`).
- **[spec] [task]** Spec 05 task 6, second run (14:26 to 14:32, a second session; the first run is in the 2026-11-08 section).
  - Kiro: built a two-card stack from File > New Stack using only menus at UI scale 1 and 2, took a screenshot after every step, compared the auto-saved stack with each step, and checked that every screenshot contains only `#000000` and `#FFFFFF`. The check script is a throw-away script outside the repository, so the commit changes no code. Executions: 2 for this task.
  - Outcome: `7615239`, 2 files, +11 -1 (`tasks.md`, `tasks.meta.json`). Spec 05 complete.
- **[steering]** This file. Created from the repository history and the facts supplied by the developer, at the developer's request. Added `KIRO_USAGE.md` to the tree in `.kiro/steering/structure.md` and rule 6 (usage log) to `.kiro/steering/workflow.md`. No application code or spec document changed. `npx tsc -b` and `npx vitest --run` were not run for this change. Evidence: `KIRO_USAGE.md`, `.kiro/steering/workflow.md`, commit pending.
