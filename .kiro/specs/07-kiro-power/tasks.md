# Implementation Plan

## Overview

**HexCard Kiro Power: validate, compile, conjure, draw and preview HexCard stacks from a Kiro chat.**

Tasks are in priority order (design §Overview, "Proposed delivery order"): the list can be cut after any task, every task leaves `npx tsc -b` and `npx vitest --run` passing, and no task depends on a later one. Each test is written in the task that builds the code it tests. The tool list grows task by task, always in the `tools/list` order of design §protocol.ts: task 3 adds `validate_stack`, `compile_hextalk` and `conjure_script`, task 4.2 adds `render_card` and task 5.1 adds `draw_layer`. The end-to-end, copy and `Function`-trap tests cover the tools that exist when a task runs, so Requirements 4.3 and 17.3 are complete after task 5.1, and Requirement 1.1 (the two skill folders) after task 6.2.

Every task ends with `npx tsc -b` and `npx vitest --run`, and the report quotes their summary lines (workflow rule 2). From task 3.5 on, every task runs `npm run build:power` before `npx vitest --run`, so the committed server file matches the sources and the staleness test of Requirement 3.5 passes; the command changes nothing when no bundled module changed. New files go only where `.kiro/steering/structure.md` lists them after task 1 (Requirement 14.6); test helpers stay in `__tests__/` folders. Workflow rule 3 has exactly two exceptions in this spec (Requirement 15.4): the document changes of task 1 and the Introduction edit of task 7. Any other change to a spec document that a task needs stops the task with a reported gap (Requirement 15.6). No task commits or pushes (workflow rule 4). Each report ends with "Decisions for review" (workflow rule 5), and after ticking a task the agent appends one entry for it to the Session log of `KIRO_USAGE.md` (workflow rule 6). Where a step of task 7 or 8 needs the Kiro UI, the agent stops, tells the developer exactly what to click and what to send, and waits for the developer's answer before it goes on.

## Tasks

- [x] 1. Make the specification document changes
  - `.kiro/steering/structure.md`: `07-kiro-power` in the `.kiro/specs/` comment and "next to 01-07"; the new top-level `powers/` entry; `buildPowerServer.ts` and `checkPowerChrome.ts` under `scripts/`; the `src/power/` folder with one line per file; `powerShowcase.ts` and `powerShowcase.json` under `src/presets/` and the `4 showcase stacks (..., Kiro power stack)` comment; `07` added to `stackValidator.ts`, `partRenderer.ts`, `paintTools.ts`, `stackLoader.ts` and the presets `index.ts` (design §Document changes, item 1)
  - `hexcard_design_spec.md` §8: `06-hypercard-classics/` becomes `├──`, followed by the `07-kiro-power/` entry (item 2); §9: the fourth entry after `apiWeatherOracle.ts` (item 3)
  - Spec 04 `requirements.md` Requirement 7.5: the sentence in brackets about the fourth showcase stack (item 4)
  - No stack name in any of these changes (Requirement 15.3). These are the only changes workflow rule 3 allows in this task; no other Markdown file and no application code changes (Requirements 15.4, 15.5)
  - Verification: `npx tsc -b`, `npx vitest --run`
  - _Requirements: 14.6, 15.1, 15.2, 15.3, 15.4, 15.5_

- [x] 2. Make the changes to existing modules
  - Before any module changes, copy the code that Properties 1 and 4 and the listing tests compare against ("kept in the test as an oracle", design §Correctness Properties and §Testing Strategy) into test helpers: `src/core/__tests__/stackValidatorOracle.ts` (today's `stackValidator.ts`, unchanged apart from import paths), `src/storage/__tests__/checkStackOracle.ts` (today's `checkStack`, calling that oracle) and `src/engine/graphics/__tests__/rectLoopOracle.ts` (today's Rect loop of `drawShape`). Tasks 3.3 and 5.2 reuse them
  - `src/core/stackValidator.ts`: `GateMessagePiece`, `GateError`, `StackValidationReport`, `formatGateError` and `listStackValidationErrors` with the error order of design §stackValidator.ts; the structural checks become collectors with unchanged messages and walks; `validateStack` returns the first entry, formatted
  - `src/storage/stackLoader.ts`: `listStackErrors` (layer decode errors after the validation errors, backgrounds before cards); `checkStack` returns the first entry (design §stackLoader.ts)
  - `src/engine/graphics/paintTools.ts`: exported `plotRectShape`; the Rect branch of `drawShape` calls it with the same `put` calls in the same order (design §paintTools.ts)
  - `src/engine/graphics/partRenderer.ts`: exported `clearIconCache` (design §partRenderer.ts)
  - `src/core/__tests__/hexAstArbitraries.ts`: the AST generators of `parser.roundtrip.test.ts`, moved unchanged apart from `export`; `parser.roundtrip.test.ts` imports them and changes no assertion or property (design D17)
  - New tests: `src/core/__tests__/stackValidator.list.test.ts`, `src/storage/__tests__/stackLoader.list.test.ts`, `src/engine/graphics/__tests__/paintTools.rect.test.ts`, `src/engine/graphics/__tests__/partRenderer.iconCache.test.ts` (design §Testing Strategy), each against the oracles where the design says so. No existing test of these four modules is edited, and all of them still pass
  - Headless Chrome (after `npm run build`; `--headless=new --disable-lcd-text`, fresh profile per scale, k = 1 and k = 2; throw-away script outside the repository): File > New Stack, the Rect tool, one drag down and to the right and one up and to the left; the auto-saved card bitmap, decoded with the repository's `decodeBitmapRLE` through Vite's `runnerImport`, equals the oracle loop's pixels for the same drags in card coordinates; every screenshot after File > New Stack has only `#000000` and `#FFFFFF`
  - Verification: `npx tsc -b`, `npx vitest --run`
  - _Requirements: 5.5, 6.4, 11.6, 14.2, 14.3, 14.5_

- [ ] 3. Build the power package and the server core with validate_stack, compile_hextalk and conjure_script
  - Order inside this task: the protocol modules and the three tools (3.1 to 3.4) come before the power package and the build script (3.5), unlike the list in design §Overview, because the build script bundles `src/power/main.ts`, which imports the protocol handler and the tools

  - [ ] 3.1 Build the protocol core: results, argument checker, stdio loop, protocol handler and start check
    - `src/power/results.ts`: `LIST_LIMIT`, `QUOTE_LIMIT`, `quoteText`, `shortenMessage`, `shortenGateError`, `cappedList`, `toolResult`, `errorResult` (design §results.ts)
    - `src/power/argumentCheck.ts`: the `ArgSchema` subset, `checkArguments` with the order, paths and messages of design §argumentCheck.ts, `formatArgPath`, lengths in UTF-16 code units, an unknown keyword thrown as a programming error
    - `src/power/stdio.ts`: `serveLines` and `MAX_LINE_BYTES`, with discard mode, one overflow answer and each answer written before the next line is handled (design §stdio.ts)
    - `src/power/protocol.ts`: `createProtocolHandler` with the steps and method table of design §protocol.ts, the four protocol versions, U+2028 and U+2029 escaped, the internal-error result and a log line without input text
    - `src/power/startCheck.ts`: `startCheckFailure` with the probes in the order of design §startCheck.ts
    - `src/power/tools/index.ts`: the types `ToolName`, `PowerTool`, `ToolSteps` and `ToolDeps`; `createPowerTools` follows in 3.2. `ToolSteps` holds `listStackErrors` and `parseHexTalk` until task 5.1 adds `checkDrawCommands`, and `ToolDeps` gains `fonts` in task 4.2
    - Tests in `src/power/__tests__/`: `argumentCheck.test.ts`, `results.test.ts`, `protocol.test.ts` (tools injected by the test, including a throwing tool followed by a correct answer to the next line), `stdio.test.ts`, `startCheck.test.ts` (design §Testing Strategy)
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 2.7, 4.1, 4.2, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 4.10, 4.11, 5.6, 5.7, 17.1_

  - [ ] 3.2 Implement stack reading and the tools validate_stack, compile_hextalk and conjure_script
    - `src/power/stackText.ts`: `MAX_STACK_TEXT` and `readAndGate` with the length, JSON or `.hexstack` reading and gate steps of design §stackText.ts, through `listStackErrors` of task 2
    - `src/power/tools/validateStack.ts`, `compileHexTalk.ts` and `conjureScript.ts` (design §tools/validateStack.ts, §tools/compileHexTalk.ts, §tools/conjureScript.ts), with the result shapes of design §Data Models; `conjure_script` imports `conjureLocally`, never `conjureScript`
    - `src/power/tools/index.ts`: `createPowerTools` returning these three tools in this order, with the titles, descriptions and inputSchemas of design §tools/index.ts and §Tool input schemas and the four annotations of Requirement 4.3
    - Tests in `src/power/__tests__/`: `validateStack.test.ts`, `compileHexTalk.test.ts`, `conjureScript.test.ts` (design §Testing Strategy); `steps.test.ts` with throwing `listStackErrors` and `parseHexTalk` doubles, each followed by a correct answer to the next call; `argumentCheck.test.ts` gains every bound of Requirement 5.3 for these three tools (each bound accepted, one past it rejected, a value outside each set rejected); no state between calls of these tools; each tool product longer than 80 characters returned whole (canonical form, handler names, conjured HexTalk, `.hexstack` text)
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1, 8.2, 8.3, 8.4, 8.5, 14.1, 17.1_

  - [ ] 3.3 Write the property test for Property 1
    - **Property 1: validate_stack agrees with the gate, in both text forms**
    - **Validates: Requirements 6.3, 6.4, 6.7, 14.2**
    - `src/power/__tests__/tools.property.test.ts`, at least 100 runs, with the comment `// Feature: 07-kiro-power, Property 1: validate_stack agrees with the gate, in both text forms`
    - Generators and comparison condition of design §Testing Strategy: strings and record keys of up to 120 characters, short non-string `schemaVersion` values, the injected faults of the property; the oracles of task 2 for the pre-spec-07 `validateStack` and `checkStack`
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 6.3, 6.4, 6.7, 14.2, 17.2_

  - [ ] 3.4 Write the property test for Property 2
    - **Property 2: compile_hextalk round trip**
    - **Validates: Requirements 7.3, 7.4**
    - `src/power/__tests__/tools.property.test.ts`, at least 100 runs, with the comment `// Feature: 07-kiro-power, Property 2: compile_hextalk round trip`, using the AST generators of `src/core/__tests__/hexAstArbitraries.ts` (task 2)
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 7.3, 7.4, 14.3, 17.2_

  - [ ] 3.5 Create the power package, the server entry, the build script and the committed server file
    - `powers/hexcard/plugin.json` and `powers/hexcard/mcp.json` exactly as design §plugin.json and §mcp.json
    - `src/power/zodJitless.ts` and `src/power/main.ts` (design §zodJitless.ts, §main.ts) without the font steps: until task 4.2, `main.ts` runs the start check and then serves the three tools of task 3.2; `zodJitless.ts` stays its first import, and the version comes from `plugin.json` through `?raw`
    - `scripts/buildPowerServer.ts` (design §Build script): `SERVER_FILE_ARG`, `POWER_DIR`, `SERVER_FILE_PATH`, `BUILD_POWER_COMMAND`, `buildPowerServer` and `main` with `--check`; one unminified chunk with the banner, failure on a second chunk, the repository's absolute root path or `file://`; the licence table and the rule that every bundled package has a licence entry; it writes `server/hexcard-mcp.mjs`, `LICENSE` and the three files of `licenses/` (design §Licence files)
    - `package.json`: the `build:power` script in the `runnerImport` form of design §Build script; `build`, `build:player`, `vite.config.ts`, `vite.player.config.ts` and `.github/workflows/deploy.yml` unchanged
    - Run `npm run build:power` to write the server file and the licence files
    - Tests in `src/power/__tests__/` (design §Testing Strategy; 60 s timeouts for tests that build or spawn the server):
      - `package.test.ts`: Requirements 1.2 to 1.7 and 2.1 to 2.3, and the part of 1.1 that holds before task 6 (`plugin.json` and `mcp.json` at the root, no `POWER.md`)
      - `serverFile.test.ts`: staleness with the message naming `npm run build:power`, without writing the committed file; a second build with another `TZ`; imports, globals, `require`, `process.getBuiltinModule`, dynamic `import()` and `process.env`; no `react` module id. Task 4.2 adds the font check
      - `serverProcess.test.ts`: the end-to-end sequence of Requirement 17.3 for the three tools; two working folders with `PLUGIN_ROOT` and `PLUGIN_DATA` set and unset; the start without `--permission` and with `--allow-fs-write=*`; a copy alone in an empty temp folder; the `Function` trap through `--import` of a `data:` module
      - `boundaries.test.ts`: no `src/power/` module reachable from `src/main.tsx` or `src/player/main.ts`; no `react` import in `src/core/` or `src/engine/`
    - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`; then `npm run build` and a check that the committed server file is byte-identical to before and that `dist/` holds no copy of it (Requirement 3.6)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 4.2, 4.10, 14.4, 14.5, 17.3, 17.5, 17.8_

- [ ] 4. Implement render_card with the Node text backend, and check it in headless Chrome

  - [ ] 4.1 Implement the TrueType reader and the Node text backend
    - `src/power/trueType.ts`: `TrueTypeError`, `parseTrueType` (the tables, the cmap subtable order, simple and composite glyphs, the rejected inputs) and `fillOutline` (nonzero winding sampled at pixel centres) (design §trueType.ts)
    - `src/power/nodeTextBackend.ts`: `parseFaces`, `faceOf`, `createNodeTextBackend` with `measureText` and `drawText` only, `coveredCodePoints` and `uncoveredCharacters` (design §nodeTextBackend.ts)
    - `src/power/fontBytes.ts`: `bundledFontBytes` through `import.meta.glob` with `?inline` (design §fontBytes.ts)
    - Only their tests import these modules until task 4.2 wires them into the server
    - Tests in `src/power/__tests__/`: `trueType.test.ts` and `nodeTextBackend.test.ts` (design §Testing Strategy), including the 95 printable ASCII code points mapped in every bundled font file
    - Verification: `npm run build:power` (the server file stays unchanged), `npx tsc -b`, `npx vitest --run`
    - _Requirements: 10.1, 10.2, 10.5, 10.6, 14.1, 14.4, 14.5_

  - [ ] 4.2 Implement the PNG encoder and render_card
    - `src/power/png.ts`: `encodeFramePng` (design §png.ts)
    - `src/power/tools/renderCard.ts` (design §tools/renderCard.ts): `readAndGate`, card selection, `composeFrame` with `createPartRasterizer` and the Node text backend, the PNG, the summary of design §Data Models with the uncovered characters of every visible part, and `clearDecodedLayerCache` and `clearIconCache` in `finally`
    - `src/power/tools/index.ts`: `render_card` as the fourth tool, with its inputSchema and a description that states the pixel-match limit of Requirement 10.4; `ToolDeps` gains `fonts`
    - `src/power/main.ts`: parses the embedded fonts after the start check and before standard input is read; a font the reader cannot read gives one standard error line and exit status 1 (design §main.ts, §Error Handling)
    - Rebuild the server file with `npm run build:power`
    - Tests in `src/power/__tests__/`: `png.test.ts` and `renderCard.test.ts` (design §Testing Strategy); `argumentCheck.test.ts` gains the `card` and `scale` bounds; determinism and no state between calls with `render_card`; `serverFile.test.ts` gains every font file as its exact base64 `data:` URL; `serverProcess.test.ts` gains `render_card` in the end-to-end sequence, the copy test and the `Function` trap, and byte-identical PNG data from two processes
    - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`
    - _Requirements: 2.4, 3.1, 3.7, 4.3, 5.2, 5.3, 5.5, 5.7, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 10.1, 10.4, 10.5, 14.1, 17.1, 17.3_

  - [ ] 4.3 Write the property test for Property 3
    - **Property 3: render_card PNG holds the frame**
    - **Validates: Requirements 9.4, 9.7**
    - `src/power/__tests__/tools.property.test.ts`, at least 100 runs, with the comment `// Feature: 07-kiro-power, Property 3: render_card PNG holds the frame`; the test's own PNG reader inflates the image data with `node:zlib`
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 9.4, 9.7, 17.2_

  - [ ] 4.4 Write the headless Chrome check and run it for the three showcase stacks
    - `scripts/checkPowerChrome.ts` and the `package.json` script `check:power-chrome` in the `runnerImport` form, with the option `--chrome <path>` (design §Headless Chrome check): the committed server file started with the `args` of `mcp.json`; the text phase (a check page built from `textRaster.ts`, every covered character alone and in runs of 24, canvas backend against Node text backend, for every face and render size); the card phase at UI scale 1 and 2, each on a fresh profile (every card of every `SHOWCASE_STACKS` entry opened through the menu, the two reads 1 s apart, `render_card` of the auto-saved stack or the `create()` output, the PNG against the canvas pixels at k = 1 and against a canvas screenshot at k = 2, only the theme's two colours in every screenshot); the summary and images in a new temp folder, nothing written into the repository
    - Run `npm run build`, then `npm run check:power-chrome`. The report quotes the summary: the Chrome version, characters compared per face and render size, cards compared per stack and scale, every differing case and the colour counts
    - A difference that the server code causes is fixed in this task (rebuild with `npm run build:power`, run the check again). A difference that a rule of `requirements.md` or `design.md` causes is reported as a gap (Requirement 15.6), and the task stays unticked
    - The script is not part of `npx vitest --run`
    - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`
    - _Requirements: 10.3, 17.6_

- [ ] 5. Implement draw_layer

  - [ ] 5.1 Implement the draw_layer tool
    - `src/power/tools/drawLayer.ts` (design §tools/drawLayer.ts): `DrawCommand`, `checkDrawCommands`, `drawCommands` (rectangles through `plotRectShape`, lines through `bresenhamLine`, pattern states through `PATTERNS` and `patternState`, sprites, text through `renderCrisp1BitText` with the Node text backend), the not-fit notes, the uncovered characters, `rleData` `""` when the drawing equals the base, and the pixel counts; the tool's `checkArguments` in the order of design §tools/drawLayer.ts, with the call's total characters last
    - `src/power/tools/index.ts`: `draw_layer` as the fifth tool, with the `oneOf` inputSchema of design §Tool input schemas; `ToolSteps` gains `checkDrawCommands`
    - Rebuild the server file with `npm run build:power`
    - Tests in `src/power/__tests__/`: `drawLayer.test.ts` (design §Testing Strategy); `steps.test.ts` gains a throwing `checkDrawCommands` double followed by a correct answer to the next call; `argumentCheck.test.ts` gains every `draw_layer` bound of Requirement 5.3; determinism, no state between calls across all five tools, and `rleData` longer than 80 characters returned whole; `serverProcess.test.ts` gains `draw_layer` in the end-to-end sequence (now `tools/list` lists exactly the five tools in order), the copy test and the `Function` trap
    - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`
    - _Requirements: 3.7, 4.3, 5.3, 5.4, 5.7, 10.5, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 11.10, 11.11, 14.1, 17.1, 17.3_

  - [ ] 5.2 Write the property test for Property 4
    - **Property 4: draw_layer rectangles and lines equal the paint tools**
    - **Validates: Requirements 11.1, 11.2, 11.3, 11.6, 14.2**
    - `src/power/__tests__/tools.property.test.ts`, at least 100 runs, with the comment `// Feature: 07-kiro-power, Property 4: draw_layer rectangles and lines equal the paint tools`; a real store, history and `createPaintController` for the same drags, and the Rect-loop oracle of task 2
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 11.1, 11.2, 11.3, 11.6, 14.2, 17.2_

  - [ ] 5.3 Write the property test for Property 5
    - **Property 5: sprites set exactly their cells**
    - **Validates: Requirements 11.1, 11.4**
    - `src/power/__tests__/tools.property.test.ts`, at least 100 runs, with the comment `// Feature: 07-kiro-power, Property 5: sprites set exactly their cells`
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 11.1, 11.4, 17.2_

  - [ ] 5.4 Write the property test for Property 6
    - **Property 6: draw_layer output is canonical, valid and stable**
    - **Validates: Requirements 11.7, 11.8, 11.11**
    - `src/power/__tests__/tools.property.test.ts`, at least 100 runs, with the comment `// Feature: 07-kiro-power, Property 6: draw_layer output is canonical, valid and stable`; texts drawn from printable ASCII
    - Verification: `npx tsc -b`, `npx vitest --run`
    - _Requirements: 11.7, 11.8, 11.11, 17.2_

- [ ] 6. Write the two skills

  - [ ] 6.1 Write the author-hexcard-stack skill
    - `powers/hexcard/skills/author-hexcard-stack/SKILL.md`: the front matter and the sections of design §Skills, covering Requirements 12.2 to 12.6, 12.8, 12.9 and 12.11 and the pixel-match limit of 10.4
    - `references/schema.md` (design spec §2.1 verbatim), `references/patterns.md` (the 38 patterns) and `references/fonts.md` (files, selecting settings, covered characters beyond printable ASCII), in the formats of design §Skills
    - Skill examples with the `hexcard:` info-string markers of design §Skills: the minimal stack, the shared-text stack with two cards, and the drawing example with its `rle-from` stack. Every `rleData`, message and canonical form in the skill is copied from an actual tool call (for example through the committed server file over stdio), never written by hand
    - Tests in `src/power/__tests__/`: `skills.test.ts` for this skill (every marked example run through the tools, failure when the skill holds no stack example or no drawing example, the `rle-from` pairing, drift of the three reference files against design spec §2.1, `PATTERNS`, `TEXT_SIZE_TABLE` and the parsed cmaps, the statements of Requirements 10.4 and 12.11); `package.test.ts` gains the front matter of Requirement 12.1
    - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`
    - _Requirements: 10.4, 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.7, 12.8, 12.9, 12.10, 12.11, 17.4, 17.5_

  - [ ] 6.2 Write the write-hextalk skill
    - `powers/hexcard/skills/write-hextalk/SKILL.md`: the front matter and the sections of design §Skills, covering Requirements 13.3 to 13.6; `references/grammar.md` (design spec §4.1 verbatim, named in `SKILL.md`)
    - A mistake example for every case of Requirement 13.4, each message copied from an actual `compile_hextalk` call; the `field N` / `button N` example followed by its `hexcard:canonical` block
    - Tests: `skills.test.ts` gains this skill (HexTalk, mistake and canonical-form blocks, failure when it holds no HexTalk example or no mistake example, drift of `grammar.md` against design spec §4.1); `package.test.ts` gains the front matter of Requirement 13.1 and the rest of Requirement 1.1 (`skills/` holds exactly the two skill folders)
    - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`
    - _Requirements: 1.1, 13.1, 13.2, 13.3, 13.4, 13.5, 13.6, 17.4, 17.5_

- [ ] 7. Use the power in Kiro: live import, Kiro check and the fourth showcase stack
  - Start only when tasks 1 to 6 are ticked. Requirement 16.1's "every other task" means tasks 1 to 6 here, because task 8 can only run after the developer has pushed this task's work (Requirement 17.9)
  - Prepare (agent, in a new folder `/tmp/hexcard-power-live/` outside the repository): `haunted.json`, the JSON text of `createHauntedMansionStack()` through Vite's `runnerImport`; and a throw-away helper that reads a word in the terminal with echo off, draws it with the committed server file's `draw_layer` (one `text` command, `size` 24, `card` layer), puts the returned `rleData` into the card of a minimal stack whose strings do not contain the word, and writes that stack's JSON text to `image-check.json`. The agent never reads the word or that file
  - Live import, developer step (Requirement 16.1): the agent stops and asks the developer to confirm in the Powers panel that no power named `hexcard` is installed, then to click Add Custom Power > Import power from a folder and choose `<repository>/powers/hexcard`, and to report the name Kiro shows for the power, the skills and the MCP server (with its name) in the power's details, the server's status and tools in the MCP servers tab of the Kiro panel, every line about the server in the output channel "Kiro - MCP Logs" (including the protocol version Kiro requested, if shown) and the Kiro version from Kiro's About dialog
  - Live import, agent: finds the server process with `ps -eo pid,args`; checks its command line (bare `node` or the absolute path the executable search found, the four `args` of Requirement 2.3, no `${PLUGIN_ROOT}` text left); reads its working directory from `/proc/<pid>/cwd`; takes the plugin root from the server file path; compares every file of `powers/hexcard/` with the plugin root byte for byte, with no file missing or extra; states whether the plugin root is the chosen folder or a copy; records `--version` of the `node` binary the process runs (`/proc/<pid>/exe`)
  - Tools and image check, developer step: the agent gives the developer two messages to send in one new chat. The first asks for the names of the tools of the power's MCP server. Before the second, the developer chooses a word of 5 to 10 letters, tells it to no one and types it into the helper in a terminal. The second message asks the chat to read `/tmp/hexcard-power-live/image-check.json` (the developer pastes its text instead if the chat cannot read files outside the workspace), call `render_card` with that text as `stack` and `scale` 1, and then name the word drawn on the card without running a command or reading a file. The developer reports both answers, whether the second spells the word letter for letter (ignoring case), and whether the chat ran a command or read a file after the `render_card` result
  - Differences (Requirements 16.2, 16.11): if a check fails or Kiro differs from an expectation of Requirement 16.2, the agent fixes the power in this task (`npm run build:power`, `npx tsc -b`, `npx vitest --run`), asks the developer to remove the power in the Powers panel and import `powers/hexcard` again, and repeats every check of Requirement 16.1. A difference that cannot be fixed in the power or in the files this spec changes stops the task before the build chat; the task stays unticked and the report names the difference
  - Record (Requirement 16.2, the exception to workflow rule 3 of Requirement 15.4): once every check has passed, the agent rewrites the Basis paragraph of this spec's `requirements.md` (live import made, date, Kiro version), adds the value seen for each expectation of Requirement 16.2 to the K1 finding, naming every contradicted expectation, and corrects every K3 finding the live import contradicts. No other change to `requirements.md` or `design.md`
  - Kiro check, developer step (Requirement 17.7): the agent gives the developer a message for a new chat that calls each of the five tools once with valid arguments: `validate_stack` and `render_card` (card 1) on the text of `/tmp/hexcard-power-live/haunted.json`, `compile_hextalk` on a short script, `conjure_script` on a Grimoire prompt and `draw_layer` with one `rect`. The developer reports each tool's `ok` value and whether the chat showed the `render_card` image, and pastes the `parts` list of the `render_card` result; the agent checks that it lists the parts of card 1 and its background
  - Build chat, developer step (Requirements 16.3 to 16.7): the agent gives the developer the build message for a new chat. The message states the rules, not the content: load the author-hexcard-stack and write-hextalk skills; write a plan of the backgrounds, cards, parts, text and pictures before the first stack text; build an original stack (Requirement 16.7) that meets Requirements 16.4 and 16.6, writing the stack text, every script and every `draw_layer` command list itself; check every script with `compile_hextalk`, every change with `validate_stack` and every card with `render_card` (Requirement 16.5); save, with its file tools, the exact text of the last `validate_stack` call that returned `ok` true to `src/presets/powerShowcase.json`; end with a report of the calls of each tool, each `render_card` call after which the stack changed (card, what the image and summary showed, what changed) and the problems found in the power. When the chat has rendered every card of the final stack, the agent asks the developer to look at the images and either confirm in the chat that every card looks as planned or ask the chat for changes; then to paste the chat's report and list every change made to the stack by hand
  - Add the stack (Requirement 16.8, design §`src/presets/index.ts` and the new showcase stack, D7): `src/presets/powerShowcase.json` passes `validate_stack` with `ok` true, no script error and no note; new `src/presets/powerShowcase.ts`; the fourth `SHOWCASE_STACKS` entry in `src/presets/index.ts`; the `src/presets/__tests__/presets.test.ts` edits of design §Changes to existing modules; new `src/power/__tests__/powerShowcase.test.ts`. The agent checks Requirements 16.4, 16.6 (string literals covered in every face) and 16.7 against the committed stack and reports each
  - Offline open (Requirement 16.8): `npm run build`, `npx vite preview --port <p> --strictPort`, then headless Chrome (`--headless=new --disable-lcd-text`, fresh profile; throw-away script outside the repository) with every request to another host failed: File > Open Showcase Stack opens the new stack through the stack loader, and no request to another host is made
  - Headless Chrome check (Requirement 16.9): `npm run check:power-chrome` with the four showcase stacks; the report and the Session log entry quote the summary
  - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`
  - Usage log (Requirement 16.10): the Session log entry gives every item of Requirement 16.10; `[power]` is added to the tag list of the Session log; the feature-index rows Powers and MCP change from Planned to Used, with evidence naming `powers/hexcard/`, the power's MCP server under the name Kiro shows and the date of the entry
  - _Requirements: 1.8, 2.6, 15.4, 15.5, 15.6, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 16.9, 16.10, 16.11, 17.6, 17.7, 17.8_

- [ ] 8. Import the power from GitHub after the developer's push
  - Start only after the developer has committed and pushed the work of tasks 1 to 7 and says so; the agent never commits or pushes (workflow rule 4)
  - Developer step: the agent asks the developer to uninstall the `hexcard` power imported from the folder in task 7, then to click Add Custom Power > Import power from GitHub in the Powers panel and enter `https://github.com/hadbilen/hexcard-resurrection/tree/main/powers/hexcard`, and to report the name Kiro installs the power under and the name of its MCP server; then to send, in a new chat, the agent's message that calls `compile_hextalk` once with a short valid script, and to report its `ok` value
  - If Kiro does not accept the folder URL or installs the power under another name than `hexcard`, the agent stops and reports the difference (Requirements 1.8, 15.6) and changes no document
  - Verification: `npm run build:power`, `npx tsc -b`, `npx vitest --run`
  - Usage log (Requirement 17.9): the Session log entry gives the URL, the installed name, the tool and its `ok` value
  - _Requirements: 1.8, 17.9_

## Notes

- No task is optional, so no task carries the `*` marker; spec 06 had none either. The property tests are required sub-tasks, one per design property.
- There are no separate checkpoint tasks: every task already ends with `npx tsc -b` and `npx vitest --run` (workflow rule 2).
- Every task ticks `tasks.md` and appends to `KIRO_USAGE.md`, and from task 3.5 on every task can rewrite the server file, so the dependency graph below runs one task per wave.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1"] },
    { "id": 1, "tasks": ["2"] },
    { "id": 2, "tasks": ["3.1"] },
    { "id": 3, "tasks": ["3.2"] },
    { "id": 4, "tasks": ["3.3"] },
    { "id": 5, "tasks": ["3.4"] },
    { "id": 6, "tasks": ["3.5"] },
    { "id": 7, "tasks": ["4.1"] },
    { "id": 8, "tasks": ["4.2"] },
    { "id": 9, "tasks": ["4.3"] },
    { "id": 10, "tasks": ["4.4"] },
    { "id": 11, "tasks": ["5.1"] },
    { "id": 12, "tasks": ["5.2"] },
    { "id": 13, "tasks": ["5.3"] },
    { "id": 14, "tasks": ["5.4"] },
    { "id": 15, "tasks": ["6.1"] },
    { "id": 16, "tasks": ["6.2"] },
    { "id": 17, "tasks": ["7"] },
    { "id": 18, "tasks": ["8"] }
  ]
}
```
