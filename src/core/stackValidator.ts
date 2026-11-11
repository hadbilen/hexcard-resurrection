/**
 * Load gate for untrusted stacks (IndexedDB, .hexstack files, URL hashes, presets).
 * Mirrors the persisted schema in `schema.ts` (hexcard_design_spec.md §2.1) and adds the
 * structural checks of Requirements 6.3–6.7: background references, layer scopes, at least one
 * card and background, globally unique ids, fixed 512x342 sizes, #RRGGBB palette colours and
 * integer part rects. A stack either passes whole or is rejected whole.
 *
 * Objects are strict: unknown keys (for example a persisted AST) are rejected (Requirement 4.5).
 */
import { z } from "zod";
import { ICON_DATA_PATTERN, isIconName } from "./icons.ts";
import type { HexPart, HexStack } from "./schema.ts";

export const SUPPORTED_SCHEMA_VERSION = "2.0.0";

/** The only stack and bitmap size supported in schema 2.0.0 (Requirement 6.6). */
export const STACK_WIDTH = 512;
export const STACK_HEIGHT = 342;

export type ValidateStackResult =
  | { ok: true; stack: HexStack }
  | { ok: false; error: string };

const idSchema = z.string();

const HEX_COLOUR = /^#[0-9A-Fa-f]{6}$/;
const hexColourSchema = z.string().regex(HEX_COLOUR, { error: "expected a #RRGGBB hex colour" });

const rectCoordinateSchema = z.number().int({ error: "expected an integer" });
const rectExtentSchema = rectCoordinateSchema.nonnegative({ error: "expected a non-negative integer" });

const rectSchema = z.strictObject({
  x: rectCoordinateSchema,
  y: rectCoordinateSchema,
  width: rectExtentSchema,
  height: rectExtentSchema,
});

const fixedWidthSchema = z.literal(STACK_WIDTH, {
  error: `expected ${STACK_WIDTH} (the only width supported in schema ${SUPPORTED_SCHEMA_VERSION})`,
});
const fixedHeightSchema = z.literal(STACK_HEIGHT, {
  error: `expected ${STACK_HEIGHT} (the only height supported in schema ${SUPPORTED_SCHEMA_VERSION})`,
});

const bitmapLayerSchema = z.strictObject({
  width: fixedWidthSchema,
  height: fixedHeightSchema,
  rleData: z.string(),
});

/** Spec 06 Requirement 8.2. */
const ICON_NAME_MESSAGE =
  "expected an icon name: 1 to 32 printable ASCII characters without spaces at the ends, not __proto__";
const iconNameSchema = z.string().refine(isIconName, { error: ICON_NAME_MESSAGE });
/** Spec 06 Requirement 8.1. */
const iconDataSchema = z.string().regex(ICON_DATA_PATTERN, {
  error: "expected icon data: 172 characters of canonical padded standard Base64 (128 bytes)",
});

const partBaseShape = {
  id: idSchema,
  name: z.string(),
  layerScope: z.enum(["card", "background"]),
  rect: rectSchema,
  visible: z.boolean(),
  enabled: z.boolean(),
  scriptSource: z.string(),
  naturalLanguagePrompt: z.string().optional(),
};

const buttonPartSchema = z.strictObject({
  ...partBaseShape,
  type: z.literal("button"),
  style: z.enum([
    "transparent", "opaque", "rectangle", "roundRect", "shadow", "checkBox", "radioButton", "default",
  ]),
  title: z.string(),
  showName: z.boolean(),
  iconId: z.string().optional(),
  autoHilite: z.boolean(),
  hilite: z.boolean(),
  family: z.number().int().min(1).max(15).optional(),
});

const fieldPartSchema = z.strictObject({
  ...partBaseShape,
  type: z.literal("field"),
  style: z.enum(["transparent", "opaque", "rectangle", "shadow", "scrolling"]),
  content: z.string(),
  sharedText: z.boolean(),
  lockText: z.boolean(),
  dontWrap: z.boolean(),
  showLines: z.boolean(),
  textAlign: z.enum(["left", "center", "right"]),
  textFont: z.enum(["System", "Sans", "Mono", "Serif"]),
  textSize: z.literal([9, 10, 12, 14, 18, 24]),
  textStyle: z.array(z.enum(["bold", "italic", "underline", "outline", "shadow", "condense"])),
});

const partSchema = z.discriminatedUnion("type", [buttonPartSchema, fieldPartSchema]);

const backgroundSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  bitmap: bitmapLayerSchema,
  parts: z.array(partSchema),
  scriptSource: z.string(),
  cantDelete: z.boolean(),
});

const cardSchema = z.strictObject({
  id: idSchema,
  name: z.string(),
  backgroundId: idSchema,
  bitmap: bitmapLayerSchema,
  parts: z.array(partSchema),
  bgFieldContents: z.record(idSchema, z.string()),
  marked: z.boolean(),
  cantDelete: z.boolean(),
  dontSearch: z.boolean(),
  scriptSource: z.string(),
});

const stackSchema = z.strictObject({
  id: idSchema,
  schemaVersion: z.literal(SUPPORTED_SCHEMA_VERSION),
  name: z.string(),
  author: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  dimensions: z.strictObject({
    width: fixedWidthSchema,
    height: fixedHeightSchema,
  }),
  themePalette: z.strictObject({
    name: z.enum(["ClassicPaper", "AmberCRT", "GreenPhosphor", "MidnightHex"]),
    darkBitHex: hexColourSchema,
    lightBitHex: hexColourSchema,
  }),
  backgrounds: z.array(backgroundSchema).min(1, { error: "must contain at least one background" }),
  cards: z.array(cardSchema).min(1, { error: "must contain at least one card" }),
  customIcons: z.record(iconNameSchema, iconDataSchema, {
    error: (issue) => (issue.code === "invalid_key" ? ICON_NAME_MESSAGE : undefined),
  }),
  scriptSource: z.string(),
}) satisfies z.ZodType<HexStack>;


// ---------------------------------------------------------------------------------------------
// Gate errors (spec 07 Requirement 6.4, design §stackValidator.ts)
// ---------------------------------------------------------------------------------------------

/** A piece of a gate error's message: fixed text, or a text taken from the read value. */
export type GateMessagePiece = string | { readonly fromValue: string };

/** One gate error (spec 07 Requirement 6.4). */
export interface GateError {
  /** The path as formatPath receives it: numbers are indexes, strings are field names or record keys of the read value. */
  readonly path: readonly PropertyKey[];
  /** The message after "<path>: "; its pieces joined give the message. */
  readonly message: readonly GateMessagePiece[];
}

export interface StackValidationReport {
  /** In check order; empty when the stack is valid. */
  errors: GateError[];
  /** The parsed stack when the schema reported no issue (also with a __proto__ or structural error), else null. */
  stack: HexStack | null;
}

const keepText = (text: string): string => text;

function formatPath(path: readonly PropertyKey[], quote: (text: string) => string = keepText): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else {
      const text = typeof key === "string" ? quote(key) : String(key);
      out += out === "" ? text : `.${text}`;
    }
  }
  return out === "" ? "stack" : out;
}

/**
 * "<path>: <message>" as formatPath and the joined pieces give it, with `quote` applied to every
 * string path key and every fromValue piece. Without `quote` it is the text validateStack returns.
 */
export function formatGateError(error: GateError, quote: (text: string) => string = keepText): string {
  let message = "";
  for (const piece of error.message) message += typeof piece === "string" ? piece : quote(piece.fromValue);
  return `${formatPath(error.path, quote)}: ${message}`;
}

const gateError = (path: readonly PropertyKey[], ...message: GateMessagePiece[]): GateError => ({ path, message });

/**
 * Message pieces of a Zod issue. Only `unrecognized_keys` messages quote text of the read value
 * (its keys, written `"<key>"`); they are split at each key. If a key is not found in the message
 * (another message format), the whole message is one `fromValue` piece so that no key escapes
 * shortening. Every other message of this schema is built from the schema alone (one fixed piece).
 */
function issueMessage(issue: z.core.$ZodIssue): GateMessagePiece[] {
  if (issue.code !== "unrecognized_keys") return [issue.message];
  const pieces: GateMessagePiece[] = [];
  let rest = issue.message;
  for (const key of issue.keys) {
    const at = rest.indexOf(`"${key}"`);
    if (at < 0) return [{ fromValue: issue.message }];
    pieces.push(`${rest.slice(0, at)}"`, { fromValue: key });
    rest = rest.slice(at + key.length + 1);
  }
  pieces.push(rest);
  return pieces;
}

function collectLayerScopeErrors(
  parts: readonly HexPart[],
  expected: HexPart["layerScope"],
  ownerPath: readonly PropertyKey[],
  errors: GateError[],
): void {
  for (let i = 0; i < parts.length; i++) {
    const scope = parts[i].layerScope;
    if (scope !== expected) {
      errors.push(gateError([...ownerPath, "parts", i, "layerScope"], `expected "${expected}" but got "`, { fromValue: scope }, `"`));
    }
  }
}

/**
 * Requirement 6.5: ids are unique across the stack, its backgrounds, cards and parts combined.
 * Walks in document order (stack, backgrounds with their parts, cards with their parts) and
 * reports every occurrence of an id after its first.
 */
function collectDuplicateIds(stack: HexStack, errors: GateError[]): void {
  const seen = new Set<string>();
  const visit = (id: string, path: readonly PropertyKey[]): void => {
    if (seen.has(id)) errors.push(gateError([...path, "id"], `duplicate id "`, { fromValue: id }, `"`));
    seen.add(id);
  };

  const layers: Array<[key: "backgrounds" | "cards", owners: ReadonlyArray<{ id: string; parts: readonly HexPart[] }>]> = [
    ["backgrounds", stack.backgrounds],
    ["cards", stack.cards],
  ];

  visit(stack.id, []);
  for (const [key, owners] of layers) {
    for (let i = 0; i < owners.length; i++) {
      visit(owners[i].id, [key, i]);
      const parts = owners[i].parts;
      for (let j = 0; j < parts.length; j++) visit(parts[j].id, [key, i, "parts", j]);
    }
  }
}

/** Spec 06 Requirement 8.3: every button `iconId` names a key of the stack's `customIcons`. */
function collectIconReferenceErrors(stack: HexStack, errors: GateError[]): void {
  const layers: Array<[key: "backgrounds" | "cards", owners: ReadonlyArray<{ parts: readonly HexPart[] }>]> = [
    ["backgrounds", stack.backgrounds],
    ["cards", stack.cards],
  ];
  for (const [key, owners] of layers) {
    for (let i = 0; i < owners.length; i++) {
      const parts = owners[i].parts;
      for (let j = 0; j < parts.length; j++) {
        const part = parts[j];
        if (part.type !== "button" || part.iconId === undefined) continue;
        if (!Object.hasOwn(stack.customIcons, part.iconId)) {
          errors.push(gateError([key, i, "parts", j, "iconId"], `no icon named "`, { fromValue: part.iconId }, `" in customIcons`));
        }
      }
    }
  }
}

/**
 * Spec 07 Requirement 6.4: every validation error of an untrusted value, in check order:
 * 1. an unsupported or missing `schemaVersion` of an object: that error alone;
 * 2. a `__proto__` key in `customIcons`;
 * 3. every issue of the schema, in Zod's order;
 * 4. when the schema reported none: layer scopes and background references (backgrounds, then
 *    cards), repeated ids, then missing icons.
 * Never mutates `input`.
 */
export function listStackValidationErrors(input: unknown): StackValidationReport {
  const errors: GateError[] = [];
  // Version first, so an old or foreign stack reports the real cause instead of a field error.
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    const version: unknown = (input as Record<string, unknown>).schemaVersion;
    if (version !== SUPPORTED_SCHEMA_VERSION) {
      const shown: GateMessagePiece[] = typeof version === "string"
        ? [`unsupported schema version "`, { fromValue: version }, `", expected "${SUPPORTED_SCHEMA_VERSION}"`]
        : ["unsupported schema version ", { fromValue: String(version) }, `, expected "${SUPPORTED_SCHEMA_VERSION}"`];
      return { errors: [gateError(["schemaVersion"], ...shown)], stack: null };
    }
    // Zod drops a "__proto__" record key silently (JSON.parse makes it an own key), so the
    // stack would load without it instead of being rejected whole (spec 06 Requirement 8.3).
    const icons: unknown = (input as Record<string, unknown>).customIcons;
    if (typeof icons === "object" && icons !== null && Object.hasOwn(icons, "__proto__")) {
      errors.push(gateError(["customIcons", "__proto__"], ICON_NAME_MESSAGE));
    }
  }

  const parsed = stackSchema.safeParse(input);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) errors.push({ path: issue.path, message: issueMessage(issue) });
    return { errors, stack: null };
  }
  const stack: HexStack = parsed.data;

  const backgroundIds = new Set<string>();
  for (let i = 0; i < stack.backgrounds.length; i++) {
    const background = stack.backgrounds[i];
    backgroundIds.add(background.id);
    collectLayerScopeErrors(background.parts, "background", ["backgrounds", i], errors);
  }

  for (let i = 0; i < stack.cards.length; i++) {
    const card = stack.cards[i];
    if (!backgroundIds.has(card.backgroundId)) {
      errors.push(gateError(["cards", i, "backgroundId"], `references missing background "`, { fromValue: card.backgroundId }, `"`));
    }
    collectLayerScopeErrors(card.parts, "card", ["cards", i], errors);
  }

  collectDuplicateIds(stack, errors);
  collectIconReferenceErrors(stack, errors);

  return { errors, stack };
}

/**
 * Validates an untrusted value as a persisted HexStack.
 * On success returns a freshly parsed stack that shares no objects with the input.
 * On failure returns the first validation error as `"<path>: <message>"`; the input is never mutated.
 */
export function validateStack(input: unknown): ValidateStackResult {
  const { errors, stack } = listStackValidationErrors(input);
  if (errors.length > 0) return { ok: false, error: formatGateError(errors[0]) };
  if (stack === null) throw new Error("listStackValidationErrors returned neither an error nor a stack");
  return { ok: true, stack };
}
