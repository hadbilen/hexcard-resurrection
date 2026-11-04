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
