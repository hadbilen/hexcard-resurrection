/**
 * Studio UI root: the System 7 shell with the card viewport as its desktop, plus the studio
 * windows (Object Inspector, Stack Graph) of spec 04 task 4.
 * Everything it needs is created by the composition root (`src/main.tsx`).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { HexHistory } from "../core/history.ts";
import type { MessageBus } from "../core/messageBus.ts";
import type { HexStore } from "../core/store.ts";
import type { PaintController } from "../engine/graphics/paintTools.ts";
import { CardViewport } from "./CardViewport.tsx";
import { ObjectInspector, type StudioWindows } from "./ObjectInspector.tsx";
import { StackGraphModal } from "./StackGraphModal.tsx";
import { System7Shell, type ForwardedCommand, type ModalManager, type UiStore } from "./System7Shell.tsx";
import type { EffectStage, MouseTracker } from "./vmHost.ts";

/**
 * Requirement 2.6: the store view handed to UI components. It is a separate object without
 * `applyAuthoring` and `replaceStack`, so those methods are absent at run time, not only in types.
 */
export function createUiStoreView(store: HexStore): UiStore {
  return {
    subscribe: store.subscribe,
    getSnapshot: store.getSnapshot,
    applyRuntime: store.applyRuntime,
    onReplaceStack: store.onReplaceStack,
    getCompiled: store.getCompiled,
    setEditLayer: store.setEditLayer,
    setTool: store.setTool,
  };
}

export interface AppProps {
  store: UiStore;
  history: HexHistory;
  modals: ModalManager;
  /** Which studio window is open; shared with the script error reporter and the message bus. */
  windows: StudioWindows;
  bus: Pick<MessageBus, "post" | "abort">;
  painter: PaintController;
  effects: EffectStage;
  mouse: Pick<MouseTracker, "set">;
  /** Index into `PATTERNS` the paint controller starts with. */
  initialPatternIndex: number;
  /** Tells the composition root, which feeds the paint controller's settings. */
  onPatternChange: (index: number) => void;
  /**
   * Called after the first commit, once the card viewport has drawn its first frame and attached
   * the visual-effect surface (child effects run before this one). StrictMode may call it twice.
   */
  onReady?: () => void;
  /** Menu commands neither the shell nor the app implements (e.g. the File menu). */
  onCommand?: (command: ForwardedCommand) => void;
}

export function App({ store, history, modals, windows, bus, painter, effects, mouse, initialPatternIndex, onPatternChange, onReady, onCommand }: AppProps) {
  const [patternIndex, setPatternIndex] = useState(initialPatternIndex);
  const open = useSyncExternalStore(windows.subscribe, windows.getSnapshot, windows.getSnapshot);
  useEffect(() => {
    onReady?.();
    // Only the first commit matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // A newly loaded stack closes the studio windows of the old one.
  useEffect(() => store.onReplaceStack(() => windows.close()), [store, windows]);

  return (
    <System7Shell
      store={store}
      history={history}
      modals={modals}
      onCommand={(command) => {
        if (command === "go.stackGraph") windows.openStackGraph();
        else onCommand?.(command);
      }}
      patternIndex={patternIndex}
      onPatternChange={(index) => {
        setPatternIndex(index);
        onPatternChange(index);
      }}
    >
      <CardViewport
        store={store}
        history={history}
        bus={bus}
        painter={painter}
        effects={effects}
        mouse={mouse}
        isModalOpen={() => modals.isOpen() || windows.isOpen()}
        onInspectPart={(partId) => windows.openInspector(partId)}
      />
      {open?.kind === "inspector" ? (
        <ObjectInspector key={open.id} store={store} history={history} request={open} onClose={windows.close} />
      ) : null}
      {open?.kind === "stackGraph" ? <StackGraphModal key={open.id} store={store} onClose={windows.close} /> : null}
    </System7Shell>
  );
}
