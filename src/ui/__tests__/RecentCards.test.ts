/**
 * Spec 06 task 6: the Recent window (Requirements 5.4, 5.5, 5.6, 13). Server rendering; the click,
 * Return/Space, close box and Escape paths are checked in headless Chrome.
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseHexTalk } from "../../core/parser.ts";
import { THEME_PALETTES, type HexCard, type HexStack } from "../../core/schema.ts";
import { createHexStore } from "../../core/store.ts";
import type { PartRasterizer } from "../../engine/graphics/bitmapCanvas.ts";
import { createUiStoreView } from "../App.tsx";
import { RECENT_COLUMNS, RecentWindow, recentCardLabel } from "../RecentCards.tsx";
import { UiScaleContext } from "../System7Shell.tsx";

const CSS = readFileSync(new URL("../system7.css", import.meta.url), "utf8");
const emptyBitmap = { width: 512, height: 342, rleData: "" };
const noParts: PartRasterizer = () => {};

function card(id: string, name: string): HexCard {
  return {
    id, name, backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [], bgFieldContents: {}, marked: false, cantDelete: false,
    dontSearch: false, scriptSource: "",
  };
}

function makeStack(): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Recent", author: "", createdAt: "", updatedAt: "",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", ...THEME_PALETTES.ClassicPaper },
    backgrounds: [{ id: "bkg_1", name: "A", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false }],
    cards: [card("crd_1", "Hall"), card("crd_2", ""), card("crd_3", "Cellar"), card("crd_4", "Attic"), card("crd_5", "Vault")],
    customIcons: {},
    scriptSource: "",
  };
}

function render(recent: readonly string[], scale = 1, current = "crd_3"): string {
  const store = createHexStore({ stack: makeStack(), compile: parseHexTalk });
  store.applyRuntime({ type: "goToCard", cardId: current });
  return renderToStaticMarkup(
    createElement(UiScaleContext, { value: scale },
      createElement(RecentWindow, {
        store: createUiStoreView(store), recent: () => recent, onChoose: () => {}, onClose: () => {}, rasterizePart: noParts,
      })),
  );
}

describe("RecentWindow (Requirement 5.4)", () => {
  it("is a window titled Recent with a miniature button per card of the list, in list order", () => {
    const html = render(["crd_3", "crd_5", "crd_1", "crd_2"]);
    expect(html).toContain(">Recent<");
    expect(html).toContain('aria-label="Recent cards"');
    expect(html.match(/<button type="button" class="s7-recent-card/g)).toHaveLength(4);
    expect(html.match(/<canvas class="s7-graph-thumbnail" width="128" height="86"/g)).toHaveLength(4);
    const labels = [...html.matchAll(/<span class="s7-recent-label">([^<]*)<\/span>/g)].map((match) => match[1]);
    expect(labels).toEqual(["Cellar", "Vault", "Hall", "Card 2"]);
    expect(html).toContain('aria-label="Card 2"');
    expect(html).toContain("width:128px;height:86px"); // miniatures at 1x
  });

  it("draws the miniatures at UI scale k", () => {
    expect(render(["crd_1", "crd_3"], 2)).toContain("width:256px;height:172px");
  });

  it("marks only the current card: aria-current and the inverted label class", () => {
    const html = render(["crd_1", "crd_3", "crd_4"], 1, "crd_3");
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html.match(/s7-recent-card-current/g)).toHaveLength(1);
    expect(html).toMatch(/class="s7-recent-card s7-recent-card-current" aria-label="Cellar" aria-current="true"/);
    expect(html).toMatch(/class="s7-recent-card" aria-label="Hall"/);
  });

  it("leaves out cards of the list that no longer exist", () => {
    const html = render(["crd_3", "crd_gone", "crd_1"]);
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html).not.toContain("crd_gone");
  });

  it("names unnamed cards by position", () => {
    const stack = makeStack();
    expect(recentCardLabel(stack, "crd_2")).toBe("Card 2");
    expect(recentCardLabel(stack, "crd_4")).toBe("Attic");
  });

  it("writes every label in printable ASCII (Requirement 13.2)", () => {
    const text = render(["crd_3", "crd_2"]).replace(/<[^>]*>/g, "");
    expect(text).toMatch(/^[\x20-\x7e]*$/);
  });
});

describe("Recent window keyboard focus (Requirements 5.5, 5.6)", () => {
  const SOURCE = readFileSync(new URL("../RecentCards.tsx", import.meta.url), "utf8");

  it("moves the focus to the current card's miniature when it opens, so Escape, Return and Space reach the window", () => {
    expect(SOURCE).toMatch(/useEffect\(\(\) => \{\s*gridRef\.current\?\.querySelector<HTMLButtonElement>\("button"\)\?\.focus\(\);\s*\}, \[\]\);/);
    expect(render(["crd_3", "crd_1"])).toMatch(/<button type="button" class="s7-recent-card s7-recent-card-current"/); // the first button is the current card
  });

  it("makes every miniature a native button, so Return and Space click it", () => {
    expect(render(["crd_3", "crd_1", "crd_2"]).match(/<button type="button"/g)).toHaveLength(3 + 1); // + the window's close box
    expect(SOURCE).not.toMatch(/onKeyDown|role="button"/);
  });
});

describe("Recent window styles (Requirements 5.4, 13.1)", () => {
  const rules = [...CSS.matchAll(/(?:^|\n)((?:[^{}\n]*\.s7-recent[^{]*)\{[^}]*\})/g)].map((match) => match[1]);

  it("lays the miniatures out four per row, 130 px wide each, at UI scale k", () => {
    expect(RECENT_COLUMNS).toBe(4);
    expect(CSS).toMatch(/\.s7-recent-grid\s*\{[^}]*display:\s*grid[^}]*grid-template-columns:\s*repeat\(4,\s*calc\(130 \* var\(--px\)\)\)/);
  });

  it("has .s7-recent* rules, inverts the current label and uses only 1-bit styling", () => {
    expect(rules.length).toBeGreaterThanOrEqual(5);
    expect(CSS).toMatch(/\.s7-recent-card-current \.s7-recent-label\s*\{[^}]*background:\s*var\(--dark-bit\)[^}]*color:\s*var\(--light-bit\)/);
    for (const rule of rules) {
      expect(rule).not.toMatch(/gradient|blur|backdrop|opacity|border-radius|dashed|dotted|box-shadow|transition/);
    }
  });
});
