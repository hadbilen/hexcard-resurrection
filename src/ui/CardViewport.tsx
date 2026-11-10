/**
 * Card viewport: the single 512x342 card canvas, pointer mapping, Browse event forwarding,
 * hidden-textarea field editing, paint routing and authoring selection handles.
 * Requirements: spec 04 2.1, 2.5, 2.8, 2.9; spec 03 4.2. Design: .kiro/specs/04-ui-audio-showcase/design.md §1;
 * hexcard_design_spec.md §3 (message targets), §5.5 (hidden textarea), §5.6 (frame pipeline, DOM overlay).
 *
 * - Every frame is composed by spec 03 `composeFrame` and drawn with `putImageData`. Requirement
 *   2.10: the canvas is shown at 512k x 342k CSS pixels for the shell's UI scale k (`useUiScale()`),
 *   the same k as the menu bar, menus, dialogs and tools palette; the viewport never derives its
 *   own scale. The only DOM elements over it are the hidden textarea and the authoring selection
 *   marquee / handles, positioned and sized with the same k.
 * - Browse tool: pointer and keyboard events become message bus posts (`createBrowseInput`). A click
 *   in an enabled unlocked field opens it for editing: text goes through the hidden textarea and
 *   is written with `store.applyRuntime` (runtime mutation, not undoable).
 * - Paint tools: pointer events go to the spec 03 paint controller only.
 * - Button / field tools: select a part of the edit layer, move it or resize it from a corner
 *   handle; each drag is one `history.execute` command.
 * - The component never writes to the stack object; it receives the narrowed `UiStore`.
 */
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type { HexCommand, HexHistory } from "../core/history.ts";
import { isAbortShortcut, type BrowseClick, type MessageBus } from "../core/messageBus.ts";
import type { HexID, HexPart, HexRect, HexStack } from "../core/schema.ts";
import { readFieldText, resolveEditTarget, type HexLayer, type HexRuntimeState } from "../core/store.ts";
import { composeFrame, frameToImageData } from "../engine/graphics/bitmapCanvas.ts";
import { createPartRasterizer, fieldCaretIndexAt, hitTest, layoutFieldText } from "../engine/graphics/partRenderer.ts";
import { isPaintTool, type PaintController } from "../engine/graphics/paintTools.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, encodeBitmapRLE } from "../engine/graphics/rleCodec.ts";
import { CARD_FRAME_WIDTH } from "./FloatingTools.tsx";
import type { ImageFileLike } from "../engine/graphics/imageImport.ts";
import { gridSnapOffset, hasDraggedFiles, useUiScale, type FileDragLike, type UiStore } from "./System7Shell.tsx";
import type { EffectStage, MouseTracker } from "./vmHost.ts";
import {
  CONTINUOUS_MESSAGE_INTERVAL_MS,
  clientToCardPoint,
  createBrowseInput,
  editableField,
  fieldExitMessage,
  type CardPoint,
  type FieldEditTarget,
} from "./browseInput.ts";

// Pointer mapping, Browse-tool input and field-edit helpers live in browseInput.ts (React-free,
// shared with the standalone player); they are re-exported from here.
export {
  CONTINUOUS_MESSAGE_INTERVAL_MS,
  autoHiliteMutations,
  clientToCardPoint,
  createBrowseInput,
  editableField,
  fieldExitMessage,
  type BrowseInput,
  type BrowseInputOptions,
  type CardPoint,
  type FieldEditTarget,
} from "./browseInput.ts";

// ---------------------------------------------------------------------------------------------
// Part selection, move and resize (button / field tools)
// ---------------------------------------------------------------------------------------------

/** Edge length of a corner handle, in card pixels. */
export const HANDLE_SIZE = 5;
/** Smallest width and height a resize produces, in card pixels. */
export const MIN_PART_SIZE = 8;

export type ResizeHandle = "nw" | "ne" | "sw" | "se";
export type PartDragMode = "move" | ResizeHandle;

const HANDLES: readonly ResizeHandle[] = ["nw", "ne", "sw", "se"];

function rectContains(rect: HexRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

/** Topmost visible part of `type` on the edit layer (card, or background in Edit Background mode). */
export function hitTestLayerPart(state: HexRuntimeState, type: HexPart["type"], x: number, y: number): HexPart | null {
  const { parts } = resolveEditTarget(state).owner;
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.type === type && part.visible && rectContains(part.rect, x, y)) return part;
  }
  return null;
}

/**
 * Spec 04 Requirement 3.1: the part a double-click at (x, y) opens in the Object Inspector. With
 * the button or field tool it is the topmost part of that type on the edit layer (the part the
 * tool selects); other tools open nothing.
 */
export function inspectablePartAt(state: HexRuntimeState, x: number, y: number): HexPart | null {
  if (state.tool !== "button" && state.tool !== "field") return null;
  return hitTestLayerPart(state, state.tool, x, y);
}

/** The corner handle at (x, y), or null. Handles are HANDLE_SIZE squares inside the rect's corners. */
export function handleAt(rect: HexRect, x: number, y: number): ResizeHandle | null {
  const left = x >= rect.x && x < rect.x + HANDLE_SIZE;
  const right = x < rect.x + rect.width && x >= rect.x + rect.width - HANDLE_SIZE;
  const top = y >= rect.y && y < rect.y + HANDLE_SIZE;
  const bottom = y < rect.y + rect.height && y >= rect.y + rect.height - HANDLE_SIZE;
  if (bottom && right) return "se";
  if (bottom && left) return "sw";
  if (top && right) return "ne";
  if (top && left) return "nw";
  return null;
}

/** The rect after dragging by (dx, dy): `move` translates; a handle moves its two edges, keeping MIN_PART_SIZE. */
export function dragRect(start: HexRect, mode: PartDragMode, dx: number, dy: number): HexRect {
  if (mode === "move") return { x: start.x + dx, y: start.y + dy, width: start.width, height: start.height };
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  const movesLeft = mode === "nw" || mode === "sw";
  const movesTop = mode === "nw" || mode === "ne";
  if (movesLeft) left = Math.min(left + dx, right - MIN_PART_SIZE);
  else right = Math.max(right + dx, left + MIN_PART_SIZE);
  if (movesTop) top = Math.min(top + dy, bottom - MIN_PART_SIZE);
  else bottom = Math.max(bottom + dy, top + MIN_PART_SIZE);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function sameRect(a: HexRect, b: HexRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** Replaces the rect of part `partId` wherever it lives; returns `stack` itself when nothing changes. */
function withPartRect(stack: HexStack, partId: HexID, rect: HexRect): HexStack {
  const update = <T extends { parts: HexPart[] }>(owner: T): T => {
    const index = owner.parts.findIndex((part) => part.id === partId);
    if (index < 0 || sameRect(owner.parts[index].rect, rect)) return owner;
    const parts = owner.parts.slice();
    parts[index] = { ...owner.parts[index], rect: { ...rect } };
    return { ...owner, parts };
  };
  const backgrounds = stack.backgrounds.map(update);
  if (backgrounds.some((background, i) => background !== stack.backgrounds[i])) return { ...stack, backgrounds };
  const cards = stack.cards.map(update);
  if (cards.some((card, i) => card !== stack.cards[i])) return { ...stack, cards };
  return stack;
}

/** Authoring command for one move or resize drag; Undo restores `before`. */
export function createPartRectCommand(partId: HexID, before: HexRect, after: HexRect): HexCommand {
  const resized = before.width !== after.width || before.height !== after.height;
  return {
    label: resized ? "Resize" : "Move",
    apply: (stack) => withPartRect(stack, partId, after),
    revert: (stack) => withPartRect(stack, partId, before),
  };
}

// ---------------------------------------------------------------------------------------------
// Frame helpers
// ---------------------------------------------------------------------------------------------

/** `stack` with the bitmap of one layer replaced by `pixels` (a paint stroke in progress). */
function withLayerPixels(stack: HexStack, layer: HexLayer, ownerId: HexID, pixels: Uint8Array): HexStack {
  const rleData = encodeBitmapRLE(pixels);
  if (layer === "card") {
    return { ...stack, cards: stack.cards.map((card) => (card.id === ownerId ? { ...card, bitmap: { ...card.bitmap, rleData } } : card)) };
  }
  return {
    ...stack,
    backgrounds: stack.backgrounds.map((background) =>
      background.id === ownerId ? { ...background, bitmap: { ...background.bitmap, rleData } } : background),
  };
}

function rectBetween(a: CardPoint, b: CardPoint): HexRect {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x) + 1, height: Math.abs(a.y - b.y) + 1 };
}

/** CSS box (in CSS pixels, relative to the canvas) of a card-pixel rect at UI scale `k`. */
export function cardRectStyle(rect: HexRect, k: number): CSSProperties {
  return { left: rect.x * k, top: rect.y * k, width: rect.width * k, height: rect.height * k };
}

/**
 * Selection frame and four HANDLE_SIZE corner handles of a selected part, at the shell's UI scale
 * k (Requirement 2.10). Card pixel (x, y) is the k x k CSS square at (x * k, y * k).
 */
export function PartSelection({ rect }: { rect: HexRect }) {
  const k = useUiScale();
  return (
    <div className="hc-part-selection" style={cardRectStyle(rect, k)} data-testid="part-selection">
      {HANDLES.map((handle) => (
        <span key={handle} className={`hc-handle hc-handle-${handle}`} style={{ width: HANDLE_SIZE * k, height: HANDLE_SIZE * k }} />
      ))}
    </div>
  );
}

/**
 * Marching-ants frame of a paint selection or a select-drag marquee: the 1 px edge of `rect` drawn
 * as alternating dark and light card pixels (a 2x2 checkerboard tile enlarged k times with
 * `patternTransform`, crispEdges), so it shows on dark and light card pixels alike and never uses
 * a dashed border (steering tech.md, 1-Bit Fidelity Rules 6). The checkerboard phase follows the
 * card pixel grid (`(x + y)` even is dark), so the ants stay put while the marquee grows.
 */
export function SelectionMarquee({ rect }: { rect: HexRect }) {
  const patternId = useId();
  const k = useUiScale();
  const width = rect.width * k;
  const height = rect.height * k;
  const phase = (rect.x + rect.y) & 1; // 0: tile pixel (0, 0) is dark
  const edges: { x: number; y: number; width: number; height: number }[] = [{ x: 0, y: 0, width, height: k }];
  if (rect.height > 1) edges.push({ x: 0, y: height - k, width, height: k });
  edges.push({ x: 0, y: 0, width: k, height });
  if (rect.width > 1) edges.push({ x: width - k, y: 0, width: k, height });
  return (
    <div className="hc-marquee" style={cardRectStyle(rect, k)} data-testid="selection-marquee">
      <svg className="hc-marquee-art" width={width} height={height} shapeRendering="crispEdges" aria-hidden="true" focusable="false">
        <defs>
          <pattern id={patternId} width={2} height={2} patternUnits="userSpaceOnUse" patternTransform={`scale(${k})`}>
            <rect width={2} height={2} fill="var(--light-bit)" />
            <rect x={phase} y={0} width={1} height={1} fill="var(--dark-bit)" />
            <rect x={1 - phase} y={1} width={1} height={1} fill="var(--dark-bit)" />
          </pattern>
        </defs>
        {edges.map((edge, index) => (
          <rect key={index} x={edge.x} y={edge.y} width={edge.width} height={edge.height} fill={`url(#${patternId})`} />
        ))}
      </svg>
    </div>
  );
}

/**
 * Moves the (flex-centred) framed viewport onto the k-pixel grid with `left` / `top`: centring in
 * the desktop can leave the frame half a CSS pixel or a non-multiple of k off the grid. The offset
 * is <= 0 (`gridSnapOffset` floors) and the desktop starts on the grid (below the 20k menu bar),
 * so the frame never moves out of the desktop and never adds scrollable overflow.
 */
function snapViewportToGrid(viewport: HTMLElement, k: number): void {
  viewport.style.left = "0px";
  viewport.style.top = "0px";
  const box = viewport.getBoundingClientRect();
  viewport.style.left = `${gridSnapOffset(box.left, k)}px`;
  viewport.style.top = `${gridSnapOffset(box.top, k)}px`;
}

/** Spec 06 Requirements 6.2, 6.3: a file drag over the card is accepted as a copy. */
export function cardDragOver(event: FileDragLike): void {
  if (!hasDraggedFiles(event.dataTransfer)) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
}

/**
 * Spec 06 Requirements 6.2, 6.3: a file drop on the card is always prevented (the browser never
 * opens the file); with no dialog or studio window open, the first file goes to `onDropImage`,
 * which checks the paint tool. Returns whether a file was handed on.
 */
export function cardDrop(
  event: FileDragLike,
  options: { isModalOpen: () => boolean; onDropImage?: (file: ImageFileLike) => void },
): boolean {
  if (!hasDraggedFiles(event.dataTransfer)) return false;
  event.preventDefault();
  const file = event.dataTransfer?.files?.[0] as ImageFileLike | undefined;
  if (options.isModalOpen() || file === undefined || options.onDropImage === undefined) return false;
  options.onDropImage(file);
  return true;
}

/** Focus targets whose own keyboard handling must not be forwarded as `keyDown`. */
function isTextEntryTarget(target: EventTarget | null): boolean {
  if (typeof Element === "undefined" || !(target instanceof Element)) return false;
  return target.closest("input, textarea, select, [contenteditable]") !== null;
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

export interface CardViewportProps {
  store: UiStore;
  history: Pick<HexHistory, "execute">;
  bus: Pick<MessageBus, "post" | "abort">;
  /** The spec 03 paint controller created by the composition root with the store and history. */
  painter: PaintController;
  effects: EffectStage;
  mouse: Pick<MouseTracker, "set">;
  isModalOpen: () => boolean;
  /** Opens the Object Inspector on a part double-clicked with the button or field tool (Req 3.1). */
  onInspectPart?: (partId: HexID) => void;
  /** Spec 06 Requirement 6.2: the first file dropped on the card (paint-tool check included). */
  onDropImage?: (file: ImageFileLike) => void;
}

interface EditingSession extends FieldEditTarget {
  caret: number;
  selEnd: number;
  textAtOpen: string;
  name: string;
}

interface PartDrag {
  partId: HexID;
  mode: PartDragMode;
  start: CardPoint;
  startRect: HexRect;
  rect: HexRect;
}

interface Surface {
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  out: Uint32Array;
  drawn: boolean;
}

function selectedPartOf(state: HexRuntimeState, partId: HexID | null): HexPart | null {
  if (partId === null || (state.tool !== "button" && state.tool !== "field")) return null;
  return resolveEditTarget(state).owner.parts.find((part) => part.id === partId && part.type === state.tool) ?? null;
}

export function CardViewport({
  store, history, bus, painter, effects, mouse, isModalOpen, onInspectPart, onDropImage,
}: CardViewportProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const surfaceRef = useRef<Surface | null>(null);
  const frameRequest = useRef<number | null>(null);
  const scrollOffsets = useRef(new Map<HexID, number>());
  const editingRef = useRef<EditingSession | null>(null);
  const dragRef = useRef<PartDrag | null>(null);
  const textDragAnchor = useRef<number | null>(null);
  const marqueeStart = useRef<CardPoint | null>(null);
  const previous = useRef({ tool: state.tool, cardId: state.currentCardId, editLayer: state.editLayer });

  // Requirement 2.10: the shell's UI scale k, shared with the menu bar, menus, dialogs and palette.
  const scale = useUiScale();
  const [editing, setEditingState] = useState<EditingSession | null>(null);
  const [drag, setDragState] = useState<PartDrag | null>(null);
  const [marquee, setMarquee] = useState<HexRect | null>(null);
  const [, setOverlayVersion] = useState(0);

  const browse = useMemo(() => createBrowseInput({ store, bus }), [store, bus]);
  const rasterizePart = useMemo(() => createPartRasterizer({ scrollOffset: (id) => scrollOffsets.current.get(id) ?? 0 }), []);

  const setEditing = (next: EditingSession | null): void => {
    editingRef.current = next;
    setEditingState(next);
  };
  const setDrag = (next: PartDrag | null): void => {
    dragRef.current = next;
    setDragState(next);
  };

  // --- drawing --------------------------------------------------------------------------------

  const getSurface = useCallback((): Surface | null => {
    if (surfaceRef.current) return surfaceRef.current;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return null;
    const image = ctx.createImageData(BITMAP_WIDTH, BITMAP_HEIGHT);
    surfaceRef.current = { ctx, image, out: new Uint32Array(image.data.buffer), drawn: false };
    return surfaceRef.current;
  }, []);

  const draw = useCallback((): void => {
    if (effects.isPlaying()) return; // a visual effect owns the canvas
    const surface = getSurface();
    if (!surface) return;
    const snapshot = store.getSnapshot();
    let stack = snapshot.stack;
    const preview = painter.getPreview();
    if (preview) stack = withLayerPixels(stack, preview.layer, preview.layerOwnerId, preview.pixels);
    const partDrag = dragRef.current;
    if (partDrag) stack = withPartRect(stack, partDrag.partId, partDrag.rect);
    const session = editingRef.current;
    const frame = composeFrame(
      stack,
      snapshot.currentCardId,
      {
        editing: session && session.cardId === snapshot.currentCardId
          ? { partId: session.partId, caret: session.caret, selEnd: session.selEnd }
          : undefined,
        pressedPartId: snapshot.tool === "browse" ? browse.pressedPartId() : undefined,
      },
      rasterizePart,
    );
    frameToImageData(frame, stack.themePalette, surface.out);
    surface.ctx.putImageData(surface.image, 0, 0);
    surface.drawn = true;
  }, [effects, getSurface, store, painter, browse, rasterizePart]);

  /** Coalesces draws of transient state (pressed buttons, strokes in progress) to one per frame. */
  const requestDraw = useCallback((): void => {
    if (frameRequest.current !== null) return;
    frameRequest.current = requestAnimationFrame(() => {
      frameRequest.current = null;
      draw();
    });
  }, [draw]);

  useEffect(() => () => {
    if (frameRequest.current !== null) cancelAnimationFrame(frameRequest.current);
    frameRequest.current = null;
  }, []);

  // Visual effects draw on this canvas; when one ends, the current state is drawn again.
  useEffect(() => {
    const detach = effects.attach({
      present(buf) {
        const surface = getSurface();
        if (!surface) return;
        surface.out.set(buf);
        surface.ctx.putImageData(surface.image, 0, 0);
        surface.drawn = true;
      },
      capture() {
        const surface = surfaceRef.current;
        return surface?.drawn ? surface.out.slice() : null;
      },
    });
    const unsubscribe = effects.subscribe(() => {
      if (!effects.isPlaying()) draw();
    });
    return () => {
      detach();
      unsubscribe();
    };
  }, [effects, getSurface, draw]);

  // --- field editing --------------------------------------------------------------------------

  const syncCaret = (): void => {
    const session = editingRef.current;
    const textarea = textareaRef.current;
    if (!session || !textarea) return;
    const caret = textarea.selectionStart;
    const selEnd = textarea.selectionEnd;
    if (caret !== session.caret || selEnd !== session.selEnd) setEditing({ ...session, caret, selEnd });
  };

  const endEditing = (): void => {
    const session = editingRef.current;
    if (!session) return;
    setEditing(null);
    textDragAnchor.current = null;
    const textarea = textareaRef.current;
    if (textarea && typeof document !== "undefined" && document.activeElement === textarea) textarea.blur();
    const snapshot = store.getSnapshot();
    if (snapshot.tool !== "browse") return;
    let text: string;
    try {
      text = readFieldText(snapshot.stack, session.cardId, session.layer, session.partId);
    } catch {
      return; // the field was removed
    }
    bus.post({ name: fieldExitMessage(session.textAtOpen, text), params: [], targetId: session.partId });
  };

  const caretIndexAt = (session: EditingSession, point: CardPoint): number | null => {
    const part = editableField(store.getSnapshot(), session);
    const textarea = textareaRef.current;
    if (!part || !textarea) return null;
    return fieldCaretIndexAt(part, textarea.value, point.x, point.y, { scroll: scrollOffsets.current.get(part.id) ?? 0 });
  };

  const placeSelection = (anchor: number, head: number): void => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), head < anchor ? "backward" : "forward");
    syncCaret();
  };

  const beginEditing = (click: Extract<BrowseClick, { action: "editField" }>, point: CardPoint): void => {
    const snapshot = store.getSnapshot();
    const target: FieldEditTarget = { cardId: snapshot.currentCardId, layer: click.layer, partId: click.partId };
    const part = editableField(snapshot, target);
    const textarea = textareaRef.current;
    if (!part || !textarea) return;
    const text = readFieldText(snapshot.stack, target.cardId, target.layer, target.partId);
    const index = fieldCaretIndexAt(part, text, point.x, point.y, { scroll: scrollOffsets.current.get(part.id) ?? 0 });
    textarea.value = text;
    textarea.readOnly = false;
    textarea.focus({ preventScroll: true }); // inside the pointer gesture, so touch keyboards open
    textarea.setSelectionRange(index, index);
    setEditing({ ...target, caret: index, selEnd: index, textAtOpen: text, name: part.name });
    textDragAnchor.current = index;
    bus.post({ name: "openField", params: [], targetId: part.id });
  };

  const onTextInput = (): void => {
    const session = editingRef.current;
    const textarea = textareaRef.current;
    if (!session || !textarea) return;
    try {
      store.applyRuntime({ type: "setFieldText", cardId: session.cardId, layer: session.layer, partId: session.partId, text: textarea.value });
    } catch (error) {
      console.error("HexCard: could not write the field text", error);
      endEditing();
      return;
    }
    syncCaret();
  };

  const onTextBlur = (): void => {
    // Switching windows keeps the field open; any other focus change closes it.
    if (typeof document !== "undefined" && !document.hasFocus()) return;
    endEditing();
  };

  // --- state changes: tools, cards, layers, external text edits ------------------------------

  useLayoutEffect(() => {
    const before = previous.current;
    const toolChanged = before.tool !== state.tool;
    const cardChanged = before.cardId !== state.currentCardId;
    const layerChanged = before.editLayer !== state.editLayer;
    previous.current = { tool: state.tool, cardId: state.currentCardId, editLayer: state.editLayer };

    if (toolChanged || cardChanged) browse.reset();
    if ((toolChanged && !isPaintTool(state.tool)) || cardChanged || layerChanged) {
      painter.cancel();
      marqueeStart.current = null;
      setMarquee(null);
    }
    if ((toolChanged && state.tool !== "select" && state.tool !== "lasso") || cardChanged) painter.clearSelection();
    if ((toolChanged || cardChanged || layerChanged) && dragRef.current) setDrag(null);
    // The part selection lives in the store, which clears it on these changes (spec 05 Requirement 10.2).

    const session = editingRef.current;
    if (session) {
      if (!editableField(state, session)) {
        endEditing();
      } else {
        // A script may change the text of the open field: keep the textarea in step.
        const text = readFieldText(state.stack, session.cardId, session.layer, session.partId);
        const textarea = textareaRef.current;
        if (textarea && textarea.value !== text) {
          textarea.value = text;
          textarea.setSelectionRange(Math.min(session.caret, text.length), Math.min(session.selEnd, text.length));
          syncCaret();
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, browse, painter]);

  // The framed card on the k-pixel grid: before the first paint, on every k and on window resize.
  useLayoutEffect(() => {
    const viewport = wrapperRef.current;
    if (!viewport) return;
    const snap = (): void => snapViewportToGrid(viewport, scale);
    snap();
    window.addEventListener("resize", snap);
    return () => window.removeEventListener("resize", snap);
  }, [scale]);

  // Every committed change (stack, card, tool, editing caret, part drag, scale) is drawn at once.
  useLayoutEffect(() => {
    draw();
  }, [draw, state, editing, drag, scale]);

  // --- keyboard and continuous messages -------------------------------------------------------

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (isAbortShortcut(event)) {
        event.preventDefault();
        bus.abort();
        return;
      }
      if (store.getSnapshot().tool !== "browse" || isModalOpen()) return;
      if (event.metaKey || event.ctrlKey || event.altKey || isTextEntryTarget(event.target)) return;
      // Enter and Space activate a focused menu button; leave those to it.
      if ((event.key === "Enter" || event.key === " ") && event.target instanceof HTMLButtonElement) return;
      browse.keyDown(event.key);
      if (event.key.startsWith("Arrow") || event.key === " ") event.preventDefault(); // no desktop scrolling
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [store, bus, browse, isModalOpen]);

  useEffect(() => {
    if (state.tool !== "browse") return;
    const timer = setInterval(() => {
      if (!isModalOpen()) browse.tick();
    }, CONTINUOUS_MESSAGE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [state.tool, browse, isModalOpen]);

  // --- pointer --------------------------------------------------------------------------------

  const toPoint = (event: { clientX: number; clientY: number }): CardPoint => {
    const canvas = canvasRef.current;
    const rect = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: BITMAP_WIDTH, height: BITMAP_HEIGHT };
    return clientToCardPoint(event.clientX, event.clientY, rect);
  };

  const startDrag = (part: HexPart, mode: PartDragMode, point: CardPoint): void => {
    setDrag({ partId: part.id, mode, start: point, startRect: part.rect, rect: part.rect });
  };

  const finishDrag = (): void => {
    const partDrag = dragRef.current;
    if (!partDrag) return;
    setDrag(null);
    if (!sameRect(partDrag.startRect, partDrag.rect)) history.execute(createPartRectCommand(partDrag.partId, partDrag.startRect, partDrag.rect));
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (event.button !== 0 || isModalOpen()) return;
    const point = toPoint(event);
    mouse.set(point.x, point.y);
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const snapshot = store.getSnapshot();

    if (snapshot.tool === "browse") {
      const session = editingRef.current;
      if (session) {
        const hit = hitTest(snapshot.stack, snapshot.currentCardId, point.x, point.y);
        if (hit?.id === session.partId) {
          const index = caretIndexAt(session, point);
          if (index !== null) {
            textDragAnchor.current = index;
            placeSelection(index, index);
          }
          return;
        }
        endEditing();
      }
      const click = browse.pointerDown(point.x, point.y);
      if (click.action === "editField") beginEditing(click, point);
      requestDraw();
      return;
    }

    if (isPaintTool(snapshot.tool)) {
      if (!painter.begin(point.x, point.y)) return;
      // A select press outside the current selection starts a new marquee.
      marqueeStart.current = snapshot.tool === "select" && painter.getSelection() === null ? point : null;
      setMarquee(marqueeStart.current ? rectBetween(point, point) : null);
      requestDraw();
      return;
    }

    // Button and field tools.
    const selected = selectedPartOf(snapshot, snapshot.selectedPartId);
    const handle = selected ? handleAt(selected.rect, point.x, point.y) : null;
    if (selected && handle) {
      startDrag(selected, handle, point);
      return;
    }
    const hit = hitTestLayerPart(snapshot, snapshot.tool === "button" ? "button" : "field", point.x, point.y);
    // Spec 05 Requirement 10.1: the selection is UI state in the store.
    store.setSelectedPart(hit?.id ?? null);
    if (hit) startDrag(hit, "move", point);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = toPoint(event);
    mouse.set(point.x, point.y);
    const snapshot = store.getSnapshot();

    if (snapshot.tool === "browse") {
      const session = editingRef.current;
      const anchor = textDragAnchor.current;
      if (session && anchor !== null && (event.buttons & 1) === 1) {
        const index = caretIndexAt(session, point);
        if (index !== null) placeSelection(anchor, index);
        return;
      }
      const pressedBefore = browse.pressedPartId();
      browse.pointerMove(point.x, point.y);
      if (browse.pressedPartId() !== pressedBefore) requestDraw();
      return;
    }

    if (painter.isActive()) {
      painter.move(point.x, point.y);
      if (marqueeStart.current) setMarquee(rectBetween(marqueeStart.current, point));
      requestDraw();
      return;
    }

    const partDrag = dragRef.current;
    if (partDrag) {
      const rect = dragRect(partDrag.startRect, partDrag.mode, point.x - partDrag.start.x, point.y - partDrag.start.y);
      if (!sameRect(rect, partDrag.rect)) setDrag({ ...partDrag, rect });
    }
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>): void => {
    const point = toPoint(event);
    const snapshot = store.getSnapshot();
    if (snapshot.tool === "browse") {
      textDragAnchor.current = null;
      browse.pointerUp(point.x, point.y);
      requestDraw();
      return;
    }
    if (painter.isActive()) {
      painter.end(point.x, point.y);
      marqueeStart.current = null;
      setMarquee(null);
      setOverlayVersion((version) => version + 1); // show the new pixel selection
      requestDraw();
      return;
    }
    finishDrag();
  };

  const onPointerCancel = (): void => {
    textDragAnchor.current = null;
    browse.cancel();
    painter.cancel();
    marqueeStart.current = null;
    setMarquee(null);
    if (dragRef.current) setDrag(null);
    requestDraw();
  };

  const onPointerLeave = (): void => {
    if (store.getSnapshot().tool === "browse") browse.pointerLeave();
  };

  const onDoubleClick = (event: { clientX: number; clientY: number }): void => {
    if (isModalOpen()) return;
    const snapshot = store.getSnapshot();
    const point = toPoint(event);
    if (snapshot.tool === "browse") {
      browse.doubleClick(point.x, point.y);
      return;
    }
    const part = inspectablePartAt(snapshot, point.x, point.y);
    if (part) onInspectPart?.(part.id);
  };

  /** Scrolling fields keep their scroll offset in UI state (spec 03 design §3). */
  const onWheel = (event: ReactWheelEvent<HTMLCanvasElement>): void => {
    if (event.deltaY === 0) return;
    const point = toPoint(event);
    const snapshot = store.getSnapshot();
    if (snapshot.tool !== "browse") return;
    const part = hitTest(snapshot.stack, snapshot.currentCardId, point.x, point.y);
    if (!part || part.type !== "field" || part.style !== "scrolling") return;
    const text = readFieldText(snapshot.stack, snapshot.currentCardId, part.layerScope, part.id);
    const current = scrollOffsets.current.get(part.id) ?? 0;
    const layout = layoutFieldText(part, text, { scroll: current });
    const next = Math.min(layout.maxScroll, Math.max(0, current + Math.sign(event.deltaY) * layout.lineHeight));
    if (next === current) return;
    scrollOffsets.current.set(part.id, next);
    requestDraw();
  };

  // --- render ---------------------------------------------------------------------------------

  const width = BITMAP_WIDTH * scale;
  const height = BITMAP_HEIGHT * scale;
  const frame = CARD_FRAME_WIDTH * scale;
  const selected = selectedPartOf(state, state.selectedPartId);
  const selectionRect = selected ? (drag?.partId === selected.id ? drag.rect : selected.rect) : null;
  const pixelSelection = isPaintTool(state.tool) && !painter.isActive() ? painter.getSelection() : null;
  const editingPart = editing ? editableField(state, editing) : null;
  const card = state.stack.cards.find((candidate) => candidate.id === state.currentCardId);

  return (
    <div
      ref={wrapperRef}
      className="hc-viewport"
      style={{ width, height, borderWidth: frame }}
      data-tool={state.tool}
      onDragOver={(event) => cardDragOver(event)}
      onDrop={(event) => void cardDrop(event, { isModalOpen, onDropImage })}
    >
      <canvas
        ref={canvasRef}
        className="hc-card-canvas"
        width={BITMAP_WIDTH}
        height={BITMAP_HEIGHT}
        style={{ width, height }}
        role="img"
        aria-label={card ? `Card ${card.name}` : "Card"}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={onPointerLeave}
        onDoubleClick={onDoubleClick}
        onWheel={onWheel}
        onMouseDown={(event) => event.preventDefault() /* keeps focus in the hidden textarea */}
      />
      <textarea
        ref={textareaRef}
        className="hc-hidden-input"
        aria-label={editing?.name || "Card field"}
        aria-hidden={editing ? undefined : true}
        tabIndex={-1}
        readOnly={!editing}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        style={editingPart ? cardRectStyle(editingPart.rect, scale) : undefined}
        onInput={onTextInput}
        onSelect={syncCaret}
        onKeyUp={syncCaret}
        onBlur={onTextBlur}
      />
      {selectionRect ? <PartSelection rect={selectionRect} /> : null}
      {pixelSelection ? <SelectionMarquee rect={pixelSelection.bounds} /> : null}
      {marquee ? <SelectionMarquee rect={marquee} /> : null}
    </div>
  );
}
