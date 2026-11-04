# HexCard — System Architecture & Design Specification

* **Project Name:** HexCard (HyperCard Resurrection & AI-Native Micro-App Studio)
* **Target Event:** Kiroween 2026 Hackathon
* **Hackathon Category:** **Resurrection** *(Reviving a dead technology in the modern era)*. The Kiroween 2026 Official Rules allow exactly one main category per submission; any bonus category is selected separately at submission time.
* **Target Platform:** Web (Zero-Backend Client Runtime + Single-File HTML/JSON Distribution). A Tauri v2 desktop wrapper is a post-hackathon stretch goal, not part of the submission scope.
* **Document Role:** This file is the **canonical source for cross-cutting data contracts**: the persisted schema (§2.1), the HexTalk grammar and AST (§4.1–4.2), the runtime concurrency model (§3.2) and the bitmap codec (§5.4). The Kiro specs in `.kiro/specs/` reference these sections instead of copying them. On any conflict, this file wins and the spec must be corrected.

---

## 1. Product Vision & Core Engineering Philosophy

Developed by Bill Atkinson in 1987, Apple HyperCard was a revolutionary "software construction kit" that empowered even non-programmers to build databases, interactive fiction games (such as *Myst* and *The Manhole*), educational software, and interface prototypes using the metaphor of "Card Stacks."

**HexCard** resurrects HyperCard to 2026 standards while preserving the true architectural depth that elevated it far beyond a simple slide presentation:

1. **Zero Compilation Overhead (Immediate Mode Authoring):** There is no distinction between design mode and runtime. The moment the user selects the **Browse (Hand)** tool from the palette, the application is live; the moment they select the **Button**, **Field**, or **Paint** tools, they edit interface layout and logic live.
2. **Background Layer Inheritance & `sharedText` Semantics:** Cards are not isolated standalone pages; they share a common `HexBackground` template (graphics, buttons, and text fields). A background text field appears in the exact same position across all cards, but if `sharedText: false`, each card stores its own record data (database record semantics); if `sharedText: true`, it displays the same static text across all cards.
3. **Sandbox-Safe, Schema-Validated Natural Language Programming (NL-to-HexAST):** When a user right-clicks a component and writes *"On click, transition to card 3 with a 'dissolve' effect, increase score by 10, and play notes C4-E4-G4 on 'harpsichord'"*, the AI layer produces a **HexScriptAST** (Abstract Syntax Tree) that is validated against the AST schema before it is accepted; the human-readable **HexTalk** code is then printed deterministically from that AST. The guarantee is *safety* (the output can only do what the sandboxed VM allows), not *correctness*: an AI layer can still misread the user's intent, so the generated HexTalk is always shown for review before it is applied.
4. **Mathematical 1-Bit Pixel Fidelity:** The rendering engine does not rely on CSS filters for a fake retro look; it executes Bill Atkinson's original error-diffusion dithering algorithm, 38 classic Macintosh `8x8` bit patterns, and genuine **Galois LFSR (Linear Feedback Shift Register)**-based pixel-by-pixel `dissolve` transitions.

---

## 2. Core Data Model & 5-Layer Architecture

HexCard's runtime hierarchy consists of 5 layers:

~~~text
[ HexStack (Stack / Application Root) ]
   ├── Stack-wide Data (Custom Icons, Theme Palette) + runtime-only `global` variables (never persisted)
   ├── [ HexBackground (Shared Template Layer - 1..N) ]
   │      ├── Background Bitmap Layer (512x342 1-bit shared pixel art)
   │      ├── Background Parts (Common Buttons / Fields visible across all cards)
   │      └── Background Script (Shared event handlers inherited by child cards)
   └── [ HexCard (Individual Screen / Record Layer - 1..M, bound to a Background) ]
          ├── Card Bitmap Layer (512x342 1-bit card-specific transparent/masked pixel art)
          ├── Background Field Overrides (Per-card data for fields with sharedText: false)
          ├── Card Parts (Card-specific Buttons / Fields visible only on this card)
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
  customIcons: Record<string, string>; // 32x32 1-bit Base64 icon library
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

---

## 3. The Message Path & Event Bubbling Hierarchy

In the HyperCard architecture, every interaction generates a **Message**. If a component does not handle the message, or its handler executes `pass <eventName>`, the message bubbles up to the next layer in the hierarchy:

~~~text
[ User Click / Keyboard / System Lifecycle Event ]
         │
         ▼
1. Target Component (HexPart: Button, or Field with lockText=true)
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

* **"Handled" rule:** a message is handled by the first object on the path whose compiled script has a handler for it (handler names are matched case-insensitively). Propagation stops there unless that handler executes `pass`.
* **`pass` semantics:** `pass <eventName>` ends the current handler immediately (statements after it never run) and forwards the *same* message with the *same* parameters to the next object on the path. `pass` naming a different message than the enclosing handler is a compile error.
* **Built-in handlers (layer 5):** unhandled messages are ignored, with one HyperCard default: `keyDown` with the Left/Right arrow key goes to the previous/next card.
* **Message targets:** mouse messages target the part under the pointer, or the card when no part is hit. In Browse mode, clicks inside an *unlocked* field place the text caret and send no mouse messages (HyperCard behaviour). `idle` and lifecycle messages start at the card.

### 3.1. Supported System Events
* **Mouse Interactions:** `mouseDown`, `mouseStillDown`, `mouseUp`, `mouseEnter`, `mouseWithin`, `mouseLeave`, `mouseDoubleClick`
* **Lifecycle:** `openStack`, `closeStack`, `openBackground`, `closeBackground`, `openCard`, `closeCard`, `newCard`, `deleteCard`
* **Field & Keyboard:** `openField`, `closeField` (when content changed and exited), `exitField` (when exited without changes), `keyDown`, `returnInField`, `enterInField`
* **Game & Animation Loop:** `idle` (sent every 200 ms under the conditions in §3.2)

### 3.2. Runtime Concurrency Model (`src/core/messageBus.ts`)

HexCard's runtime is single-threaded like HyperCard's. The rules below are normative:

1. **One dispatch at a time.** A *dispatch* is the delivery of one message along the path of §3 until it is handled. The runtime owns a FIFO queue of pending messages and runs exactly one dispatch at a time.
2. **Suspension points.** `wait`, `answer`, `ask`, `fetch` and the playback of a visual effect during `go` suspend the running dispatch (`await`). A suspended dispatch still counts as running: no other dispatch starts until it finishes.
3. **Queue policy while a dispatch runs.**
   - Discrete events (`mouseDown`, `mouseUp`, `mouseDoubleClick`, `mouseEnter`, `mouseLeave`, `keyDown`, `returnInField`, `enterInField`, `openField`, `closeField`, `exitField`) are queued in arrival order. The queue holds at most 32 entries; on overflow the oldest entry is dropped and a console warning is logged.
   - Continuous events (`mouseStillDown`, `mouseWithin`, `idle`) are coalesced: at most one pending entry of each kind.
4. **`idle` condition.** `idle` is sent every 200 ms only when all of these hold: the Browse tool is active, the queue is empty, no dispatch is running, no modal dialog is open, and the page is visible (`document.visibilityState === "visible"`).
5. **Nested messages.** `go` sends `closeCard` (and `closeBackground`/`openBackground` when the background changes) and `openCard` immediately, as *nested* dispatches inside the current dispatch, not through the queue. Nested dispatches share the parent's gas budget (§4.3). Nesting deeper than 16 levels aborts the dispatch with the script error "Too much recursion".
6. **Card context during a handler.** Field and card references are resolved against the *current* card at the moment they are evaluated, so statements after a `go` see the new card (HyperCard semantics). `me` always stays bound to the object that owns the running handler, addressed by its id.
7. **Visual effect queue.** `visual effect` stores one pending effect (the last one wins). The next `go` in the same dispatch consumes it; an unconsumed effect is discarded when the dispatch ends.
8. **Abort.** `Cmd+.` / `Ctrl+.` (HyperCard's abort shortcut) aborts the running dispatch and clears the queue. Switching from Browse to any authoring tool does the same.
9. **State writes.** The VM never mutates the stack object directly. It calls `store.applyRuntime(mutation)` (see `.kiro/specs/01-core-stack-engine/design.md`). Runtime writes are auto-saved but are not part of the undo history.

---

## 4. HexTalk / HexAST Deterministic Runtime & AI Compiler

For security and stability, HexCard **never executes user scripts or AI outputs via `eval()` or `new Function()`**. All logic is interpreted by a step-budgeted (gas-limited) virtual machine operating over a deterministic Abstract Syntax Tree (**HexScriptAST**).

### 4.1. HexTalk Grammar (canonical, EBNF)

**Lexical rules**
- Keywords, identifiers and handler names are case-insensitive. Identifiers are stored lowercase in the AST; a handler keeps its original spelling in `eventName` and is keyed in lowercase.
- `--` starts a comment that runs to the end of the line. Blank lines are ignored. A newline ends a statement.
- `Identifier ::= Letter { Letter | Digit | "_" }` and must not be a reserved word (every quoted word in this grammar is reserved).
- `NumberLiteral ::= Digit { Digit } [ "." Digit { Digit } ]`
- `StringLiteral ::= '"' { any character except '"' and newline } '"'` — there are no escape sequences; the constant `quote` produces a double quote.

~~~ebnf
Script        ::= { Handler } ;
Handler       ::= "on" Identifier [ Identifier { "," Identifier } ] Newline
                  StatementList
                  "end" Identifier ;            (* closing name must equal the opening name *)
StatementList ::= { Statement Newline } ;

Statement     ::= GoCmd | VisualCmd | PutCmd | GetCmd | MathCmd | SetCmd | PlayCmd
                | AnswerCmd | AskCmd | WaitCmd | FetchCmd | GlobalCmd
                | IfStmt | RepeatBlock | PassCmd | ExitCmd | NextRepeatCmd ;

GoCmd         ::= "go" [ "to" ] ( ( "next" | "prev" | "previous" | "first" | "last" ) [ "card" ]
                                | "back"
                                | "card" "id" Primary
                                | "card" Primary ) ;      (* number => 1-based position, otherwise card name *)
VisualCmd     ::= "visual" [ "effect" ] EffectName [ SpeedName ] ;
PutCmd        ::= "put" Expression ( "into" | "after" | "before" ) Container ;
GetCmd        ::= "get" Expression ;                       (* writes the value into it *)
MathCmd       ::= "add" Expression "to" Container
                | "subtract" Expression "from" Container
                | "multiply" Container "by" Expression
                | "divide" Container "by" Expression ;
SetCmd        ::= "set" [ "the" ] PropertyName "of" ObjectRef "to" Expression ;
PlayCmd       ::= "play" ( VoiceName | '"' VoiceName '"' ) [ "tempo" NumberLiteral ] StringLiteral ;
AnswerCmd     ::= "answer" Expression [ "with" ConcatExpr [ "or" ConcatExpr [ "or" ConcatExpr ] ] ] ;
AskCmd        ::= "ask" Expression [ "with" Expression ] ;
WaitCmd       ::= "wait" Expression [ "tick" | "ticks" | "second" | "seconds" ] ;   (* default unit: ticks *)
FetchCmd      ::= "fetch" Expression [ "at" StringLiteral ] "into" Container ;     (* "at" = JSON path, §4.3 *)
GlobalCmd     ::= "global" Identifier { "," Identifier } ;
IfStmt        ::= "if" Expression "then"
                  ( Statement                                   (* single-line form, no else *)
                  | Newline StatementList [ "else" Newline StatementList ] "end" "if" ) ;
RepeatBlock   ::= "repeat" [ RepeatHead ] Newline StatementList "end" "repeat" ;
RepeatHead    ::= "with" Identifier "=" Expression ( "to" | "down" "to" ) Expression
                | "while" Expression
                | "until" Expression
                | "forever"
                | [ "for" ] Expression [ "times" ] ;      (* bare "repeat" = forever *)
PassCmd       ::= "pass" Identifier ;                      (* must equal the enclosing handler's name *)
ExitCmd       ::= "exit" ( "repeat" | Identifier ) ;       (* "exit <handlerName>" ends the handler *)
NextRepeatCmd ::= "next" "repeat" ;

Container     ::= Identifier                               (* local variable, declared global, or it *)
                | FieldRef ;
FieldRef      ::= [ CardWord | BgWord ] ( "field" | "fld" ) PartSelector ;   (* no layer word = background field, as in HyperCard *)
ButtonRef     ::= [ CardWord | BgWord ] ( "button" | "btn" ) PartSelector ;  (* no layer word = card button, as in HyperCard *)
PartSelector  ::= "id" Primary | Primary ;                 (* number => 1-based position within that layer, otherwise name *)
ObjectRef     ::= "me" | ButtonRef | FieldRef
                | "this" "card" | "card" PartSelector
                | "this" ( "background" | "bg" ) | "this" "stack" ;
CardWord      ::= "card" | "cd" ;
BgWord        ::= "background" | "bkgnd" | "bg" ;

Expression    ::= AndExpr { "or" AndExpr } ;
AndExpr       ::= CompareExpr { "and" CompareExpr } ;
CompareExpr   ::= ConcatExpr [ CompareOp ConcatExpr ] ;     (* non-associative *)
CompareOp     ::= "=" | "is" | "<>" | "is" "not" | "<" | ">" | "<=" | ">=" | "contains" ;
ConcatExpr    ::= AddExpr { ( "&" | "&&" ) AddExpr } ;      (* "&&" inserts a space *)
AddExpr       ::= MulExpr { ( "+" | "-" ) MulExpr } ;
MulExpr       ::= UnaryExpr { ( "*" | "/" | "div" | "mod" ) UnaryExpr } ;
UnaryExpr     ::= ( "not" | "-" ) UnaryExpr | Primary ;
Primary       ::= NumberLiteral | StringLiteral | Constant
                | "(" Expression ")"
                | FunctionName "(" [ Expression { "," Expression } ] ")"
                | "the" FunctionName "of" Primary           (* one-argument form, e.g. "the random of 6" *)
                | "the" BuiltInName
                | "the" PropertyName "of" ObjectRef
                | FieldRef                                  (* reads the field's text on the current card *)
                | Identifier ;                              (* variable; an unset variable evaluates to empty *)

Constant      ::= "empty" | "true" | "false" | "quote" | "return" | "space" | "tab" ;
FunctionName  ::= "random" | "round" | "trunc" | "abs" | "length" | "min" | "max" ;
BuiltInName   ::= "date" | "time" | "ticks" | "seconds" | "mouseH" | "mouseV"
                | "number" "of" "cards" | "number" "of" "this" "card" ;
PropertyName  ::= "name" | "visible" | "enabled" | "hilite" | "title" | "showName" | "autoHilite"
                | "location" | "rect" | "style" | "lockText" | "textAlign" | "textFont" | "textSize"
                | "textStyle" | "marked" ;
EffectName    ::= "cut" | "dissolve" | "venetian" "blinds" | "checkerboard" | "iris" ( "open" | "close" )
                | "wipe" ( "left" | "right" | "up" | "down" ) | "barn" "door" ( "open" | "close" ) ;
SpeedName     ::= "very" "slow" | "slow" | "normal" | "fast" ;
VoiceName     ::= "harpsichord" | "boing" | "flute" | "square8bit" | "click" ;
~~~

**Grammar notes**
- In `answer ... with A or B or C`, the button expressions are parsed at `ConcatExpr` level, so the word `or` separates buttons instead of acting as the boolean operator. Use parentheses for a boolean button label.
- `the PropertyName of ...` and `the FunctionName of ...` never collide because the two name sets are disjoint.
- `visual effect` without a `SpeedName` uses the speed `normal`.
- A script may define each handler name only once (names compare case-insensitively). A second handler with the same name is a compile error at its `on` line; the first handler is kept.
- `exit Identifier` follows the same rule as `pass`: the name must equal the enclosing handler's name, otherwise it is a compile error at that line.
- Inside `ObjectRef`, `card field N` (or `card fld N`) is the card-layer field (`CardWord FieldRef`), not a card selected by the field's text (`"card" PartSelector`). To select a card by a field's text, write `card bg field N`.
- Not supported in v2.0.0 (deliberate scope limits): `else if` chains on one line, single-line `if ... then ... else ...`, `send`, `do`, user-defined functions, chunk expressions (`word 2 of ...`).

### 4.2. Deterministic AST Schema (`src/core/ast.ts`)

~~~typescript
import type { VisualEffectType, VisualEffectSpeed } from "./schema";

export interface HexSourceLoc { line: number; column: number } // 1-based; ignored by AST equality

export interface HexScriptAST {
  handlers: Record<string, HexHandlerNode>; // keys are lowercase event names, e.g. "mouseup", "opencard"
}

export interface HexHandlerNode {
  eventName: string;                        // original spelling, e.g. "mouseUp"
  params: string[];                         // lowercase
  body: HexStatementNode[];
  loc?: HexSourceLoc;
}

export type HexVoice = "harpsichord" | "boing" | "flute" | "square8bit" | "click";

export type HexPropertyName =
  | "name" | "visible" | "enabled" | "hilite" | "title" | "showName" | "autoHilite"
  | "location" | "rect" | "style" | "lockText" | "textAlign" | "textFont" | "textSize"
  | "textStyle" | "marked";

/** number => 1-based position within the layer (or stack for cards), anything else => name */
export type HexPartSelector =
  | { by: "id"; value: HexExprNode }
  | { by: "auto"; value: HexExprNode };

export type HexCardTarget =
  | { type: "relative"; dir: "next" | "prev" | "first" | "last" | "back" }
  | { type: "id"; value: HexExprNode }
  | { type: "auto"; value: HexExprNode };

export type HexContainerTarget =
  | { scope: "variable"; name: string }     // lowercase; "it" is the handler-local result variable
  | { scope: "field"; layer: "card" | "background"; selector: HexPartSelector };

export type HexObjectTarget =
  | { objectType: "me" }
  | { objectType: "button" | "field"; layer: "card" | "background"; selector: HexPartSelector }
  | { objectType: "card"; selector?: HexPartSelector } // omitted selector = this card
  | { objectType: "background" }                      // this background
  | { objectType: "stack" };                          // this stack

export type HexRepeatHead =
  | { type: "forever" }
  | { type: "count"; times: HexExprNode }
  | { type: "while"; condition: HexExprNode }
  | { type: "until"; condition: HexExprNode }
  | { type: "range"; varName: string; start: HexExprNode; end: HexExprNode; direction: "up" | "down" };

export type HexStatementNode = (
  | { kind: "GoToCard"; target: HexCardTarget }
  | { kind: "QueueVisualEffect"; effect: VisualEffectType; speed: VisualEffectSpeed }
  | { kind: "PutValue"; mode: "into" | "after" | "before"; value: HexExprNode; destination: HexContainerTarget }
  | { kind: "GetValue"; value: HexExprNode }                                   // writes into "it"
  | { kind: "MathMutation"; op: "add" | "subtract" | "multiply" | "divide"; amount: HexExprNode; destination: HexContainerTarget }
  | { kind: "SetProperty"; property: HexPropertyName; target: HexObjectTarget; value: HexExprNode }
  | { kind: "PlaySound"; voice: HexVoice; tempo: number; notes: string }     // tempo defaults to 120
  | { kind: "ShowAnswerDialog"; prompt: HexExprNode; buttons: HexExprNode[] } // 0..3 buttons (none => "OK"); writes the clicked label into "it"
  | { kind: "ShowAskDialog"; prompt: HexExprNode; defaultAnswer?: HexExprNode } // writes the entered text (or empty on Cancel) into "it"
  | { kind: "Wait"; amount: HexExprNode; unit: "ticks" | "seconds" }          // 1 tick = 1/60 s
  | { kind: "FetchJson"; url: HexExprNode; jsonPath?: string; destination: HexContainerTarget }
  | { kind: "DeclareGlobal"; names: string[] }
  | { kind: "IfCondition"; condition: HexExprNode; thenBranch: HexStatementNode[]; elseBranch?: HexStatementNode[] }
  | { kind: "RepeatLoop"; head: HexRepeatHead; body: HexStatementNode[] }
  | { kind: "PassEvent"; eventName: string }
  | { kind: "ExitHandler" }
  | { kind: "ExitRepeat" }
  | { kind: "NextRepeat" }
) & { loc?: HexSourceLoc };

export type HexBinaryOp =
  | "or" | "and"
  | "=" | "<>" | "<" | ">" | "<=" | ">=" | "contains"
  | "&" | "&&"
  | "+" | "-" | "*" | "/" | "div" | "mod";

export type HexExprNode = (
  | { kind: "Literal"; value: string | number | boolean }
  | { kind: "Constant"; name: "empty" | "quote" | "return" | "space" | "tab" }
  | { kind: "Variable"; name: string }                  // user variable or "it" (lowercase)
  | { kind: "BuiltIn"; name: "date" | "time" | "ticks" | "seconds" | "mouseH" | "mouseV" | "numberOfCards" | "cardNumber" }
  | { kind: "FunctionCall"; name: "random" | "round" | "trunc" | "abs" | "length" | "min" | "max"; args: HexExprNode[] }
  | { kind: "ReadContainer"; source: Extract<HexContainerTarget, { scope: "field" }> } // variables use "Variable"
  | { kind: "ReadProperty"; property: HexPropertyName; target: HexObjectTarget }
  | { kind: "BinaryOp"; op: HexBinaryOp; left: HexExprNode; right: HexExprNode }
  | { kind: "UnaryOp"; op: "not" | "-"; operand: HexExprNode }
) & { loc?: HexSourceLoc };
~~~

**Parser/printer contract (`src/core/parser.ts`)**
- `parseHexTalk(source) -> { ast, errors }` and `printHexTalk(ast) -> source`.
- **Round-trip guarantee 1:** for every AST `A` accepted by the AST schema validator, `parse(print(A))` deep-equals `A` (ignoring `loc`).
- **Round-trip guarantee 2:** for every source `S` that parses without errors, `print(parse(S))` is a canonical form `S'` with `parse(S')` deep-equal to `parse(S)`. The printer normalises synonyms (`is` → `=`, `is not` → `<>`, `previous` → `prev`, `bkgnd`/`background` → `bg`, `fld` → `field`, `btn` → `button`), always prints the block form of `if`, always prints explicit layer words, indents with 2 spaces and adds only the parentheses that precedence requires.
- The AST schema validator rejects string literals containing `"` or a newline (they cannot be printed as a single HexTalk literal), unknown property/voice/effect names, `pass` with a foreign event name, and `PlaySound.tempo` outside `20..400`.
- `ast.ts` exports `HEX_MAX_DEPTH = 256`, the maximum nesting depth of AST nodes (statement blocks and expressions counted together along any path from a handler). `validateAst` rejects deeper ASTs and `parseHexTalk` reports a compile error 'script is nested too deeply' at the first token beyond the limit, so both round-trip guarantees hold at every accepted depth.
- A parenthesised expression directly inside another pair of parentheses counts as one extra level, so redundant nested parentheses cannot bypass the limit; the printer never emits such pairs.
- Both guarantees are enforced by property-based tests (fast-check) in `src/core/__tests__/parser.roundtrip.test.ts`.

### 4.3. Virtual Machine Semantics & Sandbox Guardrails (`src/core/vm.ts`)
* **Instruction Gas Limit:** every evaluated statement node and expression node costs 1 step, and every loop iteration costs 1 more step, so a loop with an empty body still runs out of gas. The budget is `10,000` steps per top-level dispatch, shared with its nested dispatches (§3.2 rule 5). On overflow the VM throws `HexVmGasLimitError`, stops the whole dispatch, keeps every mutation already applied (no rollback), and the shell shows the System 7 bomb dialog: *"Sorry, a script error occurred: Loop exceeded 10,000 steps"*, naming the object, handler and line.
* **Script errors:** type errors (arithmetic on a non-number), unknown parts, invalid property/object combinations and similar failures throw `HexScriptError`. The dispatch stops and a System 7 alert shows `object / handler / line / message` with a **Script** button that opens the editor at that line.
* **Values:** a runtime value is `string | number | boolean`. Field contents are always strings. Arithmetic converts numeric-looking strings to numbers and the empty string (an unset variable, an empty field) to `0`; any other non-numeric string is a `HexScriptError`. `=`/`<>` compare numerically when both sides are numeric, otherwise as case-insensitive strings. `contains` is case-insensitive. `true`/`false` are booleans; the strings `"true"`/`"false"` coerce to them in conditions.
* **Variables:** variables are local to the running handler. `it` is a local variable that `get`, `answer`, `ask` and `fetch` write. `global x` makes `x` refer to a runtime-wide global for the rest of the handler; globals live only in memory and are never persisted or exported.
* **Property validity:** `text*` and `lockText` apply only to fields; `hilite`, `title`, `showName` and `autoHilite` only to buttons; `marked` only to cards; `visible`, `enabled`, `location` and `rect` only to parts; `name` to every object. `location` is `"x,y"` (part centre); `rect` is `"left,top,right,bottom"` and is converted to/from `HexRect`.
* **`fetch` network policy:**
  - Only `https:` URLs are allowed (plus `http://localhost` in development builds). The request is always `GET` with `credentials: "omit"` and `referrerPolicy: "no-referrer"`; scripts cannot set headers, so stacks can never carry auth tokens.
  - Timeout 8 s (AbortController); response body cap 256 KB; the body must parse as JSON.
  - JSON path syntax: `Path ::= Key { "." Key | "[" Digits "]" }`, `Key ::= [A-Za-z_][A-Za-z0-9_]*` (e.g. `current.temperature_2m`, `daily.time[0]`). No wildcards or filters.
  - Result: primitives become their string form; objects/arrays become compact JSON. On success both the destination and `it` receive the result. On failure the destination is unchanged and `it` becomes `"error: <reason>"` (`blocked url`, `timeout`, `http <status>`, `not json`, `too large` = body over 256 KB, `network error` = the request failed before any HTTP response, e.g. DNS, CORS or offline, `path not found`).
* **Text output:** any text a script produces reaches the screen only through the 1-bit text rasterizer (§5.5) or `textContent`; HTML is never interpreted.
* **NL ↔ HexTalk ↔ HexAST synchronization:** the AI layer (all tiers) produces **only a HexScriptAST**, which must pass the AST schema validator; HexTalk is then printed from it with `printHexTalk`. When the user edits HexTalk by hand, `parseHexTalk` rebuilds the AST. There is therefore exactly one way for the two representations to relate, and they cannot diverge.

### 4.4. HexAI Spellcaster: Tri-Tier Zero-Config Architecture (`src/ai/spellcaster.ts`)

To guarantee that hackathon judges can test natural-language-to-AST compilation immediately with **zero configuration (no API key setup required)** while keeping the public repository 100% free of exposed secrets, HexAI Spellcaster implements a deterministic **Tri-Tier Hybrid Compiler**:

1. **Tier 1 — Zero-Config Local Semantic AST Compiler & Grimoire (Default / Offline-First):**
   - **Built-in Spell Grimoire:** The Object Inspector includes a 1-click *Grimoire Preset Library* containing 24 curated natural language prompts (e.g., *"Dissolve to next card and play a harpsichord fanfare"*, *"Ask for player name, store in field 'HeroName', and add 50 to Score"*, *"Shake button on click with boing sound"*).
   - **Local Heuristic NL-to-AST Engine:** A deterministic intent-and-slot parser that tokenizes freeform English prompts (extracting target cards, `VisualEffectType`, `PlaySound` notes/voices, container mutations, and `IfCondition` branches) and compiles them into a valid `HexScriptAST` in `< 5ms` with zero network calls; the HexTalk shown to the user is printed from that AST.
2. **Tier 2 — Stateless Rate-Limited Edge Proxy (Optional Cloud Endpoint):**
   - If `import.meta.env.VITE_HEXAI_PROXY_URL` is configured, complex multi-card prompts are routed to a lightweight Cloudflare Worker proxy enforcing strict JSON Schema output (`HexScriptAST`) and IP-based rate limiting. If the proxy is unreachable or unconfigured, execution transparently falls back to Tier 1.
3. **Tier 3 — Bring-Your-Own-Key (BYOK) Studio Mode:**
   - Users can optionally open `AI Conjure -> Oracle Settings...` in the System 7 menu bar to input a session-only API key (stored strictly in memory, never persisted to exported stacks or URLs) for unconstrained multi-card generation.

**Acceptance pipeline (all tiers):** `AI output (AST JSON) -> AST schema validation (Zod) -> printHexTalk -> parseHexTalk -> deep-equal check against the validated AST -> preview in the inspector -> user clicks Apply -> stored as scriptSource`. Any failure at any step leaves the current script untouched and shows the reason in the Spellcaster tab.

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

### 5.4. 3-State Bitmap Codec: 2-Bit Packing + PackBits (`src/engine/graphics/rleCodec.ts`)

Every `HexBitmapLayer` (`512 x 342 = 175,104` pixels) uses a deterministic 3-state pixel model:
- `0` = **Transparent** (used on Card layers to let the underlying `HexBackground` show through)
- `1` = **White / Opaque Light Bit**
- `2` = **Black / Opaque Dark Bit**

`rleData` is produced in three steps:
1. **2-bit packing:** 4 pixels per byte, most significant bits first (pixel `i` occupies bits `7-2k .. 6-2k` of byte `i >> 2`, where `k = i & 3`). A layer becomes exactly `43,776` bytes.
2. **PackBits** over those bytes, the run-length scheme MacPaint itself used: header `0..127` = copy the next `header + 1` bytes literally; header `129..255` = repeat the next byte `257 - header` times; header `128` = no-op. Literal runs are what keep dithered images compact; a pure run-length format without them grows larger than the uncompressed data on dithered content.
3. **Base64.** An all-transparent layer is stored as the empty string `""`.

Measured on a 512x342 layer (reference implementation below, round-trip and corruption tests passing):

| Layer content | Previous byte-run format | This codec | This codec + outer deflate (§ below) |
|---|---|---|---|
| Empty layer | 12 chars | 0 chars | 0 |
| Solid fill or 8x8 pattern | 12 chars – 228 KB (checkerboard) | 912 chars | < 0.1 KB |
| Atkinson-dithered photo | 94.6 KB | 49.7 KB | ≈ 30 KB |

**Outer compression:** the URL-hash share link, the standalone HTML export and the `.hexstack` file wrap the *whole* stack JSON with `deflate-raw` (browser `CompressionStream`) and Base64URL. IndexedDB stores the stack JSON uncompressed.

~~~typescript
export const BITMAP_WIDTH = 512;
export const BITMAP_HEIGHT = 342;
export const TOTAL_PIXELS = BITMAP_WIDTH * BITMAP_HEIGHT; // 175,104
export const PACKED_BYTES = TOTAL_PIXELS / 4; // 43,776 (4 pixels per byte, 2 bits each)

export type PixelState = 0 | 1 | 2; // 0 = Transparent, 1 = White/Light, 2 = Black/Dark

/**
 * Pixels -> 2-bit pack (MSB-first, 4 px/byte) -> PackBits -> Base64.
 * An all-transparent layer encodes to the empty string "".
 */
export function encodeBitmapRLE(pixels: Uint8Array): string {
  if (pixels.length !== TOTAL_PIXELS) {
    throw new Error(`Invalid bitmap buffer length: expected ${TOTAL_PIXELS}, got ${pixels.length}`);
  }
  const packed = new Uint8Array(PACKED_BYTES);
  let allTransparent = true;
  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const v = pixels[i];
    if (v > 2) throw new Error(`Invalid pixel state ${v} at index ${i}`);
    if (v !== 0) allTransparent = false;
    packed[i >> 2] |= v << (6 - 2 * (i & 3));
  }
  if (allTransparent) return "";

  const out: number[] = [];
  let i = 0;
  while (i < PACKED_BYTES) {
    let run = 1;
    while (i + run < PACKED_BYTES && run < 128 && packed[i + run] === packed[i]) run++;
    if (run >= 2) {
      out.push(257 - run, packed[i]); // header 129..255 = repeat next byte (257 - header) times
      i += run;
      continue;
    }
    const start = i;
    while (i < PACKED_BYTES && i - start < 128) {
      // stop the literal where a run of 3+ identical bytes begins (a run of 2 is cheaper inside the literal)
      if (i + 2 < PACKED_BYTES && packed[i] === packed[i + 1] && packed[i] === packed[i + 2]) break;
      i++;
    }
    out.push(i - start - 1); // header 0..127 = copy next (header + 1) bytes literally
    for (let j = start; j < i; j++) out.push(packed[j]);
  }

  let binary = "";
  for (let k = 0; k < out.length; k += 0x8000) {
    binary += String.fromCharCode(...out.slice(k, k + 0x8000));
  }
  return btoa(binary);
}

/**
 * Inverse of encodeBitmapRLE. "" decodes to a layer filled with `emptyFill`
 * (cards: 0 = transparent, backgrounds: 1 = light). Throws on corrupt data.
 */
export function decodeBitmapRLE(rleData: string, emptyFill: PixelState = 0): Uint8Array {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  if (!rleData) {
    pixels.fill(emptyFill);
    return pixels;
  }
  const binary = atob(rleData);
  const packed = new Uint8Array(PACKED_BYTES);
  let r = 0;
  let w = 0;
  while (r < binary.length && w < PACKED_BYTES) {
    const header = binary.charCodeAt(r++);
    if (header < 128) {
      const count = header + 1;
      if (r + count > binary.length || w + count > PACKED_BYTES) throw new Error("Corrupt bitmap data (literal overflow)");
      for (let k = 0; k < count; k++) packed[w++] = binary.charCodeAt(r++);
    } else if (header > 128) {
      const count = 257 - header;
      if (r >= binary.length || w + count > PACKED_BYTES) throw new Error("Corrupt bitmap data (run overflow)");
      packed.fill(binary.charCodeAt(r++), w, w + count);
      w += count;
    } // header === 128 is a no-op (PackBits convention)
  }
  if (w !== PACKED_BYTES || r !== binary.length) throw new Error("Corrupt bitmap data (length mismatch)");

  for (let i = 0; i < TOTAL_PIXELS; i++) {
    const v = (packed[i >> 2] >> (6 - 2 * (i & 3))) & 0x03;
    if (v === 3) throw new Error(`Corrupt bitmap data (invalid state 3 at index ${i})`);
    pixels[i] = v;
  }
  return pixels;
}
~~~

---

### 5.5. Authentic 1-Bit Typography & Zero Anti-Aliasing Pipeline (`src/engine/graphics/textRaster.ts`)

Browsers anti-alias text. The CSS switches that turn this off (`-webkit-font-smoothing: none`, `font-smooth: never`) only work on macOS or are non-standard, so on Linux and Windows DOM text is always smoothed. HexCard therefore guarantees 1-bit text by rendering it in the canvas, not by CSS:

1. **All stack content text is rasterized, never DOM:** field text, button titles and any text a script displays on a card go through `renderCrisp1BitText(text, font, size, style, rect, align, wrap) -> { mask: Uint8Array; lineBoxes }`. It draws to an offscreen scratch canvas at integer coordinates and hard-thresholds every pixel (`alpha >= 128 ? 2 : 0`) before committing to the 3-state frame. This strips anti-aliasing fringes whatever the operating system.
2. **Editing an unlocked field in Browse mode:** keyboard input, IME and clipboard go to one visually hidden `<textarea>` (moved off-canvas with `clip-path`, never faded with opacity). Caret and selection are drawn by the rasterizer as inverted pixels. The textarea carries `aria-label` = the field's name for accessibility.
3. **Fonts:** the logical names `System`, `Sans`, `Mono`, `Serif` (Chicago-, Geneva-, Monaco- and New York-like) map to bitmap/pixel fonts bundled in `public/fonts/`. Only fonts under OFL-1.1, CC0 or public-domain terms may be bundled; each font's licence text is recorded in `public/fonts/LICENSES.md`. Apple's original Chicago, Geneva, Monaco and New York font files must never be bundled or loaded.
4. **System 7 chrome** (menu bar, dialogs, Object Inspector) may use DOM text with the same pixel fonts at integer sizes. Residual smoothing there on non-Mac systems is an accepted limitation; the 1-bit guarantee applies to the card viewport.
5. **CSS rules:** canvases use `image-rendering: pixelated`. No `blur()`, no `box-shadow` with a blur radius, no gradients, no semi-transparent colours. Drop shadows are solid `1px`/`2px` offsets or 8x8 dithered patterns.

### 5.6. Frame Composition Pipeline (`src/engine/graphics/bitmapCanvas.ts` + `partRenderer.ts`)

Buttons and fields are **rasterized into the 1-bit frame**, not laid over the canvas as DOM elements. This is what makes HyperCard's layer order possible (the card picture sits *above* background buttons and fields) and lets visual effects transition whole screens, parts included.

Per frame, into one `Uint8Array(175,104)` of pixel states:
1. Background bitmap (`""` decodes to all-light, so background pixels are `1` or `2`; a stray `0` is treated as `1`).
2. Background parts in array order: button chrome and title, field frame, field text (`sharedText ? part.content : card.bgFieldContents[part.id] ?? ""`).
3. Card bitmap, wherever its pixel is not `0`.
4. Card parts in array order.
5. Map `1 -> lightBitHex`, `2 -> darkBitHex` into a `Uint32Array` `ImageData` and draw it on a single `<canvas width=512 height=342>`, scaled by an integer CSS factor with `image-rendering: pixelated`.

- **Hit testing** is geometric (`partRenderer.hitTest(x, y)`): card parts topmost-first, then background parts. Pointer coordinates are divided by the integer scale factor.
- **Highlighting:** `autoHilite` and radio/checkbox states are drawn by inverting the part's pixels in the frame.
- Button icons (`iconId`, `customIcons`) are kept in the schema for forward compatibility but are not rendered in schema 2.0.0.
- **Transitions:** visual effects (§5.2) receive two fully composed frames (old card, new card), so every part moves with the effect.
- **DOM overlay** is limited to the hidden textarea of §5.5 and, in authoring tools, the selection marquee and resize handles (crisp 1 px borders).
- A full recomposition touches 175,104 bytes; recompose the whole frame on every change unless profiling shows a problem.

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

## 8. Kiro IDE Integration (`.kiro/` Directory)

The Kiroween 2026 rules require the `/.kiro` directory at the repository root (it must not be git-ignored). Its contents are authoritative in their own files; this section only maps them:

~~~text
.kiro/
├── steering/                       # Always-included guardrails
│   ├── product.md                  # Product vision, hackathon category, 5-layer HyperCard rules
│   ├── tech.md                     # Stack, security rules, 1-bit rendering rules, testing
│   └── structure.md                # Canonical directory tree and module-boundary rules
├── specs/                          # Each spec owns its modules; no task appears in two specs
│   ├── 01-core-stack-engine/       # schema.ts, store.ts, messageBus.ts, history.ts, stack validation
│   ├── 02-hextalk-ast-vm/          # ast.ts, parser.ts (+ printer), vm.ts, fetch policy
│   ├── 03-1bit-canvas-dither/      # rleCodec, compositor + part renderer, text raster, dither, patterns, transitions, paint tools
│   └── 04-ui-audio-showcase/       # System 7 shell, inspector, synth, Spellcaster, storage/export, player build, presets
└── hooks/                          # Kiro IDE 1.0 hook format: {"version":"v1","hooks":[...]}
    ├── validate-ast-safety.json    # PostFileSave on src/core, src/ai, src/storage
    └── enforce-1bit-ui.json        # PostFileSave on src/ui, src/engine/graphics, CSS
~~~

Each spec folder contains `requirements.md` (EARS acceptance criteria numbered `N.M`), `design.md` (module design, referencing this file's sections for shared contracts) and `tasks.md` (every task lists the `_Requirements: N.M_` it satisfies).

---

## 9. Application Directory Structure & Jury Showcase Stacks

The canonical directory tree lives in `.kiro/steering/structure.md` (it is loaded into every Kiro request, so it is kept in one place only).

**Showcase stacks (`src/presets/`):**
1. `hauntedMansion.ts` — **"The Haunted Stack of 1987"**: 1-bit horror/puzzle adventure with inventory in background fields (`sharedText: false`), LFSR dissolve transitions and harpsichord motifs.
2. `retroSynthDeck.ts` — **"HexSynth Sequencer"**: harpsichord and 8-bit step sequencer driven by `PlaySound`.
3. `apiWeatherOracle.ts` — **"HexOracle 1987"**: live data dashboard built on `fetch` (§4.3 policy) with offline fallback data.

All presets are authored as HexTalk `scriptSource` and canonical `rleData`, and are validated by the same stack validator as user imports.
