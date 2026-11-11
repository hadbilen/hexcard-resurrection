Source: `hexcard_design_spec.md` §2.1, copied unchanged (the TypeScript schema block and the persistence invariants).

~~~typescript
export type HexID = string; // Format: "stk_...", "bkg_...", "crd_...", "prt_..."

export type VisualEffectType =
  | "cut"
  | "dissolve"         // 18-bit Galois LFSR pseudo-random pixel dissolution
  | "venetianBlinds"   // Horizontal venetian blind slats opening
  | "checkerboard"     // 8x8 checkerboard transition
  | "irisOpen"         // Rectangular wipe from center outwards
  | "irisClose"        // Inward rectangular wipe towards center
  | "wipeLeft"
  | "wipeRight"
  | "wipeUp"
  | "wipeDown"
  | "barnDoorOpen"
  | "barnDoorClose";

export type VisualEffectSpeed = "verySlow" | "slow" | "normal" | "fast";

export type AuthoringTool =
  | "browse"      // Interaction mode (Hand icon)
  | "button"      // Button selection/creation/resize tool
  | "field"       // Text field selection/creation/resize tool
  | "select"      // Rectangular marquee pixel selection
  | "lasso"       // Freeform pixel selection
  | "pencil"      // 1-pixel drawing (FatBits zoom support)
  | "brush"       // Paint using selected 8x8 bit pattern
  | "eraser"      // Pixel eraser (erases to transparent on Card layer, white on Background)
  | "line"        // Bresenham algorithm 1-bit line drawing
  | "spray"       // Random matrix dispersion airbrush/spray
  | "rect"        // Rectangular frame / filled box drawing
  | "paintBucket"; // 4-way Flood-Fill algorithm using 8x8 bit pattern fill

export interface HexBitmapLayer {
  width: number;  // Standard: 512
  height: number; // Standard: 342
  /**
   * 3-state pixels packed 2 bits per pixel, compressed with PackBits, then Base64 (see §5.4).
   * Decoded at runtime into a Uint8Array (0 = Transparent, 1 = White/Light, 2 = Black/Dark).
   * "" means "empty layer": cards decode it as all-transparent (0), backgrounds as all-light (1).
   * MUST only be produced/consumed through encodeBitmapRLE / decodeBitmapRLE (src/engine/graphics/rleCodec.ts).
   */
  rleData: string;
}

export type PartType = "button" | "field"; // Only these two part kinds exist in v2.0.0

export type ButtonStyle =
  | "transparent"
  | "opaque"
  | "rectangle"
  | "roundRect"     // Classic Mac rounded rectangle button
  | "shadow"        // Button with 2px black drop-shadow on bottom and right edges
  | "checkBox"
  | "radioButton"
  | "default";      // Primary action button with double black border

export type FieldStyle =
  | "transparent"
  | "opaque"
  | "rectangle"
  | "shadow"
  | "scrolling";    // Classic Mac text field with 1-bit arrowed scrollbar

export interface HexRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface HexPartBase {
  id: HexID;
  name: string;
  type: PartType;
  layerScope: "card" | "background";
  rect: HexRect;
  visible: boolean;
  enabled: boolean;
  scriptSource: string;           // Canonical HexTalk source (the ONLY persisted form of a script)
  naturalLanguagePrompt?: string; // Last AI prompt entered by the user
}

export interface HexButtonPart extends HexPartBase {
  type: "button";
  style: ButtonStyle;
  title: string;
  showName: boolean;
  iconId?: string;                // names a key of the stack's customIcons (spec 06)
  autoHilite: boolean;            // Invert black/white pixels on click
  hilite: boolean;                // Checked state for Checkbox/Radio
  family?: number;                // Mutually exclusive radio button group number (1-15)
}

export interface HexFieldPart extends HexPartBase {
  type: "field";
  style: FieldStyle;
  content: string;                // Read if sharedText: true or when located on Card layer
  sharedText: boolean;            // If false and on Background layer, text is stored in HexCard.bgFieldContents
  lockText: boolean;              // If true, user cannot edit text in Browse mode; click events are triggered instead
  dontWrap: boolean;
  showLines: boolean;             // Classic lined-notebook dotted horizontal rules
  textAlign: "left" | "center" | "right";
  textFont: "System" | "Sans" | "Mono" | "Serif"; // Logical names mapped to bundled, freely licensed bitmap fonts (§5.5)
  textSize: 9 | 10 | 12 | 14 | 18 | 24;
  textStyle: Array<"bold" | "italic" | "underline" | "outline" | "shadow" | "condense">;
}

export type HexPart = HexButtonPart | HexFieldPart;

export interface HexBackground {
  id: HexID;
  name: string;
  bitmap: HexBitmapLayer;
  parts: HexPart[];               // layerScope === "background"
  scriptSource: string;
  cantDelete: boolean;
}

export interface HexCard {
  id: HexID;
  name: string;
  backgroundId: HexID;            // Inherited HexBackground reference
  bitmap: HexBitmapLayer;         // Card drawing overlaid on background (with transparency/mask)
  parts: HexPart[];               // layerScope === "card"
  /**
   * Mapping table storing card-specific text content for background fields
   * where sharedText === false (Key: Part.id, Value: string)
   */
  bgFieldContents: Record<HexID, string>;
  marked: boolean;                // Used for filtering and "go to next marked card" queries
  cantDelete: boolean;
  dontSearch: boolean;
  scriptSource: string;
}

export interface HexStack {
  id: HexID;
  schemaVersion: "2.0.0";
  name: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  dimensions: { width: number; height: number }; // Default: 512 x 342
  themePalette: {
    name: ThemePaletteName;
    darkBitHex: string;           // Copied from THEME_PALETTES[name] when the theme is chosen
    lightBitHex: string;
  };
  backgrounds: HexBackground[];
  cards: HexCard[];               // Sequential card array (Index 0 = First Card)
  customIcons: Record<string, string>; // icon name -> 32x32 1-bit icon: 128 bytes (32 rows x 4 bytes, row-major, MSB = leftmost pixel, 1 = dark) as padded standard Base64, 172 chars (spec 06)
  scriptSource: string;
}

export type ThemePaletteName = "ClassicPaper" | "AmberCRT" | "GreenPhosphor" | "MidnightHex";

export const THEME_PALETTES: Record<ThemePaletteName, { darkBitHex: string; lightBitHex: string }> = {
  ClassicPaper:  { darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
  AmberCRT:      { darkBitHex: "#1A1000", lightBitHex: "#FFB000" },
  GreenPhosphor: { darkBitHex: "#041804", lightBitHex: "#33FF33" },
  MidnightHex:   { darkBitHex: "#0A0A23", lightBitHex: "#C8C8FF" },
};
~~~

**Persistence invariants (single source of truth):**
- Scripts are persisted **only** as `scriptSource` (HexTalk). No AST is ever stored in a stack file, IndexedDB record, URL hash or exported HTML.
- On load, every `scriptSource` is compiled by `parser.ts` into an in-memory `ScriptCache: Map<HexID, HexScriptAST>` owned by the runtime store (`src/core/store.ts`). A script that fails to compile gets an empty AST plus a list of `{ line, column, message }` errors shown in the script editor; the stack still loads.
- Every imported stack (file, URL hash, preset) is validated against a runtime schema (Zod) before it reaches the store; invalid stacks are rejected with a System 7 alert, never partially loaded.
