/**
 * Message Box lines (spec 06 Requirement 3): classification of a line and the runner that Return in
 * the Message Box calls. Design: .kiro/specs/06-hypercard-classics/design.md §messageBox.ts.
 *
 * - A line is classified by parsing it with the unchanged HexTalk parser inside an ordinary wrapper
 *   handler (`on hexmessagebox` ... `end hexmessagebox`): first as one statement, then as one
 *   expression after `get `. The grammar, reserved words, AST and parser are not changed
 *   (Requirement 3.10).
 * - Statements and expressions run as one command dispatch on the message bus queue, through the
 *   gas-limited VM only (`runMessageBoxLine`, Requirement 3.6). Nothing here evaluates code itself.
 *
 * Pure TypeScript: no React, no DOM. The store, bus, VM host and the Message Box I/O are injected.
 */
import type { HexExprNode, HexStatementNode } from "./ast.ts";
import type { MessageBus } from "./messageBus.ts";
import { parseHexTalk } from "./parser.ts";
import type { HexStore } from "./store.ts";
import { runMessageBoxLine, toText, type HexHost, type HexValue } from "./vm.ts";

export type MessageBoxLine =
  | { kind: "empty" } // blank, or only a -- comment
  | { kind: "statement"; statement: HexStatementNode }
  | { kind: "expression"; expression: HexExprNode }
  | { kind: "error"; message: string; column: number };

export const HANDLER_ONLY = "pass and exit work only inside a handler.";

/** Requirement 3.5: the command words of design spec §4.1, lowercase. */
export const COMMAND_WORDS: ReadonlySet<string> = new Set([
  "go", "visual", "put", "get", "add", "subtract", "multiply", "divide", "set", "play", "answer", "ask", "wait",
  "fetch", "global", "if", "repeat", "pass", "exit", "next",
]);

/** The internal wrapper handler; its name never reaches the user in a located error (see vm.ts). */
const WRAPPER = "hexmessagebox";
const EXPRESSION_PREFIX = "get ";
const FIRST_WORD = /^[A-Za-z][A-Za-z0-9_]*/;
const LINE_BREAKS = /\r\n|\r|\n/g;

function wrap(body: string): string {
  return `on ${WRAPPER}\n${body}\nend ${WRAPPER}`;
}

/** The body of the wrapper handler when the source parsed without errors into that handler only. */
function wrappedBody(source: string): { body: HexStatementNode[] } | { error: { line: number; column: number; message: string } } {
  const { ast, errors } = parseHexTalk(source);
  if (errors.length > 0) return { error: errors[0] };
  const keys = Object.keys(ast.handlers);
  const handler = ast.handlers[WRAPPER];
  if (keys.length !== 1 || !Object.hasOwn(ast.handlers, WRAPPER) || !handler) {
    return { error: { line: 2, column: 1, message: "expected one statement or expression" } };
  }
  return { body: handler.body };
}

/**
 * Maps a wrapper error into the line: wrapper line 2 keeps its column (minus `prefix` for the
 * expression attempt), line 3 (a missing `end`) is the end of the line, line 1 is column 1.
 */
function lineError(error: { line: number; column: number; message: string }, line: string, prefix: number): MessageBoxLine {
  if (error.line === 2) return { kind: "error", message: error.message, column: Math.max(1, error.column - prefix) };
  if (error.line >= 3) {
    // A block left open reaches the wrapper's `end`; name the end of the line, not the wrapper.
    const message = error.message.replace(`"end ${WRAPPER}"`, "the end of the line");
    return { kind: "error", message, column: line.length + 1 };
  }
  return { kind: "error", message: error.message, column: 1 };
}

/**
 * Requirement 3.1-3.5 and 3.8: what a Message Box line is. Line breaks (which a one-line text box
 * never holds) count as spaces, so a line can never reach the wrapper's other lines.
 * A line whose first word is `find` is not special yet (spec 06 task 4.2): it is an expression error.
 */
export function classifyMessageBoxLine(raw: string): MessageBoxLine {
  const line = raw.replace(LINE_BREAKS, " ").trim();
  if (line === "") return { kind: "empty" };
  const firstWord = FIRST_WORD.exec(line)?.[0].toLowerCase() ?? "";

  const asStatement = wrappedBody(wrap(line));
  if ("body" in asStatement) {
    if (asStatement.body.length === 0) return { kind: "empty" };
    if (asStatement.body.length === 1) {
      const statement = asStatement.body[0];
      if (statement.kind === "PassEvent" || statement.kind === "ExitHandler") return { kind: "error", message: HANDLER_ONLY, column: 1 };
      return { kind: "statement", statement };
    }
  }

  const asExpression = wrappedBody(wrap(EXPRESSION_PREFIX + line));
  if ("body" in asExpression && asExpression.body.length === 1) {
    const statement = asExpression.body[0];
    if (statement.kind === "GetValue") return { kind: "expression", expression: statement.value };
  }

  if (COMMAND_WORDS.has(firstWord) && "error" in asStatement) {
    // `pass mouseUp` / `exit mouseUp`: the parser asks for the wrapper's name; no handler is running.
    if ((firstWord === "pass" || firstWord === "exit") && asStatement.error.message.includes(`"${WRAPPER}"`)) {
      return { kind: "error", message: HANDLER_ONLY, column: 1 };
    }
    return lineError(asStatement.error, line, 0);
  }
  if ("error" in asExpression) return lineError(asExpression.error, line, EXPRESSION_PREFIX.length);
  if ("error" in asStatement) return lineError(asStatement.error, line, 0);
  return { kind: "error", message: "expected one statement or expression", column: 1 };
}

/** Requirement 3.4: the value as text (design spec §4.3), every line break shown as one space. */
export function messageBoxValueText(value: HexValue): string {
  return toText(value).replace(LINE_BREAKS, " ");
}

export interface MessageBoxIO {
  /** The line now. */
  line(): string;
  setLine(line: string): void;
  alert(message: string, details?: readonly string[]): void;
}

export interface MessageBoxRunnerDeps {
  store: Pick<HexStore, "getSnapshot">;
  bus: Pick<MessageBus, "runCommand">;
  /** The VM host the bus uses. */
  host: HexHost;
  io: MessageBoxIO;
}

/** The command dispatch label of a Message Box line (also the message name its errors report). */
export const MESSAGE_BOX_COMMAND = "Message Box";

/** Requirement 3: what Return in the Message Box does with `raw` (the untrimmed text box value). */
export function createMessageBoxRunner({ store, bus, host, io }: MessageBoxRunnerDeps): (raw: string) => void {
  // Requirement 3.2: the card that is current when the dispatch starts, read inside the task.
  const currentCardId = (): string => store.getSnapshot().currentCardId;
  return (raw) => {
    const line = classifyMessageBoxLine(raw);
    switch (line.kind) {
      case "empty":
        return;
      case "error":
        io.alert(line.message, [`Column ${line.column}`]);
        return;
      case "statement": {
        const program = { kind: "statement" as const, statement: line.statement };
        bus.runCommand(MESSAGE_BOX_COMMAND, async (ctx) => {
          await runMessageBoxLine(program, currentCardId(), ctx, host);
        });
        return;
      }
      case "expression": {
        const program = { kind: "expression" as const, expression: line.expression };
        bus.runCommand(MESSAGE_BOX_COMMAND, async (ctx) => {
          const value = await runMessageBoxLine(program, currentCardId(), ctx, host);
          // Requirement 3.4: unless the user has changed the line since pressing Return.
          if (value !== undefined && io.line() === raw) io.setLine(messageBoxValueText(value));
        });
        return;
      }
    }
  };
}
