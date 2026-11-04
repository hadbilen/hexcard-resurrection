import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkFetchUrl,
  evaluateJsonPath,
  FETCH_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  fetchJson,
  parseJsonPath,
  stringifyJsonResult,
  type FetchPolicyOptions,
} from "../fetchPolicy.ts";

type FetchMock = NonNullable<FetchPolicyOptions["fetch"]>;

function respondWith(body: BodyInit | null, init?: ResponseInit, url?: string): FetchMock {
  return vi.fn<FetchMock>(() => {
    const response = new Response(body, init);
    if (url !== undefined) Object.defineProperty(response, "url", { value: url });
    return Promise.resolve(response);
  });
}

/** A fetch that never answers until its signal aborts, like a hung server. */
const hangingFetch: FetchMock = (_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

const weather = JSON.stringify({
  current: { temperature_2m: 21.5, is_day: true, note: null, label: "Sunny" },
  daily: { time: ["2026-10-31", "2026-11-01"], codes: [[1, 2], [3]] },
});

afterEach(() => {
  vi.useRealTimers();
});

describe("URL policy (Requirement 6.1)", () => {
  it.each([
    "http://example.com/data.json",
    "ftp://example.com/data.json",
    "file:///etc/passwd",
    "data:application/json,{}",
    "javascript:alert(1)",
    "not a url",
    "",
    "https://user:secret@example.com/data.json",
    "http://localhost.evil.test/data.json",
    "http://127.0.0.1/data.json",
  ])("blocks %j without calling fetch", async (url) => {
    const fetch = respondWith("{}");
    expect(await fetchJson(url, undefined, { fetch, allowLocalhost: true })).toEqual({ ok: false, reason: "blocked url" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows http://localhost only when localhost is enabled (development builds)", async () => {
    expect(checkFetchUrl("http://localhost:5173/api", false)).toBeNull();
    expect(checkFetchUrl("http://localhost:5173/api", true)?.href).toBe("http://localhost:5173/api");
    expect(await fetchJson("http://localhost/x", undefined, { fetch: respondWith("1"), allowLocalhost: false }))
      .toEqual({ ok: false, reason: "blocked url" });
    expect(await fetchJson("http://localhost/x", undefined, { fetch: respondWith("1"), allowLocalhost: true }))
      .toEqual({ ok: true, value: "1" });
  });

  it("sends a fixed GET with credentials omitted, no referrer and no headers", async () => {
    const fetch = respondWith("{}");
    await fetchJson("https://api.example.com/v1?q=1", undefined, { fetch });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(fetch).mock.calls[0];
    expect(input).toBe("https://api.example.com/v1?q=1");
    expect(Object.keys(init).sort()).toEqual(["credentials", "method", "referrerPolicy", "signal"]);
    expect(init).toMatchObject({ method: "GET", credentials: "omit", referrerPolicy: "no-referrer" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("blocks a response that was redirected outside the policy", async () => {
    const fetch = respondWith("{}", undefined, "http://plain.example.com/data.json");
    expect(await fetchJson("https://api.example.com/x", undefined, { fetch })).toEqual({ ok: false, reason: "blocked url" });
  });
});

describe("failures (Requirement 6.2)", () => {
  it("times out after 8 seconds waiting for the response", async () => {
    vi.useFakeTimers();
    const pending = fetchJson("https://api.example.com/slow", undefined, { fetch: hangingFetch });
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS - 1);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });

  it("times out when the body stalls after the headers arrived", async () => {
    vi.useFakeTimers();
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"a\":"));
      },
    });
    const pending = fetchJson("https://api.example.com/stall", undefined, { fetch: respondWith(stalled) });
    await vi.advanceTimersByTimeAsync(FETCH_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, reason: "timeout" });
  });

  it("accepts a body of exactly 256 KB and rejects one byte more", async () => {
    const exact = `"${"a".repeat(FETCH_MAX_BYTES - 2)}"`;
    const ok = await fetchJson("https://api.example.com/big", undefined, { fetch: respondWith(exact) });
    expect(ok.ok && ok.value.length).toBe(FETCH_MAX_BYTES - 2);
    const over = `"${"a".repeat(FETCH_MAX_BYTES - 1)}"`;
    expect(await fetchJson("https://api.example.com/big", undefined, { fetch: respondWith(over) }))
      .toEqual({ ok: false, reason: "too large" });
  });

  it.each([
    ["HTML", "<html>hi</html>"],
    ["an empty body", ""],
    ["truncated JSON", "{\"a\": 1"],
    ["invalid UTF-8", new Uint8Array([0x22, 0xff, 0x22])],
  ])("reports not json for %s", async (_label, body) => {
    expect(await fetchJson("https://api.example.com/x", undefined, { fetch: respondWith(body) }))
      .toEqual({ ok: false, reason: "not json" });
  });

  it("reports the HTTP status of an unsuccessful response", async () => {
    const fetch = respondWith("{\"error\":\"nope\"}", { status: 404 });
    expect(await fetchJson("https://api.example.com/x", "error", { fetch })).toEqual({ ok: false, reason: "http 404" });
  });

  it("reports a network error when fetch itself rejects", async () => {
    const fetch: FetchMock = () => Promise.reject(new TypeError("Failed to fetch"));
    expect(await fetchJson("https://api.example.com/x", undefined, { fetch })).toEqual({ ok: false, reason: "network error" });
  });

  it.each([
    "current.missing",
    "daily.time[2]",
    "daily.time.length",
    "current[0]",
    "current.temperature_2m.value",
    "constructor",
    "current.toString",
  ])("reports path not found for %j", async (path) => {
    expect(await fetchJson("https://api.example.com/x", path, { fetch: respondWith(weather) }))
      .toEqual({ ok: false, reason: "path not found" });
  });

  it.each(["", "daily..time", "daily.time[]", "daily.time[-1]", "daily.*", "1abc", "a b", "a.", "[0]"])(
    "reports path not found for the malformed path %j without fetching",
    async (path) => {
      const fetch = respondWith(weather);
      expect(await fetchJson("https://api.example.com/x", path, { fetch })).toEqual({ ok: false, reason: "path not found" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("successful results (Requirement 6.3)", () => {
  it.each([
    ["current.temperature_2m", "21.5"],
    ["current.is_day", "true"],
    ["current.note", "null"],
    ["current.label", "Sunny"],
    ["daily.time[0]", "2026-10-31"],
    ["daily.codes[0][1]", "2"],
    ["daily.codes", "[[1,2],[3]]"],
    ["current", "{\"temperature_2m\":21.5,\"is_day\":true,\"note\":null,\"label\":\"Sunny\"}"],
  ])("evaluates %j to %j", async (path, expected) => {
    expect(await fetchJson("https://api.example.com/x", path, { fetch: respondWith(weather) }))
      .toEqual({ ok: true, value: expected });
  });

  it("returns the whole document as compact JSON when there is no path", async () => {
    const pretty = JSON.stringify(JSON.parse(weather), null, 2);
    expect(await fetchJson("https://api.example.com/x", undefined, { fetch: respondWith(pretty) }))
      .toEqual({ ok: true, value: weather });
  });
});

describe("JSON path helpers", () => {
  it("parses the §4.3 path grammar", () => {
    expect(parseJsonPath("current.temperature_2m")).toEqual([{ key: "current" }, { key: "temperature_2m" }]);
    expect(parseJsonPath("daily.time[0]")).toEqual([{ key: "daily" }, { key: "time" }, { index: 0 }]);
    expect(parseJsonPath("_a[12][3].b")).toEqual([{ key: "_a" }, { index: 12 }, { index: 3 }, { key: "b" }]);
    expect(parseJsonPath("a[0")).toBeNull();
  });

  it("matches only own keys of plain objects and array indices", () => {
    const data = JSON.parse("{\"__proto__\": 5, \"list\": [\"x\"]}") as unknown;
    expect(evaluateJsonPath(data, [{ key: "__proto__" }])).toEqual({ found: true, value: 5 });
    expect(evaluateJsonPath(data, [{ key: "hasOwnProperty" }])).toEqual({ found: false });
    expect(evaluateJsonPath(data, [{ key: "list" }, { index: 0 }])).toEqual({ found: true, value: "x" });
    expect(evaluateJsonPath(data, [{ key: "list" }, { key: "0" }])).toEqual({ found: false });
  });

  it("stringifies primitives as strings and containers as compact JSON", () => {
    expect(stringifyJsonResult("a\"b")).toBe("a\"b");
    expect(stringifyJsonResult(-0.5)).toBe("-0.5");
    expect(stringifyJsonResult(false)).toBe("false");
    expect(stringifyJsonResult(null)).toBe("null");
    expect(stringifyJsonResult({ a: [1, { b: "c" }] })).toBe("{\"a\":[1,{\"b\":\"c\"}]}");
  });
});
