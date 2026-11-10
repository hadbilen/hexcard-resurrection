/**
 * Studio composition root (spec 04 design.md §1): creates the store with the built-in starter
 * stack, the history, the message bus, the VM host and the paint controller, then mounts the UI
 * with the narrowed store view (Requirement 2.6). The start-up order is in `ui/startup.ts`: the
 * first frame is composed only after `loadBundledFonts()` has settled (Requirement 2.7), and the
 * stack is opened (spec 01 Requirement 2.9) once the UI has mounted.
 *
 * Persistence (spec 04 task 6): IndexedDB auto-save is injected into the store; before the UI
 * starts, a share link in the URL hash or the most recently auto-saved stack replaces the starter
 * stack through the stack loader, which is also used by File > Open Stack File.
 *
 * Showcase stacks (spec 04 task 8): with nothing to restore, start-up opens 'The Haunted Stack
 * of 1987' (Requirement 7.4); File > Open Showcase Stack lists all three (Requirement 7.5). Both
 * load through the stack loader. File > Open Showcase Stack and Open Stack File first offer to
 * save unsaved changes (Requirement 7.6).
 *
 * Audio (spec 04 task 1): the shared synth is created at start-up, which installs its autoplay
 * unlock listeners before the first click; the VM host plays `play` statements through it.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createHistory } from "./core/history.ts";
import { createMessageBus, type MessageBus } from "./core/messageBus.ts";
import { parseHexTalk } from "./core/parser.ts";
import { validateStack } from "./core/stackValidator.ts";
import { createHexStore } from "./core/store.ts";
import { getHexAudioSynth, playSound } from "./engine/audio/synth.ts";
import { importDroppedImage, importImageFile, type ImageFileLike, type ImageImportDeps } from "./engine/graphics/imageImport.ts";
import { createPaintController } from "./engine/graphics/paintTools.ts";
import { PATTERNS } from "./engine/graphics/patterns.ts";
import { loadBundledFonts } from "./engine/graphics/textRaster.ts";
import { App, createUiStoreView } from "./ui/App.tsx";
import { createAutoSaver, openStackDatabase, type StackDatabase } from "./storage/indexedDb.ts";
import { createStackLoader } from "./storage/stackLoader.ts";
import { FIRST_LAUNCH_SHOWCASE, SHOWCASE_STACKS, findShowcase } from "./presets/index.ts";
import { stripHash } from "./storage/urlCodec.ts";
import { createBrowserFileAccess, createChangeTracker, createFileCommands, loadShareHash } from "./ui/fileCommands.ts";
import { createStarterStack } from "./ui/starterStack.ts";
import { openInitialStack, startStudio } from "./ui/startup.ts";
import { createMenuHandlers, detectPlatform } from "./ui/menuCommands.ts";
import { createScriptErrorReporter, createStudioWindows } from "./ui/ObjectInspector.tsx";
import { createModalManager } from "./ui/System7Shell.tsx";
import { createEffectStage, createMouseTracker, createVmHost } from "./ui/vmHost.ts";

/** Pattern the brush, line, rect, spray and bucket start with (same as DEFAULT_PAINT_SETTINGS). */
const DEFAULT_PATTERN_INDEX = 1;

async function main(): Promise<void> {
  const rootElement = document.getElementById("root");
  if (!rootElement) throw new Error("Missing #root element");

  // Creates the synth and installs the autoplay unlock before any await, so the first click unlocks audio.
  getHexAudioSynth();

  const starter = validateStack(createStarterStack());
  if (!starter.ok) throw new Error(`The built-in starter stack is invalid: ${starter.error}`);

  // Start loading the fonts at once; `startStudio` awaits them before the first frame (Req 2.7).
  const fonts = loadBundledFonts();
  fonts.catch(() => {}); // the rejection is reported by startStudio's onFontError

  // Requirement 5.1: the store debounces runtime and authoring changes (500 ms) into this callback.
  const openDatabase = (() => {
    let database: Promise<StackDatabase> | undefined;
    return () => (database ??= openStackDatabase().catch((error: unknown) => {
      database = undefined;
      throw error;
    }));
  })();
  const autoSave = createAutoSaver(openDatabase, (error) =>
    console.error("HexCard: the stack could not be auto-saved to IndexedDB", error));

  const store = createHexStore({ stack: starter.stack, compile: parseHexTalk, autoSave: (stack) => void autoSave(stack) });
  const history = createHistory(store);
  const modals = createModalManager();
  // Object Inspector / Stack Graph (spec 04 task 4); modal for the bus, so `idle` waits while they are open.
  const windows = createStudioWindows();

  // Requirement 5.5: the one loading path; the only holder of `store.replaceStack` (Req 2.6).
  const loader = createStackLoader({
    store,
    history,
    alert: (message, options) => void modals.alert(message, options),
  });
  // A loaded stack is saved at once, so a reload restores it even before it is edited.
  store.onReplaceStack(() => void autoSave(store.getSnapshot().stack));
  // Before the message bus exists, so the restored stack is opened once, by startStudio.
  await openInitialStack({
    hash: window.location.hash,
    clearHash: () => window.history.replaceState(window.history.state, "", stripHash(window.location.href)),
    loadMostRecent: async () => (await openDatabase()).loadMostRecent(),
    loader,
    onStorageError: (error) => console.error("HexCard: the auto-saved stack could not be read from IndexedDB", error),
    // Requirement 7.4: nothing to restore opens 'The Haunted Stack of 1987'.
    firstLaunchStack: FIRST_LAUNCH_SHOWCASE.create,
  });
  // Requirement 7.6: changes since the last load (or file save) are offered for saving before a
  // File command replaces the stack. Created after start-up, so the restored stack is the baseline.
  const changes = createChangeTracker(store);
  const effects = createEffectStage();
  const mouse = createMouseTracker();

  const reportScriptError = createScriptErrorReporter({
    getStack: () => store.getSnapshot().stack,
    modals,
    openScript: (objectId, line) => windows.openInspector(objectId, "script", line),
    log: (error, message) => console.error(`HexCard: script error while handling "${message.name}"`, error),
  });

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
    playSound, // a module-level function that resolves the shared synth itself, so no `this` to bind
  });
  bus = createMessageBus({
    store,
    host,
    isPageVisible: () => document.visibilityState === "visible",
    isModalOpen: () => modals.isOpen() || windows.isOpen(),
    // Requirements 3.3 and 3.4: the bomb dialog, or an alert whose Script button opens the editor.
    onError: (error, message) => void reportScriptError(error, message),
  });

  let patternIndex = DEFAULT_PATTERN_INDEX;
  const painter = createPaintController({ store, history, getSettings: () => ({ pattern: PATTERNS[patternIndex] }) });

  // Requirements 5.2 and 5.3: File > Save Stack File, Open Stack File, Copy Share Link.
  const fileCommands = createFileCommands({
    getStack: () => store.getSnapshot().stack,
    loader,
    modals,
    browser: createBrowserFileAccess(),
    changes,
    onError: (error) => console.error("HexCard: file command failed", error),
  });
  // Requirement 7.5: File > Open Showcase Stack loads the chosen stack through the loader,
  // after the unsaved-changes question of Requirement 7.6.
  const showcases = SHOWCASE_STACKS.map(({ id, name, description }) => ({ id, name, description }));
  const openShowcase = (id: string): void => {
    const showcase = findShowcase(id);
    if (showcase) void fileCommands.replaceStackFrom(showcase.create);
  };
  // A share link pasted into the address bar of an open studio changes only the hash.
  window.addEventListener("hashchange", () => {
    void loadShareHash(window.location.hash, loader).then((result) => {
      if (result !== undefined) window.history.replaceState(window.history.state, "", stripHash(window.location.href));
    });
  });

  // Spec 06 Requirement 6: File > Import Image and drops on the card, each one "Import Image" command.
  const imageDeps: ImageImportDeps = { store, history, alert: (message) => void modals.alert(message) };
  const reportImportError = (error: unknown): false => {
    console.error("HexCard: the image could not be imported", error);
    return false;
  };
  const images = {
    importFile: (file: ImageFileLike) => importImageFile(file, imageDeps).catch(reportImportError),
    dropFile: (file: ImageFileLike) => importDroppedImage(file, imageDeps).catch(reportImportError),
  };

  const uiStore = createUiStoreView(store);
  const readyBus: MessageBus = bus; // `bus` is a `let`, so its narrowing does not reach the closure below
  // Spec 05 design §3.5: every menu item's handler, built from the narrowed store view (no
  // applyAuthoring / replaceStack); File > New Stack loads through the file commands' loader.
  const menuHandlers = createMenuHandlers({
    store: uiStore,
    history,
    bus: readyBus,
    windows,
    files: fileCommands,
    images,
    modals,
  });
  const platform = detectPlatform(navigator);
  await startStudio({
    loadFonts: () => fonts,
    onFontError: (error) => console.error("HexCard: the bundled fonts could not be loaded; card text uses fallback fonts", error),
    mount: () => new Promise<void>((resolve) => {
      createRoot(rootElement).render(
        <StrictMode>
          <App
            store={uiStore}
            history={history}
            modals={modals}
            windows={windows}
            bus={readyBus}
            painter={painter}
            effects={effects}
            mouse={mouse}
            initialPatternIndex={patternIndex}
            onPatternChange={(index) => {
              patternIndex = index;
            }}
            onReady={resolve}
            handlers={menuHandlers}
            platform={platform}
            showcases={showcases}
            onOpenShowcase={openShowcase}
            onDropImage={(file) => void images.dropFile(file)}
          />
        </StrictMode>,
      );
    }),
    // Spec 01 Requirement 2.9: openStack, openBackground, openCard once the first frame is on screen.
    bus,
  });
}

void main();
