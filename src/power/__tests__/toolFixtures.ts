// Not a test: the stack fixtures and the call helper that the tool tests of spec 07 share
// (validateStack, compileHexTalk, conjureScript, steps, argumentCheck).
import { createBlankStack } from "../../core/authoringCommands.ts";
import type { HexButtonPart, HexFieldPart, HexStack } from "../../core/schema.ts";
import { encodeStackFile } from "../../storage/stackFile.ts";
import { createProtocolHandler } from "../protocol.ts";
import { createPowerTools, type ToolDeps, type PowerTool } from "../tools/index.ts";

export const GOOD_SCRIPT = "on mouseUp\n  go next\nend mouseUp";

export function button(id: string, extra: Partial<HexButtonPart> = {}): HexButtonPart {
  return {
    id, name: "Button", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true, enabled: true, scriptSource: "", style: "roundRect", title: "Go", showName: true,
    autoHilite: true, hilite: false, ...extra,
  };
}

export function field(id: string, extra: Partial<HexFieldPart> = {}): HexFieldPart {
  return {
    id, name: "Field", type: "field", layerScope: "background", rect: { x: 10, y: 40, width: 200, height: 100 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false,
    lockText: false, dontWrap: false, showLines: false, textAlign: "left", textFont: "System", textSize: 12,
    textStyle: [], ...extra,
  };
}

/** A valid stack with two cards on one background, one field, one button and no script. */
export function makeStack(): HexStack {
  const stack = createBlankStack({ now: new Date("2026-01-01T00:00:00.000Z"), random: () => 0.5 });
  stack.name = "Fixture";
  const backgroundId = stack.backgrounds[0].id;
  stack.backgrounds[0].parts.push(field("prt_field"));
  stack.cards[0].parts.push(button("prt_button"));
  stack.cards.push({ ...JSON.parse(JSON.stringify(stack.cards[0])), id: "crd_second", name: "Second", backgroundId, parts: [] });
  return stack;
}

/** A plain copy that a test may change freely. */
export const clone = (value: unknown): any => JSON.parse(JSON.stringify(value));

export async function toHexstack(stack: unknown): Promise<string> {
  return encodeStackFile(stack as HexStack);
}

export interface Called {
  isError: boolean;
  /** The parsed JSON text of the first content. */
  json: Record<string, any>;
  /** The first content's text, as sent. */
  text: string;
  contentTypes: string[];
}

/** Calls tools through the protocol handler, as the server does (argument check, then run). */
export function makeCaller(deps: ToolDeps = {}): {
  tools: readonly PowerTool[];
  call: (name: string, args: unknown) => Promise<Called>;
} {
  const tools = createPowerTools(deps);
  const handler = createProtocolHandler({ tools, serverVersion: "0.0.0", log: () => undefined });
  const encoder = new TextEncoder();
  let nextId = 1;
  return {
    tools,
    async call(name, args) {
      const line = await handler.handleLine(
        encoder.encode(JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } })),
      );
      const answer = JSON.parse(line as string);
      if (answer.result === undefined) throw new Error(`no result: ${line}`);
      const first = answer.result.content[0];
      return {
        isError: answer.result.isError,
        json: JSON.parse(first.text),
        text: first.text,
        contentTypes: answer.result.content.map((c: { type: string }) => c.type),
      };
    },
  };
}
