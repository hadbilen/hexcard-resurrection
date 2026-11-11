// The power's tools (spec 07 design §tools/index.ts and §Tool input schemas). createPowerTools
// returns the tools in the order of tools/list; the titles, descriptions and inputSchemas here are
// what tools/list sends and what the argument checker enforces.

import { MAX_PROMPT_LENGTH, type SpellObjectKind } from "../../ai/spellcaster.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { listStackErrors } from "../../storage/stackLoader.ts";
import { checkArguments, type ArgSchema } from "../argumentCheck.ts";
import type { CallToolResult } from "../results.ts";
import { MAX_STACK_TEXT } from "../stackText.ts";
import { MAX_SOURCE_LENGTH, runCompileHexTalk } from "./compileHexTalk.ts";
import { runConjureScript } from "./conjureScript.ts";
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

/** Steps with the studio's functions as defaults. */
function resolveSteps(deps: ToolDeps): ToolSteps {
  return { listStackErrors, parseHexTalk, ...deps.steps };
}

export function createPowerTools(deps: ToolDeps = {}): readonly PowerTool[] {
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
  return [validateStack, compileHexTalk, conjureScript];
}
