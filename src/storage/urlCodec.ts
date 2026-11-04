/**
 * URL-hash share links (spec 04 Requirement 5.3, design.md §5): the same compressed payload as a
 * `.hexstack` file (stackFile.ts), placed in the hash as `#stack=<Base64URL>`.
 *
 * A link longer than `MAX_SHARE_LINK_LENGTH` characters is reported as too long; the caller then
 * warns and offers the `.hexstack` file instead. Decoded hashes are untrusted and go through the
 * stack loader (stackLoader.ts).
 */
import type { HexStack } from "../core/schema.ts";
import { decodeStackPayload, encodeStackPayload } from "./stackFile.ts";

/** Hash prefix that marks a share link; any other hash is ignored. */
export const SHARE_HASH_PREFIX = "#stack=";

/** Longest share link (whole URL, in characters) HexCard puts on the clipboard. */
export const MAX_SHARE_LINK_LENGTH = 32_000;

export interface ShareLink {
  url: string;
  /** `url.length > MAX_SHARE_LINK_LENGTH`: warn and offer the `.hexstack` file instead. */
  tooLong: boolean;
}

/** `pageUrl` without its hash, e.g. `https://host/app/?x=1#old` -> `https://host/app/?x=1`. */
export function stripHash(pageUrl: string): string {
  const index = pageUrl.indexOf("#");
  return index < 0 ? pageUrl : pageUrl.slice(0, index);
}

/** Builds `<pageUrl without hash>#stack=<payload>`. */
export async function buildShareLink(stack: HexStack, pageUrl: string): Promise<ShareLink> {
  const url = `${stripHash(pageUrl)}${SHARE_HASH_PREFIX}${await encodeStackPayload(stack)}`;
  return { url, tooLong: url.length > MAX_SHARE_LINK_LENGTH };
}

/** The payload of a share-link hash (`location.hash`), or undefined when it is not one. */
export function readShareHash(hash: string): string | undefined {
  return hash.startsWith(SHARE_HASH_PREFIX) ? hash.slice(SHARE_HASH_PREFIX.length) : undefined;
}

/** Decodes a share-link payload into an untrusted value; throws on malformed data. */
export function decodeSharePayload(payload: string): Promise<unknown> {
  return decodeStackPayload(payload);
}
