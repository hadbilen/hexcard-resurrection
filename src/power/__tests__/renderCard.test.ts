// Spec 07 task 4.2: render_card (Requirements 9.1 to 9.7, 10.1, 10.4, 10.5, 5.5, 5.6, 5.7; design
// §tools/renderCard.ts, §Data Models).
import { describe, expect, it } from "vitest";
import { encodeIcon, ICON_PIXELS } from "../../core/icons.ts";
import { THEME_PALETTES } from "../../core/schema.ts";
import { composeFrame, decodedLayerCacheSize } from "../../engine/graphics/bitmapCanvas.ts";
import { createPartRasterizer } from "../../engine/graphics/partRenderer.ts";
import { createNodeTextBackend } from "../nodeTextBackend.ts";
import { UNCOVERED_NOTE } from "../tools/renderCard.ts";
import { pngOfContent, readPng } from "./pngReader.ts";
import { button, clone, field, FONTS, makeCaller, makeStack, toHexstack } from "./toolFixtures.ts";
const { call } = makeCaller();
const render = (stack: unknown, extra: Record<string, unknown> = {}) =>
  call("render_card", { stack: typeof stack === "string" ? stack : JSON.stringify(stack), ...extra });
/** A stack with one field of every text source, a hidden, a disabled and an outside part. */
function richStack() {
  const stack = makeStack();
  stack.backgrounds[0].parts.push(field("prt_shared", { name: "Shared", sharedText: true, content: "shared text", rect: { x: 10, y: 150, width: 200, height: 40 } }));
  stack.cards[1].bgFieldContents = { prt_field: "second card text" };
  stack.cards[0].parts.push(
    field("prt_cardfield", { name: "CardField", layerScope: "card", content: "card text", rect: { x: 220, y: 40, width: 200, height: 60 } }),
    button("prt_hidden", { name: "Hidden", visible: false, rect: { x: 10, y: 200, width: 80, height: 20 } }),
    button("prt_disabled", { name: "Disabled", enabled: false, rect: { x: 10, y: 230, width: 80, height: 20 } }),
    button("prt_outside", { name: "Outside", showName: false, rect: { x: 480, y: 330, width: 60, height: 30 } }),
  );
  return stack;
}
describe("card selection (Requirement 9.2)", () => {
  const stack = makeStack();
  it("draws the first card when card is omitted, and a card by 1-based position", async () => {
    const first = await render(stack);
    expect(first.isError).toBe(false);
    expect(first.json.card).toEqual({ position: 1, count: 2, id: stack.cards[0].id, name: "Card 1" });
    expect((await render(stack, { card: 1 })).json.card.position).toBe(1);
    expect((await render(stack, { card: 2 })).json.card).toEqual({ position: 2, count: 2, id: "crd_second", name: "Second" });
  });
  it("picks a string by exact id first, else by the lower-cased name, the first match winning", async () => {
    expect((await render(stack, { card: "crd_second" })).json.card.position).toBe(2);
    expect((await render(stack, { card: "SECOND" })).json.card.position).toBe(2);
    expect((await render(stack, { card: "card 1" })).json.card.position).toBe(1);
    // The id beats a name that equals the string case-insensitively.
    const tricky = clone(stack);
    tricky.cards[0].name = "CRD_SECOND";
    expect((await render(tricky, { card: "crd_second" })).json.card.position).toBe(2);
    expect((await render(tricky, { card: "Crd_Second" })).json.card.position).toBe(1);
    // Two cards with equal names: the first one in cards order.
    const twins = clone(stack);
    twins.cards[1].name = "card 1";
    expect((await render(twins, { card: "CARD 1" })).json.card.position).toBe(1);
  });
  it('never reads a string as a position: "2" matches only an id or a name equal to 2', async () => {
    const missing = await render(stack, { card: "2" });
    expect(missing.isError).toBe(true);
    expect(missing.json).toEqual({ ok: false, errors: ['card: no card matches "2"; the stack has 2 cards'] });
    expect(missing.contentTypes).toEqual(["text"]);
    const named = clone(stack);
    named.cards[0].name = "2";
    expect((await render(named, { card: "2" })).json.card.position).toBe(1);
  });
  it("answers a missing card with an error result that states the selector and the number of cards, without an image", async () => {
    const byNumber = await render(stack, { card: 7 });
    expect(byNumber.isError).toBe(true);
    expect(byNumber.json).toEqual({ ok: false, errors: ["card: no card matches 7; the stack has 2 cards"] });
    expect(byNumber.contentTypes).toEqual(["text"]);
    const byName = await render(stack, { card: "nope" });
    expect(byName.json.errors).toEqual(['card: no card matches "nope"; the stack has 2 cards']);
    expect(byName.contentTypes).toEqual(["text"]);
  });
  it("quotes a long selector as its first 77 characters followed by ... (Requirement 5.7)", async () => {
    const selector = "s".repeat(200);
    const missing = await render(stack, { card: selector });
    expect(missing.json.errors).toEqual([`card: no card matches "${"s".repeat(77)}..."; the stack has 2 cards`]);
    const exact = await render(stack, { card: "s".repeat(80) });
    expect(exact.json.errors).toEqual([`card: no card matches "${"s".repeat(80)}"; the stack has 2 cards`]);
  });
});
describe("the result: content order, image, theme (Requirements 9.4, 9.5)", () => {
  it("returns the JSON text first and one image/png content second", async () => {
    const result = await render(makeStack());
    expect(result.isError).toBe(false);
    expect(result.contentTypes).toEqual(["text", "image"]);
    expect(result.content[1].mimeType).toBe("image/png");
    expect(result.json.ok).toBe(true);
    const png = readPng(pngOfContent(result.content[1] as never));
    expect(png.chunks.map((chunk) => chunk.type)).toEqual(["IHDR", "PLTE", "IDAT", "IEND"]);
  });
  it("sizes the image 512 x 342 at scale 1 and 1024 x 684 at scale 2, as the summary says", async () => {
    for (const scale of [undefined, 1, 2] as const) {
      const result = await render(makeStack(), scale === undefined ? {} : { scale });
      const k = scale ?? 1;
      expect(result.json.cardSize).toEqual({ width: 512, height: 342 });
      expect(result.json.image).toEqual({ width: 512 * k, height: 342 * k, scale: k, mimeType: "image/png" });
      const png = readPng(pngOfContent(result.content[1] as never));
      expect([png.width, png.height, png.bitDepth, png.colourType, png.interlace]).toEqual([512 * k, 342 * k, 1, 3, 0]);
    }
  });
  it("draws the frame that composeFrame gives with the Node text backend, as k x k blocks", async () => {
    const stack = richStack();
    const frame = composeFrame(stack, stack.cards[0].id, {}, createPartRasterizer({ textBackend: createNodeTextBackend(FONTS) }));
    expect(frame.some((state) => state === 2)).toBe(true);
    for (const scale of [1, 2] as const) {
      const { indices, width } = readPng(pngOfContent((await render(stack, { scale })).content[1] as never));
      let wrong = 0;
      for (let y = 0; y < 342; y++) {
        for (let x = 0; x < 512; x++) {
          const want = frame[y * 512 + x] === 2 ? 1 : 0;
          for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
            if (indices[(y * scale + dy) * width + x * scale + dx] !== want) wrong++;
          }
        }
      }
      expect(wrong).toBe(0);
    }
  });
  it("puts the stack's lightBitHex in palette entry 0 and darkBitHex in entry 1, reading hex case-insensitively, and reports them as stored", async () => {
    const stack = makeStack();
    stack.themePalette = { name: "AmberCRT", lightBitHex: "#ffb000", darkBitHex: "#1A1000" };
    const result = await render(stack);
    expect(result.json.theme).toEqual({ name: "AmberCRT", lightBitHex: "#ffb000", darkBitHex: "#1A1000" });
    expect(readPng(pngOfContent(result.content[1] as never)).palette).toEqual([[255, 176, 0], [26, 16, 0]]);
    for (const name of Object.keys(THEME_PALETTES) as Array<keyof typeof THEME_PALETTES>) {
      const themed = makeStack();
      themed.themePalette = { name, ...THEME_PALETTES[name] };
      const png = readPng(pngOfContent((await render(themed)).content[1] as never));
      const hex = (rgb: number[]) => `#${rgb.map((v) => v.toString(16).padStart(2, "0")).join("")}`.toUpperCase();
      expect(png.palette.map(hex)).toEqual([THEME_PALETTES[name].lightBitHex.toUpperCase(), THEME_PALETTES[name].darkBitHex.toUpperCase()]);
    }
  });
  it("names the background of the card, and reads a .hexstack text like the JSON text", async () => {
    const stack = makeStack();
    const json = await render(stack, { card: 2 });
    expect(json.json.background).toEqual({ id: stack.backgrounds[0].id, name: stack.backgrounds[0].name });
    const packed = await render(await toHexstack(stack), { card: 2 });
    expect(packed.text).toBe(json.text);
    expect(packed.content[1].data).toBe(json.content[1].data);
  });
  it("draws button icons from customIcons", async () => {
    const stack = makeStack();
    stack.customIcons["hex-test"] = encodeIcon(new Uint8Array(ICON_PIXELS).fill(1));
    stack.cards[0].parts[0] = button("prt_button", { iconId: "hex-test", rect: { x: 100, y: 100, width: 60, height: 60 } });
    const result = await render(stack);
    expect(result.json.parts.find((part: any) => part.id === "prt_button").iconId).toBe("hex-test");
    const frame = composeFrame(stack, stack.cards[0].id, {}, createPartRasterizer({ textBackend: createNodeTextBackend(FONTS) }));
    const { indices } = readPng(pngOfContent(result.content[1] as never));
    for (let i = 0; i < frame.length; i++) if ((frame[i] === 2 ? 1 : 0) !== indices[i]) throw new Error(`pixel ${i} differs`);
    // The icon's dark block really is in the picture.
    expect(indices[(116 - 0) * 512 + 130]).toBe(1);
  });
});
describe("the part summary (Requirement 9.6)", () => {
  it("lists the background's parts, then the card's parts, hidden ones included, each with its path, layer and rect", async () => {
    const stack = richStack();
    const { json } = await render(stack);
    expect(json.parts.map((part: any) => [part.path, part.layer, part.type, part.id])).toEqual([
      ["backgrounds[0].parts[0]", "background", "field", "prt_field"],
      ["backgrounds[0].parts[1]", "background", "field", "prt_shared"],
      ["cards[0].parts[0]", "card", "button", "prt_button"],
      ["cards[0].parts[1]", "card", "field", "prt_cardfield"],
      ["cards[0].parts[2]", "card", "button", "prt_hidden"],
      ["cards[0].parts[3]", "card", "button", "prt_disabled"],
      ["cards[0].parts[4]", "card", "button", "prt_outside"],
    ]);
    expect(json.parts[0]).toMatchObject({ name: "Field", rect: { x: 10, y: 40, width: 200, height: 100 }, style: "rectangle" });
    expect(json).not.toHaveProperty("partsNotShown");
  });
  it("writes the keys of a part in the documented order", async () => {
    const { json } = await render(richStack());
    expect(Object.keys(json)).toEqual(["ok", "card", "background", "cardSize", "image", "theme", "parts", "uncoveredCharacters"]);
    expect(Object.keys(json.parts[0])).toEqual([
      "path", "layer", "type", "id", "name", "rect", "style", "hidden", "disabled", "outsideCard", "text", "textLength", "textSource",
    ]);
    expect(Object.keys(json.parts[2])).toEqual(["path", "layer", "type", "id", "name", "rect", "style", "hidden", "disabled", "outsideCard", "title"]);
  });
  it("says whether a part is hidden, disabled or outside the card", async () => {
    const { json } = await render(richStack());
    const flags = (id: string) => {
      const part = json.parts.find((candidate: any) => candidate.id === id);
      return [part.hidden, part.disabled, part.outsideCard];
    };
    expect(flags("prt_field")).toEqual([false, false, false]);
    expect(flags("prt_hidden")).toEqual([true, false, false]);
    expect(flags("prt_disabled")).toEqual([false, true, false]);
    expect(flags("prt_outside")).toEqual([false, false, true]);
  });
  it("decides outsideCard by x < 0, y < 0, x + width > 512 or y + height > 342, and by nothing else", async () => {
    const cases: Array<[Record<string, number>, boolean]> = [
      [{ x: 0, y: 0, width: 512, height: 342 }, false],
      [{ x: 0, y: 0, width: 513, height: 342 }, true],
      [{ x: 0, y: 0, width: 512, height: 343 }, true],
      [{ x: -1, y: 0, width: 10, height: 10 }, true],
      [{ x: 0, y: -1, width: 10, height: 10 }, true],
      [{ x: 511, y: 341, width: 1, height: 1 }, false],
    ];
    for (const [rect, outside] of cases) {
      const stack = makeStack();
      stack.cards[0].parts[0] = button("prt_button", { rect: rect as never });
      expect((await render(stack)).json.parts.at(-1).outsideCard, JSON.stringify(rect)).toBe(outside);
    }
  });
  it("gives a button's title only when showName is true, and its iconId only when it has one", async () => {
    const { json } = await render(richStack());
    const byId = (id: string) => json.parts.find((part: any) => part.id === id);
    expect(byId("prt_button").title).toBe("Go");
    expect(byId("prt_outside")).not.toHaveProperty("title");
    expect(byId("prt_button")).not.toHaveProperty("iconId");
    expect(byId("prt_button")).not.toHaveProperty("text");
  });
  it("gives a field the text it shows on this card, its full length, and the source of the text", async () => {
    const stack = richStack();
    const first = (await render(stack, { card: 1 })).json;
    const second = (await render(stack, { card: 2 })).json;
    const field = (json: any, id: string) => json.parts.find((part: any) => part.id === id);
    // Card 1 has no bgFieldContents entry: empty text from cardBgFieldContents.
    expect(field(first, "prt_field")).toMatchObject({ text: "", textLength: 0, textSource: "cardBgFieldContents" });
    expect(field(second, "prt_field")).toMatchObject({ text: "second card text", textLength: 16, textSource: "cardBgFieldContents" });
    expect(field(first, "prt_shared")).toMatchObject({ text: "shared text", textLength: 11, textSource: "sharedBackgroundContent" });
    expect(field(second, "prt_shared")).toMatchObject({ text: "shared text", textSource: "sharedBackgroundContent" });
    expect(field(first, "prt_cardfield")).toMatchObject({ text: "card text", textLength: 9, textSource: "cardContent" });
    // Card 2 holds no card parts; its summary lists the background's parts only.
    expect(second.parts.map((part: any) => part.id)).toEqual(["prt_field", "prt_shared"]);
  });
  it("quotes ids, names, titles, icon ids and field texts longer than 80 characters, but reports textLength whole", async () => {
    const stack = makeStack();
    const long = (c: string, n: number) => c.repeat(n);
    stack.customIcons[long("i", 32)] = encodeIcon(new Uint8Array(ICON_PIXELS));
    stack.backgrounds[0].parts[0] = field("prt_field", { name: long("n", 81), content: "", sharedText: true });
    (stack.backgrounds[0].parts[0] as any).content = long("t", 200);
    stack.cards[0].parts[0] = button("prt_button", { title: long("b", 90), iconId: long("i", 32) });
    stack.cards[0].name = long("c", 100);
    stack.cards[0].parts.push(button(long("p", 120), { name: long("m", 80) }));
    const result = await render(stack);
    expect(result.json.errors).toBeUndefined();
    const { json } = result;
    const quoted = (c: string, n: number) => `${c.repeat(77)}...`.slice(0, n);
    expect(json.card.name).toBe(quoted("c", 80));
    const f = json.parts[0];
    expect(f.name).toBe(quoted("n", 80));
    expect(f.text).toBe(quoted("t", 80));
    expect(f.textLength).toBe(200);
    const b = json.parts.find((part: any) => part.type === "button" && part.id === "prt_button");
    expect(b.title).toBe(quoted("b", 80));
    expect(b.iconId).toBe("i".repeat(32)); // icon names have at most 32 characters: whole
    const last = json.parts.at(-1);
    expect(last.id).toBe(quoted("p", 80));
    expect(last.name).toBe("m".repeat(80)); // 80 characters: whole
    expect(/[^\s"]{81,}/.test(JSON.stringify(json))).toBe(false);
  });
  it("shows at most 100 parts and counts the rest (Requirement 5.6)", async () => {
    const make = (count: number) => {
      const stack = makeStack();
      stack.cards[0].parts = Array.from({ length: count }, (_, i) => button(`prt_b${i}`, { rect: { x: 0, y: 0, width: 4, height: 4 } }));
      return stack;
    };
    const exact = (await render(make(99))).json; // 99 + the background's field = 100
    expect(exact.parts).toHaveLength(100);
    expect(exact).not.toHaveProperty("partsNotShown");
    const over = (await render(make(100))).json; // 101 parts
    expect(over.parts).toHaveLength(100);
    expect(over.partsNotShown).toBe(1);
    expect(over.parts[0].id).toBe("prt_field");
    expect(over.parts[99].id).toBe("prt_b98");
  });
});
describe("uncovered characters (Requirements 9.5, 10.5)", () => {
  const CJK = "\u4e2d";
  it("lists each uncovered character once per visible part, in drawing order with the part's path, and adds the note", async () => {
    const stack = makeStack();
    stack.backgrounds[0].parts[0] = field("prt_field", { sharedText: true, content: `a${CJK}b${CJK}\u{1F4A9}\u4e2d` });
    stack.cards[0].parts[0] = button("prt_button", { title: `\u4e2d${CJK}\u4e01` });
    const { json } = await render(stack);
    expect(json.uncoveredCharacters).toEqual([
      { path: "backgrounds[0].parts[0]", character: "U+4E2D" },
      { path: "backgrounds[0].parts[0]", character: "U+1F4A9" },
      { path: "cards[0].parts[0]", character: "U+4E2D" },
      { path: "cards[0].parts[0]", character: "U+4E01" },
    ]);
    expect(json.uncoveredNote).toBe(UNCOVERED_NOTE);
    expect(Object.keys(json).slice(-2)).toEqual(["uncoveredCharacters", "uncoveredNote"]);
  });
  it("has an empty list and no note when every character is covered", async () => {
    const { json } = await render(richStack());
    expect(json.uncoveredCharacters).toEqual([]);
    expect(json).not.toHaveProperty("uncoveredNote");
  });
  it("counts a button title only when showName is true, and leaves out hidden parts", async () => {
    const stack = makeStack();
    stack.cards[0].parts = [
      button("prt_a", { title: CJK, showName: false }),
      button("prt_b", { title: CJK, visible: false }),
      button("prt_c", { title: CJK }),
    ];
    stack.backgrounds[0].parts[0] = field("prt_field", { content: CJK, visible: false });
    const { json } = await render(stack);
    expect(json.uncoveredCharacters).toEqual([{ path: "cards[0].parts[2]", character: "U+4E2D" }]);
  });
  it("leaves out hard line breaks, which the layout never draws", async () => {
    const stack = makeStack();
    stack.backgrounds[0].parts[0] = field("prt_field", { sharedText: true, content: "a\r\nb\rc\n" });
    expect((await render(stack)).json.uncoveredCharacters).toEqual([]);
  });
  it("reads a background field's text from this card's bgFieldContents when the text is not shared", async () => {
    const stack = makeStack();
    stack.cards[1].bgFieldContents = { prt_field: CJK };
    expect((await render(stack, { card: 1 })).json.uncoveredCharacters).toEqual([]);
    expect((await render(stack, { card: 2 })).json.uncoveredCharacters).toEqual([{ path: "backgrounds[0].parts[0]", character: "U+4E2D" }]);
  });
  it("judges a field's characters in the face of its own font and bold style", async () => {
    // Every logical font, bold included, resolves to a face through cssFontString, and U+4E2D is in none of them.
    for (const textFont of ["System", "Sans", "Mono", "Serif"] as const) {
      const stack = makeStack();
      stack.backgrounds[0].parts[0] = field("prt_field", { textFont, textStyle: ["bold"], sharedText: true, content: `x${CJK}` });
      expect((await render(stack)).json.uncoveredCharacters).toEqual([{ path: "backgrounds[0].parts[0]", character: "U+4E2D" }]);
    }
  });
  it("shows at most 100 uncovered entries and counts the rest", async () => {
    const stack = makeStack();
    const chars = Array.from({ length: 101 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join("");
    stack.backgrounds[0].parts[0] = field("prt_field", { sharedText: true, content: chars });
    const { json } = await render(stack);
    expect(json.uncoveredCharacters).toHaveLength(100);
    expect(json.uncoveredCharactersNotShown).toBe(1);
    expect(json.uncoveredCharacters[0].character).toBe("U+4E00");
    expect(json.uncoveredCharacters[99].character).toBe("U+4E63");
  });
});
describe("a stack the gate rejects (Requirements 9.1, 5.2)", () => {
  it("returns the errors validate_stack returns, in the same order, as an error result with no image", async () => {
    const broken = clone(makeStack());
    broken.cards[0].parts[0].layerScope = "background";
    broken.cards[1].parts.push(clone(broken.backgrounds[0].parts[0]));
    broken.cards[1].backgroundId = "bkg_missing";
    const validated = await call("validate_stack", { stack: JSON.stringify(broken) });
    expect(validated.json.ok).toBe(false);
    expect(validated.json.errors.length).toBeGreaterThan(1);
    const rendered = await render(broken);
    expect(rendered.isError).toBe(true);
    expect(rendered.contentTypes).toEqual(["text"]);
    expect(rendered.json).toEqual({ ok: false, errors: validated.json.errors });
  });
  it("caps the errors at 100 and counts the rest, as validate_stack does", async () => {
    const broken = clone(makeStack());
    broken.cards[0].parts = Array.from({ length: 106 }, () => clone(broken.cards[0].parts[0]));
    const validated = await call("validate_stack", { stack: JSON.stringify(broken) });
    expect(validated.json.errorsNotShown).toBeGreaterThan(0);
    const rendered = await render(broken);
    expect(rendered.isError).toBe(true);
    expect(rendered.json.errors).toHaveLength(100);
    expect(rendered.json.errors).toEqual(validated.json.errors);
    expect(rendered.json.errorsNotShown).toBe(validated.json.errorsNotShown);
  });
  it("returns the read errors of Requirement 6.2 with no image", async () => {
    const notJson = await render("{ not json");
    expect(notJson.isError).toBe(true);
    expect(notJson.contentTypes).toEqual(["text"]);
    expect(notJson.json.errors).toEqual((await call("validate_stack", { stack: "{ not json" })).json.errors);
    const notPacked = await render("https://example.com/a.hexstack");
    expect(notPacked.json.errors).toEqual((await call("validate_stack", { stack: "https://example.com/a.hexstack" })).json.errors);
    expect(notPacked.json.errors[0]).toMatch(/^stack: /);
  });
  it("names the stack argument when the gate step throws (Requirement 5.4), then answers the next call", async () => {
    let calls = 0;
    const { call: guarded } = makeCaller({
      steps: {
        listStackErrors: () => {
          if (calls++ === 0) throw new RangeError("Maximum call stack size exceeded");
          return { errors: [], stack: makeStack() };
        },
      },
    });
    const failed = await guarded("render_card", { stack: "{}" });
    expect(failed.isError).toBe(true);
    expect(failed.json).toEqual({ ok: false, errors: ["stack: The stack could not be checked: Maximum call stack size exceeded"] });
    expect((await guarded("render_card", { stack: "{}" })).json.ok).toBe(true);
  });
});
describe("no state between calls (Requirements 5.5, 9.7)", () => {
  it("leaves the decoded-layer cache empty after a call, an error result included", async () => {
    const stack = richStack();
    stack.backgrounds[0].bitmap.rleData = "";
    await render(stack);
    expect(decodedLayerCacheSize()).toBe(0);
    await render(stack, { card: 9 });
    expect(decodedLayerCacheSize()).toBe(0);
    await render("{ not json");
    expect(decodedLayerCacheSize()).toBe(0);
  });
  it("returns identical JSON text and byte-identical PNG data for the same arguments, also after other calls", async () => {
    const stack = richStack();
    const args = { card: 1, scale: 2 };
    const first = await render(stack, args);
    await render(makeStack(), { card: 2 });
    await call("compile_hextalk", { source: "on mouseUp\nend mouseUp" });
    await render(stack, { card: 9 });
    const second = await render(stack, args);
    expect(second.text).toBe(first.text);
    expect(second.content[1].data).toBe(first.content[1].data);
    // A newly created server gives the same.
    const fresh = await makeCaller().call("render_card", { stack: JSON.stringify(stack), ...args });
    expect(fresh.text).toBe(first.text);
    expect(fresh.content[1].data).toBe(first.content[1].data);
  });
  it("does not change the stack text it is given, and draws the stack as given (no script run)", async () => {
    const stack = richStack();
    stack.scriptSource = "on openStack\n  go to card 2\nend openStack";
    stack.cards[0].scriptSource = "on openCard\n  go to card 2\nend openCard";
    const text = JSON.stringify(stack);
    const result = await render(text);
    expect(result.json.card.position).toBe(1);
    expect(text).toBe(JSON.stringify(stack));
  });
});
