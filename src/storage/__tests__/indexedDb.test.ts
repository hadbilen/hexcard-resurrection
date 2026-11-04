import { describe, expect, it } from "vitest";
import { validateStack } from "../../core/stackValidator.ts";
import { createAutoSaver, pickMostRecent, serializeForStorage, type StackDatabase } from "../indexedDb.ts";
import { makeStack } from "./fixtures.ts";

describe("IndexedDB records", () => {
  it("hold the stack JSON with updatedAt set to the save time, and nothing else", () => {
    const stack = makeStack();
    const record = serializeForStorage(stack, new Date("2026-05-01T12:00:00.000Z"));
    const parsed: unknown = JSON.parse(record);
    expect(parsed).toEqual({ ...stack, updatedAt: "2026-05-01T12:00:00.000Z" });
    // Strict schema: a persisted AST or any other extra key would fail validation.
    expect(validateStack(parsed).ok).toBe(true);
  });

  it("start-up restores the record with the latest updatedAt, skipping records it cannot order", () => {
    const at = (iso: string, name: string) => serializeForStorage(makeStack({ id: name, name }), new Date(iso));
    const older = at("2026-01-02T00:00:00.000Z", "older");
    const newer = at("2026-03-01T00:00:00.000Z", "newer");
    expect(pickMostRecent([older, "{broken", newer, 42, JSON.stringify({ updatedAt: "not a date" })])).toBe(newer);
    expect(pickMostRecent([])).toBeUndefined();
    expect(pickMostRecent(["{broken"])).toBeUndefined();
  });
});

describe("createAutoSaver", () => {
  function memoryDatabase(saved: string[]): StackDatabase {
    return {
      save: async (stack) => {
        saved.push(stack.name);
      },
      loadMostRecent: async () => undefined,
      close: () => {},
    };
  }

  it("opens the database once and saves every stack it receives", async () => {
    const saved: string[] = [];
    let opens = 0;
    const save = createAutoSaver(async () => {
      opens++;
      return memoryDatabase(saved);
    }, () => {});
    await save(makeStack({ name: "a" }));
    await save(makeStack({ name: "b" }));
    expect(saved).toEqual(["a", "b"]);
    expect(opens).toBe(1);
  });

  it("reports the first failure only, and retries opening on the next save", async () => {
    const errors: unknown[] = [];
    let attempts = 0;
    const saved: string[] = [];
    const save = createAutoSaver(async () => {
      attempts++;
      if (attempts < 3) throw new Error("IndexedDB is not available");
      return memoryDatabase(saved);
    }, (error) => errors.push(error));
    await save(makeStack({ name: "a" }));
    await save(makeStack({ name: "b" }));
    await save(makeStack({ name: "c" }));
    expect(errors).toHaveLength(1);
    expect(saved).toEqual(["c"]);
  });
});
