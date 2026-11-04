import { describe, expect, it } from "vitest";
import { createHistory } from "../../core/history.ts";
import { parseHexTalk } from "../../core/parser.ts";
import { createHexStore } from "../../core/store.ts";
import { noiseLayer, makeStack } from "../../storage/__tests__/fixtures.ts";
import { decodeStackFile, encodeStackFile, encodeStackPayload } from "../../storage/stackFile.ts";
import { DAMAGED_STACK_MESSAGE, createStackLoader } from "../../storage/stackLoader.ts";
import { SHARE_HASH_PREFIX } from "../../storage/urlCodec.ts";
import { SAVE_STACK_FILE_BUTTON, SHARE_LINK_COPIED_MESSAGE, createFileCommands, type FileBrowserAccess, type PickedFile } from "../fileCommands.ts";
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

function setup(pickedText?: string) {
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
  const commands = createFileCommands({ getStack: () => store.getSnapshot().stack, loader, modals, browser });
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

  it("run handles only this task's File commands", () => {
    const { commands } = setup();
    expect(commands.run("file.exportHtml")).toBe(false);
    expect(commands.run("go.next")).toBe(false);
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
    });
    return { store, modals, run, cleared: () => cleared, storageErrors };
  }

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

  it("keeps the starter stack without an alert when nothing is saved or IndexedDB is unavailable", async () => {
    const empty = startup("", async () => undefined);
    expect(await empty.run()).toBe("starter");
    expect(empty.store.getSnapshot().stack.name).toBe("Current");
    expect(empty.modals.getSnapshot()).toEqual([]);
    expect(empty.cleared()).toBe(0);

    const unavailable = startup("", async () => {
      throw new Error("IndexedDB is not available");
    });
    expect(await unavailable.run()).toBe("starter");
    expect(unavailable.modals.getSnapshot()).toEqual([]);
    expect(unavailable.storageErrors).toHaveLength(1);
  });

  it("rejects a damaged auto-saved record with one alert and keeps the starter stack", async () => {
    const s = startup("", async () => JSON.stringify({ ...makeStack(), cards: [] }));
    expect(await s.run()).toBe("starter");
    expect(s.modals.getSnapshot().map((dialog) => dialog.message)).toEqual([DAMAGED_STACK_MESSAGE]);
    expect(s.store.getSnapshot().stack.name).toBe("Current");
  });
});
