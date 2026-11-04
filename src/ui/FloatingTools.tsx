/**
 * Tear-off tools palette: a draggable System 7 window holding the 12 tools of design spec §2.1
 * (2 columns x 6 rows of 1-bit SVG icons) and the 8x8 pattern selector.
 * Requirements: spec 04 2.3. Design: .kiro/specs/04-ui-audio-showcase/design.md §1.
 *
 * The component reads the current tool through `useSyncExternalStore` and selects tools with
 * `store.setTool` (UI state only). The selected pattern is owned by the caller (the paint
 * controller's `getSettings` reads it), so it is a controlled prop here.
 */
import { useEffect, useRef, useSyncExternalStore, type PointerEvent as ReactPointerEvent } from "react";
import type { AuthoringTool } from "../core/schema.ts";
import { PATTERNS, type Pattern } from "../engine/graphics/patterns.ts";
import type { UiStore } from "./System7Shell.tsx";

// ---------------------------------------------------------------------------------------------
// 1-bit pixel art -> SVG path
// ---------------------------------------------------------------------------------------------

/** Icon size in pixels; icons are drawn 1:1 so every icon pixel is one device pixel. */
export const ICON_SIZE = 16;

/**
 * SVG path data for rows of pixel art, `#` = dark pixel and anything else = light. Horizontal runs
 * become one `M x y h n v1 h-n z` rectangle each, so the path stays small and has no diagonals.
 */
export function pixelRowsToPath(rows: readonly string[]): string {
  const commands: string[] = [];
  rows.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== "#") {
        x++;
        continue;
      }
      const start = x;
      while (x < row.length && row[x] === "#") x++;
      const length = x - start;
      commands.push(`M${start} ${y}h${length}v1h-${length}z`);
    }
  });
  return commands.join("");
}

/** SVG path data of an 8x8 pattern: bit 1 = dark pixel (same bit order as `patternBit`). */
export function patternToPath(pattern: Pattern): string {
  const rows: string[] = [];
  for (let y = 0; y < 8; y++) {
    let row = "";
    for (let x = 0; x < 8; x++) row += ((pattern[y] >> (7 - x)) & 1) === 1 ? "#" : ".";
    rows.push(row);
  }
  return pixelRowsToPath(rows);
}

// ---------------------------------------------------------------------------------------------
// The 12 tools (hexcard_design_spec.md §2.1 `AuthoringTool`)
// ---------------------------------------------------------------------------------------------

export interface ToolDefinition {
  id: AuthoringTool;
  label: string;
  /** 16 rows of 16 characters; `#` is a dark pixel. */
  icon: readonly string[];
}

/** Palette order: row by row, two tools per row. */
export const TOOLS: readonly ToolDefinition[] = [
  {
    id: "browse",
    label: "Browse",
    icon: [
      "................",
      ".......##.......",
      "......#..#......",
      "......#..#.##...",
      "......#..#.#.##.",
      ".##...#..#.#.#.#",
      "#..#..#........#",
      "#..#...........#",
      ".#..#..........#",
      "..#..#........#.",
      "...#..........#.",
      "....#........#..",
      "....#........#..",
      ".....#......#...",
      ".....########...",
      "................",
    ],
  },
  {
    id: "button",
    label: "Button",
    icon: [
      "................",
      "................",
      "................",
      "..############..",
      ".#............#.",
      "#..............#",
      "#...########...#",
      "#..............#",
      "#...########...#",
      "#..............#",
      ".#............#.",
      "..############..",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    id: "field",
    label: "Field",
    icon: [
      "................",
      "................",
      ".##############.",
      ".#............#.",
      ".#.####.......#.",
      ".#............#.",
      ".#.#######....#.",
      ".#............#.",
      ".#.####.......#.",
      ".#............#.",
      ".#.#######....#.",
      ".#............#.",
      ".##############.",
      "................",
      "................",
      "................",
    ],
  },
  {
    id: "select",
    label: "Select",
    icon: [
      "................",
      "................",
      ".#.#.#.#.#.#.#..",
      "................",
      ".#...........#..",
      "................",
      ".#...........#..",
      "................",
      ".#...........#..",
      "................",
      ".#...........#..",
      "................",
      ".#.#.#.#.#.#.#..",
      "................",
      "................",
      "................",
    ],
  },
  {
    id: "lasso",
    label: "Lasso",
    icon: [
      "................",
      ".....######.....",
      "...##......##...",
      "..#..........#..",
      ".#............#.",
      ".#............#.",
      ".#............#.",
      "..#..........#..",
      "...##......##...",
      ".....######.....",
      "......#.........",
      ".......#........",
      "......#.........",
      ".......#........",
      "......##........",
      "................",
    ],
  },
  {
    id: "pencil",
    label: "Pencil",
    icon: [
      "................",
      "...........##...",
      "..........#..#..",
      ".........#.#.##.",
      "........#.#.##..",
      ".......#.#.##...",
      "......#.#.##....",
      ".....#.#.##.....",
      "....#.#.##......",
      "...#.#.##.......",
      "..#.#.##........",
      "..#.##..........",
      "..###...........",
      "................",
      "................",
      "................",
    ],
  },
  {
    id: "brush",
    label: "Brush",
    icon: [
      "................",
      "............##..",
      "...........####.",
      "..........####..",
      ".........####...",
      "........####....",
      ".......####.....",
      "......###.......",
      "....####........",
      "...#....#.......",
      "..#......#......",
      "..#......#......",
      "...#....#.......",
      "....####........",
      "................",
      "................",
    ],
  },
  {
    id: "eraser",
    label: "Eraser",
    icon: [
      "................",
      "................",
      "................",
      ".........#######",
      "........#.....#.",
      ".......#.....#..",
      "......#######...",
      ".....#.....#....",
      "....#.....#.....",
      "...#######......",
      "................",
      ".##############.",
      "................",
      "................",
      "................",
      "................",
    ],
  },
  {
    id: "line",
    label: "Line",
    icon: [
      "................",
      "................",
      "..............##",
      ".............##.",
      "............##..",
      "...........##...",
      "..........##....",
      ".........##.....",
      "........##......",
      ".......##.......",
      "......##........",
      ".....##.........",
      "....##..........",
      "...##...........",
      "................",
      "................",
    ],
  },
  {
    id: "spray",
    label: "Spray",
    icon: [
      "................",
      "..........#...#.",
      "........#...#...",
      ".....##....#...#",
      "....#..#..#.....",
      ".....##.........",
      "..####..........",
      "..#..#..........",
      ".######.........",
      ".#....#.........",
      ".#.##.#.........",
      ".#....#.........",
      ".#.##.#.........",
      ".#....#.........",
      ".######.........",
      "................",
    ],
  },
  {
    id: "rect",
    label: "Rectangle",
    icon: [
      "................",
      "................",
      "................",
      ".##############.",
      ".#............#.",
      ".#............#.",
      ".#............#.",
      ".#............#.",
      ".#............#.",
      ".#............#.",
      ".#............#.",
      ".#............#.",
      ".##############.",
      "................",
      "................",
      "................",
    ],
  },
  {
    id: "paintBucket",
    label: "Paint Bucket",
    icon: [
      "................",
      ".....######.....",
      "....#......#....",
      "....#......#....",
      "..############..",
      "..#..........#..",
      "..#..........#..",
      "..#.########.#..",
      "..#..........#..",
      "...#........#...",
      "...#........#...",
      "....########....",
      "................",
      "................",
      "................",
      "................",
    ],
  },
];

/** Pixel art of one tool icon, for tests and for other 16x16 glyphs. */
export function PixelIcon({ rows, scale = 1 }: { rows: readonly string[]; scale?: number }) {
  return (
    <svg
      className="s7-icon"
      width={ICON_SIZE * scale}
      height={ICON_SIZE * scale}
      viewBox={`0 0 ${ICON_SIZE} ${ICON_SIZE}`}
      shapeRendering="crispEdges"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={pixelRowsToPath(rows)} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Dragging and placement
// ---------------------------------------------------------------------------------------------

export interface Point {
  x: number;
  y: number;
}

/** Height of the menu bar in CSS pixels (kept in sync with `.s7-menubar` in system7.css). */
export const MENU_BAR_HEIGHT = 24;
/** Part of a palette that must stay inside the window so the title bar can always be grabbed. */
export const PALETTE_GRAB = 32;

/** Keeps a palette's top-left corner where its title bar is still reachable below the menu bar. */
export function clampPaletteOrigin(origin: Point, viewport: { width: number; height: number }): Point {
  const x = Math.min(Math.max(origin.x, PALETTE_GRAB - 64), Math.max(viewport.width - PALETTE_GRAB, 0));
  const y = Math.min(Math.max(origin.y, MENU_BAR_HEIGHT), Math.max(viewport.height - PALETTE_GRAB, MENU_BAR_HEIGHT));
  return { x, y };
}

/**
 * Follows the pointer on `window` until it is released: `onMove` receives
 * `origin + (pointer - start)`. Returns a function that stops following (also called on release).
 */
export function beginPointerDrag(
  start: Point,
  origin: Point,
  onMove: (position: Point) => void,
  onEnd?: () => void,
): () => void {
  const move = (event: PointerEvent): void => {
    onMove({ x: origin.x + event.clientX - start.x, y: origin.y + event.clientY - start.y });
  };
  const stop = (): void => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    window.removeEventListener("pointercancel", end);
  };
  const end = (): void => {
    stop();
    onEnd?.();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end);
  window.addEventListener("pointercancel", end);
  return stop;
}

// ---------------------------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------------------------

export interface FloatingToolsProps {
  store: UiStore;
  /** Index into `PATTERNS` of the pattern used by brush, line, rect, spray and bucket. */
  patternIndex: number;
  onPatternChange: (index: number) => void;
  /** Top-left corner of the palette window in viewport pixels. */
  position: Point;
  onPositionChange: (position: Point) => void;
  onClose: () => void;
}

export function FloatingTools({ store, patternIndex, onPatternChange, position, onPositionChange, onClose }: FloatingToolsProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const stopDrag = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDrag.current?.(), []);

  const onTitlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    stopDrag.current?.();
    stopDrag.current = beginPointerDrag(
      { x: event.clientX, y: event.clientY },
      position,
      (next) => onPositionChange(clampPaletteOrigin(next, { width: window.innerWidth, height: window.innerHeight })),
    );
  };

  return (
    <div className="s7-palette" role="dialog" aria-label="Tools" style={{ left: position.x, top: position.y }}>
      <div className="s7-palette-title" onPointerDown={onTitlePointerDown}>
        <button
          type="button"
          className="s7-close-box"
          aria-label="Close tools palette"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={onClose}
        />
        <span className="s7-palette-title-text">Tools</span>
      </div>
      <div className="s7-tool-grid" role="toolbar" aria-label="Tools">
        {TOOLS.map((tool) => (
          <button
            key={tool.id}
            type="button"
            className="s7-tool"
            data-tool={tool.id}
            title={tool.label}
            aria-label={tool.label}
            aria-pressed={state.tool === tool.id}
            onClick={() => store.setTool(tool.id)}
          >
            <PixelIcon rows={tool.icon} />
          </button>
        ))}
      </div>
      <div className="s7-pattern-grid" role="radiogroup" aria-label="Patterns">
        {PATTERNS.map((pattern, index) => (
          <button
            key={index}
            type="button"
            role="radio"
            className="s7-pattern"
            data-pattern={index}
            title={`Pattern ${index + 1}`}
            aria-label={`Pattern ${index + 1}`}
            aria-checked={patternIndex === index}
            onClick={() => onPatternChange(index)}
          >
            <svg width={8} height={8} viewBox="0 0 8 8" shapeRendering="crispEdges" fill="currentColor" aria-hidden="true" focusable="false">
              <path d={patternToPath(pattern)} />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
