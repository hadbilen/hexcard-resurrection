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
/** Steps with the studio's functions as defaults. */
function resolveSteps(deps: Pick<ToolDeps, "steps">): ToolSteps {
  return { listStackErrors, parseHexTalk, ...deps.steps };
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
  return [validateStack, compileHexTalk, conjureScript, renderCard];
}
