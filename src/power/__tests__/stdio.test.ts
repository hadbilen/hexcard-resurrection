/// <reference types="node" />
// Spec 07 task 3.1: stdio.ts (Requirements 4.1, 4.8, 4.9, 4.10).
import { PassThrough, Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { MAX_LINE_BYTES, serveLines, type LineSink } from "../stdio.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function* chunks(...parts: (string | Uint8Array)[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield typeof part === "string" ? encoder.encode(part) : part;
}

/** Answers "re:<line>"; "silent" is a notification (no answer). */
function echoHandler(events: string[] = []) {
  return {
    seen: [] as string[],
    async handleLine(line: Uint8Array) {
      const text = decoder.decode(line);
      this.seen.push(text);
      events.push(`handle ${text}`);
      return text === "silent" ? null : `re:${text}`;
    },
    overflowAnswer() {
      events.push("overflow");
      return "overflow";
    },
  };
}

function collectingSink(events: string[] = []): LineSink & { text: string } {
  return {
    text: "",
    async write(text) {
      events.push(`write ${text.trimEnd()}`);
      this.text += text;
    },
  };
}

describe("serveLines", () => {
  const INPUT = "a\r\nbc\n\ndéf\nsilent\nxyz";
  const EXPECTED = "re:a\r\nre:bc\nre:\nre:déf\n";

  it("uses a 32 MiB limit", () => {
    expect(MAX_LINE_BYTES).toBe(33_554_432);
  });

  it("splits lines at LF for every chunk boundary, keeps CR and drops the unfinished last line", async () => {
    const bytes = encoder.encode(INPUT);
    for (let cut = 0; cut <= bytes.length; cut++) {
      const handler = echoHandler();
      const sink = collectingSink();
      await serveLines(chunks(bytes.subarray(0, cut), bytes.subarray(cut)), sink, handler);
      expect(sink.text, `cut at ${cut}`).toBe(EXPECTED);
      expect(handler.seen).toEqual(["a\r", "bc", "", "déf", "silent"]);
    }
  });

  it("handles one-byte chunks and a reused input buffer", async () => {
    const bytes = encoder.encode(INPUT);
    const shared = new Uint8Array(1);
    async function* reused(): AsyncGenerator<Uint8Array> {
      for (const byte of bytes) {
        shared[0] = byte;
        yield shared;
      }
    }
    const sink = collectingSink();
    await serveLines(reused(), sink, echoHandler());
    expect(sink.text).toBe(EXPECTED);
  });

  it("treats a line of exactly maxLineBytes as a normal line and one byte more as an overflow", async () => {
    const handler = echoHandler();
    const sink = collectingSink();
    await serveLines(chunks("abcd\n", "ab", "cde", "fgh", "ij\nok\n", "ab", "cd", "\n"), sink, handler, 4);
    expect(sink.text).toBe("re:abcd\noverflow\nre:ok\nre:abcd\n");
    expect(handler.seen).toEqual(["abcd", "ok", "abcd"]);
  });

  it("answers an overflow once, also when the LF comes in the same chunk", async () => {
    const sink = collectingSink();
    await serveLines(chunks("abcdefgh\nab\n"), sink, echoHandler(), 4);
    expect(sink.text).toBe("overflow\nre:ab\n");
  });

  it("drops an unfinished overflowing last line without an answer", async () => {
    const sink = collectingSink();
    await serveLines(chunks("ok\n", "abcdefgh"), sink, echoHandler(), 4);
    expect(sink.text).toBe("re:ok\n");
  });

  it("writes each answer before it handles the next line", async () => {
    const events: string[] = [];
    const sink: LineSink = {
      async write(text) {
        events.push(`write start ${text.trimEnd()}`);
        await new Promise((resolve) => setTimeout(resolve, 5));
        events.push(`write end ${text.trimEnd()}`);
      },
    };
    await serveLines(chunks("one\ntwo\n"), sink, echoHandler(events));
    expect(events).toEqual(["handle one", "write start re:one", "write end re:one", "handle two", "write start re:two", "write end re:two"]);
  });

  it("stops reading when a write fails", async () => {
    const handler = echoHandler();
    const sink: LineSink = { write: () => Promise.reject(new Error("EPIPE")) };
    await expect(serveLines(chunks("one\ntwo\n", "three\n"), sink, handler)).resolves.toBeUndefined();
    expect(handler.seen).toEqual(["one"]);
  });

  it("writes to a Node stream, one answer per line", async () => {
    const output = new PassThrough();
    let text = "";
    output.on("data", (data: Buffer) => {
      text += data.toString("utf8");
    });
    await serveLines(chunks("x\ny\n"), output, echoHandler());
    expect(text).toBe("re:x\nre:y\n");
  });

  it("stops when the Node stream fails", async () => {
    const failing = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("EPIPE"));
      },
    });
    const handler = echoHandler();
    await serveLines(chunks("one\ntwo\n"), failing, handler);
    expect(handler.seen).toEqual(["one"]);
  });
});
