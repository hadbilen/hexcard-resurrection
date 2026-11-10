/**
 * Go > Message Box (spec 06 Requirement 2): the React-free controller of the floating one-line
 * window and the window itself. Design: .kiro/specs/06-hypercard-classics/design.md §MessageBox.tsx.
 *
 * - The controller keeps the open state, the line, the position and focus requests in memory only
 *   (Requirement 2.4); nothing here is saved.
 * - The window is a floating window like the Tools palette, not a studio window: menus, the card,
 *   studio shortcuts outside its text box and `idle` keep working while it is open (Requirement 2.5).
 * - Return hands the line to `onReturn` (the runner of src/core/messageBox.ts); Escape closes it.
 */
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactElement } from "react";
import { beginPointerDrag, clampPaletteOrigin, type Point } from "./FloatingTools.tsx";
import { useUiScale } from "./System7Shell.tsx";

export type MessageBoxSelection = "end" | "all" | { start: number; end: number };

export interface MessageBoxSnapshot {
  open: boolean;
  line: string;
  /** Viewport pixels of the window's top-left corner; null until first placed (Requirement 2.6). */
  position: Point | null;
  /** A new id on every focus request; the window focuses its text box and applies `select`. */
  focus: { id: number; select: MessageBoxSelection } | null;
}

export interface MessageBoxController {
  subscribe(listener: () => void): () => void;
  getSnapshot(): MessageBoxSnapshot;
  isOpen(): boolean;
  /** Opens if closed, replaces the line when `line` is given, and requests the focus (Requirements 2.1, 2.2). */
  show(request?: { line?: string; select?: MessageBoxSelection }): void;
  close(): void;
  setLine(line: string): void;
  setPosition(position: Point): void;
}

/** Requirement 2.7: a one-line text box drops line breaks, as HTML does for `<input type="text">`. */
const LINE_BREAK_CHARS = /[\r\n]/g;

export function createMessageBox(): MessageBoxController {
  const listeners = new Set<() => void>();
  let snapshot: MessageBoxSnapshot = { open: false, line: "", position: null, focus: null };
  let nextFocusId = 1;

  const set = (next: MessageBoxSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    isOpen: () => snapshot.open,
    show(request = {}) {
      const line = request.line === undefined ? snapshot.line : request.line.replace(LINE_BREAK_CHARS, "");
      set({ ...snapshot, open: true, line, focus: { id: nextFocusId++, select: request.select ?? "end" } });
    },
    close() {
      if (snapshot.open) set({ ...snapshot, open: false, focus: null });
    },
    setLine(line) {
      const next = line.replace(LINE_BREAK_CHARS, "");
      if (next !== snapshot.line) set({ ...snapshot, line: next });
    },
    setPosition(position) {
      const current = snapshot.position;
      if (current && current.x === position.x && current.y === position.y) return;
      set({ ...snapshot, position: { x: position.x, y: position.y } });
    },
  };
}

/** Width and height of the window at 1x, frame included. */
export const MESSAGE_BOX_WIDTH = 448;
export const MESSAGE_BOX_HEIGHT = 47; // 1 frame + 12 title + 1 line + 4 + 24 text box + 4 + 1 frame
/** Distance (at 1x) of the first position from the left and bottom edges of the window. */
const MESSAGE_BOX_MARGIN = 16;

/** Requirement 2.6: the first position, near the bottom left of the desktop, at UI scale k. */
export function defaultMessageBoxPosition(k: number, viewportHeight: number): Point {
  return { x: MESSAGE_BOX_MARGIN * k, y: viewportHeight - (MESSAGE_BOX_HEIGHT + MESSAGE_BOX_MARGIN) * k };
}

/** The selection a focus request puts in a text box holding `length` characters. */
export function selectionRange(select: MessageBoxSelection, length: number): { start: number; end: number } {
  if (select === "end") return { start: length, end: length };
  if (select === "all") return { start: 0, end: length };
  const start = Math.min(Math.max(select.start, 0), length);
  return { start, end: Math.min(Math.max(select.end, start), length) };
}

/** The window's position: the placed one or the default, kept where its title bar is reachable. */
function windowPosition(placed: Point | null, k: number): Point {
  if (typeof window === "undefined") return placed ?? defaultMessageBoxPosition(k, MESSAGE_BOX_HEIGHT * k);
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  return clampPaletteOrigin(placed ?? defaultMessageBoxPosition(k, viewport.height), viewport, k);
}

export interface MessageBoxWindowProps {
  controller: MessageBoxController;
  onReturn: (line: string) => void;
  /** UI scale k; the enclosing shell's when omitted. */
  scale?: number;
}

export function MessageBoxWindow({ controller, onReturn, scale }: MessageBoxWindowProps): ReactElement | null {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const shellScale = useUiScale();
  const k = scale ?? shellScale;
  const inputRef = useRef<HTMLInputElement>(null);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  // Requirements 2.1, 2.2: every focus request focuses the text box and applies its selection.
  const focusId = snapshot.open ? snapshot.focus?.id : undefined;
  useEffect(() => {
    const input = inputRef.current;
    const focus = controller.getSnapshot().focus;
    if (focusId === undefined || !input || !focus) return;
    input.focus();
    const { start, end } = selectionRange(focus.select, input.value.length);
    input.setSelectionRange(start, end);
  }, [focusId, controller]);

  if (!snapshot.open) return null;
  const position = windowPosition(snapshot.position, k);

  const onTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    stopDrag.current = beginPointerDrag({ x: event.clientX, y: event.clientY }, position, (next) =>
      controller.setPosition(clampPaletteOrigin(next, { width: window.innerWidth, height: window.innerHeight }, k)));
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.nativeEvent.isComposing) return; // Return confirms an IME composition, not the line
    if (event.key === "Enter") {
      event.preventDefault();
      onReturn(event.currentTarget.value);
    } else if (event.key === "Escape") {
      event.preventDefault();
      controller.close();
    }
  };

  return (
    <div className="s7-palette s7-message-box" role="dialog" aria-label="Message Box" style={{ left: position.x, top: position.y }}>
      <div className="s7-palette-title" onPointerDown={onTitlePointerDown}>
        <button
          type="button"
          className="s7-close-box"
          aria-label="Close Message Box"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => controller.close()}
        />
      </div>
      <div className="s7-message-box-body">
        <input
          ref={inputRef}
          type="text"
          className="s7-input s7-message-box-input"
          aria-label="Message Box"
          spellCheck={false}
          autoComplete="off"
          value={snapshot.line}
          onChange={(event) => controller.setLine(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </div>
    </div>
  );
}
