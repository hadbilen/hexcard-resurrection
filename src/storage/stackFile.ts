/**
 * `.hexstack` files (spec 04 Requirement 5.2, design.md §5) and the compressed stack payload they
 * share with URL-hash links (urlCodec.ts):
 *
 *   encode: JSON.stringify -> UTF-8 -> CompressionStream("deflate-raw") -> Base64URL (no padding)
 *   decode: Base64URL -> DecompressionStream("deflate-raw") -> UTF-8 -> JSON.parse
 *
 * Decoding returns an untrusted value: callers hand it to the stack loader (stackLoader.ts), which
 * validates it before it reaches the store. Every decoding failure throws.
 *
 * No React or DOM access beyond the standard stream, Blob and TextEncoder globals, so it runs in Node.
 */
import type { HexStack } from "../core/schema.ts";

export const STACK_FILE_EXTENSION = ".hexstack";
export const STACK_FILE_MIME_TYPE = "application/x-hexstack";

/**
 * Upper bound for a decompressed payload. It keeps a small crafted file or link from inflating
 * into gigabytes (a "zip bomb"); real stacks stay far below it (one 512x342 layer is at most ~60 KB).
 */
export const MAX_DECOMPRESSED_BYTES = 64 * 1024 * 1024;

/** Thrown for any payload that is not valid Base64URL, deflate-raw, UTF-8 or JSON. */
export class StackPayloadError extends Error {
  override name = "StackPayloadError";
}

// ---------------------------------------------------------------------------------------------
// Base64URL (RFC 4648 §5, without padding)
// ---------------------------------------------------------------------------------------------

const BASE64URL = /^[A-Za-z0-9_-]*$/;
const CHUNK = 0x8000;

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict: only the Base64URL alphabet, no padding, no whitespace, no impossible length. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!BASE64URL.test(text) || text.length % 4 === 1) {
    throw new StackPayloadError("The data is not valid Base64URL");
  }
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------------------------
// deflate-raw
// ---------------------------------------------------------------------------------------------

async function deflateRaw(bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Inflates `bytes`, stopping with an error as soon as the output passes `limit` bytes. */
async function inflateRaw(bytes: Uint8Array<ArrayBuffer>, limit: number): Promise<Uint8Array> {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        await reader.cancel();
        throw new StackPayloadError(`The decompressed stack is larger than ${limit} bytes`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof StackPayloadError) throw error;
    throw new StackPayloadError(`The data is not valid deflate-raw: ${error instanceof Error ? error.message : String(error)}`);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Stack payload
// ---------------------------------------------------------------------------------------------

/** The stack as compressed Base64URL text. Stacks never hold ASTs, so none can be written. */
export async function encodeStackPayload(stack: HexStack): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(stack));
  return bytesToBase64Url(await deflateRaw(json));
}

/**
 * Inverse of `encodeStackPayload`. Returns the parsed JSON as an untrusted value, to be validated
 * by the stack loader. Throws `StackPayloadError` on any malformed input.
 */
export async function decodeStackPayload(payload: string, limit = MAX_DECOMPRESSED_BYTES): Promise<unknown> {
  const inflated = await inflateRaw(base64UrlToBytes(payload), limit);
  let json: string;
  try {
    json = new TextDecoder("utf-8", { fatal: true }).decode(inflated);
  } catch {
    throw new StackPayloadError("The stack is not valid UTF-8");
  }
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new StackPayloadError("The stack is not valid JSON");
  }
}

// ---------------------------------------------------------------------------------------------
// .hexstack files
// ---------------------------------------------------------------------------------------------

/** Contents of a `.hexstack` file: the payload text (ASCII only). */
export function encodeStackFile(stack: HexStack): Promise<string> {
  return encodeStackPayload(stack);
}

/** Reads a `.hexstack` file's text; surrounding whitespace (e.g. a trailing newline) is ignored. */
export function decodeStackFile(text: string): Promise<unknown> {
  return decodeStackPayload(text.trim());
}

/** Characters not allowed in file names on common systems, plus control characters. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILE_NAME = /[\u0000-\u001f\u007f<>:"/\\|?*]+/g;

/** `<stack name>.hexstack`, with characters that file systems reject replaced by "-". */
export function stackFileName(stack: Pick<HexStack, "name">): string {
  const base = stack.name.replace(UNSAFE_FILE_NAME, "-").trim().replace(/^\.+/, "").slice(0, 100).trim();
  return `${base === "" ? "Untitled" : base}${STACK_FILE_EXTENSION}`;
}
