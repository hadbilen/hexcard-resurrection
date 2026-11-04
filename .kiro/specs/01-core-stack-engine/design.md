# Technical Design Document: Core Stack Engine

## 1. Scope & Shared Contracts
Modules: `schema.ts`, `stackValidator.ts`, `store.ts`, `history.ts`, `messageBus.ts`. Pure TypeScript, no React, no DOM (DOM-dependent pieces such as `document.visibilityState` are injected).

Canonical contracts this spec implements without restating them:
- Persisted types and `THEME_PALETTES`: `hexcard_design_spec.md` §2.1
- Message path, handled rule, `pass`: §3
- Concurrency model (queue, `idle`, nested dispatch, abort): §3.2

## 2. Architecture

~~~text
 React UI (spec 04) ── useSyncExternalStore ──► store.getSnapshot()
     │ user events                                    ▲
     ▼                                                │ new snapshot
 messageBus ── dispatch ──► vm (spec 02) ── applyRuntime(mutation) ──┤
     ▲                          │                                    │
     │ nested lifecycle msgs    │ host calls (dialogs, sound, render)│
     └──────────────────────────┘                                    │
 authoring tools (spec 03/04) ── history.execute(command) ───────────┘
~~~

## 3. Store (`store.ts`)

~~~typescript
export interface HexRuntimeState {
  stack: HexStack;                 // immutable snapshot; replaced on every change
  currentCardId: HexID;
  editLayer: "card" | "background"; // Edit Background mode
  tool: AuthoringTool;
}

export type RuntimeMutation =
  | { type: "setFieldText"; cardId: HexID; layer: "card" | "background"; partId: HexID; text: string }
  | { type: "setPartProperty"; partId: HexID; property: HexPropertyName; value: string | number | boolean }
  | { type: "setCardProperty"; cardId: HexID; property: "name" | "marked"; value: string | boolean }
  | { type: "setBackgroundProperty"; backgroundId: HexID; property: "name"; value: string }
  | { type: "setStackProperty"; property: "name"; value: string }
  | { type: "goToCard"; cardId: HexID };

export interface HexStore {
  subscribe(listener: () => void): () => void;
  getSnapshot(): HexRuntimeState;
  applyRuntime(m: RuntimeMutation): void;           // not undoable, schedules auto-save
  replaceStack(stack: HexStack): void;              // after validation only; recompiles ScriptCache
  onReplaceStack(listener: () => void): () => void; // called by replaceStack before subscribers; message bus clears its back history
  applyAuthoring(next: HexStack): void;             // authoring result; incremental recompile; never touches history
  getCompiled(objectId: HexID): { ast: HexScriptAST; errors: HexCompileError[] };
}
~~~

- Snapshots are produced with structural sharing (copy the changed path only).
- `setFieldText` implements Requirement 1.2/1.3: for background fields it writes `bgFieldContents` or `content` depending on `sharedText`.
- `ScriptCache` is a `Map<HexID, { ast, errors }>`, rebuilt by calling `parseHexTalk` (spec 02) for every object on `replaceStack`, and for one object whenever its `scriptSource` changes.
- `applyAuthoring(next)` replaces the stack with an authoring result and recompiles only the objects whose `scriptSource` changed, compared by id: added objects are compiled and removed objects are dropped from the `ScriptCache`. It then notifies listeners and schedules auto-save. It never touches history.
- Auto-save is debounced (500 ms) and delegated to `src/storage/indexedDb.ts` through an injected callback, keeping core free of storage code.

## 4. History (`history.ts`)

~~~typescript
export interface HexCommand {
  label: string;                           // shown in Edit > Undo <label>
  apply(stack: HexStack): HexStack;
  revert(stack: HexStack): HexStack;
}
~~~

- History is created with the store: `createHistory(store)`.
- `execute`, `undo` and `redo` compute the next stack with `command.apply`/`command.revert` on `store.getSnapshot().stack` and hand it to `store.applyAuthoring`.
- Ring buffer of 50 commands; `execute` clears the redo list.
- `PaintStrokeCommand` stores `{ layer, layerOwnerId, rect, before: Uint8Array, after: Uint8Array }` for the stroke's bounding rectangle. It re-encodes the layer on apply/revert through an injected codec `{ encode(pixels): string; decode(rleData, emptyFill): Uint8Array }`, so `src/core/` never imports `src/engine/`. Production wiring passes `encodeBitmapRLE`/`decodeBitmapRLE` (spec 03); core tests pass a fake codec.

## 5. Message Bus (`messageBus.ts`)

~~~typescript
export interface HexMessage { name: string; params: (string | number)[]; targetId: HexID }

export interface MessageBus {
  post(msg: HexMessage): void;             // from UI: enqueue (with coalescing rules)
  sendNested(msg: HexMessage, ctx: DispatchContext): Promise<void>; // from VM during go
  changeCard(target: HexID | { type: "relative"; dir: "back" }, ctx: DispatchContext,
             transition?: () => Promise<void>): Promise<void>; // go / arrow keys: nested lifecycle msgs
  abort(): void;                           // Cmd/Ctrl+. or tool switch
}
~~~

- `buildPath(targetId)` returns `[part?, card, background, stack]` from the current snapshot.
- The dispatch loop takes one message, walks the path, asks the VM to run the first matching handler, and treats a `PassEvent` result as "continue with next object".
- `DispatchContext` carries `{ stepCount, depth, abortSignal, pendingVisualEffect }` and is shared with nested dispatches.
- The `idle` timer is a 200 ms interval that posts `idle` only when the §3.2 conditions hold; visibility and modal state are injected predicates.
- Built-in handler: unhandled `keyDown` with `ArrowLeft`/`ArrowRight` -> go prev/next.
- The back history of Requirement 2.7 lives in `messageBus.ts`; `changeCard` uses it for the target `{ type: "relative", dir: "back" }`.

## 6. Stack Validator (`stackValidator.ts`)
A strict Zod schema mirroring §2.1 (unknown keys rejected) plus the structural checks of Requirements 6.3–6.7: layer references and scopes, at least one card and one background, globally unique ids, fixed 512x342 sizes, `#RRGGBB` palette colours and integer part rects. `validateStack(unknown) -> { ok: true, stack } | { ok: false, error }`.

## 7. Testing
- Store: sharedText read/write matrix, snapshot immutability, `applyRuntime` never touches history.
- History: 60 commands keep only the last 50; undo/redo restores deep-equal stacks.
- Message bus: path order, `pass` continuation, queue overflow, coalescing, `idle` gating, nested lifecycle order on background change, recursion limit, abort.
