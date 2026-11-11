/// <reference types="node" />
// The committed server file as a child process, started the way mcp.json starts it (spec 07
// Requirements 2.5, 2.7, 3.3, 3.7, 4.10, 17.3, 17.5). Tools covered: the three of task 3.2.

import { spawn } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { POWER_DIR, SERVER_FILE_PATH } from "../../../scripts/buildPowerServer.ts";
import { makeStack } from "./toolFixtures.ts";

const TIMEOUT = 60_000;
const MCP_ARGS = (
  JSON.parse(readFileSync(join(POWER_DIR, "mcp.json"), "utf8")) as { mcpServers: { hexcard: { args: string[] } } }
).mcpServers.hexcard.args;

/** The args of mcp.json with ${PLUGIN_ROOT} replaced by `root`, as the client replaces it. */
const argsFor = (root: string): string[] => MCP_ARGS.map((arg) => arg.split("${PLUGIN_ROOT}").join(root));

const temps: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "hexcard-power-test-"));
  temps.push(dir);
  return dir;
};
afterAll(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  stdout: Buffer;
  stderr: string;
  status: number | null;
  /** Milliseconds from the last standard output data to the exit. */
  exitDelay: number;
}

/** Starts node with `args`, writes `input` in order (with back-pressure), closes standard input and waits for the exit. */
function runServer(args: string[], input: (string | Buffer)[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    let lastOut = Date.now();
    let exitAt = 0;
    child.stdout.on("data", (chunk: Buffer) => {
      out.push(chunk);
      lastOut = Date.now();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("exit", () => {
      exitAt = Date.now();
    });
    child.on("close", (status) => resolve({ stdout: Buffer.concat(out), stderr: err, status, exitDelay: exitAt - lastOut }));
    child.stdin.on("error", () => {
      // The server may exit (start check) before it reads its input.
    });
    void (async () => {
      for (const piece of input) {
        await new Promise<void>((done) => child.stdin.write(piece, () => done()));
      }
      child.stdin.end();
    })();
  });
}

const line = (message: unknown): string => `${JSON.stringify(message)}\n`;
const request = (id: number, method: string, params?: unknown): string =>
  line(params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params });
const call = (id: number, name: string, args: unknown): string => request(id, "tools/call", { name, arguments: args });

const STACK_TEXT = JSON.stringify(makeStack());
/** One call per tool with valid arguments that give ok true. */
const OK_CALLS = [
  { name: "validate_stack", args: { stack: STACK_TEXT } },
  { name: "compile_hextalk", args: { source: "on mouseUp\n  go next\nend mouseUp" } },
  { name: "conjure_script", args: { prompt: "beep" } },
] as const;
/** One call per tool with an argument that breaks its inputSchema, and the path the error names. */
const BAD_CALLS = [
  { name: "validate_stack", args: { stack: 5 }, path: "stack" },
  { name: "compile_hextalk", args: { source: "on mouseUp\nend mouseUp", extra: true }, path: "extra" },
  { name: "conjure_script", args: { prompt: "beep", objectKind: "robot" }, path: "objectKind" },
] as const;
const TOOL_NAMES = OK_CALLS.map((entry) => entry.name);

const answersOf = (stdout: Buffer): any[] => {
  const text = stdout.toString("utf8");
  expect(text.endsWith("\n")).toBe(true);
  return text.slice(0, -1).split("\n").map((entry) => JSON.parse(entry));
};
const payloadOf = (answer: any): any => JSON.parse(answer.result.content[0].text);

/** initialize, tools/list and the ok calls, ids 1 to 5. */
const SHORT_SESSION = [
  request(1, "initialize", { protocolVersion: "2025-11-25" }),
  line({ jsonrpc: "2.0", method: "notifications/initialized" }),
  request(2, "tools/list"),
  ...OK_CALLS.map((entry, i) => call(3 + i, entry.name, entry.args)),
];

function expectShortSession(answers: any[]): void {
  expect(answers.map((answer) => answer.id)).toEqual([1, 2, 3, 4, 5]);
  expect(answers[0].result.serverInfo.name).toBe("hexcard");
  expect(answers[1].result.tools.map((tool: { name: string }) => tool.name)).toEqual(TOOL_NAMES);
  for (const answer of answers.slice(2)) {
    expect(answer.result.isError).toBe(false);
    expect(payloadOf(answer).ok).toBe(true);
  }
}

describe("server process, started with the args of mcp.json", () => {
  it(
    "answers the end-to-end sequence in order and exits with 0 when standard input ends (Requirements 4.10, 17.3)",
    async () => {
      const version = (JSON.parse(readFileSync(join(POWER_DIR, "plugin.json"), "utf8")) as { version: string }).version;
      const input: (string | Buffer)[] = [
        request(1, "initialize", { protocolVersion: "2025-11-25" }),
        line({ jsonrpc: "2.0", method: "notifications/initialized" }),
        request(2, "tools/list"),
        ...OK_CALLS.map((entry, i) => call(3 + i, entry.name, entry.args)),
        ...BAD_CALLS.map((entry, i) => call(6 + i, entry.name, entry.args)),
        request(9, "resources/list"),
        "{not json\n",
        Buffer.alloc(33_554_433, 0x61),
        "\n",
        request(10, "ping"),
      ];
      const run = await runServer(argsFor(POWER_DIR), input);
      expect(run.status).toBe(0);
      expect(run.stderr).toBe("");
      expect(run.exitDelay).toBeLessThan(1000);
      const answers = answersOf(run.stdout);
      expect(answers.map((answer) => answer.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, null, null, 10]);
      for (const answer of answers) expect(answer.jsonrpc).toBe("2.0");

      expect(answers[0].result).toEqual({
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "hexcard", version },
      });
      const tools = answers[1].result.tools as { name: string; annotations: unknown }[];
      expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
      for (const tool of tools) {
        expect(tool.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      }
      for (const answer of answers.slice(2, 5)) {
        expect(answer.result.isError).toBe(false);
        expect(payloadOf(answer).ok).toBe(true);
      }
      BAD_CALLS.forEach((entry, i) => {
        const answer = answers[5 + i];
        expect(answer.result.isError).toBe(true);
        const payload = payloadOf(answer);
        expect(payload.ok).toBe(false);
        expect(payload.errors.some((error: string) => error.startsWith(`${entry.path}:`))).toBe(true);
      });
      expect(answers[8].error.code).toBe(-32601);
      expect(answers[9].error.code).toBe(-32700);
      expect(answers[10].error.code).toBe(-32600);
      expect(answers[11].result).toEqual({});
    },
    TIMEOUT,
  );

  it(
    "gives byte-identical answers from two working folders, with PLUGIN_ROOT and PLUGIN_DATA set and unset (Requirement 2.5)",
    async () => {
      const data = tempDir();
      const withVars = { ...process.env, PLUGIN_ROOT: POWER_DIR, PLUGIN_DATA: data };
      const withoutVars = { ...process.env };
      delete withoutVars.PLUGIN_ROOT;
      delete withoutVars.PLUGIN_DATA;
      const runs: Run[] = [];
      for (const cwd of [tempDir(), tempDir()]) {
        for (const env of [withVars, withoutVars]) runs.push(await runServer(argsFor(POWER_DIR), SHORT_SESSION, { cwd, env }));
      }
      expectShortSession(answersOf(runs[0].stdout));
      for (const run of runs) {
        expect(run.status).toBe(0);
        expect(run.stdout.equals(runs[0].stdout)).toBe(true);
      }
    },
    TIMEOUT,
  );

  it(
    "refuses to start without --permission and with --allow-fs-write=* (Requirement 2.7)",
    async () => {
      const args = argsFor(POWER_DIR);
      // Node itself refuses --allow-fs-read without --permission, so both permission args go.
      const withoutPermission = args.filter((arg) => arg !== "--permission" && !arg.startsWith("--allow-fs-read="));
      const withWrites = [...args.slice(0, -1), "--allow-fs-write=*", args.at(-1)!];
      for (const startArgs of [withoutPermission, withWrites]) {
        const run = await runServer(startArgs, [request(1, "initialize", { protocolVersion: "2025-11-25" })]);
        expect(run.status).toBe(1);
        expect(run.stdout.length).toBe(0);
        expect(run.stderr.endsWith("\n")).toBe(true);
        expect(run.stderr.split("\n")).toHaveLength(2);
        expect(run.stderr).toMatch(/^hexcard: refusing to start: /);
      }
    },
    TIMEOUT,
  );

  it(
    "works as a copy alone in an empty folder outside the repository (Requirement 3.7)",
    async () => {
      const dir = tempDir();
      const copy = join(dir, "hexcard-mcp.mjs");
      copyFileSync(SERVER_FILE_PATH, copy);
      const args = [MCP_ARGS[0], `--allow-fs-read=${copy}`, MCP_ARGS[2], copy];
      expect(MCP_ARGS[0]).toBe("--permission");
      expect(MCP_ARGS[2]).toBe("--disallow-code-generation-from-strings");
      const run = await runServer(args, SHORT_SESSION, { cwd: dir });
      expect(run.status).toBe(0);
      expectShortSession(answersOf(run.stdout));
    },
    TIMEOUT,
  );

  it(
    "never constructs Function during start-up or a call of each tool (Requirement 3.3)",
    async () => {
      // A data: module loaded with --import before the server: it wraps globalThis.Function and
      // reports, at exit, how often the wrapper was constructed or called.
      const trap =
        "data:text/javascript," +
        encodeURIComponent(
          "let n=0;const F=globalThis.Function;" +
            "globalThis.Function=new Proxy(F,{construct(t,a,nt){n++;return Reflect.construct(t,a,nt)},apply(t,th,a){n++;return Reflect.apply(t,th,a)}});" +
            'process.on("exit",()=>process.stderr.write("FUNCTION_TRAP "+n+"\\n"));',
        );
      // The trap counts a call: a control run that constructs Function once.
      const control = await runServer([`--import=${trap}`, "--input-type=module", "-e", 'try { new Function("") } catch {}'], []);
      expect(control.stderr).toBe("FUNCTION_TRAP 1\n");

      const args = argsFor(POWER_DIR);
      const run = await runServer([...args.slice(0, -1), `--import=${trap}`, args.at(-1)!], SHORT_SESSION);
      expect(run.status).toBe(0);
      expectShortSession(answersOf(run.stdout));
      expect(run.stderr).toBe("FUNCTION_TRAP 0\n");
    },
    TIMEOUT,
  );
});
