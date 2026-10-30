# HexCard — System Architecture & Design Specification

* **Project Name:** HexCard (HyperCard Resurrection & AI-Native Micro-App Studio)
* **Target Event:** Kiroween 2026 Hackathon
* **Primary Category:** **Resurrection** *(Reviving a dead technology in the modern era)*
* **Secondary Categories:** **Costume Contest** *(Authentic 1987 Macintosh System 7 / 1-bit Dithered GUI)* & **Frankenstein** *(Fusing an 80s native desktop card architecture + 2026 LLM AST compiler + Canvas2D/WebGL + WebAudio synthesizer)*
* **Target Platform:** Web (Zero-Backend Client Runtime + Single-File HTML/JSON Distribution) and Desktop (Tauri v2 wrapper compatible)

---

## 1. Product Vision & Core Engineering Philosophy

Developed by Bill Atkinson in 1987, Apple HyperCard was a revolutionary "software construction kit" that empowered even non-programmers to build databases, interactive fiction games (such as *Myst* and *The Manhole*), educational software, and interface prototypes using the metaphor of "Card Stacks."

**HexCard** resurrects HyperCard to 2026 standards while preserving the true architectural depth that elevated it far beyond a simple slide presentation:

1. **Zero Compilation Overhead (Immediate Mode Authoring):** There is no distinction between design mode and runtime. The moment the user selects the **Browse (Hand)** tool from the palette, the application is live; the moment they select the **Button**, **Field**, or **Paint** tools, they edit interface layout and logic live.
2. **Background Layer Inheritance & `sharedText` Semantics:** Cards are not isolated standalone pages; they share a common `HexBackground` template (graphics, buttons, and text fields). A background text field appears in the exact same position across all cards, but if `sharedText: false`, each card stores its own record data (database record semantics); if `sharedText: true`, it displays the same static text across all cards.
3. **Hallucination-Free Natural Language Programming (NL-to-HexAST):** When a user right-clicks a component and writes *"On click, transition to card 3 with a 'dissolve' effect, increase score by 10, and play notes C4-E4-G4 on 'harpsichord'"*, the AI layer compiles this directly into a safe, deterministic **HexScriptAST** (Abstract Syntax Tree) structure and human-readable **HexTalk** code.
4. **Mathematical 1-Bit Pixel Fidelity:** The rendering engine does not rely on CSS filters for a fake retro look; it executes Bill Atkinson's original error-diffusion dithering algorithm, 38 classic Macintosh `8x8` bit patterns, and genuine **Galois LFSR (Linear Feedback Shift Register)**-based pixel-by-pixel `dissolve` transitions.

---

## 2. Core Data Model & 5-Layer Architecture

HexCard's runtime hierarchy consists of 5 layers:

~~~text
[ HexStack (Stack / Application Root) ]
   ├── Global State (Variables, Custom Icons, Sound Banks, Theme Palette)
   ├── [ HexBackground (Shared Template Layer - 1..N) ]
   │      ├── Background Bitmap Layer (512x342 1-bit shared pixel art)
   │      ├── Background Parts (Common Buttons / Fields visible across all cards)
   │      └── Background Script (Shared event handlers inherited by child cards)
   └── [ HexCard (Individual Screen / Record Layer - 1..M, bound to a Background) ]
          ├── Card Bitmap Layer (512x342 1-bit card-specific transparent/masked pixel art)
          ├── Background Field Overrides (Per-card data for fields with sharedText: false)
          ├── Card Parts (Card-specific Buttons / Fields / Widgets visible only on this card)
          └── Card Script (Card-specific event handlers)
~~~

### 2.1. Exact TypeScript Data Schema (`src/core/schema.ts`)

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
   * RLE (Run-Length Encoding) + Base64 compressed 1-bit color and 1-bit mask data.
   * Decompressed at runtime into a Uint8Array (0 = Transparent, 1 = White/Opaque, 2 = Black/Opaque).
   */
  rleData: string;
}

export type PartType = "button" | "field" | "canvasWidget" | "timer";

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
  scriptSource: string;           // Human-readable HexTalk source code
  naturalLanguagePrompt?: string; // Last AI prompt entered by the user
  compiledAst: HexScriptAST;      // Deterministic AST executed by the virtual machine
}

export interface HexButtonPart extends HexPartBase {
  type: "button";
  style: ButtonStyle;
  title: string;
  showName: boolean;
  iconId?: string;                // 32x32 1-bit sprite icon reference
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
  textFont: "Chicago" | "Geneva" | "Monaco" | "NewYork";
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
  compiledAst: HexScriptAST;
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
  compiledAst: HexScriptAST;
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
    name: "ClassicPaper" | "AmberCRT" | "GreenPhosphor" | "MidnightHex";
    darkBitHex: string;           // Classic: "#000000" | Amber: "#1A1000" | Green: "#041804"
    lightBitHex: string;          // Classic: "#FFFFFF" | Amber: "#FFB000" | Green: "#33FF33"
  };
  backgrounds: HexBackground[];
  cards: HexCard[];               // Sequential card array (Index 0 = First Card)
  customIcons: Record<string, string>; // 32x32 1-bit Base64 icon library
  scriptSource: string;
  compiledAst: HexScriptAST;
}
~~~

---

## 3. The Message Path & Event Bubbling Hierarchy

In the HyperCard architecture, every interaction generates a **Message**. If a component does not handle the message or explicitly executes `pass <eventName>`, the message automatically bubbles up to the next layer in the hierarchy:

~~~text
[ User Click / Keyboard / System Lifecycle Event ]
         │
         ▼
1. Target Component (HexPart: Button or Field with lockText=true)
         │  (If no handler exists or if "pass" was executed)
         ▼
2. Active Card (HexCard)
         │  (If no handler exists or if "pass" was executed)
         ▼
3. Active Background (HexBackground)
         │  (If no handler exists or if "pass" was executed)
         ▼
4. Active Stack (HexStack)
         │  (If no handler exists or if "pass" was executed)
         ▼
5. Built-in Runtime Handlers (HexEngine Built-in Runtime Handlers)
~~~

### 3.1. Supported System Events
* **Mouse Interactions:** `mouseDown`, `mouseStillDown`, `mouseUp`, `mouseEnter`, `mouseWithin`, `mouseLeave`, `mouseDoubleClick`
* **Lifecycle:** `openStack`, `closeStack`, `openBackground`, `closeBackground`, `openCard`, `closeCard`, `newCard`, `deleteCard`
* **Field & Keyboard:** `openField`, `closeField` (when content changed and exited), `exitField` (when exited without changes), `keyDown`, `returnInField`, `enterInField`
* **Game & Animation Loop:** `idle` (Background loop triggered every 200ms when in Browse mode and no active script is executing)

---

## 4. HexTalk / HexAST Deterministic Runtime & AI Compiler

For security and stability, HexCard **never executes user scripts or AI outputs via `eval()` or `new Function()`**. All logic is interpreted by a step-budgeted (gas-limited) virtual machine operating over a deterministic Abstract Syntax Tree (**HexScriptAST**).

### 4.1. HexTalk EBNF Grammar Summary

~~~ebnf
Script        ::= { Handler } ;
Handler       ::= "on" Identifier [ IdentifierList ] Newline { Statement } "end" Identifier ;
Statement     ::= GoCmd | PutCmd | SetCmd | AddSubCmd | VisualCmd | PlayCmd
                | AnswerCmd | AskCmd | WaitCmd | FetchCmd | IfBlock | RepeatBlock | PassCmd ;

GoCmd         ::= "go" [ "to" ] ( "next" "card" | "prev" "card" | "first" "card" | "last" "card"
                | "card" Expression ) ;
VisualCmd     ::= "visual" [ "effect" ] EffectName [ SpeedName ] ;
PutCmd        ::= "put" Expression ( "into" | "after" | "before" ) TargetContainer ;
AddSubCmd     ::= ( "add" Expression "to" | "subtract" Expression "from" ) TargetContainer ;
SetCmd        ::= "set" [ "the" ] PropertyName "of" ObjectSpec "to" Expression ;
PlayCmd       ::= "play" SoundVoice [ "tempo" Number ] NoteSequenceString ;
AnswerCmd     ::= "answer" Expression [ "with" Expression [ "or" Expression [ "or" Expression ] ] ] ;
AskCmd        ::= "ask" Expression [ "with" Expression ] ;
FetchCmd      ::= "fetch" Expression "into" TargetContainer ;
IfBlock       ::= "if" Expression "then" Newline { Statement } [ "else" Newline { Statement } ] "end" "if" ;
RepeatBlock   ::= "repeat" ( "with" Identifier "=" Expression "to" Expression | "while" Expression | Expression [ "times" ] )
                  Newline { Statement } "end" "repeat" ;
PassCmd       ::= "pass" Identifier ;
~~~

### 4.2. Deterministic AST Schema (`src/core/ast.ts`)

~~~typescript
export interface HexScriptAST {
  handlers: Record<string, HexHandlerNode>; // e.g.: { "mouseup": HexHandlerNode, "opencard": HexHandlerNode }
}

export interface HexHandlerNode {
  eventName: string;
  params: string[];
  body: HexStatementNode[];
}

export type HexStatementNode =
  | {
      kind: "GoToCard";
      target:
        | { type: "relative"; dir: "next" | "prev" | "first" | "last" | "back" }
        | { type: "id" | "name" | "index"; value: HexExprNode };
    }
  | { kind: "QueueVisualEffect"; effect: VisualEffectType; speed: VisualEffectSpeed }
  | { kind: "PutValue"; mode: "into" | "after" | "before"; value: HexExprNode; destination: HexContainerTarget }
  | { kind: "MathMutation"; op: "add" | "subtract" | "multiply" | "divide"; amount: HexExprNode; destination: HexContainerTarget }
  | { kind: "SetProperty"; property: string; target: HexObjectTarget; value: HexExprNode }
  | { kind: "PlaySound"; voice: "harpsichord" | "boing" | "flute" | "square8bit" | "click"; tempo: number; notes: string }
  | { kind: "ShowAnswerDialog"; prompt: HexExprNode; buttons: HexExprNode[] } // Writes chosen button to variable "it"
  | { kind: "ShowAskDialog"; prompt: HexExprNode; defaultAnswer?: HexExprNode } // Writes entered text to variable "it"
  | { kind: "Wait"; ticks: HexExprNode } // 1 tick = 1/60th second (16.67ms)
  | { kind: "FetchJson"; url: HexExprNode; jsonPath?: string; destination: HexContainerTarget }
  | { kind: "IfCondition"; condition: HexExprNode; thenBranch: HexStatementNode[]; elseBranch?: HexStatementNode[] }
  | {
      kind: "RepeatLoop";
      loopType: "count" | "while" | "range";
      varName?: string;
      start?: HexExprNode;
      end?: HexExprNode;
      condition?: HexExprNode;
      body: HexStatementNode[];
    }
  | { kind: "PassEvent"; eventName: string };

export type HexContainerTarget =
  | { scope: "variable"; name: string } // Includes local variable "it"
  | { scope: "field"; layer: "card" | "background"; identifier: string | number };

export type HexObjectTarget =
  | { objectType: "button" | "field"; layer: "card" | "background"; identifier: string | number }
  | { objectType: "card" | "background" | "stack"; identifier?: string | number };

export type HexExprNode =
  | { kind: "Literal"; value: string | number | boolean }
  | { kind: "Variable"; name: string } // "it", "the date", "the time", "the mouseH", "the mouseV", "the random of N"
  | { kind: "ReadContainer"; source: HexContainerTarget }
  | { kind: "ReadProperty"; property: string; target: HexObjectTarget }
  | {
      kind: "BinaryOp";
      op: "+" | "-" | "*" | "/" | "mod" | "&&" | "&" | "=" | "!=" | "isGreaterThan" | "isLessThan" | "contains" | "and" | "or";
      left: HexExprNode;
      right: HexExprNode;
    }
  | { kind: "UnaryOp"; op: "not" | "-"; operand: HexExprNode };
~~~

### 4.3. Virtual Machine Sandbox Guardrails
* **Instruction Gas Limit:** Each event trigger can evaluate at most `10,000` AST nodes. If the limit is exceeded, the virtual machine terminates execution, preserves current stack state, and displays the classic System 7 bomb error dialog (*"Sorry, a script error occurred: Loop exceeded 10,000 steps"*).
* **Special `"it"` Variable:** True to HyperCard convention, commands such as `ask`, `answer`, `get`, and `fetch` always write their output into the local `it` variable of the active handler.
* **Bi-directional Synchronization (NL <-> HexTalk <-> HexAST):** When the user enters a natural language prompt, the LLM outputs both the `HexScriptAST` JSON structure and human-readable `HexTalk` code; when the user manually edits `HexTalk` code, the built-in parser (`parser.ts`) immediately updates the AST.

---

## 5. Visual Engine: 1-Bit Aesthetics, Atkinson Dithering & Transition Algorithms

### 5.1. Bill Atkinson Dithering Algorithm (`src/engine/graphics/atkinsonDither.ts`)
When the user drags and drops a color image or generates an image using AI, the image is scaled to `512x342` resolution and converted to 1-bit pixels using Bill Atkinson's original error-diffusion matrix. Unlike the Floyd-Steinberg algorithm, Atkinson dithering diffuses only **6/8 (75%)** of the quantization error to neighbor pixels; this prevents muddy clustering on 1-bit displays, yielding high-contrast, crisp edges:

~~~text
          [ * ]   1/8    1/8
   1/8     1/8    1/8
           1/8
~~~

~~~typescript
export function applyAtkinsonDithering(
  grayscaleBuffer: Float32Array,
  width: number,
  height: number,
  threshold = 128
): Uint8Array {
  const out = new Uint8Array(width * height);
  const lum = new Float32Array(grayscaleBuffer);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const oldPixel = lum[idx];
      const newPixel = oldPixel < threshold ? 0 : 255;
      out[idx] = newPixel === 0 ? 2 : 1; // 2 = Black Bit, 1 = White Bit

      const err = (oldPixel - newPixel) / 8; // 1/8th of error

      if (x + 1 < width) lum[idx + 1] += err;
      if (x + 2 < width) lum[idx + 2] += err;
      if (y + 1 < height) {
        if (x - 1 >= 0) lum[(y + 1) * width + (x - 1)] += err;
        lum[(y + 1) * width + x] += err;
        if (x + 1 < width) lum[(y + 1) * width + (x + 1)] += err;
      }
      if (y + 2 < height) {
        lum[(y + 2) * width + x] += err;
      }
    }
  }
  return out;
}
~~~

### 5.2. Authentic `visual effect dissolve` Based on Galois LFSR (`src/engine/graphics/lfsrDissolve.ts`)
Because 1-bit displays lack grayscales or alpha blending, card-to-card `dissolve` transitions are performed using an **18-bit Galois Linear Feedback Shift Register (LFSR)**. This algorithm visits every single pixel in the `512 x 342 = 175,104` frame in a pseudo-random order without visiting any pixel twice, copying pixels from the old card to the new card:

~~~typescript
// 18-bit maximal-period (2^18 - 1 = 262,143) Galois LFSR polynomial mask: 0x20400
export function stepDissolveFrame(
  currentFrameBuffer: Uint32Array,
  targetFrameBuffer: Uint32Array,
  totalPixels: number,
  lfsrStateRef: { state: number },
  pixelsPerFrame: number
): boolean {
  let state = lfsrStateRef.state;
  let copied = 0;

  while (copied < pixelsPerFrame) {
    const lsb = state & 1;
    state >>= 1;
    if (lsb !== 0) {
      state ^= 0x20400; // 18-bit maximal length tap
    }
    if (state < totalPixels) {
      currentFrameBuffer[state] = targetFrameBuffer[state];
      copied++;
    }
    if (state === 1) {
      currentFrameBuffer[0] = targetFrameBuffer[0];
      lfsrStateRef.state = 1;
      return true; // Transition complete
    }
  }
  lfsrStateRef.state = state;
  return false;
}
~~~

### 5.3. World-Space Locked 8x8 Bit Patterns (`src/engine/graphics/patterns.ts`)
The paint bucket and brush tools utilize 38 classic Macintosh patterns, each defined by an 8-byte (`Uint8Array(8)`) bitmask. A pattern bit is locked directly to canvas world coordinates using the formula `const bit = (pattern[y & 7] >> (7 - (x & 7))) & 1;`, preventing pattern drift or misalignment across overlapping brush strokes.

---

## 6. WebAudio Procedural Sound Synthesizer (`src/engine/audio/synth.ts`)

A procedural sound engine running entirely on `AudioContext` without requiring external MP3/WAV files:
1. **`harpsichord`:** Uses the Karplus-Strong physical modeling plucked-string algorithm (short noise burst + low-pass feedback delay line) to synthesize authentic 1987 harpsichord timbre.
2. **`boing`:** Applies exponential pitch envelope sliding and low-frequency modulation (LFO) across a sine oscillator.
3. **`flute` & `square8bit`:** Triangle-wave synthesizer with ADSR envelope and pulse-width modulated (PWM) 8-bit square-wave synthesizer.
4. **Note Sequence Parser:** Parses and plays note sequences in the format `play "harpsichord" tempo 140 "c4q e4q g4h c5w"` with millisecond-accurate scheduling (`w`=whole note, `h`=half note, `q`=quarter note, `e`=eighth note, `s`=sixteenth note, `.`=dotted duration extension).

---

## 7. User Interface (System 7 GUI) & Dual-Mode Authoring Architecture

1. **Top Menu Bar:** Hosts `Hex`, `File`, `Edit`, `Go`, `Tools`, `Objects`, `Paint`, and `AI Conjure` menus.
2. **Tear-Off Floating Tools Palette:** When the user drags downward from the `Tools` menu header, the menu tears off into a draggable, floating 12-tool palette window.
3. **Background Editing Mode (`Edit Background` / `Cmd+B`):** When active, classic **thick diagonal hash marks (stripes)** appear around the menu bar border. In this mode, all drawing actions and newly created components are committed directly to the active `HexBackground` layer.
4. **Object Inspector & HexAI Spellcaster:** Double-clicking any button or field opens a modal dialog exposing visual component properties, the **HexTalk** script editor, and the **HexAI Spellcaster** natural-language-to-AST prompt input.
5. **Interactive Stack Graph Modal:** Renders all cards in the stack as an interactive node graph with miniature 1-bit previews and directional `GoToCard` transition arrows.

---

## 8. Kiro IDE Integration Specification (`.kiro/` Directory Structure)

To ensure full compliance with Kiroween evaluation criteria, the following `.kiro` architecture is maintained at the project root:

~~~text
.kiro/
├── steering/
│   ├── product.md               # Product vision, 5-layer HyperCard rules, and terminology glossary
│   ├── tech.md                  # Technology stack, 1-bit rendering constraints, eval() prohibition
│   └── structure.md             # Module boundaries and layered architecture rules
├── specs/
│   ├── 01-core-stack-engine/
│   │   ├── requirements.md      # Acceptance criteria in EARS notation
│   │   ├── design.md            # Data structures and message passing diagrams
│   │   └── tasks.md             # Traceable subtask list
│   ├── 02-hextalk-ast-vm/
│   │   ├── requirements.md
│   │   ├── design.md
│   │   └── tasks.md
│   └── 03-1bit-canvas-dither/
│       ├── requirements.md
│       ├── design.md
│       └── tasks.md
└── hooks/
    ├── validate-ast-safety.json # Validates eval() ban and VM step limit when src/core/** changes
    └── enforce-1bit-ui.json     # Blocks blurry shadows and gradients when src/ui/** changes
~~~

### 8.1. EARS-Notation Requirements Template (`.kiro/specs/01-core-stack-engine/requirements.md`)

~~~markdown
# Requirements: Core Stack & Message Passing Engine

## REQ-1: Background Layer Inheritance & SharedText Semantics
- **User Story:** As a stack designer, I want multiple cards to share a common background template while allowing data fields to hold card-specific text.
- **Acceptance Criteria (EARS):**
  1. WHEN a `HexCard` is rendered, THE SYSTEM SHALL composite the linked `HexBackground` bitmap and background parts underneath the card's own bitmap and card parts.
  2. WHERE a background `HexFieldPart` has `sharedText` set to `false`, WHEN the user or a script modifies the field's text on a specific card, THE SYSTEM SHALL store and retrieve the text from `HexCard.bgFieldContents[fieldId]` without mutating other cards sharing that background.
  3. WHERE a background `HexFieldPart` has `sharedText` set to `true`, WHEN the field's text is modified on any card, THE SYSTEM SHALL update `HexFieldPart.content` on the `HexBackground` so all cards sharing that background reflect the change immediately.

## REQ-2: Deterministic Message Passing Hierarchy
- **User Story:** As an application developer, I want unhandled events on a component to propagate automatically up to Card, Background, and Stack layers.
- **Acceptance Criteria (EARS):**
  1. WHEN an interaction event (e.g., `mouseUp`) is triggered on a `HexPart` while the active tool is `browse`, THE SYSTEM SHALL execute the matching handler in `HexPart.compiledAst` if defined.
  2. IF the target `HexPart` does not define a handler for the event OR executes a `PassEvent` statement, THEN THE SYSTEM SHALL propagate the event up the hierarchy in the exact order: `HexCard` -> `HexBackground` -> `HexStack` -> `HexRuntimeBuiltIns`.

## REQ-3: Step-Budgeted Sandboxed Execution
- **User Story:** As a platform user, I want card scripts containing bugs or infinite loops to not freeze the browser.
- **Acceptance Criteria (EARS):**
  1. WHILE the HexAST Virtual Machine is executing an event handler chain, THE SYSTEM SHALL increment an instruction counter for every evaluated AST node.
  2. IF the instruction counter exceeds `10,000` steps within a single event dispatch, THEN THE SYSTEM SHALL halt execution immediately, preserve current stack state, and display a retro System 7 script error modal pointing to the offending handler.
~~~

### 8.2. Kiro Agent Hook Definition (`.kiro/hooks/validate-ast-safety.json`)

~~~json
{
  "name": "Validate HexAST Sandbox & Schema Integrity",
  "description": "Verifies no dynamic code execution (eval/Function) is introduced and unit tests pass when core VM and AST files are updated.",
  "trigger": {
    "type": "file_save",
    "patterns": ["src/core/**/*.ts", "src/ai/**/*.ts"]
  },
  "action": {
    "type": "agent_prompt",
    "prompt": "Inspect the modified file: 1) Verify that under no circumstances eval(), new Function(), or unsafe DOM injections are used. 2) Ensure that any newly added AST nodes increment the instruction gas-limit counter in src/core/vm.ts. 3) Fix any discrepancies if found."
  }
}
~~~

---

## 9. Application Directory Structure & Jury Showcase Stacks

~~~text
hexcard/
├── .kiro/                         # Kiro Spec, Steering, and Hook files
├── src/
│   ├── core/
│   │   ├── schema.ts              # Stack, Background, Card, Part data models
│   │   ├── ast.ts                 # HexScriptAST node types
│   │   ├── vm.ts                  # Step-budgeted (gas-limited) async AST interpreter
│   │   ├── parser.ts              # Bi-directional HexTalk <-> HexScriptAST converter
│   │   ├── messageBus.ts          # Part -> Card -> Background -> Stack event bubbling
│   │   └── history.ts             # 50-step Undo/Redo Command Pattern ring buffer
│   ├── engine/
│   │   ├── graphics/
│   │   │   ├── bitmapCanvas.ts    # 512x342 1-bit dual-layer (Background + Card) compositor
│   │   │   ├── atkinsonDither.ts  # Bill Atkinson error diffusion engine for image import
│   │   │   ├── patterns.ts        # 38 8x8 classic Mac bitmasks and flood-fill
│   │   │   └── lfsrDissolve.ts    # Galois LFSR Dissolve, Venetian Blinds, Iris, Checkerboard
│   │   └── audio/
│   │       └── synth.ts           # WebAudio Karplus-Strong Harpsichord & 8-bit sound synth
│   ├── ai/
│   │   ├── spellcaster.ts         # Service compiling natural language prompts into deterministic HexScriptAST
│   │   └── stackGenerator.ts      # Multi-card micro-app/game generator from a single prompt
│   ├── storage/
│   │   ├── indexedDb.ts           # Local automatic persistence
│   │   ├── urlCodec.ts            # Serverless sharing via compressed URL Hash
│   │   └── htmlExporter.ts        # Bundler packaging stack into a standalone runnable .html file
│   ├── presets/
│   │   ├── hauntedMansion.ts      # 1) "The Haunted Stack of 1987": 1-bit horror/puzzle adventure game
│   │   ├── retroSynthDeck.ts      # 2) "HexSynth Sequencer": Harpsichord and 8-bit music sequencer
│   │   └── apiWeatherOracle.ts    # 3) "MacOracle 1987": Live API data-fetching retro desktop dashboard
│   └── ui/
│       ├── System7Shell.tsx       # Menu bar, window chrome, and CRT/Classic theme switcher
│       ├── FloatingTools.tsx      # Tear-off classic 12-tool HyperCard palette
│       ├── CardViewport.tsx       # Canvas + Interactive Part layer
│       ├── ObjectInspector.tsx    # Property inspector + HexAI Spellcaster interface
│       └── StackGraphModal.tsx    # Visual interactive node graph of stack cards
└── package.json
~~~
