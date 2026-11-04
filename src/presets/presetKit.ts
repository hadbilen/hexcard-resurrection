/**
 * Small builders for the showcase stacks (spec 04 task 8). They only fill in the schema defaults
 * of `src/core/schema.ts`, so every preset is a plain `HexStack` (schemaVersion "2.0.0") that goes
 * through `validateStack` and the stack loader like any imported stack.
 *
 * Scripts are HexTalk source (`scriptSource`); `hexTalk(...)` joins source lines with newlines.
 */
import {
  THEME_PALETTES,
  type HexBackground,
  type HexBitmapLayer,
  type HexButtonPart,
  type HexCard,
  type HexFieldPart,
  type HexID,
  type HexPart,
  type HexRect,
  type HexStack,
  type ThemePaletteName,
} from "../core/schema.ts";

/** The date HyperCard 1.0 shipped; used as the presets' fixed creation time. */
export const PRESET_TIMESTAMP = "1987-08-11T09:00:00.000Z";

/** Joins HexTalk source lines. */
export function hexTalk(...lines: string[]): string {
  return lines.join("\n");
}

export function bitmap(rleData = ""): HexBitmapLayer {
  return { width: 512, height: 342, rleData };
}

export function rect(x: number, y: number, width: number, height: number): HexRect {
  return { x, y, width, height };
}

type Scope = HexPart["layerScope"];

export type ButtonOptions = Partial<Omit<HexButtonPart, "id" | "type" | "layerScope" | "name" | "rect">>;

export function button(id: HexID, layerScope: Scope, name: string, at: HexRect, options: ButtonOptions = {}): HexButtonPart {
  return {
    id,
    name,
    type: "button",
    layerScope,
    rect: at,
    visible: true,
    enabled: true,
    scriptSource: "",
    style: "roundRect",
    title: name,
    showName: true,
    autoHilite: true,
    hilite: false,
    ...options,
  };
}

export type FieldOptions = Partial<Omit<HexFieldPart, "id" | "type" | "layerScope" | "name" | "rect">>;

/** A locked field (the presets' fields are displays; scripts write them with `put`). */
export function field(id: HexID, layerScope: Scope, name: string, at: HexRect, options: FieldOptions = {}): HexFieldPart {
  return {
    id,
    name,
    type: "field",
    layerScope,
    rect: at,
    visible: true,
    enabled: true,
    scriptSource: "",
    style: "rectangle",
    content: "",
    sharedText: false,
    lockText: true,
    dontWrap: false,
    showLines: false,
    textAlign: "left",
    textFont: "Sans",
    textSize: 12,
    textStyle: [],
    ...options,
  };
}

export function background(id: HexID, name: string, rleData: string, parts: HexPart[], scriptSource = ""): HexBackground {
  return { id, name, bitmap: bitmap(rleData), parts, scriptSource, cantDelete: false };
}

export interface CardOptions {
  rleData?: string;
  parts?: HexPart[];
  bgFieldContents?: Record<HexID, string>;
  scriptSource?: string;
}

export function card(id: HexID, name: string, backgroundId: HexID, options: CardOptions = {}): HexCard {
  return {
    id,
    name,
    backgroundId,
    bitmap: bitmap(options.rleData ?? ""),
    parts: options.parts ?? [],
    bgFieldContents: options.bgFieldContents ?? {},
    marked: false,
    cantDelete: false,
    dontSearch: false,
    scriptSource: options.scriptSource ?? "",
  };
}

export interface StackOptions {
  id: HexID;
  name: string;
  theme: ThemePaletteName;
  backgrounds: HexBackground[];
  cards: HexCard[];
  scriptSource?: string;
}

export function stack({ id, name, theme, backgrounds, cards, scriptSource = "" }: StackOptions): HexStack {
  return {
    id,
    schemaVersion: "2.0.0",
    name,
    author: "HexCard",
    createdAt: PRESET_TIMESTAMP,
    updatedAt: PRESET_TIMESTAMP,
    dimensions: { width: 512, height: 342 },
    themePalette: { name: theme, ...THEME_PALETTES[theme] },
    backgrounds,
    cards,
    customIcons: {},
    scriptSource,
  };
}
