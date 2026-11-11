# Design Document

## Overview
**HexCard Kiro Power: validate, compile, conjure, draw and preview HexCard stacks from a Kiro chat.**

This design implements `requirements.md` of this spec. It adds the power folder `powers/hexcard/` (manifest, MCP configuration, one committed server file, licence files and two skills), the server's TypeScript sources in `src/power/`, two build-time scripts, and a fourth showcase stack that a Kiro chat builds with the power. It adds no persisted field and changes neither schema 2.0.0 nor the HexTalk grammar.

Canonical contracts used without restating them: schema `hexcard_design_spec.md` §2.1, grammar §4.1, AST and parser contract §4.2, VM semantics §4.3, Spellcaster pipeline §4.4, patterns §5.3, codec §5.4, text pipeline §5.5, composition §5.6. Spec 01 design §3 and §6, spec 03 design §2–§6, spec 04 design §4–§7 and spec 06 design (icons, `partRenderer.ts`) stay valid; this design only extends them.

**What comes from Kiro and what does not.** Every statement about how Kiro imports a power, starts its server, names the server and shows tool results comes from finding K1 of `requirements.md` (public Kiro documentation and Agent Plugins 1.0.0). Where K1 is silent, this design treats the behaviour as an expectation for the live import (Requirement 16.1) and depends on none of it: no server name with Kiro's namespace prefix and no install path appears in any file, test or check of this spec. The server reads its own location from `import.meta.url` and nothing else.

**Main choices** (each is argued in §"Design Decisions"):
- The server is one committed, unminified ES module, `powers/hexcard/server/hexcard-mcp.mjs`, built from the repository's sources by `scripts/buildPowerServer.ts` with Vite's `build()` API (no new dependency). `npm run build:power` writes it; a Vitest test rebuilds it in memory and fails when the committed file is stale.
- The server's sources live in a new folder `src/power/`. It holds the protocol handler, the five tools, a 1-bit PNG encoder, a TrueType reader with a pixel-centre rasterizer, and the Node text backend.
- The gate's error list comes from two new listing functions in `stackValidator.ts` and `stackLoader.ts`; `validateStack` and `checkStack` become "first entry of the list", so the first error is the same by construction.
- The Rect tool's pixels move into an exported `plotRectShape` in `paintTools.ts`, which both the paint controller and `draw_layer` call.
- The new showcase stack is `src/presets/powerShowcase.json` (the JSON text the chat validated) loaded by `src/presets/powerShowcase.ts`, and appears in File > Open Showcase Stack as the fourth entry. This design does not set its name; the chat chooses it under Requirement 16.7.
- The headless Chrome check is a committed script, `scripts/checkPowerChrome.ts` (`npm run check:power-chrome`), run by hand and never by `npx vitest --run`.

**Proposed delivery order** (the tasks phase confirms the priority with the user):
1. document changes (Requirement 15; Requirement 15.4 makes this the first task);
2. changes to existing modules: the gate listing, `plotRectShape`, `clearIconCache`;
3. the power package and the server core: `plugin.json`, `mcp.json`, licence files, build script, start check, stdio loop, protocol handler, argument checker, and the tools `validate_stack`, `compile_hextalk` and `conjure_script`;
4. the Node text backend, the PNG encoder, `render_card` and the headless Chrome check;
5. `draw_layer`;
6. the two skills and their tests;
7. the live import, the real-use chat and the showcase stack (Requirement 16, Requirement 17.7);
8. the GitHub import after the developer's push (Requirement 17.9).

## Architecture

~~~mermaid
flowchart LR
  chat[Kiro chat] -- "JSON-RPC 2.0 lines on stdin" --> stdio["stdio.ts: serveLines"]
  stdio -- "answers, one line each" --> chat
  subgraph proc["node --permission (server file only)"]
    main["main.ts: zodJitless first, startCheck, fonts"] --> stdio
    stdio --> protocol["protocol.ts"]
    protocol --> args["argumentCheck.ts"]
    protocol --> tools["tools/*.ts"]
    tools --> gate["stackText.ts: read + gate"]
    gate --> loader["stackLoader.ts listStackErrors"]
    loader --> validator["stackValidator.ts listStackValidationErrors"]
    tools --> parser["parser.ts parseHexTalk / printHexTalk"]
    tools --> spell["spellcaster.ts conjureLocally / handlerHint"]
    tools --> compose["bitmapCanvas.ts composeFrame + partRenderer.ts createPartRasterizer"]
    tools --> paint["paintTools.ts plotRectShape / bresenhamLine + patterns.ts"]
    compose --> text["textRaster.ts renderCrisp1BitText"]
    paint --> text
    text --> backend["nodeTextBackend.ts"]
    backend --> ttf["trueType.ts"]
    tools --> png["png.ts"]
    tools --> rle["rleCodec.ts"]
  end
~~~

- **One process, one file.** Kiro starts `node` with the four `args` of `mcp.json`. Node's permission model lets the process read only the server file; it refuses writes, child processes, worker threads, add-ons and code generation from strings. The server file contains everything else it needs, fonts included.
- **One line at a time.** `serveLines` reads standard input in chunks, splits it at LF, hands each complete line to the protocol handler, awaits the answer and writes it before it looks at the next line (Requirement 4.9). Reading the next chunk waits until the current lines are answered, so memory holds at most one chunk and one partial line.
- **Pure tools.** Every tool is a function of its arguments and the embedded font data. No tool keeps anything from a call: `render_card` clears the compositor's decoded-layer cache and the part renderer's icon cache at the end of every call, and the fonts are parsed once at start-up, before the first line is read (Requirement 5.5).
- **Same code as the studio.** The tools call the studio's gate, parser, printer, Spellcaster, compositor, part renderer, text rasterizer, codec, patterns and paint primitives. Only the text backend differs: the studio draws glyphs with canvas `fillText`, the server with `nodeTextBackend.ts` (Requirement 10).

State placement (nothing is persisted and nothing is undoable):

| State | Owner | Lifetime |
|---|---|---|
| Parsed fonts (cmap, advances, outlines) | `main.ts`, from the embedded bytes | the process; never derived from arguments |
| Zod `jitless` flag | `zodJitless.ts` (Zod's global config) | the process |
| Decoded layers, decoded icons | `bitmapCanvas.ts`, `partRenderer.ts` caches | one `render_card` call, cleared in `finally` |
| Partial input line | `serveLines` | until its LF or until standard input ends |

Module layout (new files; `[07]` in `structure.md`):

~~~text
powers/hexcard/                       # the power (Agent Plugins 1.0.0)
├── plugin.json
├── mcp.json
├── LICENSE                           # copy of the repository's LICENSE (MIT)
├── licenses/                         # third-party and font licence texts
│   ├── zod-LICENSE.txt
│   ├── PixelOperator-CC0-1.0.txt
│   └── FairfaxSerif-OFL-1.1.txt
├── server/
│   └── hexcard-mcp.mjs               # GENERATED by scripts/buildPowerServer.ts, never hand-edited
└── skills/
    ├── author-hexcard-stack/
    │   ├── SKILL.md
    │   └── references/
    │       ├── schema.md             # design spec §2.1 verbatim
    │       ├── patterns.md           # the 38 patterns
    │       └── fonts.md              # font files, the settings that select them, covered characters
    └── write-hextalk/
        ├── SKILL.md
        └── references/
            └── grammar.md            # design spec §4.1 verbatim
scripts/
├── buildPowerServer.ts               # bundles src/power/main.ts, writes the server file and licence files
└── checkPowerChrome.ts               # headless Chrome check of Requirements 10.3 and 17.6
src/power/
├── main.ts                           # server entry
├── zodJitless.ts                     # first import of main.ts: z.config({ jitless: true })
├── startCheck.ts                     # Requirement 2.7 permission probes
├── stdio.ts                          # line splitting, 32 MiB limit, serial answers
├── protocol.ts                       # JSON-RPC 2.0 / MCP handler
├── argumentCheck.ts                  # checks arguments against a tool's inputSchema
├── results.ts                        # result shapes, list cap, quoting
├── stackText.ts                      # reads stack text and runs the gate
├── tools/
│   ├── index.ts                      # createPowerTools
│   ├── validateStack.ts
│   ├── compileHexTalk.ts
│   ├── conjureScript.ts
│   ├── renderCard.ts
│   └── drawLayer.ts
├── png.ts                            # 1-bit indexed PNG encoder
├── trueType.ts                       # TrueType reader and pixel-centre rasterizer
├── nodeTextBackend.ts                # TextRasterBackend for Node; covered characters
└── fontBytes.ts                      # the bundled font files as bytes (import.meta.glob ?inline)
src/presets/
├── powerShowcase.ts                  # the fourth showcase stack's loader
└── powerShowcase.json                # its JSON text, as the chat validated it
~~~

## Components and Interfaces

### Power package (`powers/hexcard/`)

#### `plugin.json` (Requirements 1.2–1.5)
~~~json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "hexcard",
  "version": "0.1.0",
  "description": "Validates, compiles, conjures, draws and previews HexCard stacks with HexCard's own code; needs Node.js 22.13 or later, except 23.0 to 23.4.",
  "author": { "name": "Tugay Öztürk" },
  "keywords": ["hexcard", "hextalk", "hexstack", "hypercard"],
  "repository": "https://github.com/hadbilen/hexcard-resurrection",
  "license": "MIT"
}
~~~
- `version` is the `version` of `package.json` (today `0.1.0`); a test compares them (Requirement 1.3).
- `author.name` is the copyright holder of `LICENSE` (`Copyright (c) 2026 Tugay Öztürk`); a test reads it from that line.
- The description is 140 characters of printable ASCII. Its only `.` before the end are inside `Node.js`, `22.13`, `23.0` and `23.4`, so none is followed by a space (Requirement 1.5).

#### `mcp.json` (Requirements 2.1–2.3)
~~~json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "hexcard": {
      "type": "stdio",
      "command": "node",
      "args": [
        "--permission",
        "--allow-fs-read=${PLUGIN_ROOT}/server/hexcard-mcp.mjs",
        "--disallow-code-generation-from-strings",
        "${PLUGIN_ROOT}/server/hexcard-mcp.mjs"
      ]
    }
  }
}
~~~
- No `cwd` and no `env`. `${PLUGIN_ROOT}` is the only `${...}` text. The server file text `${PLUGIN_ROOT}/server/hexcard-mcp.mjs` is exported by the build script as `SERVER_FILE_ARG`, and the tests compare both `args` entries with it.
- The server file ends in `.mjs`, so Node loads it as an ES module from its extension alone and never looks for a `package.json` (which the permission model would not let it read).
- Tool names with Kiro's server prefix must stay within 64 characters (K1). The longest tool name, `compile_hextalk`, has 15 characters, so any prefix of up to 49 characters fits. The design does not assume what the prefix is.

#### Server file `server/hexcard-mcp.mjs` (Requirement 3)
- Built from `src/power/main.ts`. It is not minified, so a reviewer can read it, and it starts with the banner `// GENERATED by scripts/buildPowerServer.ts from the HexCard sources. Do not edit; run npm run build:power.`
- Its static imports are exactly `node:url` (`fileURLToPath`), `node:path` (`dirname`, `parse`) and `node:zlib` (`deflateSync`, `crc32`). Zod and every HexCard module are inlined. The nine font files are inlined as `data:font/ttf;base64,...` strings by Vite's `?inline` asset handling.
- `zlib.crc32` exists from Node.js 22.2.0, so every Node release that accepts `--permission` has it (Requirement 2.4). The other globals it uses (`TextEncoder`, `TextDecoder`, `Blob`, `Response`, `CompressionStream`, `DecompressionStream`, `atob`, `btoa`, `process`) exist in Node.js 22.13.0 without options.
- Size estimate: about 1 MB, of which about 280 KB are the Base64 fonts (the nine files total about 205 KB).

#### Licence files (Requirement 1.7)
| File | Text | Source the build script copies |
|---|---|---|
| `LICENSE` | HexCard's MIT licence | the repository's `LICENSE`, unchanged |
| `licenses/zod-LICENSE.txt` | Zod's MIT licence and copyright notice | `node_modules/zod/LICENSE`, unchanged |
| `licenses/PixelOperator-CC0-1.0.txt` | CC0 1.0 legal code | the lines inside the fenced block under `## Pixel Operator: Creative Commons Zero 1.0 Universal` in `public/fonts/LICENSES.md` |
| `licenses/FairfaxSerif-OFL-1.1.txt` | OFL-1.1 with the Kreative Software copyright notice | the lines inside the fenced block under `## Fairfax Serif: SIL Open Font License 1.1` in the same file |

The build script also derives the list of bundled third-party packages from the bundle's module ids (every `/node_modules/<package>/` segment; today only `zod`) and fails when a package has no entry in its licence table, so a new dependency cannot enter the server file without its licence.

### Build script (`scripts/buildPowerServer.ts`)
~~~typescript
/** `${PLUGIN_ROOT}/server/hexcard-mcp.mjs`, the server file text of mcp.json (Requirement 2.2). */
export const SERVER_FILE_ARG = "${PLUGIN_ROOT}/server/hexcard-mcp.mjs";
/** Absolute paths, from this script's import.meta.url. Never written into the output. */
export const POWER_DIR: string;
export const SERVER_FILE_PATH: string;
/** Build command named in the staleness failure message (Requirement 3.5). */
export const BUILD_POWER_COMMAND = "npm run build:power";

export interface PowerBuild {
  /** The server file text. */
  serverFile: string;
  /** Packages under node_modules whose code is in the bundle, sorted (today ["zod"]). */
  bundledPackages: string[];
  /** Licence file path relative to POWER_DIR -> text (Requirement 1.7). */
  licenceFiles: Record<string, string>;
}
/** Builds in memory. Writes nothing. */
export function buildPowerServer(): Promise<PowerBuild>;
/** `npm run build:power`: writes the server file and the licence files. `--check`: exits 1 if any differs. */
export function main(argv: readonly string[]): Promise<void>;
~~~
`buildPowerServer` calls Vite's `build()` with an inline configuration:
~~~typescript
await build({
  configFile: false, envFile: false, root: REPO_ROOT, mode: "production", base: "/",
  logLevel: "silent", publicDir: false,
  build: {
    write: false, ssr: "src/power/main.ts", target: "node22", minify: false, sourcemap: false,
    rolldownOptions: { output: { format: "es", entryFileNames: "hexcard-mcp.mjs", codeSplitting: false, banner: BANNER } },
  },
  ssr: { noExternal: true, target: "node" },
});
~~~
- `ssr.noExternal: true` inlines Zod. Node built-ins stay as `node:` imports.
- A trial build of `checkStack`, Zod and one font with these options (run while writing this design) gave one chunk, `node:url` as the only import, the font as a `data:` URL, no absolute path, no `process.env` and no `//#region` comments. The build script still fails if the output has more than one chunk, contains the repository's absolute root path, or contains `file://`.
- `package.json` gains `"build:power"` with the same `runnerImport` form as `build:preset-art`:
  `node --input-type=module -e "import { runnerImport } from 'vite'; const { module } = await runnerImport('./scripts/buildPowerServer.ts'); await module.main(process.argv.slice(1));" --`
- `build`, `build:player`, `vite.config.ts`, `vite.player.config.ts` and `.github/workflows/deploy.yml` are unchanged, so `npm run build` neither builds nor copies the server file (Requirement 3.6). The deploy workflow's `npm test` runs the staleness test, so a stale server file stops a deployment.
- Every later change to a module that the server bundles (for example `parser.ts`) needs `npm run build:power` in the same change; the staleness test reports it.

### New modules (`src/power/`)
Modules that use Node APIs start with `/// <reference types="node" />`, as `presets.test.ts` does. None imports React or a DOM API.

#### `main.ts`
~~~typescript
import "./zodJitless.ts";              // must stay the first import (see zodJitless.ts)
import { fileURLToPath } from "node:url";
import pluginJson from "../../powers/hexcard/plugin.json?raw";

const serverFile = fileURLToPath(import.meta.url);
const failure = startCheckFailure(process.permission, serverFile);
if (failure !== undefined) {
  process.stderr.write(`hexcard: refusing to start: ${failure}. Start the server with the command line of mcp.json.\n`);
  process.exitCode = 1;                // standard input is never read, nothing goes to standard output
} else {
  let fonts: ParsedFaces | undefined;
  try {
    fonts = parseFaces(bundledFontBytes());
  } catch (error) {
    process.stderr.write(`hexcard: refusing to start: the embedded fonts could not be read (${messageOf(error)}).\n`);
    process.exitCode = 1;
  }
  if (fonts !== undefined) {
    const tools = createPowerTools({ fonts });
    const handler = createProtocolHandler({ tools, serverVersion: JSON.parse(pluginJson).version });
    await serveLines(process.stdin, process.stdout, handler);
  }
}
~~~
- The version comes from `plugin.json` itself (inlined as text), so `serverInfo.version` cannot drift from the manifest (Requirement 4.2).
- When standard input ends, `serveLines` resolves and nothing keeps the event loop alive, so the process exits with status 0 right after its last answer is flushed (Requirement 4.10).

#### `zodJitless.ts` (Requirement 3.3)
~~~typescript
import { z } from "zod";
z.config({ jitless: true });
~~~
Zod 4 decides at schema construction whether an object schema may use its code-generating fast path: the constructor reads `globalConfig.jitless` and probes `new Function("")` once (`node_modules/zod/v4/core/schemas.js`, `$ZodObjectJIT`; `util.allowsEval`). `stackValidator.ts` and `astValidator.ts` build their schemas at module evaluation. In the bundle, modules evaluate in import order, so this module must be the first import of `main.ts`: Zod's core evaluates first, then this module sets the flag, then the HexCard modules build their schemas. With the flag set, the probe is skipped too. A test traps the `Function` constructor and checks that loading the server file never calls it (§"Testing Strategy").

#### `startCheck.ts` (Requirement 2.7)
~~~typescript
export interface PermissionApi { has(scope: string, reference?: string): boolean }
/** Why the server must not start, or undefined. `serverFile` comes from import.meta.url. */
export function startCheckFailure(permission: PermissionApi | undefined, serverFile: string): string | undefined;
~~~
Probes, in this order; the first that fails names the reason:

| Probe | Fails when | Reason text |
|---|---|---|
| permission model on | `permission === undefined` | `the permission model is off` |
| no writes | `has("fs.write")`, `has("fs.write", serverFile)`, `has("fs.write", dirname(serverFile))` or `has("fs.write", parse(serverFile).root)` is true | `writing files is allowed` |
| no child processes | `has("child")` | `child processes are allowed` |
| no worker threads | `has("worker")` | `worker threads are allowed` |
| no add-ons, no WASI | `has("addon")` or `has("wasi")` | `native add-ons or WASI are allowed` |
| server folder not readable | `has("fs.read")` or `has("fs.read", dirname(serverFile))` | `reading the server's folder is allowed` |

Measured on Node 24.19.0 for this design, with the start line of `mcp.json`:
- `has("fs.write")` without a reference is true only when every write is allowed (`--allow-fs-write=*`, also through `NODE_OPTIONS`); with `--allow-fs-write=<some folder>` it is false. That is why the probe also names three concrete paths.
- With the plain start line every probe passes: `fs.read` is true only for the server file itself.
- A write grant for an unrelated folder (for example `--allow-fs-write=/var/tmp`) passes all probes. The server file still cannot write there, because it imports no file module (Requirement 3.2).

#### `stdio.ts` (Requirements 4.1, 4.8–4.10)
~~~typescript
export const MAX_LINE_BYTES = 33_554_432;
export interface LineSink { write(text: string): Promise<void> }   // process.stdout adapter waits for "drain"
/** Reads `input` to its end and answers every complete line in order. */
export function serveLines(input: AsyncIterable<Uint8Array>, output: NodeJS.WritableStream | LineSink,
  handler: Pick<ProtocolHandler, "handleLine" | "overflowAnswer">, maxLineBytes?: number): Promise<void>;
~~~
- A line is the bytes before an LF; a CR before the LF stays in the line.
- While no LF is found, the partial line is kept as a list of chunk slices. When it would grow past `maxLineBytes`, the slices are dropped, the reader switches to discard mode until the next LF, and then writes `handler.overflowAnswer()` once (error -32600, id `null`). A line of exactly `maxLineBytes` bytes is a normal line.
- Each answer is written as the JSON text followed by one LF. The next line is handled only after the write resolved.
- At the end of input, the bytes after the last LF are dropped without an answer.

#### `protocol.ts` (Requirement 4)
~~~typescript
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = "2025-11-25";
export interface ProtocolOptions {
  tools: readonly PowerTool[];        // the tests inject a throwing tool here (Requirement 17.1)
  serverVersion: string;
  /** Diagnostics; default writes one line to standard error. */
  log?: (line: string) => void;
}
export interface ProtocolHandler {
  /** The answer's JSON text (no LF), or null for a notification. Never throws. */
  handleLine(line: Uint8Array): Promise<string | null>;
  /** Answer to a line longer than MAX_LINE_BYTES. */
  overflowAnswer(): string;
}
export function createProtocolHandler(options: ProtocolOptions): ProtocolHandler;
~~~
`handleLine` steps:
1. Decode with `new TextDecoder("utf-8", { fatal: true })`. Failure → -32700, id `null`.
2. `JSON.parse`. Failure (the empty line included) → -32700, id `null`.
3. Classify. A request is a plain object with `jsonrpc === "2.0"`, a string `method`, an `id` that is a string or a safe integer (`Number.isSafeInteger`), and `params` absent or a plain object. A notification is the same object without the `id` key. Anything else, a JSON array included, → -32600, id `null`.
4. Notification → `null` (nothing is written).
5. Request by method:

| Method | Answer |
|---|---|
| `initialize` | `{ protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: "hexcard", version } }`; `protocolVersion` is `params.protocolVersion` when it is one of the four supported strings, else `"2025-11-25"`. A repeated `initialize` is answered the same way. |
| `ping` | `{}` |
| `tools/list` | `{ tools: [...] }` in the order `validate_stack`, `compile_hextalk`, `conjure_script`, `render_card`, `draw_layer`; each `{ name, title, description, inputSchema, annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }`. A `cursor` is ignored and no `nextCursor` is sent. |
| `tools/call` | below |
| any other | -32601 |

`tools/call`:
1. `params.name` missing, not a string, or not a listed tool → -32602 (`Invalid params: missing tool name`, `... tool name must be a string`, `... unknown tool`).
2. `arguments` missing → `{}`. Not a plain object → error result `["arguments: must be an object"]`.
3. `tool.checkArguments(arguments)` (default: `checkArguments(tool.inputSchema, arguments)`). Any entry → error result with the entries, without running the tool (Requirements 4.5, 11.10).
4. `await tool.run(arguments)`. A throw that the tool did not turn into a result → error result `["Internal error in <tool>: <message>"]`, where `<message>` is `error.message` (or `String(error)`) passed through `shortenMessage`; the log line is `hexcard: internal error in <tool>` with no message text (Requirement 4.1). The handler then goes on (Requirement 4.10).

Every answer is `JSON.stringify(response)` with U+2028 and U+2029 replaced by `\u2028` and `\u2029`, so no line separator that a client might split on appears raw. The answer keeps the request's `id` value and type. Error objects use fixed messages (`Parse error`, `Invalid Request`, `Method not found`, `Invalid params: ...`) with no text from the line. The server sends no request and no notification of its own (Requirement 4.11).

#### `argumentCheck.ts` (Requirements 4.3, 4.5, 5.3, 11.10)
~~~typescript
/** The JSON Schema subset the inputSchemas use. Unknown keywords are a programming error (the module throws). */
export type ArgSchema =
  | { type: "object"; properties: Record<string, ArgSchema>; required?: string[]; additionalProperties: false; description?: string }
  | { type: "array"; items: ArgSchema; minItems?: number; maxItems?: number; uniqueItems?: boolean; description?: string }
  | { type: "string"; minLength?: number; maxLength?: number; pattern?: string; enum?: string[]; const?: string; default?: string; description?: string }
  | { type: "integer"; minimum?: number; maximum?: number; enum?: number[]; default?: number; description?: string }
  | { type: "boolean"; default?: boolean; description?: string }
  | { anyOf: ArgSchema[]; description?: string }                  // branches of different JSON types
  | { oneOf: ArgSchema[]; description?: string };                 // object branches told apart by a const "op"
export interface CheckOptions { /** Arguments whose maxLength is enforced by the tool as a read error instead. */ readLimited?: readonly string[] }
/** Every broken rule as "<path>: <rule>", in schema order. Empty when the value conforms. */
export function checkArguments(schema: ArgSchema, value: unknown, options?: CheckOptions): string[];
/** "commands[3].rows[1]" from ["commands", 3, "rows", 1]. */
export function formatArgPath(path: readonly (string | number)[]): string;
~~~
- The inputSchema objects of §"Tool input schemas" are both what `tools/list` sends and what this checker interprets, so the listed schema and the enforced rules cannot drift apart.
- Order: for an object, its unknown keys first (in input order, `<path>: is not an allowed argument` at the top level and `... is not an allowed field` below it), then each declared property in schema order (`is required` when missing); for an array, its length rule, then each item in order. An item of a `oneOf` is checked against the branch its `op` names (`<path>.op: must be one of rect, line, sprite, text` when none).
- Messages: `must be a string`, `must be an integer`, `must be a boolean`, `must be an object`, `must be an array`, `must be from 0 to 511`, `must be one of card, background`, `must have at most 65536 characters`, `must have 1 to 64 characters`, `must have 1 to 256 entries`, `must contain only # and .`, `must list each style at most once`, `must be an integer from 1 to 100000 or a string of at most 256 characters`.
- Lengths are counted in UTF-16 code units (`String.prototype.length`, the requirements' Glossary). JSON Schema's own `maxLength` counts code points, so the descriptions say "characters (UTF-16 code units)". For text outside the Basic Multilingual Plane the server is the stricter of the two.
- An unknown key is text from the arguments, so it is shortened with `quoteText` where the error path is built; every other part of a checker message is fixed text, so the message meets Requirement 5.7 without `shortenMessage`.

#### `results.ts` (Requirements 5.6, 5.7)
~~~typescript
export const LIST_LIMIT = 100;
export const QUOTE_LIMIT = 80;
/** Requirement 5.7 for text the tool quotes itself: whole when <= 80 characters, else the first 77 + "...". */
export function quoteText(text: string): string;
/**
 * Requirement 5.7 for messages other than gate errors that embed argument text (read errors, parser
 * messages, refusal reasons, thrown errors): (1) the inner text of every "..." pair longer than 80
 * characters becomes quoteText(inner); (2) then every run of more than 80 characters without white
 * space or '"' becomes quoteText(run). The other text is unchanged.
 */
export function shortenMessage(message: string): string;
/** Requirements 5.7 and 6.4 for gate errors: formatGateError(error, quoteText). */
export function shortenGateError(error: GateError): string;
/** `{ [key]: first 100 items, [key + "NotShown"]: rest }`; the count key only when items > 100. */
export function cappedList<T>(key: string, items: readonly T[]): Record<string, T[] | number>;
export type ToolContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: "image/png" };
export interface CallToolResult { content: ToolContent[]; isError: boolean }
export function toolResult(payload: Record<string, unknown>, png?: Uint8Array): CallToolResult;  // isError false
export function errorResult(errors: readonly string[]): CallToolResult;                          // { ok: false, errors, errorsNotShown? }, isError true
~~~
- The JSON text is `JSON.stringify(payload)` (compact, fixed key order), so the same payload always gives the same text (Requirements 9.7, 11.11).
- Rule (2) works because no fixed text of a parser message or refusal reason has a word of more than 80 characters; any such run in a message is copied from the arguments (an identifier, a number literal).
- `shortenGateError` changes only the texts the gate error takes from the stack: each string path key and each `fromValue` piece longer than 80 characters becomes `quoteText` of it, and every other character is copied (D14). Fixed path names such as `bgFieldContents` are never longer than 80 characters, so `quoteText` leaves them whole.
- Tool products (canonical form, handler names, conjured HexTalk, `.hexstack` text, `rleData`) never pass through these functions.

#### `stackText.ts` (Requirements 5.2, 5.3, 6.1, 6.2, 9.1)
~~~typescript
export const MAX_STACK_TEXT = 4_194_304;
export type GateOutcome =
  | { kind: "readError"; error: string }        // "stack: <message>"
  | { kind: "checkError"; error: string }       // "stack: The stack could not be checked: <message>" (Requirement 5.4)
  | { kind: "rejected"; errors: GateError[] }   // raw gate errors, in gate order
  | { kind: "accepted"; stack: HexStack };      // the stack checkStack would return
export function readAndGate(stackText: string, steps: Pick<ToolSteps, "listStackErrors">): Promise<GateOutcome>;
~~~
1. `stackText.length > MAX_STACK_TEXT` → `stack: The stack text has more than 4194304 characters`.
2. Trimmed with `String.prototype.trim`. When the original's first non-white-space character is `{`: `JSON.parse(trimmed)`; a throw → `stack: The stack is not valid JSON: <error message>`. V8's JSON messages quote at most about ten characters of the input (checked on Node 24.19.0: `Unexpected token 'x', "{"a": xzzzzzzzzz"... is not valid JSON`); `shortenMessage` still applies.
3. Otherwise `decodeStackPayload(trimmed, MAX_STACK_TEXT)`; a throw → `stack: <error message>` (for example `stack: The data is not valid Base64URL`). The empty and all-white-space texts go this way and fail as deflate-raw.
4. `steps.listStackErrors(value)`; a throw → `checkError` (Requirement 5.4). An empty list → `accepted` with the report's stack; else `rejected`.

Both stack tools turn `readError` and `checkError` into `errorResult([shortenMessage(error)])`, and write each `rejected` error as `shortenGateError(error)`.

#### `tools/index.ts`
~~~typescript
export type ToolName = "validate_stack" | "compile_hextalk" | "conjure_script" | "render_card" | "draw_layer";
export interface PowerTool {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: Extract<ArgSchema, { type: "object" }>;
  checkArguments?(args: Record<string, unknown>): string[];
  run(args: Record<string, unknown>): Promise<CallToolResult>;
}
/** The steps of Requirement 5.4; the tests replace them with throwing doubles. */
export interface ToolSteps {
  listStackErrors: typeof listStackErrors;        // stackLoader.ts
  parseHexTalk: typeof parseHexTalk;              // parser.ts
  checkDrawCommands: typeof checkDrawCommands;    // tools/drawLayer.ts
}
export interface ToolDeps { fonts: ParsedFaces; steps?: Partial<ToolSteps> }
export function createPowerTools(deps: ToolDeps): readonly PowerTool[];
~~~
Titles: `Validate HexCard stack`, `Compile HexTalk`, `Conjure HexTalk`, `Render HexCard card`, `Draw HexCard layer`. Descriptions are printable ASCII, under 2,000 characters each, and state what the tool returns, its limits, that it reads no file or URL and runs no script. The `render_card` description also states the limit of Requirement 10.4: the pixel match with the studio holds only for covered characters, was measured only in headless Chrome 157 on Linux, and other browsers and operating systems were not checked.

#### `tools/validateStack.ts` (Requirement 6)
1. `readAndGate(stack)`. `readError` or `checkError` → `errorResult([shortenMessage(error)])`. `rejected` → `toolResult({ ok: false, ...cappedList("errors", errors.map(shortenGateError)) })` (a normal result, Requirement 6.3).
2. `accepted`:
   - **script errors:** for every `scriptSource` in the order stack, each background then its parts, each card then its parts, `steps.parseHexTalk(source).errors` become `<path> line L, column C: <shortenMessage(message)>`. A throw → `errorResult(["stack: A script in the stack could not be compiled: <message>"])`.
   - **notes:** for every layer, backgrounds before cards, `encodeBitmapRLE(decodeBitmapRLE(rleData)) !== rleData` → `<path>: this rleData decodes but is not canonical; replace it with draw_layer output or ""`. `""` is canonical.
   - **stack:** `{ name: quoteText(stack.name), cards, backgrounds }`.
   - **hexstack** (only when `hexstack` is true): `await encodeStackFile(stack)`.

#### `tools/compileHexTalk.ts` (Requirement 7)
`steps.parseHexTalk(source)` on the untouched `source` (a throw → `errorResult(["source: The script could not be compiled: <message>"])`).
- `handlers` = `Object.values(ast.handlers).map((h) => h.eventName)`. The parser inserts handlers in source order and handler names start with a letter, so the object's key order is source order.
- With errors: `{ ok: false, ...cappedList("compileErrors", errors.map((e) => ({ line, column, message: shortenMessage(message) }))), handlers, notes: [] }`.
- Without errors: `{ ok: true, canonical: printHexTalk(ast), handlers, notes }`, where `notes` is `["The script has no handlers."]` when `handlers` is empty and `[]` otherwise.

#### `tools/conjureScript.ts` (Requirement 8)
`conjureLocally(prompt, { objectKind: objectKind ?? "button" })`:
- accepted → `{ ok: true, hexTalk, notes: hint === undefined ? [] : [hint] }` with `hint = handlerHint(ast, objectKind)`;
- refused → `{ ok: false, reason: shortenMessage(reason), suggestions: suggestions.map((s) => s.prompt) }`.

The studio's Spellcaster tab shows, for an object with an empty script, `mergeSpell("", ast).source`; `mergeSpell` returns `acceptAst(spell).hexTalk` for a blank script, which is the `hexTalk` that `conjureLocally` returned (Requirement 8.4). Only Tier 1 is reachable: the tool imports `conjureLocally`, not `conjureScript`.

#### `tools/renderCard.ts` (Requirements 9, 10)
1. `readAndGate(stack)`; `readError`, `checkError` or `rejected` → `errorResult` with the same entries, in the same order, that `validate_stack` would return, capped (Requirement 9.1).
2. Card selection (Requirement 9.2): no `card` → `cards[0]`; an integer n → `cards[n - 1]`; a string → the card whose `id === card`, else the first whose `name.toLowerCase() === card.toLowerCase()`. No match → `errorResult(["card: no card matches <selector>; the stack has <N> cards"])`, the selector as `7` or `"quoteText(card)"`.
3. `frame = composeFrame(stack, card.id, {}, createPartRasterizer({ textBackend }))`: no editing, no pressed part, no found text, every scroll offset 0, no script run (Requirement 9.3).
4. `png = encodeFramePng(frame, scale, stack.themePalette)`.
5. `toolResult(summary, png)`: text content first, then `{ type: "image", data: base64(png), mimeType: "image/png" }` (Requirement 9.4). The summary is in §"Data Models".
6. `finally { clearDecodedLayerCache(); clearIconCache(); }`, also after an error result (Requirement 5.5).

Uncovered characters (Requirements 9.5, 10.5) are collected per visible part in drawing order (background parts, then card parts):
- a button with `showName` true: its `title` in the button face, `cssFontString(BUTTON_TEXT.font, BUTTON_TEXT.size, false)`;
- a field: `readFieldText(stack, card.id, part.layerScope, part.id)` in `cssFontString(part.textFont, part.textSize, part.textStyle.includes("bold"))`, the same string `layoutFieldText` builds.
Hard line breaks (`\r\n`, `\r`, `\n`) are left out, because the layout splits at them and never draws them.

#### `tools/drawLayer.ts` (Requirement 11)
~~~typescript
export type DrawCommand =
  | { op: "rect"; x: number; y: number; width: number; height: number; pattern?: number; filled?: boolean }
  | { op: "line"; x1: number; y1: number; x2: number; y2: number; pattern?: number }
  | { op: "sprite"; x: number; y: number; rows: string[] }
  | { op: "text"; x: number; y: number; text: string; width?: number; height?: number; font?: LogicalFont;
      size?: TextSize; style?: TextStyle[]; align?: TextAlign; wrap?: boolean; ink?: "dark" | "light" };
/** The rules of Requirement 11.10 that the inputSchema cannot express, for commands that passed it. */
export function checkDrawCommands(commands: readonly DrawCommand[]): string[];
/** Draws on the base of `layer` in list order. Pure; text goes through createNodeTextBackend(faces). */
export function drawCommands(layer: HexLayer, commands: readonly DrawCommand[], faces: ParsedFaces):
  { pixels: Uint8Array; notes: string[]; uncovered: { path: string; character: string }[] };
~~~
Argument check (`PowerTool.checkArguments`): `layer` and the `commands` array with the generic checker; then for each command in order, its schema branch, and, when that passed, `steps.checkDrawCommands` for that command; finally the total of every `rows` entry and `text` value against 65,536 (`commands: the sprite rows and texts have N characters in all, more than 65536`). A throw of `checkDrawCommands` → `errorResult(["commands: The drawing commands could not be checked: <message>"])`.

`checkDrawCommands` rules:
- `rect`: `x + width <= 512` and `y + height <= 342` (`commands[i]: the rectangle must lie inside the 512 x 342 layer`);
- `sprite`: every row as long as `rows[0]` (`commands[i].rows[j]: must have the same length as rows[0] (N characters)`), `x + rows[0].length <= 512`, `y + rows.length <= 342`;
- `text`: with the defaults `width = 512 - x`, `height = 342 - y`, `x + width <= 512` and `y + height <= 342`.

Drawing, starting from `new Uint8Array(175_104).fill(layer === "card" ? 0 : 1)`:
- `rect`: `plotRectShape(x, y, x + width - 1, y + height - 1, filled ?? false, plot)` with `plot = (px, py) => pixels[py * 512 + px] = patternState(PATTERNS[pattern ?? 1], px, py)`;
- `line`: `bresenhamLine(x1, y1, x2, y2, plot)`, same `plot`;
- `sprite`: `#` → 2, `.` → 1 at `(x + column, y + row)`;
- `text`: `renderCrisp1BitText(text, font ?? "Sans", size ?? 12, style ?? [], { x, y, width, height }, align ?? "left", wrap ?? true, backend)`; every mask value 2 sets the pixel to 2 (`ink` `dark`) or 1 (`ink` `light`). Its uncovered characters are `uncoveredCharacters(faces, text, cssFontString(font, size, style.includes("bold")))`, each listed with the path `commands[i]` (Requirement 10.5).

Notes for text that does not fit (Requirement 11.9), from the returned `lineBoxes` (their `width` is "the drawn text after styles"): a box with `width >= 1` does not fit when `width > box width` or `(lineBox.y - y) + lineBox.height > height`. One note per command with at least one such line: `commands[i]: 1 line of the text does not fit in its box` or `... N lines of the text do not fit in its box`, followed by `; make the box larger, the text shorter or the size smaller`.

Result: `rleData = pixels equal the base everywhere ? "" : encodeBitmapRLE(pixels)`, with `lightPixels` and `darkPixels` counted over all 175,104 pixels (Requirements 11.7, 11.8). For a card layer `encodeBitmapRLE` of the base is already `""`; for a background layer the base would encode to a non-empty string, so the equality check is what gives `""`. Both are canonical: `encodeBitmapRLE(decodeBitmapRLE(""))` is `""`, and a non-empty `rleData` decodes without using the empty fill.

#### `png.ts` (Requirement 9.4)
~~~typescript
/** Indexed-colour PNG, bit depth 1, palette [light, dark], no interlace, chunks IHDR PLTE IDAT IEND only. */
export function encodeFramePng(frame: Uint8Array, scale: 1 | 2, palette: { lightBitHex: string; darkBitHex: string }): Uint8Array;
~~~
- IHDR: width 512k, height 342k, bit depth 1, colour type 3, compression 0, filter 0, interlace 0.
- PLTE: entry 0 = `lightBitHex`, entry 1 = `darkBitHex`, hex digits read case-insensitively.
- Image data: each output row is a filter byte 0 and 64k bytes; frame pixel (x, y) fills the k x k block from (kx, ky), bit 0 for state 1 and bit 1 for state 2, most significant bit first. The whole stream goes through `zlib.deflateSync(raw, { level: 9 })` in one IDAT chunk. Chunk CRCs come from `zlib.crc32`.
- Same frame, scale and palette give the same bytes on the same Node binary, which Requirement 9.7 needs. Another Node release may bundle another zlib and compress differently; the pixels stay the same.
- A frame state other than 1 or 2 throws (a programming error).

#### `trueType.ts` (Requirement 10.1)
~~~typescript
export class TrueTypeError extends Error {}
export interface GlyphOutline { /** Closed polygons in font units (y up): [x0, y0, x1, y1, ...]. */ contours: readonly Float64Array[] }
export interface TrueTypeFont {
  readonly unitsPerEm: number;
  readonly numGlyphs: number;
  /** Code point -> glyph id from the chosen Unicode subtable; unmapped code points are absent. */
  readonly cmap: ReadonlyMap<number, number>;
  /** hmtx advance width in font units; glyphs at or after numberOfHMetrics use the last entry. */
  advance(glyph: number): number;
  /** Composites resolved. Glyph 0 is .notdef. */
  outline(glyph: number): GlyphOutline;
}
/** Parses every glyph eagerly. Throws TrueTypeError on anything outside the subset below. */
export function parseTrueType(bytes: Uint8Array): TrueTypeFont;
/** Nonzero-winding fill sampled at pixel centres; sets alpha 255 inside, leaves other pixels. */
export function fillOutline(alpha: Uint8Array, width: number, height: number, outline: GlyphOutline,
  scale: number, originX: number, baselineY: number): void;
~~~
Tables read:
- table directory (sfnt version `0x00010000` or `true`); `head` (`unitsPerEm` at 18, `indexToLocFormat` at 50), `maxp` (`numGlyphs` at 4), `hhea` (`numberOfHMetrics` at 34), `hmtx`, `loca` (short offsets x 2, or long), `glyf`, `cmap`.
- `cmap`: the first subtable present in fontTools' `getBestCmap` order, (3,10), (0,6), (0,4), (3,1), (0,3), (0,2), (0,1), (0,0), among formats 4 and 12. That is the order the coverage measurement of the requirements used.
- simple glyphs: `endPtsOfContours`, instructions skipped, flags with repeat counts, short and long coordinate deltas. A point without the on-curve flag throws `TrueTypeError` (quadratic curves are not drawn).
- composite glyphs: `ARG_1_AND_2_ARE_WORDS`, `ARGS_ARE_XY_VALUES` (required; point matching throws), `WE_HAVE_A_SCALE`, `WE_HAVE_AN_X_AND_Y_SCALE`, `WE_HAVE_A_TWO_BY_TWO` (F2Dot14), `MORE_COMPONENTS`, `WE_HAVE_INSTRUCTIONS` (skipped). The offset is added after the transform unless `SCALED_COMPONENT_OFFSET` is set. `ROUND_XY_TO_GRID` is not applied (see the measurements). Nesting deeper than 8 levels throws.

Measured with fontTools on the nine files for this design:
- no glyph has an off-curve point;
- Pixel Operator files have 30 to 95 composite glyphs each, Fairfax Serif none. Their component flags are only `ARG_1_AND_2_ARE_WORDS`, `ARGS_ARE_XY_VALUES`, `ROUND_XY_TO_GRID`, `WE_HAVE_A_SCALE` and `UNSCALED_COMPONENT_OFFSET`. Two components per file use a scale of -1 (`exclamdown` and `questiondown` turn `exclam` and `question` by 180 degrees). Some composites nest another composite (in `PixelOperator.ttf` seven, which use `tilde` or `quotedblright`);
- every component offset is a multiple of 100 font units. Every face is drawn at 1x or 2x of its native size, where one pixel is 100 or 50 font units, so every offset is a whole number of pixels and rounding it to the grid changes nothing;
- the Mono files have `numberOfHMetrics` 4, so the advance rule for later glyphs matters;
- the Unicode subtables of each file map the same code points ((3,1,4) everywhere; (0,3,4) in Pixel Operator; (0,3,12) in Fairfax Serif);
- every outline edge is horizontal or vertical, except one edge in each of five files (`J` in `PixelOperatorMono.ttf`, `PixelOperatorMono-Bold.ttf` and `PixelOperatorMono8.ttf`; U+20B7 in `PixelOperator8-Bold.ttf` and `PixelOperatorMono8-Bold.ttf`) that rises 4 font units (at most 0.08 px at the sizes used).

Rasterization (`fillOutline`): a point (gx, gy) maps to (`originX + gx * scale`, `baselineY - gy * scale`). For each pixel row y, the sample line is `y + 0.5`. An edge from (x0, y0) to (x1, y1) with y0 ≠ y1 crosses it when `min(y0, y1) <= y + 0.5 < max(y0, y1)`, with direction +1 when y1 > y0 and -1 otherwise, at `x = x0 + (y + 0.5 - y0) * (x1 - x0) / (y1 - y0)`. Pixel (x, y) is inside when the sum of the directions of the crossings left of `x + 0.5` (strictly smaller) is not zero. Each glyph is filled on its own and the results are united, as overlapping glyph masks are in a canvas.

Why this equals Chrome after the `alpha >= 128` threshold: with the measurements above, every vertex lies on the pixel grid or within 0.08 px of it, the pen and the baseline are whole pixels (whole-pixel advances, integer `x` and baseline from `renderCrisp1BitText`), and the only sloped edges stay within one tenth of a pixel of a grid line. A pixel is then covered completely or not at all, except where an edge lies 0.02 to 0.08 px off the grid, where it is covered to at least 92 % or at most 8 %. Coverage of at least 50 % (alpha >= 128) and "the centre is inside" therefore agree for every pixel, and no sample point ever lies on an edge, so the tie rule is never used. The requirements' measurement saw the same result in 4,724 of 4,728 Chrome cases; the other four contain U+00AD, which Requirement 10.2 handles.

#### `nodeTextBackend.ts` (Requirements 10.1, 10.2, 10.5, 10.6, 14.1)
~~~typescript
export type FontBytes = Readonly<Record<FontFileName, Uint8Array>>;
export interface ParsedFaces { readonly fonts: ReadonlyMap<FontFileName, TrueTypeFont> }
export function parseFaces(bytes: FontBytes): ParsedFaces;
/** The face of a cssFontString() value: the FONT_FILES entry whose family it names, and its px size. */
export function faceOf(cssFont: string): { file: FontFileName; renderSize: number };
export function createNodeTextBackend(faces: ParsedFaces): TextRasterBackend;   // measureText and drawText only
/** Covered characters of a font file (Glossary): its cmap plus U+0009, U+000B, U+000C, U+00AD, U+200B. */
export function coveredCodePoints(faces: ParsedFaces, file: FontFileName): ReadonlySet<number>;
/** Distinct uncovered characters of `text` in `cssFont`, in order of first occurrence, as "U+XXXX". */
export function uncoveredCharacters(faces: ParsedFaces, text: string, cssFont: string): string[];
~~~
- `faceOf` parses `<n>px "<family>", <generic>` and finds the family in `FONT_FILES`. It is the only way the backend and the coverage helpers pick a file, so the logical-font-to-face mapping stays in `TEXT_SIZE_TABLE` and `cssFontString` (Requirement 14.1). An unknown family throws.
- Per code point (a surrogate pair is one code point; a lone surrogate counts as its own code unit): U+0009, U+000B and U+000C use the space glyph and advance; U+00AD and U+200B draw nothing and advance 0; a mapped code point uses its glyph and `advance(glyph) * renderSize / unitsPerEm`, unrounded; an unmapped one uses glyph 0 (`.notdef`) and its advance.
- `measureText` is the exact sum of the advances. `drawText` allocates `width * height` alpha values, fills each glyph at pen `x + (advances before it)` and `baseline`, and returns the array.
- `uncoveredCharacters` drops hard line breaks first and writes code points as `U+` with at least four uppercase hex digits.

#### `fontBytes.ts` (Requirement 3.1)
~~~typescript
/** Every file tableFontFiles() names, as bytes. Throws if one is missing or not a base64 data: URL. */
export function bundledFontBytes(): FontBytes;
~~~
It uses `import.meta.glob("../../public/fonts/*.ttf", { query: "?inline", import: "default", eager: true })`, the pattern `src/player/main.ts` and `textRaster.test.ts` already use, and decodes each `data:font/ttf;base64,` URL with `atob`. The same code runs in Vitest and inside the server file.

### Tool input schemas
All have `type: "object"`, `additionalProperties: false`, and a `description` on every property that repeats its limit and default.

| Tool | Property | Schema | Required |
|---|---|---|---|
| `validate_stack` | `stack` | string, `maxLength` 4194304 (over it: a read error, `readLimited`) | yes |
| | `hexstack` | boolean, `default` false | no |
| `compile_hextalk` | `source` | string, `maxLength` 65536 | yes |
| `conjure_script` | `prompt` | string, `maxLength` 600 | yes |
| | `objectKind` | string, `enum` button, field, card, background, stack, `default` button | no |
| `render_card` | `stack` | as `validate_stack` | yes |
| | `card` | `anyOf`: integer 1..100000, string `maxLength` 256; omitted = the first card | no |
| | `scale` | integer, `enum` [1, 2], `default` 1 | no |
| `draw_layer` | `layer` | string, `enum` card, background | yes |
| | `commands` | array, `minItems` 1, `maxItems` 256, `items` `oneOf` the four commands | yes |

Drawing commands (every coordinate is an integer):

| `op` | Required fields | Optional fields (default) |
|---|---|---|
| `rect` | `op` (const), `x` 0..511, `y` 0..341, `width` 1..512, `height` 1..342 | `pattern` 0..37 (1), `filled` boolean (false) |
| `line` | `op`, `x1` 0..511, `y1` 0..341, `x2` 0..511, `y2` 0..341 | `pattern` 0..37 (1) |
| `sprite` | `op`, `x` 0..511, `y` 0..341, `rows`: array of 1..64 strings, each 1..64 characters, `pattern` `^[#.]+$` | |
| `text` | `op`, `x` 0..511, `y` 0..341, `text`: string of 1..256 characters | `width` 1..512 (512 - x), `height` 1..342 (342 - y), `font` System, Sans, Mono, Serif (Sans), `size` 9, 10, 12, 14, 18, 24 (12), `style` array of bold, italic, underline, outline, shadow, condense with `uniqueItems` ([]), `align` left, center, right (left), `wrap` boolean (true), `ink` dark, light (dark) |

The defaults that depend on another field (`width`, `height`, the first card) are stated in the descriptions, not as `default`.

### Changes to existing modules

| Module (owner) | Change |
|---|---|
| `src/core/stackValidator.ts` (01; changed by 06) | New `listStackValidationErrors` and `formatGateError`. `validateStack` returns its first entry, formatted. The structural checks become collectors (below). |
| `src/storage/stackLoader.ts` (04) | New `listStackErrors`. `checkStack` returns its first entry. |
| `src/engine/graphics/paintTools.ts` (03) | New exported `plotRectShape`; the Rect branch of the controller's `drawShape` calls it. |
| `src/engine/graphics/partRenderer.ts` (03; changed by 06) | New exported `clearIconCache()`, which empties the module-level `iconCache`. |
| `src/presets/index.ts` (04) | A fourth `SHOWCASE_STACKS` entry (task of Requirement 16). |

Tests changed:
- `src/presets/__tests__/presets.test.ts` (Requirement 16.8, below).
- `src/core/__tests__/parser.roundtrip.test.ts` (Requirement 14.3, decision D17): its AST generators move, unchanged apart from being exported, into the new test helper `src/core/__tests__/hexAstArbitraries.ts`, and the test imports them from there. The edit removes the generator declarations and adds the import; no assertion or property changes. It is the only edit to the tests of `parser.ts`.

No test of `stackValidator.ts`, `stackLoader.ts`, `paintTools.ts` or `partRenderer.ts` is edited (Requirement 14.2); their new behaviour is tested in new test files.

Other files changed: `package.json` gains the scripts `build:power` and `check:power-chrome` (root files carry no spec number in `structure.md`, so its line gets no bracket); the documents of §"Document changes"; `KIRO_USAGE.md` (Requirements 16.10, 17.9).

#### `stackValidator.ts`: listing every validation error
~~~typescript
/** A piece of a gate error's message: fixed text, or a text taken from the read value. */
export type GateMessagePiece = string | { readonly fromValue: string };
/** One gate error (spec 07 Requirement 6.4). */
export interface GateError {
  /** The path as formatPath receives it: numbers are indexes, strings are field names or record keys of the read value. */
  readonly path: readonly PropertyKey[];
  /** The message after "<path>: "; its pieces joined give the message. */
  readonly message: readonly GateMessagePiece[];
}
export interface StackValidationReport {
  /** In check order; empty when the stack is valid. */
  errors: GateError[];
  /** The parsed stack when the schema reported no issue (also with a __proto__ or structural error), else null. */
  stack: HexStack | null;
}
/**
 * "<path>: <message>" as formatPath and the joined pieces give it, with `quote` applied to every
 * string path key and every fromValue piece. Without `quote` it is the text validateStack returns.
 */
export function formatGateError(error: GateError, quote?: (text: string) => string): string;
/** Spec 07 Requirement 6.4. Never mutates `input`. */
export function listStackValidationErrors(input: unknown): StackValidationReport;

export function validateStack(input: unknown): ValidateStackResult {
  const { errors, stack } = listStackValidationErrors(input);
  return errors.length === 0 ? { ok: true, stack: stack! } : { ok: false, error: formatGateError(errors[0]) };
}
~~~
Message pieces:
- the module's own messages mark each value they insert as `fromValue`: the shown `schemaVersion` (the string between its quotes, or `String(version)` for any other value), the `layerScope` found, the id of a duplicate id or a missing background, and the `iconId` of a missing icon. The surrounding text, the quotes included, is fixed;
- a Zod issue with code `unrecognized_keys` is split at each `"<key>"` of `issue.keys`, in order, with the key as `fromValue`; if a key is not found (another Zod message format), the whole message is one `fromValue` piece, so no key escapes shortening. Every other issue's message is one fixed piece: for this schema and the installed Zod they are built from the schema alone (expected types and literals, received type names, limits and the module's own texts). A test pins both facts for the installed Zod;
- the joined pieces always equal the message, so `formatGateError(error)` is the old error text by construction.
Order of `errors`:
1. An object whose `schemaVersion` is not `"2.0.0"`: that error alone (the current message), `stack: null`.
2. The `__proto__` icon-key error when there is one (current path and message).
3. Every issue of `stackSchema.safeParse(input).error.issues`, in Zod's order, formatted by the existing `formatPath`.
4. Only when step 3 found none (the stack is typed): `collectLayerScopeErrors` for each background, then for each card its `backgroundId` error and `collectLayerScopeErrors`, then `collectDuplicateIds` (every occurrence after the first, in the existing walk), then `collectIconReferenceErrors` (backgrounds' parts before cards' parts).

The four collectors keep the current messages and walks of `checkLayerScopes`, `checkUniqueIds` and `checkIconReferences`, but push every error instead of returning the first. Today's `validateStack` returns the first error of exactly this order, so its value is unchanged for every input: the same `ok`, the same text, and the same parsed stack (Requirement 14.2).

#### `stackLoader.ts`: listing every gate error
~~~typescript
/** Spec 07 Requirement 6.4: the validation errors, then (when the schema passed) every layer decodeBitmapRLE rejects. */
export function listStackErrors(input: unknown): StackValidationReport;

export function checkStack(input: unknown): CheckStackResult {
  const { errors, stack } = listStackErrors(input);
  return errors.length === 0 ? { ok: true, stack: stack! } : { ok: false, error: formatGateError(errors[0]) };
}
~~~
When the report has a stack, every background layer, then every card layer, is decoded with its empty fill; each throw adds an error with path `["backgrounds" or "cards", i, "bitmap", "rleData"]` and the thrown message as one fixed piece, which formats to the current `<path>.bitmap.rleData: <message>`. The codec's decode messages hold only fixed text and numbers, so they quote no text of the stack. Today's `checkStack` returns the first validation error, or else the first layer error in the same order, so its value is unchanged too. The difference is cost only: a damaged stack now has all of its layers decoded.

#### `paintTools.ts`: the Rect tool's pixels
~~~typescript
/**
 * Spec 07 Requirement 11.6: the pixels the Rect tool sets for a drag from (x0, y0) to (x1, y1), clipped
 * to the canvas: the 1-pixel frame of the box, or the whole box when `filled`. `plot` applies the pattern.
 */
export function plotRectShape(x0: number, y0: number, x1: number, y1: number, filled: boolean, plot: (x: number, y: number) => void): void;
~~~
The body is the current Rect branch of `drawShape` (min/max of the corners, rows and columns clipped to the canvas, frame test `x === x0 || x === x1 || y === y0 || y === y1`). `drawShape` becomes `plotRectShape(s.start.x, s.start.y, to.x, to.y, s.settings.rectFilled, put)`. The calls to `put` happen in the same order with the same arguments, so the paint controller sets the same pixels as before.

#### `partRenderer.ts`: `clearIconCache`
~~~typescript
/** Spec 07 Requirement 5.5: forgets every decoded icon (render_card calls it after every call). */
export function clearIconCache(): void;
~~~
The cache is keyed by the icon data string, so its hits never change a frame; clearing it keeps the server from holding anything derived from a call's arguments.

#### `src/presets/index.ts` and the new showcase stack (Requirements 15.3, 16.8)
- `src/presets/powerShowcase.json` is the stack JSON text the chat saved with its file tools after the last `validate_stack` that returned `ok` true for that same text.
- `src/presets/powerShowcase.ts`:
~~~typescript
import STACK_TEXT from "./powerShowcase.json?raw";
export const POWER_SHOWCASE_TEXT: string = STACK_TEXT;
/** The stack's name, read without validation so a damaged file cannot stop the studio from starting. */
export const POWER_SHOWCASE_NAME: string;           // JSON.parse(STACK_TEXT).name when a string, else "Power Showcase"
/** A fresh, validated stack; throws when the file does not pass validateStack (the loader then shows "This stack is damaged"). */
export function createPowerShowcaseStack(): HexStack;
~~~
- `SHOWCASE_STACKS` gains `{ id: "powerShowcase", name: POWER_SHOWCASE_NAME, description: "Built in a Kiro chat with the HexCard power.", create: createPowerShowcaseStack }` as its fourth entry. File > Open Showcase Stack lists it and opens it through `fileCommands.replaceStackFrom(showcase.create)` and the stack loader, as for the other three; `main.tsx` is unchanged. The stack is part of the studio bundle, so the built studio opens it with no network access.
- `presets.test.ts`: the name test expects the four names, the fourth being `POWER_SHOWCASE_NAME`. The tests "plays only note strings the synth understands" and "uses only generated preset art in its bitmap layers" run for the three hand-built stacks only (`entry.id !== "powerShowcase"`), because the new stack's art comes from `draw_layer` and Requirement 16.4 does not ask for sound. The validator and compile tests run for all four.
- `src/power/__tests__/powerShowcase.test.ts` checks the rest of Requirement 16.8 (below).

### Skills (Requirements 12, 13)
Both skills have YAML front matter with only `name` and `description` (Agent Skills specification).

`skills/author-hexcard-stack/SKILL.md`:
- front matter: `name: author-hexcard-stack`; description "Build, check, draw, preview and fix HexCard stacks with the hexcard tools: plan the cards and backgrounds, add buttons and fields, draw their pictures with draw_layer, check every change with validate_stack, preview each card with render_card, and save the result as a .hexstack file."
- sections: Before you start (Node.js 22.13 or later, except 23.0 to 23.4, and the `node --version` check of Requirement 12.11); The steps (Requirement 12.2, numbered); Schema rules the gate enforces and the two conventions it does not (Requirement 12.3, pointing at `references/schema.md`); Which text a field shows (Requirement 12.4, with its two-card stack example); Pictures and rleData (Requirement 12.5); Drawing with draw_layer (Requirement 12.6, pointing at `references/patterns.md`, with the drawing example and its stack example); Reading the tools' output (Requirement 12.8); Text and fonts (Requirement 12.9, pointing at `references/fonts.md`); the pixel-match limit of Requirement 10.4.
- `references/schema.md`: one line naming the source (`hexcard_design_spec.md` §2.1), a blank line, then the lines after the `### 2.1.` heading up to the line before the `---` that ends section 2, unchanged.
- `references/patterns.md`: for each index 0 to 37, a heading `## Pattern <n>` and a `text` fenced block of 8 rows of 8 characters (`#` = bit 1 = dark, `.` = bit 0 = light, leftmost character = most significant bit, top row first), after a paragraph stating the `(x mod 8, y mod 8)` alignment.
- `references/fonts.md`: for each file of `tableFontFiles()` in that order, a heading `## <file>`, then two lines in a fixed format the test regenerates:
  - `Selected by: <groups>`, groups `<Font> <regular|bold> <sizes>` joined by `; ` (for example `System regular 12, 14, 24; System bold 12, 14, 24; Sans bold 12, 14, 24`), in the order System, Sans, Mono, Serif and regular before bold;
  - `Covered beyond printable ASCII: <ranges>`, the covered code points outside U+0020..U+007E (cmap plus the five special code points), ascending, as `U+XXXX` or `U+XXXX-U+YYYY` runs joined by `, `.
  A paragraph above the list says that button titles use `System regular 12`.

`skills/write-hextalk/SKILL.md`:
- front matter: `name: write-hextalk`; description "Write, check and fix HexTalk scripts for HexCard buttons, fields, cards, backgrounds and stacks: the exact grammar, the VM's limits, common compile errors and their fixes, compile_hextalk for the canonical text and conjure_script for a first draft."
- sections: The grammar (names `references/grammar.md`); Rules and limits (Requirement 13.3); Common mistakes (Requirement 13.4, every listed case); `field N` and `button N` without a layer word (the example and its canonical form); Checking a script (Requirement 13.5, first list); A first draft with conjure_script (Requirement 13.5, second list); Putting a script into a stack (Requirement 13.6).
- `references/grammar.md`: one line naming the source (`hexcard_design_spec.md` §4.1), a blank line, then the lines after the `### 4.1.` heading and before the `### 4.2.` heading without their leading and trailing blank lines, as one block.

Skill examples are fenced blocks whose info string is a language word followed by a `hexcard:` marker. The test reads every `.md` file of both skills and runs:

| Marker | Kind | Checked as |
|---|---|---|
| `json hexcard:stack` | stack example | `validate_stack`: `ok` true, no script error, no note |
| `json hexcard:stack rle-from=<id>` | stack example holding a drawing's output | as above, and some layer of the drawing's layer kind has exactly the `rleData` of `<id>` |
| `json hexcard:draw id=<id>` | drawing example: the arguments of one `draw_layer` call | `draw_layer`: `ok` true, no note |
| `hextalk hexcard:hextalk` | HexTalk example (optional `id=<id>`) | `compile_hextalk`: `ok` true |
| `hextalk hexcard:canonical of=<id>` | canonical form of a HexTalk example | equals the `canonical` of `<id>` |
| `hextalk hexcard:mistake` | mistake example | exactly one compile error, equal to the next non-blank line, which must read `compile_hextalk: line L, column C: <message>`; the next fenced block must be a `hextalk hexcard:hextalk` block (the fix) |

Example:
~~~markdown
```hextalk hexcard:mistake
on mouseUp
  go next
end mouseDown
```
compile_hextalk: line 3, column 1: expected "end mouseUp" but found "end mouseDown"

```hextalk hexcard:hextalk
on mouseUp
  go next
end mouseUp
```
~~~
The message in this example shows the format; the skill author copies each message from an actual `compile_hextalk` call, and the test fails on any difference. Most Markdown viewers use only the first info-string word, so the markers stay invisible to readers.

### Headless Chrome check (`scripts/checkPowerChrome.ts`; Requirements 10.3, 16.9, 17.6)
`npm run build`, then `npm run check:power-chrome` (same `runnerImport` form as `build:preset-art`; options `--chrome <path>`, default `/usr/bin/google-chrome`). It is never part of `npx vitest --run`. The tooling follows the repository's earlier checks: `vite preview --port <p> --strictPort` started by the script, Chrome started by the script with `--headless=new --remote-debugging-port=<port> --user-data-dir=<fresh temp folder> --disable-lcd-text`, and CDP over Node's built-in `WebSocket`, with device scale factor 1.

1. **Server.** The script starts the committed server file as Kiro would, `node` plus the `args` of `mcp.json` with `${PLUGIN_ROOT}` replaced by the absolute path of `powers/hexcard`, and calls `render_card` over stdio.
2. **Text phase** (Requirement 17.6, first bullet). The script builds a check page with Vite's `build()` into a temp folder: a virtual entry that imports `renderCrisp1BitText`, `createCanvasTextBackend`, `loadBundledFonts` and `TEXT_SIZE_TABLE` from `src/engine/graphics/textRaster.ts` and exposes `globalThis.__hexcardTextCheck(cases)`, plus a copy of `public/fonts/`. It serves the folder with a second `vite preview` and waits for `loadBundledFonts()`. For every (file, render size) pair that `TEXT_SIZE_TABLE` uses, with one (font, size, bold) setting that selects it, the cases are every covered character alone and runs of 24 consecutive covered characters (in code point order, wrapping at the end so that every character is in a run). Each case is drawn with `renderCrisp1BitText(text, font, size, [], { x: 0, y: 0, width, height: lineHeight }, "left", false, backend)` in Chrome (canvas backend) and in Node (`createNodeTextBackend`, loaded with `runnerImport`), with `width` the Node width plus 64; the masks must be equal.
3. **Card phase** (second and third bullets), once at UI scale 1 and once at UI scale 2, each on a fresh profile. The viewport is sized so that `computeIntegerScale` gives k; the script checks that the card canvas's CSS width is 512k.
   - The studio opens the first showcase stack on first launch. Every other entry of `SHOWCASE_STACKS` is opened with File > Open Showcase Stack (real `Input.dispatchMouseEvent` clicks), answering `Don't Save` if the unsaved-changes question appears. Cards are visited with Go > Next; the canvas `aria-label` must name the expected card.
   - After each card opens: wait 600 ms (more than the 500 ms auto-save delay); read the canvas pixels (`getImageData`) and the IndexedDB record of the stack's id (`hexcard` database, `stacks` store); wait 1 s; read both again. Different reads count as a failure for that card.
   - When no record exists, the stack still equals the showcase's `create()` output: `replaceStack` schedules no save, and every later change does within 500 ms. The script then uses `create()`.
   - `render_card` of that stack text with `card` = the 1-based position and `scale` = k. The PNG is decoded in the page with `createImageBitmap(blob, { colorSpaceConversion: "none", premultiplyAlpha: "none" })`, a conforming decoder. At k = 1 its pixels must equal the canvas's 512 x 342 pixels; at k = 2 they must equal a `Page.captureScreenshot` of the canvas rectangle (1024 x 684 at device scale factor 1).
   - Every screenshot (the canvas rectangle at both scales) must hold only the theme's two colours.
4. **Output.** A summary on standard output and in `summary.json` in a new folder `<os temp>/hexcard-power-check-<UTC timestamp>/`, with the screenshots and, for every difference, the two images and a list of differing pixels: the number of characters and cards compared per face and scale, every case that differs, and the colour counts. Nothing is written into the repository. The task report (and, for Requirement 16.9, the Session log entry) quotes the summary.

### Document changes (Requirement 15, task 1)
1. `.kiro/steering/structure.md`:
   - the `.kiro/specs/` comment lists `07-kiro-power` after `06-hypercard-classics`, and "next to 01-06" becomes "next to 01-07";
   - a new top-level entry `powers/` with `hexcard/ ... [07]` and the entries of the module layout above (`licenses/` as one entry, "licence texts of the bundled code and fonts");
   - under `scripts/`: `buildPowerServer.ts` and `checkPowerChrome.ts`, each `[07]`;
   - a new folder entry `src/power/ ... [07]` with one line per file of the layout above and `__tests__/`;
   - under `src/presets/`: `powerShowcase.ts` and `powerShowcase.json`, each `[07]`; the folder comment becomes `4 showcase stacks (Haunted Mansion, Synth, Weather Oracle, Kiro power stack)`;
   - brackets: `stackValidator.ts [01, 06]` → `[01, 06, 07]`; `partRenderer.ts ... [06]` → `[06, 07]`; `paintTools.ts` → `[03, 07]`; `stackLoader.ts` → `[04, 07]`; `index.ts` (presets) → `[04, 07]`.
2. `hexcard_design_spec.md` §8: `06-hypercard-classics/` changes from `└──` to `├──`, followed by `└── 07-kiro-power/              # powers/hexcard/: Kiro power (MCP server, skills) with validate_stack, compile_hextalk, conjure_script, render_card, draw_layer; server sources in src/power/`.
3. `hexcard_design_spec.md` §9: a fourth entry after `apiWeatherOracle.ts`: ``4. `powerShowcase.ts` (data in `powerShowcase.json`) — a stack built in a Kiro chat with the HexCard Kiro power (`powers/hexcard/`), its skills and its five tools.``
4. Spec 04 `requirements.md` Requirement 7.5 gets the sentence "(Spec 07 adds a fourth showcase stack, built in a Kiro chat with the HexCard Kiro power.)".

No stack name appears in these changes (Requirement 15.3).

## Data Models

**Common.** A result's first content is `{ type: "text", text: JSON.stringify(payload) }`. Field order is as listed. Every capped list `L` is followed by `LNotShown` only when it had more than 100 entries (Requirement 5.6). Text marked *quoted* passes through `quoteText`; text marked *shortened* passes through `shortenGateError` when it is a gate error and through `shortenMessage` otherwise (Requirement 5.7).

~~~typescript
/** Every error result (MCP isError true). */
interface ErrorResultJson { ok: false; errors: string[]; errorsNotShown?: number }   // entries shortened

// validate_stack (isError false)
interface ValidateRejected { ok: false; errors: string[]; errorsNotShown?: number }  // gate errors, shortened
interface ValidateAccepted {
  ok: true;
  errors: [];
  scriptErrors: string[]; scriptErrorsNotShown?: number;   // "<path> line L, column C: <message>"
  notes: string[]; notesNotShown?: number;                 // non-canonical layers
  stack: { name: string /* quoted */; cards: number; backgrounds: number };
  hexstack?: string;                                       // only with hexstack: true; a tool product
}

// compile_hextalk (isError false)
interface CompileResult {
  ok: boolean;
  canonical?: string;                                      // only when ok; a tool product
  handlers: string[];                                      // source order, `on` spelling; a tool product
  compileErrors?: { line: number; column: number; message: string /* shortened */ }[];  // only when !ok
  compileErrorsNotShown?: number;
  notes: string[];                                         // ["The script has no handlers."] or []
}

// conjure_script (isError false)
type ConjureResult =
  | { ok: true; hexTalk: string /* a tool product */; notes: string[] /* [] or [handlerHint] */ }
  | { ok: false; reason: string /* shortened */; suggestions: string[] /* 1-3 Grimoire prompts */ };

// render_card (isError false; second content is the PNG)
interface RenderCardResult {
  ok: true;
  card: { position: number; count: number; id: string; name: string };      // id, name quoted
  background: { id: string; name: string };                                   // quoted
  cardSize: { width: 512; height: 342 };
  image: { width: number; height: number; scale: 1 | 2; mimeType: "image/png" };
  theme: { name: string; lightBitHex: string; darkBitHex: string };           // as stored
  parts: PartSummary[]; partsNotShown?: number;                               // drawing order, hidden parts included
  uncoveredCharacters: { path: string; character: string }[]; uncoveredCharactersNotShown?: number;
  uncoveredNote?: string;                                                     // only when the list is not empty
}
interface PartSummary {
  path: string;                                  // "backgrounds[0].parts[2]"
  layer: "background" | "card";
  type: "button" | "field";
  id: string; name: string;                      // quoted
  rect: { x: number; y: number; width: number; height: number };
  style: string;
  hidden: boolean;                               // visible === false: not drawn
  disabled: boolean;                             // enabled === false
  outsideCard: boolean;                          // x < 0 || y < 0 || x + width > 512 || y + height > 342
  title?: string;                                // buttons with showName true; quoted
  iconId?: string;                               // buttons with an iconId; quoted
  text?: string;                                 // fields: the text shown on this card; quoted
  textLength?: number;                           // fields: length of the full text
  textSource?: "cardContent" | "sharedBackgroundContent" | "cardBgFieldContents";
}

// draw_layer (isError false)
interface DrawLayerResult {
  ok: true;
  layer: "card" | "background";
  rleData: string;                               // canonical; "" when the drawing equals the base; a tool product
  lightPixels: number;                           // pixels in state 1, all 175,104 counted
  darkPixels: number;                            // pixels in state 2
  notes: string[]; notesNotShown?: number;       // text that does not fit
  uncoveredCharacters: { path: string; character: string }[]; uncoveredCharactersNotShown?: number;  // path "commands[i]"
}
~~~

Fixed texts:
- `uncoveredNote`: `The studio draws each listed character with a system fallback font, so the studio's pixels of each listed part can differ from this preview.`
- `textSource`: `cardContent` for a card field, `sharedBackgroundContent` for a background field with `sharedText` true, `cardBgFieldContents` for a background field with `sharedText` false (a missing entry shows empty text).

Example of a capped list: a stack with 103 gate errors gives `{"ok":false,"errors":[...100 entries...],"errorsNotShown":3}`.

**Gate error.** `<path>: <message>` in the path format of `validateStack` (`cards[1].parts[0].rect.width: expected an integer`), as `formatGateError` writes it; results carry `shortenGateError` of it.

**Script error.** `<path of the scriptSource> line L, column C: <message>`, L and C 1-based as `parseHexTalk` reports them.

**Limits.** Stack text 4,194,304 characters and 4,194,304 decompressed bytes; script 65,536 characters; prompt 600 characters; card selector 1..100,000 or 256 characters; 256 drawing commands; 65,536 characters of sprite rows and texts per call; input line 33,554,432 bytes; 100 list entries; 80 quoted characters.

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system-essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

Each property is one fast-check test of Requirement 17.2, run with at least 100 cases (fast-check's default `numRuns`), and holds for every generated input. The tools are created with `createPowerTools({ fonts: parseFaces(bundledFontBytes()) })` and called through their `run` and `checkArguments` functions.

### Property 1: validate_stack agrees with the gate, in both text forms

*For any* stack value V drawn from random valid stacks (1 to 4 backgrounds, 1 to 6 cards, random parts, scripts, icons and layers) and from those stacks with one or more injected faults (a wrong `schemaVersion`, a `__proto__` icon key, a schema issue, a part with the wrong `layerScope`, a missing background, a repeated id, a dangling `iconId`, an undecodable layer), and its JSON text J = `JSON.stringify(V)`:
- the `validate_stack` error list for J is empty exactly when `checkStack(V).ok` is true;
- when `checkStack(V)` rejects and its error contains no string or object key of V that is longer than 80 characters, the list's first entry equals `checkStack(V).error` exactly. When the error contains such a text, the property does not compare the first entry, because Requirement 6.4 shortens that text;
- `validate_stack` returns the same `ok`, errors, script errors, notes, stack name and counts for J and for the `.hexstack` text of J;
- `validateStack(V)` and `checkStack(V)` deep-equal the results of the pre-spec-07 bodies of both functions, kept in the test as an oracle.

**Validates: Requirements 6.3, 6.4, 6.7, 14.2**

### Property 2: compile_hextalk round trip

*For any* AST A from the AST generators in `src/core/__tests__/hexAstArbitraries.ts` (the generators `parser.roundtrip.test.ts` imports, Requirement 14.3), `compile_hextalk` of `printHexTalk(A)` returns `ok` true, `printHexTalk(A)` as the canonical form and the handler names of A in order; and `compile_hextalk` of that canonical form returns the same canonical form and the same handler names.

**Validates: Requirements 7.3, 7.4**

### Property 3: render_card PNG holds the frame

*For any* theme from `THEME_PALETTES`, scale k in {1, 2} and card layer whose every pixel is light or dark at random (one background with `rleData` `""`, one card, no parts), decoding the PNG of `render_card` with the test's PNG reader gives a 512k x 342k image in which the k x k block of every frame pixel has the palette colour of that pixel's state, the palette is exactly [lightBitHex, darkBitHex], and a second call with the same arguments returns byte-identical PNG data and identical JSON text.

**Validates: Requirements 9.4, 9.7**

### Property 4: draw_layer rectangles and lines equal the paint tools

*For any* layer kind and list of 1 to 20 `rect` and `line` commands with random points, patterns and fill settings inside the layer, the layer decoded from `draw_layer`'s `rleData` equals the target layer that a real store, history and `createPaintController` produce from the same base for the same drags (`begin` at the first point, `end` at the second, Rect or Line tool, the same pattern and `rectFilled`), applied in the same order; and the controller's pixels for each drag equal those of the pre-spec-07 Rect loop kept in the test as an oracle.

**Validates: Requirements 11.1, 11.2, 11.3, 11.6, 14.2**

### Property 5: sprites set exactly their cells

*For any* layer kind and sprite of 1 to 64 equal rows of 1 to 64 random `#` and `.` characters at a random position inside the layer, the layer decoded from `draw_layer`'s `rleData` is dark at every `#` cell, light at every `.` cell and equal to the base everywhere else.

**Validates: Requirements 11.1, 11.4**

### Property 6: draw_layer output is canonical, valid and stable

*For any* layer kind and list of 1 to 12 commands of all four kinds within the limits of Requirement 5.3 (texts drawn from printable ASCII), `draw_layer` returns `ok` true with `rleData` R such that `encodeBitmapRLE(decodeBitmapRLE(R)) === R`, the pixel counts equal the counts of the decoded layer, a minimal stack holding R in the bitmap of that layer kind passes `validate_stack` with `ok` true and no note, and a second call returns identical JSON text.

**Validates: Requirements 11.7, 11.8, 11.11**

## Error Handling

| Situation | Behaviour |
|---|---|
| Started without `--permission`, or with wider permissions | One line on standard error naming the failed probe; exit status 1; standard input never read; nothing on standard output (Requirement 2.7). |
| Line is not UTF-8 or not JSON, the empty line included | -32700, id `null`. |
| Valid JSON that is not a request or notification, a batch included | -32600, id `null`. |
| Line longer than 33,554,432 bytes | Discarded up to its LF; one -32600, id `null`. |
| Unknown method | -32601 (notifications: no answer). |
| `tools/call` without a valid tool name | -32602. |
| `arguments` not an object, or breaking the inputSchema or a rule of Requirement 11.10 | Error result, one entry per broken rule, `<path>: <rule>`; the tool does not run. |
| Stack text over 4,194,304 characters, not JSON, not `.hexstack`, or decompressing past 4,194,304 bytes | Error result with one entry `stack: <message>`. |
| Gate rejects the stack | `validate_stack`: normal result, `ok` false, every gate error; `render_card`: error result with the same errors, no image. |
| A step of Requirement 5.4 throws | Error result `stack: The stack could not be checked: ...`, `stack: A script in the stack could not be compiled: ...`, `source: The script could not be compiled: ...` or `commands: The drawing commands could not be checked: ...`. |
| No card matches `card` | Error result `card: no card matches <selector>; the stack has <N> cards`. |
| Any other throw inside a tool | Error result `Internal error in <tool>: <message>`; standard error gets `hexcard: internal error in <tool>`; the server goes on. |
| Uncovered character | Drawn as `.notdef`; listed; `ok` unchanged. |
| Text that does not fit its `draw_layer` box | Clipped; one note per command; `ok` unchanged. |
| Standard output closed by the client | The write fails; `serveLines` stops reading and the process ends. |
| Embedded font that the TrueType reader cannot read (off-curve points, point matching, missing table) | `TrueTypeError` at start-up, after the start check and before standard input is read: one line on standard error, exit status 1. The font tests make this a test failure long before a release. |
| Committed server file out of date | `npx vitest --run` fails with "run npm run build:power". |

Every gate error is passed through `shortenGateError`, every other message through `shortenMessage`, and every quoted value through `quoteText`, so no message holds more than 80 consecutive characters of an argument (Requirement 5.7).

## Testing Strategy

Unit and example tests (Vitest, Node environment, no browser, no network, no Kiro; Requirement 17.8). Tests that build or spawn the server set explicit timeouts (60 s) so they do not depend on Vitest's 5 s default.

| Test file | Covers |
|---|---|
| `src/core/__tests__/stackValidator.list.test.ts` | `listStackValidationErrors`: each error kind with its path and message pieces, the order of Requirement 6.4, `stack` null or set; `formatGateError` without `quote` equal to the oracle's text; for the installed Zod, an `unrecognized_keys` message split at its keys, the one-piece fallback, and the other issue messages free of input text; `validateStack` unchanged against the oracle copy. |
| `src/storage/__tests__/stackLoader.list.test.ts` | `listStackErrors`: layer errors after validation errors, backgrounds before cards; `checkStack` unchanged against the oracle copy. |
| `src/engine/graphics/__tests__/paintTools.rect.test.ts` | `plotRectShape` frame and fill, clipping, corner order; the controller against the oracle loop. |
| `src/engine/graphics/__tests__/partRenderer.iconCache.test.ts` | `clearIconCache` empties the cache; frames unchanged. |
| `src/power/__tests__/argumentCheck.test.ts` | every keyword of the subset; order; paths; UTF-16 lengths; each bound of Requirement 5.3 accepted and one past it rejected, for every tool. |
| `src/power/__tests__/results.test.ts` | `quoteText` at 80 and 81 characters; `shortenMessage` on quoted pairs and long runs; `shortenGateError` on record keys of 80 and 81 characters in a path (an 80-character key after `cards[3].bgFieldContents.` stays whole), on an 81-character key with spaces, on a quoted id of 81 characters that contains spaces and `"`, and on a long `String(version)`; `cappedList` at 100 and 101. |
| `src/power/__tests__/protocol.test.ts` | Requirement 4 handler cases of Requirement 17.1: `initialize` for each supported version, an unsupported one, a non-string and a missing one; -32602, -32600 (objects and a batch), -32700, -32601, `ping`, notifications; an injected throwing tool followed by a correct answer to the next line; id types kept; U+2028 escaped. |
| `src/power/__tests__/stdio.test.ts` | chunk splits at every byte position; CR kept; the limit at `maxLineBytes` and one past it (small limit); unfinished last line dropped; answers in order. |
| `src/power/__tests__/startCheck.test.ts` | each probe with fake permission objects. |
| `src/power/__tests__/validateStack.test.ts` | both text forms; each read error of Requirement 6.2; each gate error kind; script errors; non-canonical notes; `hexstack` output reopened with `decodeStackFile` and validated again; a `stack` that looks like a URL. |
| `src/power/__tests__/compileHexTalk.test.ts` | errors with lines and columns, CRLF sources, canonical form, handler names, no-handler note, a long token shortened in a message. |
| `src/power/__tests__/conjureScript.test.ts` | an accepted and a refused prompt for each object kind; default `button`; parity with `mergeSpell("", ast).source` over the Grimoire prompts and the Tier 1 corpus of `src/ai/__tests__/tier1Corpus.ts`; `compile_hextalk` returns each accepted HexTalk unchanged. |
| `src/power/__tests__/renderCard.test.ts` | selection by position, id, name and the `"2"` case; missing card; both scales; palette order and case-insensitive hex; chunk list `IHDR PLTE IDAT IEND`; content order; every summary field including the three text sources (one a missing entry), hidden, disabled and outside parts; uncovered characters and the note; caches empty after a call; no state between calls. |
| `src/power/__tests__/drawLayer.test.ts` | each command with its defaults; both bases; command order; each rule of Requirement 11.10 and the order of a mixed list; `""` results; not-fit notes; uncovered characters; determinism. |
| `src/power/__tests__/steps.test.ts` | Requirement 5.4: a throwing `listStackErrors`, `parseHexTalk` and `checkDrawCommands` double, each followed by a correct answer to the next call. |
| `src/power/__tests__/trueType.test.ts` | every bundled font parses; glyph counts; composite resolution (`exclamdown` is `exclam` turned); advances past `numberOfHMetrics`; off-curve and point-matching inputs rejected; every component offset is a whole pixel at both render sizes; every font maps U+0020..U+007E (Requirement 10.6). |
| `src/power/__tests__/nodeTextBackend.test.ts` | `faceOf` for every `cssFontString`; the special code points; surrogates; `.notdef`; exact sums; `uncoveredCharacters` order and format. |
| `src/power/__tests__/png.test.ts` | byte layout against hand-computed chunks for a tiny frame; scale 2 blocks. |
| `src/core/__tests__/hexAstArbitraries.ts` | Not a test: the shared test helper of D17, holding the AST generators moved from `parser.roundtrip.test.ts`, unchanged apart from being exported. |
| `src/core/__tests__/parser.roundtrip.test.ts` | Unchanged assertions and properties; it imports its AST generators from `hexAstArbitraries.ts` (Requirement 14.3). |
| `src/power/__tests__/tools.property.test.ts` | Properties 1 to 6. |
| `src/power/__tests__/package.test.ts` | `plugin.json`, `mcp.json`, folder entries (`lstat`, no symbolic link, `git check-ignore --no-index`), licence files and the bundled-package licence rule, skill front matter (Requirements 1.2 to 1.7, 2.1 to 2.3, 12.1, 13.1). |
| `src/power/__tests__/serverFile.test.ts` | `buildPowerServer()` once per file: staleness with the message naming `npm run build:power` (3.5, never writing the committed file); a second build with another `TZ` equal to the first, and no repository path, home folder or `file://` in it (3.4); the server file parsed with Vite's `parseAst`: static imports only `node:` built-ins outside the forbidden list, no `require`, no `process.getBuiltinModule`, no `ImportExpression`, no free `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest` and no such property of `globalThis`, `global`, `self` or `window`, no `process.env` (3.2, 3.3, 2.5); each font as its exact base64 data URL (3.1); no `react` module id (14.5). |
| `src/power/__tests__/serverProcess.test.ts` | spawns `process.execPath` with the `args` of `mcp.json`: the end-to-end sequence of Requirement 17.3 (one call per tool with `ok` true, one schema violation per tool, unknown method, invalid JSON, a 33,554,433-byte line, `ping`, then end of input with exit status 0 within 1 s and only expected lines on standard output); two working folders with `PLUGIN_ROOT` and `PLUGIN_DATA` set and unset give byte-identical output (2.5); without `--permission`, and with `--allow-fs-write=*` added, one standard error line, empty standard output, status 1 (2.7); a copy alone in an empty temp folder (3.7); `render_card` in two processes gives identical bytes (9.7); a run with `--import` of a `data:` module that wraps `globalThis.Function` and reports how often it was constructed: zero during start-up and during one call of each tool (3.3). |
| `src/power/__tests__/skills.test.ts` | every marked example of both skills (Requirement 17.4), with failure when a required kind is missing; the `rle-from` pairing; the canonical-form block; drift of `references/schema.md` against §2.1, `references/grammar.md` against §4.1, `references/patterns.md` against `PATTERNS`, `references/fonts.md` against `TEXT_SIZE_TABLE` and the parsed cmaps; the statements of Requirements 10.4 and 12.11. |
| `src/power/__tests__/boundaries.test.ts` | the import graph from `src/main.tsx` and `src/player/main.ts` (regex over `import`/`export ... from` and `import(...)` in `.ts`/`.tsx` files) reaches no `src/power/` module (14.4); no `src/core/` or `src/engine/` module imports `react` (14.5). |
| `src/power/__tests__/powerShowcase.test.ts` | Requirement 16.8, once the stack exists: the committed JSON passes the gate, every `scriptSource` compiles, every layer is canonical, `render_card` lists no uncovered character for any card. |
| `src/presets/__tests__/presets.test.ts` | the edits listed in §"Changes to existing modules". |

Property tests: `tools.property.test.ts` uses fast-check with at least 100 runs per property. Each test carries the comment `// Feature: 07-kiro-power, Property <n>: <title>` and implements exactly one property.
- Property 1's generators draw strings and record keys of up to 120 characters, so first errors with and without a quoted text longer than 80 characters both occur. The test collects every string and object key of V that is longer than 80 characters and compares the first entry with `checkStack(V).error` only when none of them occurs in that error (Requirement 17.2).
- Property 1's generators keep a changed non-string `schemaVersion` short: a number, a boolean, `null`, or an array or object whose `String` value has at most 80 characters. `validateStack` prints such a value with `String(version)`, and `shortenGateError` shortens that text when it is longer than 80 characters, even when no single string or key inside it is. The property's condition looks only at strings and keys, so a longer `String` value would fail it without breaking Requirement 6.4.
- Property 2 imports the AST generators from `src/core/__tests__/hexAstArbitraries.ts` (decision D17).

Browser check (Requirements 10.3, 16.9, 17.6): `npm run build`, then `npm run check:power-chrome` (§"Headless Chrome check"). It runs in the task that completes `render_card` and again in the task of Requirement 16, where `SHOWCASE_STACKS` includes the new stack. The task reports record the summary: characters and cards compared per face and scale, every differing case, colour counts.

Kiro checks (Requirements 16.1, 16.2, 17.7, 17.9) are manual and recorded in the task report and in `KIRO_USAGE.md`:
- the live import with Import power from a folder, its checks in the order of Requirement 16.1 (power name, plugin root contents with byte comparison, the server's command line from the process list, Powers panel details, MCP servers tab and "Kiro - MCP Logs", the five tools in a new chat, the image check with a hidden word);
- one call of each tool in a new chat (Requirement 17.7);
- after the developer's push, Import power from GitHub with the folder URL and one tool call (Requirement 17.9).

## Design Decisions

**D1. Shipping the server.** Chosen: one committed, unminified ES module built by `scripts/buildPowerServer.ts` through Vite's `build()` API, Node target, Zod and fonts inlined, written by `npm run build:power`, checked for staleness by a test.
- Alternatives: esbuild (not installed, Vite 8 does not depend on it, so it would be a new dependency); Rolldown's own API (installed only as Vite's dependency, not in `package.json`); `tsc` output (many files and no bundling of Zod); a minified file (smaller, but a reviewer cannot read what users run); an npm package started with `npx` (needs the network on the user's machine and is out of scope); committed `node_modules` (thousands of files).
- Reasons: Vite is already the project's build tool, a trial build gave one deterministic chunk with no absolute path, and `import.meta.glob` with `?inline` already embeds fonts for the player. The `.mjs` extension makes Node load the file as an ES module without reading a `package.json`, which the permission model would refuse. The file sits in `server/`, away from the manifest, so the start check can probe the folder that holds it.

**D2. Module layout.** Chosen: every server module, the TrueType reader and the Node text backend in `src/power/`.
- Alternative: `trueType.ts` and `nodeTextBackend.ts` in `src/engine/graphics/`.
- Reason: Requirement 14.4 then becomes a folder rule (nothing outside `src/power/` and its tests imports `src/power/`), which a simple import-graph test enforces. Both modules are still pure TypeScript with no `node:` import, so they could move to `src/engine/` later if the studio ever needs them.

**D3. Start check.** Chosen: the probes of §`startCheck.ts`, including `addon` and `wasi`, which Requirement 2.7 does not list. `has("fs.write")` without a reference only detects `*`, so the check adds the server file, its folder and the filesystem root. A write grant for an unrelated folder is not detected; the server cannot write anyway because it imports no file module.

**D4. Result JSON.** Chosen: compact `JSON.stringify` with a fixed key order; a capped list `L` followed by a sibling `LNotShown` count instead of a final string entry, so every list keeps one type; compile errors under `compileErrors` (objects) so that `errors` always means strings; uncovered characters as one entry per (part, character) with a single `uncoveredNote` stating the studio limit for every listed part; part entries with their `path` so the uncovered list can point at them.

**D5. Gate listing.** Chosen: `listStackValidationErrors` and `listStackErrors` collect everything, and `validateStack` and `checkStack` return their first entry, so "first error equals checkStack" holds by construction. Each entry is a `GateError` (path segments and message pieces) rather than a string, so that `formatGateError` gives the old text and `shortenGateError` can shorten exactly the texts taken from the stack (D14). Alternative: keep the old functions and add separate listing code, which could drift. The cost is that a damaged stack's remaining checks and layer decodes always run.

**D6. Rect tool's pixels.** Chosen: `plotRectShape(x0, y0, x1, y1, filled, plot)`, the same callback style as `bresenhamLine`, with the pattern applied by the caller through `patternState`. Both the controller and `draw_layer` call it.

**D7. Showcase stack.** Chosen: `src/presets/powerShowcase.json` (the JSON text the chat validated, stored byte for byte) and `src/presets/powerShowcase.ts`, added to `SHOWCASE_STACKS` and opened with File > Open Showcase Stack.
- Alternatives: a committed `.hexstack` file opened with File > Open Stack File (a judge would first have to find and download the file); the stack as a TypeScript literal (the chat would have to edit code, and the text would no longer be the exact text `validate_stack` checked).
- The design does not set the stack's name: the chat picks it under Requirement 16.7, and the documents of task 1 use the label "Kiro power stack". The chooser shows the name read from the JSON file; a damaged file shows the fallback name and the loader's "This stack is damaged" alert, never a failed studio start.

**D8. Headless Chrome check.** Chosen: a committed script run by hand (`npm run check:power-chrome`), so the same check runs for the three stacks now and for the new stack in Requirement 16.9.
- The text phase uses a check page built from the repository's `textRaster.ts` with Vite's production build, because the studio's `dist/` bundle does not expose `renderCrisp1BitText`. The card phase uses the studio's own `dist/` from `npm run build`.
- When IndexedDB holds no record for the open stack, the script uses the showcase's `create()` output, because the store schedules no save on `replaceStack` and saves every later change within 500 ms.
- Results go to a temp folder and into the task report, never into the repository.

**D9. Skills.** Chosen: a `references/` folder per skill (Agent Skills' optional folder), the verbatim copies and generated-format lists checked by drift tests, and fenced-block markers `hexcard:<kind>` in the info string, which renderers ignore and the test can find without parsing prose.

**D10. Licence files.** Chosen: `LICENSE` at the power root and third-party and font texts in `licenses/`, all written by `npm run build:power` from their sources, so they are regenerated with the server file. The build fails when the bundle contains a package without a licence entry.

**D11. Argument checking.** Chosen: a small interpreter of the JSON Schema subset that the inputSchemas use, so the schema sent in `tools/list` is the rule set the server enforces.
- Alternatives: Zod schemas with `z.toJSONSchema` (Zod's JSON Schema output and its error texts are not under this project's control); hand-written checks next to hand-written schemas (two sources that can drift).
- Lengths are UTF-16 code units as the Glossary defines; descriptions say so, because JSON Schema counts code points.

**D12. PNG compression.** Chosen: `node:zlib` `deflateSync` at level 9 and `zlib.crc32`, both allowed built-ins. Alternatives: stored (uncompressed) deflate blocks, which give the same bytes on every Node release but make a scale 2 image about 88 KB before Base64; `CompressionStream("deflate")`, which uses the same zlib asynchronously. Requirement 9.7 asks for identical bytes within and across processes on one machine, which zlib gives.

**D13. Fonts.** Chosen: all nine fonts parsed whole at start-up, before standard input is read, so no parsed data depends on a call. Quadratic curves and point matching are rejected instead of approximated, because the bundled fonts have neither and an approximation could never be checked against Chrome.

**D14. Shortening messages.** Settled with the user: Requirement 5.7 takes precedence over the exact match with `checkStack`, and Requirement 6.4 says so.
- Gate errors are shortened in their path and in their message. `shortenGateError` writes the `GateError` of the listing (D5) with `quoteText` applied to every string path key and every `fromValue` piece. Each such text longer than 80 characters becomes its first 77 characters followed by `...`; every other character is copied.
- A first error that quotes no stack text longer than 80 characters is therefore exactly the error `checkStack` returns. Property 1 checks this for every first error whose `checkStack` text contains no string or object key of the read value longer than 80 characters (Requirement 17.2).
- A non-string `schemaVersion` is shown as `String(version)`, one `fromValue` piece. It is shortened when that text is longer than 80 characters, even when no single string inside it is.
- `shortenMessage` keeps its string rules for the messages that are not gate errors: read errors, parser messages, refusal reasons and thrown errors.
- Rejected alternative: `shortenMessage` on gate errors. A string rule cannot tell a record key in a path from the fixed path text around it. Rule (2) would shorten `cards[3].bgFieldContents.<60-character key>:`, an 86-character run, although the key is short. It would also leave whole a long key that contains spaces, or a long quoted id that contains `"`.

**D15. Reading standard input.** Chosen: `for await` over `process.stdin`, handling and answering each complete line before the next chunk is read. Memory stays at one chunk plus one partial line, and slow tools apply back-pressure to the client.

**D16. Line separators.** Chosen: U+2028 and U+2029 escaped in every answer. JSON allows them raw, but a client that splits lines on them would see a broken message.

**D17. Parser generators for Property 2.** Settled with the user, and Requirement 14.3 allows exactly this edit.
- The AST generators that `src/core/__tests__/parser.roundtrip.test.ts` declares move, unchanged apart from being exported, into a new test helper `src/core/__tests__/hexAstArbitraries.ts`.
- `parser.roundtrip.test.ts` imports them from there. The edit removes the generator declarations and adds the import, and changes none of its assertions or properties.
- Property 2 imports the same generators, so `compile_hextalk` is tested on the ASTs of the parser's own round-trip property (Requirement 17.2).
- The helper lies in a `__tests__/` folder, so `structure.md` does not list it (Requirement 14.6).
- Rejected alternative: a copy of the generators in the power test. The two copies could drift, and Requirement 17.2 names the shared helper.

**D18. Server version.** Chosen: `serverInfo.version` read from `plugin.json`, inlined as text by `?raw`, so the version in the answer and in the manifest are one value.

**D19. Request ids.** Chosen: an integer id must be a safe integer (`Number.isSafeInteger`); any other number gives -32600 with id `null`. `JSON.parse` cannot keep an integer beyond 2^53 - 1 exactly, so echoing it would break Requirement 4.9's "same value". MCP clients use small integers or strings.

**D20. Smaller result details.** Chosen: `tools/list` entries carry an MCP `title` (clients of older protocol revisions ignore it); the list fields `notes` and `uncoveredCharacters` are always present, empty when there is nothing to say, so every result of one tool has the same shape; the `.hexstack` text appears only when asked for, because it can be as large as the stack.
