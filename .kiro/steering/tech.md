---
inclusion: always
---

# Technical Stack & Engineering Constraints

## Core Stack
- **Frontend Framework:** React 19 + TypeScript (Strict Mode) + Vite
- **Styling:** Tailwind CSS + custom pixel-exact CSS rules for the Macintosh System 7 GUI
- **State:** framework-free store in `src/core/store.ts`, consumed in React with `useSyncExternalStore` (no external state library)
- **Runtime validation:** Zod schemas for persisted stacks and for AI-produced ASTs
- **Graphics Engine:** HTML5 `Canvas2D` operating on raw `Uint8Array` / `Uint32Array` pixel buffers (`512x342` native resolution, integer CSS scaling, `image-rendering: pixelated`)
- **Audio Engine:** Procedural WebAudio API synthesizer (Karplus-Strong harpsichord, pitch-modulated boing, 8-bit square wave) with zero external audio asset dependencies
- **Persistence:** IndexedDB for local auto-save, `deflate-raw` (`CompressionStream`) + Base64URL for URL-hash sharing and `.hexstack` files, and a single-file standalone `.html` export built from a separate player bundle
- **Testing:** Vitest for unit tests, fast-check for property-based tests (parser round-trip, codec round-trip). `src/core/` and `src/engine/` must be testable in Node without a browser.

## Security Guardrails
1. **No dynamic code execution:** never use `eval()`, `new Function()`, `setTimeout(string)`/`setInterval(string)`, or dynamically created `<script>` elements. All user and AI scripts execute exclusively through the step-budgeted `HexScriptAST` VM (`src/core/vm.ts`), capped at `10,000` evaluated AST nodes per top-level dispatch (shared with its nested dispatches).
2. **No HTML injection:** never use `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write` or React `dangerouslySetInnerHTML`. Stack content and script output reach the screen only through the 1-bit text rasterizer or `textContent`.
3. **Untrusted stacks:** every stack loaded from a file, URL hash or preset passes the Zod stack validator before it reaches the store. Invalid stacks are rejected whole, never partially loaded.
4. **Network:** the only network access a script has is `fetch`, under the policy in `hexcard_design_spec.md` §4.3 (https only, GET, no credentials, no custom headers, 8 s timeout, 256 KB cap, JSON only).
5. **Secrets:** a BYOK API key lives only in memory for the current session. It is never written to IndexedDB, URLs, exported stacks, exported HTML or logs.
6. **Standalone HTML export:** the embedded stack JSON must write every `<` as the six-character escape `\u003c` so that it can never close its `<script type="application/json">` tag.

## Data Contracts
- **Single source of truth for scripts:** only HexTalk `scriptSource` is persisted. ASTs live in the in-memory `ScriptCache` and are rebuilt by `parser.ts` on load. The AI layer outputs ASTs only; HexTalk is printed from them.
- **Bitmap codec:** always use `encodeBitmapRLE` / `decodeBitmapRLE` from `src/engine/graphics/rleCodec.ts` for `HexBitmapLayer.rleData` (2-bit packing + PackBits + Base64; `""` = empty layer; states `0 = Transparent`, `1 = White/Light`, `2 = Black/Dark`). Never invent ad-hoc bitmap formats in presets or exporters. Card layers decode `""` as transparent, background layers as light.

## 1-Bit Fidelity Rules
1. **Transitions:** no CSS opacity fades. Card transitions operate on two fully composed pixel frames; `dissolve` uses the 18-bit Galois LFSR (`0x20400` mask).
2. **Image import:** Bill Atkinson error diffusion (6/8 of the quantization error spread to 6 neighbours).
3. **Card content is rasterized:** buttons, fields and their text are drawn into the 1-bit frame by `partRenderer.ts` and `textRaster.ts`. The only DOM elements over the card canvas are the hidden text-input textarea and authoring selection handles.
4. **Text:** card text is drawn with `renderCrisp1BitText` (alpha threshold `>= 128`). Do not rely on `-webkit-font-smoothing` / `font-smooth`; they only work on macOS.
5. **Fonts:** bundle only OFL-1.1, CC0 or public-domain bitmap fonts in `public/fonts/`, with licences listed in `public/fonts/LICENSES.md`. Never bundle or load Apple's Chicago, Geneva, Monaco or New York font files.
6. **CSS:** never use `box-shadow` with a blur radius (only hard offsets such as `2px 2px 0px var(--dark-bit)`), `linear-gradient`, `radial-gradient`, `backdrop-filter`, `filter: blur()`, or `opacity` values between `0.01` and `0.99`. Also never use `border-radius`, dashed or dotted borders and outlines (`border-style: dashed|dotted`, `outline-style: dashed|dotted`), or glyphs missing from the bundled fonts (they fall back to anti-aliased system fonts). Use crisp 1px/2px solid borders and 8x8 bit patterns. Always apply `image-rendering: pixelated` to `<canvas>` elements.

## Zero-Config AI
`src/ai/spellcaster.ts` MUST work out of the box without an API key, defaulting to the built-in Local Semantic AST Compiler and Grimoire presets when no proxy or key is configured.
