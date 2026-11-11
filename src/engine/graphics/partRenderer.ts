// Part rasterizer and geometric hit testing. Canonical contract: hexcard_design_spec.md §5.6 and
// spec 03 design.md §3.
//
// Buttons and fields are drawn into the 1-bit frame (states 1 = light, 2 = dark) with 1-px lines;
// their text goes through `renderCrisp1BitText`, never DOM text. Highlighting (autoHilite press,
// hilite, checkbox/radio marks), the field caret and the field selection are drawn by inverting
// frame pixels. Every write is clipped to the part's rect and to the frame.
//
// Pure TypeScript: the only browser dependency is the text backend of textRaster.ts, which is
// created lazily and can be replaced (tests pass a fixed-metric stub).

import type { HexButtonPart, HexFieldPart, HexID, HexPart, HexRect, HexStack } from "../../core/schema.ts";
import { ICON_SIZE, decodeIcon, isIconData } from "../../core/icons.ts";
import type { EditingState, PartDrawContext, PartRasterizer } from "./bitmapCanvas.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH } from "./rleCodec.ts";
import {
  type TextLineBox,
  type TextRasterBackend,
  cssFontString,
  getDefaultBackend,
  layoutText,
  lineMetrics,
  renderCrisp1BitText,
} from "./textRaster.ts";

const LIGHT = 1;
const DARK = 2;

/** Width of the solid drop shadow on the right and bottom edges of `shadow` buttons and fields. */
export const SHADOW_OFFSET = 2;
/** Width of a scrolling field's scrollbar, including the borders it shares with the field frame. */
export const SCROLLBAR_WIDTH = 16;
/** Buttons have no text properties in schema 2.0.0; titles use HyperCard's default Chicago 12 look. */
export const BUTTON_TEXT = { font: "System", size: 12 } as const;
/** Field text inset from the part rect (border + margin). */
export const FIELD_TEXT_INSET = { left: 4, right: 4, top: 2, bottom: 2 } as const;

// ---------------------------------------------------------------------------------------------
// Clipping and pixel helpers
// ---------------------------------------------------------------------------------------------

/** Half-open pixel box [x0, x1) x [y0, y1). */
interface Clip {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function rectClip(r: HexRect): Clip {
  return {
    x0: Math.max(0, r.x),
    y0: Math.max(0, r.y),
    x1: Math.min(BITMAP_WIDTH, r.x + r.width),
    y1: Math.min(BITMAP_HEIGHT, r.y + r.height),
  };
}

function intersect(a: Clip, b: Clip): Clip {
  return { x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) };
}

const inClip = (c: Clip, x: number, y: number): boolean => x >= c.x0 && x < c.x1 && y >= c.y0 && y < c.y1;

function setPx(frame: Uint8Array, clip: Clip, x: number, y: number, v: number): void {
  if (inClip(clip, x, y)) frame[y * BITMAP_WIDTH + x] = v;
}

function invertPx(frame: Uint8Array, clip: Clip, x: number, y: number): void {
  if (inClip(clip, x, y)) {
    const i = y * BITMAP_WIDTH + x;
    frame[i] = frame[i] === DARK ? LIGHT : DARK;
  }
}

function fillBox(frame: Uint8Array, clip: Clip, x0: number, y0: number, x1: number, y1: number, v: number): void {
  const c = intersect(clip, { x0, y0, x1, y1 });
  for (let y = c.y0; y < c.y1; y++) frame.fill(v, y * BITMAP_WIDTH + c.x0, y * BITMAP_WIDTH + Math.max(c.x0, c.x1));
}

function invertBox(frame: Uint8Array, clip: Clip, x0: number, y0: number, x1: number, y1: number): void {
  const c = intersect(clip, { x0, y0, x1, y1 });
  for (let y = c.y0; y < c.y1; y++) for (let x = c.x0; x < c.x1; x++) invertPx(frame, clip, x, y);
}

/** Copies the ink (state 2) of a rect-local text mask into the frame. */
function blitInk(
  frame: Uint8Array,
  clip: Clip,
  mask: Uint8Array,
  rect: HexRect,
  allow?: (x: number, y: number) => boolean,
): void {
  for (let my = 0; my < rect.height; my++) {
    const y = rect.y + my;
    if (y < clip.y0 || y >= clip.y1) continue;
    for (let mx = 0; mx < rect.width; mx++) {
      if (mask[my * rect.width + mx] !== DARK) continue;
      const x = rect.x + mx;
      if (inClip(clip, x, y) && (!allow || allow(x, y))) frame[y * BITMAP_WIDTH + x] = DARK;
    }
  }
}

/**
 * 50% checkerboard of disabled parts (Requirement 3.4), world-aligned like the patterns:
 * a disabled part's text ink is kept only where this returns true.
 */
export const dimmedInk = (x: number, y: number): boolean => ((x + y) & 1) === 0;

// ---------------------------------------------------------------------------------------------
// Shapes: per-pixel classification of a part's chrome
// ---------------------------------------------------------------------------------------------

const OUT = 0; // untouched
const BORDER = 1; // dark line
const INSIDE = 2; // light fill (if filled); inverted by highlighting; may receive text
const GAP = 3; // light fill (if filled); not inverted (between the two borders of `default`)
const SHADE = 4; // dark drop shadow

interface Shape {
  w: number;
  h: number;
  cls: Uint8Array;
}

const CHAR_CLASS: Readonly<Record<string, number>> = { o: OUT, "#": BORDER, ".": INSIDE };

function shapeFromRows(rows: readonly string[]): Shape {
  const h = rows.length;
  const w = rows[0].length;
  const cls = new Uint8Array(w * h);
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) cls[y * w + x] = CHAR_CLASS[row[x]];
  });
  return { w, h, cls };
}

function filledShape(w: number, h: number): Shape {
  return { w, h, cls: new Uint8Array(w * h).fill(INSIDE) };
}

function rectShape(w: number, h: number): Shape {
  const s = filledShape(w, h);
  if (w === 0 || h === 0) return s;
  for (let x = 0; x < w; x++) {
    s.cls[x] = BORDER;
    s.cls[(h - 1) * w + x] = BORDER;
  }
  for (let y = 0; y < h; y++) {
    s.cls[y * w] = BORDER;
    s.cls[y * w + w - 1] = BORDER;
  }
  return s;
}

/** Fixed 1-bit top-left corner of `roundRect`, mirrored to the other three corners. */
const ROUND_CORNER: readonly string[] = [
  "ooo##",
  "o##..",
  "o#...",
  "#....",
  "#....",
];
const ROUND_MIN = 2 * ROUND_CORNER.length; // smaller rects fall back to square corners

function roundRectShape(w: number, h: number): Shape {
  const s = rectShape(w, h);
  if (w < ROUND_MIN || h < ROUND_MIN) return s;
  const n = ROUND_CORNER.length;
  for (let cy = 0; cy < n; cy++) {
    for (let cx = 0; cx < n; cx++) {
      const c = CHAR_CLASS[ROUND_CORNER[cy][cx]];
      s.cls[cy * w + cx] = c;
      s.cls[cy * w + (w - 1 - cx)] = c;
      s.cls[(h - 1 - cy) * w + cx] = c;
      s.cls[(h - 1 - cy) * w + (w - 1 - cx)] = c;
    }
  }
  return s;
}

/** Inset of the inner border of `default` from its outer border. */
const DEFAULT_RING = 3;

/** `default`: an outer and an inner round-rect border with a light gap between them. */
function defaultShape(w: number, h: number): Shape {
  const outer = roundRectShape(w, h);
  const iw = w - 2 * DEFAULT_RING;
  const ih = h - 2 * DEFAULT_RING;
  if (iw < ROUND_MIN || ih < ROUND_MIN) return outer;
  for (let i = 0; i < outer.cls.length; i++) if (outer.cls[i] === INSIDE) outer.cls[i] = GAP;
  const inner = roundRectShape(iw, ih);
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iw; x++) {
      const c = inner.cls[y * iw + x];
      if (c !== OUT) outer.cls[(y + DEFAULT_RING) * w + x + DEFAULT_RING] = c;
    }
  }
  return outer;
}

/** A rectangle body `SHADOW_OFFSET` px smaller than the rect, with its shadow filling the rest. */
function shadowShape(w: number, h: number): Shape {
  const s = SHADOW_OFFSET;
  const bw = w - s;
  const bh = h - s;
  if (bw < 1 || bh < 1) return rectShape(w, h);
  const body = rectShape(bw, bh);
  const cls = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < bw && y < bh) cls[y * w + x] = body.cls[y * bw + x];
      else if (x >= s && y >= s) cls[y * w + x] = SHADE;
    }
  }
  return { w, h, cls };
}

function drawShape(frame: Uint8Array, clip: Clip, ox: number, oy: number, shape: Shape, fill: boolean): void {
  for (let y = 0; y < shape.h; y++) {
    for (let x = 0; x < shape.w; x++) {
      const c = shape.cls[y * shape.w + x];
      if (c === BORDER || c === SHADE) setPx(frame, clip, ox + x, oy + y, DARK);
      else if (fill && (c === INSIDE || c === GAP)) setPx(frame, clip, ox + x, oy + y, LIGHT);
    }
  }
}

function invertInside(frame: Uint8Array, clip: Clip, ox: number, oy: number, shape: Shape): void {
  for (let y = 0; y < shape.h; y++) {
    for (let x = 0; x < shape.w; x++) if (shape.cls[y * shape.w + x] === INSIDE) invertPx(frame, clip, ox + x, oy + y);
  }
}

/** Bounding box of the INSIDE pixels, in shape coordinates (half-open), or null. */
function insideBox(shape: Shape): Clip | null {
  let x0 = shape.w;
  let y0 = shape.h;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < shape.h; y++) {
    for (let x = 0; x < shape.w; x++) {
      if (shape.cls[y * shape.w + x] !== INSIDE) continue;
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + 1);
      y1 = Math.max(y1, y + 1);
    }
  }
  return x1 > x0 ? { x0, y0, x1, y1 } : null;
}

// ---------------------------------------------------------------------------------------------
// Checkbox and radio button glyphs (12 x 12)
// ---------------------------------------------------------------------------------------------

const CHECK_SIZE = 12;
/** Gap between the left edge of the rect and the box, and between the box and the title. */
const CHECK_MARGIN = 2;
const CHECK_TITLE_GAP = 4;

const CHECKBOX_SHAPE = rectShape(CHECK_SIZE, CHECK_SIZE);
const RADIO_SHAPE = shapeFromRows([
  "oooo####oooo",
  "oo##....##oo",
  "o#........#o",
  "o#........#o",
  "#..........#",
  "#..........#",
  "#..........#",
  "#..........#",
  "o#........#o",
  "o#........#o",
  "oo##....##oo",
  "oooo####oooo",
]);

/** Checked mark of a checkbox: the two diagonals of the box interior. */
const CHECK_MARK = (() => {
  const m = new Uint8Array(CHECK_SIZE * CHECK_SIZE);
  for (let i = 1; i < CHECK_SIZE - 1; i++) {
    m[i * CHECK_SIZE + i] = 1;
    m[i * CHECK_SIZE + (CHECK_SIZE - 1 - i)] = 1;
  }
  return m;
})();

/** Selected mark of a radio button: a 6 x 6 dot in the centre. */
const RADIO_MARK = (() => {
  const dot = ["o####o", "######", "######", "######", "######", "o####o"];
  const m = new Uint8Array(CHECK_SIZE * CHECK_SIZE);
  dot.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) if (row[x] === "#") m[(y + 3) * CHECK_SIZE + x + 3] = 1;
  });
  return m;
})();

/** Pressed state: the ring of interior pixels next to the border (a thickened outline). */
function innerRing(shape: Shape): Uint8Array {
  const { w, h, cls } = shape;
  const m = new Uint8Array(w * h);
  const isBorder = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < w && y < h && cls[y * w + x] === BORDER;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (cls[y * w + x] !== INSIDE) continue;
      if (isBorder(x - 1, y) || isBorder(x + 1, y) || isBorder(x, y - 1) || isBorder(x, y + 1)) m[y * w + x] = 1;
    }
  }
  return m;
}

const CHECKBOX_RING = innerRing(CHECKBOX_SHAPE);
const RADIO_RING = innerRing(RADIO_SHAPE);

// ---------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------

function buttonShape(style: HexButtonPart["style"], w: number, h: number): { shape: Shape; fill: boolean } {
  switch (style) {
    case "transparent":
      return { shape: filledShape(w, h), fill: false };
    case "opaque":
      return { shape: filledShape(w, h), fill: true };
    case "rectangle":
      return { shape: rectShape(w, h), fill: true };
    case "roundRect":
      return { shape: roundRectShape(w, h), fill: true };
    case "shadow":
      return { shape: shadowShape(w, h), fill: true };
    case "default":
      return { shape: defaultShape(w, h), fill: true };
    case "checkBox":
    case "radioButton":
      throw new Error(`buttonShape: ${style} is drawn by drawCheckable`);
  }
}

function renderTitle(title: string, rect: HexRect, align: "left" | "center", backend: TextRasterBackend) {
  return renderCrisp1BitText(title, BUTTON_TEXT.font, BUTTON_TEXT.size, [], rect, align, false, backend);
}

/** Decoded icons by data string; cleared when it reaches ICON_CACHE_LIMIT entries. */
const ICON_CACHE_LIMIT = 256;
const iconCache = new Map<string, Uint8Array>();

/** Spec 06 Requirement 9: the decoded stack icon of a push button, or null when it has none. */
function buttonIcon(part: HexButtonPart, ctx: PartDrawContext): Uint8Array | null {
  const { iconId } = part;
  if (iconId === undefined || !Object.hasOwn(ctx.stack.customIcons, iconId)) return null;
  const data = ctx.stack.customIcons[iconId];
  const cached = iconCache.get(data);
  if (cached) return cached;
  if (!isIconData(data)) return null;
  if (iconCache.size >= ICON_CACHE_LIMIT) iconCache.clear();
  const pixels = decodeIcon(data);
  iconCache.set(data, pixels);
  return pixels;
}

/** Spec 07 Requirement 5.5: forgets every decoded icon (render_card calls it after every call). */
export function clearIconCache(): void {
  iconCache.clear();
}

/** Set bits become dark where `allow` permits (inside pixels, dimming); clear bits write nothing. */
function blitIcon(frame: Uint8Array, clip: Clip, icon: Uint8Array, ox: number, oy: number, allow: (x: number, y: number) => boolean): void {
  for (let iy = 0; iy < ICON_SIZE; iy++) {
    const py = oy + iy;
    if (py < clip.y0 || py >= clip.y1) continue;
    for (let ix = 0; ix < ICON_SIZE; ix++) {
      if (icon[iy * ICON_SIZE + ix] !== 1) continue;
      const px = ox + ix;
      if (inClip(clip, px, py) && allow(px, py)) frame[py * BITMAP_WIDTH + px] = DARK;
    }
  }
}

function drawPushButton(frame: Uint8Array, clip: Clip, part: HexButtonPart, ctx: PartDrawContext, getBackend: () => TextRasterBackend): void {
  const { x, y, width: w, height: h } = part.rect;
  const { shape, fill } = buttonShape(part.style, w, h);
  drawShape(frame, clip, x, y, shape, fill);

  const box = insideBox(shape);
  const dim = !part.enabled;
  const allow = (px: number, py: number): boolean =>
    shape.cls[(py - y) * w + (px - x)] === INSIDE && (!dim || dimmedInk(px, py));
  const withTitle = part.showName && ctx.text.length > 0;
  const icon = box ? buttonIcon(part, ctx) : null;
  if (box && icon) {
    // Spec 06 Requirement 9.1: icon and title line centred vertically as one block.
    const { lineHeight } = lineMetrics(BUTTON_TEXT.font, BUTTON_TEXT.size);
    const insideW = box.x1 - box.x0;
    const insideH = box.y1 - box.y0;
    const blockH = ICON_SIZE + (withTitle ? lineHeight : 0);
    const iconX = x + box.x0 + Math.floor((insideW - ICON_SIZE) / 2);
    const iconY = y + box.y0 + Math.max(0, Math.floor((insideH - blockH) / 2));
    blitIcon(frame, clip, icon, iconX, iconY, allow);
    if (withTitle) {
      const titleRect = { x: x + box.x0, y: iconY + ICON_SIZE, width: insideW, height: lineHeight };
      const { mask } = renderTitle(ctx.text, titleRect, "center", getBackend());
      blitInk(frame, clip, mask, titleRect, allow);
    }
  } else if (box && withTitle) {
    const { lineHeight } = lineMetrics(BUTTON_TEXT.font, BUTTON_TEXT.size);
    const lineRect = {
      x: x + box.x0,
      y: y + box.y0 + Math.floor((box.y1 - box.y0 - lineHeight) / 2),
      width: box.x1 - box.x0,
      height: lineHeight,
    };
    const { mask } = renderTitle(ctx.text, lineRect, "center", getBackend());
    blitInk(frame, clip, mask, lineRect, allow);
  }

  if (part.hilite || (part.autoHilite && ctx.pressed)) invertInside(frame, clip, x, y, shape);
}

function drawCheckable(frame: Uint8Array, clip: Clip, part: HexButtonPart, ctx: PartDrawContext, getBackend: () => TextRasterBackend): void {
  const { x, y, width: w, height: h } = part.rect;
  const radio = part.style === "radioButton";
  const shape = radio ? RADIO_SHAPE : CHECKBOX_SHAPE;
  const bx = x + CHECK_MARGIN;
  const by = y + Math.floor((h - CHECK_SIZE) / 2);
  drawShape(frame, clip, bx, by, shape, true);

  if (part.showName && ctx.text.length > 0) {
    const { lineHeight } = lineMetrics(BUTTON_TEXT.font, BUTTON_TEXT.size);
    const tx = bx + CHECK_SIZE + CHECK_TITLE_GAP;
    const lineRect = { x: tx, y: y + Math.floor((h - lineHeight) / 2), width: Math.max(0, x + w - tx), height: lineHeight };
    const { mask } = renderTitle(ctx.text, lineRect, "left", getBackend());
    blitInk(frame, clip, mask, lineRect, part.enabled ? undefined : dimmedInk);
  }

  const mark = part.hilite ? (radio ? RADIO_MARK : CHECK_MARK) : null;
  const ring = part.autoHilite && ctx.pressed ? (radio ? RADIO_RING : CHECKBOX_RING) : null;
  if (!mark && !ring) return;
  for (let i = 0; i < CHECK_SIZE * CHECK_SIZE; i++) {
    if (mark?.[i] || ring?.[i]) invertPx(frame, clip, bx + (i % CHECK_SIZE), by + Math.floor(i / CHECK_SIZE));
  }
}

// ---------------------------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------------------------

function fieldShape(style: HexFieldPart["style"], w: number, h: number): { shape: Shape; fill: boolean } {
  switch (style) {
    case "transparent":
      return { shape: filledShape(w, h), fill: false };
    case "opaque":
      return { shape: filledShape(w, h), fill: true };
    case "rectangle":
    case "scrolling":
      return { shape: rectShape(w, h), fill: true };
    case "shadow":
      return { shape: shadowShape(w, h), fill: true };
  }
}

/** The rect field text is laid out and clipped in (frame coordinates). */
export function fieldTextRect(part: HexFieldPart): HexRect {
  const { x, y, width, height } = part.rect;
  const shadow = part.style === "shadow" ? SHADOW_OFFSET : 0;
  const scrollbar = part.style === "scrolling" ? SCROLLBAR_WIDTH - 1 : 0; // shares the right border
  return {
    x: x + FIELD_TEXT_INSET.left,
    y: y + FIELD_TEXT_INSET.top,
    width: Math.max(0, width - shadow - scrollbar - FIELD_TEXT_INSET.left - FIELD_TEXT_INSET.right),
    height: Math.max(0, height - shadow - FIELD_TEXT_INSET.top - FIELD_TEXT_INSET.bottom),
  };
}

export interface FieldTextLayout {
  /** See `fieldTextRect`. */
  textRect: HexRect;
  /** Applied scroll offset in pixels: 0 unless the field is `scrolling`, clamped to [0, maxScroll]. */
  scroll: number;
  /** Largest useful scroll offset: content height minus visible height (0 for non-scrolling fields). */
  maxScroll: number;
  lineHeight: number;
  baselineOffset: number;
  /** Line boxes in frame coordinates (already shifted up by `scroll`), including hidden lines. */
  lineBoxes: TextLineBox[];
  /** Rasterized text, local to `maskRect` (only rows inside `textRect` are ever shown). */
  mask: Uint8Array;
  maskRect: HexRect;
  /** Advance width of a string in the field's font (the measure used for the layout). */
  measure: (s: string) => number;
}

export interface FieldLayoutOptions {
  /** Requested scroll offset in pixels (UI state, not persisted). Ignored unless `scrolling`. */
  scroll?: number;
  backend?: TextRasterBackend;
}

/** Lays out and rasterizes a field's text exactly as the renderer draws it. */
export function layoutFieldText(part: HexFieldPart, text: string, options: FieldLayoutOptions = {}): FieldTextLayout {
  const textRect = fieldTextRect(part);
  const backend = options.backend ?? getDefaultBackend();
  const css = cssFontString(part.textFont, part.textSize, part.textStyle.includes("bold"));
  const measure = (s: string): number => backend.measureText(s, css);
  const { lineHeight, baselineOffset } = lineMetrics(part.textFont, part.textSize);
  const wrap = !part.dontWrap;

  const requested = part.style === "scrolling" && Number.isFinite(options.scroll) ? Math.max(0, Math.floor(options.scroll!)) : 0;
  let scroll = 0;
  if (requested > 0) {
    const count = layoutText(text, textRect.width, wrap, measure).length;
    scroll = Math.min(requested, Math.max(0, count * lineHeight - textRect.height));
  }

  const maskRect = { x: textRect.x, y: textRect.y - scroll, width: textRect.width, height: textRect.height + scroll };
  const { mask, lineBoxes } = renderCrisp1BitText(text, part.textFont, part.textSize, part.textStyle, maskRect, part.textAlign, wrap, backend);
  const maxScroll = part.style === "scrolling" ? Math.max(0, lineBoxes.length * lineHeight - textRect.height) : 0;
  return { textRect, scroll, maxScroll, lineHeight, baselineOffset, lineBoxes, mask, maskRect, measure };
}

/** `showLines`: a world-aligned dotted rule on the baseline row of every line slot. */
function drawRules(frame: Uint8Array, textClip: Clip, textRect: HexRect, scroll: number, lineHeight: number, baselineOffset: number): void {
  const bottom = textRect.y + textRect.height;
  for (let k = Math.max(0, Math.floor(scroll / lineHeight) - 1); ; k++) {
    const top = textRect.y - scroll + k * lineHeight;
    if (top >= bottom) break;
    const row = top + baselineOffset;
    if (row < textClip.y0 || row >= textClip.y1) continue;
    for (let x = textClip.x0; x < textClip.x1; x++) if (((x + row) & 1) === 0) frame[row * BITMAP_WIDTH + x] = DARK;
  }
}

/** Outlined System 7 scroll arrow (pointing up); the down arrow is its vertical mirror. */
const ARROW_UP: readonly string[] = [
  ".....#.....",
  "....#.#....",
  "...#...#...",
  "..#.....#..",
  ".#.......#.",
  "####...####",
  "...#...#...",
  "...#...#...",
  "...#####...",
];

function drawArrow(frame: Uint8Array, clip: Clip, boxX: number, boxY: number, down: boolean): void {
  const inner = SCROLLBAR_WIDTH - 2;
  const ax = boxX + 1 + Math.floor((inner - ARROW_UP[0].length) / 2);
  const ay = boxY + 1 + Math.floor((inner - ARROW_UP.length) / 2);
  ARROW_UP.forEach((row, r) => {
    const y = ay + (down ? ARROW_UP.length - 1 - r : r);
    for (let c = 0; c < row.length; c++) if (row[c] === "#") setPx(frame, clip, ax + c, y, DARK);
  });
}

/** Minimum field height for the arrow boxes, and for arrows plus thumb. */
const SCROLL_ARROWS_MIN = 2 * SCROLLBAR_WIDTH;
const SCROLL_THUMB_MIN = 3 * SCROLLBAR_WIDTH - 2;

/**
 * 1-bit scrollbar on the right edge: arrow boxes at both ends; when the content overflows, a 50%
 * gray track with a 16-px thumb positioned by `scroll / maxScroll`, otherwise a light track.
 */
function drawScrollbar(frame: Uint8Array, clip: Clip, rect: HexRect, scroll: number, maxScroll: number): void {
  const { x, y, width: w, height: h } = rect;
  if (w < SCROLLBAR_WIDTH) return;
  const sx = x + w - SCROLLBAR_WIDTH; // left line of the scrollbar
  const right = x + w; // exclusive
  const bottom = y + h; // exclusive
  fillBox(frame, clip, sx, y, sx + 1, bottom, DARK);
  if (h < SCROLL_ARROWS_MIN) return;

  fillBox(frame, clip, sx, y + SCROLLBAR_WIDTH - 1, right, y + SCROLLBAR_WIDTH, DARK);
  fillBox(frame, clip, sx, bottom - SCROLLBAR_WIDTH, right, bottom - SCROLLBAR_WIDTH + 1, DARK);
  drawArrow(frame, clip, sx, y, false);
  drawArrow(frame, clip, sx, bottom - SCROLLBAR_WIDTH, true);

  if (maxScroll <= 0 || h < SCROLL_THUMB_MIN) return;
  const trackClip = intersect(clip, { x0: sx + 1, y0: y + SCROLLBAR_WIDTH, x1: right - 1, y1: bottom - SCROLLBAR_WIDTH });
  for (let py = trackClip.y0; py < trackClip.y1; py++) {
    for (let px = trackClip.x0; px < trackClip.x1; px++) frame[py * BITMAP_WIDTH + px] = ((px + py) & 1) === 0 ? DARK : LIGHT;
  }
  // The thumb shares its top/bottom lines with the arrow boxes at the ends of its travel.
  const travel = h - SCROLL_THUMB_MIN;
  const top = y + SCROLLBAR_WIDTH - 1 + Math.round((travel * Math.min(scroll, maxScroll)) / maxScroll);
  fillBox(frame, clip, sx + 1, top + 1, right - 1, top + SCROLLBAR_WIDTH - 1, LIGHT);
  fillBox(frame, clip, sx, top, right, top + 1, DARK);
  fillBox(frame, clip, sx, top + SCROLLBAR_WIDTH - 1, right, top + SCROLLBAR_WIDTH, DARK);
}

// ---------------------------------------------------------------------------------------------
// Editing: caret and selection (Requirement 4.2)
// ---------------------------------------------------------------------------------------------

/** Index of the line a caret at `index` is shown on (a soft-wrap boundary belongs to the next line). */
function caretLine(boxes: readonly TextLineBox[], index: number): number {
  let k = 0;
  for (let j = 0; j < boxes.length; j++) if (boxes[j].start <= index) k = j;
  return k;
}

function xAtIndex(layout: FieldTextLayout, text: string, box: TextLineBox, index: number): number {
  return box.x + Math.round(layout.measure(text.slice(box.start, Math.min(Math.max(index, box.start), box.end))));
}

/**
 * Inverts the caret (when `caret === selEnd`: a 1-px column just left of the caret position, one
 * line high) or the selection [min, max) (per line; a selection that continues past a line's end
 * extends to the right edge of the text rect, one that starts on an earlier line starts at its left edge).
 */
function drawEditing(frame: Uint8Array, clip: Clip, layout: FieldTextLayout, text: string, editing: EditingState): void {
  const clamp = (i: number): number => Math.min(text.length, Math.max(0, Number.isFinite(i) ? Math.floor(i) : 0));
  const a = clamp(editing.caret);
  const b = clamp(editing.selEnd);
  const boxes = layout.lineBoxes;
  const tr = layout.textRect;
  const textClip = intersect(clip, rectClip(tr));
  const lh = layout.lineHeight;

  if (a === b) {
    const box = boxes[caretLine(boxes, a)];
    const cx = xAtIndex(layout, text, box, a) - 1;
    const caretClip = { x0: clip.x0, x1: clip.x1, y0: textClip.y0, y1: textClip.y1 };
    invertBox(frame, caretClip, cx, box.y, cx + 1, box.y + lh);
    return;
  }

  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  boxes.forEach((box, k) => {
    const spanEnd = k + 1 < boxes.length ? boxes[k + 1].start : text.length;
    if (!(lo < spanEnd && hi > box.start)) return;
    const x0 = lo < box.start ? tr.x : xAtIndex(layout, text, box, lo);
    const x1 = hi > box.end ? tr.x + tr.width : xAtIndex(layout, text, box, hi);
    invertBox(frame, textClip, x0, box.y, x1, box.y + lh);
  });
}

/**
 * Spec 06 Requirement 4.8: the found-text box. The range [start, end) is split into per-line
 * segments exactly as a selection is (`drawEditing`); for each segment from x0 to x1 on a line with
 * top `top`, the 1-pixel outline from (x0 - 1, top) to (x1, top + lineHeight - 1) is inverted.
 * Horizontally it is clipped to the part rect (the left column lies 1 px left of the text), and
 * vertically to the text rect, so a line scrolled half out of view never inverts the field frame.
 */
function drawFound(frame: Uint8Array, clip: Clip, layout: FieldTextLayout, text: string, found: { start: number; end: number }): void {
  const clamp = (i: number): number => Math.min(text.length, Math.max(0, Number.isFinite(i) ? Math.floor(i) : 0));
  const lo = clamp(Math.min(found.start, found.end));
  const hi = clamp(Math.max(found.start, found.end));
  if (lo === hi) return;
  const boxes = layout.lineBoxes;
  const tr = layout.textRect;
  const textClip = intersect(clip, rectClip(tr));
  const boxClip = { x0: clip.x0, x1: clip.x1, y0: textClip.y0, y1: textClip.y1 };
  const lh = layout.lineHeight;
  boxes.forEach((box, k) => {
    const spanEnd = k + 1 < boxes.length ? boxes[k + 1].start : text.length;
    if (!(lo < spanEnd && hi > box.start)) return;
    const x0 = lo < box.start ? tr.x : xAtIndex(layout, text, box, lo);
    const x1 = hi > box.end ? tr.x + tr.width : xAtIndex(layout, text, box, hi);
    const left = x0 - 1;
    const top = box.y;
    const bottom = box.y + lh - 1;
    invertBox(frame, boxClip, left, top, x1 + 1, top + 1); // top row
    invertBox(frame, boxClip, left, bottom, x1 + 1, bottom + 1); // bottom row
    invertBox(frame, boxClip, left, top + 1, left + 1, bottom); // left column
    invertBox(frame, boxClip, x1, top + 1, x1 + 1, bottom); // right column
  });
}

/**
 * Spec 06 Requirement 4.10: the scroll offset that shows the line holding `index` of a `scrolling`
 * field. The current (clamped) offset when that line is fully visible, else
 * `min(maxScroll, lineIndex * lineHeight)`. Fields of other styles never scroll (0).
 */
export function fieldScrollToIndex(part: HexFieldPart, text: string, index: number, options: FieldLayoutOptions = {}): number {
  const layout = layoutFieldText(part, text, options);
  if (part.style !== "scrolling") return 0;
  const boxes = layout.lineBoxes;
  if (boxes.length === 0) return layout.scroll;
  const k = caretLine(boxes, Math.min(text.length, Math.max(0, Math.floor(index))));
  const top = boxes[k].y - layout.maskRect.y; // the line's top in unscrolled text coordinates
  const visible = top >= layout.scroll && top + layout.lineHeight <= layout.scroll + layout.textRect.height;
  return visible ? layout.scroll : Math.min(layout.maxScroll, top);
}

function nextCodePoint(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
    const d = text.charCodeAt(i + 1);
    if (d >= 0xdc00 && d <= 0xdfff) return i + 2;
  }
  return i + 1;
}

/**
 * Caret index for a click at frame point (`x`, `y`) in a field: the line under `y` (clamped to the
 * first/last line), then the code-point boundary nearest to `x` (ties go to the earlier index).
 * On a soft-wrapped line the line end is excluded, since that index is shown on the next line.
 * Used by the UI to place the hidden textarea's selection.
 */
export function fieldCaretIndexAt(part: HexFieldPart, text: string, x: number, y: number, options: FieldLayoutOptions = {}): number {
  const layout = layoutFieldText(part, text, options);
  const boxes = layout.lineBoxes;
  const k = Math.min(boxes.length - 1, Math.max(0, Math.floor((y - boxes[0].y) / layout.lineHeight)));
  const box = boxes[k];
  const softEnd = k + 1 < boxes.length && boxes[k + 1].start === box.end && box.end > box.start;
  let best = box.start;
  let bestDist = Infinity;
  for (let i = box.start; i <= box.end; i = nextCodePoint(text, i)) {
    if (softEnd && i === box.end) break;
    const dist = Math.abs(x - xAtIndex(layout, text, box, i));
    if (dist < bestDist) {
      best = i;
      bestDist = dist;
    }
    if (i === box.end) break;
  }
  return best;
}

function drawField(
  frame: Uint8Array,
  clip: Clip,
  part: HexFieldPart,
  ctx: PartDrawContext,
  getBackend: () => TextRasterBackend,
  requestedScroll: number,
): void {
  const { x, y, width: w, height: h } = part.rect;
  const { shape, fill } = fieldShape(part.style, w, h);
  drawShape(frame, clip, x, y, shape, fill);

  const tr = fieldTextRect(part);
  const textClip = intersect(clip, rectClip(tr));
  const layout =
    ctx.text.length > 0 || ctx.editing ? layoutFieldText(part, ctx.text, { scroll: requestedScroll, backend: getBackend() }) : null;
  const { lineHeight, baselineOffset } = layout ?? lineMetrics(part.textFont, part.textSize);
  const scroll = layout?.scroll ?? 0;
  const maxScroll = layout?.maxScroll ?? (part.style === "scrolling" ? Math.max(0, lineHeight - tr.height) : 0);

  if (part.showLines) drawRules(frame, textClip, tr, scroll, lineHeight, baselineOffset);
  if (layout) blitInk(frame, textClip, layout.mask, layout.maskRect, part.enabled ? undefined : dimmedInk);
  if (layout && ctx.found) drawFound(frame, clip, layout, ctx.text, ctx.found);
  if (part.style === "scrolling") drawScrollbar(frame, clip, part.rect, scroll, maxScroll);
  if (layout && ctx.editing) drawEditing(frame, clip, layout, ctx.text, ctx.editing);
}

// ---------------------------------------------------------------------------------------------
// Rasterizer
// ---------------------------------------------------------------------------------------------

export interface PartRendererOptions {
  /** Text backend; defaults to the shared canvas backend, created only when text is drawn. */
  textBackend?: TextRasterBackend;
  /** Per-field scroll offset in pixels (UI state, not persisted); only `scrolling` fields use it. */
  scrollOffset?: (partId: HexID) => number;
}

/** Builds a PartRasterizer (bitmapCanvas.ts) for all ButtonStyle and FieldStyle values. */
export function createPartRasterizer(options: PartRendererOptions = {}): PartRasterizer {
  const getBackend = (): TextRasterBackend => options.textBackend ?? getDefaultBackend();
  return (frame, part, ctx) => {
    const { width, height } = part.rect;
    if (width <= 0 || height <= 0) return;
    const clip = rectClip(part.rect);
    if (clip.x0 >= clip.x1 || clip.y0 >= clip.y1) return;
    if (part.type === "button") {
      if (part.style === "checkBox" || part.style === "radioButton") drawCheckable(frame, clip, part, ctx, getBackend);
      else drawPushButton(frame, clip, part, ctx, getBackend);
    } else {
      drawField(frame, clip, part, ctx, getBackend, options.scrollOffset?.(part.id) ?? 0);
    }
  };
}

/** Default rasterizer of `composeFrame`: shared canvas text backend, no scroll offsets. */
export const rasterizePart: PartRasterizer = createPartRasterizer();

// ---------------------------------------------------------------------------------------------
// Hit testing (Requirement 3.3)
// ---------------------------------------------------------------------------------------------

function contains(part: HexPart, x: number, y: number): boolean {
  const r = part.rect;
  return part.visible && x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;
}

/**
 * Topmost visible part of `cardId` whose rect contains the pointer: card parts before background
 * parts, later array entries first. `x`, `y` are canvas-relative pointer coordinates in CSS
 * pixels; they are divided by the integer `scale` (see `computeIntegerScale`) and floored to frame
 * pixels. Returns null when no part is hit. Throws for an unknown card or background, or a scale
 * that is not a positive integer.
 */
export function hitTest(stack: HexStack, cardId: HexID, x: number, y: number, scale = 1): HexPart | null {
  if (!Number.isInteger(scale) || scale < 1) throw new Error(`hitTest: scale must be a positive integer, got ${scale}`);
  const card = stack.cards.find((c) => c.id === cardId);
  if (!card) throw new Error(`hitTest: card ${cardId} not found`);
  const background = stack.backgrounds.find((b) => b.id === card.backgroundId);
  if (!background) throw new Error(`hitTest: background ${card.backgroundId} of card ${cardId} not found`);
  const px = Math.floor(x / scale);
  const py = Math.floor(y / scale);
  for (const parts of [card.parts, background.parts]) {
    for (let i = parts.length - 1; i >= 0; i--) if (contains(parts[i], px, py)) return parts[i];
  }
  return null;
}
