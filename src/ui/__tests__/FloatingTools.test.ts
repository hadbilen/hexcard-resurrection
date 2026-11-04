import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AuthoringTool } from "../../core/schema.ts";
import { PATTERNS } from "../../engine/graphics/patterns.ts";
import {
  FloatingTools,
  ICON_SIZE,
  MENU_BAR_HEIGHT,
  PALETTE_GRAB,
  TOOLS,
  clampPaletteOrigin,
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
    expect(clampPaletteOrigin({ x: 100, y: -50 }, viewport).y).toBe(MENU_BAR_HEIGHT);
    expect(clampPaletteOrigin({ x: 5000, y: 5000 }, viewport)).toEqual({ x: 800 - PALETTE_GRAB, y: 600 - PALETTE_GRAB });
  });

  it("leaves a position inside the window unchanged", () => {
    expect(clampPaletteOrigin({ x: 120, y: 90 }, viewport)).toEqual({ x: 120, y: 90 });
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
