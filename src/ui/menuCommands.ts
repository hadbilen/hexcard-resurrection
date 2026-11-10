/**
 * Menu model of the studio: the menu layout, exact labels, enabling rules, menu handlers, the
 * shortcut table, platform labels and the key-to-command mapping.
 * Design: .kiro/specs/05-authoring-loop/design.md §5, §6 and §8. Requirements (spec 05) 1-13 and 16.
 *
 * - Every menu item is either enabled and connected to a menu handler, or disabled (Requirement 1.1).
 *   `MenuHandlers` is a `Record` over every non-reserved command, so a missing handler is a type error.
 * - Enabled states are computed from a `MenuContext` (store snapshot, history, back history) when a
 *   menu opens or a shortcut is pressed (Requirement 1.4), and again when a command dispatch starts
 *   (Requirement 1.6).
 * - New Card, New Background, Delete Card and the Go items run as one command dispatch in the message
 *   bus queue (design §5); every other handler runs synchronously.
 *
 * React-free and DOM-free: browser objects are only duck-typed (`closest` on an event target), so
 * the module runs in Node tests.
 */
import {
  canDeleteCard,
  createBlankStack,
  createDeleteCardCommand,
  createNewBackgroundCommand,
  createNewCardCommand,
  createNewPartCommand,
  createDeletePartCommand,
  type RandomSource,
} from "../core/authoringCommands.ts";
import type { HexCommand, HexHistory } from "../core/history.ts";
import { resolveRelativeCard, type CardChangeTarget, type MessageBus } from "../core/messageBus.ts";
import { THEME_PALETTES, type AuthoringTool, type HexID, type HexStack, type PartType, type ThemePaletteName } from "../core/schema.ts";
import type { HexRuntimeState, HexStore } from "../core/store.ts";
import type { ImageFileLike } from "../engine/graphics/imageImport.ts";
import { isPaintTool } from "../engine/graphics/paintTools.ts";
import type { FileCommands } from "./fileCommands.ts";
import type { StudioWindows } from "./ObjectInspector.tsx";
import type { ModalManager } from "./System7Shell.tsx";

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

/** Items whose feature belongs to a later spec: always disabled, no shortcut label, no handler (Requirement 1.5). */
export type ReservedCommand =
  | "edit.iconEditor"
  | "go.recent"
  | "go.find"
  | "go.messageBox"
  | "ai.conjureStack"
  | "ai.oracleSettings";

export type ThemeCommand = `theme:${ThemePaletteName}`;
export type ToolCommand = `tool:${AuthoringTool}`;

export type MenuCommand =
  | ReservedCommand
  | "hex.about"
  | ThemeCommand
  | "file.newStack"
  | "file.openShowcase"
  | "file.openStackFile"
  | "file.saveStackFile"
  | "file.importImage"
  | "file.copyShareLink"
  | "file.exportHtml"
  | "edit.undo"
  | "edit.redo"
  | "edit.background"
  | "go.back"
  | "go.first"
  | "go.previous"
  | "go.next"
  | "go.last"
  | "go.stackGraph"
  | ToolCommand
  | "objects.objectInfo"
  | "objects.cardInfo"
  | "objects.backgroundInfo"
  | "objects.stackInfo"
  | "objects.newButton"
  | "objects.newField"
  | "objects.deletePart"
  | "objects.newCard"
  | "objects.deleteCard"
  | "objects.newBackground"
  | "paint.togglePalette"
  | "ai.conjure";

export const RESERVED_COMMANDS: ReadonlySet<MenuCommand> = new Set<ReservedCommand>([
  "edit.iconEditor",
  "go.recent",
  "go.find",
  "go.messageBox",
  "ai.conjureStack",
  "ai.oracleSettings",
]);

export function isReservedCommand(command: MenuCommand): command is ReservedCommand {
  return RESERVED_COMMANDS.has(command);
}

/** Theme names in menu order (same order as `THEME_PALETTES`). */
export const MENU_THEMES: readonly ThemePaletteName[] = ["ClassicPaper", "AmberCRT", "GreenPhosphor", "MidnightHex"];

/** The 12 tools in palette order with their menu labels (same as `TOOLS` in FloatingTools.tsx). */
export const MENU_TOOLS: readonly { id: AuthoringTool; label: string }[] = [
  { id: "browse", label: "Browse" },
  { id: "button", label: "Button" },
  { id: "field", label: "Field" },
  { id: "select", label: "Select" },
  { id: "lasso", label: "Lasso" },
  { id: "pencil", label: "Pencil" },
  { id: "brush", label: "Brush" },
  { id: "eraser", label: "Eraser" },
  { id: "line", label: "Line" },
  { id: "spray", label: "Spray" },
  { id: "rect", label: "Rectangle" },
  { id: "paintBucket", label: "Paint Bucket" },
];

/** Exact labels of the items with a fixed label (design §6.1); `...` marks items that open a window or dialog. */
const FIXED_LABELS = {
  "hex.about": "About HexCard...",
  "file.newStack": "New Stack",
  "file.openShowcase": "Open Showcase Stack...",
  "file.openStackFile": "Open Stack File...",
  "file.saveStackFile": "Save Stack File",
  "file.importImage": "Import Image...",
  "file.copyShareLink": "Copy Share Link",
  "file.exportHtml": "Export Standalone HTML",
  "edit.background": "Edit Background",
  "edit.iconEditor": "Icon Editor...",
  "go.back": "Back",
  "go.recent": "Recent...",
  "go.first": "First",
  "go.previous": "Prev",
  "go.next": "Next",
  "go.last": "Last",
  "go.find": "Find...",
  "go.messageBox": "Message Box...",
  "go.stackGraph": "Stack Graph...",
  "objects.objectInfo": "Object Info...",
  "objects.cardInfo": "Card Info...",
  "objects.backgroundInfo": "Background Info...",
  "objects.stackInfo": "Stack Info...",
  "objects.newButton": "New Button",
  "objects.newField": "New Field",
  "objects.deletePart": "Delete Part",
  "objects.newCard": "New Card",
  "objects.deleteCard": "Delete Card",
  "objects.newBackground": "New Background",
  "ai.conjure": "Conjure Script...",
  "ai.conjureStack": "Conjure Stack...",
  "ai.oracleSettings": "Oracle Settings...",
} as const satisfies Partial<Record<MenuCommand, string>>;

type FixedLabelCommand = keyof typeof FIXED_LABELS;

/** A label without its trailing `...`, as used in "<item label> is not available now." (Requirement 1.6). */
export function plainLabel(label: string): string {
  return label.endsWith("...") ? label.slice(0, -3) : label;
}

/** Requirement 1.6. */
export function notAvailableMessage(label: string): string {
  return `${plainLabel(label)} is not available now.`;
}

/** The About HexCard alert (unchanged from spec 04). */
export const ABOUT_MESSAGE = "HexCard 2.0.0\nA resurrection of HyperCard (1987).";

// ---------------------------------------------------------------------------------------------
// Context and enabling rules (Requirements 1.4, 3-12)
// ---------------------------------------------------------------------------------------------

export interface MenuContext {
  state: HexRuntimeState;
  history: Pick<HexHistory, "canUndo" | "canRedo" | "undoLabel" | "redoLabel">;
  backHistory: readonly HexID[];
  paletteVisible: boolean;
}

function currentIndex(state: HexRuntimeState): number {
  return state.stack.cards.findIndex((card) => card.id === state.currentCardId);
}

/** Requirement 11.4: the back history holds a card of the stack other than the current card. */
function hasBackTarget(state: HexRuntimeState, backHistory: readonly HexID[]): boolean {
  return backHistory.some((id) => id !== state.currentCardId && state.stack.cards.some((card) => card.id === id));
}

/** The enabling rule of `command` (design §6.1). Reserved items are never enabled. */
export function isEnabled(command: MenuCommand, context: MenuContext): boolean {
  if (isReservedCommand(command)) return false;
  const { state } = context;
  const cards = state.stack.cards;
  switch (command) {
    case "edit.undo":
      return context.history.canUndo();
    case "edit.redo":
      return context.history.canRedo();
    case "go.back":
      return hasBackTarget(state, context.backHistory);
    case "go.first":
      return currentIndex(state) !== 0;
    case "go.last":
      return currentIndex(state) !== cards.length - 1;
    case "go.previous":
    case "go.next":
      return cards.length > 1;
    case "objects.objectInfo":
    case "objects.deletePart":
      return state.selectedPartId !== null;
    case "objects.deleteCard":
      return canDeleteCard(state.stack, state.currentCardId);
    case "file.importImage":
      return isPaintTool(state.tool); // spec 06 Requirement 1.3
    default:
      return true;
  }
}

/** Whether a checkable item is checked; undefined for items that are never checked. */
function checkedState(command: MenuCommand, context: MenuContext): boolean | undefined {
  if (command.startsWith("theme:")) return context.state.stack.themePalette.name === command.slice("theme:".length);
  if (command.startsWith("tool:")) return context.state.tool === command.slice("tool:".length);
  if (command === "edit.background") return context.state.editLayer === "background";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Platform and shortcuts (design §6.3, Requirements 2 and 16)
// ---------------------------------------------------------------------------------------------

export type Platform = "mac" | "other";

/** `navigator.userAgentData.platform`, else `navigator.platform`; "mac" when it starts with "Mac". */
export function detectPlatform(
  nav: { platform?: string; userAgentData?: { platform?: string } } | undefined = globalThis.navigator as
    | { platform?: string; userAgentData?: { platform?: string } }
    | undefined,
): Platform {
  const preferred = nav?.userAgentData?.platform;
  const value = preferred !== undefined && preferred !== "" ? preferred : nav?.platform ?? "";
  return value.toLowerCase().startsWith("mac") ? "mac" : "other";
}

export interface Shortcut {
  key: "B" | "Z";
  shift: boolean;
}

/** "Cmd+B" / "Ctrl+Shift+Z" (Requirement 2.3). */
export function shortcutLabel(shortcut: Shortcut, platform: Platform): string {
  return `${platform === "mac" ? "Cmd" : "Ctrl"}+${shortcut.shift ? "Shift+" : ""}${shortcut.key}`;
}

/** Requirement 2.2: the only menu shortcuts. Platform modifier = Cmd or Ctrl on every platform. */
export const SHORTCUTS: readonly { command: MenuCommand; shortcut: Shortcut }[] = [
  { command: "edit.background", shortcut: { key: "B", shift: false } },
  { command: "edit.undo", shortcut: { key: "Z", shift: false } },
  { command: "edit.redo", shortcut: { key: "Z", shift: true } },
];

/**
 * Requirement 2.1: combinations browsers reserve and pages cannot prevent. `modifier: "platform"`
 * means Cmd on macOS and Ctrl elsewhere; `"ctrl"` means the Control key.
 */
export const RESERVED_BROWSER_SHORTCUTS: readonly { modifier: "platform" | "ctrl"; key: string; shift: boolean }[] = [
  { modifier: "platform", key: "N", shift: false },
  { modifier: "platform", key: "T", shift: false },
  { modifier: "platform", key: "W", shift: false },
  { modifier: "platform", key: "Q", shift: false },
  { modifier: "platform", key: "Tab", shift: false },
  { modifier: "platform", key: "N", shift: true },
  { modifier: "platform", key: "T", shift: true },
  { modifier: "platform", key: "Tab", shift: true },
  { modifier: "ctrl", key: "PageUp", shift: false },
  { modifier: "ctrl", key: "PageDown", shift: false },
];

/** The fields of a `KeyboardEvent` the mapping reads. */
export interface KeyLike {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  target: EventTarget | null;
}

/** Same selector as CardViewport's text-entry test. */
const TEXT_INPUT_SELECTOR = "input, textarea, select, [contenteditable]";

/** Requirement 16: true when the event target is (inside) a text input. */
export function isTextInputTarget(target: EventTarget | null): boolean {
  const element = target as { closest?: (selector: string) => unknown } | null;
  if (element === null || typeof element !== "object" || typeof element.closest !== "function") return false;
  return element.closest(TEXT_INPUT_SELECTOR) !== null;
}

/**
 * The command a key press maps to (design §6.3), with `preventDefault` advice; undefined for
 * text-input targets and for keys that are not studio shortcuts. Table matches are prevented
 * whether or not their item is enabled (Requirement 2.4); Delete / Backspace map to Delete Part
 * only while it is enabled, so Browse-mode `keyDown` forwarding keeps them otherwise (Requirement 2.5).
 */
export function shortcutCommand(event: KeyLike, context: MenuContext): { command: MenuCommand; preventDefault: boolean } | undefined {
  if (isTextInputTarget(event.target)) return undefined;
  if ((event.metaKey || event.ctrlKey) && !event.altKey) {
    const key = event.code === "KeyB" ? "B" : event.code === "KeyZ" ? "Z" : undefined;
    const match = SHORTCUTS.find(({ shortcut }) => shortcut.key === key && shortcut.shift === event.shiftKey);
    return match ? { command: match.command, preventDefault: true } : undefined;
  }
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
  if (plain && (event.key === "Delete" || event.key === "Backspace") && isEnabled("objects.deletePart", context)) {
    return { command: "objects.deletePart", preventDefault: true };
  }
  return undefined;
}

/**
 * The shell's window `keydown` step: maps the press, prevents the default action when advised and
 * runs the menu handler when the item is enabled. Returns the command that ran, if any.
 */
export function handleShortcutKey(
  event: KeyLike & { preventDefault(): void },
  context: MenuContext,
  handlers: MenuHandlers,
): MenuCommand | undefined {
  const mapped = shortcutCommand(event, context);
  if (!mapped) return undefined;
  if (mapped.preventDefault) event.preventDefault();
  return runMenuCommand(mapped.command, context, handlers) ? mapped.command : undefined;
}

// ---------------------------------------------------------------------------------------------
// Layout (design §6.1)
// ---------------------------------------------------------------------------------------------

export type MenuEntry =
  | { kind: "separator" }
  | { kind: "item"; command: MenuCommand; label: string; shortcut?: string; checked?: boolean; disabled: boolean };

export interface MenuModel {
  id: "hex" | "file" | "edit" | "go" | "tools" | "objects" | "paint" | "ai";
  label: string;
  entries: readonly MenuEntry[];
}

const SEPARATOR: MenuEntry = { kind: "separator" };

/** The eight menus in menu-bar order, with labels, check marks, disabled flags and shortcut labels. */
export function buildMenus(context: MenuContext, platform: Platform): MenuModel[] {
  const entry = (command: MenuCommand, label: string): MenuEntry => {
    const result: Extract<MenuEntry, { kind: "item" }> = { kind: "item", command, label, disabled: !isEnabled(command, context) };
    const checked = checkedState(command, context);
    if (checked !== undefined) result.checked = checked;
    const shortcut = SHORTCUTS.find((candidate) => candidate.command === command);
    if (shortcut) result.shortcut = shortcutLabel(shortcut.shortcut, platform);
    return result;
  };
  const fixed = (command: FixedLabelCommand): MenuEntry => entry(command, FIXED_LABELS[command]);
  const undoLabel = context.history.undoLabel();
  const redoLabel = context.history.redoLabel();

  return [
    {
      id: "hex",
      label: "Hex",
      entries: [fixed("hex.about"), SEPARATOR, ...MENU_THEMES.map((name) => entry(`theme:${name}`, name))],
    },
    {
      id: "file",
      label: "File",
      entries: [
        fixed("file.newStack"),
        fixed("file.openShowcase"),
        SEPARATOR,
        fixed("file.openStackFile"),
        fixed("file.saveStackFile"),
        SEPARATOR,
        fixed("file.importImage"),
        SEPARATOR,
        fixed("file.copyShareLink"),
        fixed("file.exportHtml"),
      ],
    },
    {
      id: "edit",
      label: "Edit",
      entries: [
        entry("edit.undo", undoLabel ? `Undo ${undoLabel}` : "Undo"),
        entry("edit.redo", redoLabel ? `Redo ${redoLabel}` : "Redo"),
        SEPARATOR,
        fixed("edit.background"),
        SEPARATOR,
        fixed("edit.iconEditor"),
      ],
    },
    {
      id: "go",
      label: "Go",
      entries: [
        fixed("go.back"),
        fixed("go.recent"),
        SEPARATOR,
        fixed("go.first"),
        fixed("go.previous"),
        fixed("go.next"),
        fixed("go.last"),
        SEPARATOR,
        fixed("go.find"),
        fixed("go.messageBox"),
        SEPARATOR,
        fixed("go.stackGraph"),
      ],
    },
    {
      id: "tools",
      label: "Tools",
      entries: MENU_TOOLS.map((tool) => entry(`tool:${tool.id}`, tool.label)),
    },
    {
      id: "objects",
      label: "Objects",
      entries: [
        fixed("objects.objectInfo"),
        fixed("objects.cardInfo"),
        fixed("objects.backgroundInfo"),
        fixed("objects.stackInfo"),
        SEPARATOR,
        fixed("objects.newButton"),
        fixed("objects.newField"),
        fixed("objects.deletePart"),
        SEPARATOR,
        fixed("objects.newCard"),
        fixed("objects.deleteCard"),
        fixed("objects.newBackground"),
      ],
    },
    {
      id: "paint",
      label: "Paint",
      entries: [entry("paint.togglePalette", context.paletteVisible ? "Hide Tools Palette" : "Show Tools Palette")],
    },
    {
      id: "ai",
      label: "AI Conjure",
      entries: [fixed("ai.conjure"), SEPARATOR, fixed("ai.conjureStack"), fixed("ai.oracleSettings")],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Handlers (design §5, §6.1, §6.2, §8)
// ---------------------------------------------------------------------------------------------

export type MenuHandlers = Record<Exclude<MenuCommand, ReservedCommand>, () => void>;
/** Every handler except the palette toggle, which the shell owns (its visibility is React state). */
export type ShellMenuHandlers = Omit<MenuHandlers, "paint.togglePalette">;

export interface MenuHandlerDeps {
  store: Pick<HexStore, "getSnapshot" | "setTool" | "setEditLayer" | "setSelectedPart">;
  history: Pick<HexHistory, "execute" | "undo" | "redo" | "canUndo" | "canRedo" | "undoLabel" | "redoLabel">;
  /** `backHistory` is read by the enabling rule of Go > Back when its dispatch starts. */
  bus: Pick<MessageBus, "runCommand" | "changeCard" | "changeCardBy" | "sendNested" | "backHistory">;
  windows: Pick<StudioWindows, "openInspector" | "openStackGraph" | "openShowcaseChooser">;
  files: Pick<
    FileCommands,
    "replaceStackFrom" | "openStackFile" | "saveStackFile" | "copyShareLink" | "exportStandaloneHtml" | "pickImageFile"
  >;
  /** Spec 06 Requirement 6: imports a chosen image file into the edit target (main.tsx wiring). */
  images: { importFile(file: ImageFileLike): Promise<unknown> };
  modals: Pick<ModalManager, "alert">;
  /** Id source of new objects; Math.random by default. */
  random?: RandomSource;
}

/** Authoring command that switches the stack theme; Undo restores the palette it replaced. */
export function createThemeCommand(name: ThemePaletteName): HexCommand {
  let previous: HexStack["themePalette"] | undefined;
  return {
    label: "Theme",
    apply(stack) {
      const { darkBitHex, lightBitHex } = THEME_PALETTES[name];
      const current = stack.themePalette;
      if (current.name === name && current.darkBitHex === darkBitHex && current.lightBitHex === lightBitHex) return stack;
      previous = current;
      return { ...stack, themePalette: { name, darkBitHex, lightBitHex } };
    },
    revert(stack) {
      return previous === undefined ? stack : { ...stack, themePalette: previous };
    },
  };
}

export function createMenuHandlers(deps: MenuHandlerDeps): ShellMenuHandlers {
  const { store, history, bus, windows, files, images, modals, random } = deps;

  /** Requirement 1.6: the enabling rule on the live snapshot, when a command dispatch starts. */
  const stillEnabled = (command: MenuCommand): boolean =>
    isEnabled(command, { state: store.getSnapshot(), history, backHistory: bus.backHistory(), paletteVisible: false });
  const notAvailable = (command: FixedLabelCommand): void => {
    void modals.alert(notAvailableMessage(FIXED_LABELS[command]));
  };

  /** Go First / Prev / Next / Last / Back: the destination is resolved when the dispatch starts (Requirement 11.5). */
  const go = (command: FixedLabelCommand, resolve: (state: HexRuntimeState) => CardChangeTarget) => (): void => {
    bus.runCommand(`Go ${plainLabel(FIXED_LABELS[command])}`, async (ctx) => {
      if (!stillEnabled(command)) return notAvailable(command);
      await bus.changeCard(resolve(store.getSnapshot()), ctx);
    });
  };

  /** New Card / New Background (design §5): closeCard [closeBackground] commit newCard [openBackground] openCard. */
  const newCardOn = (command: "objects.newCard" | "objects.newBackground") => (): void => {
    bus.runCommand(FIXED_LABELS[command], async (ctx) => {
      if (!stillEnabled(command)) return notAvailable(command);
      const { stack, currentCardId } = store.getSnapshot();
      const change = command === "objects.newCard"
        ? createNewCardCommand(stack, currentCardId, random)
        : createNewBackgroundCommand(stack, currentCardId, random);
      await bus.changeCardBy(ctx, {
        cardId: change.cardId,
        backgroundId: change.backgroundId,
        isNew: true,
        commit: () => history.execute(change),
      });
    });
  };

  const deleteCard = (): void => {
    bus.runCommand(FIXED_LABELS["objects.deleteCard"], async (ctx) => {
      if (!stillEnabled("objects.deleteCard")) return notAvailable("objects.deleteCard");
      const cardId = store.getSnapshot().currentCardId;
      await bus.sendNested({ name: "deleteCard", params: [], targetId: cardId }, ctx);
      // Requirement 6.4: a deleteCard handler that went elsewhere cancels the deletion.
      if (store.getSnapshot().currentCardId !== cardId) return;
      const { stack } = store.getSnapshot();
      if (!canDeleteCard(stack, cardId)) return notAvailable("objects.deleteCard");
      const change = createDeleteCardCommand(stack, cardId);
      await bus.changeCardBy(ctx, {
        cardId: change.cardId,
        backgroundId: change.backgroundId,
        isNew: false,
        commit: () => history.execute(change),
      });
    });
  };

  /** Requirements 9.1-9.3: add the part, select its tool, select the part. */
  const newPart = (type: PartType) => (): void => {
    const command = createNewPartCommand(store.getSnapshot(), type, random);
    history.execute(command);
    store.setTool(type);
    store.setSelectedPart(command.partId);
  };

  const inspectSelected = (): void => {
    const partId = store.getSnapshot().selectedPartId;
    if (partId !== null) windows.openInspector(partId);
  };

  const themeHandlers = Object.fromEntries(
    MENU_THEMES.map((name) => [`theme:${name}`, () => history.execute(createThemeCommand(name))]),
  ) as Record<ThemeCommand, () => void>;
  const toolHandlers = Object.fromEntries(
    MENU_TOOLS.map(({ id }) => [`tool:${id}`, () => store.setTool(id)]),
  ) as Record<ToolCommand, () => void>;

  return {
    "hex.about": () => void modals.alert(ABOUT_MESSAGE),
    ...themeHandlers,
    "file.newStack": () => {
      void files.replaceStackFrom(() => createBlankStack({ random })).then((result) => {
        if (result?.ok) store.setTool("browse"); // Requirement 3.4
      });
    },
    "file.openShowcase": () => windows.openShowcaseChooser(),
    "file.openStackFile": () => void files.openStackFile(),
    "file.saveStackFile": () => void files.saveStackFile(),
    // Spec 06 Requirement 6.1: the file chooser, then the import of the chosen file.
    "file.importImage": () => void files.pickImageFile().then((file) => (file ? images.importFile(file) : undefined)),
    "file.copyShareLink": () => void files.copyShareLink(),
    "file.exportHtml": () => void files.exportStandaloneHtml(),
    "edit.undo": () => void history.undo(),
    "edit.redo": () => void history.redo(),
    "edit.background": () => store.setEditLayer(store.getSnapshot().editLayer === "background" ? "card" : "background"),
    "go.back": go("go.back", () => ({ type: "relative", dir: "back" })),
    "go.first": go("go.first", (state) => resolveRelativeCard(state, "first")),
    "go.previous": go("go.previous", (state) => resolveRelativeCard(state, "prev")),
    "go.next": go("go.next", (state) => resolveRelativeCard(state, "next")),
    "go.last": go("go.last", (state) => resolveRelativeCard(state, "last")),
    "go.stackGraph": () => windows.openStackGraph(),
    ...toolHandlers,
    "objects.objectInfo": inspectSelected,
    "objects.cardInfo": () => windows.openInspector(store.getSnapshot().currentCardId),
    "objects.backgroundInfo": () => {
      const { stack, currentCardId } = store.getSnapshot();
      const card = stack.cards.find((candidate) => candidate.id === currentCardId);
      if (card) windows.openInspector(card.backgroundId);
    },
    "objects.stackInfo": () => windows.openInspector(store.getSnapshot().stack.id),
    "objects.newButton": newPart("button"),
    "objects.newField": newPart("field"),
    "objects.deletePart": () => {
      const state = store.getSnapshot();
      if (state.selectedPartId === null) return;
      // The store clears the selection once the part is gone (Requirement 10.2).
      history.execute(createDeletePartCommand(state, state.selectedPartId));
    },
    "objects.newCard": newCardOn("objects.newCard"),
    "objects.deleteCard": deleteCard,
    "objects.newBackground": newCardOn("objects.newBackground"),
    "ai.conjure": () => {
      const { selectedPartId, currentCardId } = store.getSnapshot();
      windows.openInspector(selectedPartId ?? currentCardId, "spellcaster");
    },
  };
}

/** Runs the handler only when the item is enabled; returns whether it ran (Requirements 1.2, 1.3). */
export function runMenuCommand(command: MenuCommand, context: MenuContext, handlers: MenuHandlers): boolean {
  if (isReservedCommand(command) || !isEnabled(command, context)) return false;
  const handler = (handlers as Partial<Record<MenuCommand, () => void>>)[command];
  if (handler === undefined) return false;
  handler();
  return true;
}
