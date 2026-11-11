// Spec 07 tasks 3.2, 4.2 and 5.1: what tools/list says about validate_stack, compile_hextalk, conjure_script,
// render_card and draw_layer (Requirements 4.3, 5.3, 10.4, 11; design §tools/index.ts and §Tool input schemas).
import { describe, expect, it } from "vitest";
import { MAX_PROMPT_LENGTH } from "../../ai/spellcaster.ts";
import { checkArguments, type ArgSchema } from "../argumentCheck.ts";
import { createProtocolHandler } from "../protocol.ts";
import { MAX_STACK_TEXT } from "../stackText.ts";
import { createPowerTools } from "../tools/index.ts";
import { FONTS } from "./toolFixtures.ts";

const tools = createPowerTools({ fonts: FONTS });

async function listed(): Promise<Array<Record<string, any>>> {
  const handler = createProtocolHandler({ tools, serverVersion: "0.0.0", log: () => undefined });
  const line = await handler.handleLine(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })));
  return JSON.parse(line as string).result.tools;
}

describe("createPowerTools", () => {
  it("returns validate_stack, compile_hextalk, conjure_script, render_card and draw_layer, in this order, with their titles", () => {
    expect(tools.map((tool) => [tool.name, tool.title])).toEqual([
      ["validate_stack", "Validate HexCard stack"],
      ["compile_hextalk", "Compile HexTalk"],
      ["conjure_script", "Conjure HexTalk"],
      ["render_card", "Render HexCard card"],
      ["draw_layer", "Draw HexCard layer"],
    ]);
  });

  it("writes each description as printable ASCII under 2,000 characters that states the no-file, no-script rule", () => {
    for (const tool of tools) {
      expect(tool.description, tool.name).toMatch(/^[\x20-\x7e]+$/);
      expect(tool.description.length, tool.name).toBeLessThan(2000);
      expect(tool.description, tool.name).toMatch(/reads no file/);
      expect(tool.description, tool.name).toMatch(/(never runs|runs no) /);
    }
  });

  it("matches the tool names Kiro accepts and stays within 64 characters with a 49-character prefix", () => {
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect(49 + tool.name.length).toBeLessThanOrEqual(64);
    }
  });

  it("gives every inputSchema type object, no additional properties, and a description on every property", () => {
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const [name, property] of Object.entries(tool.inputSchema.properties)) {
        expect(property.description, `${tool.name}.${name}`).toBeTruthy();
      }
      expect(() => checkArguments(tool.inputSchema, {})).not.toThrow();
    }
  });

  it("states the limits and defaults of Requirement 5.3 in the schemas", () => {
    const [validate, compile, conjure, render, drawLayer] = tools.map((tool) => tool.inputSchema);
    expect(validate.required).toEqual(["stack"]);
    expect(validate.properties.stack).toMatchObject({ type: "string", maxLength: MAX_STACK_TEXT });
    expect(validate.properties.hexstack).toMatchObject({ type: "boolean", default: false });
    expect(compile.required).toEqual(["source"]);
    expect(compile.properties.source).toMatchObject({ type: "string", maxLength: 65536 });
    expect(conjure.required).toEqual(["prompt"]);
    expect(conjure.properties.prompt).toMatchObject({ type: "string", maxLength: MAX_PROMPT_LENGTH });
    expect(conjure.properties.objectKind).toMatchObject({
      type: "string", enum: ["button", "field", "card", "background", "stack"], default: "button",
    });
    expect(render.required).toEqual(["stack"]);
    expect(render.properties.stack).toMatchObject({ type: "string", maxLength: MAX_STACK_TEXT });
    expect(render.properties.card).toMatchObject({
      anyOf: [{ type: "integer", minimum: 1, maximum: 100000 }, { type: "string", maxLength: 256 }],
    });
    expect(render.properties.scale).toMatchObject({ type: "integer", enum: [1, 2], default: 1 });
    expect(drawLayer.required).toEqual(["layer", "commands"]);
    expect(drawLayer.properties.layer).toMatchObject({ type: "string", enum: ["card", "background"] });
    expect(drawLayer.properties.commands).toMatchObject({ type: "array", minItems: 1, maxItems: 256 });
    for (const [tool, property, text] of [
      [validate, "stack", "4194304"], [validate, "hexstack", "false"], [compile, "source", "65536"],
      [conjure, "prompt", "600"], [conjure, "objectKind", "button"],
      [render, "stack", "4194304"], [render, "card", "100000"], [render, "card", "256"], [render, "scale", "default 1"],
      [drawLayer, "layer", "card"], [drawLayer, "commands", "256"], [drawLayer, "commands", "65536"],
    ] as const) {
      expect(tool.properties[property].description, property).toContain(text);
    }
  });
});

describe("tools/list", () => {
  it("lists the five tools with the four annotations of Requirement 4.3", async () => {
    const result = await listed();
    expect(result.map((tool) => tool.name)).toEqual([
      "validate_stack", "compile_hextalk", "conjure_script", "render_card", "draw_layer",
    ]);
    for (const tool of result) {
      expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }
  });
});

describe("render_card description (Requirement 10.4)", () => {
  it("states that the pixel match holds only for covered characters, was measured only in headless Chrome 157 on Linux, and that other browsers and operating systems were not checked", () => {
    const description = tools.find((tool) => tool.name === "render_card")!.description;
    expect(description).toContain("only for characters that the font of the text covers");
    expect(description).toContain("measured only in headless Chrome 157 on Linux");
    expect(description).toContain("other browsers and operating systems were not checked");
  });
});

describe("draw_layer inputSchema (Requirements 4.3, 5.3; design §Tool input schemas)", () => {
  const { inputSchema } = tools.find((tool) => tool.name === "draw_layer")!;
  const commands = inputSchema.properties.commands as Extract<ArgSchema, { type: "array" }>;
  const branches = (commands.items as Extract<ArgSchema, { oneOf: ArgSchema[] }>).oneOf as Array<Extract<ArgSchema, { type: "object" }>>;
  const byOp = (op: string) => branches.find((branch) => (branch.properties.op as { const: string }).const === op)!;

  it("is a oneOf of the four commands, rect, line, sprite and text, in this order", () => {
    expect(branches.map((branch) => (branch.properties.op as { const: string }).const)).toEqual(["rect", "line", "sprite", "text"]);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
      for (const [name, property] of Object.entries(branch.properties)) expect(property.description, name).toBeTruthy();
    }
  });

  it("states the required fields, limits and defaults of each command", () => {
    expect(byOp("rect").required).toEqual(["op", "x", "y", "width", "height"]);
    expect(byOp("rect").properties).toMatchObject({
      x: { minimum: 0, maximum: 511 }, y: { minimum: 0, maximum: 341 }, width: { minimum: 1, maximum: 512 }, height: { minimum: 1, maximum: 342 },
      pattern: { type: "integer", minimum: 0, maximum: 37, default: 1 }, filled: { type: "boolean", default: false },
    });
    expect(byOp("line").required).toEqual(["op", "x1", "y1", "x2", "y2"]);
    expect(byOp("line").properties).toMatchObject({
      x1: { minimum: 0, maximum: 511 }, y1: { minimum: 0, maximum: 341 }, x2: { minimum: 0, maximum: 511 }, y2: { minimum: 0, maximum: 341 },
      pattern: { minimum: 0, maximum: 37, default: 1 },
    });
    expect(byOp("sprite").required).toEqual(["op", "x", "y", "rows"]);
    expect(byOp("sprite").properties.rows).toMatchObject({
      type: "array", minItems: 1, maxItems: 64, items: { type: "string", minLength: 1, maxLength: 64, pattern: "^[#.]+$" },
    });
    expect(byOp("text").required).toEqual(["op", "x", "y", "text"]);
    expect(byOp("text").properties).toMatchObject({
      text: { type: "string", minLength: 1, maxLength: 256 },
      width: { minimum: 1, maximum: 512 }, height: { minimum: 1, maximum: 342 },
      font: { enum: ["System", "Sans", "Mono", "Serif"], default: "Sans" },
      size: { enum: [9, 10, 12, 14, 18, 24], default: 12 },
      style: { type: "array", uniqueItems: true, items: { enum: ["bold", "italic", "underline", "outline", "shadow", "condense"] } },
      align: { enum: ["left", "center", "right"], default: "left" },
      wrap: { type: "boolean", default: true },
      ink: { enum: ["dark", "light"], default: "dark" },
    });
  });

  it("states the defaults that depend on another field in the descriptions", () => {
    const text = byOp("text").properties;
    expect(text.width.description).toContain("512 - x");
    expect(text.height.description).toContain("342 - y");
  });
});
