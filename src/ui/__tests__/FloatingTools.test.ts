import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthoringTool } from "../../core/schema.ts";
import { PATTERNS } from "../../engine/graphics/patterns.ts";
import {
  CARD_FRAME_WIDTH,
  FloatingTools,
  ICON_SIZE,
  MENU_BAR_BASE_HEIGHT,
  PALETTE_GRAB,
  TOOLS,
  clampPaletteOrigin,
  computeUiScale,
  menuBarHeight,
  patternToPath,
  pixelRowsToPath,
} from "../FloatingTools.tsx";
import type { UiStore } from "../System7Shell.tsx";

const SPEC_TOOLS: AuthoringTool[] = [
  "browse", "button", "field", "select", "lasso", "pencil",
  "brush", "eraser", "line", "spray", "rect", "paintBucket",
];

function fakeStore(tool: AuthoringTool): UiStore {
  const snapshot = { tool } as ReturnType<UiStore["getSnapshot"]>;
  return {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
    applyRuntime: () => {},
    onReplaceStack: () => () => {},
    getCompiled: () => ({ ast: { handlers: {} }, errors: [] }),
    setEditLayer: () => {},
    setTool: () => {},
    setSelectedPart: () => {},
  };
}

function renderPalette(tool: AuthoringTool, patternIndex: number): string {
  return renderToStaticMarkup(
    createElement(FloatingTools, {
      store: fakeStore(tool),
      patternIndex,
      onPatternChange: () => {},
      position: { x: 10, y: 40 },
      onPositionChange: () => {},
      onClose: () => {},
    }),
  );
}

describe("tool definitions", () => {
  it("lists the 12 tools of design spec §2.1 in palette order", () => {
    expect(TOOLS.map((tool) => tool.id)).toEqual(SPEC_TOOLS);
  });

  it("gives every tool a 16x16 icon with at least one dark pixel", () => {
    for (const tool of TOOLS) {
      expect(tool.icon, tool.id).toHaveLength(ICON_SIZE);
      for (const row of tool.icon) expect(row, tool.id).toMatch(/^[.#]{16}$/);
      expect(tool.icon.join("")).toContain("#");
    }
  });
});

describe("pixel paths", () => {
  it("emits one rectangle per horizontal run", () => {
    expect(pixelRowsToPath(["##.#", "...."])).toBe("M0 0h2v1h-2zM3 0h1v1h-1z");
  });

  it("can draw the runs of another character", () => {
    expect(pixelRowsToPath(["#++#", ".+.."], "+")).toBe("M1 0h2v1h-2zM1 1h1v1h-1z");
  });

  it("draws exactly the set bits of any pattern", () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 8, maxLength: 8 }), (bytes) => {
        const path = patternToPath(bytes);
        const area = [...path.matchAll(/h(\d+)v1/g)].reduce((sum, match) => sum + Number(match[1]), 0);
        const bits = [...bytes].reduce((sum, byte) => sum + byte.toString(2).replaceAll("0", "").length, 0);
        expect(area).toBe(bits);
      }),
    );
  });
});

describe("clampPaletteOrigin", () => {
  const viewport = { width: 800, height: 600 };

  it("keeps the palette below the menu bar and the title bar inside the window", () => {
    expect(clampPaletteOrigin({ x: 100, y: -50 }, viewport).y).toBe(MENU_BAR_BASE_HEIGHT);
    expect(clampPaletteOrigin({ x: 5000, y: 5000 }, viewport)).toEqual({ x: 800 - PALETTE_GRAB, y: 600 - PALETTE_GRAB });
  });

  it("leaves a position inside the window unchanged", () => {
    expect(clampPaletteOrigin({ x: 120, y: 90 }, viewport)).toEqual({ x: 120, y: 90 });
  });
});

describe("computeUiScale (Requirement 2.10)", () => {
  it("is the classic 20 px menu bar times k", () => {
    expect(MENU_BAR_BASE_HEIGHT).toBe(20);
    expect([1, 2, 3, 4].map(menuBarHeight)).toEqual([20, 40, 60, 80]);
  });

  it("reserves a 2-pixel card frame on every side", () => {
    expect(CARD_FRAME_WIDTH).toBe(2);
  });

  it("fits the card (512k x 342k), its 2k frame on every side and the 20k menu bar", () => {
    expect(computeUiScale(516, 366)).toBe(1);
    expect(computeUiScale(1032, 732)).toBe(2); // (512 + 4) * 2, (342 + 4) * 2 + 40
    expect(computeUiScale(1548, 1098)).toBe(3); // the new exact fit for k = 3
    expect(computeUiScale(3000, 3000)).toBe(5); // width-bound: 516 * 5 = 2580
  });

  it("drops to a smaller k where the card fits but its frame or the menu bar does not", () => {
    expect(computeUiScale(1536, 1086)).toBe(2); // the old exact fit for k = 3 leaves no room for the frame
    expect(computeUiScale(1024, 724)).toBe(1); // the old exact fit for k = 2
    expect(computeUiScale(1547, 1098)).toBe(2); // one pixel short in width
    expect(computeUiScale(1548, 1097)).toBe(2); // one pixel short in height
    expect(computeUiScale(1920, 1080)).toBe(2); // the card alone would get 3
    expect(computeUiScale(2560, 1440)).toBe(3); // the card alone would get 4
  });

  it("always leaves room for the card, the frame and the menu bar at k > 1", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 8000 }), fc.integer({ min: 0, max: 8000 }), (width, height) => {
        const k = computeUiScale(width, height);
        const frame = 2 * CARD_FRAME_WIDTH;
        if (k > 1) {
          expect((512 + frame) * k).toBeLessThanOrEqual(width);
          expect((342 + frame) * k + menuBarHeight(k)).toBeLessThanOrEqual(height);
        }
        // k is the largest such scale.
        expect((512 + frame) * (k + 1) > width || (342 + frame) * (k + 1) + menuBarHeight(k + 1) > height).toBe(true);
      }),
    );
  });

  it("gives 1 for tiny or invalid viewports", () => {
    expect(computeUiScale(300, 200)).toBe(1);
    expect(computeUiScale(512, 342)).toBe(1);
    expect(computeUiScale(0, 0)).toBe(1);
    expect(computeUiScale(Number.NaN, 1000)).toBe(1);
  });
});

describe("scaled palette", () => {
  it("clamps below the 20k menu bar with a 32k grab margin", () => {
    const viewport = { width: 1600, height: 1200 };
    expect(clampPaletteOrigin({ x: 100, y: 0 }, viewport, 3)).toEqual({ x: 100, y: 60 });
    expect(clampPaletteOrigin({ x: 5000, y: 5000 }, viewport, 3)).toEqual({ x: 1600 - 96, y: 1200 - 96 });
  });

  it("draws icons and pattern swatches k times larger", () => {
    const html = renderToStaticMarkup(
      createElement(FloatingTools, {
        store: fakeStore("browse"), patternIndex: 1, onPatternChange: () => {},
        position: { x: 10, y: 80 }, onPositionChange: () => {}, onClose: () => {}, scale: 3,
      }),
    );
    expect(html.match(/<svg class="s7-icon" width="48" height="48"/g)).toHaveLength(12);
    expect(html.match(/<svg width="24" height="24" viewBox="0 0 8 8"/g)).toHaveLength(PATTERNS.length);
  });
});

describe("FloatingTools markup", () => {
  it("renders 12 tool buttons and 38 pattern buttons", () => {
    const html = renderPalette("browse", 1);
    expect(html.match(/class="s7-tool"/g)).toHaveLength(12);
    expect(html.match(/class="s7-pattern"/g)).toHaveLength(PATTERNS.length);
    expect(PATTERNS).toHaveLength(38);
  });

  it("marks only the current tool and pattern as selected", () => {
    const html = renderPalette("lasso", 5);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/data-tool="lasso"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*data-tool="lasso"/);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/data-pattern="5"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-pattern="5"/);
  });

  it("positions the window from the position prop", () => {
    expect(renderPalette("browse", 1)).toContain("left:10px;top:40px");
  });
});
