/**
 * File menu commands of spec 04 task 6 (Requirements 5.2, 5.3): Save Stack File, Open Stack File
 * and Copy Share Link, plus loading share links from the page's URL hash.
 *
 * Browser access (downloads, the file picker, the clipboard, the page URL) is injected through
 * `FileBrowserAccess`, so the command logic runs in Node tests; `createBrowserFileAccess` is the
 * DOM implementation used by the composition root.
 */
import type { HexStack } from "../core/schema.ts";
import { decodeStackFile, encodeStackFile, STACK_FILE_EXTENSION, STACK_FILE_MIME_TYPE, stackFileName } from "../storage/stackFile.ts";
import type { LoadStackResult, StackLoader } from "../storage/stackLoader.ts";
import { MAX_SHARE_LINK_LENGTH, buildShareLink, decodeSharePayload, readShareHash } from "../storage/urlCodec.ts";
import type { ForwardedCommand, ModalManager } from "./System7Shell.tsx";

export interface PickedFile {
  text(): Promise<string>;
}

export interface FileBrowserAccess {
  /** Offers `text` as a file download named `fileName`. */
  download(fileName: string, text: string, mimeType: string): void;
  /** Lets the user choose one file; resolves undefined when the picker is cancelled. */
  pickFile(accept: string): Promise<PickedFile | undefined>;
  copyText(text: string): Promise<void>;
  /** The current page URL, e.g. `location.href`. */
  pageUrl(): string;
}

export interface FileCommandOptions {
  getStack: () => HexStack;
  loader: Pick<StackLoader, "loadFrom">;
  modals: Pick<ModalManager, "alert">;
  browser: FileBrowserAccess;
  /** Unexpected failures (e.g. compression unavailable) are reported here as well as in an alert. */
  onError?: (error: unknown) => void;
}

export interface FileCommands {
  /** Runs a File command of this task; returns false for commands it does not handle. */
  run(command: ForwardedCommand): boolean;
  saveStackFile(): Promise<void>;
  openStackFile(): Promise<LoadStackResult | undefined>;
  copyShareLink(): Promise<void>;
}

export const SAVE_STACK_FILE_BUTTON = "Save Stack File";
export const SHARE_LINK_COPIED_MESSAGE = "The share link has been copied to the clipboard.";

export function shareLinkTooLongMessage(length: number): string {
  return `This share link would be ${length.toLocaleString("en-US")} characters long, `
    + `more than the ${MAX_SHARE_LINK_LENGTH.toLocaleString("en-US")} a link can hold.`;
}

export function createFileCommands({ getStack, loader, modals, browser, onError }: FileCommandOptions): FileCommands {
  const fail = (message: string, error: unknown): void => {
    onError?.(error);
    void modals.alert(message, { details: [error instanceof Error ? error.message : String(error)] });
  };

  const saveStackFile = async (): Promise<void> => {
    const stack = getStack();
    try {
      browser.download(stackFileName(stack), await encodeStackFile(stack), STACK_FILE_MIME_TYPE);
    } catch (error) {
      fail("The stack could not be saved.", error);
    }
  };

  const openStackFile = async (): Promise<LoadStackResult | undefined> => {
    let file: PickedFile | undefined;
    try {
      file = await browser.pickFile(STACK_FILE_EXTENSION);
    } catch (error) {
      fail("The stack file could not be opened.", error);
      return undefined;
    }
    if (!file) return undefined;
    const picked = file;
    return loader.loadFrom(async () => decodeStackFile(await picked.text()));
  };

  const copyShareLink = async (): Promise<void> => {
    let link: Awaited<ReturnType<typeof buildShareLink>>;
    try {
      link = await buildShareLink(getStack(), browser.pageUrl());
    } catch (error) {
      fail("The share link could not be created.", error);
      return;
    }
    if (link.tooLong) {
      const choice = await modals.alert(shareLinkTooLongMessage(link.url.length), {
        details: ["Save the stack as a .hexstack file instead."],
        buttons: ["Cancel", SAVE_STACK_FILE_BUTTON],
      });
      if (choice === SAVE_STACK_FILE_BUTTON) await saveStackFile();
      return;
    }
    try {
      await browser.copyText(link.url);
    } catch (error) {
      fail("The share link could not be copied to the clipboard.", error);
      return;
    }
    await modals.alert(SHARE_LINK_COPIED_MESSAGE);
  };

  return {
    run(command) {
      switch (command) {
        case "file.saveStackFile":
          void saveStackFile();
          return true;
        case "file.openStackFile":
          void openStackFile();
          return true;
        case "file.copyShareLink":
          void copyShareLink();
          return true;
        default:
          return false;
      }
    },
    saveStackFile,
    openStackFile,
    copyShareLink,
  };
}

/**
 * Loads the share link in `hash` (`location.hash`), if it is one. Resolves undefined when the hash
 * is not a share link; otherwise the loader's result (a damaged link has already been alerted).
 */
export async function loadShareHash(hash: string, loader: Pick<StackLoader, "loadFrom">): Promise<LoadStackResult | undefined> {
  const payload = readShareHash(hash);
  if (payload === undefined) return undefined;
  return loader.loadFrom(() => decodeSharePayload(payload));
}

/** DOM implementation of `FileBrowserAccess`. */
export function createBrowserFileAccess(): FileBrowserAccess {
  return {
    download(fileName, text, mimeType) {
      const url = URL.createObjectURL(new Blob([text], { type: mimeType }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = fileName;
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      // Revoke after the click has been handled; revoking at once can cancel the download.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    },
    pickFile(accept) {
      return new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = accept;
        input.addEventListener("change", () => resolve(input.files?.[0] ?? undefined), { once: true });
        input.addEventListener("cancel", () => resolve(undefined), { once: true });
        input.click();
      });
    },
    copyText: (text) => navigator.clipboard.writeText(text),
    pageUrl: () => window.location.href,
  };
}
