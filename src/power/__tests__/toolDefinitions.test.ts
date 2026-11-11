// Spec 07 tasks 3.2 and 4.2: what tools/list says about validate_stack, compile_hextalk, conjure_script and
// render_card (Requirements 4.3, 5.3, 10.4; design §tools/index.ts and §Tool input schemas).
import { describe, expect, it } from "vitest";
import { MAX_PROMPT_LENGTH } from "../../ai/spellcaster.ts";
import { checkArguments } from "../argumentCheck.ts";
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
  it("returns validate_stack, compile_hextalk, conjure_script and render_card, in this order, with their titles", () => {
    expect(tools.map((tool) => [tool.name, tool.title])).toEqual([
      ["validate_stack", "Validate HexCard stack"],
      ["compile_hextalk", "Compile HexTalk"],
      ["conjure_script", "Conjure HexTalk"],
      ["render_card", "Render HexCard card"],
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
    const [validate, compile, conjure, render] = tools.map((tool) => tool.inputSchema);
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
    for (const [tool, property, text] of [
      [validate, "stack", "4194304"], [validate, "hexstack", "false"], [compile, "source", "65536"],
      [conjure, "prompt", "600"], [conjure, "objectKind", "button"],
      [render, "stack", "4194304"], [render, "card", "100000"], [render, "card", "256"], [render, "scale", "default 1"],
    ] as const) {
      expect(tool.properties[property].description, property).toContain(text);
    }
  });
});

describe("tools/list", () => {
  it("lists the four tools with the four annotations of Requirement 4.3", async () => {
    const result = await listed();
    expect(result.map((tool) => tool.name)).toEqual(["validate_stack", "compile_hextalk", "conjure_script", "render_card"]);
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
