/**
 * Local auto-save (spec 04 Requirement 5.1, design.md §5): one IndexedDB object store `stacks`,
 * key = stack id, value = the stack JSON text (uncompressed, design spec §5.4; never an AST).
 *
 * The 500 ms debounce lives in the store (spec 01 design.md §3): `createAutoSaver` returns the
 * callback the composition root injects as `HexStoreOptions.autoSave`.
 *
 * Each saved record has `updatedAt` set to the save time, so that start-up can restore the most
 * recently saved stack (`loadMostRecent`). The in-memory stack is not changed by this.
 * Records read back are untrusted: they go through the stack loader (stackLoader.ts).
 */
import type { HexStack } from "../core/schema.ts";

export const DATABASE_NAME = "hexcard";
export const DATABASE_VERSION = 1;
export const STACKS_STORE = "stacks";

export interface StackDatabase {
  /** Writes the stack under its id, replacing any earlier record of the same stack. */
  save(stack: HexStack): Promise<void>;
  /** JSON text of the most recently saved record, or undefined when there is none. */
  loadMostRecent(): Promise<string | undefined>;
  close(): void;
}

/** The record value for `stack`: its JSON with `updatedAt` set to `now`. */
export function serializeForStorage(stack: HexStack, now: Date = new Date()): string {
  return JSON.stringify({ ...stack, updatedAt: now.toISOString() });
}

function savedAt(record: string): number {
  try {
    const value: unknown = JSON.parse(record);
    if (typeof value !== "object" || value === null) return Number.NaN;
    const updatedAt = (value as { updatedAt?: unknown }).updatedAt;
    return typeof updatedAt === "string" ? Date.parse(updatedAt) : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/**
 * The record with the latest `updatedAt`. Records that are not JSON objects with a parseable
 * `updatedAt` cannot be ordered and are skipped; the chosen record is validated by the loader.
 */
export function pickMostRecent(records: readonly unknown[]): string | undefined {
  let best: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const record of records) {
    if (typeof record !== "string") continue;
    const time = savedAt(record);
    if (Number.isNaN(time) || time <= bestTime) continue;
    best = record;
    bestTime = time;
  }
  return best;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

/** Opens (and on first use creates) the HexCard database. */
export async function openStackDatabase(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<StackDatabase> {
  if (!factory) throw new Error("IndexedDB is not available");
  const request = factory.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(STACKS_STORE)) db.createObjectStore(STACKS_STORE);
  };
  const db = await requestResult(request);

  return {
    async save(stack) {
      const transaction = db.transaction(STACKS_STORE, "readwrite");
      transaction.objectStore(STACKS_STORE).put(serializeForStorage(stack), stack.id);
      await transactionDone(transaction);
    },
    async loadMostRecent() {
      const transaction = db.transaction(STACKS_STORE, "readonly");
      const records = await requestResult(transaction.objectStore(STACKS_STORE).getAll());
      return pickMostRecent(records);
    },
    close: () => db.close(),
  };
}

/**
 * The store's auto-save callback. The database is opened on first use and reused. A failed write
 * is reported through `onError` once (not on every later attempt), so a browser without
 * IndexedDB (e.g. some private modes) does not flood the console.
 */
export function createAutoSaver(
  open: () => Promise<StackDatabase>,
  onError: (error: unknown) => void,
): (stack: HexStack) => Promise<void> {
  let database: Promise<StackDatabase> | undefined;
  let reported = false;
  return async (stack) => {
    try {
      database ??= open();
      await (await database).save(stack);
    } catch (error) {
      database = undefined; // retry opening next time
      if (!reported) {
        reported = true;
        onError(error);
      }
    }
  };
}
