/**
 * Studio composition root (spec 04 design.md §1): creates the store with the built-in starter
 * stack, the history, the message bus, the VM host and the paint controller, then mounts the UI
 * with the narrowed store view (Requirement 2.6). The start-up order is in `ui/startup.ts`: the
 * first frame is composed only after `loadBundledFonts()` has settled (Requirement 2.7), and the
 * stack is opened (spec 01 Requirement 2.9) once the UI has mounted.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHistory } from "./core/history.ts";
import { createMessageBus, type MessageBus } from "./core/messageBus.ts";
import { parseHexTalk } from "./core/parser.ts";
import { validateStack } from "./core/stackValidator.ts";
import { createHexStore } from "./core/store.ts";
import { createPaintController } from "./engine/graphics/paintTools.ts";
import { PATTERNS } from "./engine/graphics/patterns.ts";
import { loadBundledFonts } from "./engine/graphics/textRaster.ts";
import { App, createUiStoreView } from "./ui/App.tsx";
import { createStarterStack } from "./ui/starterStack.ts";
import { startStudio } from "./ui/startup.ts";
import { createModalManager } from "./ui/System7Shell.tsx";
import { createEffectStage, createMouseTracker, createVmHost } from "./ui/vmHost.ts";

/** Pattern the brush, line, rect, spray and bucket start with (same as DEFAULT_PAINT_SETTINGS). */
const DEFAULT_PATTERN_INDEX = 1;

async function main(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element");

  const starter = validateStack(createStarterStack());
  if (!starter.ok) throw new Error(`The built-in starter stack is invalid: ${starter.error}`);

  const store = createHexStore({ stack: starter.stack, compile: parseHexTalk });
  const history = createHistory(store);
  const modals = createModalManager();
  const effects = createEffectStage();
  const mouse = createMouseTracker();

  let bus: MessageBus | undefined;
  const host = createVmHost({
    store,
    bus: () => {
      if (!bus) throw new Error("The message bus is not ready");
      return bus;
    },
    dialogs: modals,
    effects,
    mouse,
  });
  bus = createMessageBus({
    store,
    host,
    isPageVisible: () => document.visibilityState === "visible",
    isModalOpen: () => modals.isOpen(),
    // Script error dialogs (bomb / alert with Script button) are spec 04 task 4.
    onError: (error, message) => console.error(`HexCard: script error while handling "${message.name}"`, error),
  });

  let patternIndex = DEFAULT_PATTERN_INDEX;
  const painter = createPaintController({ store, history, getSettings: () => ({ pattern: PATTERNS[patternIndex] }) });

  const uiStore = createUiStoreView(store);
  const readyBus: MessageBus = bus; // `bus` is a `let`, so its narrowing does not reach the closure below
  await startStudio({
    loadFonts: loadBundledFonts,
    onFontError: (error) => console.error("HexCard: the bundled fonts could not be loaded; card text uses fallback fonts", error),
    mount: () => new Promise<void>((resolve) => {
      createRoot(rootElement).render(
        <StrictMode>
          <App
            store={uiStore}
            history={history}
            modals={modals}
            bus={readyBus}
            painter={painter}
            effects={effects}
            mouse={mouse}
            initialPatternIndex={patternIndex}
            onPatternChange={(index) => {
              patternIndex = index;
            }}
            onReady={resolve}
          />
        </StrictMode>,
      );
    }),
    // Spec 01 Requirement 2.9: openStack, openBackground, openCard once the first frame is on screen.
    bus,
  });
}

void main();
