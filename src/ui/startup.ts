/**
 * Studio start-up order (spec 04 Requirement 2.7, spec 01 Requirement 2.9), kept out of
 * `src/main.tsx` so it can be tested in Node:
 * 1. await the bundled fonts; a failure is reported and start-up continues with fallback fonts;
 * 2. mount the UI and wait until it is ready, so the first frame is composed with the loaded fonts
 *    and the card viewport is attached as the visual-effect surface;
 * 3. open the stack: `openStack`, `openBackground`, `openCard` to the current card.
 *
 * Opening after the mount means openCard handlers run against a card that is already on screen,
 * as in HyperCard: their field writes redraw through the store subscription, and a
 * `go ... with visual effect` animates from the shown card instead of being skipped because no
 * effect surface is attached yet.
 */
import type { MessageBus } from "../core/messageBus.ts";
import type { LoadStackResult, StackLoader } from "../storage/stackLoader.ts";
import { loadShareHash } from "./fileCommands.ts";

export interface InitialStackOptions {
  /** `location.hash` at start-up. */
  hash: string;
  /** Removes the share link from the address bar, so a reload does not import it again over local edits. */
  clearHash: () => void;
  /** The most recently auto-saved record (indexedDb.ts `loadMostRecent`). */
  loadMostRecent: () => Promise<string | undefined>;
  loader: Pick<StackLoader, "loadFrom">;
  /** Called when IndexedDB cannot be read; start-up continues with the starter stack. */
  onStorageError: (error: unknown) => void;
}

export type InitialStackSource = "urlHash" | "indexedDb" | "starter";

/**
 * Replaces the starter stack before the UI starts (spec 04 Requirements 5.3-5.5): a share link in
 * the URL hash first, otherwise the most recently auto-saved stack, otherwise the starter stays.
 * A damaged source is alerted by the loader and the next source is tried. Runs before the message
 * bus exists, so the stack is opened only once, by `startStudio`.
 */
export async function openInitialStack({ hash, clearHash, loadMostRecent, loader, onStorageError }: InitialStackOptions): Promise<InitialStackSource> {
  const shared = await loadShareHash(hash, loader);
  if (shared !== undefined) clearHash();
  if (shared?.ok) return "urlHash";

  let record: string | undefined;
  try {
    record = await loadMostRecent();
  } catch (error) {
    // No IndexedDB (e.g. some private modes): nothing to restore, which is not a damaged stack.
    onStorageError(error);
    return "starter";
  }
  if (record === undefined) return "starter";
  const saved = record;
  const restored: LoadStackResult = await loader.loadFrom(() => JSON.parse(saved) as unknown);
  return restored.ok ? "indexedDb" : "starter";
}

export interface StudioStartOptions {
  loadFonts: () => Promise<unknown>;
  /** Called when `loadFonts` rejects; start-up then continues. */
  onFontError: (error: unknown) => void;
  /** Mounts the UI; resolves once it has committed its first frame. */
  mount: () => Promise<void>;
  bus: Pick<MessageBus, "openCurrentStack">;
}

export async function startStudio({ loadFonts, onFontError, mount, bus }: StudioStartOptions): Promise<void> {
  try {
    await loadFonts();
  } catch (error) {
    onFontError(error);
  }
  await mount();
  bus.openCurrentStack();
}
