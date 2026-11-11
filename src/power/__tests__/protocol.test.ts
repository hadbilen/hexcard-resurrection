// Spec 07 task 3.1: protocol.ts (Requirements 4.1-4.11, 17.1). The tools are test doubles injected
// into the handler; none of them is part of the server file.
import { describe, expect, it } from "vitest";
import type { ArgSchema } from "../argumentCheck.ts";
import { LATEST_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS, createProtocolHandler, type ProtocolHandler } from "../protocol.ts";
import { toolResult, type CallToolResult } from "../results.ts";
import type { PowerTool, ToolName } from "../tools/index.ts";

const encoder = new TextEncoder();

const SCHEMA: Extract<ArgSchema, { type: "object" }> = {
  type: "object",
  properties: { source: { type: "string", maxLength: 8 } },
  required: ["source"],
  additionalProperties: false,
};

function makeTool(name: ToolName, run: (args: Record<string, unknown>) => Promise<CallToolResult>): PowerTool & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    name,
    title: `Title of ${name}`,
    description: `Description of ${name}.`,
    inputSchema: SCHEMA,
    calls,
    run(args) {
      calls.push(args);
      return run(args);
    },
  };
}

function setup() {
  const logs: string[] = [];
  const echo = makeTool("compile_hextalk", async (args) => toolResult({ ok: true, got: args.source ?? null }));
  const throwing = makeTool("validate_stack", async () => {
    throw new Error(`boom ${"s".repeat(200)}`);
  });
  const throwingValue = makeTool("conjure_script", async () => {
    throw "plain value";
  });
  const lineBreaks = makeTool("render_card", async () => toolResult({ ok: true, text: "a\u2028b\u2029c" }));
  const noArgs = makeTool("draw_layer", async (args) => toolResult({ ok: true, keys: Object.keys(args) }));
  noArgs.inputSchema = { type: "object", properties: {}, additionalProperties: false };
  const handler = createProtocolHandler({
    tools: [throwing, echo, throwingValue, lineBreaks, noArgs],
    serverVersion: "9.8.7",
    log: (line) => logs.push(line),
  });
  return { handler, logs, echo, throwing, noArgs };
}

async function send(handler: ProtocolHandler, message: unknown): Promise<string | null> {
  return handler.handleLine(encoder.encode(typeof message === "string" ? message : JSON.stringify(message)));
}

async function answer(handler: ProtocolHandler, message: unknown): Promise<Record<string, any>> {
  const line = await send(handler, message);
  expect(line).not.toBeNull();
  expect(line).not.toContain("\n");
  return JSON.parse(line as string);
}

const request = (id: string | number, method: string, params?: unknown) =>
  params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };

const resultJson = (result: { content: { text: string }[] }) => JSON.parse(result.content[0].text);

describe("initialize", () => {
  it.each(SUPPORTED_PROTOCOL_VERSIONS)("answers the supported version %s with itself", async (version) => {
    const { handler } = setup();
    const reply = await answer(handler, request(1, "initialize", { protocolVersion: version, capabilities: {} }));
    expect(reply).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hexcard", version: "9.8.7" },
      },
    });
  });

  it.each([
    ["an unsupported version", { protocolVersion: "1999-01-01" }],
    ["a version that is not a string", { protocolVersion: 20251125 }],
    ["a missing version", {}],
    ["missing params", undefined],
  ])("answers %s with 2025-11-25", async (_label, params) => {
    const { handler } = setup();
    const reply = await answer(handler, request("init", "initialize", params));
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25");
    expect(reply.result.protocolVersion).toBe("2025-11-25");
    expect(reply.id).toBe("init");
  });

  it("answers a repeated initialize by the same rule", async () => {
    const { handler } = setup();
    await answer(handler, request(1, "initialize", { protocolVersion: "2025-06-18" }));
    const again = await answer(handler, request(2, "initialize", { protocolVersion: "2024-11-05" }));
    expect(again.result.protocolVersion).toBe("2024-11-05");
  });
});

describe("methods", () => {
  it("answers ping with an empty result, also before initialize", async () => {
    const { handler } = setup();
    expect(await answer(handler, request(3, "ping"))).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
  });

  it("lists the tools in order with their schemas and the four annotations", async () => {
    const { handler } = setup();
    const reply = await answer(handler, request(4, "tools/list", { cursor: "ignored" }));
    expect(reply.result.tools.map((tool: { name: string }) => tool.name)).toEqual([
      "validate_stack",
      "compile_hextalk",
      "conjure_script",
      "render_card",
      "draw_layer",
    ]);
    expect(reply.result.tools[1]).toEqual({
      name: "compile_hextalk",
      title: "Title of compile_hextalk",
      description: "Description of compile_hextalk.",
      inputSchema: SCHEMA,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    });
    expect(reply.result).not.toHaveProperty("nextCursor");
  });

  it("sends nothing for a notification, whatever its method", async () => {
    const { handler } = setup();
    expect(await send(handler, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(await send(handler, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } })).toBeNull();
    expect(await send(handler, { jsonrpc: "2.0", method: "no/such/method" })).toBeNull();
  });

  it.each(["resources/list", "prompts/list", "logging/setLevel", "secret-method-name"])("answers %s with -32601", async (method) => {
    const { handler } = setup();
    const line = await send(handler, request(5, method));
    expect(JSON.parse(line as string)).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32601, message: "Method not found" } });
  });
});

describe("tools/call", () => {
  it("runs a listed tool with conforming arguments", async () => {
    const { handler, echo } = setup();
    const reply = await answer(handler, request(6, "tools/call", { name: "compile_hextalk", arguments: { source: "on x" } }));
    expect(reply.result.isError).toBe(false);
    expect(resultJson(reply.result)).toEqual({ ok: true, got: "on x" });
    expect(echo.calls).toEqual([{ source: "on x" }]);
  });

  it("treats missing arguments as an empty object", async () => {
    const { handler, noArgs } = setup();
    const reply = await answer(handler, request(7, "tools/call", { name: "draw_layer" }));
    expect(resultJson(reply.result)).toEqual({ ok: true, keys: [] });
    expect(noArgs.calls).toEqual([{}]);
  });

  it.each([
    ["no params", undefined, "Invalid params: missing tool name"],
    ["no name", { arguments: {} }, "Invalid params: missing tool name"],
    ["a name that is not a string", { name: 7 }, "Invalid params: tool name must be a string"],
    ["an unknown tool", { name: "delete_everything" }, "Invalid params: unknown tool"],
    ["an inherited name", { name: "toString" }, "Invalid params: unknown tool"],
  ])("answers %s with -32602", async (_label, params, message) => {
    const { handler } = setup();
    const reply = await answer(handler, request(8, "tools/call", params));
    expect(reply).toEqual({ jsonrpc: "2.0", id: 8, error: { code: -32602, message } });
  });

  it("answers arguments that are not an object with an error result at the path arguments", async () => {
    const { handler, echo } = setup();
    for (const args of [[], "x", 3, null]) {
      const reply = await answer(handler, request(9, "tools/call", { name: "compile_hextalk", arguments: args }));
      expect(reply.result.isError).toBe(true);
      expect(resultJson(reply.result)).toEqual({ ok: false, errors: ["arguments: must be an object"] });
    }
    expect(echo.calls).toEqual([]);
  });

  it("answers arguments that break the inputSchema with an error result, without running the tool", async () => {
    const { handler, echo } = setup();
    const reply = await answer(handler, request(10, "tools/call", { name: "compile_hextalk", arguments: { source: "123456789", extra: 1 } }));
    expect(reply.result.isError).toBe(true);
    expect(resultJson(reply.result)).toEqual({
      ok: false,
      errors: ["extra: is not an allowed argument", "source: must have at most 8 characters"],
    });
    expect(echo.calls).toEqual([]);
  });

  it("uses a tool's own checkArguments when it has one", async () => {
    const own = makeTool("draw_layer", async () => toolResult({ ok: true }));
    own.checkArguments = () => ["commands[0]: the rectangle must lie inside the 512 x 342 layer"];
    const handler = createProtocolHandler({ tools: [own], serverVersion: "1", log: () => {} });
    const reply = await answer(handler, request(1, "tools/call", { name: "draw_layer", arguments: {} }));
    expect(resultJson(reply.result).errors).toEqual(["commands[0]: the rectangle must lie inside the 512 x 342 layer"]);
    expect(own.calls).toEqual([]);
  });

  it("turns a throwing tool into the internal-error result and answers the next line correctly", async () => {
    const { handler, logs } = setup();
    const reply = await answer(handler, request(11, "tools/call", { name: "validate_stack", arguments: { source: "x" } }));
    expect(reply.id).toBe(11);
    expect(reply.result.isError).toBe(true);
    expect(resultJson(reply.result)).toEqual({ ok: false, errors: [`Internal error in validate_stack: boom ${"s".repeat(77)}...`] });
    expect(logs).toEqual(["hexcard: internal error in validate_stack"]);

    const next = await answer(handler, request(12, "tools/call", { name: "compile_hextalk", arguments: { source: "ok" } }));
    expect(next.id).toBe(12);
    expect(resultJson(next.result)).toEqual({ ok: true, got: "ok" });
  });

  it("writes a thrown value that is not an Error as a string", async () => {
    const { handler, logs } = setup();
    const reply = await answer(handler, request(13, "tools/call", { name: "conjure_script", arguments: { source: "x" } }));
    expect(resultJson(reply.result)).toEqual({ ok: false, errors: ["Internal error in conjure_script: plain value"] });
    expect(logs).toEqual(["hexcard: internal error in conjure_script"]);
    expect(logs.join("")).not.toContain("plain value");
  });

  it("escapes U+2028 and U+2029 in every answer", async () => {
    const { handler } = setup();
    const line = (await send(handler, request(14, "tools/call", { name: "render_card", arguments: { source: "x" } }))) as string;
    expect(line).not.toMatch(/[\u2028\u2029]/);
    expect(line).toContain("\\u2028");
    expect(line).toContain("\\u2029");
    expect(resultJson(JSON.parse(line).result)).toEqual({ ok: true, text: "a\u2028b\u2029c" });
    const echoed = (await send(handler, request("\u2028", "ping"))) as string;
    expect(echoed).toBe('{"jsonrpc":"2.0","id":"\\u2028","result":{}}');
  });
});

describe("ids and malformed lines", () => {
  it("keeps the id's value and JSON type", async () => {
    const { handler } = setup();
    expect(await send(handler, request(7, "ping"))).toBe('{"jsonrpc":"2.0","id":7,"result":{}}');
    expect(await send(handler, request("7", "ping"))).toBe('{"jsonrpc":"2.0","id":"7","result":{}}');
    expect(await send(handler, request(-3, "ping"))).toBe('{"jsonrpc":"2.0","id":-3,"result":{}}');
    expect(await send(handler, request(2 ** 53 - 1, "ping"))).toBe(`{"jsonrpc":"2.0","id":${2 ** 53 - 1},"result":{}}`);
  });

  it.each([
    ["invalid UTF-8", new Uint8Array([0x7b, 0xff, 0x7d])],
    ["invalid JSON", encoder.encode('{"jsonrpc": "2.0", "id": 1, "method": "ping"')],
    ["an empty line", new Uint8Array(0)],
    ["a CR alone", encoder.encode("\r")],
  ])("answers %s with -32700 and id null", async (_label, bytes) => {
    const { handler } = setup();
    expect(JSON.parse((await handler.handleLine(bytes)) as string)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  it("reads a CR before the LF as white space", async () => {
    const { handler } = setup();
    expect(await handler.handleLine(encoder.encode(`${JSON.stringify(request(1, "ping"))}\r`))).toBe('{"jsonrpc":"2.0","id":1,"result":{}}');
  });

  it.each([
    ["a batch", [request(1, "ping")]],
    ["an empty batch", []],
    ["a number", 7],
    ["a string", "ping"],
    ["null", null],
    ["a wrong jsonrpc", { jsonrpc: "1.0", id: 1, method: "ping" }],
    ["no jsonrpc", { id: 1, method: "ping" }],
    ["a method that is not a string", { jsonrpc: "2.0", id: 1, method: 5 }],
    ["no method", { jsonrpc: "2.0", id: 1 }],
    ["a null id", { jsonrpc: "2.0", id: null, method: "ping" }],
    ["a fractional id", { jsonrpc: "2.0", id: 1.5, method: "ping" }],
    ["an unsafe integer id", { jsonrpc: "2.0", id: 2 ** 53, method: "ping" }],
    ["an object id", { jsonrpc: "2.0", id: {}, method: "ping" }],
    ["array params", { jsonrpc: "2.0", id: 1, method: "ping", params: [] }],
    ["null params", { jsonrpc: "2.0", id: 1, method: "ping", params: null }],
    ["a notification with array params", { jsonrpc: "2.0", method: "notifications/initialized", params: [1] }],
  ])("answers %s with -32600 and id null", async (_label, message) => {
    const { handler } = setup();
    expect(JSON.parse((await send(handler, JSON.stringify(message))) as string)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  });

  it("puts no text of the line into an error answer", async () => {
    const { handler } = setup();
    const secret = "TOP-SECRET-TEXT";
    for (const line of [`{"x": "${secret}"`, `{"jsonrpc":"2.0","id":1,"method":"${secret}"}`, `["${secret}"]`]) {
      expect(await send(handler, line)).not.toContain(secret);
    }
  });

  it("gives the overflow answer -32600 with id null", () => {
    const { handler } = setup();
    expect(JSON.parse(handler.overflowAnswer())).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
  });
});
