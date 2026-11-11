// Spec 07 property tests (design §Correctness Properties, §Testing Strategy; Requirement 17.2).
// One section per property, each with its own generators; later tasks add Properties 3 to 6 below
// the marker at the end of the file. Each property is one fast-check test run at least 100 times.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { astArb } from "../../core/__tests__/hexAstArbitraries.ts";
import { validateStack as validateStackOracle } from "../../core/__tests__/stackValidatorOracle.ts";
import { createBlankStack } from "../../core/authoringCommands.ts";
import { BLANK_ICON, encodeIcon, ICON_PIXELS } from "../../core/icons.ts";
import { createHistory } from "../../core/history.ts";
import { printHexTalk } from "../../core/parser.ts";
import { THEME_PALETTES, type ThemePaletteName } from "../../core/schema.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { createHexStore, type CompiledScript, type HexLayer } from "../../core/store.ts";
import { rectLoopOracle } from "../../engine/graphics/__tests__/rectLoopOracle.ts";
import { bresenhamLine, createPaintController } from "../../engine/graphics/paintTools.ts";
import { PATTERNS, patternState } from "../../engine/graphics/patterns.ts";
import { BITMAP_HEIGHT, BITMAP_WIDTH, decodeBitmapRLE, encodeBitmapRLE, TOTAL_PIXELS } from "../../engine/graphics/rleCodec.ts";
import { encodeStackFile } from "../../storage/stackFile.ts";
import { checkStack } from "../../storage/stackLoader.ts";
import { checkStack as checkStackOracle } from "../../storage/__tests__/checkStackOracle.ts";
import { checkArguments } from "../argumentCheck.ts";
import { QUOTE_LIMIT } from "../results.ts";
import { createPowerTools, type ToolName } from "../tools/index.ts";
import { pngOfContent, readPng } from "./pngReader.ts";
import { FONTS } from "./toolFixtures.ts";

// ---------------------------------------------------------------------------------------------
// Shared by all properties
// ---------------------------------------------------------------------------------------------

/** Every property runs this many cases (Requirement 17.2: at least 100). */
const NUM_RUNS = 200;

const tools = createPowerTools({ fonts: FONTS });

/** Calls a tool through its `checkArguments` and `run`, as the protocol handler does. */
async function callTool(name: ToolName, args: Record<string, unknown>): Promise<{ isError: boolean; json: any }> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`no tool named ${name}`);
  const problems = tool.checkArguments ? tool.checkArguments(args) : checkArguments(tool.inputSchema, args);
  if (problems.length > 0) throw new Error(`arguments of ${name} rejected: ${problems.join("; ")}`);
  const result = await tool.run(args);
  const first = result.content[0];
  if (first.type !== "text") throw new Error(`first content of ${name} is not text`);
  return { isError: result.isError, json: JSON.parse(first.text) };
}

// ---------------------------------------------------------------------------------------------
// Property 1: validate_stack agrees with the gate, in both text forms
// ---------------------------------------------------------------------------------------------

/** Plain, mutable stack trees: the faults below change them in place before they are read. */
type Plain = any;

const MAX_TEXT = 120;
// Texts of up to 120 characters: most are short, some straddle the 80-character quoting limit.
const shortText = fc.string({ maxLength: 20 });
const longText = fc.string({ minLength: 78, maxLength: MAX_TEXT });
const textArb = fc.oneof({ weight: 3, arbitrary: shortText }, { weight: 1, arbitrary: longText });

// Layers: "" and a few canonical pictures built once, plus one that decodes but is not canonical
// (a PackBits no-op byte in front), so that notes occur on accepted stacks.
function layerOf(stateAt: (x: number, y: number) => 0 | 1 | 2): string {
  const pixels = new Uint8Array(TOTAL_PIXELS);
  for (let i = 0; i < TOTAL_PIXELS; i++) pixels[i] = stateAt(i % 512, Math.floor(i / 512));
  return encodeBitmapRLE(pixels);
}
const DARK_LAYER = layerOf(() => 2);
const NON_CANONICAL_LAYER = btoa(String.fromCharCode(0x80, ...Array.from(atob(DARK_LAYER), (c) => c.charCodeAt(0))));
const layerArb = fc.oneof(
  { weight: 5, arbitrary: fc.constant("") },
  { weight: 1, arbitrary: fc.constant(DARK_LAYER) },
  { weight: 1, arbitrary: fc.constant(layerOf(() => 1)) },
  { weight: 1, arbitrary: fc.constant(layerOf(() => 0)) },
  { weight: 1, arbitrary: fc.constant(layerOf((x, y) => (((x >> 5) + (y >> 5)) % 3) as 0 | 1 | 2)) },
  { weight: 1, arbitrary: fc.constant(NON_CANONICAL_LAYER) },
);

const scriptArb = fc.oneof(
  { weight: 3, arbitrary: fc.constant("") },
  { weight: 2, arbitrary: fc.constantFrom("on mouseUp\n  go next\nend mouseUp", "on openCard\n  play boing\nend openCard") },
  { weight: 2, arbitrary: textArb }, // mostly script errors
);

const rectArb = fc.record({
  x: fc.integer({ min: -50, max: 600 }),
  y: fc.integer({ min: -50, max: 600 }),
  width: fc.integer({ min: 0, max: 600 }),
  height: fc.integer({ min: 0, max: 600 }),
});

const partCommon = {
  suffix: textArb,
  name: textArb,
  rect: rectArb,
  visible: fc.boolean(),
  enabled: fc.boolean(),
  scriptSource: scriptArb,
  prompt: fc.option(textArb, { nil: undefined }),
};
const buttonSpecArb = fc.record({
  ...partCommon,
  type: fc.constant("button" as const),
  style: fc.constantFrom("transparent", "opaque", "rectangle", "roundRect", "shadow", "checkBox", "radioButton", "default"),
  title: textArb,
  showName: fc.boolean(),
  autoHilite: fc.boolean(),
  hilite: fc.boolean(),
  iconPick: fc.option(fc.nat(), { nil: undefined }),
  family: fc.option(fc.integer({ min: 1, max: 15 }), { nil: undefined }),
});
const fieldSpecArb = fc.record({
  ...partCommon,
  type: fc.constant("field" as const),
  style: fc.constantFrom("transparent", "opaque", "rectangle", "shadow", "scrolling"),
  content: textArb,
  sharedText: fc.boolean(),
  lockText: fc.boolean(),
  dontWrap: fc.boolean(),
  showLines: fc.boolean(),
  textAlign: fc.constantFrom("left", "center", "right"),
  textFont: fc.constantFrom("System", "Sans", "Mono", "Serif"),
  textSize: fc.constantFrom(9, 10, 12, 14, 18, 24),
  textStyle: fc.subarray(["bold", "italic", "underline", "outline", "shadow", "condense"] as const),
});
const partSpecArb = fc.oneof({ weight: 2, arbitrary: buttonSpecArb }, { weight: 1, arbitrary: fieldSpecArb });
const partsArb = fc.array(partSpecArb, { maxLength: 3 });

const iconNameArb = fc.stringMatching(/^[!-~]([ -~]{0,30}[!-~])?$/).filter((name) => name !== "__proto__");
const iconDataArb = fc.oneof(
  fc.constant(BLANK_ICON),
  fc.uint8Array({ minLength: ICON_PIXELS, maxLength: ICON_PIXELS, max: 1 }).map(encodeIcon),
);
const hexColourArb = fc
  .array(fc.constantFrom(..."0123456789abcdefABCDEF".split("")), { minLength: 6, maxLength: 6 })
  .map((digits) => `#${digits.join("")}`);

const stackSpecArb = fc.record({
  suffix: textArb,
  name: textArb,
  author: textArb,
  createdAt: shortText,
  updatedAt: shortText,
  theme: fc.record({ name: fc.constantFrom("ClassicPaper", "AmberCRT", "GreenPhosphor", "MidnightHex"), dark: hexColourArb, light: hexColourArb }),
  icons: fc.array(fc.tuple(iconNameArb, iconDataArb), { maxLength: 3 }),
  scriptSource: scriptArb,
  backgrounds: fc.array(
    fc.record({ suffix: textArb, name: textArb, layer: layerArb, parts: partsArb, scriptSource: scriptArb, cantDelete: fc.boolean() }),
    { minLength: 1, maxLength: 4 },
  ),
  cards: fc.array(
    fc.record({
      suffix: textArb,
      name: textArb,
      backgroundPick: fc.nat(),
      layer: layerArb,
      parts: partsArb,
      bgFieldContents: fc.dictionary(shortText, textArb, { maxKeys: 3, noNullPrototype: true }),
      marked: fc.boolean(),
      cantDelete: fc.boolean(),
      dontSearch: fc.boolean(),
      scriptSource: scriptArb,
    }),
    { minLength: 1, maxLength: 6 },
  ),
});
type StackSpec = typeof stackSpecArb extends fc.Arbitrary<infer T> ? T : never;
type PartSpec = StackSpec["backgrounds"][number]["parts"][number];

/** A valid stack, from a spec: ids are unique (counter first), and carry a random suffix so long ids occur. */
function buildStack(spec: StackSpec): Plain {
  let counter = 0;
  const id = (prefix: string, suffix: string): string => `${prefix}${counter++}_${suffix}`;
  const iconNames = Array.from(new Set(spec.icons.map(([name]) => name)));
  const buildPart = (part: PartSpec, layerScope: "card" | "background"): Plain => {
    const base = {
      id: id("prt_", part.suffix),
      name: part.name,
      type: part.type,
      layerScope,
      rect: { ...part.rect },
      visible: part.visible,
      enabled: part.enabled,
      scriptSource: part.scriptSource,
      ...(part.prompt === undefined ? {} : { naturalLanguagePrompt: part.prompt }),
    };
    if (part.type === "field") {
      return {
        ...base, style: part.style, content: part.content, sharedText: part.sharedText, lockText: part.lockText,
        dontWrap: part.dontWrap, showLines: part.showLines, textAlign: part.textAlign, textFont: part.textFont,
        textSize: part.textSize, textStyle: [...part.textStyle],
      };
    }
    return {
      ...base, style: part.style, title: part.title, showName: part.showName,
      ...(part.iconPick === undefined || iconNames.length === 0 ? {} : { iconId: iconNames[part.iconPick % iconNames.length] }),
      autoHilite: part.autoHilite, hilite: part.hilite,
      ...(part.family === undefined ? {} : { family: part.family }),
    };
  };
  const stackId = id("stk_", spec.suffix);
  const backgrounds = spec.backgrounds.map((background) => ({
    id: id("bkg_", background.suffix),
    name: background.name,
    bitmap: { width: 512, height: 342, rleData: background.layer },
    parts: background.parts.map((part) => buildPart(part, "background")),
    scriptSource: background.scriptSource,
    cantDelete: background.cantDelete,
  }));
  const cards = spec.cards.map((card) => ({
    id: id("crd_", card.suffix),
    name: card.name,
    backgroundId: backgrounds[card.backgroundPick % backgrounds.length].id,
    bitmap: { width: 512, height: 342, rleData: card.layer },
    parts: card.parts.map((part) => buildPart(part, "card")),
    bgFieldContents: { ...card.bgFieldContents },
    marked: card.marked,
    cantDelete: card.cantDelete,
    dontSearch: card.dontSearch,
    scriptSource: card.scriptSource,
  }));
  return {
    id: stackId,
    schemaVersion: "2.0.0",
    name: spec.name,
    author: spec.author,
    createdAt: spec.createdAt,
    updatedAt: spec.updatedAt,
    dimensions: { width: 512, height: 342 },
    themePalette: { name: spec.theme.name, darkBitHex: spec.theme.dark, lightBitHex: spec.theme.light },
    backgrounds,
    cards,
    customIcons: Object.fromEntries(spec.icons),
    scriptSource: spec.scriptSource,
  };
}

// The injected faults: one generator per kind of gate error of Requirement 6.4. Each fault changes the
// built stack in place and does nothing when its target does not exist (a stack without buttons has no
// icon to dangle); the property holds whatever the fault did.
const MISSING = Symbol("missing");
type Fault =
  | { kind: "version"; value: unknown }
  | { kind: "protoIcon"; data: string }
  | { kind: "schemaIssue"; which: number; pick: number; text: string }
  | { kind: "layerScope"; pick: number }
  | { kind: "missingBackground"; pick: number; remove: boolean; text: string }
  | { kind: "repeatedId"; from: number; to: number }
  | { kind: "danglingIcon"; pick: number; text: string }
  | { kind: "badLayer"; pick: number; rleData: string };

// A changed non-string schemaVersion stays short (design §Testing Strategy): validateStack prints it
// with String(version), and that text is shortened when it is longer than 80 characters even though
// no single string or key in it is.
const wrongVersionArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.constant(MISSING),
  textArb.filter((text) => text !== "2.0.0"),
  fc.integer(),
  fc.double({ noNaN: true, noDefaultInfinity: true }).filter((n) => !Object.is(n, -0)),
  fc.boolean(),
  fc.constant(null),
  fc.array(fc.oneof(fc.integer(), fc.boolean()), { maxLength: 4 }),
  fc.dictionary(fc.constantFrom("a", "b", "c"), fc.integer(), { maxKeys: 2, noNullPrototype: true }),
);
const badRleDataArb = fc.oneof(fc.constantFrom("AAAA", "!!!", "="), textArb);
const faultArb: fc.Arbitrary<Fault> = fc.oneof(
  fc.record({ kind: fc.constant("version" as const), value: wrongVersionArb }),
  fc.record({ kind: fc.constant("protoIcon" as const), data: iconDataArb }),
  fc.record({ kind: fc.constant("schemaIssue" as const), which: fc.nat(), pick: fc.nat(), text: textArb }),
  fc.record({ kind: fc.constant("layerScope" as const), pick: fc.nat() }),
  fc.record({ kind: fc.constant("missingBackground" as const), pick: fc.nat(), remove: fc.boolean(), text: textArb }),
  fc.record({ kind: fc.constant("repeatedId" as const), from: fc.nat(), to: fc.nat() }),
  fc.record({ kind: fc.constant("danglingIcon" as const), pick: fc.nat(), text: textArb }),
  fc.record({ kind: fc.constant("badLayer" as const), pick: fc.nat(), rleData: badRleDataArb }),
);

const isObject = (value: unknown): value is Plain => typeof value === "object" && value !== null && !Array.isArray(value);
const objectsIn = (value: unknown): Plain[] => (Array.isArray(value) ? value.filter(isObject) : []);
const layerOwners = (stack: Plain): Plain[] => [...objectsIn(stack.backgrounds), ...objectsIn(stack.cards)];
const partsOf = (stack: Plain): Plain[] => layerOwners(stack).flatMap((owner) => objectsIn(owner.parts));
const idNodes = (stack: Plain): Plain[] => [stack, ...layerOwners(stack).flatMap((owner) => [owner, ...objectsIn(owner.parts)])];
const pickFrom = <T>(list: T[], pick: number): T | undefined => (list.length === 0 ? undefined : list[pick % list.length]);
/** Defines an own enumerable key, also "__proto__" (assignment would change the prototype instead). */
function setOwn(target: Plain, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/** Schema issues of several kinds: unknown keys (the key is stack text), wrong types, bad values, missing keys. */
const SCHEMA_ISSUES: Array<(stack: Plain, pick: number, text: string) => void> = [
  (stack, _pick, text) => { if (!Object.hasOwn(stack, text)) setOwn(stack, text, 1); },
  (stack, pick, text) => {
    const node = pickFrom(idNodes(stack), pick);
    if (node !== undefined && !Object.hasOwn(node, text)) setOwn(node, text, null);
  },
  (stack, pick) => { const node = pickFrom(idNodes(stack), pick); if (node !== undefined) node.name = 5; },
  (stack, pick) => { const part = pickFrom(partsOf(stack), pick); if (isObject(part?.rect)) part.rect.width = 1.5; },
  (stack, pick) => { const part = pickFrom(partsOf(stack), pick); if (isObject(part?.rect)) part.rect.height = -3; },
  (stack, _pick, text) => { if (isObject(stack.themePalette)) stack.themePalette.darkBitHex = text; },
  (stack) => { if (isObject(stack.dimensions)) stack.dimensions.width = 100; },
  (stack) => { stack.backgrounds = []; },
  (stack) => { stack.cards = []; },
  (stack, _pick, text) => { if (isObject(stack.customIcons)) setOwn(stack.customIcons, ` ${text}`, BLANK_ICON); },
  (stack, _pick, text) => { if (isObject(stack.customIcons)) setOwn(stack.customIcons, "icon", text); },
  (stack, pick) => {
    const field = pickFrom(partsOf(stack).filter((part) => part.type === "field"), pick);
    if (field !== undefined) field.textSize = 11;
  },
  (stack, pick) => { const owner = pickFrom(layerOwners(stack), pick); if (isObject(owner?.bitmap)) owner.bitmap.rleData = 5; },
  (stack, pick) => { const node = pickFrom(idNodes(stack), pick); if (node !== undefined) delete node.scriptSource; },
  (stack, pick, text) => {
    const card = pickFrom(objectsIn(stack.cards), pick);
    if (isObject(card?.bgFieldContents)) setOwn(card.bgFieldContents, text, 5);
  },
  (stack, pick, text) => { const part = pickFrom(partsOf(stack), pick); if (part !== undefined) part.type = text; },
];

function applyFault(stack: Plain, fault: Fault): void {
  switch (fault.kind) {
    case "version":
      if (fault.value === MISSING) delete stack.schemaVersion;
      else stack.schemaVersion = fault.value;
      break;
    case "protoIcon":
      if (isObject(stack.customIcons)) setOwn(stack.customIcons, "__proto__", fault.data);
      break;
    case "schemaIssue":
      SCHEMA_ISSUES[fault.which % SCHEMA_ISSUES.length](stack, fault.pick, fault.text);
      break;
    case "layerScope": {
      const part = pickFrom(partsOf(stack), fault.pick);
      if (part !== undefined) part.layerScope = part.layerScope === "card" ? "background" : "card";
      break;
    }
    case "missingBackground": {
      if (fault.remove && Array.isArray(stack.backgrounds) && stack.backgrounds.length > 0) {
        stack.backgrounds.splice(fault.pick % stack.backgrounds.length, 1);
      } else {
        const card = pickFrom(objectsIn(stack.cards), fault.pick);
        if (card !== undefined) card.backgroundId = fault.text;
      }
      break;
    }
    case "repeatedId": {
      const nodes = idNodes(stack);
      const from = pickFrom(nodes, fault.from);
      const to = pickFrom(nodes, fault.to);
      if (from !== undefined && to !== undefined && from !== to) from.id = to.id;
      break;
    }
    case "danglingIcon": {
      const button = pickFrom(partsOf(stack).filter((part) => part.type === "button"), fault.pick);
      if (button !== undefined) button.iconId = fault.text;
      break;
    }
    case "badLayer": {
      const owner = pickFrom(layerOwners(stack), fault.pick);
      if (isObject(owner?.bitmap)) owner.bitmap.rleData = fault.rleData;
      break;
    }
  }
}

// About 30% of the values are valid stacks; the rest have one to three faults.
const faultsArb = fc.oneof({ weight: 3, arbitrary: fc.constant<Fault[]>([]) }, { weight: 7, arbitrary: fc.array(faultArb, { minLength: 1, maxLength: 3 }) });
const stackValueArb: fc.Arbitrary<Plain> = fc.tuple(stackSpecArb, faultsArb).map(([spec, faults]) => {
  const stack = buildStack(spec);
  for (const fault of faults) applyFault(stack, fault);
  return stack;
});

/** Every string value and object key of the value that is longer than 80 characters (Requirement 5.7). */
function longTexts(value: unknown, found: string[] = []): string[] {
  if (typeof value === "string") {
    if (value.length > QUOTE_LIMIT) found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) longTexts(item, found);
  } else if (isObject(value)) {
    for (const key of Object.keys(value)) {
      if (key.length > QUOTE_LIMIT) found.push(key);
      longTexts(value[key], found);
    }
  }
  return found;
}

/**
 * The oracle for Requirement 5.7 on a gate error: every text of `texts` that occurs in `error` is
 * replaced by its first 77 characters followed by "...". Longer texts go first, so that a long text
 * that contains another one is replaced as a whole. split/join, never a RegExp built from stack text.
 * This does not use quoteText from src/power, so the test stays independent of the code it checks.
 */
function shortenLongTexts(error: string, texts: readonly string[]): string {
  let out = error;
  for (const text of [...texts].sort((a, b) => b.length - a.length)) {
    out = out.split(text).join(text.slice(0, 77) + "...");
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Property 3: render_card PNG holds the frame
// ---------------------------------------------------------------------------------------------

const themeArb = fc.constantFrom(...(Object.keys(THEME_PALETTES) as ThemePaletteName[]));
const scaleArb = fc.constantFrom(1 as const, 2 as const);

// A picture of TOTAL_PIXELS states, each 1 (light) or 2 (dark). Two random bit strings are combined by
// one of five rules, so the dark share is about 0, 25, 50, 75 or 100 percent and runs of equal pixels
// of every length occur (the PNG compressor and the bitmap codec see both noise and flat areas).
const PICTURE_BYTES = TOTAL_PIXELS / 8;
const layerPictureArb: fc.Arbitrary<Uint8Array> = fc
  .tuple(
    fc.uint8Array({ minLength: PICTURE_BYTES, maxLength: PICTURE_BYTES }),
    fc.uint8Array({ minLength: PICTURE_BYTES, maxLength: PICTURE_BYTES }),
    fc.constantFrom("plain", "and", "or", "allLight", "allDark"),
  )
  .map(([a, b, rule]) => {
    const picture = new Uint8Array(TOTAL_PIXELS);
    for (let i = 0; i < TOTAL_PIXELS; i++) {
      const bitA = (a[i >> 3] >> (i & 7)) & 1;
      const bitB = (b[i >> 3] >> (i & 7)) & 1;
      const dark = rule === "plain" ? bitA : rule === "and" ? bitA & bitB : rule === "or" ? bitA | bitB : rule === "allDark" ? 1 : 0;
      picture[i] = dark ? 2 : 1;
    }
    return picture;
  });

const hexToRgb = (hex: string): [number, number, number] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];

/** Calls render_card through its `checkArguments` and `run`; unlike callTool it keeps every content. */
async function callRenderCard(args: Record<string, unknown>): Promise<{ isError: boolean; content: Array<Record<string, any>> }> {
  const tool = tools.find((candidate) => candidate.name === "render_card");
  if (tool === undefined) throw new Error("no tool named render_card");
  const problems = tool.checkArguments ? tool.checkArguments(args) : checkArguments(tool.inputSchema, args);
  if (problems.length > 0) throw new Error(`arguments of render_card rejected: ${problems.join("; ")}`);
  const result = await tool.run(args);
  return { isError: result.isError, content: result.content as Array<Record<string, any>> };
}

// ---------------------------------------------------------------------------------------------
// Property 4: draw_layer rectangles and lines equal the paint tools
// ---------------------------------------------------------------------------------------------

/** One drag of the Rect or Line tool, with the setting that the matching draw_layer command carries. */
interface Drag {
  tool: "rect" | "line";
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** undefined: the command leaves `pattern` out, the tools' default is solid dark (index 1). */
  pattern: number | undefined;
  /** undefined: the command leaves `filled` out (false). Only used by the Rect tool. */
  filled: boolean | undefined;
}

const layerKindArb = fc.constantFrom<HexLayer>("card", "background");
const pointArb = fc.record({ x: fc.integer({ min: 0, max: BITMAP_WIDTH - 1 }), y: fc.integer({ min: 0, max: BITMAP_HEIGHT - 1 }) });
const dragArb: fc.Arbitrary<Drag> = fc.record({
  tool: fc.constantFrom("rect" as const, "line" as const),
  from: pointArb,
  to: pointArb,
  pattern: fc.option(fc.integer({ min: 0, max: PATTERNS.length - 1 }), { nil: undefined }),
  filled: fc.option(fc.boolean(), { nil: undefined }),
});
const dragsArb = fc.array(dragArb, { minLength: 1, maxLength: 20 });

/**
 * The draw_layer command for a drag. A rectangle command names its top-left corner and size, so the
 * drag's two corners are put in order here; the Rect tool is symmetric in its corners, the Line
 * tool is not (Requirement 11.3), so a line keeps its two points in drag order.
 */
function commandOfDrag(drag: Drag): Record<string, unknown> {
  const extra = drag.pattern === undefined ? {} : { pattern: drag.pattern };
  if (drag.tool === "line") {
    return { op: "line", x1: drag.from.x, y1: drag.from.y, x2: drag.to.x, y2: drag.to.y, ...extra };
  }
  const x = Math.min(drag.from.x, drag.to.x);
  const y = Math.min(drag.from.y, drag.to.y);
  return {
    op: "rect",
    x,
    y,
    width: Math.abs(drag.from.x - drag.to.x) + 1,
    height: Math.abs(drag.from.y - drag.to.y) + 1,
    ...extra,
    ...(drag.filled === undefined ? {} : { filled: drag.filled }),
  };
}

const noScripts = (): CompiledScript => ({ ast: { handlers: {} }, errors: [] });

// ---------------------------------------------------------------------------------------------
// Property 5: sprites set exactly their cells
// ---------------------------------------------------------------------------------------------

/** A sprite command: `rows` are `height` strings of `width` characters, all `#` or `.`, wholly inside the layer. */
interface SpriteCase {
  layer: HexLayer;
  x: number;
  y: number;
  rows: string[];
}

// Sizes 1..64 in both directions (Requirement 5.3). The share of `#` cells is 0, 10, 50, 90 or 100
// percent, so all-light, all-dark and mixed sprites all occur. A 1 x 1 sprite is rare (about 1 in 4096)
// and is counted but not required.
const spriteCaseArb: fc.Arbitrary<SpriteCase> = fc
  .tuple(layerKindArb, fc.integer({ min: 1, max: 64 }), fc.integer({ min: 1, max: 64 }), fc.constantFrom(0, 10, 50, 90, 100))
  .chain(([layer, width, height, darkShare]) =>
    fc.record({
      layer: fc.constant(layer),
      // Any position that leaves the whole sprite inside the 512 x 342 layer, edges included.
      x: fc.integer({ min: 0, max: BITMAP_WIDTH - width }),
      y: fc.integer({ min: 0, max: BITMAP_HEIGHT - height }),
      rows: fc.array(fc.integer({ min: 0, max: 99 }), { minLength: width * height, maxLength: width * height }).map((draws) =>
        Array.from({ length: height }, (_, row) =>
          draws
            .slice(row * width, (row + 1) * width)
            .map((draw) => (draw < darkShare ? "#" : "."))
            .join(""),
        ),
      ),
    }),
  );

describe("tools property tests", () => {
  // Feature: 07-kiro-power, Property 1: validate_stack agrees with the gate, in both text forms
  // Validates: Requirements 6.3, 6.4, 6.7, 14.2
  it("Property 1: validate_stack agrees with the gate, in both text forms", async () => {
    const seen = { accepted: 0, rejected: 0, firstEntryCompared: 0, firstEntryNotCompared: 0 };
    await fc.assert(
      fc.asyncProperty(stackValueArb, async (value) => {
        const json = JSON.stringify(value);
        const gate = checkStack(value);

        // The studio's functions are unchanged since before spec 07.
        expect(validateStack(value)).toEqual(validateStackOracle(value));
        expect(gate).toEqual(checkStackOracle(value));

        // `hexstack: true` makes the result carry the .hexstack text too (Requirement 6.7).
        const fromJson = await callTool("validate_stack", { stack: json, hexstack: true });
        const fromFile = await callTool("validate_stack", { stack: await encodeStackFile(value), hexstack: true });
        expect(fromFile).toEqual(fromJson);

        // A gate verdict is a normal result, never an error result (Requirement 6.3).
        expect(fromJson.isError).toBe(false);
        expect(fromJson.json.ok).toBe(gate.ok);
        expect(fromJson.json.errors.length === 0).toBe(gate.ok);
        if (gate.ok) {
          seen.accepted++;
          return;
        }
        seen.rejected++;
        // Requirement 6.4: the first entry is checkStack's error. Where that error quotes a text
        // longer than 80 characters, the tool shortens it (Requirement 5.7, design decision D14), so
        // the expected entry is the gate error with each such text replaced by its short form.
        const longs = longTexts(value);
        const expected = shortenLongTexts(gate.error, longs);
        if (longs.some((text) => gate.error.includes(text))) seen.firstEntryNotCompared++;
        else seen.firstEntryCompared++;
        expect(fromJson.json.errors[0]).toBe(expected);
      }),
      { numRuns: NUM_RUNS },
    );
    // The generators must reach every branch of the comparison, or the property would pass without testing it.
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.rejected).toBeGreaterThan(0);
    expect(seen.firstEntryCompared).toBeGreaterThan(0);
    expect(seen.firstEntryNotCompared).toBeGreaterThan(0);
  }, 120_000);

  // Feature: 07-kiro-power, Property 2: compile_hextalk round trip
  // Validates: Requirements 7.3, 7.4
  // The generators are the parser round-trip property's own (src/core/__tests__/hexAstArbitraries.ts,
  // design decision D17), so compile_hextalk is tested on exactly the ASTs that property covers.
  it("Property 2: compile_hextalk round trip", async () => {
    await fc.assert(
      fc.asyncProperty(astArb, async (ast) => {
        const printed = printHexTalk(ast);
        // The handler names of A in order: astArb inserts handlers in generation order, under keys
        // that start with a letter, so the key order is that order.
        const handlers = Object.values(ast.handlers).map((handler) => handler.eventName);

        const first = await callTool("compile_hextalk", { source: printed });
        expect(first.isError).toBe(false);
        expect(first.json.ok).toBe(true);
        expect(first.json.canonical).toBe(printed);
        expect(first.json.handlers).toEqual(handlers);

        // Compiling the canonical form again gives the same canonical form and handler names.
        const second = await callTool("compile_hextalk", { source: first.json.canonical });
        expect(second.isError).toBe(false);
        expect(second.json.ok).toBe(true);
        expect(second.json.canonical).toBe(first.json.canonical);
        expect(second.json.handlers).toEqual(first.json.handlers);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 120_000);

  // Feature: 07-kiro-power, Property 3: render_card PNG holds the frame
  // Validates: Requirements 9.4, 9.7
  // The stack is a blank stack (one background with rleData "", one card, no parts) whose card layer
  // is replaced by a picture of light and dark pixels only. The card layer then covers the whole
  // background, so the composed frame is that picture; the expected image is computed from the
  // picture alone, not from composeFrame.
  it("Property 3: render_card PNG holds the frame", async () => {
    await fc.assert(
      fc.asyncProperty(themeArb, scaleArb, layerPictureArb, async (themeName, k, picture) => {
        const theme = THEME_PALETTES[themeName];
        const stack = createBlankStack({ now: new Date("2026-01-01T00:00:00.000Z"), random: () => 0.5 });
        stack.themePalette = { name: themeName, darkBitHex: theme.darkBitHex, lightBitHex: theme.lightBitHex };
        stack.cards[0].bitmap.rleData = encodeBitmapRLE(picture);
        const args = { stack: JSON.stringify(stack), scale: k };

        const first = await callRenderCard(args);
        expect(first.isError).toBe(false);
        expect(first.content.map((content) => content.type)).toEqual(["text", "image"]);
        expect(first.content[1].mimeType).toBe("image/png");

        const png = readPng(pngOfContent(first.content[1] as never));
        expect([png.width, png.height, png.bitDepth, png.colourType, png.interlace]).toEqual([512 * k, 342 * k, 1, 3, 0]);
        // The palette is exactly [lightBitHex, darkBitHex].
        expect(png.palette).toEqual([hexToRgb(theme.lightBitHex), hexToRgb(theme.darkBitHex)]);

        // The k x k block of every frame pixel has the palette index of the pixel's state (1 -> 0, 2 -> 1).
        const expected = new Uint8Array(png.width * png.height);
        for (let y = 0; y < 342 * k; y++) {
          const frameRow = Math.floor(y / k) * 512;
          for (let x = 0; x < 512 * k; x++) expected[y * png.width + x] = picture[frameRow + Math.floor(x / k)] === 2 ? 1 : 0;
        }
        expect(Buffer.from(png.indices).equals(Buffer.from(expected))).toBe(true);

        // A second call with the same arguments returns the same PNG data and the same JSON text.
        const second = await callRenderCard(args);
        expect(second.isError).toBe(false);
        expect(second.content[1].data).toBe(first.content[1].data);
        expect(second.content[0].text).toBe(first.content[0].text);
      }),
      { numRuns: NUM_RUNS },
    );
  }, 300_000);

  // Feature: 07-kiro-power, Property 4: draw_layer rectangles and lines equal the paint tools
  // Validates: Requirements 11.1, 11.2, 11.3, 11.6, 14.2
  // The paint tools run on a real store and history through createPaintController, on a blank stack
  // (layer "" = the base of draw_layer: transparent for a card, light for a background). Each drag is
  // `begin` at the first point and `end` at the second. After every drag the stack's layer is also
  // compared with a layer kept by the pre-spec-07 Rect loop (rectLoopOracle) for rectangles and by
  // bresenhamLine, the Line tool's own plotter, for lines.
  it("Property 4: draw_layer rectangles and lines equal the paint tools", async () => {
    const seen = { card: 0, background: 0, rects: 0, lines: 0, filled: 0, drawn: 0, blank: 0 };
    await fc.assert(
      fc.asyncProperty(layerKindArb, dragsArb, async (layer, drags) => {
        const base = layer === "card" ? 0 : 1;
        const stack = createBlankStack({ now: new Date("2026-01-01T00:00:00.000Z"), random: () => 0.5 });
        const store = createHexStore({ stack, compile: noScripts });
        const history = createHistory(store);
        store.setEditLayer(layer);
        let pattern = PATTERNS[1];
        let rectFilled = false;
        const paint = createPaintController({ store, history, getSettings: () => ({ pattern, rectFilled }) });
        const layerOfStore = (): Uint8Array => {
          const current = store.getSnapshot().stack;
          const owner = layer === "card" ? current.cards[0] : current.backgrounds[0];
          return decodeBitmapRLE(owner.bitmap.rleData, base);
        };

        const expected = new Uint8Array(TOTAL_PIXELS).fill(base);
        const plotExpected = (x: number, y: number): void => {
          if (x >= 0 && y >= 0 && x < BITMAP_WIDTH && y < BITMAP_HEIGHT) expected[y * BITMAP_WIDTH + x] = patternState(pattern, x, y);
        };
        for (const drag of drags) {
          pattern = PATTERNS[drag.pattern ?? 1];
          rectFilled = drag.filled ?? false;
          store.setTool(drag.tool);
          paint.begin(drag.from.x, drag.from.y);
          paint.end(drag.to.x, drag.to.y);
          if (drag.tool === "rect") rectLoopOracle(drag.from, drag.to, rectFilled, plotExpected);
          else bresenhamLine(drag.from.x, drag.from.y, drag.to.x, drag.to.y, plotExpected);
          // The controller's pixels for this drag are the oracle's (Requirements 11.6, 14.2).
          expect(Buffer.from(layerOfStore()).equals(Buffer.from(expected))).toBe(true);
          if (drag.tool === "rect") {
            seen.rects++;
            if (rectFilled) seen.filled++;
          } else {
            seen.lines++;
          }
        }
        seen[layer]++;

        const drawn = await callTool("draw_layer", { layer, commands: drags.map(commandOfDrag) });
        expect(drawn.isError).toBe(false);
        expect(drawn.json.ok).toBe(true);
        expect(drawn.json.layer).toBe(layer);
        const fromTool = decodeBitmapRLE(drawn.json.rleData, base);
        // A deep comparison of 175,104 states, reported as one boolean so a failure stays readable.
        expect(Buffer.from(fromTool).equals(Buffer.from(layerOfStore()))).toBe(true);
        if (drawn.json.rleData === "") seen.blank++;
        else seen.drawn++;
      }),
      { numRuns: NUM_RUNS },
    );
    // The generators must reach every branch, or the property would pass without testing it.
    for (const [name, count] of Object.entries(seen)) if (name !== "blank") expect(count, name).toBeGreaterThan(0);
  }, 600_000);

  // Feature: 07-kiro-power, Property 5: sprites set exactly their cells
  // Validates: Requirements 11.1, 11.4
  // The expected layer is built from the sprite alone: the base (0 for a card, 1 for a background),
  // then state 2 at every `#` cell and state 1 at every `.` cell, counted from the sprite's position.
  it("Property 5: sprites set exactly their cells", async () => {
    const seen = { card: 0, background: 0, allDark: 0, allLight: 0, mixed: 0, singleCell: 0, atEdge: 0 };
    await fc.assert(
      fc.asyncProperty(spriteCaseArb, async ({ layer, x, y, rows }) => {
        const base = layer === "card" ? 0 : 1;
        const expected = new Uint8Array(TOTAL_PIXELS).fill(base);
        rows.forEach((row, dy) => {
          for (let dx = 0; dx < row.length; dx++) expected[(y + dy) * BITMAP_WIDTH + x + dx] = row[dx] === "#" ? 2 : 1;
        });

        const drawn = await callTool("draw_layer", { layer, commands: [{ op: "sprite", x, y, rows }] });
        expect(drawn.isError).toBe(false);
        expect(drawn.json.ok).toBe(true);
        expect(drawn.json.layer).toBe(layer);
        // One boolean for the 175,104 states, so a failure stays readable.
        expect(Buffer.from(decodeBitmapRLE(drawn.json.rleData, base)).equals(Buffer.from(expected))).toBe(true);

        seen[layer]++;
        const joined = rows.join("");
        if (!joined.includes(".")) seen.allDark++;
        else if (!joined.includes("#")) seen.allLight++;
        else seen.mixed++;
        if (joined.length === 1) seen.singleCell++;
        if (x + rows[0].length === BITMAP_WIDTH || y + rows.length === BITMAP_HEIGHT || x === 0 || y === 0) seen.atEdge++;
      }),
      { numRuns: NUM_RUNS },
    );
    // The generators must reach every branch, or the property would pass without testing it.
    for (const [name, count] of Object.entries(seen)) if (name !== "singleCell") expect(count, name).toBeGreaterThan(0);
  }, 300_000);

  // Property 6 is added here by task 5.4, as its own `it` with its own
  // `// Feature: 07-kiro-power, Property 6: <title>` comment and its own generators.
});
