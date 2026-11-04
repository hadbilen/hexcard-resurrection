/**
 * Studio UI root: the System 7 shell with the card viewport as its desktop.
 * Everything it needs is created by the composition root (`src/main.tsx`).
 */
import { useEffect, useState } from "react";
import type { HexHistory } from "../core/history.ts";
import type { MessageBus } from "../core/messageBus.ts";
import type { HexStore } from "../core/store.ts";
import type { PaintController } from "../engine/graphics/paintTools.ts";
import { CardViewport } from "./CardViewport.tsx";
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
  /** Menu commands the shell does not implement itself (e.g. the File menu). */
  onCommand?: (command: ForwardedCommand) => void;
}

export function App({ store, history, modals, bus, painter, effects, mouse, initialPatternIndex, onPatternChange, onReady, onCommand }: AppProps) {
  const [patternIndex, setPatternIndex] = useState(initialPatternIndex);
  useEffect(() => {
    onReady?.();
    // Only the first commit matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <System7Shell
      store={store}
      history={history}
      modals={modals}
      onCommand={onCommand}
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
        isModalOpen={modals.isOpen}
      />
    </System7Shell>
  );
}
