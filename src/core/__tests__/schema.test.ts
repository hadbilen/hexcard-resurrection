import { describe, expect, expectTypeOf, it } from "vitest";
import {
  THEME_PALETTES,
  type HexBackground,
  type HexButtonPart,
  type HexCard,
  type HexFieldPart,
  type HexPart,
  type HexPartBase,
  type HexStack,
  type PartType,
  type ThemePaletteName,
} from "../schema.ts";

// Type-level assertions are enforced by `tsc -b` (the test files are part of the app project).

describe("schema: part types (Requirement 1.5)", () => {
  it("supports exactly the two part types button and field", () => {
    expectTypeOf<PartType>().toEqualTypeOf<"button" | "field">();
    expectTypeOf<HexPart["type"]>().toEqualTypeOf<"button" | "field">();
    expectTypeOf<HexPart>().toEqualTypeOf<HexButtonPart | HexFieldPart>();
  });

  it("discriminates HexPart by its type field", () => {
    expectTypeOf<Extract<HexPart, { type: "button" }>>().toEqualTypeOf<HexButtonPart>();
    expectTypeOf<Extract<HexPart, { type: "field" }>>().toEqualTypeOf<HexFieldPart>();
  });
});

describe("schema: no AST in persisted types (Requirement 4.5)", () => {
  // Pinning the exact key sets means an AST (or any other unplanned) field cannot be added
  // to a persisted type without this test failing to compile.
  it("persists scripts only as scriptSource", () => {
    expectTypeOf<keyof HexStack>().toEqualTypeOf<
      | "id" | "schemaVersion" | "name" | "author" | "createdAt" | "updatedAt" | "dimensions"
      | "themePalette" | "backgrounds" | "cards" | "customIcons" | "scriptSource"
    >();
    expectTypeOf<keyof HexBackground>().toEqualTypeOf<
      "id" | "name" | "bitmap" | "parts" | "scriptSource" | "cantDelete"
    >();
    expectTypeOf<keyof HexCard>().toEqualTypeOf<
      | "id" | "name" | "backgroundId" | "bitmap" | "parts" | "bgFieldContents" | "marked"
      | "cantDelete" | "dontSearch" | "scriptSource"
    >();
    expectTypeOf<keyof HexPartBase>().toEqualTypeOf<
      | "id" | "name" | "type" | "layerScope" | "rect" | "visible" | "enabled" | "scriptSource"
      | "naturalLanguagePrompt"
    >();
    expectTypeOf<HexStack["scriptSource"]>().toEqualTypeOf<string>();
    expectTypeOf<HexCard["scriptSource"]>().toEqualTypeOf<string>();
    expectTypeOf<HexBackground["scriptSource"]>().toEqualTypeOf<string>();
    expectTypeOf<HexPart["scriptSource"]>().toEqualTypeOf<string>();
  });
});

describe("schema: THEME_PALETTES (design spec §2.1)", () => {
  it("defines exactly the four theme palettes with the canonical colours", () => {
    expectTypeOf<keyof typeof THEME_PALETTES>().toEqualTypeOf<ThemePaletteName>();
    expect(THEME_PALETTES).toEqual({
      ClassicPaper: { darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
      AmberCRT: { darkBitHex: "#1A1000", lightBitHex: "#FFB000" },
      GreenPhosphor: { darkBitHex: "#041804", lightBitHex: "#33FF33" },
      MidnightHex: { darkBitHex: "#0A0A23", lightBitHex: "#C8C8FF" },
    });
  });
});
