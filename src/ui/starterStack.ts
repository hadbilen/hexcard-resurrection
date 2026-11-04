/**
 * Built-in starter stack the studio opens with (spec 04 design.md §1, composition root): one
 * background, one card with a "Welcome to HexCard" field and one button. The stack loader (task 6)
 * and the showcase stacks (task 8) replace it through `store.replaceStack`.
 *
 * The stack must pass `validateStack`; its scripts are HexTalk source only (no ASTs).
 */
import { THEME_PALETTES, type HexStack } from "../core/schema.ts";

export const STARTER_BUTTON_SCRIPT = [
  "on mouseUp",
  '  play harpsichord tempo 140 "c4e e4e g4e c5q"',
  '  answer "Welcome to HexCard!" with "OK"',
  "end mouseUp",
].join("\n");

/** A fresh starter stack; `now` sets `createdAt` / `updatedAt`. */
export function createStarterStack(now: Date = new Date()): HexStack {
  const timestamp = now.toISOString();
  const emptyBitmap = { width: 512, height: 342, rleData: "" };
  return {
    id: "stk_starter",
    schemaVersion: "2.0.0",
    name: "Untitled",
    author: "",
    createdAt: timestamp,
    updatedAt: timestamp,
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", ...THEME_PALETTES.ClassicPaper },
    backgrounds: [
      { id: "bkg_starter", name: "Background 1", bitmap: { ...emptyBitmap }, parts: [], scriptSource: "", cantDelete: false },
    ],
    cards: [
      {
        id: "crd_starter",
        name: "Card 1",
        backgroundId: "bkg_starter",
        bitmap: { ...emptyBitmap },
        parts: [
          {
            id: "prt_welcome",
            name: "Welcome",
            type: "field",
            layerScope: "card",
            rect: { x: 96, y: 96, width: 320, height: 64 },
            visible: true,
            enabled: true,
            scriptSource: "",
            style: "rectangle",
            content: "Welcome to HexCard",
            sharedText: false,
            lockText: false,
            dontWrap: false,
            showLines: false,
            textAlign: "center",
            textFont: "System",
            textSize: 18,
            textStyle: [],
          },
          {
            id: "prt_hello",
            name: "Hello",
            type: "button",
            layerScope: "card",
            rect: { x: 196, y: 200, width: 120, height: 24 },
            visible: true,
            enabled: true,
            scriptSource: STARTER_BUTTON_SCRIPT,
            style: "roundRect",
            title: "Hello",
            showName: true,
            autoHilite: true,
            hilite: false,
          },
        ],
        bgFieldContents: {},
        marked: false,
        cantDelete: false,
        dontSearch: false,
        scriptSource: "",
      },
    ],
    customIcons: {},
    scriptSource: "",
  };
}
