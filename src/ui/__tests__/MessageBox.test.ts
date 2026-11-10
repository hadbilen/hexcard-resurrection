/**
 * Spec 06 task 4.1: the Message Box controller and window (Requirements 2.1-2.9, 13).
 */
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { releaseTextFocus } from "../CardViewport.tsx";
import {
  createMessageBox,
  defaultMessageBoxPosition,
  MESSAGE_BOX_HEIGHT,
  MESSAGE_BOX_WIDTH,
  MessageBoxWindow,
  selectionRange,
} from "../MessageBox.tsx";
import { UiScaleContext } from "../System7Shell.tsx";

const SHELL_CSS = readFileSync(new URL("../system7.css", import.meta.url), "utf8");

describe("createMessageBox", () => {
  it("starts closed with an empty line and no position", () => {
    const box = createMessageBox();
    expect(box.getSnapshot()).toEqual({ open: false, line: "", position: null, focus: null });
    expect(box.isOpen()).toBe(false);
  });

  it("opens with a focus request, keeps the line across close and reopen, and notifies subscribers (Requirements 2.1-2.4)", () => {
    const box = createMessageBox();
    let notified = 0;
    const unsubscribe = box.subscribe(() => void notified++);
    box.setLine("put 1 into x");
    box.show({ select: "end" });
    const opened = box.getSnapshot();
    expect(opened).toMatchObject({ open: true, line: "put 1 into x", focus: { select: "end" } });
    box.show({ select: "all" });
    expect(box.getSnapshot().focus).toMatchObject({ select: "all" });
    expect(box.getSnapshot().focus!.id).toBeGreaterThan(opened.focus!.id);
    box.close();
    expect(box.getSnapshot()).toMatchObject({ open: false, line: "put 1 into x", focus: null });
    box.show();
    expect(box.getSnapshot()).toMatchObject({ open: true, line: "put 1 into x", focus: { select: "end" } });
    expect(notified).toBe(5);
    unsubscribe();
    box.close();
    expect(notified).toBe(5);
  });

  it("replaces the line only when show is given one, and keeps the line to one line (Requirement 2.7)", () => {
    const box = createMessageBox();
    box.show({ line: 'find ""', select: { start: 6, end: 6 } });
    expect(box.getSnapshot()).toMatchObject({ line: 'find ""', focus: { select: { start: 6, end: 6 } } });
    box.setLine("a\nb\r\nc");
    expect(box.getSnapshot().line).toBe("abc");
  });

  it("does not notify for a change that changes nothing", () => {
    const box = createMessageBox();
    let notified = 0;
    box.subscribe(() => void notified++);
    box.close();
    box.setLine("");
    box.setPosition({ x: 3, y: 4 });
    box.setPosition({ x: 3, y: 4 });
    expect(notified).toBe(1);
    expect(box.getSnapshot().position).toEqual({ x: 3, y: 4 });
  });
});

describe("Message Box geometry and focus", () => {
  it("is 448 x 47 at 1x and first opens near the bottom left of the desktop, at UI scale k (Requirement 2.6)", () => {
    expect([MESSAGE_BOX_WIDTH, MESSAGE_BOX_HEIGHT]).toEqual([448, 47]);
    expect(defaultMessageBoxPosition(1, 800)).toEqual({ x: 16, y: 800 - 63 });
    expect(defaultMessageBoxPosition(2, 900)).toEqual({ x: 32, y: 900 - 126 });
  });

  it("maps focus requests to text selections", () => {
    expect(selectionRange("end", 7)).toEqual({ start: 7, end: 7 });
    expect(selectionRange("all", 7)).toEqual({ start: 0, end: 7 });
    expect(selectionRange({ start: 6, end: 6 }, 7)).toEqual({ start: 6, end: 6 });
    expect(selectionRange({ start: 9, end: 2 }, 7)).toEqual({ start: 7, end: 7 });
  });

  it("moves the focus out of a text input on a card press, but keeps it in the card's own hidden textarea (Requirement 2.8)", () => {
    const focused = (matches: boolean) => {
      const element = { blurred: 0, closest: () => (matches ? {} : null), blur: () => void element.blurred++ };
      return element;
    };
    const messageBoxInput = focused(true);
    expect(releaseTextFocus(messageBoxInput, null)).toBe(true);
    expect(messageBoxInput.blurred).toBe(1);
    const hidden = focused(true);
    expect(releaseTextFocus(hidden, hidden)).toBe(false);
    expect(hidden.blurred).toBe(0);
    const button = focused(false);
    expect(releaseTextFocus(button, null)).toBe(false);
    expect(button.blurred).toBe(0);
    expect(releaseTextFocus(null, null)).toBe(false);
    expect(releaseTextFocus({}, null)).toBe(false); // the document body in old engines: nothing to blur
  });
});

describe("MessageBoxWindow rendering", () => {
  const render = (box = createMessageBox(), k = 1) =>
    renderToStaticMarkup(createElement(UiScaleContext, { value: k }, createElement(MessageBoxWindow, { controller: box, onReturn: () => {} })));

  it("renders nothing while closed", () => {
    expect(render()).toBe("");
  });

  it("renders a floating palette-chrome window with a labelled one-line text box (Requirements 2.1, 2.9, 13.2)", () => {
    const box = createMessageBox();
    box.show({ line: 'put "brass lamp" into card field 1' });
    const html = render(box, 2);
    expect(html).toContain('class="s7-palette s7-message-box" role="dialog" aria-label="Message Box"');
    expect(html).toContain('class="s7-close-box" aria-label="Close Message Box"');
    const input = html.match(/<input [^>]*>/)?.[0] ?? "";
    expect(input).toContain('type="text" class="s7-input s7-message-box-input" aria-label="Message Box"');
    expect(input).toMatch(/spellcheck="false"/i);
    expect(input).toContain('value="put &quot;brass lamp&quot; into card field 1"');
    expect(html).not.toContain("aria-modal"); // not a studio window (Requirement 2.5)
    // Every label is printable ASCII.
    for (const label of html.matchAll(/aria-label="([^"]*)"/g)) expect(label[1]).toMatch(/^[\x20-\x7e]+$/);
    // At k = 2 the first position is 32 px from the left.
    expect(html).toContain("left:32px");
  });

  it("is styled with the 1-bit rules: solid frames, theme colours, no blur, gradient, opacity or rounding (Requirement 13.1)", () => {
    const rules = [...SHELL_CSS.matchAll(/(\.s7-message-box[^{]*|\.s7-shell \.s7-message-box-input)\{([^}]*)\}/g)];
    expect(rules.length).toBeGreaterThanOrEqual(3);
    for (const [, , body] of rules) {
      expect(body).not.toMatch(/gradient|blur|opacity|border-radius|dashed|dotted|shadow/);
    }
    expect(SHELL_CSS).toMatch(/\.s7-message-box \{\s*width: calc\(448 \* var\(--px\)\);/);
  });
});
