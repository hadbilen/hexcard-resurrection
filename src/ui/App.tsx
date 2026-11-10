/**
 * Studio UI root: the System 7 shell with the card viewport as its desktop, plus the studio
 * windows (Object Inspector, Stack Graph) of spec 04 task 4 and the showcase chooser of task 8.
 * Everything it needs is created by the composition root (`src/main.tsx`).
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import type { HexHistory } from "../core/history.ts";
import type { MessageBus } from "../core/messageBus.ts";
import type { HexID } from "../core/schema.ts";
import type { HexStore } from "../core/store.ts";
import type { ImageFileLike } from "../engine/graphics/imageImport.ts";
import type { PaintController } from "../engine/graphics/paintTools.ts";
import { CardViewport } from "./CardViewport.tsx";
import { IconEditor } from "./IconEditor.tsx";
import { MessageBoxWindow, type MessageBoxController } from "./MessageBox.tsx";
import { ObjectInspector, type StudioWindows } from "./ObjectInspector.tsx";
import { ShowcaseChooser, type ShowcaseChoice } from "./ShowcaseChooser.tsx";
import { StackGraphModal } from "./StackGraphModal.tsx";
import type { Platform, ShellMenuHandlers } from "./menuCommands.ts";
import { System7Shell, type ModalManager, type UiStore } from "./System7Shell.tsx";
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
    setSelectedPart: store.setSelectedPart,
    setFound: store.setFound,
  };
}

export interface AppProps {
  store: UiStore;
  history: HexHistory;
  modals: ModalManager;
  /** Which studio window is open; shared with the script error reporter and the message bus. */
  windows: StudioWindows;
  /** The viewport posts and aborts; the menu handlers (built in main.tsx) use the rest. */
  bus: Pick<MessageBus, "post" | "abort" | "runCommand" | "changeCard" | "changeCardBy" | "sendNested" | "backHistory">;
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
  /** Spec 05 design §3.5: the menu handlers of `createMenuHandlers`. */
  handlers: ShellMenuHandlers;
  /** Shortcut label platform, detected once by the composition root. */
  platform: Platform;
  /** Stacks listed by File > Open Showcase Stack (Requirement 7.5). */
  showcases?: readonly ShowcaseChoice[];
  /** Loads the chosen showcase stack (through the stack loader). */
  onOpenShowcase?: (id: string) => void;
  /** Spec 06 Requirement 6.2: imports a file dropped on the card (paint-tool check included). */
  onDropImage?: (file: ImageFileLike) => void;
  /** Spec 06 Requirement 2: the floating Message Box, shared with the Go > Message Box handler. */
  messageBox?: MessageBoxController;
  /** Spec 06 Requirement 3: runs a Message Box line (Return); `createMessageBoxRunner` in main.tsx. */
  onMessageBoxReturn?: (line: string) => void;
}

export function App({
  store, history, modals, windows, bus, painter, effects, mouse, initialPatternIndex, onPatternChange, onReady, handlers,
  platform, showcases = [], onOpenShowcase, onDropImage, messageBox, onMessageBoxReturn,
}: AppProps) {
  const [patternIndex, setPatternIndex] = useState(initialPatternIndex);
  const open = useSyncExternalStore(windows.subscribe, windows.getSnapshot, windows.getSnapshot);
  useEffect(() => {
    onReady?.();
    // Only the first commit matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const backHistory = (): readonly HexID[] => bus.backHistory();
  // A newly loaded stack closes the studio windows of the old one.
  useEffect(() => store.onReplaceStack(() => windows.close()), [store, windows]);

  return (
    <System7Shell
      store={store}
      history={history}
      modals={modals}
      handlers={handlers}
      backHistory={backHistory}
      platform={platform}
      isWindowOpen={windows.isOpen}
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
        onDropImage={onDropImage}
      />
      {messageBox ? <MessageBoxWindow controller={messageBox} onReturn={(line) => onMessageBoxReturn?.(line)} /> : null}
      {open?.kind === "inspector" ? (
        <ObjectInspector key={open.id} store={store} history={history} request={open} onClose={windows.close} />
      ) : null}
      {open?.kind === "stackGraph" ? <StackGraphModal key={open.id} store={store} onClose={windows.close} /> : null}
      {open?.kind === "iconEditor" ? (
        <IconEditor key={open.id} store={store} history={history} modals={modals} onClose={windows.close} />
      ) : null}
      {open?.kind === "showcaseChooser" ? (
        <ShowcaseChooser
          key={open.id}
          showcases={showcases}
          onOpen={(id) => {
            // A successful load closes the window through onReplaceStack; a damaged one shows its alert.
            windows.close();
            onOpenShowcase?.(id);
          }}
          onClose={windows.close}
        />
      ) : null}
    </System7Shell>
  );
}
