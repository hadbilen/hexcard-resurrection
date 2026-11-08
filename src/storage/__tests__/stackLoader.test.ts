import { beforeEach, describe, expect, it } from "vitest";
import { createHistory } from "../../core/history.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { createHexStore, type HexStore } from "../../core/store.ts";
import { clearDecodedLayerCache, composeFrame, decodedLayerCacheSize } from "../../engine/graphics/bitmapCanvas.ts";
import { createThemeCommand } from "../../ui/menuCommands.ts";
import { decodeStackFile, encodeStackFile } from "../stackFile.ts";
import { DAMAGED_STACK_MESSAGE, checkStack, createStackLoader } from "../stackLoader.ts";
import { makeStack } from "./fixtures.ts";

function setup() {
  const store = createHexStore({ stack: makeStack({ name: "Current" }), compile: parseHexTalk });
  const history = createHistory(store);
  const alerts: Array<{ message: string; details: readonly string[] }> = [];
  const order: string[] = [];
  const watchedStore: Pick<HexStore, "replaceStack"> = {
    replaceStack(stack) {
      order.push(`replaceStack(canUndo=${history.canUndo()}, cachedLayers=${decodedLayerCacheSize()})`);
      store.replaceStack(stack);
    },
  };
  const loader = createStackLoader({
    store: watchedStore,
    history,
    alert: (message, { details }) => alerts.push({ message, details }),
  });
  return { store, history, loader, alerts, order };
}

beforeEach(() => clearDecodedLayerCache());

describe("stack loader", () => {
  it("clears the history and the decoded-layer cache, then replaces the stack", () => {
    const { store, history, loader, alerts, order } = setup();
    history.execute(createThemeCommand("AmberCRT"));
    composeFrame(store.getSnapshot().stack, "crd_starter", {}, () => {});
    expect(history.canUndo()).toBe(true);
    expect(decodedLayerCacheSize()).toBeGreaterThan(0);

    const next = makeStack({ id: "stk_next", name: "Next" });
    const result = loader.load(next);

    expect(result.ok).toBe(true);
    expect(order).toEqual(["replaceStack(canUndo=false, cachedLayers=0)"]);
    expect(store.getSnapshot().stack).toEqual(next);
    expect(alerts).toEqual([]);
  });

  it("rejects a schema-invalid stack whole with one alert and leaves the current stack untouched", () => {
    const { store, loader, alerts, order } = setup();
    const before = store.getSnapshot();
    const result = loader.load({ ...makeStack(), schemaVersion: "1.0.0" });

    expect(result).toEqual({ ok: false, error: expect.stringContaining("schemaVersion") });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe(DAMAGED_STACK_MESSAGE);
    expect(alerts[0].details[0]).toContain("unsupported schema version");
    expect(order).toEqual([]);
    expect(store.getSnapshot()).toBe(before);
  });

  it("rejects a stack whose layer has invalid Base64 or corrupt PackBits data", () => {
    const { store, loader, alerts } = setup();
    const before = store.getSnapshot();

    const badBase64 = makeStack();
    badBase64.backgrounds[0].bitmap.rleData = "!!not base64!!";
    expect(loader.load(badBase64)).toEqual({ ok: false, error: expect.stringContaining("backgrounds[0].bitmap.rleData") });

    const corrupt = makeStack();
    corrupt.cards[0].bitmap.rleData = btoa("\u0005ab"); // literal of 6 bytes with only 2 present
    expect(loader.load(corrupt)).toEqual({ ok: false, error: expect.stringContaining("cards[0].bitmap.rleData") });

    expect(alerts.map((alert) => alert.message)).toEqual([DAMAGED_STACK_MESSAGE, DAMAGED_STACK_MESSAGE]);
    expect(store.getSnapshot()).toBe(before);
  });

  it("rejects a source that fails to read, with one alert", async () => {
    const { store, loader, alerts } = setup();
    const before = store.getSnapshot();
    const result = await loader.loadFrom(() => decodeStackFile("%%%"));
    expect(result.ok).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(alerts[0].message).toBe(DAMAGED_STACK_MESSAGE);
    expect(store.getSnapshot()).toBe(before);
  });

  it("loads a .hexstack file end to end", async () => {
    const { store, loader } = setup();
    const next = makeStack({ id: "stk_file", name: "From file" });
    const text = await encodeStackFile(next);
    const result = await loader.loadFrom(() => decodeStackFile(text));
    expect(result.ok).toBe(true);
    expect(store.getSnapshot().stack.name).toBe("From file");
  });

  it("checkStack returns a validated copy that shares no objects with the input", () => {
    const input = makeStack();
    const checked = checkStack(input);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.stack).toEqual(input);
      expect(checked.stack.cards[0]).not.toBe(input.cards[0]);
    }
  });
});
