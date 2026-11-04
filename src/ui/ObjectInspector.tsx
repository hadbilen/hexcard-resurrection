/**
 * Object Inspector, script editor and script error dialogs (spec 04 task 4).
 * Requirements: spec 04 3.1, 3.2, 3.3, 3.4. Design: .kiro/specs/04-ui-audio-showcase/design.md §1;
 * hexcard_design_spec.md §4.3 (gas limit and script errors), §7.4 (Object Inspector).
 *
 * - The inspector is a modal System 7 window with the tabs `Properties`, `HexTalk Script` and
 *   `HexAI Spellcaster`. Property and script edits are authoring commands run through
 *   `history.execute`; the store recompiles a saved script into its ScriptCache, and the editor
 *   shows the stored compile errors inline (gutter mark, column marker, clickable list).
 * - `StudioWindows` is the one place that knows which studio window (inspector or Stack Graph)
 *   is open, so the card viewport (double-click), the script error alert (**Script** button) and
 *   the Go menu can open them, and the message bus can treat them as modal.
 * - `createScriptErrorReporter` is the message bus `onError`: the bomb dialog for
 *   `HexVmGasLimitError`, an alert with a **Script** button for other located runtime errors.
 */
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { HexCompileError } from "../core/ast.ts";
import type { HexCommand, HexHistory } from "../core/history.ts";
import type { HexMessage } from "../core/messageBus.ts";
import type {
  ButtonStyle,
  FieldStyle,
  HexBackground,
  HexButtonPart,
  HexCard,
  HexFieldPart,
  HexID,
  HexPart,
  HexStack,
} from "../core/schema.ts";
import { HexRuntimeError, HexVmGasLimitError } from "../core/vm.ts";
import { PixelIcon } from "./FloatingTools.tsx";
import { PushButtonArt, System7Window, useUiScale, type ModalManager, type UiStore } from "./System7Shell.tsx";

// ---------------------------------------------------------------------------------------------
// Studio windows (inspector and Stack Graph)
// ---------------------------------------------------------------------------------------------

export type InspectorTab = "properties" | "script" | "spellcaster";

export const INSPECTOR_TABS: readonly { id: InspectorTab; label: string }[] = [
  { id: "properties", label: "Properties" },
  { id: "script", label: "HexTalk Script" },
  { id: "spellcaster", label: "HexAI Spellcaster" },
];

export type InspectorRequest = { id: number; kind: "inspector"; objectId: HexID; tab: InspectorTab; line?: number };
export type StudioWindow = InspectorRequest | { id: number; kind: "stackGraph" };

export interface StudioWindows {
  subscribe(listener: () => void): () => void;
  /** The open window, or null. A new object on every open, so a reopened window starts afresh. */
  getSnapshot(): StudioWindow | null;
  isOpen(): boolean;
  /** Opens the inspector on `objectId`; `line` (1-based) selects that script line (Requirement 3.4). */
  openInspector(objectId: HexID, tab?: InspectorTab, line?: number): void;
  openStackGraph(): void;
  close(): void;
}

export function createStudioWindows(): StudioWindows {
  const listeners = new Set<() => void>();
  let current: StudioWindow | null = null;
  let nextId = 1;
  const set = (next: StudioWindow | null): void => {
    current = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => current,
    isOpen: () => current !== null,
    openInspector(objectId, tab = "properties", line) {
      set(line === undefined
        ? { id: nextId++, kind: "inspector", objectId, tab }
        : { id: nextId++, kind: "inspector", objectId, tab, line });
    },
    openStackGraph() {
      set({ id: nextId++, kind: "stackGraph" });
    },
    close() {
      if (current !== null) set(null);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------------------------

export type InspectedObject =
  | { kind: "stack"; object: HexStack }
  | { kind: "background"; object: HexBackground }
  | { kind: "card"; object: HexCard }
  | { kind: "part"; object: HexPart };

/** The stack, background, card or part with `id`, or undefined. */
export function findObject(stack: HexStack, id: HexID): InspectedObject | undefined {
  if (stack.id === id) return { kind: "stack", object: stack };
  for (const background of stack.backgrounds) {
    if (background.id === id) return { kind: "background", object: background };
    const part = background.parts.find((candidate) => candidate.id === id);
    if (part) return { kind: "part", object: part };
  }
  for (const card of stack.cards) {
    if (card.id === id) return { kind: "card", object: card };
    const part = card.parts.find((candidate) => candidate.id === id);
    if (part) return { kind: "part", object: part };
  }
  return undefined;
}

const named = (object: { id: HexID; name: string }): string => (object.name ? `"${object.name}"` : `id ${object.id}`);

/** HyperCard-style object name, e.g. `card button "Go"`, `bg field "Score"`, `card "Hall"`. */
export function describeObject(stack: HexStack, id: HexID): string | undefined {
  const found = findObject(stack, id);
  if (!found) return undefined;
  switch (found.kind) {
    case "part":
      return `${found.object.layerScope === "card" ? "card" : "bg"} ${found.object.type} ${named(found.object)}`;
    case "card":
      return `card ${named(found.object)}`;
    case "background":
      return `background ${named(found.object)}`;
    case "stack":
      return `stack ${named(found.object)}`;
  }
}

// ---------------------------------------------------------------------------------------------
// Authoring commands
// ---------------------------------------------------------------------------------------------

type Changes = Readonly<Record<string, unknown>>;

const sameValue = (a: unknown, b: unknown): boolean => a === b || JSON.stringify(a) === JSON.stringify(b);

/** `object` with `changes` applied; an `undefined` value removes the key (e.g. no radio `family`). */
function assign<T extends object>(object: T, changes: Changes): T {
  const next = { ...object } as Record<string, unknown>;
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete next[key];
    else next[key] = value;
  }
  return next as T;
}

type Owner = HexCard | HexBackground;

/** Updates the owner or part with `id` in `owners`; undefined when it is not there. */
function mapInOwners<T extends Owner>(owners: readonly T[], id: HexID, update: (object: object) => object): T[] | undefined {
  for (let i = 0; i < owners.length; i++) {
    const owner = owners[i];
    let next: T;
    if (owner.id === id) {
      next = update(owner) as T;
    } else {
      const j = owner.parts.findIndex((part) => part.id === id);
      if (j < 0) continue;
      const part = update(owner.parts[j]) as HexPart;
      if (part === owner.parts[j]) return owners as T[];
      const parts = owner.parts.slice();
      parts[j] = part;
      next = { ...owner, parts };
    }
    if (next === owner) return owners as T[];
    const copy = owners.slice();
    copy[i] = next;
    return copy;
  }
  return undefined;
}

/** Structural-sharing update of one object; the same stack when it is missing or unchanged. */
function mapObject(stack: HexStack, id: HexID, update: (object: object) => object): HexStack {
  if (stack.id === id) return update(stack) as HexStack;
  const backgrounds = mapInOwners(stack.backgrounds, id, update);
  if (backgrounds) return backgrounds === stack.backgrounds ? stack : { ...stack, backgrounds };
  const cards = mapInOwners(stack.cards, id, update);
  if (cards) return cards === stack.cards ? stack : { ...stack, cards };
  return stack;
}

/**
 * Authoring command that sets keys of one object (stack, background, card or part). Undo restores
 * the values it replaced. Changing nothing (or a missing object) returns the same stack, so the
 * history does not record it.
 */
export function createObjectEditCommand(objectId: HexID, label: string, changes: Changes): HexCommand {
  let before: Changes | undefined;
  return {
    label,
    apply(stack) {
      return mapObject(stack, objectId, (object) => {
        const record = object as Record<string, unknown>;
        const keys = Object.keys(changes);
        if (keys.every((key) => sameValue(record[key], changes[key]))) return object;
        before = Object.fromEntries(keys.map((key) => [key, record[key]]));
        return assign(object, changes);
      });
    },
    revert(stack) {
      const previous = before;
      return previous ? mapObject(stack, objectId, (object) => assign(object, previous)) : stack;
    },
  };
}

type PartKeys = "id" | "type" | "layerScope" | "scriptSource" | "naturalLanguagePrompt";
export type ObjectChanges =
  | Partial<Omit<HexButtonPart, PartKeys>>
  | Partial<Omit<HexFieldPart, PartKeys | "content">>
  | Partial<Pick<HexCard, "name" | "marked" | "dontSearch" | "cantDelete">>
  | Partial<Pick<HexBackground, "name" | "cantDelete">>
  | Partial<Pick<HexStack, "name" | "author">>;

/** Properties tab edit (one undoable step, Edit > Undo Properties). */
export function createPropertiesCommand(objectId: HexID, changes: ObjectChanges): HexCommand {
  return createObjectEditCommand(objectId, "Properties", changes);
}

/** Requirement 3.2: a saved script is stored as `scriptSource` (Edit > Undo Script). */
export function createScriptCommand(objectId: HexID, source: string): HexCommand {
  return createObjectEditCommand(objectId, "Script", { scriptSource: source });
}

// ---------------------------------------------------------------------------------------------
// Script error dialogs (Requirements 3.3, 3.4)
// ---------------------------------------------------------------------------------------------

export const GAS_LIMIT_MESSAGE = "Sorry, a script error occurred: Loop exceeded 10,000 steps";
export const SCRIPT_BUTTON = "Script";

/** Object, handler and line of a runtime error, one detail line each. */
export function scriptErrorDetails(stack: HexStack, error: HexRuntimeError): string[] {
  const object = error.objectId === undefined ? "unknown" : describeObject(stack, error.objectId) ?? `id ${error.objectId}`;
  const line = error.line !== undefined && error.line > 0 ? String(error.line) : "unknown";
  return [`Object: ${object}`, `Handler: ${error.handler ?? "unknown"}`, `Line: ${line}`];
}

export interface ScriptErrorReporterOptions {
  getStack: () => HexStack;
  modals: Pick<ModalManager, "alert" | "bomb">;
  /** Opens the script editor of `objectId` at `line` (the **Script** button). */
  openScript: (objectId: HexID, line: number) => void;
  /** Also receives every error, e.g. `console.error`. */
  log?: (error: unknown, message: HexMessage) => void;
}

/**
 * The message bus `onError`. Resolves once the dialog has been dismissed (and the editor opened
 * when **Script** was clicked).
 */
export function createScriptErrorReporter({ getStack, modals, openScript, log }: ScriptErrorReporterOptions) {
  return async (error: unknown, message: HexMessage): Promise<void> => {
    log?.(error, message);
    const stack = getStack();
    if (error instanceof HexVmGasLimitError) {
      await modals.bomb(GAS_LIMIT_MESSAGE, { details: scriptErrorDetails(stack, error) });
      return;
    }
    if (error instanceof HexRuntimeError) {
      const objectId = error.objectId;
      const canOpen = objectId !== undefined && findObject(stack, objectId) !== undefined;
      const choice = await modals.alert(error.message, {
        details: scriptErrorDetails(stack, error),
        buttons: canOpen ? [SCRIPT_BUTTON, "OK"] : ["OK"],
      });
      if (choice === SCRIPT_BUTTON && objectId !== undefined) openScript(objectId, error.line ?? 0);
      return;
    }
    await modals.alert(`Sorry, an unexpected error occurred while handling "${message.name}".`, {
      details: [error instanceof Error ? error.message : String(error)],
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Script text helpers
// ---------------------------------------------------------------------------------------------

/** Tab width of the script editor (`tab-size` in system7.css). */
export const SCRIPT_TAB_SIZE = 2;
/** Script editor metrics at 1x: Pixel Operator Mono 16 px advances 8 px per character. */
export const SCRIPT_CHAR_WIDTH = 8;
export const SCRIPT_LINE_HEIGHT = 16;
export const SCRIPT_PADDING = 4;

/** Start and end offsets of 1-based `line` (clamped to the existing lines), without its "\n". */
export function lineSpan(source: string, line: number): { start: number; end: number } {
  let start = 0;
  for (let current = 1; current < line; current++) {
    const newline = source.indexOf("\n", start);
    if (newline < 0) break;
    start = newline + 1;
  }
  const newline = source.indexOf("\n", start);
  return { start, end: newline < 0 ? source.length : newline };
}

/** Offset of 1-based `line` and `column` (UTF-16 units, as the parser counts), clamped to the line. */
export function offsetAt(source: string, line: number, column: number): number {
  const { start, end } = lineSpan(source, line);
  return Math.min(end, start + Math.max(0, column - 1));
}

/** Character cell (0-based) where 1-based `column` of `lineText` is drawn, with tabs expanded. */
export function visualColumn(lineText: string, column: number, tabSize = SCRIPT_TAB_SIZE): number {
  let cell = 0;
  const limit = Math.min(Math.max(0, column - 1), lineText.length);
  for (let i = 0; i < limit; i++) cell = lineText[i] === "\t" ? (Math.floor(cell / tabSize) + 1) * tabSize : cell + 1;
  return cell + Math.max(0, column - 1 - lineText.length);
}

/** Where each compile error is marked in the editor: 0-based row and character cell. */
export function errorMarkers(source: string, errors: readonly HexCompileError[]): { row: number; cell: number }[] {
  return errors.map((error) => {
    const { start, end } = lineSpan(source, error.line);
    return { row: error.line - 1, cell: visualColumn(source.slice(start, end), error.column) };
  });
}

export function formatCompileError(error: HexCompileError): string {
  return `Line ${error.line}, column ${error.column}: ${error.message}`;
}

// ---------------------------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------------------------

const CHECKBOX_OFF: readonly string[] = [
  "................",
  "................",
  "..############..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..#..........#..",
  "..############..",
  "................",
  "................",
];

/** The System 7 check box: an X from corner to corner inside the box. */
export const CHECKBOX_ON: readonly string[] = CHECKBOX_OFF.map((row, y) => {
  if (y < 3 || y > 12) return row;
  const cells = [...row];
  cells[y] = "#";
  cells[15 - y] = "#";
  return cells.join("");
});

function CheckProperty({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  const k = useUiScale();
  return (
    <button type="button" className="s7-checkbox" role="checkbox" aria-checked={checked} onClick={() => onChange(!checked)}>
      <PixelIcon rows={checked ? CHECKBOX_ON : CHECKBOX_OFF} scale={k} />
      <span>{label}</span>
    </button>
  );
}

function ChoiceProperty<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly T[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="s7-form-row">
      <span className="s7-form-label">{label}</span>
      <div className="s7-choices" role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={String(option)}
            type="button"
            className="s7-choice"
            role="radio"
            aria-checked={option === value}
            onClick={() => onChange(option)}
          >
            {String(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * A text box that commits on Enter or when it loses the focus. `onCommit` returns false to reject
 * the text, which then reverts to `value`.
 */
function TextProperty({ label, value, onCommit, width }: { label: string; value: string; onCommit: (text: string) => boolean; width?: number }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const commit = (): void => {
    if (text !== value && !onCommit(text)) setText(value);
  };
  const k = useUiScale();
  return (
    <label className="s7-form-row">
      <span className="s7-form-label">{label}</span>
      <input
        className="s7-input"
        type="text"
        value={text}
        spellCheck={false}
        style={width === undefined ? undefined : { width: width * k }}
        onChange={(event) => setText(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          }
        }}
      />
    </label>
  );
}

const INTEGER = /^\s*-?\d+\s*$/;

/** An integer in `min..max`, or undefined. */
export function parseInteger(text: string, min: number, max: number): number | undefined {
  if (!INTEGER.test(text)) return undefined;
  const value = Number(text.trim());
  return value >= min && value <= max ? value : undefined;
}

const BUTTON_STYLES: readonly ButtonStyle[] = ["transparent", "opaque", "rectangle", "roundRect", "shadow", "checkBox", "radioButton", "default"];
const FIELD_STYLES: readonly FieldStyle[] = ["transparent", "opaque", "rectangle", "shadow", "scrolling"];
const TEXT_FONTS: readonly HexFieldPart["textFont"][] = ["System", "Sans", "Mono", "Serif"];
const TEXT_SIZES: readonly HexFieldPart["textSize"][] = [9, 10, 12, 14, 18, 24];
const TEXT_ALIGNS: readonly HexFieldPart["textAlign"][] = ["left", "center", "right"];
const TEXT_STYLES: readonly HexFieldPart["textStyle"][number][] = ["bold", "italic", "underline", "outline", "shadow", "condense"];
/** Part coordinates are kept within a generous range around the 512x342 card. */
const COORDINATE_LIMIT = 4096;

// ---------------------------------------------------------------------------------------------
// Properties tab
// ---------------------------------------------------------------------------------------------

function PartProperties({ part, onChange }: { part: HexPart; onChange: (changes: ObjectChanges) => void }) {
  const rectInput = (label: string, key: "x" | "y" | "width" | "height") => (
    <TextProperty
      label={label}
      value={String(part.rect[key])}
      width={56}
      onCommit={(text) => {
        const extent = key === "width" || key === "height";
        const value = parseInteger(text, extent ? 1 : -COORDINATE_LIMIT, COORDINATE_LIMIT);
        if (value === undefined) return false;
        onChange({ rect: { ...part.rect, [key]: value } });
        return true;
      }}
    />
  );
  return (
    <>
      <TextProperty label="Name" value={part.name} onCommit={(name) => (onChange({ name }), true)} />
      <div className="s7-form-inline">
        {rectInput("Left", "x")}
        {rectInput("Top", "y")}
        {rectInput("Width", "width")}
        {rectInput("Height", "height")}
      </div>
      <div className="s7-form-checks">
        <CheckProperty label="Visible" checked={part.visible} onChange={(visible) => onChange({ visible })} />
        <CheckProperty label="Enabled" checked={part.enabled} onChange={(enabled) => onChange({ enabled })} />
      </div>
      {part.type === "button" ? (
        <>
          <ChoiceProperty label="Style" options={BUTTON_STYLES} value={part.style} onChange={(style) => onChange({ style })} />
          <TextProperty label="Title" value={part.title} onCommit={(title) => (onChange({ title }), true)} />
          <div className="s7-form-checks">
            <CheckProperty label="Show Name" checked={part.showName} onChange={(showName) => onChange({ showName })} />
            <CheckProperty label="Auto Hilite" checked={part.autoHilite} onChange={(autoHilite) => onChange({ autoHilite })} />
            <CheckProperty label="Hilite" checked={part.hilite} onChange={(hilite) => onChange({ hilite })} />
          </div>
          <TextProperty
            label="Family (0 = none)"
            value={String(part.family ?? 0)}
            width={40}
            onCommit={(text) => {
              const family = parseInteger(text, 0, 15);
              if (family === undefined) return false;
              onChange({ family: family === 0 ? undefined : family });
              return true;
            }}
          />
        </>
      ) : (
        <>
          <ChoiceProperty label="Style" options={FIELD_STYLES} value={part.style} onChange={(style) => onChange({ style })} />
          <div className="s7-form-checks">
            <CheckProperty label="Lock Text" checked={part.lockText} onChange={(lockText) => onChange({ lockText })} />
            {part.layerScope === "background" ? (
              <CheckProperty label="Shared Text" checked={part.sharedText} onChange={(sharedText) => onChange({ sharedText })} />
            ) : null}
            <CheckProperty label="Don't Wrap" checked={part.dontWrap} onChange={(dontWrap) => onChange({ dontWrap })} />
            <CheckProperty label="Show Lines" checked={part.showLines} onChange={(showLines) => onChange({ showLines })} />
          </div>
          <ChoiceProperty label="Font" options={TEXT_FONTS} value={part.textFont} onChange={(textFont) => onChange({ textFont })} />
          <ChoiceProperty label="Size" options={TEXT_SIZES} value={part.textSize} onChange={(textSize) => onChange({ textSize })} />
          <ChoiceProperty label="Align" options={TEXT_ALIGNS} value={part.textAlign} onChange={(textAlign) => onChange({ textAlign })} />
          <div className="s7-form-row">
            <span className="s7-form-label">Text Style</span>
            <div className="s7-form-checks">
              {TEXT_STYLES.map((style) => (
                <CheckProperty
                  key={style}
                  label={style}
                  checked={part.textStyle.includes(style)}
                  onChange={(on) => onChange({
                    textStyle: on ? TEXT_STYLES.filter((s) => s === style || part.textStyle.includes(s)) : part.textStyle.filter((s) => s !== style),
                  })}
                />
              ))}
            </div>
          </div>
        </>
      )}
    </>
  );
}

function PropertiesPanel({ found, onChange }: { found: InspectedObject; onChange: (changes: ObjectChanges) => void }) {
  const nameInput = <TextProperty label="Name" value={found.object.name} onCommit={(name) => (onChange({ name }), true)} />;
  switch (found.kind) {
    case "part":
      return <PartProperties part={found.object} onChange={onChange} />;
    case "card":
      return (
        <>
          {nameInput}
          <div className="s7-form-checks">
            <CheckProperty label="Marked" checked={found.object.marked} onChange={(marked) => onChange({ marked })} />
            <CheckProperty label="Don't Search" checked={found.object.dontSearch} onChange={(dontSearch) => onChange({ dontSearch })} />
            <CheckProperty label="Can't Delete" checked={found.object.cantDelete} onChange={(cantDelete) => onChange({ cantDelete })} />
          </div>
        </>
      );
    case "background":
      return (
        <>
          {nameInput}
          <div className="s7-form-checks">
            <CheckProperty label="Can't Delete" checked={found.object.cantDelete} onChange={(cantDelete) => onChange({ cantDelete })} />
          </div>
        </>
      );
    case "stack":
      return (
        <>
          {nameInput}
          <TextProperty label="Author" value={found.object.author} onCommit={(author) => (onChange({ author }), true)} />
        </>
      );
  }
}

// ---------------------------------------------------------------------------------------------
// HexTalk Script tab (Requirement 3.2)
// ---------------------------------------------------------------------------------------------

interface ScriptEditorProps {
  text: string;
  dirty: boolean;
  errors: readonly HexCompileError[];
  onChange: (text: string) => void;
  onSave: () => void;
  onRevert: () => void;
  /** 1-based line to select once the editor is shown (the **Script** button of an error alert). */
  focusLine?: number;
  onFocused: () => void;
}

export function ScriptEditor({ text, dirty, errors, onChange, onSave, onRevert, focusLine, onFocused }: ScriptEditorProps) {
  const k = useUiScale();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ top: 0, left: 0 });
  const lineCount = text.split("\n").length;
  const errorLines = new Set(errors.map((error) => error.line));
  const markers = errorMarkers(text, errors);

  /** Selects `start..end` and scrolls its line to the middle of the editor. */
  const reveal = (line: number, start: number, end: number): void => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(start, end);
    textarea.scrollTop = Math.max(0, (line - 1) * SCRIPT_LINE_HEIGHT * k - textarea.clientHeight / 2);
  };

  useLayoutEffect(() => {
    if (focusLine === undefined) return;
    if (focusLine > 0) {
      const { start, end } = lineSpan(text, focusLine);
      reveal(focusLine, start, end);
    } else {
      textareaRef.current?.focus({ preventScroll: true });
    }
    onFocused();
    // Only when a line is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusLine]);

  const onScroll = (): void => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (gutterRef.current) gutterRef.current.scrollTop = textarea.scrollTop;
    setScroll({ top: textarea.scrollTop, left: textarea.scrollLeft });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      onSave();
    }
  };

  const status = dirty
    ? "Not saved"
    : errors.length === 0
      ? "Compiled without errors"
      : `${errors.length} compile error${errors.length === 1 ? "" : "s"}`;

  return (
    <div className="s7-script">
      <div className="s7-script-editor">
        <div ref={gutterRef} className="s7-script-gutter" aria-hidden="true">
          {Array.from({ length: lineCount }, (_, index) => (
            <div key={index} className={errorLines.has(index + 1) ? "s7-script-line s7-script-line-error" : "s7-script-line"}>
              {index + 1}
            </div>
          ))}
        </div>
        <div className="s7-script-area">
          <textarea
            ref={textareaRef}
            className="s7-script-text"
            aria-label="HexTalk script"
            value={text}
            wrap="off"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            onChange={(event) => onChange(event.target.value)}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
          />
          <div className="s7-script-markers" aria-hidden="true">
            {markers.map((marker, index) => (
              <span
                key={index}
                className="s7-script-marker"
                data-testid="compile-error-marker"
                style={{
                  left: (SCRIPT_PADDING + marker.cell * SCRIPT_CHAR_WIDTH) * k - scroll.left,
                  top: (SCRIPT_PADDING + marker.row * SCRIPT_LINE_HEIGHT + SCRIPT_LINE_HEIGHT - 2) * k - scroll.top,
                  width: SCRIPT_CHAR_WIDTH * k,
                  height: 2 * k,
                }}
              />
            ))}
          </div>
        </div>
      </div>
      <p className="s7-script-status" role="status">
        {status}
      </p>
      {errors.length > 0 ? (
        <ul className="s7-script-errors" aria-label="Compile errors">
          {errors.map((error, index) => (
            <li key={index}>
              <button
                type="button"
                className="s7-script-error"
                onClick={() => {
                  const offset = offsetAt(text, error.line, error.column);
                  reveal(error.line, offset, offset);
                }}
              >
                {formatCompileError(error)}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="s7-dialog-buttons">
        <button type="button" className="s7-button" disabled={!dirty} onClick={onRevert}>
          Revert
          <PushButtonArt isDefault={false} />
        </button>
        <button type="button" className="s7-button s7-button-default" onClick={onSave}>
          Save
          <PushButtonArt isDefault />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Inspector window (Requirement 3.1)
// ---------------------------------------------------------------------------------------------

/**
 * Fixed size of the inspector window at 1x (frame included), the same for every tab; drawn at
 * k times this size. Whenever the 1x UI fits at all, computeUiScale leaves a desktop of at least
 * (512 + 4)k x (342 + 4)k below the menu bar, so 480k x 328k always fits inside the window's CSS
 * limit (desktop minus 16k), with 9k to spare above and below. The tab panels scroll inside it
 * (the Properties form, the script editor, the compile-error list); the Revert / Save row never
 * moves out of the window.
 */
export const INSPECTOR_WIDTH = 480;
export const INSPECTOR_HEIGHT = 328;
/** Space the window keeps free in the desktop (`max-width` / `max-height` of .s7-window), at 1x. */
export const WINDOW_DESKTOP_MARGIN = 16;

export interface ObjectInspectorProps {
  store: Pick<UiStore, "subscribe" | "getSnapshot" | "getCompiled">;
  history: Pick<HexHistory, "execute">;
  request: InspectorRequest;
  onClose: () => void;
  /** Content of the HexAI Spellcaster tab (spec 04 task 5). */
  renderSpellcaster?: (objectId: HexID) => ReactNode;
}

export function ObjectInspector({ store, history, request, onClose, renderSpellcaster }: ObjectInspectorProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const k = useUiScale();
  const [tab, setTab] = useState<InspectorTab>(request.tab);
  /** Unsaved script text; null while the editor shows the stored `scriptSource`. */
  const [draft, setDraft] = useState<string | null>(null);
  const [pendingLine, setPendingLine] = useState(request.line);
  const found = findObject(state.stack, request.objectId);
  const missing = found === undefined;

  // The object was removed (undo of its creation, another stack loaded): close the inspector.
  useEffect(() => {
    if (missing) onClose();
  }, [missing, onClose]);
  if (!found) return null;

  const objectId = request.objectId;
  const saved = found.object.scriptSource;
  const text = draft ?? saved;
  const save = (): void => {
    history.execute(createScriptCommand(objectId, text));
    setDraft(null);
  };

  return (
    <System7Window
      title={`Object Inspector: ${describeObject(state.stack, objectId) ?? objectId}`}
      className="s7-inspector"
      layoutKey={tab}
      style={{ width: INSPECTOR_WIDTH * k, height: INSPECTOR_HEIGHT * k }}
      onClose={onClose}
    >
      <div className="s7-tabs" role="tablist" aria-label="Object Inspector">
        {INSPECTOR_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            className="s7-tab"
            role="tab"
            aria-selected={tab === entry.id}
            onClick={() => setTab(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div className={`s7-tab-panel s7-tab-panel-${tab}`} role="tabpanel" aria-label={INSPECTOR_TABS.find((entry) => entry.id === tab)?.label}>
        {tab === "properties" ? (
          <div className="s7-form">
            <PropertiesPanel found={found} onChange={(changes) => history.execute(createPropertiesCommand(objectId, changes))} />
          </div>
        ) : tab === "script" ? (
          <ScriptEditor
            text={text}
            dirty={draft !== null && draft !== saved}
            errors={store.getCompiled(objectId).errors}
            onChange={setDraft}
            onSave={save}
            onRevert={() => setDraft(null)}
            focusLine={pendingLine}
            onFocused={() => setPendingLine(undefined)}
          />
        ) : renderSpellcaster ? (
          renderSpellcaster(objectId)
        ) : (
          <p className="s7-inspector-note">The HexAI Spellcaster is not available yet.</p>
        )}
      </div>
    </System7Window>
  );
}
