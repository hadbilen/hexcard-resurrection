import { describe, expect, it } from "vitest";
import { encodeStackPayload } from "../stackFile.ts";
import { MAX_SHARE_LINK_LENGTH, SHARE_HASH_PREFIX, buildShareLink, decodeSharePayload, readShareHash, stripHash } from "../urlCodec.ts";
import { makeStack, noiseLayer } from "./fixtures.ts";

describe("share links", () => {
  it("put the .hexstack payload in the hash of the page URL, replacing an old hash", async () => {
    const stack = makeStack();
    const link = await buildShareLink(stack, "https://example.org/hexcard/?v=1#old");
    expect(link.url).toBe(`https://example.org/hexcard/?v=1${SHARE_HASH_PREFIX}${await encodeStackPayload(stack)}`);
    expect(link.tooLong).toBe(false);

    const payload = readShareHash(new URL(link.url).hash);
    expect(payload).toBeDefined();
    expect(await decodeSharePayload(payload ?? "")).toEqual(stack);
  });

  it("report links longer than 32,000 characters as too long", async () => {
    const stack = makeStack();
    stack.cards[0].bitmap.rleData = noiseLayer(1);
    const link = await buildShareLink(stack, "https://example.org/");
    expect(link.url.length).toBeGreaterThan(MAX_SHARE_LINK_LENGTH);
    expect(link.tooLong).toBe(true);
    expect(MAX_SHARE_LINK_LENGTH).toBe(32_000);
  });

  it("ignore hashes that are not share links", () => {
    expect(readShareHash("")).toBeUndefined();
    expect(readShareHash("#card=2")).toBeUndefined();
    expect(readShareHash("#stack=abc")).toBe("abc");
    expect(stripHash("https://a.b/c")).toBe("https://a.b/c");
  });
});
