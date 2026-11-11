/// <reference types="node" />
// JSON-RPC 2.0 / MCP handler (spec 07 Requirement 4; design §protocol.ts). One input line in, one
// answer text (or null for a notification) out. Never throws.

import { checkArguments } from "./argumentCheck.ts";
import { errorResult, shortenMessage, type CallToolResult } from "./results.ts";
import type { PowerTool } from "./tools/index.ts";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;
export const LATEST_PROTOCOL_VERSION = "2025-11-25";

export interface ProtocolOptions {
  /** The tests inject a throwing tool here (Requirement 17.1). */
  tools: readonly PowerTool[];
  serverVersion: string;
  /** Diagnostics; default writes one line to standard error. */
  log?: (line: string) => void;
}

export interface ProtocolHandler {
  /** The answer's JSON text (no LF), or null for a notification. Never throws. */
  handleLine(line: Uint8Array): Promise<string | null>;
  /** Answer to a line longer than MAX_LINE_BYTES. */
  overflowAnswer(): string;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/** Requirement 4.3: the same four annotations on every tool. */
const TOOL_ANNOTATIONS = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

type RequestId = string | number;

interface Request {
  id: RequestId;
  method: string;
  params: Record<string, unknown> | undefined;
}

const hasOwn = (object: object, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON text with U+2028 and U+2029 written as escapes (design D16). Both can only occur inside JSON
 * strings, where the escape means the same character.
 */
function serialize(message: unknown): string {
  return JSON.stringify(message).replace(/[\u2028\u2029]/g, (c) => (c === "\u2028" ? "\\u2028" : "\\u2029"));
}

function errorAnswer(id: RequestId | null, code: number, message: string): string {
  return serialize({ jsonrpc: "2.0", id, error: { code, message } });
}

function resultAnswer(id: RequestId, result: unknown): string {
  return serialize({ jsonrpc: "2.0", id, result });
}

/** "request", "notification", or null when the value is neither (Requirement 4.7). */
function classify(value: unknown): Request | "notification" | null {
  if (!isPlainObject(value)) return null;
  if (value.jsonrpc !== "2.0" || typeof value.method !== "string") return null;
  const params = value.params;
  if (hasOwn(value, "params") && !isPlainObject(params)) return null;
  if (!hasOwn(value, "id")) return "notification";
  const id = value.id;
  // Design D19: an integer id must be a safe integer, so it is echoed with the same value.
  if (typeof id !== "string" && !Number.isSafeInteger(id)) return null;
  return { id: id as RequestId, method: value.method, params: params as Record<string, unknown> | undefined };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const defaultLog = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

export function createProtocolHandler(options: ProtocolOptions): ProtocolHandler {
  const { tools, serverVersion } = options;
  const log = options.log ?? defaultLog;
  const decoder = new TextDecoder("utf-8", { fatal: true });

  function initialize(params: Record<string, unknown> | undefined): unknown {
    const requested = params?.protocolVersion;
    const protocolVersion =
      typeof requested === "string" && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested)
        ? requested
        : LATEST_PROTOCOL_VERSION;
    return {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "hexcard", version: serverVersion },
    };
  }

  function listTools(): unknown {
    return {
      tools: tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: TOOL_ANNOTATIONS,
      })),
    };
  }

  /** The tools/call answer: a JSON-RPC error text for a bad tool name, else the CallToolResult. */
  async function callTool(id: RequestId, params: Record<string, unknown> | undefined): Promise<string> {
    if (params === undefined || !hasOwn(params, "name")) return errorAnswer(id, INVALID_PARAMS, "Invalid params: missing tool name");
    const name = params.name;
    if (typeof name !== "string") return errorAnswer(id, INVALID_PARAMS, "Invalid params: tool name must be a string");
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) return errorAnswer(id, INVALID_PARAMS, "Invalid params: unknown tool");

    const args = hasOwn(params, "arguments") ? params.arguments : {};
    let result: CallToolResult;
    if (!isPlainObject(args)) {
      result = errorResult(["arguments: must be an object"]);
    } else {
      try {
        const problems = tool.checkArguments ? tool.checkArguments(args) : checkArguments(tool.inputSchema, args);
        result = problems.length > 0 ? errorResult(problems) : await tool.run(args);
      } catch (error) {
        // Requirement 4.10: the message goes into the result, never into the log line.
        log(`hexcard: internal error in ${tool.name}`);
        result = errorResult([`Internal error in ${tool.name}: ${shortenMessage(messageOf(error))}`]);
      }
    }
    return resultAnswer(id, result);
  }

  async function handleRequest(request: Request): Promise<string> {
    switch (request.method) {
      case "initialize":
        return resultAnswer(request.id, initialize(request.params));
      case "ping":
        return resultAnswer(request.id, {});
      case "tools/list":
        return resultAnswer(request.id, listTools());
      case "tools/call":
        return callTool(request.id, request.params);
      default:
        return errorAnswer(request.id, METHOD_NOT_FOUND, "Method not found");
    }
  }

  return {
    async handleLine(line) {
      let value: unknown;
      try {
        value = JSON.parse(decoder.decode(line));
      } catch {
        return errorAnswer(null, PARSE_ERROR, "Parse error");
      }
      const request = classify(value);
      if (request === null) return errorAnswer(null, INVALID_REQUEST, "Invalid Request");
      if (request === "notification") return null;
      try {
        return await handleRequest(request);
      } catch {
        // Only reachable through a fault outside a tool's run (for example an answer that cannot
        // be serialized). The method name is the only input text the log line may carry.
        log(`hexcard: internal error in ${request.method}`);
        return errorAnswer(request.id, INTERNAL_ERROR, "Internal error");
      }
    },
    overflowAnswer() {
      return errorAnswer(null, INVALID_REQUEST, "Invalid Request");
    },
  };
}
