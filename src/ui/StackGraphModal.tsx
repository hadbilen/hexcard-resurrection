/**
 * Stack Graph (spec 04 task 4, Requirement 3.5; design.md §1; hexcard_design_spec.md §7.5): every
 * card as a node with a 1-bit thumbnail, and an arrow for every `go` with a statically known
 * target.
 *
 * - Edges come from the compiled ASTs in the store's ScriptCache. A `GoToCard` counts when its
 *   target is a literal (`go card "Hall"`, `go card 3`, `go card id "crd_1"`, resolved exactly as
 *   the VM resolves them) or relative (`next`, `prev`, `first`, `last`, resolved from the card the
 *   script runs on). `go back` and computed targets are not static and draw no arrow.
 * - A script runs on: its card (card scripts and card parts), every card of its background
 *   (background scripts and parts), or every card (the stack script).
 * - Thumbnails are the composed card frame reduced 4x: a block is dark when any of its pixels is
 *   dark, so 1-px lines and text stay visible, and the result stays 1-bit (steering tech.md,
 *   1-Bit Fidelity Rules).
 */
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { HexCardTarget, HexScriptAST, HexStatementNode } from "../core/ast.ts";
import { resolveRelativeCard } from "../core/messageBus.ts";
import type { HexID, HexStack } from "../core/schema.ts";
import type { CompiledScript, HexRuntimeState } from "../core/store.ts";
import { resolveObjectTarget } from "../core/vm.ts";
import { composeFrame, packOpaqueColour, type PartRasterizer } from "../engine/graphics/bitmapCanvas.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH } from "../engine/graphics/rleCodec.ts";
import { System7Window, useUiScale, type UiStore } from "./System7Shell.tsx";

// ---------------------------------------------------------------------------------------------
// Edges
// ---------------------------------------------------------------------------------------------

export interface StackGraphEdge {
  from: HexID;
  to: HexID;
}

function collectFrom(statements: readonly HexStatementNode[], out: HexCardTarget[]): void {
  for (const statement of statements) {
    if (statement.kind === "GoToCard") out.push(statement.target);
    else if (statement.kind === "IfCondition") {
      collectFrom(statement.thenBranch, out);
      if (statement.elseBranch) collectFrom(statement.elseBranch, out);
    } else if (statement.kind === "RepeatLoop") collectFrom(statement.body, out);
  }
}

/** Targets of every `go` in `ast`, in source order, including those inside `if` and `repeat`. */
export function collectGoTargets(ast: HexScriptAST): HexCardTarget[] {
  const out: HexCardTarget[] = [];
  for (const handler of Object.values(ast.handlers)) collectFrom(handler.body, out);
  return out;
}

/** The card `target` names when the script runs on card `fromCardId`, or undefined when not static. */
export function staticGoTarget(stack: HexStack, fromCardId: HexID, target: HexCardTarget): HexID | undefined {
  const state: HexRuntimeState = {
    stack, currentCardId: fromCardId, editLayer: "card", tool: "browse", selectedPartId: null, found: null, fatBits: null,
  };
  if (target.type === "relative") return target.dir === "back" ? undefined : resolveRelativeCard(state, target.dir);
  if (target.value.kind !== "Literal") return undefined;
  try {
    const found = resolveObjectTarget(
      state,
      { objectType: "card", selector: { by: target.type, value: target.value.value } },
      fromCardId,
    );
    return found.kind === "card" ? found.card.id : undefined;
  } catch {
    return undefined; // no such card: the `go` fails at run time, so there is no arrow
  }
}

/** Every distinct (from, to) pair of static `go` targets, in stack order. Self-links are kept. */
export function buildStackGraphEdges(stack: HexStack, getCompiled: (objectId: HexID) => CompiledScript): StackGraphEdge[] {
  const edges: StackGraphEdge[] = [];
  const seen = new Set<string>();
  const add = (scriptOwnerId: HexID, cardIds: readonly HexID[]): void => {
    const targets = collectGoTargets(getCompiled(scriptOwnerId).ast);
    for (const from of cardIds) {
      for (const target of targets) {
        const to = staticGoTarget(stack, from, target);
        if (to === undefined) continue;
        const key = JSON.stringify([from, to]);
        if (seen.has(key)) continue;
        seen.add(key);
        edges.push({ from, to });
      }
    }
  };
  const allCards = stack.cards.map((card) => card.id);
  add(stack.id, allCards);
  for (const background of stack.backgrounds) {
    const cards = stack.cards.filter((card) => card.backgroundId === background.id).map((card) => card.id);
    add(background.id, cards);
    for (const part of background.parts) add(part.id, cards);
  }
  for (const card of stack.cards) {
    add(card.id, [card.id]);
    for (const part of card.parts) add(part.id, [card.id]);
  }
  return edges;
}

// ---------------------------------------------------------------------------------------------
// Thumbnails
// ---------------------------------------------------------------------------------------------

export const THUMBNAIL_REDUCTION = 4;
export const THUMBNAIL_WIDTH = Math.ceil(BITMAP_WIDTH / THUMBNAIL_REDUCTION); // 128
export const THUMBNAIL_HEIGHT = Math.ceil(BITMAP_HEIGHT / THUMBNAIL_REDUCTION); // 86

/**
 * Reduces a composed 512x342 frame (1 = light, 2 = dark) to THUMBNAIL_WIDTH x THUMBNAIL_HEIGHT
 * by OR-downsampling: each 4x4 block (partial blocks at the bottom edge) is dark (2) when any of
 * its pixels is dark, otherwise light (1). 1-px lines, text and single dark pixels survive; dark
 * areas and fine patterns get bolder.
 */
export function reduceFrame(frame: Uint8Array): Uint8Array {
  if (frame.length !== BITMAP_WIDTH * BITMAP_HEIGHT) throw new Error(`Expected a ${BITMAP_WIDTH}x${BITMAP_HEIGHT} frame`);
  const out = new Uint8Array(THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT).fill(1);
  for (let y = 0; y < BITMAP_HEIGHT; y++) {
    const row = Math.floor(y / THUMBNAIL_REDUCTION) * THUMBNAIL_WIDTH;
    for (let x = 0; x < BITMAP_WIDTH; x++) {
      if (frame[y * BITMAP_WIDTH + x] === 2) out[row + Math.floor(x / THUMBNAIL_REDUCTION)] = 2;
    }
  }
  return out;
}

/** The 1-bit thumbnail of one card (states 1 = light, 2 = dark). */
export function createCardThumbnail(stack: HexStack, cardId: HexID, rasterizePart?: PartRasterizer): Uint8Array {
  return reduceFrame(composeFrame(stack, cardId, {}, rasterizePart));
}

/** A card miniature (1 = light, 2 = dark) at UI scale k; also used by the Recent window (spec 06). */
export function ThumbnailCanvas({ pixels, palette }: { pixels: Uint8Array; palette: HexStack["themePalette"] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const k = useUiScale();
  useEffect(() => {
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const image = ctx.createImageData(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
    const out = new Uint32Array(image.data.buffer);
    const dark = packOpaqueColour(palette.darkBitHex);
    const light = packOpaqueColour(palette.lightBitHex);
    for (let i = 0; i < pixels.length; i++) out[i] = pixels[i] === 2 ? dark : light;
    ctx.putImageData(image, 0, 0);
  }, [pixels, palette.darkBitHex, palette.lightBitHex]);
  return (
    <canvas
      ref={canvasRef}
      className="s7-graph-thumbnail"
      width={THUMBNAIL_WIDTH}
      height={THUMBNAIL_HEIGHT}
      style={{ width: THUMBNAIL_WIDTH * k, height: THUMBNAIL_HEIGHT * k }}
      aria-hidden="true"
    />
  );
}

// ---------------------------------------------------------------------------------------------
// Layout (1x units; drawn k times larger)
// ---------------------------------------------------------------------------------------------

export const GRAPH_COLUMNS = 3;
export const NODE_LABEL_HEIGHT = 16;
/** Node box: 1 px frame, thumbnail, 1 px rule, label row, 1 px frame. */
export const NODE_WIDTH = THUMBNAIL_WIDTH + 2;
export const NODE_HEIGHT = THUMBNAIL_HEIGHT + NODE_LABEL_HEIGHT + 3;
export const NODE_GAP_X = 48;
export const NODE_GAP_Y = 40;
/** Room around the grid for self-link loops. */
export const GRAPH_MARGIN = 24;

export interface GraphNodeBox {
  cardId: HexID;
  x: number;
  y: number;
}

export interface StackGraphLayout {
  nodes: GraphNodeBox[];
  width: number;
  height: number;
}

/** Cards left to right, top to bottom, GRAPH_COLUMNS per row. */
export function layoutStackGraph(cardIds: readonly HexID[]): StackGraphLayout {
  const columns = Math.max(1, Math.min(GRAPH_COLUMNS, cardIds.length));
  const rows = Math.max(1, Math.ceil(cardIds.length / columns));
  return {
    nodes: cardIds.map((cardId, index) => ({
      cardId,
      x: GRAPH_MARGIN + (index % columns) * (NODE_WIDTH + NODE_GAP_X),
      y: GRAPH_MARGIN + Math.floor(index / columns) * (NODE_HEIGHT + NODE_GAP_Y),
    })),
    width: 2 * GRAPH_MARGIN + columns * NODE_WIDTH + (columns - 1) * NODE_GAP_X,
    height: 2 * GRAPH_MARGIN + rows * NODE_HEIGHT + (rows - 1) * NODE_GAP_Y,
  };
}

export interface Point {
  x: number;
  y: number;
}

/** Space left between an arrow end and the node frame. */
const ARROW_GAP = 2;
const ARROW_LENGTH = 7;
const ARROW_HALF_WIDTH = 3.5;
/** Two opposite arrows between the same nodes are moved this far apart. */
const PARALLEL_OFFSET = 3;

/** Distance from a node centre along unit vector (ux, uy) to its frame. */
function exitDistance(ux: number, uy: number): number {
  const tx = ux === 0 ? Infinity : NODE_WIDTH / 2 / Math.abs(ux);
  const ty = uy === 0 ? Infinity : NODE_HEIGHT / 2 / Math.abs(uy);
  return Math.min(tx, ty);
}

/**
 * The visible part of an arrow between two distinct nodes: from the frame of `from` to the frame
 * of `to` (ARROW_GAP outside both), moved sideways by PARALLEL_OFFSET when `offset` is set.
 */
export function arrowSegment(from: GraphNodeBox, to: GraphNodeBox, offset: boolean): { start: Point; end: Point } {
  const c1 = { x: from.x + NODE_WIDTH / 2, y: from.y + NODE_HEIGHT / 2 };
  const c2 = { x: to.x + NODE_WIDTH / 2, y: to.y + NODE_HEIGHT / 2 };
  const dx = c2.x - c1.x;
  const dy = c2.y - c1.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  const shift = offset ? PARALLEL_OFFSET : 0;
  const nx = -uy * shift;
  const ny = ux * shift;
  const reach = exitDistance(ux, uy) + ARROW_GAP;
  const snap = (value: number): number => Math.round(value) + 0.5;
  return {
    start: { x: snap(c1.x + ux * reach + nx), y: snap(c1.y + uy * reach + ny) },
    end: { x: snap(c2.x - ux * reach + nx), y: snap(c2.y - uy * reach + ny) },
  };
}

/** Arrowhead triangle at `end`, pointing away from `start`. */
export function arrowHead(start: Point, end: Point): Point[] {
  const length = Math.hypot(end.x - start.x, end.y - start.y) || 1;
  const ux = (end.x - start.x) / length;
  const uy = (end.y - start.y) / length;
  const bx = end.x - ux * ARROW_LENGTH;
  const by = end.y - uy * ARROW_LENGTH;
  return [end, { x: bx - uy * ARROW_HALF_WIDTH, y: by + ux * ARROW_HALF_WIDTH }, { x: bx + uy * ARROW_HALF_WIDTH, y: by - ux * ARROW_HALF_WIDTH }];
}

/** A self-link: a square hook from the top edge round the top-right corner back to the right edge. */
export function selfLoopPath(node: GraphNodeBox): { points: Point[]; head: Point[] } {
  const right = node.x + NODE_WIDTH;
  const points = [
    { x: right - 20.5, y: node.y - ARROW_GAP },
    { x: right - 20.5, y: node.y - 12.5 },
    { x: right + 12.5, y: node.y - 12.5 },
    { x: right + 12.5, y: node.y + 16.5 },
    { x: right + ARROW_GAP, y: node.y + 16.5 },
  ];
  return { points, head: arrowHead(points[3], points[4]) };
}

const toPoints = (points: readonly Point[]): string => points.map((point) => `${point.x},${point.y}`).join(" ");

// ---------------------------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------------------------

export interface StackGraphModalProps {
  store: Pick<UiStore, "subscribe" | "getSnapshot" | "getCompiled">;
  onClose: () => void;
  /** Rasterizer for the thumbnails; defaults to partRenderer.ts's. */
  rasterizePart?: PartRasterizer;
}

function cardLabel(name: string, index: number): string {
  return name || `Card ${index + 1}`;
}

export function StackGraphModal({ store, onClose, rasterizePart }: StackGraphModalProps) {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { stack } = state;
  const k = useUiScale();
  const thumbnails = useMemo(
    () => new Map(stack.cards.map((card) => [card.id, createCardThumbnail(stack, card.id, rasterizePart)])),
    [stack, rasterizePart],
  );
  // The ScriptCache follows the stack, so the stack identity is the cache key.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const edges = useMemo(() => buildStackGraphEdges(stack, store.getCompiled), [stack]);
  const layout = useMemo(() => layoutStackGraph(stack.cards.map((card) => card.id)), [stack]);
  const boxes = new Map(layout.nodes.map((node) => [node.cardId, node]));
  const edgeKeys = new Set(edges.map((edge) => `${edge.from}\n${edge.to}`));
  const labels = new Map(stack.cards.map((card, index) => [card.id, cardLabel(card.name, index)]));

  return (
    <System7Window title={`Stack Graph: ${stack.name || "Untitled"}`} className="s7-graph-window" onClose={onClose}>
      <div className="s7-graph" style={{ width: layout.width * k, height: layout.height * k }}>
        <ul className="s7-graph-nodes" aria-label="Cards">
          {layout.nodes.map((node, index) => {
            const targets = edges.filter((edge) => edge.from === node.cardId).map((edge) => labels.get(edge.to) ?? edge.to);
            const label = labels.get(node.cardId) ?? node.cardId;
            const current = node.cardId === state.currentCardId;
            return (
              <li
                key={node.cardId}
                className={current ? "s7-graph-node s7-graph-node-current" : "s7-graph-node"}
                style={{ left: node.x * k, top: node.y * k, width: NODE_WIDTH * k, height: NODE_HEIGHT * k }}
                aria-label={targets.length > 0 ? `${label}, goes to ${targets.join(", ")}` : label}
                aria-current={current ? "true" : undefined}
                data-card-index={index + 1}
              >
                <ThumbnailCanvas pixels={thumbnails.get(node.cardId)!} palette={stack.themePalette} />
                <span className="s7-graph-label">{label}</span>
              </li>
            );
          })}
        </ul>
        <svg
          className="s7-graph-arrows"
          width={layout.width * k}
          height={layout.height * k}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          shapeRendering="crispEdges"
          aria-hidden="true"
          focusable="false"
        >
          {edges.map((edge) => {
            const from = boxes.get(edge.from);
            const to = boxes.get(edge.to);
            if (!from || !to) return null;
            const key = `${edge.from}\n${edge.to}`;
            if (from === to) {
              const loop = selfLoopPath(from);
              return (
                <g key={key} data-testid="graph-arrow">
                  <polyline points={toPoints(loop.points)} />
                  <polygon points={toPoints(loop.head)} />
                </g>
              );
            }
            const { start, end } = arrowSegment(from, to, edgeKeys.has(`${edge.to}\n${edge.from}`));
            return (
              <g key={key} data-testid="graph-arrow">
                <line x1={start.x} y1={start.y} x2={end.x} y2={end.y} />
                <polygon points={toPoints(arrowHead(start, end))} />
              </g>
            );
          })}
        </svg>
      </div>
    </System7Window>
  );
}
