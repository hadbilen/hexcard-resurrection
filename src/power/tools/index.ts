// The power's tools (spec 07 design §tools/index.ts and §Tool input schemas). createPowerTools
// returns the tools in the order of tools/list; the titles, descriptions and inputSchemas here are
// what tools/list sends and what the argument checker enforces.

import { MAX_PROMPT_LENGTH, type SpellObjectKind } from "../../ai/spellcaster.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { listStackErrors } from "../../storage/stackLoader.ts";
import { checkArguments, type ArgSchema } from "../argumentCheck.ts";
import type { ParsedFaces } from "../nodeTextBackend.ts";
import type { CallToolResult } from "../results.ts";
import { MAX_STACK_TEXT } from "../stackText.ts";
import { MAX_SOURCE_LENGTH, runCompileHexTalk } from "./compileHexTalk.ts";
import { runConjureScript } from "./conjureScript.ts";
import { checkDrawCommands, checkDrawLayerArguments, MAX_COMMANDS, MAX_DRAW_TEXT_CHARACTERS, runDrawLayer } from "./drawLayer.ts";
import { MAX_CARD_POSITION, MAX_CARD_SELECTOR, runRenderCard } from "./renderCard.ts";
import { runValidateStack } from "./validateStack.ts";

export type ToolName = "validate_stack" | "compile_hextalk" | "conjure_script" | "render_card" | "draw_layer";

export interface PowerTool {
  name: ToolName;
  title: string;
  description: string;
  inputSchema: Extract<ArgSchema, { type: "object" }>;
  /** Replaces the generic checkArguments(inputSchema, args) when the tool has rules the schema cannot express. */
  checkArguments?(args: Record<string, unknown>): string[];
  run(args: Record<string, unknown>): Promise<CallToolResult>;
}

/** The steps of Requirement 5.4; the tests replace them with throwing doubles. */
export interface ToolSteps {
  listStackErrors: typeof listStackErrors; // stackLoader.ts
  parseHexTalk: typeof parseHexTalk; // parser.ts
  checkDrawCommands: typeof checkDrawCommands; // tools/drawLayer.ts
}

export interface ToolDeps {
  /** The parsed bundled fonts of the Node text backend; main.ts parses them once, at start-up (Requirement 5.5). */
  fonts: ParsedFaces;
  steps?: Partial<ToolSteps>;
}

/** Requirement 5.3: the object kinds, in this order; `satisfies` makes the compiler flag a kind the Spellcaster adds. */
const OBJECT_KINDS = Object.keys({
  button: true,
  field: true,
  card: true,
  background: true,
  stack: true,
} satisfies Record<SpellObjectKind, true>);

const VALIDATE_STACK_SCHEMA: PowerTool["inputSchema"] = {
  type: "object",
  properties: {
    stack: {
      type: "string",
      maxLength: MAX_STACK_TEXT,
      description:
        `The stack to check: the JSON text of a HexCard stack, or the text of a .hexstack file. At most ${MAX_STACK_TEXT} characters (UTF-16 code units); ` +
        `a longer text is answered as a read error of stack. A .hexstack text may decompress to at most ${MAX_STACK_TEXT} bytes. ` +
        "Text that starts with { (after white space) is read as JSON, any other text as .hexstack text. It is never a file name or a URL.",
    },
    hexstack: {
      type: "boolean",
      default: false,
      description: "Optional, default false. When true and the stack is accepted, the result also holds the .hexstack text of the stack.",
    },
  },
  required: ["stack"],
  additionalProperties: false,
};

const COMPILE_HEXTALK_SCHEMA: PowerTool["inputSchema"] = {
  type: "object",
  properties: {
    source: {
      type: "string",
      maxLength: MAX_SOURCE_LENGTH,
      description: `The HexTalk script to compile, passed to the parser unchanged. At most ${MAX_SOURCE_LENGTH} characters (UTF-16 code units).`,
    },
  },
  required: ["source"],
  additionalProperties: false,
};

const CONJURE_SCRIPT_SCHEMA: PowerTool["inputSchema"] = {
  type: "object",
  properties: {
    prompt: {
      type: "string",
      maxLength: MAX_PROMPT_LENGTH,
      description: `What the script should do, in English. At most ${MAX_PROMPT_LENGTH} characters (UTF-16 code units).`,
    },
    objectKind: {
      type: "string",
      enum: OBJECT_KINDS,
      default: "button",
      description: "Optional, default button. The kind of object the script is for: button, field, card, background or stack.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
};

const RENDER_CARD_SCHEMA: PowerTool["inputSchema"] = {
  type: "object",
  properties: {
    stack: {
      type: "string",
      maxLength: MAX_STACK_TEXT,
      description:
        `The stack to draw: the JSON text of a HexCard stack, or the text of a .hexstack file. At most ${MAX_STACK_TEXT} characters (UTF-16 code units); ` +
        `a longer text is answered as a read error of stack. A .hexstack text may decompress to at most ${MAX_STACK_TEXT} bytes. ` +
        "Text that starts with { (after white space) is read as JSON, any other text as .hexstack text. It is never a file name or a URL.",
    },
    card: {
      anyOf: [
        { type: "integer", minimum: 1, maximum: MAX_CARD_POSITION },
        { type: "string", maxLength: MAX_CARD_SELECTOR },
      ],
      description:
        `Optional, default the first card. Which card to draw: an integer from 1 to ${MAX_CARD_POSITION} (the card's 1-based position in the stack), ` +
        `or a string of at most ${MAX_CARD_SELECTOR} characters (UTF-16 code units) that is a card id, or else a card name compared without regard to letter case. ` +
        'A string is never read as a position, so "2" matches only a card with the id or name 2.',
    },
    scale: {
      type: "integer",
      enum: [1, 2],
      default: 1,
      description: "Optional, default 1. The image is 512 x 342 pixels at scale 1 and 1024 x 684 pixels at scale 2.",
    },
  },
  required: ["stack"],
  additionalProperties: false,
};

/** An integer property of a drawing command, with its limit (and default) in the description. */
function integerField(minimum: number, maximum: number, description: string, defaultValue?: number): ArgSchema {
  return defaultValue === undefined
    ? { type: "integer", minimum, maximum, description }
    : { type: "integer", minimum, maximum, default: defaultValue, description };
}
const X_FIELD = (what: string): ArgSchema => integerField(0, 511, `${what}, an integer from 0 to 511.`);
const Y_FIELD = (what: string): ArgSchema => integerField(0, 341, `${what}, an integer from 0 to 341.`);
const PATTERN_FIELD: ArgSchema = integerField(
  0,
  37,
  "Optional, default 1 (solid dark). The pattern index, an integer from 0 to 37: 0 is solid light, 1 is solid dark, the others are the 38 classic 8x8 patterns of the paint tools.",
  1,
);
const OP = (name: string): ArgSchema => ({ type: "string", const: name, description: `Must be ${name}.` });

const RECT_COMMAND: ArgSchema = {
  type: "object",
  description:
    "A rectangle: the frame of the box, or the whole box when filled is true, with x + width at most 512 and y + height at most 342. Pixels take the state of the pattern at their own layer coordinates.",
  properties: {
    op: OP("rect"),
    x: X_FIELD("Left column"),
    y: Y_FIELD("Top row"),
    width: integerField(1, 512, "Width in pixels, an integer from 1 to 512; x + width is at most 512."),
    height: integerField(1, 342, "Height in pixels, an integer from 1 to 342; y + height is at most 342."),
    pattern: PATTERN_FIELD,
    filled: { type: "boolean", default: false, description: "Optional, default false. True draws every pixel of the box, false only its 1-pixel frame." },
  },
  required: ["op", "x", "y", "width", "height"],
  additionalProperties: false,
};

const LINE_COMMAND: ArgSchema = {
  type: "object",
  description:
    "A line from (x1, y1) to (x2, y2), both ends included, drawn like the Line tool. The order of the two points matters: swapping them can set different pixels.",
  properties: {
    op: OP("line"),
    x1: X_FIELD("Column of the first point"),
    y1: Y_FIELD("Row of the first point"),
    x2: X_FIELD("Column of the second point"),
    y2: Y_FIELD("Row of the second point"),
    pattern: PATTERN_FIELD,
  },
  required: ["op", "x1", "y1", "x2", "y2"],
  additionalProperties: false,
};

const SPRITE_COMMAND: ArgSchema = {
  type: "object",
  description:
    "A sprite: rows of # (dark pixel) and . (light pixel) with its top-left corner at (x, y). Every row has the same length, and the sprite lies wholly inside the layer.",
  properties: {
    op: OP("sprite"),
    x: X_FIELD("Left column of the sprite"),
    y: Y_FIELD("Top row of the sprite"),
    rows: {
      type: "array",
      minItems: 1,
      maxItems: 64,
      description:
        "1 to 64 rows of the same length. Each row is 1 to 64 characters (UTF-16 code units), every one # (dark) or . (light). The rows of all sprites and the texts of all text commands in one call add up to at most 65536 characters.",
      items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[#.]+$", description: "One row: 1 to 64 characters, each # or ." },
    },
  },
  required: ["op", "x", "y", "rows"],
  additionalProperties: false,
};

const TEXT_COMMAND: ArgSchema = {
  type: "object",
  description:
    "Text laid out and drawn in a box with the studio's text rasterizer and the bundled pixel fonts, like the text of a field with no inset. Lines that do not fit the box are cut off and reported in notes; characters the fonts do not cover are listed in uncoveredCharacters.",
  properties: {
    op: OP("text"),
    x: X_FIELD("Left column of the box"),
    y: Y_FIELD("Top row of the box"),
    text: {
      type: "string",
      minLength: 1,
      maxLength: 256,
      description:
        "The text, 1 to 256 characters (UTF-16 code units). The texts and sprite rows of all commands in one call add up to at most 65536 characters.",
    },
    width: integerField(1, 512, "Optional, default 512 - x. Box width in pixels, an integer from 1 to 512; x + width is at most 512."),
    height: integerField(1, 342, "Optional, default 342 - y. Box height in pixels, an integer from 1 to 342; y + height is at most 342."),
    font: { type: "string", enum: ["System", "Sans", "Mono", "Serif"], default: "Sans", description: "Optional, default Sans. The logical font: System, Sans, Mono or Serif." },
    size: { type: "integer", enum: [9, 10, 12, 14, 18, 24], default: 12, description: "Optional, default 12. The text size: 9, 10, 12, 14, 18 or 24." },
    style: {
      type: "array",
      uniqueItems: true,
      description: "Optional, default an empty list. Text styles, each at most once: bold, italic, underline, outline, shadow, condense.",
      items: { type: "string", enum: ["bold", "italic", "underline", "outline", "shadow", "condense"], description: "One text style." },
    },
    align: { type: "string", enum: ["left", "center", "right"], default: "left", description: "Optional, default left. Alignment in the box: left, center or right." },
    wrap: {
      type: "boolean",
      default: true,
      description: "Optional, default true. True wraps lines at spaces to the box width; false breaks lines only at line breaks.",
    },
    ink: { type: "string", enum: ["dark", "light"], default: "dark", description: "Optional, default dark. The state the ink pixels are set to: dark or light." },
  },
  required: ["op", "x", "y", "text"],
  additionalProperties: false,
};

const DRAW_LAYER_SCHEMA: PowerTool["inputSchema"] = {
  type: "object",
  properties: {
    layer: {
      type: "string",
      enum: ["card", "background"],
      description:
        "Which kind of layer to draw: card (starts all transparent) or background (starts all light). The result's rleData belongs in that kind of bitmap.",
    },
    commands: {
      type: "array",
      minItems: 1,
      maxItems: MAX_COMMANDS,
      description:
        `1 to ${MAX_COMMANDS} drawing commands, drawn in list order on the 512 x 342 layer; a later command overwrites the pixels of an earlier one. ` +
        `Each is an object whose op is rect, line, sprite or text. The sprite rows and texts of the whole call add up to at most ${MAX_DRAW_TEXT_CHARACTERS} characters (UTF-16 code units).`,
      items: { oneOf: [RECT_COMMAND, LINE_COMMAND, SPRITE_COMMAND, TEXT_COMMAND] },
    },
  },
  required: ["layer", "commands"],
  additionalProperties: false,
};

/** Steps with the studio's functions as defaults. */
function resolveSteps(deps: Pick<ToolDeps, "steps">): ToolSteps {
  return { listStackErrors, parseHexTalk, checkDrawCommands, ...deps.steps };
}

export function createPowerTools(deps: ToolDeps): readonly PowerTool[] {
  const steps = resolveSteps(deps);
  const validateStack: PowerTool = {
    name: "validate_stack",
    title: "Validate HexCard stack",
    description:
      "Checks a HexCard stack with the same load check the HexCard studio uses and reports every reason it would be rejected, each with its path. " +
      "Takes the stack as JSON text or as .hexstack text. Returns ok, the list of errors (at most 100, then a count of the rest), and, for an accepted stack, " +
      "the compile errors of every script in it, a note for every bitmap layer whose rleData is not canonical, and the stack name and counts of cards and backgrounds. " +
      "With hexstack true it also returns the .hexstack text of an accepted stack. " +
      `Limits: the stack text has at most ${MAX_STACK_TEXT} characters and a .hexstack text decompresses to at most ${MAX_STACK_TEXT} bytes. ` +
      "It reads no file and no URL, opens no network connection and runs no script; it only reads and checks the text it is given.",
    inputSchema: VALIDATE_STACK_SCHEMA,
    // The stack text length is a read error of stack (Requirement 5.3), so the checker skips it.
    checkArguments: (args) => checkArguments(VALIDATE_STACK_SCHEMA, args, { readLimited: ["stack"] }),
    run: (args) => runValidateStack(args, steps),
  };
  const compileHexTalk: PowerTool = {
    name: "compile_hextalk",
    title: "Compile HexTalk",
    description:
      "Compiles a HexTalk script with the HexCard parser. Returns ok, the canonical form of the script (the text HexCard prints for the parsed script), " +
      "the names of its handlers in source order, and notes. When the script has errors, ok is false and the result lists each error with its line, column and message " +
      "(at most 100, then a count of the rest) and the handlers that compiled. Lines and columns are 1-based and refer to the source exactly as sent. " +
      `Limit: the source has at most ${MAX_SOURCE_LENGTH} characters. ` +
      "It only parses and prints the script; it never runs it, and it reads no file and no URL.",
    inputSchema: COMPILE_HEXTALK_SCHEMA,
    run: (args) => runCompileHexTalk(args, steps),
  };
  const conjureScript: PowerTool = {
    name: "conjure_script",
    title: "Conjure HexTalk",
    description:
      "Turns an English description into a HexTalk script with the HexCard Spellcaster, Tier 1 only: the built-in Grimoire spells and the local compiler, with no network, no API key and no model. " +
      "Returns ok true with the HexTalk and notes (a note says when a handler would never run in the chosen object kind), or ok false with the reason and one to three suggested Grimoire prompts. " +
      `Limit: the prompt has at most ${MAX_PROMPT_LENGTH} characters. The object kind defaults to button. ` +
      "It reads no file and no URL and never runs the script it returns.",
    inputSchema: CONJURE_SCRIPT_SCHEMA,
    run: async (args) => runConjureScript(args),
  };
  const renderCard: PowerTool = {
    name: "render_card",
    title: "Render HexCard card",
    description:
      "Draws one card of a HexCard stack with the studio's own compositor and part renderer, and returns a 1-bit PNG image of it plus a JSON summary. " +
      "The stack is read and checked like validate_stack; a stack the studio would not load gets the same errors and no image. " +
      "Choose the card by 1-based position, by id or by name (default the first card) and the image scale, 1 or 2 (default 1). " +
      "The summary names the card and its background, the image size, the theme colours, every part in drawing order (hidden parts included, with its rect, style, text and whether it is hidden, disabled or outside the card), " +
      "and every character that the bundled fonts do not cover, per part. " +
      "Pixel match with the studio: the text in the image matches the studio's card pixel for pixel only for characters that the font of the text covers. " +
      "This was measured only in headless Chrome 157 on Linux; other browsers and operating systems were not checked. " +
      "It runs no script (no openStack or openCard handler), keeps nothing between calls, reads no file and no URL, and opens no network connection. " +
      `Limits: the stack text has at most ${MAX_STACK_TEXT} characters.`,
    inputSchema: RENDER_CARD_SCHEMA,
    // The stack text length is a read error of stack (Requirement 5.3), so the checker skips it.
    checkArguments: (args) => checkArguments(RENDER_CARD_SCHEMA, args, { readLimited: ["stack"] }),
    run: (args) => runRenderCard(args, steps, deps.fonts),
  };
  const drawLayer: PowerTool = {
    name: "draw_layer",
    title: "Draw HexCard layer",
    description:
      "Draws simple 1-bit art on a blank card or background layer from a list of drawing commands and returns the layer's canonical rleData, ready to put in a stack's bitmap. " +
      "Commands: rect (frame or filled box), line, sprite (rows of # and .) and text (laid out and drawn with the studio's text rasterizer and the bundled pixel fonts). " +
      "Rectangles and lines are drawn with the paint tools' own code and the 38 classic patterns. A card layer starts transparent and a background layer starts light; later commands overwrite earlier ones. " +
      "Returns ok, the layer, the rleData (an empty string when the drawing equals the blank layer), the number of light and dark pixels, notes for text that does not fit its box, and the characters the fonts do not cover. " +
      `Limits: 1 to ${MAX_COMMANDS} commands, every point and shape inside the 512 x 342 layer, sprites of at most 64 x 64 pixels, texts of at most 256 characters, ` +
      `and at most ${MAX_DRAW_TEXT_CHARACTERS} characters of sprite rows and texts in one call. ` +
      "It cannot draw over existing rleData. It reads no file and no URL, opens no network connection and runs no script.",
    inputSchema: DRAW_LAYER_SCHEMA,
    // Rules the schema cannot express (shapes inside the layer, equal sprite rows, the call's total) follow it.
    checkArguments: (args) => checkDrawLayerArguments(DRAW_LAYER_SCHEMA, args, steps),
    run: (args) => runDrawLayer(args, deps.fonts),
  };
  return [validateStack, compileHexTalk, conjureScript, renderCard, drawLayer];
}
