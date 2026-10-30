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