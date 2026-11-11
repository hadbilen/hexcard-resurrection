/**
 * Spec 07 task 2: `clearIconCache` (design §partRenderer.ts), Requirement 5.5.
 * The real `decodeIcon` is wrapped in a spy so the test can see when the part renderer decodes an
 * icon instead of taking it from its cache. Frames are drawn with the real renderer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as icons from "../../../core/icons.ts";
import type { HexButtonPart, HexStack } from "../../../core/schema.ts";
import { clearDecodedLayerCache, composeFrame } from "../bitmapCanvas.ts";
import { clearIconCache, createPartRasterizer } from "../partRenderer.ts";
import type { TextRasterBackend } from "../textRaster.ts";

vi.mock("../../../core/icons.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../core/icons.ts")>();
  return { ...actual, decodeIcon: vi.fn(actual.decodeIcon) };
});

const noText: TextRasterBackend = {
  measureText: (text) => text.length * 6,
  drawText: (_text, _css, _x, _baseline, width, height) => new Uint8Array(width * height),
};

function iconData(...dark: Array<[x: number, y: number]>): string {
  const pixels = new Uint8Array(icons.ICON_PIXELS);
  for (const [x, y] of dark) pixels[y * 32 + x] = 1;
  return icons.encodeIcon(pixels);
}

function makeStack(): HexStack {
  const button = (id: string, iconId: string, x: number): HexButtonPart => ({
    id, name: id, type: "button", layerScope: "card", rect: { x, y: 10, width: 60, height: 60 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", title: "", showName: false,
    iconId, autoHilite: true, hilite: false,
  });
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "T", author: "T",
    createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "B", bitmap: { width: 512, height: 342, rleData: "" }, parts: [], scriptSource: "", cantDelete: false }],
    cards: [{
      id: "crd_1", name: "C", backgroundId: "bkg_1", bitmap: { width: 512, height: 342, rleData: "" },
      parts: [button("prt_a", "a", 10), button("prt_b", "b", 100)], bgFieldContents: {},
      marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
    }],
    customIcons: { a: iconData([0, 0], [31, 31]), b: iconData([5, 9]) },
    scriptSource: "",
  };
}

const decodeIcon = vi.mocked(icons.decodeIcon);
const raster = createPartRasterizer({ textBackend: noText });
const render = (stack: HexStack): Uint8Array => composeFrame(stack, "crd_1", {}, raster);

describe("clearIconCache (Requirement 5.5)", () => {
  beforeEach(() => {
    clearIconCache();
    clearDecodedLayerCache();
    decodeIcon.mockClear();
  });

  it("makes the next frame decode its icons again", () => {
    const stack = makeStack();
    const first = render(stack);
    expect(decodeIcon).toHaveBeenCalledTimes(2);
    render(stack);
    expect(decodeIcon).toHaveBeenCalledTimes(2); // both icons came from the cache
    clearIconCache();
    const again = render(stack);
    expect(decodeIcon).toHaveBeenCalledTimes(4);
    expect(again).toEqual(first);
  });

  it("leaves frames unchanged", () => {
    const stack = makeStack();
    const cold = render(stack);
    const warm = render(stack);
    clearIconCache();
    expect(render(stack)).toEqual(cold);
    expect(warm).toEqual(cold);
    // The icons are drawn: the first icon's top-left pixel is dark, inside the 60 x 60 button at (10, 10).
    expect(cold[(10 + 14) * 512 + 10 + 14]).toBe(2);
  });

  it("can be called on an empty cache", () => {
    expect(() => { clearIconCache(); clearIconCache(); }).not.toThrow();
  });
});
