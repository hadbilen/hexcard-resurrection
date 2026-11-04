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
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
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
  PixelIcon,
  TOOLS,
  beginPointerDrag,
  clampPaletteOrigin,
  computeUiScale,
  menuBarHeight,
  pixelRowsToPath,
  type Point,
} from "./FloatingTools.tsx";
import "./system7.css";

// ---------------------------------------------------------------------------------------------
// UI scale (Requirement 2.10)
// ---------------------------------------------------------------------------------------------

/**
 * The integer UI scale factor k of the studio (Requirement 2.10), provided by `System7Shell` to
 * everything it renders, including its `children` (the card viewport).
 *
 * Contract for consumers:
 * - Read it with `useUiScale()` inside the shell's subtree. Outside a shell it is 1.
 * - k is an integer >= 1, computed by `computeUiScale(window.innerWidth, window.innerHeight)`:
 *   the card at 512k x 342k CSS pixels, a card frame of `CARD_FRAME_WIDTH * k` (FloatingTools.tsx)
 *   on every side and the 20k menu bar fit in the window. It is recomputed on window `resize`,
 *   and consumers re-render when it changes.
 * - The card viewport draws the card at exactly 512k x 342k CSS pixels with this k, so the menu
 *   bar, menus, dialogs, tools palette and card share one scale. It must not derive its own scale.
 *   It draws its frame, `CARD_FRAME_WIDTH * k` wide, inside the space k reserves around the card,
 *   so the frame is never clipped, not even when the card exactly fills the desktop.
 * - In CSS the same value is available on `.s7-shell` and below as `--k` (unitless), `--px`
 *   (`k` CSS pixels, one 1x pixel) and `--menubar-height` (20k px).
 */
export const UiScaleContext = createContext<number>(1);

/** The UI scale k of the enclosing shell (see `UiScaleContext`). */
export function useUiScale(): number {
  return useContext(UiScaleContext);
}

/** CSS custom properties of UI scale `k`; system7.css sizes every shell metric from `--px`. */
export function uiScaleCssVariables(k: number): CSSProperties {
  return { "--k": String(k), "--px": `${k}px`, "--menubar-height": `${menuBarHeight(k)}px` } as CSSProperties;
}

function subscribeToResize(listener: () => void): () => void {
  window.addEventListener("resize", listener);
  return () => window.removeEventListener("resize", listener);
}

const readViewportScale = (): number => computeUiScale(window.innerWidth, window.innerHeight);
/** Server rendering (and tests in Node) have no window: 1x. */
const serverViewportScale = (): number => 1;

/** k for the current window, re-read on every `resize` (a number, so equal values do not re-render). */
export function useViewportScale(): number {
  return useSyncExternalStore(subscribeToResize, readViewportScale, serverViewportScale);
}

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

// ---------------------------------------------------------------------------------------------
// 1-bit pixel art for the chrome (steering tech.md, 1-Bit Fidelity Rules 6)
// ---------------------------------------------------------------------------------------------

/**
 * Menu check mark, 16x16 at 1x, sitting on the text baseline (row 13) like a glyph. The bundled
 * fonts have no U+2713, and a fallback system font would draw it with anti-aliasing.
 */
export const CHECK_MARK: readonly string[] = [
  "................",
  "................",
  "................",
  "................",
  "................",
  "................",
  "...........##...",
  "..........##....",
  ".........##.....",
  "...##...##......",
  "....##.##.......",
  ".....###........",
  "......#.........",
  "................",
  "................",
  "................",
];

/** Push button height at 1x (System 7 dialog buttons are 20 px high). */
export const PUSH_BUTTON_HEIGHT = 20;
/** Horizontal label padding and minimum width of a push button at 1x. */
export const PUSH_BUTTON_PADDING = 12;
export const PUSH_BUTTON_MIN_WIDTH = 64;
/** The default button ring: 3 px thick, drawn around the button rect outset by 4 px at 1x. */
export const DEFAULT_RING_OUTSET = 4;

/**
 * Top-left corner of a push button: QuickDraw `FrameRoundRect` with an 8x8 oval.
 * `#` = frame (dark), `+` = face (light, dark while pressed), `.` = outside (not drawn).
 */
export const PUSH_BUTTON_CORNER: readonly string[] = [
  "..##",
  ".#++",
  "#+++",
  "#+++",
];

/**
 * Top-left corner of the default button ring: `PenSize(3, 3)` and `FrameRoundRect` with a 16x16
 * oval around the button rect outset by 4, as in Inside Macintosh. `#` = ring, `.` = not drawn.
 */
export const DEFAULT_RING_CORNER: readonly string[] = [
  ".....###",
  "...#####",
  "..######",
  ".#####..",
  ".###....",
  "####....",
  "###.....",
  "###.....",
];

const mirrorRows = (rows: readonly string[]): string[] => rows.map((row) => [...row].reverse().join(""));

/** A full-height cap: the corner, the straight side repeated, and the corner flipped vertically. */
function capRows(corner: readonly string[], height: number): string[] {
  const side = corner[corner.length - 1];
  return [...corner, ...Array<string>(height - 2 * corner.length).fill(side), ...[...corner].reverse()];
}

/** Left and right caps of a push button (4x20) and of the default ring (8x28), at 1x. */
export const PUSH_BUTTON_LEFT_CAP: readonly string[] = capRows(PUSH_BUTTON_CORNER, PUSH_BUTTON_HEIGHT);
export const PUSH_BUTTON_RIGHT_CAP: readonly string[] = mirrorRows(PUSH_BUTTON_LEFT_CAP);
export const DEFAULT_RING_LEFT_CAP: readonly string[] = capRows(DEFAULT_RING_CORNER, PUSH_BUTTON_HEIGHT + 2 * DEFAULT_RING_OUTSET);
export const DEFAULT_RING_RIGHT_CAP: readonly string[] = mirrorRows(DEFAULT_RING_LEFT_CAP);

/** Pixel art with a frame (`#`, dark) and a face (`+`), on a 1x grid enlarged k times. */
function PixelArt({ rows, scale }: { rows: readonly string[]; scale: number }) {
  const width = rows[0].length;
  const height = rows.length;
  const face = pixelRowsToPath(rows, "+");
  return (
    <svg
      className="s7-pixel-art"
      width={width * scale}
      height={height * scale}
      viewBox={`0 0 ${width} ${height}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      {face ? <path className="s7-art-face" d={face} /> : null}
      <path className="s7-art-frame" d={pixelRowsToPath(rows)} />
    </svg>
  );
}

/**
 * The System 7 rounded push button frame (and the default ring), drawn under the label of a
 * `.s7-button`. It must follow the label text node, so the label stays the button's first child.
 */
export function PushButtonArt({ isDefault }: { isDefault: boolean }) {
  const k = useUiScale();
  return (
    <>
      <span className="s7-button-art" aria-hidden="true">
        <PixelArt rows={PUSH_BUTTON_LEFT_CAP} scale={k} />
        <span className="s7-button-edge" />
        <PixelArt rows={PUSH_BUTTON_RIGHT_CAP} scale={k} />
      </span>
      {isDefault ? (
        <span className="s7-button-ring" aria-hidden="true">
          <PixelArt rows={DEFAULT_RING_LEFT_CAP} scale={k} />
          <span className="s7-button-edge" />
          <PixelArt rows={DEFAULT_RING_RIGHT_CAP} scale={k} />
        </span>
      ) : null}
    </>
  );
}

/**
 * Left and right padding (CSS px) that centre a label of `textWidth` CSS px in a push button at
 * UI scale k, rounded down to whole 1x pixels, as QuickDraw centres button titles. CSS
 * `text-align: center` would put an odd leftover half a CSS pixel off the grid, and Chrome draws
 * text at a half-pixel x with grey anti-aliasing.
 */
export function pushButtonLabelPadding(textWidth: number, k: number): { left: number; right: number } {
  const width = Math.ceil(textWidth);
  const free = Math.max((PUSH_BUTTON_MIN_WIDTH - 2 * PUSH_BUTTON_PADDING) * k - width, 0);
  const half = Math.floor(free / (2 * k)) * k;
  return { left: PUSH_BUTTON_PADDING * k + half, right: PUSH_BUTTON_PADDING * k + free - half };
}

/** Offset (CSS px) that moves a box whose edge is at `position` onto the k-pixel grid. */
export function gridSnapOffset(position: number, k: number): number {
  return Math.floor(position / k) * k - position;
}

/**
 * Puts all dialog text on whole pixels after layout: centres each push button label with
 * `pushButtonLabelPadding`, then moves the (flex-centred) dialog onto the k-pixel grid.
 */
function snapModalLayout(dialog: HTMLElement, k: number): void {
  for (const button of dialog.querySelectorAll<HTMLButtonElement>(".s7-button")) {
    const label = button.firstChild;
    if (!(label instanceof Text)) continue;
    const range = document.createRange();
    range.selectNodeContents(label);
    const { left, right } = pushButtonLabelPadding(range.getBoundingClientRect().width, k);
    button.style.paddingLeft = `${left}px`;
    button.style.paddingRight = `${right}px`;
  }
  dialog.style.left = "0px";
  dialog.style.top = "0px";
  const box = dialog.getBoundingClientRect();
  dialog.style.left = `${gridSnapOffset(box.left, k)}px`;
  dialog.style.top = `${gridSnapOffset(box.top, k)}px`;
}

function focusables(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>("button, input")].filter((element) => !element.hasAttribute("disabled"));
}

function ModalDialog({ request, modals }: { request: ModalRequest; modals: ModalManager }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const defaultButtonRef = useRef<HTMLButtonElement>(null);
  const [text, setText] = useState(request.kind === "ask" ? request.defaultAnswer : "");
  const titleId = useId();
  const k = useUiScale();

  useEffect(() => {
    if (request.kind === "ask") inputRef.current?.select();
    else defaultButtonRef.current?.focus();
  }, [request.kind]);

  // Before the first paint and after every resize: labels and the dialog on whole pixels.
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const snap = (): void => snapModalLayout(dialog, k);
    snap();
    window.addEventListener("resize", snap);
    return () => window.removeEventListener("resize", snap);
  }, [k]);

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
            <PixelIcon rows={BOMB_ICON} scale={2 * k} />
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
                  <PushButtonArt isDefault={false} />
                </button>
                <button type="button" className="s7-button s7-button-default" onClick={() => modals.settle(request.id, text)}>
                  OK
                  <PushButtonArt isDefault />
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
                    <PushButtonArt isDefault={isDefault} />
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

/** Pixels (at 1x) the pointer must travel below the menu bar before the Tools menu detaches. */
export const TEAR_OFF_DISTANCE = 8;

/** Client y (CSS px) the pointer must pass to tear off the Tools menu at UI scale k: 20k + 8k. */
export function tearOffThreshold(scale: number): number {
  return menuBarHeight(scale) + TEAR_OFF_DISTANCE * scale;
}

/** Requirement 2.3: the pointer has been dragged below the menu bar (at UI scale `scale`). */
export function shouldTearOff(pointerY: number, scale: number): boolean {
  return pointerY > tearOffThreshold(scale);
}

/** Where the palette first appears at UI scale k: 16k from the left, 16k below the menu bar. */
export function defaultPalettePosition(scale: number): Point {
  return { x: 16 * scale, y: menuBarHeight(scale) + 16 * scale };
}

/** Where the pointer sits on the palette's title bar right after tear-off (at 1x). */
const TEAR_OFF_GRAB: Point = { x: 40, y: 6 };

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
  /** The card area. Reads the shared UI scale with `useUiScale()`. */
  children?: ReactNode;
  /** Fixed UI scale k instead of the one computed from the window (tests, embedding). */
  scale?: number;
}

function isTool(value: string): value is AuthoringTool {
  return TOOLS.some((tool) => tool.id === value);
}

function isTheme(value: string): value is ThemePaletteName {
  return (THEME_NAMES as readonly string[]).includes(value);
}

/**
 * Diagonal hash stripes along the menu bar border: an 8x8 tile (at 1x) with a 2 px thick
 * diagonal, enlarged k times with `patternTransform` so every stripe pixel is a k x k block.
 */
function EditBackgroundStripes() {
  const patternId = useId();
  const k = useUiScale();
  let path = "";
  for (let y = 0; y < 8; y++) path += `M${y} ${y}h1v1h-1zM${(y + 1) % 8} ${y}h1v1h-1z`;
  return (
    <svg className="s7-stripes" width="100%" height={8 * k} shapeRendering="crispEdges" aria-hidden="true" focusable="false" data-testid="edit-background-stripes">
      <defs>
        <pattern id={patternId} width={8} height={8} patternUnits="userSpaceOnUse" patternTransform={`scale(${k})`}>
          <path d={path} fill="var(--dark-bit)" />
        </pattern>
      </defs>
      <rect width="100%" height={8 * k} fill={`url(#${patternId})`} />
    </svg>
  );
}

/**
 * The tear-off line at the top of the Tools menu: one 1x row of alternating dark and light
 * pixels (a 2x1 tile enlarged k times), in currentColor.
 */
function TearOffStrip() {
  const patternId = useId();
  const k = useUiScale();
  return (
    <div className="s7-tear-strip" aria-hidden="true">
      <svg className="s7-tear-strip-art" width="100%" height={k} shapeRendering="crispEdges" focusable="false" data-testid="tear-off-pattern">
        <defs>
          <pattern id={patternId} width={2} height={1} patternUnits="userSpaceOnUse" patternTransform={`scale(${k})`}>
            <rect width={1} height={1} fill="currentColor" />
          </pattern>
        </defs>
        <rect width="100%" height={k} fill={`url(#${patternId})`} />
      </svg>
    </div>
  );
}

/** An open menu: its items, check marks drawn as pixel art, and the tear-off line for Tools. */
export function MenuDropdown({ menu, onRun }: { menu: MenuModel; onRun: (command: ShellCommand) => void }) {
  const k = useUiScale();
  return (
    <div className="s7-dropdown" role="menu" aria-label={menu.label}>
      {menu.id === "tools" ? <TearOffStrip /> : null}
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
            onClick={() => onRun(entry.command)}
          >
            <span className="s7-check" aria-hidden="true">
              {entry.checked ? <PixelIcon rows={CHECK_MARK} scale={k} /> : null}
            </span>
            <span className="s7-menu-label">{entry.label}</span>
            <span className="s7-shortcut">{entry.shortcut ?? ""}</span>
          </button>
        ),
      )}
    </div>
  );
}

/**
 * Keeps menu titles from taking focus on a pointer press (System 7 menus never take focus), so
 * a title can only be focused, and shown inverted through `:focus-visible`, from the keyboard.
 */
const keepFocusOnPointerPress = (event: { preventDefault(): void }): void => event.preventDefault();

export function System7Shell({ store, history, modals, patternIndex, onPatternChange, onCommand, children, scale }: System7ShellProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const modalQueue = useSyncExternalStore(modals.subscribe, modals.getSnapshot, modals.getSnapshot);
  const modalOpen = modalQueue.length > 0;
  const viewportScale = useViewportScale();
  const k = scale ?? viewportScale;
  const scaleRef = useRef(k);
  scaleRef.current = k;

  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [paletteVisible, setPaletteVisible] = useState(false);
  /** `null` until the palette is first placed: it then opens at `defaultPalettePosition(k)`. */
  const [placedPalette, setPalettePosition] = useState<Point | null>(null);
  const palettePosition = placedPalette ?? defaultPalettePosition(k);
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

  // A new UI scale (window resize) moves a placed palette back where its title bar is reachable.
  useEffect(() => {
    setPalettePosition((placed) =>
      placed === null ? null : clampPaletteOrigin(placed, { width: window.innerWidth, height: window.innerHeight }, k),
    );
  }, [k]);

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
      const s = scaleRef.current;
      if (torn || !shouldTearOff(e.clientY, s)) return;
      torn = true;
      suppressClick.current = true;
      setOpenMenu(null);
      setPaletteVisible(true);
      const clamp = (p: Point): Point => clampPaletteOrigin(p, { width: window.innerWidth, height: window.innerHeight }, scaleRef.current);
      const origin = clamp({ x: e.clientX - TEAR_OFF_GRAB.x * s, y: e.clientY - TEAR_OFF_GRAB.y * s });
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
    <UiScaleContext value={k}>
    <div
      className="s7-shell"
      data-theme={palette.name}
      data-edit-background={editBackground ? "true" : "false"}
      data-ui-scale={k}
      style={{ ...themeCssVariables(palette), ...uiScaleCssVariables(k) }}
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
                onMouseDown={keepFocusOnPointerPress}
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
              {open ? <MenuDropdown menu={menu} onRun={runCommand} /> : null}
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
          scale={k}
        />
      ) : null}
      <ModalLayer modals={modals} />
    </div>
    </UiScaleContext>
  );
}
