import { describe, expect, it } from "vitest";
import { BLANK_ICON, isIconData, isIconName } from "../../core/icons.ts";
import { SHOWCASE_STACKS } from "../index.ts";
import { BUILT_IN_ICONS } from "../builtInIcons.ts";

describe("built-in icons (spec 06 Requirement 11)", () => {
  it("ships at least 12 icons with unique hex- names of lowercase words", () => {
    expect(BUILT_IN_ICONS.length).toBeGreaterThanOrEqual(12);
    const names = BUILT_IN_ICONS.map((icon) => icon.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name).toMatch(/^hex-[a-z]+(?:-[a-z]+)*$/);
      expect(isIconName(name)).toBe(true);
    }
  });

  it("makes every icon valid icon data, not blank and different from every other icon", () => {
    const data = BUILT_IN_ICONS.map((icon) => icon.data);
    for (const value of data) {
      expect(isIconData(value)).toBe(true);
      expect(value).not.toBe(BLANK_ICON);
    }
    expect(new Set(data).size).toBe(data.length);
  });

  it("is never referenced by the showcase stacks, which carry their own customIcons", () => {
    for (const entry of SHOWCASE_STACKS) {
      const stack = entry.create();
      const iconIds = [...stack.backgrounds, ...stack.cards].flatMap((owner) => owner.parts)
        .flatMap((part) => (part.type === "button" && part.iconId !== undefined ? [part.iconId] : []));
      for (const id of iconIds) expect(Object.hasOwn(stack.customIcons, id)).toBe(true);
    }
  });
});
