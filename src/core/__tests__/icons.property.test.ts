import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { ICON_DATA_PATTERN, ICON_PIXELS, decodeIcon, encodeIcon, isIconData } from "../icons.ts";
import type { HexButtonPart, HexStack } from "../schema.ts";
import { validateStack } from "../stackValidator.ts";

const emptyBitmap = { width: 512, height: 342, rleData: "" };

function stackWith(customIcons: Record<string, string>, iconId?: string): HexStack {
  const button: HexButtonPart = {
    id: "prt_1", name: "B", type: "button", layerScope: "card", rect: { x: 0, y: 0, width: 40, height: 40 },
    visible: true, enabled: true, scriptSource: "", style: "rectangle", title: "B", showName: true,
    autoHilite: false, hilite: false, ...(iconId === undefined ? {} : { iconId }),
  };
  return {
    id: "stk_1", schemaVersion: "2.0.0", name: "P", author: "", createdAt: "", updatedAt: "",
    dimensions: { width: 512, height: 342 },
    themePalette: { name: "ClassicPaper", darkBitHex: "#000000", lightBitHex: "#FFFFFF" },
    backgrounds: [{ id: "bkg_1", name: "", bitmap: emptyBitmap, parts: [], scriptSource: "", cantDelete: false }],
    cards: [{
      id: "crd_1", name: "", backgroundId: "bkg_1", bitmap: emptyBitmap, parts: [button], bgFieldContents: {},
      marked: false, cantDelete: false, dontSearch: false, scriptSource: "",
    }],
    customIcons, scriptSource: "",
  };
}

const pixelsArb = fc.uint8Array({ minLength: ICON_PIXELS, maxLength: ICON_PIXELS, max: 1 });
const iconDataArb = pixelsArb.map(encodeIcon);

/** Strings near the format: Base64-ish alphabets with "-", "_" and "=", lengths 168-176, random endings. */
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const nearChar = fc.constantFrom(...(BASE64 + "-_=").split(""));
const nearIconDataArb = fc.oneof(
  fc.array(nearChar, { minLength: 168, maxLength: 176 }).map((chars) => chars.join("")),
  fc.tuple(fc.array(fc.constantFrom(...BASE64.split("")), { minLength: 170, maxLength: 170 }), nearChar, nearChar)
    .map(([body, a, b]) => body.join("") + a + b),
  fc.tuple(iconDataArb, fc.nat(171), nearChar).map(([data, i, c]) => data.slice(0, i) + c + data.slice(i + 1)),
);

describe("icons: properties", () => {
  // Feature: 06-hypercard-classics, Property 1: Icon data round trip
  // **Validates: Requirements 8.1, 8.5**
  it("Property 1: encodeIcon / decodeIcon round-trip in both directions", () => {
    fc.assert(
      fc.property(pixelsArb, (pixels) => {
        const data = encodeIcon(pixels);
        expect(data).toHaveLength(172);
        expect(isIconData(data)).toBe(true);
        expect(decodeIcon(data)).toEqual(pixels);
        expect(encodeIcon(decodeIcon(data))).toBe(data);
      }),
      { numRuns: 200 },
    );
  });

  // Feature: 06-hypercard-classics, Property 2: Validator accepts exactly icon data
  // **Validates: Requirements 8.3, 15.2**
  it("Property 2: validateStack accepts a customIcons value exactly when it is icon data", () => {
    fc.assert(
      fc.property(fc.oneof(nearIconDataArb, iconDataArb), (value) => {
        expect(validateStack(stackWith({ a: value })).ok).toBe(ICON_DATA_PATTERN.test(value));
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(iconDataArb, (data) => {
        expect(validateStack(stackWith({ a: data }, "a")).ok).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  // Feature: 06-hypercard-classics, Property 2 (dangling iconId part)
  // **Validates: Requirements 8.3, 15.2**
  it("Property 2: a button iconId that is not a key of customIcons is always rejected", () => {
    const nameArb = fc.string({ minLength: 1, maxLength: 8 });
    fc.assert(
      fc.property(fc.dictionary(fc.constantFrom("a", "b", "Icon 1", "x y"), iconDataArb, { maxKeys: 3 }), nameArb, (icons, iconId) => {
        fc.pre(!Object.hasOwn(icons, iconId));
        const result = validateStack(stackWith(icons, iconId));
        expect(result.ok).toBe(false);
        if (!result.ok) expect(result.error).toMatch(/^cards\[0\]\.parts\[0\]\.iconId: no icon named/);
      }),
      { numRuns: 200 },
    );
  });
});
