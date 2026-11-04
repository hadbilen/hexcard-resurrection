# Implementation Plan: 1-Bit Canvas, Codec, Text & Transitions

- [x] 1. Implement the bitmap codec
  - Copy the reference implementation of `hexcard_design_spec.md` §5.4 into `src/engine/graphics/rleCodec.ts`
  - Port the round-trip, fuzz and corruption tests; add a fast-check round-trip property
  - _Requirements: 1.1, 1.2, 1.3, 1.4_

- [x] 2. Implement frame composition
  - `composeFrame` with the §5.6 layer order, background `0 -> 1` rule and decoded-layer cache
  - `frameToImageData` palette mapping and integer scaling helper
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 3. Implement crisp text rendering and fonts
  - Choose freely licensed bitmap fonts, add them to `public/fonts/` with `LICENSES.md`
  - `renderCrisp1BitText` with threshold, deterministic wrapping and pixel-based text styles
  - _Requirements: 4.1, 4.3, 4.4_

- [x] 4. Implement part rendering and hit testing
  - Draw functions for all button and field styles, highlight inversion, `showLines`
  - Hidden-textarea editing support: caret and selection drawing from editing state
  - Geometric `hitTest`
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.2_

- [x] 5. Implement Atkinson image import
  - Scale-to-fit, luminance conversion and the §5.1 dithering function
  - _Requirements: 5.1_

- [x] 6. Implement visual effects
  - `lfsrDissolve.ts` from §5.2 with the four speed settings
  - Remaining effects in `transitions.ts` operating on full composed frames
  - _Requirements: 6.1, 6.2, 6.3_

- [x] 7. Implement paint tools and patterns
  - 38 patterns, world-aligned pattern bits, Bresenham line, rect, spray, eraser rules, flood fill, select, lasso
  - Emit one `PaintStrokeCommand` per stroke to the spec-01 history
  - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
