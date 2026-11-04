/**
 * System 7 shell: menu bar, Edit Background stripes, theme switcher, tear-off tools palette host
 * and modal manager. Requirements: spec 04 2.2, 2.3, 2.4, 2.6.
 * Design: .kiro/specs/04-ui-audio-showcase/design.md §1.
 *
 * - State is read with `useSyncExternalStore`; the shell only calls `store.setTool`,
 *   `store.setEditLayer` (UI state) and `history.execute` / `undo` / `redo` (theme and undo).
 * - Menu items that belong to later tasks (file I/O, navigation, objects, Spellcaster) are
 *   forwarded to `onCommand`; the shell does not implement them.
 * - The modal manager is created by the composition root with `createModalManager()` so that the
 *   VM host (`showAnswer` / `showAsk`) and the message bus (`isModalOpen`) can use the same instance.
 */
import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import type { HexCommand, HexHistory } from "../core/history.ts";
import { THEME_PALETTES, type AuthoringTool, type HexStack, type ThemePaletteName } from "../core/schema.ts";
import type { HexLayer, HexStore } from "../core/store.ts";
import {
  FloatingTools,
  MENU_BAR_HEIGHT,
  PixelIcon,
  TOOLS,
  beginPointerDrag,
  clampPaletteOrigin,
  type Point,
} from "./FloatingTools.tsx";
import "./system7.css";

/** Requirement 2.6: the store view handed to every UI component. */
export type UiStore = Omit<HexStore, "applyAuthoring" | "replaceStack">;

/** The part of the history the shell needs. */
export type ShellHistory = Pick<HexHistory, "execute" | "undo" | "redo" | "canUndo" | "canRedo" | "undoLabel" | "redoLabel">;

// ---------------------------------------------------------------------------------------------
// Themes (Requirement 2.4)
// ---------------------------------------------------------------------------------------------

export const THEME_NAMES: readonly ThemePaletteName[] = ["ClassicPaper", "AmberCRT", "GreenPhosphor", "MidnightHex"];

/** CSS custom properties for a stack's palette. Custom properties are the only theme mechanism. */
export function themeCssVariables(palette: { darkBitHex: string; lightBitHex: string }): CSSProperties {
  return { "--dark-bit": palette.darkBitHex, "--light-bit": palette.lightBitHex } as CSSProperties;
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

// ---------------------------------------------------------------------------------------------
// Modal manager (alerts, bomb dialog, answer / ask)
// ---------------------------------------------------------------------------------------------

export interface AlertOptions {
  /** Button labels, left to right; the last one is the default button. Default: `["OK"]`. */
  buttons?: readonly string[];
  /** Extra lines under the message, e.g. object, handler and line of a script error. */
  details?: readonly string[];
}

export type ModalRequest =
  | { id: number; kind: "alert" | "bomb" | "answer"; message: string; buttons: readonly string[]; details: readonly string[]; resolve: (label: string) => void }
  | { id: number; kind: "ask"; message: string; defaultAnswer: string; resolve: (text: string) => void };

export interface ModalManager {
  subscribe(listener: () => void): () => void;
  /** Open and queued requests, oldest first. The first one is on screen. A new array on every change. */
  getSnapshot(): readonly ModalRequest[];
  /** True while any dialog is open or queued (message bus `isModalOpen`). */
  isOpen(): boolean;
  /** System 7 alert. Resolves with the label of the clicked button. */
  alert(message: string, options?: AlertOptions): Promise<string>;
  /** The bomb dialog, e.g. "Sorry, a script error occurred: Loop exceeded 10,000 steps". */
  bomb(message: string, options?: AlertOptions): Promise<string>;
  /** HyperTalk `answer`: resolves with the clicked button label. */
  answer(prompt: string, buttons: readonly string[]): Promise<string>;
  /** HyperTalk `ask`: resolves with the typed text, or "" when cancelled. */
  ask(prompt: string, defaultAnswer: string): Promise<string>;
  /** Used by the dialog components. */
  settle(id: number, value: string): void;
}

export function createModalManager(): ModalManager {
  const listeners = new Set<() => void>();
  let queue: readonly ModalRequest[] = [];
  let nextId = 1;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };
  const push = (request: ModalRequest): void => {
    queue = [...queue, request];
    emit();
  };
  const labels = (buttons: readonly string[] | undefined): readonly string[] =>
    buttons !== undefined && buttons.length > 0 ? [...buttons] : ["OK"];
  const labelled = (kind: "alert" | "bomb" | "answer") => (message: string, options: AlertOptions = {}): Promise<string> =>
    new Promise((resolve) => {
      push({ id: nextId++, kind, message, buttons: labels(options.buttons), details: [...(options.details ?? [])], resolve });
    });

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => queue,
    isOpen: () => queue.length > 0,
    alert: labelled("alert"),
    bomb: labelled("bomb"),
    answer: (prompt, buttons) => labelled("answer")(prompt, { buttons }),
    ask: (message, defaultAnswer) =>
      new Promise((resolve) => {
        push({ id: nextId++, kind: "ask", message, defaultAnswer, resolve });
      }),
    settle(id, value) {
      const request = queue.find((candidate) => candidate.id === id);
      if (!request) return;
      queue = queue.filter((candidate) => candidate.id !== id);
      request.resolve(value);
      emit();
    },
  };
}

const BOMB_ICON: readonly string[] = [
  "............#.#.",
  ".............#..",
  "...........#....",
  "..........#.....",
  "....######......",
  "..##########....",
  ".#.##########...",
  ".############...",
  "##############..",
  "##############..",
  "##############..",
  ".############...",
  ".############...",
  "..##########....",
  "....######......",
  "................",
];

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button, input")].filter((element) => !element.hasAttribute("disabled"));
}

function ModalDialog({ request, modals }: { request: ModalRequest; modals: ModalManager }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const defaultButtonRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(request.kind === "ask" ? request.defaultAnswer : "");
  const titleId = useId();

  useEffect(() => {
    if (request.kind === "ask") inputRef.current?.select();
    else defaultButtonRef.current?.focus();
  }, [request.kind]);

  const cancelValue = request.kind === "ask" ? "" : undefined;
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape" && cancelValue !== undefined) {
      event.preventDefault();
      modals.settle(request.id, cancelValue);
    } else if (event.key === "Enter" && request.kind === "ask") {
      event.preventDefault();
      modals.settle(request.id, text);
    } else if (event.key === "Tab" && dialogRef.current) {
      const items = focusables(dialogRef.current);
      if (items.length === 0) return;
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next = event.shiftKey ? (index <= 0 ? items.length - 1 : index - 1) : index === items.length - 1 ? 0 : index + 1;
      event.preventDefault();
      items[next].focus();
    }
  };

  return (
    <div className="s7-modal-backdrop">
      <div
        ref={dialogRef}
        className={`s7-dialog s7-dialog-${request.kind}`}
        role={request.kind === "ask" || request.kind === "answer" ? "dialog" : "alertdialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        {request.kind === "bomb" ? (
          <div className="s7-dialog-icon">
            <PixelIcon rows={BOMB_ICON} scale={2} />
          </div>
        ) : null}
        <div className="s7-dialog-body">
          <p id={titleId} className="s7-dialog-message">
            {request.message}
          </p>
          {request.kind !== "ask"
            ? request.details.map((line, index) => (
                <p key={index} className="s7-dialog-detail">
                  {line}
                </p>
              ))
            : null}
          {request.kind === "ask" ? (
            <input
              ref={inputRef}
              className="s7-dialog-input"
              type="text"
              value={text}
              aria-label={request.message}
              onChange={(event) => setText(event.target.value)}
            />
          ) : null}
          <div className="s7-dialog-buttons">
            {request.kind === "ask" ? (
              <>
                <button type="button" className="s7-button" onClick={() => modals.settle(request.id, "")}>
                  Cancel
                </button>
                <button type="button" className="s7-button s7-button-default" onClick={() => modals.settle(request.id, text)}>
                  OK
                </button>
              </>
            ) : (
              request.buttons.map((label, index) => {
                const isDefault = index === request.buttons.length - 1;
                return (
                  <button
                    key={`${index}:${label}`}
                    ref={isDefault ? defaultButtonRef : undefined}
                    type="button"
                    className={isDefault ? "s7-button s7-button-default" : "s7-button"}
                    onClick={() => modals.settle(request.id, label)}
                  >
                    {label}
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ModalLayer({ modals }: { modals: ModalManager }) {
  const queue = useSyncExternalStore(modals.subscribe, modals.getSnapshot, modals.getSnapshot);
  const current = queue[0];
  return current ? <ModalDialog key={current.id} request={current} modals={modals} /> : null;
}

// ---------------------------------------------------------------------------------------------
// Menus (design spec §7.1)
// ---------------------------------------------------------------------------------------------

/** Menu commands the shell forwards to `onCommand`; they are implemented by later tasks. */
export type ForwardedCommand =
  | "file.saveStackFile"
  | "file.openStackFile"
  | "file.copyShareLink"
  | "file.exportHtml"
  | "file.openShowcase"
  | "go.first"
  | "go.previous"
  | "go.next"
  | "go.last"
  | "go.stackGraph"
  | "objects.newButton"
  | "objects.newField"
  | "objects.objectInfo"
  | "ai.conjure";

export type ShellCommand =
  | ForwardedCommand
  | "hex.about"
  | "edit.undo"
  | "edit.redo"
  | "edit.background"
  | "paint.togglePalette"
  | `tool:${AuthoringTool}`
  | `theme:${ThemePaletteName}`;

export type MenuEntry =
  | { kind: "separator" }
  | { kind: "item"; command: ShellCommand; label: string; shortcut?: string; checked?: boolean; disabled?: boolean };

export interface MenuModel {
  id: string;
  label: string;
  entries: readonly MenuEntry[];
}

export interface MenuState {
  tool: AuthoringTool;
  editLayer: HexLayer;
  themeName: ThemePaletteName;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel?: string;
  redoLabel?: string;
  paletteVisible: boolean;
}

const item = (command: ShellCommand, label: string, extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {}): MenuEntry => ({
  kind: "item",
  command,
  label,
  ...extra,
});
const SEPARATOR: MenuEntry = { kind: "separator" };

/** The eight menus in menu-bar order, with check marks and enabled states taken from `state`. */
export function buildMenus(state: MenuState): MenuModel[] {
  return [
    {
      id: "hex",
      label: "Hex",
      entries: [
        item("hex.about", "About HexCard"),
        SEPARATOR,
        ...THEME_NAMES.map((name) => item(`theme:${name}`, name, { checked: state.themeName === name })),
      ],
    },
    {
      id: "file",
      label: "File",
      entries: [
        item("file.openShowcase", "Open Showcase Stack"),
        SEPARATOR,
        item("file.openStackFile", "Open Stack File"),
        item("file.saveStackFile", "Save Stack File"),
        SEPARATOR,
        item("file.copyShareLink", "Copy Share Link"),
        item("file.exportHtml", "Export Standalone HTML"),
      ],
    },
    {
      id: "edit",
      label: "Edit",
      entries: [
        item("edit.undo", state.undoLabel ? `Undo ${state.undoLabel}` : "Undo", { disabled: !state.canUndo }),
        item("edit.redo", state.redoLabel ? `Redo ${state.redoLabel}` : "Redo", { disabled: !state.canRedo }),
        SEPARATOR,
        item("edit.background", "Edit Background", { shortcut: "Ctrl+B", checked: state.editLayer === "background" }),
      ],
    },
    {
      id: "go",
      label: "Go",
      entries: [
        item("go.first", "First"),
        item("go.previous", "Prev"),
        item("go.next", "Next"),
        item("go.last", "Last"),
        SEPARATOR,
        item("go.stackGraph", "Stack Graph"),
      ],
    },
    {
      id: "tools",
      label: "Tools",
      entries: TOOLS.map((tool) => item(`tool:${tool.id}`, tool.label, { checked: state.tool === tool.id })),
    },
    {
      id: "objects",
      label: "Objects",
      entries: [item("objects.newButton", "New Button"), item("objects.newField", "New Field"), SEPARATOR, item("objects.objectInfo", "Object Info")],
    },
    {
      id: "paint",
      label: "Paint",
      entries: [item("paint.togglePalette", state.paletteVisible ? "Hide Tools Palette" : "Show Tools Palette")],
    },
    {
      id: "ai",
      label: "AI Conjure",
      entries: [item("ai.conjure", "Conjure Script")],
    },
  ];
}

// ---------------------------------------------------------------------------------------------
// Keyboard and gesture helpers
// ---------------------------------------------------------------------------------------------

/** Cmd+B / Ctrl+B (Requirement 2.2). */
export function isEditBackgroundShortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean }): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "b";
}

/** Pixels the pointer must travel below the menu bar before the Tools menu detaches. */
export const TEAR_OFF_DISTANCE = 8;

/** Requirement 2.3: the pointer has been dragged below the menu bar. */
export function shouldTearOff(pointerY: number, menuBarBottom: number): boolean {
  return pointerY > menuBarBottom + TEAR_OFF_DISTANCE;
}

const DEFAULT_PALETTE_POSITION: Point = { x: 16, y: MENU_BAR_HEIGHT + 16 };
/** Where the pointer sits on the palette's title bar right after tear-off. */
const TEAR_OFF_GRAB: Point = { x: 40, y: 8 };

// ---------------------------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------------------------

export interface System7ShellProps {
  store: UiStore;
  history: ShellHistory;
  modals: ModalManager;
  /** Index into `PATTERNS`; owned by the composition root so the paint controller can read it. */
  patternIndex: number;
  onPatternChange: (index: number) => void;
  /** Receives menu commands implemented outside the shell. */
  onCommand?: (command: ForwardedCommand) => void;
  /** The card area. */
  children?: ReactNode;
}

function isTool(value: string): value is AuthoringTool {
  return TOOLS.some((tool) => tool.id === value);
}

function isTheme(value: string): value is ThemePaletteName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/** Diagonal hash stripes along the menu bar border: an 8x8 tile with a 2 px thick diagonal. */
function EditBackgroundStripes() {
  const patternId = useId();
  let path = "";
  for (let y = 0; y < 8; y++) path += `M${y} ${y}h1v1h-1zM${(y + 1) % 8} ${y}h1v1h-1z`;
  return (
    <svg className="s7-stripes" width="100%" height={8} shapeRendering="crispEdges" aria-hidden="true" focusable="false" data-testid="edit-background-stripes">
      <defs>
        <pattern id={patternId} width={8} height={8} patternUnits="userSpaceOnUse">
          <path d={path} fill="var(--dark-bit)" />
        </pattern>
      </defs>
      <rect width="100%" height={8} fill={`url(#${patternId})`} />
    </svg>
  );
}

export function System7Shell({ store, history, modals, patternIndex, onPatternChange, onCommand, children }: System7ShellProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const modalQueue = useSyncExternalStore(modals.subscribe, modals.getSnapshot, modals.getSnapshot);
  const modalOpen = modalQueue.length > 0;

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [paletteVisible, setPaletteVisible] = useState(false);
  const [palettePosition, setPalettePosition] = useState<Point>(DEFAULT_PALETTE_POSITION);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const stopGesture = useRef<(() => void) | null>(null);
  const suppressClick = useRef(false);

  const palette = state.stack.themePalette;
  const editBackground = state.editLayer === "background";

  const toggleEditBackground = (): void => store.setEditLayer(store.getSnapshot().editLayer === "background" ? "card" : "background");

  // Requirement 2.2: Cmd+B / Ctrl+B toggles Edit Background (not while a dialog is open).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (modalOpen || !isEditBackgroundShortcut(event)) return;
      event.preventDefault();
      toggleEditBackground();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen, store]);

  // Close an open menu on an outside press or Escape.
  useEffect(() => {
    if (openMenu === null) return;
    const onPointerDown = (event: PointerEvent): void => {
      if (!menuBarRef.current?.contains(event.target as Node)) setOpenMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => () => stopGesture.current?.(), []);

  const runCommand = (command: ShellCommand): void => {
    setOpenMenu(null);
    if (command.startsWith("tool:")) {
      const tool = command.slice("tool:".length);
      if (isTool(tool)) store.setTool(tool);
    } else if (command.startsWith("theme:")) {
      const theme = command.slice("theme:".length);
      if (isTheme(theme)) history.execute(createThemeCommand(theme));
    } else if (command === "edit.undo") {
      history.undo();
    } else if (command === "edit.redo") {
      history.redo();
    } else if (command === "edit.background") {
      toggleEditBackground();
    } else if (command === "paint.togglePalette") {
      setPaletteVisible((visible) => !visible);
    } else if (command === "hex.about") {
      void modals.alert("HexCard 2.0.0\nA resurrection of HyperCard (1987).");
    } else {
      onCommand?.(command as ForwardedCommand);
    }
  };

  /** Requirement 2.3: press on the Tools header and drag below the menu bar to detach the palette. */
  const onToolsPointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    suppressClick.current = false;
    stopGesture.current?.();
    let stopFollowing: (() => void) | null = null;
    let torn = false;
    const watch = (e: PointerEvent): void => {
      const bottom = menuBarRef.current?.getBoundingClientRect().bottom ?? MENU_BAR_HEIGHT;
      if (torn || !shouldTearOff(e.clientY, bottom)) return;
      torn = true;
      suppressClick.current = true;
      setOpenMenu(null);
      setPaletteVisible(true);
      const clamp = (p: Point): Point => clampPaletteOrigin(p, { width: window.innerWidth, height: window.innerHeight });
      const origin = clamp({ x: e.clientX - TEAR_OFF_GRAB.x, y: e.clientY - TEAR_OFF_GRAB.y });
      setPalettePosition(origin);
      stopFollowing = beginPointerDrag({ x: e.clientX, y: e.clientY }, origin, (next) => setPalettePosition(clamp(next)));
    };
    const finish = (): void => {
      window.removeEventListener("pointermove", watch);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      stopFollowing?.();
      stopGesture.current = null;
    };
    window.addEventListener("pointermove", watch);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
    stopGesture.current = finish;
  };

  const menus = buildMenus({
    tool: state.tool,
    editLayer: state.editLayer,
    themeName: palette.name,
    canUndo: history.canUndo(),
    canRedo: history.canRedo(),
    undoLabel: history.undoLabel(),
    redoLabel: history.redoLabel(),
    paletteVisible,
  });

  return (
    <div
      className="s7-shell"
      data-theme={palette.name}
      data-edit-background={editBackground ? "true" : "false"}
      style={themeCssVariables(palette)}
    >
      <div ref={menuBarRef} className="s7-menubar" role="menubar" aria-label="Menu bar">
        {menus.map((menu) => {
          const open = openMenu === menu.id;
          return (
            <div key={menu.id} className="s7-menu">
              <button
                type="button"
                className={open ? "s7-menu-title s7-menu-title-open" : "s7-menu-title"}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={open}
                onPointerDown={menu.id === "tools" ? onToolsPointerDown : undefined}
                onPointerEnter={() => {
                  if (openMenu !== null && openMenu !== menu.id) setOpenMenu(menu.id);
                }}
                onClick={() => {
                  if (suppressClick.current) {
                    suppressClick.current = false;
                    return;
                  }
                  setOpenMenu(open ? null : menu.id);
                }}
              >
                {menu.label}
              </button>
              {open ? (
                <div className="s7-dropdown" role="menu" aria-label={menu.label}>
                  {menu.id === "tools" ? <div className="s7-tear-strip" aria-hidden="true" /> : null}
                  {menu.entries.map((entry, index) =>
                    entry.kind === "separator" ? (
                      <div key={index} className="s7-separator" role="separator" />
                    ) : (
                      <button
                        key={index}
                        type="button"
                        className="s7-menu-item"
                        role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                        aria-checked={entry.checked}
                        disabled={entry.disabled}
                        onClick={() => runCommand(entry.command)}
                      >
                        <span className="s7-check" aria-hidden="true">
                          {entry.checked ? "\u2713" : ""}
                        </span>
                        <span className="s7-menu-label">{entry.label}</span>
                        <span className="s7-shortcut">{entry.shortcut ?? ""}</span>
                      </button>
                    ),
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
        {editBackground ? <EditBackgroundStripes /> : null}
      </div>
      <main className="s7-desktop">{children}</main>
      {paletteVisible ? (
        <FloatingTools
          store={store}
          patternIndex={patternIndex}
          onPatternChange={onPatternChange}
          position={palettePosition}
          onPositionChange={setPalettePosition}
          onClose={() => setPaletteVisible(false)}
        />
      ) : null}
      <ModalLayer modals={modals} />
    </div>
  );
}
