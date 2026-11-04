# Requirements Document: HexTalk Language, AST & Sandboxed VM

## Introduction
This spec covers the HexTalk parser and printer, the AST schema validator that gates AI output, and the gas-limited asynchronous VM, including the sandboxed `fetch`. Canonical contracts: grammar `hexcard_design_spec.md` §4.1, AST types §4.2, VM semantics and fetch policy §4.3, concurrency §3.2.

## Requirements

### Requirement 1: Parsing HexTalk
**User Story:** As a stack author, I want my HexTalk scripts parsed exactly by the published grammar, with clear errors, so that I can write and fix scripts confidently.

#### Acceptance Criteria
1. WHEN `parseHexTalk(source)` is called, THE SYSTEM SHALL accept exactly the language of design spec §4.1 and return `{ ast, errors }`, where each error has `line`, `column` and `message`.
2. IF the source contains a syntax error, THEN THE SYSTEM SHALL return the error without throwing, recover at the next `end <handler>` line, and still return the handlers that parsed correctly.
3. THE SYSTEM SHALL treat keywords, identifiers and handler names case-insensitively, storing identifiers and handler keys in lowercase and keeping the original handler spelling in `eventName`.
4. IF a handler's closing name differs from its opening name, or `pass` names a message other than the enclosing handler, THEN THE SYSTEM SHALL report a compile error at that line.
5. WHEN parsing `answer ... with A or B or C`, THE SYSTEM SHALL parse the button expressions at `ConcatExpr` level so that `or` separates buttons.

### Requirement 2: Printing & Round-Trip Guarantees
**User Story:** As a user of the AI Spellcaster, I want the HexTalk I see to be an exact representation of the AST that will run, so that what I review is what executes.

#### Acceptance Criteria
1. WHEN `printHexTalk(ast)` is called, THE SYSTEM SHALL produce canonical HexTalk using the normalisation rules of design spec §4.2 (parser/printer contract).
2. FOR every AST accepted by the AST validator, THE SYSTEM SHALL satisfy `parse(print(A))` deep-equal to `A`, ignoring `loc`.
3. FOR every source `S` that parses without errors, THE SYSTEM SHALL satisfy `parse(print(parse(S)))` deep-equal to `parse(S)`, ignoring `loc`.

### Requirement 3: AST Validation Gate
**User Story:** As a platform user, I want AI-generated scripts checked before they can run, so that malformed output is never accepted.

#### Acceptance Criteria
1. WHEN an AST arrives from any AI tier, THE SYSTEM SHALL validate it with the Zod schema in `src/core/astValidator.ts` before printing or storing it.
2. IF the AST contains a string literal with `"` or a newline, an unknown property, voice or effect name, a `pass` naming a foreign message, or a `PlaySound.tempo` outside `20..400`, THEN THE SYSTEM SHALL reject it with a reason.

### Requirement 4: Sandboxed, Gas-Limited Execution
**User Story:** As a platform user, I want scripts with bugs or infinite loops to stop safely, so that the browser never freezes and nothing outside the sandbox can run.

#### Acceptance Criteria
1. THE SYSTEM SHALL execute scripts only by interpreting `HexScriptAST` nodes in `src/core/vm.ts` and SHALL NOT use `eval()`, `new Function()`, string timers or dynamic script elements.
2. WHILE a dispatch runs, THE SYSTEM SHALL add 1 to the shared step counter for every evaluated statement node and expression node, plus 1 step per loop iteration, including nested dispatches.
3. IF the step counter exceeds `10,000`, THEN THE SYSTEM SHALL throw `HexVmGasLimitError`, stop the whole dispatch, keep the mutations already applied, and report the object, handler and line.
4. IF a runtime type error, missing part or invalid property/object combination occurs, THEN THE SYSTEM SHALL throw `HexScriptError` with object, handler, line and message, and stop the dispatch.
5. WHEN the abort signal of the dispatch fires, THE SYSTEM SHALL stop at the next statement boundary or suspension point.

### Requirement 5: Language Semantics
**User Story:** As a stack author, I want HyperCard-like semantics for variables, containers and properties, so that classic HyperTalk habits work.

#### Acceptance Criteria
1. WHEN `get`, `answer`, `ask` or `fetch` completes, THE SYSTEM SHALL store its result in the handler-local variable `it`.
2. WHEN a handler declares `global x`, THE SYSTEM SHALL bind `x` to a runtime-wide global for the rest of that handler; globals SHALL NOT be persisted or exported.
3. WHEN a field or card reference is evaluated, THE SYSTEM SHALL resolve it against the current card at that moment; `me` SHALL stay bound to the object owning the handler.
4. WHEN values are compared or computed, THE SYSTEM SHALL follow the value rules of design spec §4.3 (numeric vs case-insensitive string comparison, numeric conversion for arithmetic).
5. IF a property is set or read on an object type it does not apply to (design spec §4.3 property validity), THEN THE SYSTEM SHALL raise `HexScriptError`.
6. WHEN `exit repeat`, `next repeat` or `exit <handler>` executes, THE SYSTEM SHALL leave the innermost loop, continue with its next iteration, or end the handler, respectively.
7. WHEN `go` executes with a pending visual effect, THE SYSTEM SHALL hand the effect to the host for the card change and clear it; THE SYSTEM SHALL discard an unconsumed effect at the end of the dispatch.

### Requirement 6: Sandboxed Network Fetch
**User Story:** As a stack author, I want to pull live JSON data into fields, without shared stacks being able to misuse the network.

#### Acceptance Criteria
1. WHEN `fetch` runs, THE SYSTEM SHALL allow only `https:` URLs (plus `http://localhost` in development builds) and SHALL send a `GET` with `credentials: "omit"`, `referrerPolicy: "no-referrer"` and no script-controlled headers.
2. IF the request exceeds 8 seconds, the body exceeds 256 KB, the body is not JSON, or the JSON path is not found, THEN THE SYSTEM SHALL leave the destination unchanged and set `it` to `"error: <reason>"`.
3. WHEN the request succeeds, THE SYSTEM SHALL evaluate the JSON path syntax of design spec §4.3 and write the result (primitives as strings, objects/arrays as compact JSON) into both the destination and `it`.
