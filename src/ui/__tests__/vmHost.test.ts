/**
 * Spec 04 task 3: the VM host (HexHost) with the real parser, store, message bus and VM.
 */
import { describe, expect, it } from "vitest";
import { createMessageBus, type HexMessage, type MessageBus } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import type { HexButtonPart, HexCard, HexFieldPart, HexStack } from "../../core/schema.ts";
import { createHexStore, readFieldText } from "../../core/store.ts";
import type { FetchResult, HexValue } from "../../core/vm.ts";
import { composeEffectFrame, EFFECT_FRAMES } from "../../engine/graphics/transitions.ts";
import { encodeBitmapRLE, TOTAL_PIXELS } from "../../engine/graphics/rleCodec.ts";
import { createModalManager } from "../System7Shell.tsx";
import {
  FETCH_CACHE_TTL_MS,
  createEffectStage,
  createFetchCache,
  createMouseTracker,
  createVmHost,
  formatShortDate,
  formatShortTime,
  type SoundPlayer,
} from "../vmHost.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

/** A card bitmap with its left half dark, so the two cards compose to different frames. */
function halfDarkBitmap(): string {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  for (let i = 0; i < TOTAL_PIXELS; i++) if (i % 512 < 256) pixels[i] = 2;
  return encodeBitmapRLE(pixels);
}

function card(id: string, name: string, parts: HexCard["parts"] = [], rleData = ""): HexCard {
  return {
    id, name, backgroundId: "bkg_1", bitmap: { ...emptyBitmap, rleData }, parts, bgFieldContents: {},
    marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
  };
}

function makeStack(buttonScript: string): HexStack {
  // Title "" and empty field text: no text is rasterized, so no canvas text backend is needed in Node.
  const button: HexButtonPart = {
    id: "prt_btn", name: "Go", type: "button", layerScope: "card", rect: { x: 10, y: 10, width: 80, height: 20 },
    visible: true, enabled: true, scriptSource: buttonScript, style: "rectangle", title: "", showName: true,
    autoHilite: false, hilite: false,
  };
  const field: HexFieldPart = {
    id: "prt_out", name: "Out", type: "field", layerScope: "card", rect: { x: 10, y: 40, width: 200, height: 40 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", content: "", sharedText: false, lockText: true,
    dontWrap: false, showLines: false, textAlign: "left", textFont: "System", textSize: 12, textStyle: [],
  };
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Stack", author: "Tester",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "Main", bitmap: emptyBitmap, scriptSource: "", cantDelete: false, parts: [] }],
    cards: [card("crd_1", "First", [button, field]), card("crd_2", "Second", [], halfDarkBitmap())],
    customIcons: {}, scriptSource: "",
  };
}

const immediateFrame = (callback: () => void): void => {
  setTimeout(callback, 0);
};

function setup(buttonScript: string, extra: { playSound?: SoundPlayer } = {}) {
  const store = createHexStore({ stack: makeStack(buttonScript), compile: parseHexTalk });
  expect(store.getCompiled("prt_btn").errors).toEqual([]);
  const modals = createModalManager();
  const effects = createEffectStage({ requestFrame: immediateFrame });
  const mouse = createMouseTracker();
  const errors: unknown[] = [];
  const globals = new Map<string, HexValue>();
  let bus: MessageBus | undefined;
  const host = createVmHost({
    store,
    bus: () => bus!,
    dialogs: modals,
    effects,
    mouse,
    playSound: extra.playSound,
    now: () => new Date(2026, 0, 9, 21, 5, 0),
    uptimeMs: () => 2_000,
  });
  bus = createMessageBus({
    store, host, globals,
    isPageVisible: () => true,
    isModalOpen: () => modals.isOpen(),
    scheduleInterval: () => () => undefined,
    onError: (error) => errors.push(error),
    warn: () => undefined,
  });

  /** Lets the bus run until it is idle or waits on a dialog. */
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if ((!bus!.isRunning() && bus!.pendingCount() === 0) || modals.isOpen()) return;
    }
  };
  const run = async (msg: HexMessage): Promise<void> => {
    bus!.post(msg);
    await settle();
  };
  return { store, modals, effects, mouse, errors, globals, run, settle };
}

const click: HexMessage = { name: "mouseUp", params: [], targetId: "prt_btn" };
const outText = (store: ReturnType<typeof setup>["store"]): string =>
  readFieldText(store.getSnapshot().stack, "crd_1", "card", "prt_out");

describe("createVmHost", () => {
  it("answer goes through the modal manager and the clicked label reaches the script", async () => {
    const { store, modals, errors, run, settle } = setup([
      "on mouseUp",
      '  answer "Pick one" with "Left" or "Right"',
      "  put it into card field 1",
      "end mouseUp",
    ].join("\n"));

    await run(click);
    const [request] = modals.getSnapshot();
    expect(request).toMatchObject({ kind: "answer", message: "Pick one", buttons: ["Left", "Right"] });

    modals.settle(request.id, "Right");
    await settle();
    expect(errors).toEqual([]);
    expect(outText(store)).toBe("Right");
  });

  it("ask returns the typed text", async () => {
    const { store, modals, errors, run, settle } = setup([
      "on mouseUp",
      '  ask "Your name?" with "Bill"',
      "  put it into card field 1",
      "end mouseUp",
    ].join("\n"));

    await run(click);
    const [request] = modals.getSnapshot();
    expect(request).toMatchObject({ kind: "ask", message: "Your name?", defaultAnswer: "Bill" });
    modals.settle(request.id, "Atkinson");
    await settle();
    expect(errors).toEqual([]);
    expect(outText(store)).toBe("Atkinson");
  });

  it("play is delegated to the injected sound player", async () => {
    const calls: unknown[][] = [];
    const { errors, run } = setup([
      "on mouseUp",
      '  play "harpsichord" tempo 140 "c4q e4q g4h"',
      "end mouseUp",
    ].join("\n"), { playSound: (...args) => calls.push(args) });

    await run(click);
    expect(errors).toEqual([]);
    expect(calls).toEqual([["harpsichord", 140, "c4q e4q g4h"]]);
  });

  it("fetch uses the sandbox policy: a plain http URL is blocked without a request", async () => {
    const { store, errors, run } = setup([
      "on mouseUp",
      '  fetch "http://example.com/data.json" into x',
      "  put it into card field 1",
      "end mouseUp",
    ].join("\n"));

    await run(click);
    expect(errors).toEqual([]);
    expect(outText(store)).toBe("error: blocked url");
  });

  it("the date, the time, the ticks and the mouse come from the host clock and pointer", async () => {
    const { store, mouse, errors, run } = setup([
      "on mouseUp",
      '  put the date & "|" & the time & "|" & the ticks & "|" & the mouseH & "," & the mouseV into card field 1',
      "end mouseUp",
    ].join("\n"));

    mouse.set(42, 17);
    await run(click);
    expect(errors).toEqual([]);
    expect(outText(store)).toBe("1/9/26|9:05 PM|120|42,17");
  });

  it("go with a visual effect plays it on the attached view and ends on the destination frame", async () => {
    const { store, effects, errors, run } = setup([
      "on mouseUp",
      "  visual effect wipe right fast",
      '  go to card "Second"',
      "end mouseUp",
    ].join("\n"));

    const presented: Uint32Array[] = [];
    const onScreen = composeEffectFrame(store.getSnapshot().stack, "crd_1");
    const playing: boolean[] = [];
    effects.subscribe(() => playing.push(effects.isPlaying()));
    effects.attach({ present: (buf) => presented.push(buf.slice()), capture: () => onScreen.slice() });

    await run(click);
    expect(errors).toEqual([]);
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
    expect(presented).toHaveLength(EFFECT_FRAMES.fast);
    expect(presented.at(-1)).toEqual(composeEffectFrame(store.getSnapshot().stack, "crd_2"));
    expect(presented[0]).not.toEqual(presented.at(-1)); // a partial wipe, not a cut
    expect(playing).toEqual([true, false]);
  });

  it("go without an attached view changes card without composing a frame", async () => {
    const { store, errors, run } = setup([
      "on mouseUp",
      "  visual effect dissolve",
      "  go next",
      "end mouseUp",
    ].join("\n"));

    await run(click);
    expect(errors).toEqual([]);
    expect(store.getSnapshot().currentCardId).toBe("crd_2");
  });
});

describe("createFetchCache", () => {
  const DOCUMENT = JSON.stringify({ current: { temperature_2m: 3.5, weather_code: 95 }, daily: { time: ["2026-01-09"] } });

  function cached(responses: (url: string) => FetchResult = () => ({ ok: true, value: DOCUMENT })) {
    let now = 1_000_000;
    const calls: Array<{ url: string; path?: string }> = [];
    const fetchJson = createFetchCache({
      fetchDocument: async (url, path) => {
        calls.push({ url, path });
        return responses(url);
      },
      nowMs: () => now,
    });
    return { fetchJson, calls, advance: (ms: number) => { now += ms; } };
  }

  it("answers the same URL with different JSON paths from one request within 60 s", async () => {
    const { fetchJson, calls, advance } = cached();
    expect(await fetchJson("https://api.example.com/w", "current.temperature_2m")).toEqual({ ok: true, value: "3.5" });
    advance(FETCH_CACHE_TTL_MS - 1);
    expect(await fetchJson("https://api.example.com/w", "daily.time[0]")).toEqual({ ok: true, value: "2026-01-09" });
    expect(await fetchJson("https://api.example.com/w", "current")).toEqual({ ok: true, value: '{"temperature_2m":3.5,"weather_code":95}' });
    expect(await fetchJson("https://api.example.com/w")).toEqual({ ok: true, value: DOCUMENT });
    expect(await fetchJson("https://api.example.com/w", "current.missing")).toEqual({ ok: false, reason: "path not found" });
    expect(calls).toEqual([{ url: "https://api.example.com/w", path: undefined }]);
  });

  it("requests again after 60 s and for a different URL", async () => {
    const { fetchJson, calls, advance } = cached();
    await fetchJson("https://api.example.com/w", "current.weather_code");
    await fetchJson("https://api.example.com/other", "current.weather_code");
    advance(FETCH_CACHE_TTL_MS);
    expect(await fetchJson("https://api.example.com/w", "current.weather_code")).toEqual({ ok: true, value: "95" });
    expect(calls.map((call) => call.url)).toEqual(["https://api.example.com/w", "https://api.example.com/other", "https://api.example.com/w"]);
  });

  it("does not cache failures, and rejects a malformed path without a request", async () => {
    let failing = true;
    const { fetchJson, calls } = cached(() => (failing ? { ok: false, reason: "network error" } : { ok: true, value: DOCUMENT }));
    expect(await fetchJson("https://api.example.com/w", "current.temperature_2m")).toEqual({ ok: false, reason: "network error" });
    failing = false;
    expect(await fetchJson("https://api.example.com/w", "current.temperature_2m")).toEqual({ ok: true, value: "3.5" });
    expect(await fetchJson("https://api.example.com/w", "current..x")).toEqual({ ok: false, reason: "path not found" });
    expect(await fetchJson("https://api.example.com/x", "[0]")).toEqual({ ok: false, reason: "path not found" });
    expect(calls).toHaveLength(2);
  });

  it("finds no path inside a primitive document", async () => {
    const { fetchJson } = cached(() => ({ ok: true, value: "hello" }));
    expect(await fetchJson("https://api.example.com/s")).toEqual({ ok: true, value: "hello" });
    expect(await fetchJson("https://api.example.com/s", "length")).toEqual({ ok: false, reason: "path not found" });
  });

  it("the host's cache still applies the fetch policy: a plain http URL is blocked on every fetch", async () => {
    const { store, errors, run } = setup([
      "on mouseUp",
      '  fetch "http://example.com/data.json" at "a.b" into x',
      '  fetch "http://example.com/data.json" at "a.c" into y',
      "  put it into card field 1",
      "end mouseUp",
    ].join("\n"));
    await run(click);
    expect(errors).toEqual([]);
    expect(outText(store)).toBe("error: blocked url");
  });
});

describe("clock formatting", () => {
  it("uses HyperCard's short date and 12-hour time", () => {
    expect(formatShortDate(new Date(2026, 10, 30))).toBe("11/30/26");
    expect(formatShortDate(new Date(2005, 0, 1))).toBe("1/1/05");
    expect(formatShortTime(new Date(2026, 0, 1, 0, 7))).toBe("12:07 AM");
    expect(formatShortTime(new Date(2026, 0, 1, 12, 0))).toBe("12:00 PM");
    expect(formatShortTime(new Date(2026, 0, 1, 23, 59))).toBe("11:59 PM");
  });
});
