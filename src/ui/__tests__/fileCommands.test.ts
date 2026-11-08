import { describe, expect, it } from "vitest";
import { createHistory } from "../../core/history.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { createHexStore } from "../../core/store.ts";
import { noiseLayer, makeStack } from "../../storage/__tests__/fixtures.ts";
import { decodeStackFile, encodeStackFile, encodeStackPayload } from "../../storage/stackFile.ts";
import { DAMAGED_STACK_MESSAGE, createStackLoader } from "../../storage/stackLoader.ts";
import { SHARE_HASH_PREFIX } from "../../storage/urlCodec.ts";
import { parseEmbeddedStack } from "../../player/embedded.ts";
import {
  CANCEL_BUTTON,
  DONT_SAVE_BUTTON,
  EXPORT_NEEDS_BUILD_MESSAGE,
  SAVE_CHANGES_BUTTON,
  SAVE_CHANGES_MESSAGE,
  SAVE_STACK_FILE_BUTTON,
  SHARE_LINK_COPIED_MESSAGE,
  createChangeTracker,
  createFileCommands,
  loadPlayerSource,
  type FileBrowserAccess,
  type PickedFile,
} from "../fileCommands.ts";
import { openInitialStack } from "../startup.ts";
import { createModalManager } from "../System7Shell.tsx";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Waits until the modal manager shows a dialog (encoding runs on real compression streams). */
async function nextDialog(modals: ReturnType<typeof createModalManager>) {
  for (let i = 0; i < 200 && modals.getSnapshot().length === 0; i++) await flush();
  const dialog = modals.getSnapshot()[0];
  if (!dialog) throw new Error("no dialog appeared");
  return dialog;
}

function setup(pickedText?: string, loadPlayer?: () => Promise<string | null>) {
  const store = createHexStore({ stack: makeStack({ name: "Current" }), compile: parseHexTalk });
  const history = createHistory(store);
  const modals = createModalManager();
  const loader = createStackLoader({ store, history, alert: (message, options) => void modals.alert(message, options) });
  const downloads: Array<{ fileName: string; text: string; mimeType: string }> = [];
  const copied: string[] = [];
  const browser: FileBrowserAccess = {
    download: (fileName, text, mimeType) => downloads.push({ fileName, text, mimeType }),
    pickFile: async (): Promise<PickedFile | undefined> =>
      pickedText === undefined ? undefined : { text: async () => pickedText },
    copyText: async (text) => {
      copied.push(text);
    },
    pageUrl: () => "https://example.org/hexcard/#old",
  };
  const commands = createFileCommands({ getStack: () => store.getSnapshot().stack, loader, modals, browser, loadPlayer });
  return { store, history, modals, commands, downloads, copied };
}

describe("File menu commands", () => {
  it("Save Stack File downloads <name>.hexstack holding the compressed stack", async () => {
    const { store, commands, downloads } = setup();
    await commands.saveStackFile();
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe("Current.hexstack");
    expect(await decodeStackFile(downloads[0].text)).toEqual(store.getSnapshot().stack);
  });

  it("Open Stack File loads the chosen file through the loader; cancelling does nothing", async () => {
    const next = makeStack({ id: "stk_opened", name: "Opened" });
    const { store, commands } = setup(await encodeStackFile(next));
    expect((await commands.openStackFile())?.ok).toBe(true);
    expect(store.getSnapshot().stack.name).toBe("Opened");

    const cancelled = setup();
    expect(await cancelled.commands.openStackFile()).toBeUndefined();
    expect(cancelled.store.getSnapshot().stack.name).toBe("Current");
  });

  it("Open Stack File rejects a damaged file with one alert", async () => {
    const { store, modals, commands } = setup("not a stack file");
    const before = store.getSnapshot();
    expect((await commands.openStackFile())?.ok).toBe(false);
    expect(modals.getSnapshot().map((dialog) => dialog.message)).toEqual([DAMAGED_STACK_MESSAGE]);
    expect(store.getSnapshot()).toBe(before);
  });

  it("Copy Share Link copies the page URL with the payload in the hash", async () => {
    const { store, modals, commands, copied } = setup();
    const done = commands.copyShareLink();
    const dialog = await nextDialog(modals);
    expect(dialog.message).toBe(SHARE_LINK_COPIED_MESSAGE);
    modals.settle(dialog.id, "OK");
    await done;
    expect(copied).toEqual([`https://example.org/hexcard/${SHARE_HASH_PREFIX}${await encodeStackPayload(store.getSnapshot().stack)}`]);
  });

  it("a share link over 32,000 characters is not copied; the warning offers the .hexstack file", async () => {
    const { store, history, modals, commands, copied, downloads } = setup();
    const big = makeStack({ id: "stk_big", name: "Big" });
    big.cards[0].bitmap.rleData = noiseLayer(7);
    history.clear();
    store.replaceStack(big);

    const done = commands.copyShareLink();
    const dialog = await nextDialog(modals);
    expect(dialog.message).toContain("more than the 32,000");
    expect(dialog.kind === "alert" && dialog.buttons).toEqual(["Cancel", SAVE_STACK_FILE_BUTTON]);
    modals.settle(dialog.id, SAVE_STACK_FILE_BUTTON);
    await done;

    expect(copied).toEqual([]);
    expect(downloads.map((download) => download.fileName)).toEqual(["Big.hexstack"]);
  });

  it("Save Stack File resolves false when the stack cannot be encoded", async () => {
    const { store, commands, downloads, modals } = setup();
    const broken = createFileCommands({
      getStack: () => ({ ...store.getSnapshot().stack, name: 1n as unknown as string }), // BigInt: JSON.stringify throws
      loader: createStackLoader({ store, history: createHistory(store), alert: () => undefined }),
      modals,
      browser: { download: () => downloads.push({ fileName: "", text: "", mimeType: "" }), pickFile: async () => undefined, copyText: async () => undefined, pageUrl: () => "" },
    });
    expect(await commands.saveStackFile()).toBe(true);
    expect(await broken.saveStackFile()).toBe(false);
    expect(downloads).toHaveLength(1);
  });

  it("loadPlayerSource resolves virtual:hexcard-player under Vitest (text of dist-player/player.js, or null)", async () => {
    const source = await loadPlayerSource();
    expect(source === null || typeof source === "string").toBe(true);
  });

  it("Export Standalone HTML without a player build alerts and downloads nothing", async () => {
    const { modals, commands, downloads } = setup(undefined, async () => null);
    const done = commands.exportStandaloneHtml();
    const dialog = await nextDialog(modals);
    expect(dialog.message).toBe(EXPORT_NEEDS_BUILD_MESSAGE);
    modals.settle(dialog.id, "OK");
    expect(await done).toBe(false);
    expect(downloads).toEqual([]);
  });

  it("Export Standalone HTML downloads <name>.html with the player and the current stack", async () => {
    const { store, modals, commands, downloads } = setup(undefined, async () => "/*FAKE_PLAYER*/");
    // A runtime change: the export holds the stack as it is now, with no prompt.
    store.applyRuntime({ type: "setFieldText", cardId: "crd_starter", layer: "card", partId: "prt_welcome", text: "</script><!-- typed" });
    expect(await commands.exportStandaloneHtml()).toBe(true);
    expect(modals.getSnapshot()).toEqual([]);
    expect(downloads).toHaveLength(1);
    expect(downloads[0].fileName).toBe("Current.html");
    expect(downloads[0].mimeType).toBe("text/html");
    expect(downloads[0].text).toContain("<script>/*FAKE_PLAYER*/</script>");
    const json = /<script type="application\/json" id="hexstack">([^<]*)<\/script>/.exec(downloads[0].text)?.[1];
    const parsed = parseEmbeddedStack(json);
    expect(parsed.ok && parsed.stack).toEqual(store.getSnapshot().stack);
  });
});

// ---------------------------------------------------------------------------------------------
// Requirement 7.6: unsaved changes before a File command replaces the stack
// ---------------------------------------------------------------------------------------------

describe("unsaved-changes guard", () => {
  async function guarded() {
    const opened = makeStack({ id: "stk_opened", name: "Opened" });
    const base = setup(await encodeStackFile(opened));
    const changes = createChangeTracker(base.store);
    const loader = createStackLoader({ store: base.store, history: base.history, alert: (message, options) => void base.modals.alert(message, options) });
    const commands = createFileCommands({
      getStack: () => base.store.getSnapshot().stack,
      loader,
      modals: base.modals,
      browser: {
        download: (fileName, text, mimeType) => base.downloads.push({ fileName, text, mimeType }),
        pickFile: async () => ({ text: async () => encodeStackFile(opened) }),
        copyText: async () => undefined,
        pageUrl: () => "https://example.org/",
      },
      changes,
    });
    const edit = () => base.store.applyRuntime({ type: "setStackProperty", property: "name", value: "Edited" });
    const showcase = () => makeStack({ id: "stk_showcase", name: "Showcase" });
    return { ...base, changes, commands, edit, showcase };
  }

  it("opens without asking when nothing changed since the stack was loaded", async () => {
    const g = await guarded();
    expect(g.changes.hasChanges()).toBe(false);
    expect((await g.commands.replaceStackFrom(g.showcase))?.ok).toBe(true);
    expect((await g.commands.openStackFile())?.ok).toBe(true);
    expect(g.store.getSnapshot().stack.name).toBe("Opened");
    expect(g.modals.getSnapshot()).toEqual([]);
    expect(g.downloads).toEqual([]);
  });

  it("asks with Save…, Don't Save and Cancel in that order, Save… being the default", async () => {
    const g = await guarded();
    g.edit();
    const done = g.commands.openStackFile();
    const dialog = await nextDialog(g.modals);
    expect(dialog).toMatchObject({
      kind: "alert",
      message: SAVE_CHANGES_MESSAGE,
      buttons: ["Save\u2026", "Don't Save", "Cancel"],
      defaultButton: SAVE_CHANGES_BUTTON,
      cancelButton: CANCEL_BUTTON,
    });
    g.modals.settle(dialog.id, CANCEL_BUTTON);
    await done;
  });

  it("Save… saves the changed stack as a .hexstack file, then opens", async () => {
    const g = await guarded();
    g.edit();
    const edited = g.store.getSnapshot().stack;
    const done = g.commands.openStackFile();
    g.modals.settle((await nextDialog(g.modals)).id, SAVE_CHANGES_BUTTON);
    expect((await done)?.ok).toBe(true);
    expect(g.downloads.map((download) => download.fileName)).toEqual(["Edited.hexstack"]);
    expect(await decodeStackFile(g.downloads[0].text)).toEqual(edited);
    expect(g.store.getSnapshot().stack.name).toBe("Opened");
  });

  it("Don't Save opens without saving", async () => {
    const g = await guarded();
    g.edit();
    const done = g.commands.replaceStackFrom(g.showcase);
    g.modals.settle((await nextDialog(g.modals)).id, DONT_SAVE_BUTTON);
    expect((await done)?.ok).toBe(true);
    expect(g.downloads).toEqual([]);
    expect(g.store.getSnapshot().stack.name).toBe("Showcase");
    expect(g.changes.hasChanges()).toBe(false); // the loaded stack is the new baseline
  });

  it("Cancel leaves the stack, its undo history and the downloads untouched", async () => {
    const g = await guarded();
    g.history.execute({
      label: "Rename",
      apply: (stack) => ({ ...stack, name: "Authored" }),
      revert: (stack) => ({ ...stack, name: "Current" }),
    });
    const before = g.store.getSnapshot();
    expect(g.changes.hasChanges()).toBe(true);

    const showcase = g.commands.replaceStackFrom(g.showcase);
    g.modals.settle((await nextDialog(g.modals)).id, CANCEL_BUTTON);
    expect(await showcase).toBeUndefined();
    const file = g.commands.openStackFile();
    g.modals.settle((await nextDialog(g.modals)).id, CANCEL_BUTTON);
    expect(await file).toBeUndefined();

    expect(g.store.getSnapshot()).toBe(before);
    expect(g.history.canUndo()).toBe(true);
    expect(g.downloads).toEqual([]);
  });

  it("does not count a change that was undone, or changes already saved as a file", async () => {
    const g = await guarded();
    g.history.execute({
      label: "Rename",
      apply: (stack) => ({ ...stack, name: "Authored" }),
      revert: (stack) => ({ ...stack, name: "Current" }),
    });
    expect(g.changes.hasChanges()).toBe(true);
    g.history.undo();
    expect(g.changes.hasChanges()).toBe(false);

    g.edit();
    expect(g.changes.hasChanges()).toBe(true);
    expect(await g.commands.saveStackFile()).toBe(true);
    expect(g.changes.hasChanges()).toBe(false);
    expect((await g.commands.replaceStackFrom(g.showcase))?.ok).toBe(true);
    expect(g.modals.getSnapshot()).toEqual([]);
  });
});

describe("openInitialStack", () => {
  function startup(hash: string, record: () => Promise<string | undefined>) {
    const { store, history, modals } = setup();
    const loader = createStackLoader({ store, history, alert: (message, options) => void modals.alert(message, options) });
    let cleared = 0;
    const storageErrors: unknown[] = [];
    const run = () => openInitialStack({
      hash,
      clearHash: () => {
        cleared++;
      },
      loadMostRecent: record,
      loader,
      onStorageError: (error) => storageErrors.push(error),
      firstLaunchStack,
    });
    return { store, modals, run, cleared: () => cleared, storageErrors };
  }

  let firstLaunchStack: () => unknown = () => makeStack({ id: "stk_showcase", name: "Showcase" });

  it("prefers a share link in the hash and clears the hash", async () => {
    const shared = makeStack({ id: "stk_shared", name: "Shared" });
    const saved = JSON.stringify(makeStack({ id: "stk_saved", name: "Saved" }));
    const s = startup(`${SHARE_HASH_PREFIX}${await encodeStackPayload(shared)}`, async () => saved);
    expect(await s.run()).toBe("urlHash");
    expect(s.store.getSnapshot().stack.name).toBe("Shared");
    expect(s.cleared()).toBe(1);
  });

  it("falls back to the auto-saved stack after a damaged share link, with one alert", async () => {
    const saved = JSON.stringify(makeStack({ id: "stk_saved", name: "Saved" }));
    const s = startup(`${SHARE_HASH_PREFIX}garbage`, async () => saved);
    expect(await s.run()).toBe("indexedDb");
    expect(s.store.getSnapshot().stack.name).toBe("Saved");
    expect(s.modals.getSnapshot().map((dialog) => dialog.message)).toEqual([DAMAGED_STACK_MESSAGE]);
    expect(s.cleared()).toBe(1);
  });

  it("opens the first-launch showcase without an alert when nothing is saved or IndexedDB is unavailable (Req 7.4)", async () => {
    const empty = startup("", async () => undefined);
    expect(await empty.run()).toBe("showcase");
    expect(empty.store.getSnapshot().stack.name).toBe("Showcase");
    expect(empty.modals.getSnapshot()).toEqual([]);
    expect(empty.cleared()).toBe(0);

    const unavailable = startup("", async () => {
      throw new Error("IndexedDB is not available");
    });
    expect(await unavailable.run()).toBe("showcase");
    expect(unavailable.modals.getSnapshot()).toEqual([]);
    expect(unavailable.storageErrors).toHaveLength(1);
  });

  it("rejects a damaged auto-saved record with one alert, then opens the first-launch showcase", async () => {
    const s = startup("", async () => JSON.stringify({ ...makeStack(), cards: [] }));
    expect(await s.run()).toBe("showcase");
    expect(s.modals.getSnapshot().map((dialog) => dialog.message)).toEqual([DAMAGED_STACK_MESSAGE]);
    expect(s.store.getSnapshot().stack.name).toBe("Showcase");
  });

  it("keeps the starter stack only if the first-launch showcase is rejected", async () => {
    const original = firstLaunchStack;
    firstLaunchStack = () => ({ ...makeStack(), cards: [] });
    try {
      const s = startup("", async () => undefined);
      expect(await s.run()).toBe("starter");
      expect(s.store.getSnapshot().stack.name).toBe("Current");
      expect(s.modals.getSnapshot().map((dialog) => dialog.message)).toEqual([DAMAGED_STACK_MESSAGE]);
    } finally {
      firstLaunchStack = original;
    }
  });
});
