/**
 * Edit > Icon Editor (spec 06 task 3.2, Requirement 10). A studio window with the list of the
 * stack's icons and HexCard's built-in icons, a 32 x 32 editing grid of FatBits cells and the
 * buttons New, Duplicate, Rename..., Delete, Add to Stack, Use for Button, No Icon and Undo.
 * Design: .kiro/specs/06-hypercard-classics/design.md §IconEditor.tsx.
 *
 * - Every change is an icon command (`src/core/icons.ts`) run through `history.execute`. The
 *   window reads the stack with `useSyncExternalStore`, so Undo and Redo keep the list and the grid
 *   in step (Requirement 10.10).
 * - A press on the grid starts a stroke on a local working copy that is shown live; the release
 *   applies it as one `Edit Icon` command (Requirement 10.3). Built-in icons are read-only.
 * - Everything is drawn in the stack theme's two colours: canvases with `putImageData`, text with
 *   the bundled fonts (printable ASCII only).
 */
import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from "react";
import type { HexHistory } from "../core/history.ts";
import {
  ICON_SIZE,
  createButtonIconCommand,
  createCopyIconCommand,
  createDeleteIconCommand,
  createEditIconCommand,
  createNewIconCommand,
  createRenameIconCommand,
  decodeIcon,
  encodeIcon,
  freeIconName,
  iconNameError,
  type IconCommand,
} from "../core/icons.ts";
import type { HexButtonPart, HexStack } from "../core/schema.ts";
import type { HexRuntimeState } from "../core/store.ts";
import { packOpaqueColour } from "../engine/graphics/bitmapCanvas.ts";
import { FATBITS_CELL, drawFatCell } from "../engine/graphics/fatBits.ts";
import { BUILT_IN_ICONS } from "../presets/builtInIcons.ts";
import { PushButtonArt, System7Window, useUiScale, type ModalManager, type UiStore } from "./System7Shell.tsx";

export interface IconEditorProps {
  store: Pick<UiStore, "subscribe" | "getSnapshot">;
  history: Pick<HexHistory, "execute" | "undo" | "canUndo">;
  modals: Pick<ModalManager, "ask" | "alert">;
  onClose: () => void;
}

export type IconChoice = { kind: "stack"; name: string } | { kind: "builtIn"; name: string };

/** Window size at 1x (design §IconEditor.tsx); the grid is 32 cells of 8 pixels. */
export const ICON_EDITOR_WIDTH = 472;
export const ICON_EDITOR_HEIGHT = 320;
export const ICON_GRID_SIZE = ICON_SIZE * FATBITS_CELL; // 256

export const ICON_EDITOR_TITLE = "Icon Editor";
export const BUILT_IN_HEADING = "HexCard icons";

/** Button labels in layout order (Requirement 10). */
export const ICON_EDITOR_BUTTONS = [
  "New", "Duplicate", "Rename...", "Delete", "Add to Stack", "Use for Button", "No Icon", "Undo",
] as const;
export type IconEditorButton = (typeof ICON_EDITOR_BUTTONS)[number];

// ---------------------------------------------------------------------------------------------
// Pure rules (Node-testable)
// ---------------------------------------------------------------------------------------------

function partById(stack: HexStack, partId: string): HexButtonPart | undefined {
  for (const owner of [...stack.backgrounds, ...stack.cards]) {
    const part = owner.parts.find((candidate) => candidate.id === partId);
    if (part) return part.type === "button" ? part : undefined;
  }
  return undefined;
}

/** The selected part when it is a button (the store only allows that with the Button tool). */
export function selectedButton(state: HexRuntimeState): HexButtonPart | undefined {
  return state.selectedPartId === null ? undefined : partById(state.stack, state.selectedPartId);
}

/** Requirement 10.2: the selected button's icon, else the first stack icon, else the first built-in icon. */
export function initialIconChoice(state: HexRuntimeState): IconChoice {
  const { customIcons } = state.stack;
  const iconId = selectedButton(state)?.iconId;
  if (iconId !== undefined && Object.hasOwn(customIcons, iconId)) return { kind: "stack", name: iconId };
  const first = Object.keys(customIcons)[0];
  if (first !== undefined) return { kind: "stack", name: first };
  return { kind: "builtIn", name: BUILT_IN_ICONS[0].name };
}

/** The choice when it still names an icon, else `initialIconChoice` (Requirement 10.10). */
export function validIconChoice(state: HexRuntimeState, choice: IconChoice | null): IconChoice {
  if (choice?.kind === "stack" && Object.hasOwn(state.stack.customIcons, choice.name)) return choice;
  if (choice?.kind === "builtIn" && BUILT_IN_ICONS.some((icon) => icon.name === choice.name)) return choice;
  return initialIconChoice(state);
}

/** Requirements 10.9, 10.11, 10.12: which buttons are enabled. `choice` null means no icon is selected. */
export function iconEditorEnabled(
  state: HexRuntimeState,
  choice: IconChoice | null,
  canUndo: boolean,
): Record<IconEditorButton, boolean> {
  const button = selectedButton(state);
  const stackIcon = choice?.kind === "stack";
  const builtIn = choice?.kind === "builtIn";
  return {
    New: true,
    Duplicate: choice !== null,
    "Rename...": stackIcon,
    Delete: stackIcon,
    "Add to Stack": builtIn,
    // A built-in icon is always copied into the stack, so setting it always changes something.
    "Use for Button": button !== undefined && choice !== null && (builtIn || button.iconId !== choice.name),
    "No Icon": button !== undefined && button.iconId !== undefined,
    Undo: canUndo,
  };
}

/** The icon data of a choice, or undefined when it does not exist. */
export function iconDataOf(stack: HexStack, choice: IconChoice): string | undefined {
  if (choice.kind === "stack") return Object.hasOwn(stack.customIcons, choice.name) ? stack.customIcons[choice.name] : undefined;
  return BUILT_IN_ICONS.find((icon) => icon.name === choice.name)?.data;
}

/**
 * Requirement 10.9: the command of **Use for Button**. A built-in icon is copied into
 * `customIcons` first, under `freeIconName`, and that name is set.
 */
export function createUseIconCommand(stack: HexStack, partId: string, choice: IconChoice): IconCommand {
  if (choice.kind === "stack") return createButtonIconCommand(stack, partId, choice.name);
  const data = iconDataOf(stack, choice);
  if (data === undefined) throw new RangeError(`No built-in icon named "${choice.name}"`);
  const name = freeIconName(choice.name, Object.keys(stack.customIcons));
  return createButtonIconCommand(stack, partId, name, { name, data });
}

/**
 * Requirement 10.3: the cells on the straight line from cell `from` to cell `to` (Bresenham over
 * cell coordinates), both ends included, in order from `from` to `to`. Cells are row-major indexes
 * 0..1023 (`y * 32 + x`). A pointer that moves faster than the pointer events arrive jumps over
 * cells; painting this line leaves none of them out.
 */
export function cellLine(from: number, to: number): number[] {
  let x = from % ICON_SIZE;
  let y = Math.floor(from / ICON_SIZE);
  const x1 = to % ICON_SIZE;
  const y1 = Math.floor(to / ICON_SIZE);
  const dx = Math.abs(x1 - x);
  const dy = -Math.abs(y1 - y);
  const sx = x < x1 ? 1 : -1;
  const sy = y < y1 ? 1 : -1;
  let error = dx + dy;
  const cells: number[] = [];
  for (;;) {
    cells.push(y * ICON_SIZE + x);
    if (x === x1 && y === y1) return cells;
    const doubled = 2 * error;
    if (doubled >= dy) {
      error += dy;
      x += sx;
    }
    if (doubled <= dx) {
      error += dx;
      y += sy;
    }
  }
}

/**
 * The `scrollTop` that shows a list row completely, changing it as little as possible: the current
 * value when the row is already inside, else the row's top (row above the view) or the value that
 * puts the row's bottom edge at the view's bottom edge. `rowTop` is measured from the top of the
 * list's scrollable content; the browser clamps the result to the scroll range.
 */
export function scrollTopToShowRow(scrollTop: number, viewHeight: number, rowTop: number, rowHeight: number): number {
  if (rowTop < scrollTop) return Math.max(0, Math.floor(rowTop));
  if (rowTop + rowHeight > scrollTop + viewHeight) return Math.max(0, Math.ceil(rowTop + rowHeight - viewHeight));
  return scrollTop;
}

// ---------------------------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------------------------

type Palette = HexStack["themePalette"];

/** Draws a state frame (1 = light, 2 = dark) of `width` x `height` pixels into a canvas. */
function putFrame(canvas: HTMLCanvasElement | null, frame: Uint8Array, width: number, height: number, palette: Palette): void {
  const ctx = canvas?.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(width, height);
  const out = new Uint32Array(image.data.buffer);
  const dark = packOpaqueColour(palette.darkBitHex);
  const light = packOpaqueColour(palette.lightBitHex);
  for (let i = 0; i < frame.length; i++) out[i] = frame[i] === 2 ? dark : light;
  ctx.putImageData(image, 0, 0);
}

/** A 32 x 32 preview: dark bits dark, clear bits light. */
function IconPreview({ data, palette }: { data: string; palette: Palette }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const k = useUiScale();
  useEffect(() => {
    const bits = decodeIcon(data);
    const frame = new Uint8Array(bits.length);
    for (let i = 0; i < bits.length; i++) frame[i] = bits[i] === 1 ? 2 : 1;
    putFrame(canvasRef.current, frame, ICON_SIZE, ICON_SIZE, palette);
  }, [data, palette.darkBitHex, palette.lightBitHex]);
  return (
    <canvas
      ref={canvasRef}
      className="s7-icon-preview"
      width={ICON_SIZE}
      height={ICON_SIZE}
      style={{ width: ICON_SIZE * k, height: ICON_SIZE * k }}
      aria-hidden="true"
    />
  );
}

/** The 256 x 256 editing grid. `bits` has 1024 entries (1 = dark). */
function drawGrid(canvas: HTMLCanvasElement | null, bits: Uint8Array, palette: Palette): void {
  const frame = new Uint8Array(ICON_GRID_SIZE * ICON_GRID_SIZE);
  for (let y = 0; y < ICON_SIZE; y++) {
    for (let x = 0; x < ICON_SIZE; x++) {
      drawFatCell(frame, ICON_GRID_SIZE, x * FATBITS_CELL, y * FATBITS_CELL, bits[y * ICON_SIZE + x] === 1);
    }
  }
  putFrame(canvas, frame, ICON_GRID_SIZE, ICON_GRID_SIZE, palette);
}

/** Disabled push buttons get the 50% checkerboard of light pixels, as disabled menu items do. */
function ButtonDim({ patternId }: { patternId: string }) {
  const k = useUiScale();
  return (
    <svg className="s7-dim" width="100%" height="100%" shapeRendering="crispEdges" aria-hidden="true" focusable="false">
      <defs>
        <pattern id={patternId} width={2} height={2} patternUnits="userSpaceOnUse" patternTransform={`scale(${k})`}>
          <path d="M0 0h1v1H0zM1 1h1v1H1z" fill="var(--light-bit)" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill={`url(#${patternId})`} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

interface Stroke {
  name: string;
  /** Icon data when the stroke began (the `before` of the command). */
  before: string;
  paint: 0 | 1;
  working: Uint8Array;
  /** The cell painted last; the next move paints the line from it (Requirement 10.3). */
  last: number;
}

const sameChoice = (a: IconChoice, b: IconChoice): boolean => a.kind === b.kind && a.name === b.name;

export function IconEditor({ store, history, modals, onClose }: IconEditorProps): ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const k = useUiScale();
  const { stack } = state;
  const [requested, setRequested] = useState<IconChoice | null>(() => initialIconChoice(store.getSnapshot()));
  const choice = validIconChoice(state, requested);
  const data = iconDataOf(stack, choice) ?? "";
  const enabled = iconEditorEnabled(state, choice, history.canUndo());
  const readOnly = choice.kind === "builtIn";

  // The working copy of a stroke in progress; null between strokes.
  const [working, setWorking] = useState<Uint8Array | null>(null);
  const stroke = useRef<Stroke | null>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const shown = working ?? (data === "" ? new Uint8Array(ICON_SIZE * ICON_SIZE) : decodeIcon(data));
  useEffect(() => {
    drawGrid(gridRef.current, shown, stack.themePalette);
  }, [shown, stack.themePalette.darkBitHex, stack.themePalette.lightBitHex]);

  // Keep the selected row fully visible whenever the choice changes (a click, a command's name, the
  // fallback after Undo or Delete) or the number of stack rows above the built-in ones changes.
  // Only the list's own scrollTop is set: scrollIntoView could also scroll the page.
  const listRef = useRef<HTMLUListElement>(null);
  const stackIconCount = Object.keys(stack.customIcons).length;
  useEffect(() => {
    const list = listRef.current;
    const selectedRow = list?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!list || !selectedRow) return;
    const rowTop = selectedRow.getBoundingClientRect().top - list.getBoundingClientRect().top - list.clientTop + list.scrollTop;
    const target = scrollTopToShowRow(list.scrollTop, list.clientHeight, rowTop, selectedRow.offsetHeight);
    if (target !== list.scrollTop) list.scrollTop = target;
  }, [choice.kind, choice.name, stackIconCount]);

  const run = (command: IconCommand): void => {
    // The choice follows the command's icon; a name the stack does not have yet is valid once applied.
    if (command.name !== undefined) setRequested({ kind: "stack", name: command.name });
    history.execute(command);
  };

  // ---- editing grid (Requirement 10.3) ----
  const cellAt = (event: ReactPointerEvent<HTMLCanvasElement>): number => {
    const canvas = event.currentTarget;
    const box = canvas.getBoundingClientRect();
    const cell = FATBITS_CELL * k;
    const clamp = (value: number): number => Math.max(0, Math.min(ICON_SIZE - 1, Math.floor(value / cell)));
    // The 1-px frame is a border of the canvas: cells start inside it.
    return clamp(event.clientY - box.top - canvas.clientTop) * ICON_SIZE + clamp(event.clientX - box.left - canvas.clientLeft);
  };
  /** Paints every cell on the line from the last painted cell to `index` (one state update). */
  const paintTo = (index: number): void => {
    const current = stroke.current;
    if (!current) return;
    const cells = cellLine(current.last, index);
    current.last = index;
    if (cells.every((cell) => current.working[cell] === current.paint)) return;
    const next = current.working.slice();
    for (const cell of cells) next[cell] = current.paint;
    current.working = next;
    setWorking(next);
  };
  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || readOnly || choice.kind !== "stack") return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const bits = decodeIcon(data);
    const index = cellAt(event);
    stroke.current = { name: choice.name, before: data, paint: bits[index] === 1 ? 0 : 1, working: bits, last: index };
    paintTo(index);
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (stroke.current) paintTo(cellAt(event));
  };
  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const current = stroke.current;
    if (!current) return;
    paintTo(cellAt(event));
    const finished = stroke.current;
    stroke.current = null;
    setWorking(null);
    if (!finished) return;
    const after = encodeIcon(finished.working);
    if (after !== finished.before) run(createEditIconCommand(finished.name, finished.before, after));
  };
  const onPointerCancel = (): void => {
    stroke.current = null;
    setWorking(null);
  };

  // ---- buttons (Requirements 10.4-10.9, 10.11) ----
  const rename = async (): Promise<void> => {
    if (choice.kind !== "stack") return;
    const answer = await modals.ask("Icon name:", choice.name);
    if (answer === "") return;
    const latest = store.getSnapshot();
    if (!Object.hasOwn(latest.stack.customIcons, choice.name)) return;
    const error = iconNameError(latest.stack, answer, choice.name);
    if (error !== undefined) {
      void modals.alert(error);
      return;
    }
    run(createRenameIconCommand(latest.stack, choice.name, answer));
  };
  const actions: Record<IconEditorButton, () => void> = {
    New: () => run(createNewIconCommand(stack)),
    Duplicate: () => run(createCopyIconCommand(stack, choice.name, data, "Duplicate Icon")),
    "Rename...": () => void rename(),
    Delete: () => {
      if (choice.kind === "stack") run(createDeleteIconCommand(stack, choice.name));
    },
    "Add to Stack": () => run(createCopyIconCommand(stack, choice.name, data, "Add Icon")),
    "Use for Button": () => {
      const button = selectedButton(state);
      if (button) run(createUseIconCommand(stack, button.id, choice));
    },
    "No Icon": () => {
      const button = selectedButton(state);
      if (button) run(createButtonIconCommand(stack, button.id, undefined));
    },
    Undo: () => void history.undo(),
  };

  const stackNames = Object.keys(stack.customIcons);
  const row = (rowChoice: IconChoice, rowData: string): ReactElement => {
    const selected = sameChoice(rowChoice, choice);
    return (
      <li key={`${rowChoice.kind}:${rowChoice.name}`} role="presentation">
        <button
          type="button"
          role="option"
          aria-selected={selected}
          className={selected ? "s7-icon-row s7-icon-row-selected" : "s7-icon-row"}
          onClick={() => setRequested(rowChoice)}
        >
          <IconPreview data={rowData} palette={stack.themePalette} />
          <span className="s7-icon-name">{rowChoice.name}</span>
        </button>
      </li>
    );
  };

  return (
    <System7Window
      title={ICON_EDITOR_TITLE}
      className="s7-icon-editor"
      style={{ width: ICON_EDITOR_WIDTH * k, height: ICON_EDITOR_HEIGHT * k }}
      onClose={onClose}
    >
      <div className="s7-icon-editor-main">
        <div className="s7-icon-left">
          <ul ref={listRef} className="s7-icon-list" role="listbox" aria-label="Icons">
            {stackNames.map((name) => row({ kind: "stack", name }, stack.customIcons[name]))}
            <li role="presentation" className="s7-icon-heading">{BUILT_IN_HEADING}</li>
            {BUILT_IN_ICONS.map((icon) => row({ kind: "builtIn", name: icon.name }, icon.data))}
          </ul>
          <div className="s7-icon-buttons">
            {ICON_EDITOR_BUTTONS.map((label) => (
              <button
                key={label}
                type="button"
                className="s7-button"
                disabled={!enabled[label]}
                onClick={actions[label]}
              >
                {label}
                <PushButtonArt isDefault={false} />
                {enabled[label] ? null : <ButtonDim patternId={`s7-icon-dim-${label.replace(/\W/g, "")}`} />}
              </button>
            ))}
          </div>
        </div>
        <div className="s7-icon-right">
          <canvas
            ref={gridRef}
            className="s7-icon-grid"
            width={ICON_GRID_SIZE}
            height={ICON_GRID_SIZE}
            style={{ width: ICON_GRID_SIZE * k, height: ICON_GRID_SIZE * k }}
            role="img"
            aria-label={`Icon ${choice.name}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
          />
          <p className="s7-icon-current">{readOnly ? `${choice.name} (built-in)` : choice.name}</p>
        </div>
      </div>
    </System7Window>
  );
}
