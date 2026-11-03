---
inclusion: always
---

# Technical Stack & Engineering Constraints

## Core Stack
- **Frontend Framework:** React 19 + TypeScript (Strict Mode) + Vite
- **Styling:** Tailwind CSS + Custom Pixel-Exact CSS rules for Macintosh System 7 GUI
- **Graphics Engine:** HTML5 `Canvas2D` operating on raw `Uint8Array` / `Uint32Array` pixel buffers (`512x342` native 1-bit resolution with integer scaling and `image-rendering: pixelated`)
- **Audio Engine:** Procedural WebAudio API synthesizer (Karplus-Strong harpsichord, pitch-modulated boing, 8-bit square wave) with zero external audio asset dependencies
- **Persistence:** IndexedDB for local auto-save, URL-hash compression for serverless sharing, and single-file standalone `.html` export

## Strict Security & Fidelity Guardrails
1. **NO Dynamic Code Execution:** Never use `eval()`, `new Function()`, or `setTimeout(string)` to run user or AI scripts. All interactivity MUST execute through the step-budgeted `HexScriptAST` interpreter (`src/core/vm.ts`).
2. **VM Gas Limit:** Every event dispatch in `HexScriptAST` MUST track evaluated nodes and halt execution at `10,000` steps with a classic System 7 bomb error dialog to prevent infinite loops.
3. **Mathematical 1-Bit Graphics:**
   - Do NOT use CSS opacity fades for transitions. Implement the 18-bit Galois LFSR (`0x20400` polynomial mask) for authentic pixel-by-pixel `dissolve` transitions.
   - Image imports MUST use Bill Atkinson's error-diffusion dithering algorithm (propagating 6/8 of quantization error).
   - UI components MUST strictly avoid blurry CSS `box-shadow`, anti-aliased gradients, or non-integer border radii. Use crisp 1px/2px solid borders and classic 8x8 bit patterns.

## Mandatory Architectural Guardrails (Strict Enforcement)

1. **No Dynamic Code Execution:** NEVER use `eval()`, `new Function()`, or `setTimeout(string)`. All user and AI scripts MUST execute exclusively through the step-budgeted `HexScriptAST` virtual machine (`src/core/vm.ts`) with a hard limit of `10,000` evaluated AST nodes per event dispatch.
2. **Canonical 3-State RLE Bitmap Codec:** ALWAYS use `encodeBitmapRLE` and `decodeBitmapRLE` from `src/engine/graphics/rleCodec.ts` for all `HexBitmapLayer.rleData` operations (`0 = Transparent`, `1 = White/Light`, `2 = Black/Dark`). Never invent ad-hoc bitmap string formats in presets or exporters.
3. **Strict 1-Bit Visual Discipline:**
   - NEVER use CSS `box-shadow` with a blur radius (e.g., `0 4px 6px` is FORBIDDEN; only hard offset shadows like `2px 2px 0px var(--dark-bit)` are allowed).
   - NEVER use CSS `linear-gradient`, `radial-gradient`, `backdrop-filter`, or `opacity` values between `0.01` and `0.99`.
   - ALWAYS apply `image-rendering: pixelated` to `<canvas>` elements and threshold offscreen text rendering at `alpha >= 128`.
4. **Zero-Config AI Fallback:** `src/ai/spellcaster.ts` MUST work out-of-the-box without requiring an external API key by defaulting to the built-in Local Semantic AST Compiler and Grimoire Presets when no API key or proxy is configured.