/**
 * Standalone player (spec 04 Requirements 2.7, 6.1, 6.3; design.md §6): the browse-only runtime
 * of an exported `.html` file, built by `vite.player.config.ts` into one IIFE.
 *
 * 1. Reads the stack embedded in `<script type="application/json" id="hexstack">` and checks it
 *    like every other load (`parseEmbeddedStack`: validator plus a decode of every bitmap layer).
 *    An invalid stack shows a plain-text error and nothing runs.
 * 2. Loads the bundled fonts from `data:` URLs inlined into this bundle, so the page makes no font
 *    requests (Requirement 6.1), and only then composes the first frame (Requirement 2.7).
 * 3. Creates the store (no IndexedDB auto-save), the VM host, the message bus, the effect stage and
 *    the synth from the spec 01-04 modules, and runs the stack with the Browse tool only. There are
 *    no authoring tools, no undo history and no AI features (Requirement 6.3).
 *
 * The card is a 512x342 canvas at an integer CSS scale with `image-rendering: pixelated`. The only
 * other DOM elements are the hidden textarea for field editing and the `answer` / `ask` / error
 * dialogs, whose text is set with `textContent` only (steering tech.md, Security Guardrails 2).
 * No React, no eval, no innerHTML; the only network access is the stack's own `fetch` commands
 * through the §4.3 policy in `vmHost.ts`.
 */
import { isAbortShortcut, createMessageBus, type BrowseClick, type HexMessage, type MessageBus } from "../core/messageBus.ts";
import { parseHexTalk } from "../core/parser.ts";
import type { HexID, HexRect, HexStack } from "../core/schema.ts";
import { createHexStore, readFieldText } from "../core/store.ts";
import { HexRuntimeError, HexVmGasLimitError } from "../core/vm.ts";
import { getHexAudioSynth, playSound } from "../engine/audio/synth.ts";
import { composeFrame, computeIntegerScale, frameToImageData } from "../engine/graphics/bitmapCanvas.ts";
import { createPartRasterizer, fieldCaretIndexAt, hitTest, layoutFieldText } from "../engine/graphics/partRenderer.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH } from "../engine/graphics/rleCodec.ts";
import { loadBundledFonts, tableFontFiles, type FontUrlOverrides } from "../engine/graphics/textRaster.ts";
import { DAMAGED_STACK_MESSAGE } from "../storage/stackLoader.ts";
import {
  CONTINUOUS_MESSAGE_INTERVAL_MS,
  clientToCardPoint,
  createBrowseInput,
  editableField,
  fieldExitMessage,
  type CardPoint,
  type FieldEditTarget,
} from "../ui/browseInput.ts";
import { createEffectStage, createMouseTracker, createVmHost } from "../ui/vmHost.ts";
import { EMBEDDED_STACK_ELEMENT_ID, parseEmbeddedStack } from "./embedded.ts";

// ---------------------------------------------------------------------------------------------
// Fonts inlined into the bundle (Requirement 6.1)
// ---------------------------------------------------------------------------------------------

/** Every bundled font file as a base64 `data:` URL, keyed by its path relative to this module. */
const INLINED_FONTS = import.meta.glob<string>("../../public/fonts/*.ttf", { query: "?inline", import: "default", eager: true });

/** `data:` URL overrides for every font file the size table uses, or null if one is missing. */
function inlinedFontOverrides(): FontUrlOverrides | null {
  const overrides: Partial<Record<string, string>> = {};
  for (const file of tableFontFiles()) {
    const url = INLINED_FONTS[`../../public/fonts/${file}`];
    if (typeof url !== "string" || !url.startsWith("data:")) return null;
    overrides[file] = url;
  }
  return overrides as FontUrlOverrides;
}

// ---------------------------------------------------------------------------------------------
// Chrome: colours, scale, font
// ---------------------------------------------------------------------------------------------

const DARK = "var(--dark-bit)";
const LIGHT = "var(--light-bit)";
/** Dialog text: Pixel Operator at its native 16 px, times the scale. */
const UI_FONT_FAMILY = `"HexCard PixelOperator", monospace`;
const UI_FONT_SIZE = 16;
/** Width of the frame around the card, in card pixels. */
const CARD_FRAME = 1;

/** Largest integer scale at which the framed card fits the window. */
function playerScale(): number {
  const width = window.innerWidth;
  const height = window.innerHeight;
  for (let k = computeIntegerScale(width, height); k > 1; k--) {
    if ((BITMAP_WIDTH + 2 * CARD_FRAME) * k <= width && (BITMAP_HEIGHT + 2 * CARD_FRAME) * k <= height) return k;
  }
  return 1;
}

function setStyles(element: HTMLElement, styles: Record<string, string>): void {
  for (const [property, value] of Object.entries(styles)) element.style.setProperty(property, value);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, styles: Record<string, string> = {}, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  setStyles(node, styles);
  if (text !== undefined) node.textContent = text;
  return node;
}

function applyPalette(palette: HexStack["themePalette"]): void {
  const root = document.documentElement;
  root.style.setProperty("--dark-bit", palette.darkBitHex);
  root.style.setProperty("--light-bit", palette.lightBitHex);
}

function styleBody(): void {
  setStyles(document.body, {
    margin: "0",
    padding: "0",
    overflow: "hidden",
    background: LIGHT,
    color: DARK,
    "user-select": "none",
    "-webkit-user-select": "none",
  });
  setStyles(document.documentElement, { margin: "0", padding: "0", background: LIGHT });
}

/** Plain-text error page for a stack that cannot be run. */
function showFatalError(message: string, detail: string): void {
  applyPalette({ name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" });
  styleBody();
  const box = element("div", { margin: "16px", "font-family": UI_FONT_FAMILY, "font-size": `${UI_FONT_SIZE}px`, "line-height": `${UI_FONT_SIZE}px` });
  box.append(element("p", { margin: "0 0 8px 0" }, message), element("p", { margin: "0" }, detail));
  document.body.append(box);
}

// ---------------------------------------------------------------------------------------------
// Dialogs: answer, ask and script errors (textContent only)
// ---------------------------------------------------------------------------------------------

interface PlayerDialogs {
  answer(prompt: string, buttons: readonly string[]): Promise<string>;
  ask(prompt: string, defaultAnswer: string): Promise<string>;
  alert(message: string, details?: readonly string[]): Promise<void>;
  isOpen(): boolean;
}

type DialogSpec =
  | { kind: "buttons"; message: string; details: readonly string[]; buttons: readonly string[] }
  | { kind: "ask"; message: string; defaultAnswer: string };

function createPlayerDialogs(getScale: () => number): PlayerDialogs {
  let pending = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const show = (spec: DialogSpec): Promise<string> => {
    pending += 1;
    const result = queue.then(() => new Promise<string>((resolve) => {
      const k = getScale();
      const px = (n: number): string => `${n * k}px`;
      const fontStyles = { "font-family": UI_FONT_FAMILY, "font-size": px(UI_FONT_SIZE), "line-height": px(UI_FONT_SIZE), color: DARK };
      const overlay = element("div", { position: "fixed", left: "0", top: "0", right: "0", bottom: "0", "z-index": "10" });
      // Integer card-pixel position and size, so the text stays on the k-pixel grid.
      const width = Math.max(120, Math.min(360, Math.floor(window.innerWidth / k) - 16));
      const box = element("div", {
        position: "absolute",
        left: px(Math.max(0, Math.floor((Math.floor(window.innerWidth / k) - width) / 2))),
        top: px(48),
        "box-sizing": "border-box",
        width: px(width),
        padding: px(12),
        background: LIGHT,
        border: `${px(2)} solid ${DARK}`,
        "box-shadow": `${px(2)} ${px(2)} 0px ${DARK}`,
        ...fontStyles,
      });
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.append(element("p", { margin: "0", "white-space": "pre-wrap", "overflow-wrap": "anywhere" }, spec.message));
      if (spec.kind === "buttons") {
        for (const detail of spec.details) box.append(element("p", { margin: `${px(4)} 0 0 0`, "overflow-wrap": "anywhere" }, detail));
      }

      let closed = false;
      const close = (value: string): void => {
        if (closed) return;
        closed = true;
        overlay.remove();
        pending -= 1;
        resolve(value);
      };
      const makeButton = (label: string, isDefault: boolean, onClick: () => void): HTMLButtonElement => {
        const button = element("button", {
          appearance: "none",
          "-webkit-appearance": "none",
          margin: `0 0 0 ${px(8)}`,
          padding: `${px(2)} ${px(12)}`,
          "min-width": px(64),
          background: LIGHT,
          border: `${px(isDefault ? 2 : 1)} solid ${DARK}`,
          outline: "none",
          ...fontStyles,
        }, label);
        button.type = "button";
        button.addEventListener("click", onClick);
        return button;
      };

      const row = element("div", { display: "flex", "justify-content": "flex-end", "margin-top": px(12) });
      let focusTarget: HTMLElement;
      let onEnter: () => void;
      let onEscape: (() => void) | undefined;
      if (spec.kind === "ask") {
        const input = element("input", {
          display: "block",
          "box-sizing": "border-box",
          width: "100%",
          margin: `${px(8)} 0 0 0`,
          padding: `${px(2)} ${px(4)}`,
          background: LIGHT,
          border: `${px(1)} solid ${DARK}`,
          outline: "none",
          ...fontStyles,
        });
        input.type = "text";
        input.value = spec.defaultAnswer;
        input.spellcheck = false;
        input.autocomplete = "off";
        box.append(input);
        onEnter = () => close(input.value);
        onEscape = () => close("");
        row.append(makeButton("Cancel", false, onEscape), makeButton("OK", true, onEnter));
        focusTarget = input;
      } else {
        const labels = spec.buttons.length > 0 ? spec.buttons : ["OK"];
        const defaultLabel = labels[labels.length - 1];
        const buttons = labels.map((label) => makeButton(label, label === defaultLabel, () => close(label)));
        row.append(...buttons);
        onEnter = () => close(defaultLabel);
        focusTarget = buttons[buttons.length - 1];
      }
      box.append(row);
      box.addEventListener("keydown", (event) => {
        event.stopPropagation(); // dialog keys never reach the card
        if (event.key === "Enter") {
          event.preventDefault();
          onEnter();
        } else if (event.key === "Escape" && onEscape) {
          event.preventDefault();
          onEscape();
        }
      });
      overlay.append(box);
      document.body.append(overlay);
      focusTarget.focus({ preventScroll: true });
      if (focusTarget instanceof HTMLInputElement) focusTarget.select();
    }));
    queue = result;
    return result;
  };

  return {
    answer: (prompt, buttons) => show({ kind: "buttons", message: prompt, details: [], buttons }),
    ask: (prompt, defaultAnswer) => show({ kind: "ask", message: prompt, defaultAnswer }),
    alert: async (message, details = []) => {
      await show({ kind: "buttons", message, details, buttons: ["OK"] });
    },
    isOpen: () => pending > 0,
  };
}

/** Same wording as the studio's bomb dialog (Requirement 3.3). */
const GAS_LIMIT_MESSAGE = "Sorry, a script error occurred: Loop exceeded 10,000 steps";

function describeObject(stack: HexStack, id: HexID): string {
  const named = (object: { name: string; id: HexID }): string => (object.name ? `"${object.name}"` : `id ${object.id}`);
  if (stack.id === id) return `stack ${named(stack)}`;
  for (const background of stack.backgrounds) {
    if (background.id === id) return `background ${named(background)}`;
    const part = background.parts.find((candidate) => candidate.id === id);
    if (part) return `bg ${part.type} ${named(part)}`;
  }
  for (const card of stack.cards) {
    if (card.id === id) return `card ${named(card)}`;
    const part = card.parts.find((candidate) => candidate.id === id);
    if (part) return `card ${part.type} ${named(part)}`;
  }
  return `id ${id}`;
}

function scriptErrorDetails(stack: HexStack, error: HexRuntimeError): string[] {
  const object = error.objectId === undefined ? "unknown" : describeObject(stack, error.objectId);
  const line = error.line !== undefined && error.line > 0 ? String(error.line) : "unknown";
  return [`Object: ${object}`, `Handler: ${error.handler ?? "unknown"}`, `Line: ${line}`];
}

// ---------------------------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------------------------

interface EditingSession extends FieldEditTarget {
  caret: number;
  selEnd: number;
  textAtOpen: string;
}

async function main(): Promise<void> {
  // Installs the autoplay unlock before any await, so the first click unlocks audio (Req 1.3).
  getHexAudioSynth();

  const checked = parseEmbeddedStack(document.getElementById(EMBEDDED_STACK_ELEMENT_ID)?.textContent);
  if (!checked.ok) {
    showFatalError(DAMAGED_STACK_MESSAGE, checked.error);
    return;
  }

  // Requirement 2.7: the fonts are loaded before the first frame; a failure leaves fallback fonts.
  const overrides = inlinedFontOverrides();
  try {
    if (!overrides) throw new Error("the player bundle does not contain every font file");
    await loadBundledFonts("", overrides);
  } catch (error) {
    console.error("HexCard player: the bundled fonts could not be loaded; card text uses fallback fonts", error);
  }

  // No auto-save: an exported stack starts from its embedded state on every load.
  const store = createHexStore({ stack: checked.stack, compile: parseHexTalk });
  let scale = playerScale();
  const dialogs = createPlayerDialogs(() => scale);
  const effects = createEffectStage();
  const mouse = createMouseTracker();

  let bus: MessageBus | undefined;
  const host = createVmHost({
    store,
    bus: () => {
      if (!bus) throw new Error("The message bus is not ready");
      return bus;
    },
    dialogs,
    effects,
    mouse,
    playSound,
  });
  const reportScriptError = async (error: unknown, message: HexMessage): Promise<void> => {
    console.error(`HexCard player: script error while handling "${message.name}"`, error);
    const stack = store.getSnapshot().stack;
    if (error instanceof HexVmGasLimitError) return dialogs.alert(GAS_LIMIT_MESSAGE, scriptErrorDetails(stack, error));
    if (error instanceof HexRuntimeError) return dialogs.alert(error.message, scriptErrorDetails(stack, error));
    return dialogs.alert(`Sorry, an unexpected error occurred while handling "${message.name}".`, [
      error instanceof Error ? error.message : String(error),
    ]);
  };
  const readyBus = createMessageBus({
    store,
    host,
    isPageVisible: () => document.visibilityState === "visible",
    isModalOpen: () => dialogs.isOpen(),
    onError: (error, message) => void reportScriptError(error, message),
  });
  bus = readyBus;
  const browse = createBrowseInput({ store, bus: readyBus });

  // --- DOM ------------------------------------------------------------------------------------

  applyPalette(store.getSnapshot().stack.themePalette);
  styleBody();
  const viewport = element("div", { position: "absolute", "box-sizing": "content-box", border: `0px solid ${DARK}`, background: LIGHT });
  const canvas = element("canvas", { display: "block", "image-rendering": "pixelated", "touch-action": "none" });
  canvas.width = BITMAP_WIDTH;
  canvas.height = BITMAP_HEIGHT;
  canvas.setAttribute("role", "img");
  // Spec 03 Requirement 4.2: visually hidden with clip-path, never with opacity.
  const textarea = element("textarea", {
    position: "absolute",
    margin: "0",
    padding: "0",
    border: "0",
    overflow: "hidden",
    resize: "none",
    "clip-path": "inset(50%)",
    "white-space": "pre-wrap",
    "pointer-events": "none",
    "user-select": "text",
    "-webkit-user-select": "text",
  });
  textarea.tabIndex = -1;
  textarea.readOnly = true;
  textarea.spellcheck = false;
  textarea.autocomplete = "off";
  textarea.setAttribute("autocapitalize", "off");
  textarea.setAttribute("aria-hidden", "true");
  viewport.append(canvas, textarea);
  document.body.append(viewport);

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    showFatalError("This browser cannot draw the card.", "Canvas 2D is not available.");
    return;
  }
  const image = ctx.createImageData(BITMAP_WIDTH, BITMAP_HEIGHT);
  const out = new Uint32Array(image.data.buffer);
  let drawn = false;

  const scrollOffsets = new Map<HexID, number>();
  const rasterizePart = createPartRasterizer({ scrollOffset: (id) => scrollOffsets.get(id) ?? 0 });
  let editing: EditingSession | null = null;
  let textDragAnchor: number | null = null;

  const placeTextarea = (): void => {
    const part = editing ? editableField(store.getSnapshot(), editing) : null;
    const rect: HexRect = part ? part.rect : { x: 0, y: 0, width: 1, height: 1 };
    setStyles(textarea, {
      left: `${rect.x * scale}px`,
      top: `${rect.y * scale}px`,
      width: `${rect.width * scale}px`,
      height: `${rect.height * scale}px`,
    });
  };

  const layout = (): void => {
    scale = playerScale();
    const width = BITMAP_WIDTH * scale;
    const height = BITMAP_HEIGHT * scale;
    const frame = CARD_FRAME * scale;
    // Explicit integer offsets keep the card on the k-pixel grid (no half-pixel centring).
    const left = Math.max(0, Math.floor((window.innerWidth - width - 2 * frame) / 2 / scale) * scale);
    const top = Math.max(0, Math.floor((window.innerHeight - height - 2 * frame) / 2 / scale) * scale);
    setStyles(viewport, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px`, "border-width": `${frame}px` });
    setStyles(canvas, { width: `${width}px`, height: `${height}px` });
    placeTextarea();
  };

  // --- drawing --------------------------------------------------------------------------------

  const draw = (): void => {
    if (effects.isPlaying()) return; // a visual effect owns the canvas
    const snapshot = store.getSnapshot();
    const session = editing;
    const frame = composeFrame(
      snapshot.stack,
      snapshot.currentCardId,
      {
        editing: session && session.cardId === snapshot.currentCardId ? { partId: session.partId, caret: session.caret, selEnd: session.selEnd } : undefined,
        pressedPartId: browse.pressedPartId(),
      },
      rasterizePart,
    );
    frameToImageData(frame, snapshot.stack.themePalette, out);
    ctx.putImageData(image, 0, 0);
    drawn = true;
  };

  // Draws are deferred to the next animation frame, so a `go ... with visual effect` captures the
  // card that is still on screen before the new card is drawn (vmHost.ts `createEffectStage`).
  let frameRequest: number | null = null;
  const requestDraw = (): void => {
    if (frameRequest !== null) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = null;
      draw();
    });
  };

  effects.attach({
    present(buf) {
      out.set(buf);
      ctx.putImageData(image, 0, 0);
      drawn = true;
    },
    capture: () => (drawn ? out.slice() : null),
  });
  effects.subscribe(() => {
    if (!effects.isPlaying()) draw();
  });

  // --- field editing (Requirement 2.5) --------------------------------------------------------

  const syncCaret = (): void => {
    if (!editing) return;
    const caret = textarea.selectionStart;
    const selEnd = textarea.selectionEnd;
    if (caret !== editing.caret || selEnd !== editing.selEnd) {
      editing = { ...editing, caret, selEnd };
      requestDraw();
    }
  };

  const endEditing = (): void => {
    const session = editing;
    if (!session) return;
    editing = null;
    textDragAnchor = null;
    textarea.readOnly = true;
    textarea.setAttribute("aria-hidden", "true");
    if (document.activeElement === textarea) textarea.blur();
    placeTextarea();
    requestDraw();
    let text: string;
    try {
      text = readFieldText(store.getSnapshot().stack, session.cardId, session.layer, session.partId);
    } catch {
      return; // the field was removed
    }
    readyBus.post({ name: fieldExitMessage(session.textAtOpen, text), params: [], targetId: session.partId });
  };

  const caretIndexAt = (session: EditingSession, point: CardPoint): number | null => {
    const part = editableField(store.getSnapshot(), session);
    if (!part) return null;
    return fieldCaretIndexAt(part, textarea.value, point.x, point.y, { scroll: scrollOffsets.get(part.id) ?? 0 });
  };

  const placeSelection = (anchor: number, head: number): void => {
    textarea.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head), head < anchor ? "backward" : "forward");
    syncCaret();
  };

  const beginEditing = (click: Extract<BrowseClick, { action: "editField" }>, point: CardPoint): void => {
    const snapshot = store.getSnapshot();
    const target: FieldEditTarget = { cardId: snapshot.currentCardId, layer: click.layer, partId: click.partId };
    const part = editableField(snapshot, target);
    if (!part) return;
    const text = readFieldText(snapshot.stack, target.cardId, target.layer, target.partId);
    const index = fieldCaretIndexAt(part, text, point.x, point.y, { scroll: scrollOffsets.get(part.id) ?? 0 });
    textarea.value = text;
    textarea.readOnly = false;
    textarea.removeAttribute("aria-hidden");
    textarea.setAttribute("aria-label", part.name || "Card field");
    editing = { ...target, caret: index, selEnd: index, textAtOpen: text };
    placeTextarea();
    textarea.focus({ preventScroll: true }); // inside the pointer gesture, so touch keyboards open
    textarea.setSelectionRange(index, index);
    textDragAnchor = index;
    readyBus.post({ name: "openField", params: [], targetId: part.id });
  };

  textarea.addEventListener("input", () => {
    const session = editing;
    if (!session) return;
    try {
      store.applyRuntime({ type: "setFieldText", cardId: session.cardId, layer: session.layer, partId: session.partId, text: textarea.value });
    } catch (error) {
      console.error("HexCard player: could not write the field text", error);
      endEditing();
      return;
    }
    syncCaret();
  });
  textarea.addEventListener("select", syncCaret);
  textarea.addEventListener("keyup", syncCaret);
  textarea.addEventListener("blur", () => {
    // Switching windows keeps the field open; any other focus change closes it.
    if (!document.hasFocus()) return;
    endEditing();
  });

  // --- store changes ----------------------------------------------------------------------------

  let previousCardId = store.getSnapshot().currentCardId;
  store.subscribe(() => {
    const state = store.getSnapshot();
    applyPalette(state.stack.themePalette);
    if (state.currentCardId !== previousCardId) {
      previousCardId = state.currentCardId;
      browse.reset();
    }
    canvas.setAttribute("aria-label", `Card ${state.stack.cards.find((card) => card.id === state.currentCardId)?.name ?? ""}`.trim());
    const session = editing;
    if (session) {
      if (!editableField(state, session)) {
        endEditing();
      } else {
        // A script may change the text of the open field: keep the textarea in step.
        const text = readFieldText(state.stack, session.cardId, session.layer, session.partId);
        if (textarea.value !== text) {
          textarea.value = text;
          textarea.setSelectionRange(Math.min(session.caret, text.length), Math.min(session.selEnd, text.length));
          syncCaret();
        }
      }
    }
    requestDraw();
  });

  // --- pointer --------------------------------------------------------------------------------

  const toPoint = (event: { clientX: number; clientY: number }): CardPoint =>
    clientToCardPoint(event.clientX, event.clientY, canvas.getBoundingClientRect());

  canvas.addEventListener("mousedown", (event) => event.preventDefault()); // keeps focus in the hidden textarea

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dialogs.isOpen()) return;
    const point = toPoint(event);
    mouse.set(point.x, point.y);
    canvas.setPointerCapture?.(event.pointerId);
    const session = editing;
    if (session) {
      const snapshot = store.getSnapshot();
      const hit = hitTest(snapshot.stack, snapshot.currentCardId, point.x, point.y);
      if (hit?.id === session.partId) {
        const index = caretIndexAt(session, point);
        if (index !== null) {
          textDragAnchor = index;
          placeSelection(index, index);
        }
        return;
      }
      endEditing();
    }
    const click = browse.pointerDown(point.x, point.y);
    if (click.action === "editField") beginEditing(click, point);
    requestDraw();
  });

  canvas.addEventListener("pointermove", (event) => {
    const point = toPoint(event);
    mouse.set(point.x, point.y);
    const session = editing;
    if (session && textDragAnchor !== null && (event.buttons & 1) === 1) {
      const index = caretIndexAt(session, point);
      if (index !== null) placeSelection(textDragAnchor, index);
      return;
    }
    const pressedBefore = browse.pressedPartId();
    browse.pointerMove(point.x, point.y);
    if (browse.pressedPartId() !== pressedBefore) requestDraw();
  });

  canvas.addEventListener("pointerup", (event) => {
    const point = toPoint(event);
    textDragAnchor = null;
    browse.pointerUp(point.x, point.y);
    requestDraw();
  });

  canvas.addEventListener("pointercancel", () => {
    textDragAnchor = null;
    browse.cancel();
    requestDraw();
  });

  canvas.addEventListener("pointerleave", () => browse.pointerLeave());

  canvas.addEventListener("dblclick", (event) => {
    if (dialogs.isOpen()) return;
    const point = toPoint(event);
    browse.doubleClick(point.x, point.y);
  });

  /** Scrolling fields keep their scroll offset in player state (spec 03 design §3). */
  canvas.addEventListener("wheel", (event) => {
    if (event.deltaY === 0) return;
    const point = toPoint(event);
    const snapshot = store.getSnapshot();
    const part = hitTest(snapshot.stack, snapshot.currentCardId, point.x, point.y);
    if (!part || part.type !== "field" || part.style !== "scrolling") return;
    event.preventDefault();
    const text = readFieldText(snapshot.stack, snapshot.currentCardId, part.layerScope, part.id);
    const current = scrollOffsets.get(part.id) ?? 0;
    const fieldLayout = layoutFieldText(part, text, { scroll: current });
    const next = Math.min(fieldLayout.maxScroll, Math.max(0, current + Math.sign(event.deltaY) * fieldLayout.lineHeight));
    if (next === current) return;
    scrollOffsets.set(part.id, next);
    requestDraw();
  }, { passive: false });

  // --- keyboard and continuous messages -------------------------------------------------------

  window.addEventListener("keydown", (event) => {
    if (isAbortShortcut(event)) {
      event.preventDefault();
      readyBus.abort();
      return;
    }
    if (dialogs.isOpen() || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, button, [contenteditable]") !== null) return;
    browse.keyDown(event.key);
    if (event.key.startsWith("Arrow") || event.key === " ") event.preventDefault(); // no page scrolling
  });

  setInterval(() => {
    if (!dialogs.isOpen()) browse.tick();
  }, CONTINUOUS_MESSAGE_INTERVAL_MS);

  window.addEventListener("resize", () => {
    layout();
    draw();
  });

  // --- start: first frame, then openStack / openBackground / openCard (spec 01 Req 2.9) ------

  layout();
  draw();
  readyBus.openCurrentStack();
}

void main().catch((error: unknown) => {
  console.error("HexCard player: the stack could not be started", error);
  showFatalError("The stack could not be started.", error instanceof Error ? error.message : String(error));
});
