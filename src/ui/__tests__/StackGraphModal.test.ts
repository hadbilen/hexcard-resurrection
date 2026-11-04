/**
 * Spec 04 task 4, Requirement 3.5: Stack Graph edges from static `go` targets, 1-bit thumbnails,
 * layout and arrow geometry, and server rendering.
 */
/// <reference types="node" />
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseHexTalk } from "../../core/parser.ts";
import { THEME_PALETTES, type HexButtonPart, type HexCard, type HexStack } from "../../core/schema.ts";
import { createHexStore } from "../../core/store.ts";
import type { PartRasterizer } from "../../engine/graphics/bitmapCanvas.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH } from "../../engine/graphics/rleCodec.ts";
import { createUiStoreView } from "../App.tsx";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  StackGraphModal,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_WIDTH,
  arrowSegment,
  buildStackGraphEdges,
  collectGoTargets,
  layoutStackGraph,
  reduceFrame,
  selfLoopPath,
  staticGoTarget,
} from "../StackGraphModal.tsx";
import { UiScaleContext } from "../System7Shell.tsx";

const emptyBitmap = { width: 512, height: 342, rleData: "" };
/** Parts are not drawn in these tests: the edge logic does not depend on them. */
const noParts: PartRasterizer = () => {};

function card(id: string, name: string, scriptSource = "", backgroundId = "bkg_1", parts: HexButtonPart[] = []): HexCard {
  return { id, name, backgroundId, bitmap: emptyBitmap, parts, bgFieldContents: {}, marked: false, cantDelete: false, dontSearch: false, scriptSource };
}

function goButton(id: string, scriptSource: string, layerScope: "card" | "background" = "card"): HexButtonPart {
  return {
    id, name: id, type: "button", layerScope, rect: { x: 0, y: 0, width: 10, height: 10 }, visible: true, enabled: true,
    scriptSource, style: "rectangle", title: "", showName: true, autoHilite: false, hilite: false,
  };
}

function makeStack(overrides: Partial<HexStack> = {}): HexStack {
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "Graph", author: "", createdAt: "", updatedAt: "",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", ...THEME_PALETTES.ClassicPaper },
    backgrounds: [
      { id: "bkg_1", name: "A", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false },
      { id: "bkg_2", name: "B", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false },
    ],
    cards: [card("crd_1", "Hall"), card("crd_2", "Library"), card("crd_3", "Cellar")],
    customIcons: {},
    scriptSource: "",
    ...overrides,
  };
}

function edgesOf(stack: HexStack) {
  const store = createHexStore({ stack, compile: parseHexTalk });
  return buildStackGraphEdges(store.getSnapshot().stack, store.getCompiled);
}

const handler = (body: string): string => `on mouseUp\n${body}\nend mouseUp`;

describe("static go targets", () => {
  const stack = makeStack();
  const targets = collectGoTargets(parseHexTalk(handler([
    'go card "Library"',
    "go card 3",
    'go card id "crd_1"',
    "go next",
    "go back",
    'go card ("Lib" & "rary")',
    'if x then\n  go prev\nelse\n  repeat 2 times\n    go last\n  end repeat\nend if',
  ].join("\n"))).ast);

  it("collects every go, including those nested in if and repeat", () => {
    expect(targets).toHaveLength(8);
  });

  it("resolves literal and relative targets like the VM; back and computed targets are not static", () => {
    // `go prev` from the first card wraps to the last card.
    expect(targets.map((target) => staticGoTarget(stack, "crd_1", target))).toEqual([
      "crd_2", "crd_3", "crd_1", "crd_2", undefined, undefined, "crd_3", "crd_3",
    ]);
  });

  it("has no target for a card that does not exist", () => {
    const [target] = collectGoTargets(parseHexTalk(handler('go card "Attic"')).ast);
    expect(staticGoTarget(stack, "crd_1", target)).toBeUndefined();
  });
});

describe("stack graph edges", () => {
  it("links card and card-part scripts from their own card, deduplicated", () => {
    const stack = makeStack({
      cards: [
        card("crd_1", "Hall", handler("go next\ngo next"), "bkg_1", [goButton("prt_1", handler('go card "Cellar"'))]),
        card("crd_2", "Library"),
        card("crd_3", "Cellar", handler("go to card 3")),
      ],
    });
    expect(edgesOf(stack)).toEqual([
      { from: "crd_1", to: "crd_2" },
      { from: "crd_1", to: "crd_3" },
      { from: "crd_3", to: "crd_3" },
    ]);
  });

  it("links background scripts from every card of that background, and the stack script from every card", () => {
    const stack = makeStack({
      scriptSource: handler("go first"),
      backgrounds: [
        { id: "bkg_1", name: "A", bitmap: emptyBitmap, parts: [goButton("prt_b", handler("go next"), "background")], scriptSource: "", cantDelete: false },
        { id: "bkg_2", name: "B", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false },
      ],
      cards: [card("crd_1", "Hall"), card("crd_2", "Library"), card("crd_3", "Cellar", "", "bkg_2")],
    });
    expect(edgesOf(stack)).toEqual([
      { from: "crd_1", to: "crd_1" },
      { from: "crd_2", to: "crd_1" },
      { from: "crd_3", to: "crd_1" },
      { from: "crd_1", to: "crd_2" },
      { from: "crd_2", to: "crd_3" },
    ]);
  });

  it("draws nothing for a script with compile errors (empty AST)", () => {
    expect(edgesOf(makeStack({ cards: [card("crd_1", "Hall", "on mouseUp\n  go\nend mouseUp"), card("crd_2", "B")] }))).toEqual([]);
  });
});

describe("thumbnails", () => {
  it("keep solid areas solid and stay 1-bit", () => {
    const light = reduceFrame(new Uint8Array(BITMAP_WIDTH * BITMAP_HEIGHT).fill(1));
    const dark = reduceFrame(new Uint8Array(BITMAP_WIDTH * BITMAP_HEIGHT).fill(2));
    expect(light).toHaveLength(THUMBNAIL_WIDTH * THUMBNAIL_HEIGHT);
    expect(light.every((state) => state === 1)).toBe(true);
    expect(dark.every((state) => state === 2)).toBe(true);
  });

  it("keep 1-px lines and single dark pixels (dark if any pixel of the block is dark)", () => {
    const frame = new Uint8Array(BITMAP_WIDTH * BITMAP_HEIGHT).fill(1);
    for (let x = 0; x < BITMAP_WIDTH; x++) frame[101 * BITMAP_WIDTH + x] = 2; // horizontal line, y = 101
    for (let y = 0; y < BITMAP_HEIGHT; y++) frame[y * BITMAP_WIDTH + 203] = 2; // vertical line, x = 203
    frame[341 * BITMAP_WIDTH + 2] = 2; // single pixel in the partial bottom row of blocks
    const thumb = reduceFrame(frame);
    const at = (tx: number, ty: number): number => thumb[ty * THUMBNAIL_WIDTH + tx];
    for (let tx = 0; tx < THUMBNAIL_WIDTH; tx++) expect(at(tx, 25)).toBe(2);
    for (let ty = 0; ty < THUMBNAIL_HEIGHT; ty++) expect(at(50, ty)).toBe(2);
    expect(at(0, 85)).toBe(2);
    // All-light blocks next to them stay light; the output is 1-bit.
    expect(at(10, 24)).toBe(1);
    expect(at(49, 10)).toBe(1);
    expect(at(1, 85)).toBe(1);
    expect(thumb.every((state) => state === 1 || state === 2)).toBe(true);
    expect(thumb.filter((state) => state === 2)).toHaveLength(THUMBNAIL_WIDTH + THUMBNAIL_HEIGHT - 1 + 1);
  });

  it("reject a frame of the wrong size", () => {
    expect(() => reduceFrame(new Uint8Array(10))).toThrow();
  });
});

describe("layout and arrows", () => {
  it("places cards three per row inside a margin", () => {
    const layout = layoutStackGraph(["a", "b", "c", "d"]);
    expect(layout.nodes[1].y).toBe(layout.nodes[0].y);
    expect(layout.nodes[3].x).toBe(layout.nodes[0].x);
    expect(layout.nodes[3].y).toBeGreaterThan(layout.nodes[0].y + NODE_HEIGHT);
    for (const node of layout.nodes) {
      expect(node.x + NODE_WIDTH).toBeLessThan(layout.width);
      expect(node.y + NODE_HEIGHT).toBeLessThan(layout.height);
    }
  });

  it("starts and ends arrows outside both node frames, and separates opposite arrows", () => {
    const [a, b] = layoutStackGraph(["a", "b"]).nodes;
    const { start, end } = arrowSegment(a, b, false);
    expect(start.x).toBeGreaterThan(a.x + NODE_WIDTH);
    expect(end.x).toBeLessThan(b.x);
    expect(start.y).toBe(end.y);
    const there = arrowSegment(a, b, true);
    const back = arrowSegment(b, a, true);
    expect(there.start.y).not.toBe(back.end.y);
  });

  it("draws a self-link as a loop beside the node", () => {
    const [node] = layoutStackGraph(["a"]).nodes;
    const loop = selfLoopPath(node);
    expect(loop.points[0].y).toBeLessThanOrEqual(node.y);
    expect(loop.points.at(-1)!.x).toBeGreaterThan(node.x + NODE_WIDTH);
    expect(loop.head).toHaveLength(3);
  });
});

describe("StackGraphModal rendering", () => {
  it("shows every card as a node with a pixelated thumbnail canvas and one arrow per edge", () => {
    const stack = makeStack({ cards: [card("crd_1", "Hall", handler("go next")), card("crd_2", ""), card("crd_3", "Cellar", handler('go card "Hall"'))] });
    const store = createHexStore({ stack, compile: parseHexTalk });
    const html = renderToStaticMarkup(
      createElement(UiScaleContext, { value: 2 },
        createElement(StackGraphModal, { store: createUiStoreView(store), onClose: () => {}, rasterizePart: noParts })),
    );
    expect(html.match(/<li /g)).toHaveLength(3);
    expect(html.match(/<canvas class="s7-graph-thumbnail" width="128" height="86"/g)).toHaveLength(3);
    expect(html).toContain("width:256px;height:172px");
    expect(html.match(/data-testid="graph-arrow"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Hall, goes to Card 2"');
    expect(html).toContain('aria-label="Cellar, goes to Hall"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain('shape-rendering="crispEdges"');
    expect(html).toContain("Stack Graph: Graph");
  });
});
