// Spec 07 property tests (design §Correctness Properties, §Testing Strategy; Requirement 17.2).
// One section per property, each with its own generators; later tasks add Properties 3 to 6 below
// the marker at the end of the file. Each property is one fast-check test run at least 100 times.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { astArb } from "../../core/__tests__/hexAstArbitraries.ts";
import { validateStack as validateStackOracle } from "../../core/__tests__/stackValidatorOracle.ts";
import { BLANK_ICON, encodeIcon, ICON_PIXELS } from "../../core/icons.ts";
import { printHexTalk } from "../../core/parser.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { encodeBitmapRLE, TOTAL_PIXELS } from "../../engine/graphics/rleCodec.ts";
import { encodeStackFile } from "../../storage/stackFile.ts";
import { checkStack } from "../../storage/stackLoader.ts";
import { checkStack as checkStackOracle } from "../../storage/__tests__/checkStackOracle.ts";
import { checkArguments } from "../argumentCheck.ts";
import { QUOTE_LIMIT } from "../results.ts";
import { createPowerTools, type ToolName } from "../tools/index.ts";

// ---------------------------------------------------------------------------------------------
// Shared by all properties
// ---------------------------------------------------------------------------------------------

/** Every property runs this many cases (Requirement 17.2: at least 100). */
const NUM_RUNS = 200;

const tools = createPowerTools();

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

  // Properties 3 to 6 are added here by tasks 4.3, 5.2, 5.3 and 5.4, each as its own `it` with
  // its own `// Feature: 07-kiro-power, Property <n>: <title>` comment and its own generators.
});
