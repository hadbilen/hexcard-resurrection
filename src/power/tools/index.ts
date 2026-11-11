// The power's tools (spec 07 design §tools/index.ts). Task 3.1 defines the types; createPowerTools
// and the tools themselves follow in later tasks.

import type { ArgSchema } from "../argumentCheck.ts";
import type { CallToolResult } from "../results.ts";
import type { listStackErrors } from "../../storage/stackLoader.ts";
import type { parseHexTalk } from "../../core/parser.ts";

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
