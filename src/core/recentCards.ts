/**
 * Recent (spec 06 Requirement 5): the cards that most recently became current, newest first.
 * Design: .kiro/specs/06-hypercard-classics/design.md §recentCards.ts.
 *
 * - The list is a store subscriber, like the message bus's back history: whenever `currentCardId`
 *   changes it moves that card to the front, so every way a card becomes current is covered (`go`,
 *   `go back`, the Go menu, the arrow keys, Find, Recent, New Card, New Background, Delete Card,
 *   Undo and Redo) without each of them calling it (Requirement 5.1).
 * - It holds at most 12 cards, each at most once. The first entry is always the current card.
 * - A loaded stack resets it to the new current card; cards that no longer exist are left out
 *   (Requirement 5.2). It lives in memory only and is never saved (Requirement 5.3).
 *
 * Pure TypeScript: no React, no DOM.
 */
import type { HexID } from "./schema.ts";
import type { MessageBus } from "./messageBus.ts";
import type { HexStore } from "./store.ts";

/** Requirement 5.1: the most cards the list holds. */
export const RECENT_LIMIT = 12;

export interface RecentCards {
  /** Requirements 5.1, 5.2: newest first, the current card first, only cards of the current stack. */
  list(): readonly HexID[];
  /** Stops listening to the store. */
  dispose(): void;
}

export function createRecentCards(
  store: Pick<HexStore, "subscribe" | "getSnapshot" | "onReplaceStack">,
  limit: number = RECENT_LIMIT,
): RecentCards {
  const existing = (): Set<HexID> => new Set(store.getSnapshot().stack.cards.map((card) => card.id));

  let ids: HexID[] = [store.getSnapshot().currentCardId];
  let lastCurrent: HexID = ids[0];

  /** Moves `cardId` to the front; cards that were deleted meanwhile do not use up a place. */
  const remember = (cardId: HexID): void => {
    const alive = existing();
    ids = [cardId, ...ids.filter((id) => id !== cardId && alive.has(id))].slice(0, limit);
  };

  const unsubscribe = store.subscribe(() => {
    const { currentCardId } = store.getSnapshot();
    if (currentCardId === lastCurrent) return;
    lastCurrent = currentCardId;
    remember(currentCardId);
  });

  // Requirement 5.2: another stack starts a new list. This runs before the store notifies its
  // subscribers, which then see an unchanged current card.
  const unsubscribeReplace = store.onReplaceStack(() => {
    lastCurrent = store.getSnapshot().currentCardId;
    ids = [lastCurrent];
  });

  return {
    list() {
      const { currentCardId } = store.getSnapshot();
      const alive = existing();
      return [currentCardId, ...ids.filter((id) => id !== currentCardId && alive.has(id))].slice(0, limit);
    },
    dispose() {
      unsubscribe();
      unsubscribeReplace();
    },
  };
}

/**
 * Requirement 5.5: goes to a card chosen in the Recent window, as one command dispatch with the
 * lifecycle messages of `go`. It closes nothing itself (the window does). The current card queues
 * nothing, and a card that no longer exists when the dispatch starts is ignored.
 */
export function goToRecentCard(
  store: Pick<HexStore, "getSnapshot">,
  bus: Pick<MessageBus, "runCommand" | "changeCard">,
  cardId: HexID,
): void {
  if (store.getSnapshot().currentCardId === cardId) return;
  bus.runCommand("Go Recent", async (ctx) => {
    if (!store.getSnapshot().stack.cards.some((card) => card.id === cardId)) return;
    await bus.changeCard(cardId, ctx);
  });
}
