/// <reference types="node" />
// Line splitting, 32 MiB line limit and serial answers for the MCP stdio transport
// (spec 07 Requirements 4.1, 4.8-4.10; design §stdio.ts).

import type { ProtocolHandler } from "./protocol.ts";

/** Requirement 4.8: a line longer than this (before its LF) is discarded and answered once with -32600. */
export const MAX_LINE_BYTES = 33_554_432;

const LF = 0x0a;

/** Where answers go. The process.stdout adapter resolves once the stream has taken the text. */
export interface LineSink {
  write(text: string): Promise<void>;
}

function isNodeStream(output: NodeJS.WritableStream | LineSink): output is NodeJS.WritableStream {
  return typeof (output as Partial<NodeJS.WritableStream>).on === "function";
}

/**
 * A LineSink over a Node writable stream. Each write resolves in its callback, so the next line is
 * handled only after the stream accepted the answer (back-pressure, design D15). A failed write
 * (for example a closed standard output) rejects; the 'error' event is observed so that it does not
 * become an uncaught exception.
 */
function streamSink(stream: NodeJS.WritableStream): LineSink {
  let failure: unknown;
  stream.on("error", (error: unknown) => {
    failure ??= error;
  });
  return {
    write(text) {
      if (failure !== undefined) return Promise.reject(failure);
      return new Promise<void>((resolve, reject) => {
        stream.write(text, "utf8", (error?: Error | null) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function concat(parts: readonly Uint8Array[], last: Uint8Array): Uint8Array {
  if (parts.length === 0) return last;
  let length = last.length;
  for (const part of parts) length += part.length;
  const line = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    line.set(part, at);
    at += part.length;
  }
  line.set(last, at);
  return line;
}

/**
 * Reads `input` to its end and answers every complete line in order. A line is the bytes before an
 * LF; a CR before the LF stays in the line. The bytes after the last LF are dropped without an
 * answer. Each answer is written, followed by one LF, before the next line is handled. When a write
 * fails, reading stops and the promise resolves (design §Error Handling).
 */
export async function serveLines(
  input: AsyncIterable<Uint8Array>,
  output: NodeJS.WritableStream | LineSink,
  handler: Pick<ProtocolHandler, "handleLine" | "overflowAnswer">,
  maxLineBytes: number = MAX_LINE_BYTES,
): Promise<void> {
  const sink = isNodeStream(output) ? streamSink(output) : output;
  /** Writes one answer line; false when the write failed. */
  const answer = async (text: string): Promise<boolean> => {
    try {
      await sink.write(`${text}\n`);
      return true;
    } catch {
      return false;
    }
  };

  // The partial line: copies of chunk slices, so a reused input buffer cannot change them.
  let parts: Uint8Array[] = [];
  let partLength = 0;
  let discarding = false;

  for await (const chunk of input) {
    let start = 0;
    for (;;) {
      const lf = chunk.indexOf(LF, start);
      if (lf < 0) {
        const rest = chunk.subarray(start);
        if (!discarding && rest.length > 0) {
          if (partLength + rest.length > maxLineBytes) {
            // Discard mode until the next LF: at most maxLineBytes of the line were ever kept.
            parts = [];
            partLength = 0;
            discarding = true;
          } else {
            parts.push(new Uint8Array(rest));
            partLength += rest.length;
          }
        }
        break;
      }
      const piece = chunk.subarray(start, lf);
      start = lf + 1;
      if (discarding || partLength + piece.length > maxLineBytes) {
        parts = [];
        partLength = 0;
        discarding = false;
        if (!(await answer(handler.overflowAnswer()))) return;
        continue;
      }
      const line = concat(parts, piece);
      parts = [];
      partLength = 0;
      const reply = await handler.handleLine(line);
      if (reply !== null && !(await answer(reply))) return;
    }
  }
}
