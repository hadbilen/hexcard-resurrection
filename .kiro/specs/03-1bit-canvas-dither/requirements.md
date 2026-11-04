# Requirements Document: 1-Bit Canvas, Codec, Text & Transitions

## Introduction
This spec covers everything that turns stack data into 1-bit pixels: the bitmap codec, the frame compositor and part renderer, crisp text rendering and fonts, Atkinson image import, visual effects, and the paint tools. Canonical contracts: codec `hexcard_design_spec.md` §5.4, text §5.5, composition §5.6, dithering §5.1, dissolve §5.2, patterns §5.3.

## Requirements

### Requirement 1: Bitmap Codec
**User Story:** As a user sharing stacks, I want bitmaps stored compactly and safely, so that stacks with dithered images stay small and corrupt data cannot break the app.

#### Acceptance Criteria
1. WHEN `encodeBitmapRLE(pixels)` is called with a 175,104-pixel buffer of states `0..2`, THE SYSTEM SHALL produce 2-bit-packed, PackBits-compressed Base64 as specified in design spec §5.4, and `""` for an all-transparent layer.
2. FOR every valid buffer `P`, THE SYSTEM SHALL satisfy `decodeBitmapRLE(encodeBitmapRLE(P))` equal to `P`.
3. WHEN `decodeBitmapRLE("")` is called, THE SYSTEM SHALL return all `0` for card layers and all `1` for background layers.
4. IF the input buffer has the wrong length or a state above 2, or the encoded data is truncated, overflows, has trailing bytes or decodes to state 3, THEN THE SYSTEM SHALL throw an error instead of returning partial data.

### Requirement 2: Frame Composition
**User Story:** As a stack author, I want the card to look exactly like HyperCard's layering, so that card pictures can cover background buttons and fields.

#### Acceptance Criteria
1. WHEN a frame is composed, THE SYSTEM SHALL draw, in order: background bitmap, background parts, card bitmap (non-transparent pixels only), card parts, as in design spec §5.6.
2. WHEN a background pixel decodes to `0`, THE SYSTEM SHALL treat it as `1` (light).
3. WHEN the frame is displayed, THE SYSTEM SHALL map `1` to `lightBitHex` and `2` to `darkBitHex` of the stack's theme, draw it on one 512x342 canvas, and scale it by an integer CSS factor with `image-rendering: pixelated`.

### Requirement 3: Part Rendering & Hit Testing
**User Story:** As a user, I want buttons and fields drawn as authentic 1-bit System 7 controls and to respond to clicks precisely.

#### Acceptance Criteria
1. WHEN a visible part is composed, THE SYSTEM SHALL rasterize its style (every `ButtonStyle` and `FieldStyle` in design spec §2.1), title or text, and `showLines` rules into the frame.
2. WHEN a button with `autoHilite` is pressed, or a button has `hilite = true`, THE SYSTEM SHALL draw the highlighted state by inversion: checkboxes and radio buttons by inverting their mark only, other buttons by inverting the area inside their border. While a checkbox or radio button is pressed, its box shows a pressed ring instead; the mark changes on release.
3. WHEN a pointer position is tested, THE SYSTEM SHALL return the topmost visible part containing it (card parts before background parts, later array entries first), after dividing by the integer scale factor.
4. WHEN a part has `enabled = false`, THE SYSTEM SHALL draw its title or text through a 50% checkerboard mask (classic dimmed look) while drawing its frame normally.

### Requirement 4: Crisp 1-Bit Text & Fonts
**User Story:** As a retro computing enthusiast, I want card text to be truly 1-bit on every operating system, and as the maintainer I want only legally redistributable fonts.

#### Acceptance Criteria
1. WHEN card text (field text, button titles) is drawn, THE SYSTEM SHALL render it with `renderCrisp1BitText`, thresholding alpha at `>= 128`, and SHALL NOT render it as DOM text.
2. WHILE an unlocked field is being edited in Browse mode, THE SYSTEM SHALL take input from one visually hidden `<textarea>` (hidden with `clip-path`, not opacity, labelled with the field name) and draw the caret and selection as inverted pixels.
3. THE SYSTEM SHALL map the logical fonts `System`, `Sans`, `Mono`, `Serif` to bitmap fonts in `public/fonts/` licensed under OFL-1.1, CC0 or public domain, with each licence recorded in `public/fonts/LICENSES.md`, and SHALL render every logical text size (9, 10, 12, 14, 18, 24) at a positive integer multiple (1x, 2x, ...) of the chosen font file's native pixel size, never at an in-between size, as listed in the size table of design.md §4.
4. THE SYSTEM SHALL NOT bundle or load Apple's Chicago, Geneva, Monaco or New York font files.

### Requirement 5: Atkinson Image Import
**User Story:** As a creator, I want imported photos converted to authentic 1-bit art.

#### Acceptance Criteria
1. WHEN an image is imported onto a layer, THE SYSTEM SHALL scale it to fit 512x342, convert it to luminance `0.299R + 0.587G + 0.114B`, and dither it with Atkinson error diffusion (1/8 of the error to each of 6 neighbours) as in design spec §5.1.

### Requirement 6: Visual Effects
**User Story:** As a stack author, I want classic card transitions computed on pixels, not CSS.

#### Acceptance Criteria
1. WHEN a card change carries a visual effect, THE SYSTEM SHALL compose the full old and new frames (parts included) and animate between them in the pixel buffer.
2. WHEN the effect is `dissolve`, THE SYSTEM SHALL visit every pixel exactly once in the order of the 18-bit Galois LFSR with mask `0x20400`, copying `3,600 / 7,300 / 14,500 / 29,000` pixels per frame for `verySlow / slow / normal / fast`.
3. THE SYSTEM SHALL implement every `VisualEffectType` of design spec §2.1 without CSS opacity or filters.

### Requirement 7: Paint Tools & Patterns
**User Story:** As a creator, I want MacPaint-style tools with world-aligned patterns.

#### Acceptance Criteria
1. WHEN the pencil, brush, eraser, line, rect, spray, paint bucket, select or lasso tool is used, THE SYSTEM SHALL modify only the layer chosen by the Edit Background state (spec 01 Requirement 1.4).
2. WHEN a pattern is painted, THE SYSTEM SHALL compute each bit as `(pattern[y & 7] >> (7 - (x & 7))) & 1` in canvas coordinates.
3. WHEN the eraser is used, THE SYSTEM SHALL set card-layer pixels to `0` (transparent) and background-layer pixels to `1` (light).
4. WHEN the paint bucket is used, THE SYSTEM SHALL flood-fill 4-connected pixels of the same composed colour with the selected pattern.
5. WHEN a stroke ends, THE SYSTEM SHALL submit it as one `PaintStrokeCommand` to the history (spec 01 Requirement 5.3).
