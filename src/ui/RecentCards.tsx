/**
 * Go > Recent (spec 06 Requirement 5.4, 5.5, 5.6): a studio window titled `Recent` with the
 * miniature of every card of the Recent list, newest first, four per row, each with the card's name
 * (or `Card N`) below it and the current card's name inverted as in the Stack Graph.
 * Design: .kiro/specs/06-hypercard-classics/design.md §RecentCards.tsx.
 *
 * - Each miniature is a native `<button>`: a click, or Return or Space on the focused button,
 *   calls `onChoose` (the composition root closes the window and queues the Go dispatch).
 * - The window is a `System7Window`: its close box and Escape call `onClose` and change nothing.
 *   Key presses reach a window only from inside it, so the current card's miniature takes the focus
 *   when the window opens; Escape, Return and Space then work at once from the keyboard.
 * - Miniatures are the Stack Graph's (`createCardThumbnail`, drawn by its `ThumbnailCanvas`).
 */
import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactElement } from "react";
import type { HexID, HexStack } from "../core/schema.ts";
import type { PartRasterizer } from "../engine/graphics/bitmapCanvas.ts";
import { createCardThumbnail, ThumbnailCanvas } from "./StackGraphModal.tsx";
import { System7Window, type UiStore } from "./System7Shell.tsx";

/** Requirement 5.4: miniatures per row. */
export const RECENT_COLUMNS = 4;

export interface RecentWindowProps {
  store: Pick<UiStore, "subscribe" | "getSnapshot">;
  /** The Recent list, newest first (`RecentCards.list`). */
  recent: () => readonly HexID[];
  onChoose: (cardId: HexID) => void;
  onClose: () => void;
  /** Rasterizer for the miniatures; defaults to partRenderer.ts's. */
  rasterizePart?: PartRasterizer;
}

/** The card's name, or `Card N` (N = its 1-based position in the stack) when it has none. */
export function recentCardLabel(stack: HexStack, cardId: HexID): string {
  const index = stack.cards.findIndex((card) => card.id === cardId);
  const name = index < 0 ? "" : stack.cards[index].name;
  return name !== "" ? name : `Card ${index + 1}`;
}

export function RecentWindow({ store, recent, onChoose, onClose, rasterizePart }: RecentWindowProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { stack, currentCardId } = state;
  // The list only changes together with the store snapshot, so the snapshot drives the re-read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const ids = useMemo(() => recent().filter((id) => stack.cards.some((card) => card.id === id)), [recent, state]);
  const gridRef = useRef<HTMLUListElement>(null);
  useEffect(() => {
    gridRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
  }, []);
  const thumbnails = useMemo(
    () => new Map(ids.map((id) => [id, createCardThumbnail(stack, id, rasterizePart)])),
    [stack, ids, rasterizePart],
  );

  return (
    <System7Window title="Recent" className="s7-recent-window" onClose={onClose}>
      <ul ref={gridRef} className="s7-recent-grid" aria-label="Recent cards">
        {ids.map((id) => {
          const label = recentCardLabel(stack, id);
          const current = id === currentCardId;
          return (
            <li key={id} className="s7-recent-item">
              <button
                type="button"
                className={current ? "s7-recent-card s7-recent-card-current" : "s7-recent-card"}
                aria-label={label}
                aria-current={current ? "true" : undefined}
                onClick={() => onChoose(id)}
              >
                <ThumbnailCanvas pixels={thumbnails.get(id)!} palette={stack.themePalette} />
                <span className="s7-recent-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </System7Window>
  );
}
