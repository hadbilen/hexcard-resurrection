/**
 * Sandboxed network fetch for the HexTalk `fetch` command.
 * Design: .kiro/specs/02-hextalk-ast-vm/design.md §5. Policy: hexcard_design_spec.md §4.3.
 *
 * - Only `https:` URLs (plus `http://localhost` in development builds); URLs with embedded
 *   credentials are blocked.
 * - Always `GET` with `credentials: "omit"` and `referrerPolicy: "no-referrer"`; no headers are
 *   ever sent, so stacks cannot carry auth tokens.
 * - One 8 s `AbortController` timeout covers the whole request, including the body read.
 * - The body is read as a stream and cancelled as soon as it exceeds 256 KB.
 * - The body must be UTF-8 JSON. The optional JSON path (`Key { "." Key | "[" Digits "]" }`) is
 *   walked over own properties and array indices only.
 * - Primitives become their string form; objects and arrays become compact JSON.
 *
 * `fetchJson` never throws or rejects: every failure is a `{ ok: false, reason }` result, and the VM
 * turns it into `it = "error: <reason>"` while leaving the destination unchanged.
 * Pure TypeScript: uses only `fetch`, `URL`, `AbortController` and `TextDecoder`, which exist in
 * both Node and browsers.
 */
import type { FetchResult } from "./vm.ts";

/** Whole-request timeout (connect, headers and body). */
export const FETCH_TIMEOUT_MS = 8_000;
/** Maximum response body size in bytes. */
export const FETCH_MAX_BYTES = 256 * 1024;

/** Failure reasons; the VM shows them as `it = "error: <reason>"`. */
export const FETCH_ERROR = {
  blockedUrl: "blocked url",
  timeout: "timeout",
  notJson: "not json",
  pathNotFound: "path not found",
  tooLarge: "too large",
  network: "network error",
} as const;

/** True in Vite development builds (`npm run dev`); false in production and player builds. */
const DEV_BUILD: boolean = import.meta.env?.DEV === true;

export interface FetchPolicyOptions {
  /** The `fetch` implementation; defaults to the global one. Injected by tests. */
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Allow `http://localhost`; defaults to whether this is a development build. */
  allowLocalhost?: boolean;
}

// ---------------------------------------------------------------------------------------------
// URL policy
// ---------------------------------------------------------------------------------------------

/** Returns the parsed URL if the policy allows it, otherwise `null`. */
export function checkFetchUrl(url: string, allowLocalhost: boolean = DEV_BUILD): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.username !== "" || parsed.password !== "") return null;
  if (parsed.protocol === "https:") return parsed;
  if (allowLocalhost && parsed.protocol === "http:" && parsed.hostname === "localhost") return parsed;
  return null;
}

// ---------------------------------------------------------------------------------------------
// JSON path
// ---------------------------------------------------------------------------------------------

export type JsonPathSegment = { key: string } | { index: number };

const PATH_KEY = /^[A-Za-z_][A-Za-z0-9_]*/;
const PATH_INDEX = /^\[([0-9]+)\]/;

/** Parses `Key { "." Key | "[" Digits "]" }`; returns `null` on any syntax error. */
export function parseJsonPath(path: string): JsonPathSegment[] | null {
  const first = PATH_KEY.exec(path);
  if (!first) return null;
  const segments: JsonPathSegment[] = [{ key: first[0] }];
  let rest = path.slice(first[0].length);
  while (rest !== "") {
    if (rest.startsWith(".")) {
      const key = PATH_KEY.exec(rest.slice(1));
      if (!key) return null;
      segments.push({ key: key[0] });
      rest = rest.slice(1 + key[0].length);
    } else {
      const index = PATH_INDEX.exec(rest);
      if (!index) return null;
      segments.push({ index: Number(index[1]) });
      rest = rest.slice(index[0].length);
    }
  }
  return segments;
}

/**
 * Walks `segments` over a parsed JSON value. Keys match only own properties of plain objects and
 * indices only elements of arrays, so prototype members (`constructor`, `length`, ...) never match.
 */
export function evaluateJsonPath(
  value: unknown,
  segments: readonly JsonPathSegment[],
): { found: true; value: unknown } | { found: false } {
  let current = value;
  for (const segment of segments) {
    if ("key" in segment) {
      if (typeof current !== "object" || current === null || Array.isArray(current)) return { found: false };
      if (!Object.hasOwn(current, segment.key)) return { found: false };
      current = (current as Record<string, unknown>)[segment.key];
    } else {
      if (!Array.isArray(current) || segment.index >= current.length) return { found: false };
      current = current[segment.index];
    }
  }
  return { found: true, value: current };
}

/** Primitives as their string form (`null` -> "null"); objects and arrays as compact JSON. */
export function stringifyJsonResult(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

// ---------------------------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------------------------

type BodyResult = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too large" | "aborted" };

/** Reads the body as a stream, cancelling it once it exceeds `FETCH_MAX_BYTES` or `signal` aborts. */
async function readCappedBody(response: Response, signal: AbortSignal): Promise<BodyResult> {
  if (response.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = response.body.getReader();
  // Cancelling settles a pending read even when the stream ignores the abort signal.
  const onAbort = (): void => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      if (signal.aborted) return { ok: false, reason: "aborted" };
      const { done, value } = await reader.read();
      if (signal.aborted) return { ok: false, reason: "aborted" };
      if (done) break;
      total += value.byteLength;
      if (total > FETCH_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: "too large" };
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes };
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

function defaultFetch(input: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(input, init);
}

/**
 * Runs one sandboxed `fetch` and evaluates the optional JSON path. Never rejects.
 * Hosts implement `HexHost.fetchJson` by calling this.
 */
export async function fetchJson(url: string, jsonPath?: string, options: FetchPolicyOptions = {}): Promise<FetchResult> {
  const allowLocalhost = options.allowLocalhost ?? DEV_BUILD;
  const target = checkFetchUrl(url, allowLocalhost);
  if (!target) return { ok: false, reason: FETCH_ERROR.blockedUrl };

  // A path that does not match the grammar can never be found; fail before touching the network.
  const segments = jsonPath === undefined ? [] : parseJsonPath(jsonPath);
  if (segments === null) return { ok: false, reason: FETCH_ERROR.pathNotFound };

  const fetchImpl = options.fetch ?? defaultFetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      // Fixed request: no headers, no body, no credentials, no referrer.
      response = await fetchImpl(target.href, {
        method: "GET",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal,
      });
    } catch {
      return { ok: false, reason: controller.signal.aborted ? FETCH_ERROR.timeout : FETCH_ERROR.network };
    }

    // A redirect must not lead outside the URL policy.
    if (response.url !== "" && !checkFetchUrl(response.url, allowLocalhost)) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: FETCH_ERROR.blockedUrl };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: `http ${response.status}` };
    }

    let body: BodyResult;
    try {
      body = await readCappedBody(response, controller.signal);
    } catch {
      return { ok: false, reason: controller.signal.aborted ? FETCH_ERROR.timeout : FETCH_ERROR.network };
    }
    if (!body.ok) return { ok: false, reason: body.reason === "too large" ? FETCH_ERROR.tooLarge : FETCH_ERROR.timeout };

    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body.bytes));
    } catch {
      return { ok: false, reason: FETCH_ERROR.notJson };
    }

    const found = evaluateJsonPath(data, segments);
    if (!found.found) return { ok: false, reason: FETCH_ERROR.pathNotFound };
    return { ok: true, value: stringifyJsonResult(found.value) };
  } finally {
    clearTimeout(timer);
  }
}
