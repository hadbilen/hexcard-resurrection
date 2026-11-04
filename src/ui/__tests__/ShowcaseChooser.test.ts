/**
 * Spec 04 task 8, Requirements 7.1 and 7.5: File > Open Showcase Stack opens a chooser window
 * listing the three showcase stacks by name.
 */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SHOWCASE_STACKS } from "../../presets/index.ts";
import { createStudioWindows } from "../ObjectInspector.tsx";
import { SHOWCASE_CHOOSER_TITLE, ShowcaseChooser } from "../ShowcaseChooser.tsx";

describe("showcase chooser", () => {
  it("is a studio window, so the message bus treats it as modal", () => {
    const windows = createStudioWindows();
    windows.openShowcaseChooser();
    expect(windows.getSnapshot()?.kind).toBe("showcaseChooser");
    expect(windows.isOpen()).toBe(true);
    windows.close();
    expect(windows.isOpen()).toBe(false);
  });

  it("lists every showcase stack by name with the first one selected", () => {
    const html = renderToStaticMarkup(createElement(ShowcaseChooser, {
      showcases: SHOWCASE_STACKS,
      onOpen: () => {},
      onClose: () => {},
    }));
    expect(html).toContain(SHOWCASE_CHOOSER_TITLE);
    for (const { name } of SHOWCASE_STACKS) expect(html).toContain(name);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.indexOf('aria-pressed="true"')).toBeLessThan(html.indexOf(SHOWCASE_STACKS[0].name));
    expect(html).toContain(">Open<");
    expect(html).toContain(">Cancel<");
  });
});
