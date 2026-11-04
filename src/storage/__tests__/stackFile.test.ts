import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_DECOMPRESSED_BYTES,
  StackPayloadError,
  base64UrlToBytes,
  bytesToBase64Url,
  decodeStackFile,
  decodeStackPayload,
  encodeStackFile,
  encodeStackPayload,
  stackFileName,
} from "../stackFile.ts";
import { makeStack } from "./fixtures.ts";

async function deflate(text: string): Promise<string> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return bytesToBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
}

describe("stack payload (deflate-raw + Base64URL)", () => {
  it("round-trips a stack and uses only the unpadded Base64URL alphabet", async () => {
    const stack = makeStack({ name: "Ünïcode ✓ stack" });
    const payload = await encodeStackPayload(stack);
    expect(payload).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(await decodeStackPayload(payload)).toEqual(stack);
    expect(payload.length).toBeLessThan(JSON.stringify(stack).length);
  });

  it("a .hexstack file is the payload text; surrounding whitespace is ignored on read", async () => {
    const stack = makeStack();
    const text = await encodeStackFile(stack);
    expect(text).toBe(await encodeStackPayload(stack));
    expect(await decodeStackFile(`\n ${text}\r\n`)).toEqual(stack);
  });

  it("Property: Base64URL decoding inverts encoding for any bytes", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        const text = bytesToBase64Url(bytes);
        expect(text).toMatch(/^[A-Za-z0-9_-]*$/);
        expect([...base64UrlToBytes(text)]).toEqual([...bytes]);
      }),
    );
  });

  it("Property: the payload round-trips any stack text content", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), fc.string(), async (name, content) => {
        const stack = makeStack({ name });
        const field = stack.cards[0].parts[0];
        if (field.type === "field") field.content = content;
        expect(await decodeStackPayload(await encodeStackPayload(stack))).toEqual(stack);
      }),
      { numRuns: 50 },
    );
  });

  it("rejects text outside the Base64URL alphabet, padding and impossible lengths", async () => {
    for (const bad of ["ab+c", "ab/c", "abc=", "ab c", "abcde"]) {
      await expect(decodeStackPayload(bad)).rejects.toBeInstanceOf(StackPayloadError);
    }
  });

  it("rejects data that is not deflate-raw, UTF-8 or JSON", async () => {
    await expect(decodeStackPayload("")).rejects.toBeInstanceOf(StackPayloadError);
    await expect(decodeStackPayload(bytesToBase64Url(new Uint8Array([0xff, 0xff, 0xff, 0xff])))).rejects.toBeInstanceOf(StackPayloadError);
    await expect(decodeStackPayload(await deflate("{not json"))).rejects.toThrow("not valid JSON");

    const stream = new Blob([new Uint8Array([0x7b, 0xc3, 0x28, 0x7d])]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    const invalidUtf8 = bytesToBase64Url(new Uint8Array(await new Response(stream).arrayBuffer()));
    await expect(decodeStackPayload(invalidUtf8)).rejects.toThrow("UTF-8");
  });

  it("stops inflating once the output passes the size limit", async () => {
    const payload = await deflate(`"${"a".repeat(100_000)}"`);
    await expect(decodeStackPayload(payload, 10_000)).rejects.toThrow("larger than 10000 bytes");
    expect(await decodeStackPayload(payload)).toHaveLength(100_000);
    expect(MAX_DECOMPRESSED_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe("stackFileName", () => {
  it("names the file after the stack, replacing characters file systems reject", () => {
    expect(stackFileName({ name: "Haunted Mansion" })).toBe("Haunted Mansion.hexstack");
    expect(stackFileName({ name: 'a/b\\c:d*e?"f<g>h|i' })).toBe("a-b-c-d-e-f-g-h-i.hexstack");
    expect(stackFileName({ name: "  " })).toBe("Untitled.hexstack");
    expect(stackFileName({ name: "..hidden" })).toBe("hidden.hexstack");
  });
});
