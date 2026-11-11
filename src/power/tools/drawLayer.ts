// draw_layer (spec 07 Requirement 11; design §tools/drawLayer.ts). Draws a list of rectangles,
// lines, sprites and texts on the base of a card or background layer and returns the canonical
// rleData. Rectangles go through plotRectShape and lines through bresenhamLine (the paint tools'
// code), patterns through PATTERNS and patternState, text through renderCrisp1BitText on the Node
// text backend. It runs no script and keeps nothing between calls. Pure TypeScript: no Node
// module, no DOM.

import type { HexLayer } from "../../core/store.ts";
import { bresenhamLine, plotRectShape } from "../../engine/graphics/paintTools.ts";
import { PATTERNS, patternState } from "../../engine/graphics/patterns.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, TOTAL_PIXELS, encodeBitmapRLE } from "../../engine/graphics/rleCodec.ts";
import {
  cssFontString,
  renderCrisp1BitText,
  type LogicalFont,
  type TextAlign,
  type TextSize,
  type TextStyle,
} from "../../engine/graphics/textRaster.ts";
import { checkArguments, type ArgSchema } from "../argumentCheck.ts";
import { createNodeTextBackend, uncoveredCharacters, type ParsedFaces } from "../nodeTextBackend.ts";
import { cappedList, shortenMessage, toolResult, type CallToolResult } from "../results.ts";
import type { ToolSteps } from "./index.ts";

/** Requirement 5.3: the most drawing commands in one call. */
export const MAX_COMMANDS = 256;
/** Requirement 5.3: the most characters of sprite rows and texts in one call. */
export const MAX_DRAW_TEXT_CHARACTERS = 65_536;

export type DrawCommand =
  | { op: "rect"; x: number; y: number; width: number; height: number; pattern?: number; filled?: boolean }
  | { op: "line"; x1: number; y1: number; x2: number; y2: number; pattern?: number }
  | { op: "sprite"; x: number; y: number; rows: string[] }
  | {
      op: "text";
      x: number;
      y: number;
      text: string;
      width?: number;
      height?: number;
      font?: LogicalFont;
      size?: TextSize;
      style?: TextStyle[];
      align?: TextAlign;
      wrap?: boolean;
      ink?: "dark" | "light";
    };

const LAYER_SIZE = `${BITMAP_WIDTH} x ${BITMAP_HEIGHT}`;

/**
 * The rules of Requirement 11.10 that the inputSchema cannot express, for commands that passed it:
 * a shape, sprite or text box that does not lie wholly inside the layer, and sprite rows of
 * different lengths. Every entry is `commands[i]...: <rule>`, in command order.
 */
export function checkDrawCommands(commands: readonly DrawCommand[]): string[] {
  const errors: string[] = [];
  commands.forEach((command, i) => {
    const path = `commands[${i}]`;
    switch (command.op) {
      case "rect":
        if (command.x + command.width > BITMAP_WIDTH || command.y + command.height > BITMAP_HEIGHT) {
          errors.push(`${path}: the rectangle must lie inside the ${LAYER_SIZE} layer`);
        }
        break;
      case "line":
        break; // both ends are inside the layer by the inputSchema
      case "sprite": {
        const length = command.rows[0].length;
        command.rows.forEach((row, j) => {
          if (row.length !== length) errors.push(`${path}.rows[${j}]: must have the same length as rows[0] (${length} characters)`);
        });
        if (command.x + length > BITMAP_WIDTH || command.y + command.rows.length > BITMAP_HEIGHT) {
          errors.push(`${path}: the sprite must lie inside the ${LAYER_SIZE} layer`);
        }
        break;
      }
      case "text": {
        const width = command.width ?? BITMAP_WIDTH - command.x;
        const height = command.height ?? BITMAP_HEIGHT - command.y;
        if (command.x + width > BITMAP_WIDTH || command.y + height > BITMAP_HEIGHT) {
          errors.push(`${path}: the text box must lie inside the ${LAYER_SIZE} layer`);
        }
        break;
      }
    }
  });
  return errors;
}

/** A command that passes the inputSchema; it stands in for every item while the call's own fields are checked. */
const PLACEHOLDER_COMMAND = { op: "rect", x: 0, y: 0, width: 1, height: 1 };

/** Moves an entry about the only command of a one-command check to the command's real position. */
const atPosition = (entry: string, index: number): string => entry.replace(/^commands\[0\]/, `commands[${index}]`);

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The characters of every `rows` entry and `text` value of the call, wherever they are valid or not. */
function drawnCharacters(commands: readonly unknown[]): number {
  let total = 0;
  for (const command of commands) {
    if (typeof command !== "object" || command === null) continue;
    const { op, rows, text } = command as Record<string, unknown>;
    if (op === "sprite" && Array.isArray(rows)) {
      for (const row of rows) if (typeof row === "string") total += row.length;
    } else if (op === "text" && typeof text === "string") {
      total += text.length;
    }
  }
  return total;
}

/**
 * The tool's checkArguments (Requirements 4.5, 11.10; design §tools/drawLayer.ts), in this order:
 * the call's own fields (unknown arguments, `layer`, the length of `commands`); then each command in
 * order, with its schema branch and, when that passed, `steps.checkDrawCommands` for that command;
 * last the call's total of sprite-row and text characters.
 */
export function checkDrawLayerArguments(
  schema: Extract<ArgSchema, { type: "object" }>,
  args: Record<string, unknown>,
  steps: Pick<ToolSteps, "checkDrawCommands">,
): string[] {
  const commands = args.commands;
  const list = Array.isArray(commands) ? (commands as unknown[]) : undefined;
  // The call's own fields are checked with a valid command in place of each item, so only they can report.
  const own: Record<string, unknown> = { ...args };
  if (Object.prototype.hasOwnProperty.call(args, "commands")) {
    own.commands = list === undefined ? commands : list.map(() => PLACEHOLDER_COMMAND);
  }
  const errors = checkArguments(schema, own);
  if (list === undefined) return errors;
  try {
    list.forEach((command, i) => {
      // A one-command call has the same rules as the command inside the list, at position 0.
      const broken = checkArguments(schema, { layer: "card", commands: [command] }).map((entry) => atPosition(entry, i));
      errors.push(...broken);
      if (broken.length === 0) errors.push(...steps.checkDrawCommands([command as DrawCommand]).map((entry) => atPosition(entry, i)));
    });
  } catch (error) {
    // Requirement 5.4: the step threw, so the commands were not checked; this is the one entry.
    return [shortenMessage(`commands: The drawing commands could not be checked: ${messageOf(error)}`)];
  }
  const total = drawnCharacters(list);
  if (total > MAX_DRAW_TEXT_CHARACTERS) {
    errors.push(`commands: the sprite rows and texts have ${total} characters in all, more than ${MAX_DRAW_TEXT_CHARACTERS}`);
  }
  return errors;
}

export interface DrawnLayer {
  /** TOTAL_PIXELS states: 0 transparent, 1 light, 2 dark. */
  pixels: Uint8Array;
  notes: string[];
  uncovered: { path: string; character: string }[];
}

/** Draws on the base of `layer` in list order (Requirement 11.1). Pure; text goes through the Node text backend. */
export function drawCommands(layer: HexLayer, commands: readonly DrawCommand[], faces: ParsedFaces): DrawnLayer {
  const pixels = new Uint8Array(TOTAL_PIXELS).fill(layer === "card" ? 0 : 1);
  const notes: string[] = [];
  const uncovered: { path: string; character: string }[] = [];
  const backend = createNodeTextBackend(faces);
  const set = (x: number, y: number, state: number): void => {
    if (x >= 0 && y >= 0 && x < BITMAP_WIDTH && y < BITMAP_HEIGHT) pixels[y * BITMAP_WIDTH + x] = state;
  };

  commands.forEach((command, i) => {
    const path = `commands[${i}]`;
    switch (command.op) {
      case "rect": {
        const pattern = PATTERNS[command.pattern ?? 1];
        const plot = (x: number, y: number): void => set(x, y, patternState(pattern, x, y));
        plotRectShape(command.x, command.y, command.x + command.width - 1, command.y + command.height - 1, command.filled ?? false, plot);
        break;
      }
      case "line": {
        const pattern = PATTERNS[command.pattern ?? 1];
        bresenhamLine(command.x1, command.y1, command.x2, command.y2, (x, y) => set(x, y, patternState(pattern, x, y)));
        break;
      }
      case "sprite":
        command.rows.forEach((row, dy) => {
          for (let dx = 0; dx < row.length; dx++) set(command.x + dx, command.y + dy, row[dx] === "#" ? 2 : 1);
        });
        break;
      case "text": {
        const font = command.font ?? "Sans";
        const size = command.size ?? 12;
        const style = command.style ?? [];
        const width = command.width ?? BITMAP_WIDTH - command.x;
        const height = command.height ?? BITMAP_HEIGHT - command.y;
        const result = renderCrisp1BitText(
          command.text,
          font,
          size,
          style,
          { x: command.x, y: command.y, width, height },
          command.align ?? "left",
          command.wrap ?? true,
          backend,
        );
        const ink = command.ink === "light" ? 1 : 2;
        for (let dy = 0; dy < height; dy++) {
          for (let dx = 0; dx < width; dx++) {
            if (result.mask[dy * width + dx] === 2) set(command.x + dx, command.y + dy, ink);
          }
        }
        // Requirement 11.9: a line with ink that is wider than the box or ends below it does not fit.
        const misfits = result.lineBoxes.filter(
          (box) => box.width >= 1 && (box.width > width || box.y - command.y + box.height > height),
        ).length;
        if (misfits > 0) {
          const lines = misfits === 1 ? "1 line of the text does not fit" : `${misfits} lines of the text do not fit`;
          notes.push(`${path}: ${lines} in its box; make the box larger, the text shorter or the size smaller`);
        }
        // Requirement 10.5: each distinct uncovered character once per command.
        for (const character of uncoveredCharacters(faces, command.text, cssFontString(font, size, style.includes("bold")))) {
          uncovered.push({ path, character });
        }
        break;
      }
    }
  });
  return { pixels, notes, uncovered };
}

/** Requirements 11.7 and 11.8. The arguments passed checkDrawLayerArguments. */
export async function runDrawLayer(args: Record<string, unknown>, faces: ParsedFaces): Promise<CallToolResult> {
  const layer = args.layer as HexLayer;
  const { pixels, notes, uncovered } = drawCommands(layer, args.commands as DrawCommand[], faces);
  const base = layer === "card" ? 0 : 1;
  let lightPixels = 0;
  let darkPixels = 0;
  let changed = false;
  for (const state of pixels) {
    if (state === 1) lightPixels++;
    else if (state === 2) darkPixels++;
    if (state !== base) changed = true;
  }
  // The base of a background is not the empty fill of the codec, so "equals the base" is checked here:
  // "" is the canonical layer for it, and decodeBitmapRLE("") gives the base back for either kind.
  const rleData = changed ? encodeBitmapRLE(pixels) : "";
  return toolResult({
    ok: true,
    layer,
    rleData,
    lightPixels,
    darkPixels,
    ...cappedList("notes", notes),
    ...cappedList("uncoveredCharacters", uncovered),
  });
}
