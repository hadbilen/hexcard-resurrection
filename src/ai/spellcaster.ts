/**
 * HexAI Spellcaster: natural language -> HexScriptAST (spec 04 Requirements 4.1, 4.2, 4.3, 4.6;
 * design.md §4; hexcard_design_spec.md §4.3 "NL <-> HexTalk <-> HexAST" and §4.4).
 *
 * - Zero-config: with no proxy URL and no session key (the only mode so far, task 5.1), prompts
 *   are compiled by the local Tier 1 compiler and the Grimoire. Tier 1 is pure, synchronous code:
 *   no network, no `eval`, no `new Function`.
 * - Every tier's output goes through `acceptAst`: AST schema validation (Zod), `printHexTalk`,
 *   `parseHexTalk`, deep-equal check against the validated AST. Only an accepted result reaches
 *   the preview; `scriptSource` changes only when the user clicks Apply (ObjectInspector.tsx).
 * - Tier 1 never guesses. It is a deterministic intent-and-slot parser in which every word of the
 *   prompt must be explained by a rule (or be a filler word such as "the" or "please"). If any word
 *   is left over, or a slot is ambiguous, the result is "not understood" with the closest
 *   Grimoire spells as suggestions.
 *
 * Tier 1 pipeline: tokenize (quoted strings, URLs, numbers, words; light typo correction) ->
 * remove the trigger phrase ("when clicked", "when the card opens", ...) which picks the handler ->
 * split into sentences and clauses ("," "and" "then" ...) -> parse each clause as a sequence of
 * phrases (go, visual effect, play, answer, ask, put, add, set property, wait, fetch, ...) ->
 * assemble `if` / `otherwise` branches, `N times` loops and effect placement -> acceptAst.
 */
import type {
  HexBinaryOp,
  HexCardTarget,
  HexContainerTarget,
  HexExprNode,
  HexObjectTarget,
  HexPropertyName,
  HexScriptAST,
  HexStatementNode,
  HexVoice,
} from "../core/ast.ts";
import { HEX_RESERVED_WORDS, validateAst } from "../core/astValidator.ts";
import { parseHexTalk, printHexTalk } from "../core/parser.ts";
import type { VisualEffectSpeed, VisualEffectType } from "../core/schema.ts";
import { parseNoteSequence } from "../engine/audio/synth.ts";
import {
  GRIMOIRE,
  MELODIES,
  answer,
  ask,
  binary,
  builtIn,
  effect as effectStatement,
  emptyText,
  fetchJson,
  fieldTarget,
  flash,
  getValue,
  goTo,
  ifThen,
  itVar,
  lit,
  math,
  me,
  not,
  play,
  put,
  random,
  readField,
  readProperty,
  repeat,
  repeatTimes,
  script,
  setProperty,
  shakeMe,
  variable,
  varTarget,
  wait,
  type FieldTarget,
  type GrimoireEntry,
} from "./grimoire.ts";

export type { GrimoireEntry } from "./grimoire.ts";

/** The kind of object whose script the spell is for; picks the default handler and `me`. */
export type SpellObjectKind = "button" | "field" | "card" | "background" | "stack";

export interface SpellContext {
  objectKind: SpellObjectKind;
}

export type SpellResult =
  | { ok: true; ast: HexScriptAST; hexTalk: string }
  | { ok: false; reason: string; suggestions: GrimoireEntry[] };

/** Prompts longer than this are refused (Tier 1 is meant for one behaviour at a time). */
export const MAX_PROMPT_LENGTH = 600;
/** How many Grimoire spells a "not understood" result suggests. */
export const SUGGESTION_COUNT = 3;

// ---------------------------------------------------------------------------------------------
// Acceptance pipeline (hexcard_design_spec.md §4.4), shared by every tier
// ---------------------------------------------------------------------------------------------

export type AcceptResult = { ok: true; ast: HexScriptAST; hexTalk: string } | { ok: false; reason: string };

/**
 * Deep equality of two AST values, ignoring `loc` keys and keys whose value is `undefined`
 * (an absent optional field and an explicit `undefined` mean the same thing).
 */
export function astEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => astEqual(item, b[index]));
  }
  const keys = (value: object): string[] =>
    Object.keys(value).filter((key) => key !== "loc" && (value as Record<string, unknown>)[key] !== undefined).sort();
  const aKeys = keys(a);
  const bKeys = keys(b);
  if (aKeys.length !== bKeys.length || aKeys.some((key, index) => key !== bKeys[index])) return false;
  return aKeys.every((key) => astEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

/**
 * AI output (AST JSON) -> AST schema validation -> printHexTalk -> parseHexTalk -> deep-equal
 * check against the validated AST. On success returns the validated AST and its printed HexTalk
 * for the preview; on failure the reason to show in the Spellcaster tab. Never throws.
 */
export function acceptAst(output: unknown): AcceptResult {
  const validated = validateAst(output);
  if (!validated.ok) return { ok: false, reason: `The spell did not pass the AST check (${validated.reason}).` };
  const hexTalk = printHexTalk(validated.ast);
  const reparsed = parseHexTalk(hexTalk);
  if (reparsed.errors.length > 0) {
    const error = reparsed.errors[0];
    return { ok: false, reason: `The printed HexTalk does not compile (line ${error.line}: ${error.message}).` };
  }
  if (!astEqual(reparsed.ast, validated.ast)) {
    return { ok: false, reason: "The printed HexTalk does not compile back to the same script." };
  }
  return { ok: true, ast: validated.ast, hexTalk };
}

// ---------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------

/**
 * Turns a natural-language prompt into a previewable script. Zero-config: Tier 1 (Grimoire and
 * local compiler), no network call. The result is always the output of `acceptAst`.
 */
export async function conjureScript(prompt: string, context: SpellContext): Promise<SpellResult> {
  return conjureLocally(prompt, context);
}

/** Tier 1, synchronously: an exact Grimoire spell, else the local compiler. */
export function conjureLocally(prompt: string, context: SpellContext): SpellResult {
  const notUnderstood = (reason: string): SpellResult => ({ ok: false, reason, suggestions: suggestGrimoire(prompt) });
  if (prompt.trim() === "") return notUnderstood("Type what the script should do, or pick a spell from the Grimoire.");
  if (prompt.length > MAX_PROMPT_LENGTH) {
    return notUnderstood(`That spell is too long (over ${MAX_PROMPT_LENGTH} characters). Describe one behaviour at a time.`);
  }
  const entry = findGrimoireEntry(prompt);
  const compiled = entry ? { ok: true as const, ast: entry.ast } : compileTier1(prompt, context);
  if (!compiled.ok) return notUnderstood(compiled.reason);
  const accepted = acceptAst(compiled.ast);
  return accepted.ok ? accepted : notUnderstood(accepted.reason);
}

const normalizePrompt = (text: string): string =>
  text.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/[\s.!?]+$/, "").replace(/\s+/g, " ").trim();

/** The Grimoire entry whose prompt equals `prompt` (case, spacing and final punctuation ignored). */
export function findGrimoireEntry(prompt: string): GrimoireEntry | undefined {
  const wanted = normalizePrompt(prompt);
  return GRIMOIRE.find((entry) => normalizePrompt(entry.prompt) === wanted);
}

// ---------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------

/** Every word some rule looks for. Words outside it (and outside STOPWORDS) can be names. */
const VOCAB = new Set<string>();

function words(list: string): ReadonlySet<string> {
  const set = new Set(list.trim().split(/\s+/));
  for (const word of set) VOCAB.add(word);
  return set;
}

/** Filler words: skipped between phrases, never names. */
const STOPWORDS: ReadonlySet<string> = new Set(
  ("the a an please pls kindly just now also then and so to with using via immediately instantly simply " +
    "i want would like you can could should will we lets let us some nice little cool really " +
    "go ahead must need needs try okay finally afterwards afterward").split(" ").filter((word) => word !== "go"),
);

/** Words never "corrected" into a keyword, although they are one typo away from one. */
const PROTECTED = new Set(
  ("made make same game home came mode more move save gave have nice near line lime fine wine bell tell score scores " +
    "lives life level levels coins coin health money gold points total counter car cat hat bat far fan pet").split(" "),
);

const NUMBER_WORDS: ReadonlyMap<string, number> = (() => {
  const units = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const map = new Map<string, number>();
  units.forEach((word, value) => map.set(word, value));
  tens.forEach((word, ten) => {
    if (!word) return;
    map.set(word, ten * 10);
    for (let unit = 1; unit < 10; unit++) map.set(word + units[unit], ten * 10 + unit);
  });
  map.set("hundred", 100);
  map.set("thousand", 1000);
  for (const word of map.keys()) VOCAB.add(word);
  return map;
})();

// Words the rules below compare with directly (the word sets register themselves through `words`).
words(
  "current todays today date time clock number of cards count random name variable var between up welcome text out " +
  "back away die dice d6 roll throw pick choose generate get add give subtract deduct remove take multiply divide " +
  "double triple halve set change reset fill append prepend major c tempo bpm wave visibility centre toggle rename " +
  "mark unmark move flash blink flicker shake wiggle jiggle wobble rattle lock unlock make turn true false on off hold " +
  "half for after later following preceding final forward forwards backward backwards home start beginning end any " +
  "page screen per every each times twice thrice once row do repeat open close in out next prev previous first last",
);

const ORDINAL_WORDS: ReadonlyMap<string, number> = new Map(
  "second third fourth fifth sixth seventh eighth ninth tenth".split(" ").map((word, index) => [word, index + 2] as const),
);
for (const word of ORDINAL_WORDS.keys()) VOCAB.add(word);

// ---------------------------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------------------------

type Token =
  | { type: "word"; word: string; raw: string }
  | { type: "number"; value: number; raw: string }
  | { type: "string"; value: string }
  | { type: "url"; value: string }
  | { type: "point"; value: string }
  | { type: "op"; value: string }
  | { type: "sep"; value: string }
  | { type: "other"; value: string };

type Toks = readonly Token[];

const WORD = /^[A-Za-z0-9_#]+(?:[\u2019'\-.][A-Za-z0-9_#]+|\[\d+\])*/;
const NUMBER = /^\d+(?:\.\d+)?(?![A-Za-z0-9_#])/;
const POINT = /^(\d+) ?, ?(\d+)(?![\d.])/;
const URL = /^https?:\/\/[^\s"<>\u201c\u201d]+/i;
const OPERATORS = [">=", "<=", "<>", "!=", "==", "=", ">", "<"];

function normalizeWord(raw: string): string {
  return raw.toLowerCase().replace(/['\u2019]s$/, "").replace(/['\u2019-]/g, "");
}

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const url = URL.exec(rest);
    if (url) {
      const value = url[0].replace(/[.,;:!?)]+$/, "");
      tokens.push({ type: "url", value });
      i += value.length;
      continue;
    }
    if (c === '"' || c === "\u201c" || c === "\u201d") {
      const close = rest.slice(1).search(/["\u201c\u201d\n]/);
      if (close >= 0 && rest[close + 1] !== "\n") {
        tokens.push({ type: "string", value: rest.slice(1, close + 1) });
        i += close + 2;
      } else {
        tokens.push({ type: "other", value: c });
        i++;
      }
      continue;
    }
    if ((c === "'" || c === "\u2018") && (i === 0 || /[\s(,:;]/.test(text[i - 1]))) {
      const match = /^['\u2018]([^'\u2019\n]*)['\u2019](?=$|[\s.,;:!?)])/.exec(rest);
      if (match) {
        tokens.push({ type: "string", value: match[1] });
        i += match[0].length;
        continue;
      }
    }
    const point = POINT.exec(rest);
    if (point) {
      tokens.push({ type: "point", value: `${point[1]},${point[2]}` });
      i += point[0].length;
      continue;
    }
    const word = WORD.exec(rest);
    const number = NUMBER.exec(rest);
    if (number && (!word || word[0] === number[0])) {
      tokens.push({ type: "number", value: Number(number[0]), raw: number[0] });
      i += number[0].length;
      continue;
    }
    if (word) {
      tokens.push({ type: "word", word: normalizeWord(word[0]), raw: word[0] });
      i += word[0].length;
      continue;
    }
    const op = OPERATORS.find((candidate) => rest.startsWith(candidate));
    if (op) {
      tokens.push({ type: "op", value: op === "!=" ? "<>" : op === "==" ? "=" : op });
      i += op.length;
      continue;
    }
    if (",;:.!?".includes(c)) tokens.push({ type: "sep", value: c });
    else if (c === "-" || c === "\u2013" || c === "\u2014") tokens.push({ type: "sep", value: "," });
    else if (c !== "'" && c !== "\u2019" && c !== "(" && c !== ")") tokens.push({ type: "other", value: c });
    i++;
  }
  return tokens;
}

/** Optimal-string-alignment distance (adjacent transpositions count 1), capped at `limit + 1`. */
function editDistance(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) {
    rows.push([i]);
    for (let j = 1; j <= b.length; j++) {
      if (i === 0) {
        rows[0].push(j);
        continue;
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, rows[i - 2][j - 2] + 1);
      rows[i].push(value);
    }
  }
  return rows[a.length][b.length];
}

const isTransposition = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  const diff = [...a].flatMap((char, index) => (char === b[index] ? [] : [index]));
  return diff.length === 2 && diff[1] === diff[0] + 1 && a[diff[0]] === b[diff[1]] && a[diff[1]] === b[diff[0]];
};

/**
 * Light typo correction: an unknown lowercase word (or the first word of a sentence) becomes the
 * one known word it is closest to: one edit for 4 to 7 letters, two edits from 8 letters, a swap
 * of two neighbouring letters or one missing letter for 3 letters. Ties, capitalised names,
 * digits and the PROTECTED words are left alone.
 */
function correctWords(tokens: Token[]): Token[] {
  const known = [...new Set([...VOCAB, ...STOPWORDS])];
  return tokens.map((token, index) => {
    if (token.type !== "word") return token;
    const { word, raw } = token;
    if (VOCAB.has(word) || STOPWORDS.has(word) || PROTECTED.has(word) || /\d|_|#|\./.test(word)) return token;
    const initial = index === 0 || tokens[index - 1].type === "sep";
    if (/^[A-Z]/.test(raw) && !initial) return token;
    if (word.length < 3) return token;
    const limit = word.length >= 8 ? 2 : 1;
    let best: string | undefined;
    let bestDistance = limit + 1;
    let tie = false;
    for (const candidate of known) {
      // 3 letters: only a swap ("teh") or one missing letter ("nxt").
      if (word.length === 3 && !isTransposition(word, candidate) && candidate.length !== 4) continue;
      const distance = editDistance(word, candidate, limit);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
        tie = false;
      } else if (distance === bestDistance && distance <= limit) {
        tie = true;
      }
    }
    return best !== undefined && !tie && bestDistance <= limit ? { ...token, word: best } : token;
  });
}

/** Joins two-word forms the rules treat as one word ("double click", "8 bit", "check box"...). */
function mergeCompounds(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const a = tokens[i];
    const b = tokens[i + 1];
    const aw = a.type === "word" ? a.word : a.type === "number" ? a.raw : undefined;
    const bw = b?.type === "word" ? b.word : undefined;
    const joined = aw !== undefined && bw !== undefined ? COMPOUNDS.get(`${aw} ${bw}`) : undefined;
    if (joined !== undefined) {
      out.push({ type: "word", word: joined, raw: joined });
      i++;
    } else {
      out.push(a);
    }
  }
  return out;
}

const COMPOUNDS: ReadonlyMap<string, string> = new Map(
  [
    ["double click", "doubleclick"], ["double clicks", "doubleclicks"], ["double clicked", "doubleclicked"],
    ["double clicking", "doubleclicking"], ["mouse up", "mouseup"], ["mouse down", "mousedown"],
    ["mouse enter", "mouseenter"], ["mouse leave", "mouseleave"], ["8 bit", "8bit"], ["check box", "checkbox"],
    ["radio button", "radiobutton"], ["pop up", "popup"], ["barn door", "barndoor"], ["checker board", "checkerboard"],
    ["text box", "field"], ["text field", "field"], ["square wave", "square8bit"], ["dice roll", "dieroll"],
    ["die roll", "dieroll"], ["take away", "subtract"], ["grey out", "disable"], ["gray out", "disable"],
    ["turn on", "turnon"], ["turn off", "turnoff"], ["today date", "todaysdate"], ["todays date", "todaysdate"],
  ].map(([from, to]) => {
    VOCAB.add(to);
    for (const part of from.split(" ")) if (!/^\d+$/.test(part)) VOCAB.add(part);
    return [from, to] as const;
  }),
);

// ---------------------------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------------------------

const wordAt = (t: Toks, i: number): string | undefined => {
  const token = t[i];
  return token?.type === "word" ? token.word : undefined;
};
const isAt = (t: Toks, i: number, set: ReadonlySet<string>): boolean => {
  const word = wordAt(t, i);
  return word !== undefined && set.has(word);
};
const skip = (t: Toks, i: number, set: ReadonlySet<string>): number => {
  while (isAt(t, i, set)) i++;
  return i;
};
const rawAt = (t: Toks, i: number): string => {
  const token = t[i];
  if (!token) return "";
  return token.type === "word" || token.type === "number" ? token.raw : token.type === "string" ? `'${token.value}'` : token.value;
};

const IDENTIFIER_RAW = /^[A-Za-z][A-Za-z0-9_]*$/;

/** A word that can be a field or card name on its own: not a keyword, not a filler word. */
function isNameWord(t: Toks, i: number): boolean {
  const token = t[i];
  return token?.type === "word" && IDENTIFIER_RAW.test(token.raw) && !VOCAB.has(token.word) && !STOPWORDS.has(token.word);
}

/** After an explicit `field` / `button` / `card` word: any identifier that is not structural. */
const STRUCTURAL = words("to into in on of with and then from by for at is are as named called number id this that it me or onto inside");
function isSelectorWord(t: Toks, i: number): boolean {
  const token = t[i];
  if (token?.type !== "word" || !IDENTIFIER_RAW.test(token.raw)) return false;
  if (STRUCTURAL.has(token.word) || STOPWORDS.has(token.word)) return false;
  return isNameWord(t, i) || /^[A-Z]/.test(token.raw);
}

function readNumber(t: Toks, i: number): { value: number; end: number } | null {
  const token = t[i];
  if (token?.type === "number") return { value: token.value, end: i + 1 };
  const word = wordAt(t, i);
  if (word === undefined) return null;
  if ((word === "a" || word === "one") && wordAt(t, i + 1) === "hundred") return { value: 100, end: i + 2 };
  const value = NUMBER_WORDS.get(word);
  if (value === undefined) return null;
  if (value < 10 && wordAt(t, i + 1) === "hundred") return { value: value * 100, end: i + 2 };
  return { value, end: i + 1 };
}

function readOrdinal(t: Toks, i: number): { value: number; end: number } | null {
  const word = wordAt(t, i);
  if (word === undefined) return null;
  const ordinal = ORDINAL_WORDS.get(word);
  if (ordinal !== undefined) return { value: ordinal, end: i + 1 };
  const digits = /^(\d+)(st|nd|rd|th)$/.exec(word);
  return digits ? { value: Number(digits[1]), end: i + 1 } : null;
}

/** A string literal HexTalk can print (§4.2: no double quote, no newline). */
const printable = (value: string): boolean => !/["\r\n]/.test(value);

// ---------------------------------------------------------------------------------------------
// Triggers: which handler the script goes into
// ---------------------------------------------------------------------------------------------

/** One slot of a trigger pattern: alternatives, optional (`?`) or repeated up to 3 times (`*`). */
interface Slot {
  words: ReadonlySet<string>;
  min: number;
  max: number;
}

function pattern(source: string): Slot[] {
  return source.trim().split(/\s+/).map((part) => {
    const suffix = part.at(-1);
    const body = suffix === "?" || suffix === "*" ? part.slice(0, -1) : part;
    return { words: words(body.replace(/\|/g, " ")), min: suffix === "?" || suffix === "*" ? 0 : 1, max: suffix === "*" ? 3 : 1 };
  });
}

function matchSlots(t: Toks, i: number, slots: readonly Slot[], s = 0): number {
  if (s === slots.length) return i;
  const slot = slots[s];
  let count = 0;
  let j = i;
  while (count < slot.max && isAt(t, j, slot.words)) {
    count++;
    j++;
  }
  // Greedy, backing off one word at a time.
  for (; count >= slot.min; count--, j--) {
    const end = matchSlots(t, j, slots, s + 1);
    if (end >= 0) return end;
  }
  return -1;
}

const SUBJECT = "the? user|player|someone|somebody|anyone|i|you|they|we|people|visitor?";
const CLICK_TAIL = "on|at? it|this|that|me|here|the|button|field|checkbox|radiobutton|card*";
const PART_SUBJECT = "it|this|that|i|im|the|button|field|checkbox|radiobutton|me*";
const CARD_NOUN = "the|this? card|page";

const TRIGGERS: readonly { eventName: string; slots: Slot[] }[] = ([
  ["mouseDoubleClick", `on|when|whenever|after|upon|if? ${SUBJECT} doubleclick|doubleclicks|doubleclicked|doubleclicking ${CLICK_TAIL}`],
  ["mouseDoubleClick", `when|whenever|once|after|if ${PART_SUBJECT} is|gets|get|was|are doubleclicked`],
  ["mouseDown", "on|when|whenever|upon mousedown"],
  ["mouseDown", "when|whenever the? mouse|button goes|is|gets down"],
  ["mouseEnter", "on|when|whenever|if? the? mouse|pointer|cursor enters|moves|goes|hovers|rolls|is over|onto|into? it|this|me|the|button|field*"],
  ["mouseEnter", "on|when|whenever|while hover|hovering|hovered|mouseenter|mouseover|rollover over? it|this|me|the|button|field*"],
  ["mouseEnter", "when|whenever|if the? user|i|you|someone hovers|hover|mouses over? it|this|me|the|button|field*"],
  ["mouseLeave", "on|when|whenever|if? the? mouse|pointer|cursor leaves|exits it|this|me|the|button|field*"],
  ["mouseLeave", "on|when|whenever mouseleave"],
  ["mouseUp", `on|upon|after|by click|clicking|press|pressing|tap|tapping|release|releasing|mouseup ${CLICK_TAIL}`],
  ["mouseUp", `when|whenever|once|after ${SUBJECT} click|clicks|clicked|press|presses|pressed|tap|taps|tapped|push|pushes|pushed|hit|hits|release|releases ${CLICK_TAIL}`],
  ["mouseUp", `when|whenever|once|after|if ${PART_SUBJECT} is|gets|get|was|am|are? clicked|pressed|tapped|pushed|hit|released`],
  ["mouseUp", "when|whenever mouseup"],
  ["openCard", `when|whenever|once|each|every? time? ${CARD_NOUN} opens|appears|loads|starts|shows`],
  ["openCard", `when|whenever|once ${CARD_NOUN} is|gets opened|shown|displayed|entered|visited|loaded`],
  ["openCard", "on|upon|at|after open card|page"],
  ["openCard", "on|upon|at|after opencard"],
  ["openCard", `when|on|upon|after|while entering|arriving|arrival|visiting|opening at|on|in? ${CARD_NOUN}?`],
  ["openCard", `when|whenever|once ${SUBJECT} arrive|arrives|enter|enters|visit|visits|reach|reaches|open|opens|come|comes|get|gets at|on|to|in? ${CARD_NOUN}`],
  ["closeCard", `when|whenever|once|before ${CARD_NOUN} closes|closed`],
  ["closeCard", `when|whenever|once|before ${CARD_NOUN} is|gets closed|left`],
  ["closeCard", "on|upon|at close card|page"],
  ["closeCard", "on|upon|at closecard"],
  ["closeCard", `when|on|upon|before|after leaving|exiting|closing ${CARD_NOUN}?`],
  ["closeCard", `when|whenever|before|once ${SUBJECT} leave|leaves|exit|exits ${CARD_NOUN}`],
  ["openStack", "when|whenever|once the|this? stack opens|starts|loads|launches"],
  ["openStack", "when|whenever|once the|this? stack is|gets opened|started|loaded|launched"],
  ["openStack", "on|upon|at open stack"],
  ["openStack", "on|upon|at openstack|startup|launch"],
  ["idle", "on|when|while|during? every|each? idle|idling|idles"],
  ["idle", "constantly|continuously"],
  ["idle", "all the time"],
] as const).map(([eventName, source]) => ({ eventName, slots: pattern(source) }));

/** Removes every trigger phrase; fails when two different handlers are asked for. */
function extractTrigger(tokens: Token[]): { tokens: Token[]; eventName?: string } | { error: string } {
  let eventName: string | undefined;
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    let end = -1;
    let found: string | undefined;
    for (const trigger of TRIGGERS) {
      end = matchSlots(tokens, i, trigger.slots);
      if (end > i) {
        found = trigger.eventName;
        break;
      }
    }
    if (found === undefined) {
      out.push(tokens[i]);
      i++;
      continue;
    }
    if (eventName !== undefined && eventName !== found) {
      return { error: `That spell asks for two different events (${eventName} and ${found}). Conjure one handler at a time.` };
    }
    eventName = found;
    i = end;
  }
  return { tokens: out, eventName };
}

const DEFAULT_HANDLER: Readonly<Record<SpellObjectKind, string>> = {
  button: "mouseUp",
  field: "mouseUp",
  card: "openCard",
  background: "openCard",
  stack: "openStack",
};

// ---------------------------------------------------------------------------------------------
// Sentences and clauses
// ---------------------------------------------------------------------------------------------

const SENTENCE_END = new Set([".", "!", "?", ";"]);
const CLAUSE_WORDS = words("and then also afterwards afterward finally plus");

function splitSentences(tokens: Toks): Token[][][] {
  const sentences: Token[][][] = [];
  let clauses: Token[][] = [];
  let clause: Token[] = [];
  const endClause = (): void => {
    if (clause.length > 0) clauses.push(clause);
    clause = [];
  };
  const endSentence = (): void => {
    endClause();
    if (clauses.length > 0) sentences.push(clauses);
    clauses = [];
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.type === "sep") {
      if (SENTENCE_END.has(token.value)) endSentence();
      else endClause();
      continue;
    }
    if (token.type === "word" && CLAUSE_WORDS.has(token.word)) {
      const prev = tokens[i - 1];
      const next = tokens[i + 1];
      // "between 1 and 6", "'Yes' and 'No'": not a clause boundary.
      const literal = (x: Token | undefined): boolean => x?.type === "number" || x?.type === "string";
      if (token.word === "and" && literal(prev) && literal(next)) {
        clause.push(token);
        continue;
      }
      endClause();
      continue;
    }
    // "if X go next otherwise go back": "otherwise" / "else" starts its own clause.
    if (token.type === "word" && (token.word === "otherwise" || token.word === "else") && clause.length > 0
      && !(token.word === "else" && wordAt(tokens, i - 1) === "or")) {
      endClause();
      clause.push(token);
      continue;
    }
    if (token.type === "word" && token.word === "after" && wordAt(tokens, i + 1) === "that") {
      endClause();
      i++;
      continue;
    }
    // "First, ask ..." (but not "first card").
    if (token.type === "word" && token.word === "first" && clause.length === 0 && !isAt(tokens, i + 1, CARD_WORDS)) {
      continue;
    }
    clause.push(token);
  }
  endSentence();
  return sentences;
}

// ---------------------------------------------------------------------------------------------
// Compile state and values
// ---------------------------------------------------------------------------------------------

interface Ctx {
  kind: SpellObjectKind;
  /** Whether a statement so far wrote `it` (ask, answer, get, fetch). */
  itWritten: boolean;
}

interface Parsed<T> {
  value: T;
  end: number;
}

const ARTICLES = words("the a an");
const LAYER_CARD = words("card cd");
const LAYER_BG = words("background bg bkgnd");
const FIELD_WORDS = words("field fld fields");
const BUTTON_WORDS = words("button btn checkbox radiobutton");
const CARD_WORDS = words("card page screen one");
const IT_WORDS = words("it answer result reply response input choice that value text");
const IT_NOUN_WORDS = words("name answer result reply response input choice value text");

/** Field (or `variable x`) container. `allowBare`: a lone name word means a background field. */
function readContainer(t: Toks, i: number, allowBare: boolean): Parsed<HexContainerTarget> | null {
  let j = skip(t, i, ARTICLES);
  if (wordAt(t, j) === "variable" || wordAt(t, j) === "var") {
    const token = t[j + 1];
    if (token?.type === "word" && /^[a-z][a-z0-9_]*$/.test(token.raw.toLowerCase()) && !HEX_RESERVED_WORDS.has(token.raw.toLowerCase())) {
      return { value: varTarget(token.raw.toLowerCase()), end: j + 2 };
    }
    return null;
  }
  let layer: "card" | "background" | undefined;
  if (isAt(t, j, LAYER_CARD) && isAt(t, j + 1, FIELD_WORDS)) {
    layer = "card";
    j++;
  } else if (isAt(t, j, LAYER_BG) && isAt(t, j + 1, FIELD_WORDS)) {
    layer = "background";
    j++;
  }
  if (isAt(t, j, FIELD_WORDS)) {
    const selector = readSelector(t, j + 1);
    if (!selector) return null;
    return { value: fieldTargetOf(selector.value, layer ?? "background"), end: selector.end };
  }
  // "the 'Score' field", "the Score field"
  const token = t[j];
  if (token?.type === "string" && isAt(t, j + 1, FIELD_WORDS) && printable(token.value)) {
    return { value: fieldTarget(token.value), end: j + 2 };
  }
  if (isNameWord(t, j) && isAt(t, j + 1, FIELD_WORDS)) return { value: fieldTarget((t[j] as { raw: string }).raw), end: j + 2 };
  if (!allowBare) return null;
  if (token?.type === "string" && printable(token.value) && token.value !== "") return { value: fieldTarget(token.value), end: j + 1 };
  if (isNameWord(t, j)) return { value: fieldTarget((t[j] as { raw: string }).raw), end: j + 1 };
  return null;
}

function fieldTargetOf(name: string | number, layer: "card" | "background"): FieldTarget {
  return fieldTarget(name, layer);
}

/** Part or card selector after its noun: a string, a number, `named X`, `number N` or a name word. */
function readSelector(t: Toks, i: number): Parsed<string | number> | null {
  let j = i;
  if (isAt(t, j, words("named called number"))) j++;
  const token = t[j];
  if (token?.type === "string") return printable(token.value) && token.value !== "" ? { value: token.value, end: j + 1 } : null;
  if (token?.type === "number" && Number.isInteger(token.value)) return { value: token.value, end: j + 1 };
  if (isSelectorWord(t, j) && !NUMBER_WORDS.has(wordAt(t, j) as string)) return { value: (token as { raw: string }).raw, end: j + 1 };
  return null;
}

/** A random-number phrase after `random`: `between A and B`, `from A to B`, `up to N`, `1 to N`. */
function readRandomRange(t: Toks, i: number): Parsed<HexExprNode> | null {
  let j = i;
  if (wordAt(t, j) === "number") j++;
  let low: number | undefined;
  let high: number | undefined;
  let end = j;
  if (isAt(t, j, words("between from"))) {
    const a = readNumber(t, j + 1);
    if (a && isAt(t, a.end, words("and to"))) {
      const b = readNumber(t, a.end + 1);
      if (b) {
        low = a.value;
        high = b.value;
        end = b.end;
      }
    }
  } else if (wordAt(t, j) === "up" && wordAt(t, j + 1) === "to") {
    const b = readNumber(t, j + 2);
    if (b) {
      low = 1;
      high = b.value;
      end = b.end;
    }
  } else {
    const a = readNumber(t, j);
    if (a && wordAt(t, a.end) === "to") {
      const b = readNumber(t, a.end + 1);
      if (b) {
        low = a.value;
        high = b.value;
        end = b.end;
      }
    }
  }
  if (low === undefined || high === undefined || !Number.isInteger(low) || !Number.isInteger(high) || low < 0 || high <= low) return null;
  const roll = random(lit(high - low + 1));
  return { value: low === 1 ? roll : binary("+", lit(low - 1), roll), end };
}

/**
 * A value: a string, number, `empty`, `it` (after ask / answer / get / fetch), the date or time,
 * the number of cards, a random number, a field (bare names only with `allowBare`) or
 * `the name of <object>`.
 */
function readValue(t: Toks, i: number, ctx: Ctx, allowBare: boolean): Parsed<HexExprNode> | null {
  const token = t[i];
  if (token?.type === "string") return printable(token.value) ? { value: lit(token.value), end: i + 1 } : null;
  if (token?.type === "url") return printable(token.value) ? { value: lit(token.value), end: i + 1 } : null;
  if (token?.type === "point") return { value: lit(token.value), end: i + 1 };
  const number = readNumber(t, i);
  if (number) return { value: lit(number.value), end: number.end };
  const hadArticle = isAt(t, i, ARTICLES);
  let j = skip(t, i, ARTICLES);
  const word = wordAt(t, j);
  if (word === undefined) return null;
  if (!hadArticle && (word === "empty" || word === "nothing" || word === "blank")) return { value: emptyText(), end: j + 1 };
  if (word === "current" || word === "todays") j++;
  const next = wordAt(t, j);
  if (next === "date" || next === "todaysdate" || (next === "today" && word !== "the")) return { value: builtIn("date"), end: j + 1 };
  if (next === "time" || next === "clock") return { value: builtIn("time"), end: j + 1 };
  if (next === "number" && wordAt(t, j + 1) === "of" && wordAt(t, j + 2) === "cards") return { value: builtIn("numberOfCards"), end: j + 3 };
  if (next === "card" && (wordAt(t, j + 1) === "count")) return { value: builtIn("numberOfCards"), end: j + 2 };
  if (next === "card" && wordAt(t, j + 1) === "number") return { value: builtIn("cardNumber"), end: j + 2 };
  if (next === "dieroll") return { value: random(lit(6)), end: j + 1 };
  if (next === "random") {
    const range = readRandomRange(t, j + 1);
    if (range) return range;
    return null;
  }
  if (next === "name" && wordAt(t, j + 1) === "of") {
    const object = readObject(t, j + 2, ctx);
    if (object && propertyAllowed("name", object.value.kind)) return { value: readProperty("name", object.value.target), end: object.end };
    return null;
  }
  if (ctx.itWritten && next !== undefined && IT_WORDS.has(next) && (next !== "it" || !hadArticle)) {
    if (next === "it" || hadArticle || next === "that") return { value: itVar(), end: j + 1 };
  }
  const container = readContainer(t, i, allowBare);
  if (container) {
    const target = container.value;
    return { value: target.scope === "field" ? readField(target) : variable(target.name), end: container.end };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Objects and properties
// ---------------------------------------------------------------------------------------------

type ObjectKind = "button" | "field" | "card" | "background" | "stack";

interface ObjectRef {
  target: HexObjectTarget;
  kind: ObjectKind;
}

const ME_WORDS = words("me myself itself it");

/** `me`, `this button`, `button "Go"`, `the 'Clue' field`, `this card`, ... */
function readObject(t: Toks, i: number, ctx: Ctx): Parsed<ObjectRef> | null {
  const self: ObjectRef = { target: me(), kind: ctx.kind };
  if (isAt(t, i, ME_WORDS)) return { value: self, end: i + 1 };
  const demonstrative = isAt(t, i, words("this the that"));
  let j = demonstrative ? i + 1 : i;
  if (wordAt(t, j) === "current") j++;
  // Layer word + part noun + selector
  let layer: "card" | "background" | undefined;
  if (isAt(t, j, LAYER_CARD) && (isAt(t, j + 1, FIELD_WORDS) || isAt(t, j + 1, BUTTON_WORDS))) {
    layer = "card";
    j++;
  } else if (isAt(t, j, LAYER_BG) && (isAt(t, j + 1, FIELD_WORDS) || isAt(t, j + 1, BUTTON_WORDS))) {
    layer = "background";
    j++;
  }
  const noun = wordAt(t, j);
  const part: "button" | "field" | undefined = isAt(t, j, BUTTON_WORDS) ? "button" : isAt(t, j, FIELD_WORDS) ? "field" : undefined;
  if (part) {
    // "this button" is the object itself; only "the button 'X'" / "button 'X'" take a selector.
    const selector = wordAt(t, i) === "this" || wordAt(t, i) === "that" ? null : readSelector(t, j + 1);
    if (selector) {
      return {
        value: { target: { objectType: part, layer: layer ?? (part === "field" ? "background" : "card"), selector: { by: "auto", value: lit(selector.value) } }, kind: part },
        end: selector.end,
      };
    }
    // "this button", "the checkbox": the object itself.
    if (layer === undefined && ctx.kind === part && (demonstrative || j === i)) return { value: self, end: j + 1 };
    return null;
  }
  if (layer === undefined && (noun === "card" || noun === "page")) {
    if (demonstrative) return { value: { target: { objectType: "card" }, kind: "card" }, end: j + 1 };
    const selector = readSelector(t, j + 1);
    if (selector) return { value: { target: { objectType: "card", selector: { by: "auto", value: lit(selector.value) } }, kind: "card" }, end: selector.end };
    return null;
  }
  if (demonstrative && (noun === "background" || noun === "bg")) return { value: { target: { objectType: "background" }, kind: "background" }, end: j + 1 };
  if (demonstrative && noun === "stack") return { value: { target: { objectType: "stack" }, kind: "stack" }, end: j + 1 };
  // "the 'Secret' button", "the Secret button"
  const token = t[j];
  const named = token?.type === "string" ? (printable(token.value) && token.value !== "" ? token.value : undefined)
    : isNameWord(t, j) ? (token as { raw: string }).raw : undefined;
  if (named !== undefined) {
    const kind = isAt(t, j + 1, BUTTON_WORDS) ? "button" : isAt(t, j + 1, FIELD_WORDS) ? "field" : undefined;
    if (kind) {
      return {
        value: { target: { objectType: kind, layer: kind === "field" ? "background" : "card", selector: { by: "auto", value: lit(named) } }, kind },
        end: j + 2,
      };
    }
  }
  return null;
}

/** §4.3 property validity: which object kinds accept which property. */
function propertyAllowed(property: HexPropertyName, kind: ObjectKind): boolean {
  switch (property) {
    case "name":
      return true;
    case "textAlign": case "textFont": case "textSize": case "textStyle": case "lockText":
      return kind === "field";
    case "hilite": case "title": case "showName": case "autoHilite":
      return kind === "button";
    case "marked":
      return kind === "card";
    case "visible": case "enabled": case "location": case "rect":
      return kind === "button" || kind === "field";
    case "style":
      return kind === "button" || kind === "field";
  }
}

// ---------------------------------------------------------------------------------------------
// Phrase parsers
// ---------------------------------------------------------------------------------------------

interface Phrase {
  end: number;
  statements?: HexStatementNode[];
  repeat?: number;
  speed?: VisualEffectSpeed;
}

type PhraseParser = (t: Toks, i: number, ctx: Ctx) => Phrase | null;

const statements = (end: number, ...list: HexStatementNode[]): Phrase => ({ end, statements: list });

// ----- go ------------------------------------------------------------------------------------

const GO_VERBS = words("go goto navigate jump flip head advance proceed switch move return travel skip turn take bring show open visit");
const GO_FILLER = words("to me us on over onto towards toward into");

function readCardTarget(t: Toks, i: number, afterVerb: boolean): Parsed<HexCardTarget> | null {
  let j = skip(t, i, ARTICLES);
  const word = wordAt(t, j);
  const cardNoun = (k: number): number => (isAt(t, k, CARD_WORDS) ? k + 1 : k);
  const relative = (dir: Extract<HexCardTarget, { type: "relative" }>["dir"], end: number): Parsed<HexCardTarget> =>
    ({ value: { type: "relative", dir }, end });
  const hasNoun = (k: number): boolean => isAt(t, k, CARD_WORDS);
  if (word === "next" || word === "following") return afterVerb || hasNoun(j + 1) ? relative("next", cardNoun(j + 1)) : null;
  if (word === "prev" || word === "previous" || word === "preceding") return afterVerb || hasNoun(j + 1) ? relative("prev", cardNoun(j + 1)) : null;
  if (word === "first") return afterVerb || hasNoun(j + 1) ? relative("first", cardNoun(j + 1)) : null;
  if (word === "last" || word === "final") return afterVerb || hasNoun(j + 1) ? relative("last", cardNoun(j + 1)) : null;
  if (afterVerb) {
    if (word === "back") return relative("back", j + 1);
    if (word === "forward" || word === "forwards") return relative("next", cardNoun(j + 1));
    if (word === "backward" || word === "backwards") return relative("prev", cardNoun(j + 1));
    if (word === "home" || word === "start" || word === "beginning") return relative("first", cardNoun(j + 1));
    if (word === "end") return relative("last", j + 1);
  }
  const ordinal = readOrdinal(t, j);
  if (ordinal && (afterVerb || hasNoun(ordinal.end))) return { value: { type: "auto", value: lit(ordinal.value) }, end: cardNoun(ordinal.end) };
  if ((word === "random" || word === "any") && isAt(t, j + 1, words("card page"))) {
    return { value: { type: "auto", value: random(builtIn("numberOfCards")) }, end: j + 2 };
  }
  if (word === "card" || word === "page") {
    const selector = readSelector(t, j + 1);
    if (selector) return { value: { type: "auto", value: lit(selector.value) }, end: selector.end };
    return null;
  }
  // "the 'Hall' card", "the Hall card"
  const token = t[j];
  if (token?.type === "string" && printable(token.value) && token.value !== "" && isAt(t, j + 1, words("card page"))) {
    return { value: { type: "auto", value: lit(token.value) }, end: j + 2 };
  }
  // A bare name before "card" must be capitalised ("the Hall card"), so a typo is never a card name.
  if (isNameWord(t, j) && /^[A-Z]/.test((token as { raw: string }).raw) && isAt(t, j + 1, words("card page"))) {
    return { value: { type: "auto", value: lit((token as { raw: string }).raw) }, end: j + 2 };
  }
  return null;
}

const parseGo: PhraseParser = (t, i) => {
  if (isAt(t, i, GO_VERBS)) {
    const verb = wordAt(t, i);
    let j = i + 1;
    if ((verb === "take" || verb === "bring") && !isAt(t, j, words("me us"))) return null;
    if (verb === "turn" && !isAt(t, skip(t, j, GO_FILLER), words("next prev previous page"))) return null;
    j = skip(t, j, GO_FILLER);
    // "go back to the first card": the explicit target wins.
    if (wordAt(t, j) === "back" && wordAt(t, j + 1) === "to") {
      const target = readCardTarget(t, j + 2, true);
      if (target) return statements(target.end, goTo(target.value));
    }
    const target = readCardTarget(t, j, true);
    if (target) return statements(target.end, goTo(target.value));
    if (verb === "return" && j === i + 1) return statements(i + 1, goTo({ type: "relative", dir: "back" }));
    return null;
  }
  const target = readCardTarget(t, i, false);
  return target ? statements(target.end, goTo(target.value)) : null;
};

// ----- visual effect -------------------------------------------------------------------------

const DIRECTIONS = words("left right up down");
const EFFECT_NOUNS = words("effect transition animation style");
words("visual dissolve dissolving dissolves fade fading fades wipe wiping wipes iris zoom barndoor venetian blinds checkerboard checkers cut");

function directionEffect(direction: string): VisualEffectType {
  return direction === "left" ? "wipeLeft" : direction === "right" ? "wipeRight" : direction === "up" ? "wipeUp" : "wipeDown";
}

const parseEffect: PhraseParser = (t, i) => {
  let j = i;
  if (wordAt(t, j) === "visual") j++;
  if (isAt(t, j, EFFECT_NOUNS) && j > i) j++;
  j = skip(t, j, ARTICLES);
  const word = wordAt(t, j);
  let effectName: VisualEffectType | undefined;
  if (word === "dissolve" || word === "dissolving" || word === "dissolves" || word === "fade" || word === "fading" || word === "fades") {
    effectName = "dissolve";
    j++;
  } else if (word === "wipe" || word === "wiping" || word === "wipes") {
    let k = skip(t, j + 1, words("to the"));
    if (!isAt(t, k, DIRECTIONS)) return null;
    effectName = directionEffect(wordAt(t, k) as string);
    j = k + 1;
  } else if (isAt(t, j, DIRECTIONS) && isAt(t, j + 1, words("wipe wipes"))) {
    effectName = directionEffect(word as string);
    j += 2;
  } else if (word === "iris" || word === "zoom" || word === "barndoor") {
    const how = wordAt(t, j + 1);
    const open = how === "open" || how === "opens" || (word === "zoom" && how === "in");
    const close = how === "close" || how === "closes" || (word === "zoom" && how === "out");
    if (!open && !close) return null;
    effectName = word === "barndoor" ? (open ? "barnDoorOpen" : "barnDoorClose") : open ? "irisOpen" : "irisClose";
    j += 2;
  } else if (word === "venetian" || word === "blinds") {
    j += word === "venetian" && wordAt(t, j + 1) === "blinds" ? 2 : 1;
    effectName = "venetianBlinds";
  } else if (word === "checkerboard" || word === "checkers") {
    effectName = "checkerboard";
    j++;
  } else if (word === "cut") {
    effectName = "cut";
    j++;
  }
  if (effectName === undefined) return null;
  if (isAt(t, j, EFFECT_NOUNS)) j++;
  return statements(j, effectStatement(effectName));
};

words("slowly slow gently quickly quick fast rapidly swiftly normal normally very speed at");

const parseSpeed: PhraseParser = (t, i) => {
  let j = i;
  if (wordAt(t, j) === "at" && isAt(t, j + 1, words("slow fast normal very"))) j++;
  let speed: VisualEffectSpeed | undefined;
  const word = wordAt(t, j);
  if (word === "very" && isAt(t, j + 1, words("slowly slow"))) {
    speed = "verySlow";
    j += 2;
  } else if (word === "slowly" || word === "slow" || word === "gently") {
    speed = "slow";
    j++;
  } else if (word === "quickly" || word === "quick" || word === "fast" || word === "rapidly" || word === "swiftly") {
    speed = "fast";
    j++;
  } else if (word === "normal" || word === "normally") {
    speed = "normal";
    j++;
  }
  if (speed === undefined) return null;
  if (wordAt(t, j) === "speed") j++;
  return { end: j, speed };
};

// ----- sound ---------------------------------------------------------------------------------

const VOICE_WORDS: ReadonlyMap<string, HexVoice> = new Map([
  ["harpsichord", "harpsichord"], ["harpsichords", "harpsichord"], ["cembalo", "harpsichord"],
  ["boing", "boing"], ["boings", "boing"], ["bounce", "boing"], ["bouncy", "boing"], ["spring", "boing"], ["sproing", "boing"],
  ["flute", "flute"], ["flutes", "flute"], ["whistle", "flute"],
  ["square8bit", "square8bit"], ["8bit", "square8bit"], ["chiptune", "square8bit"], ["square", "square8bit"], ["retro", "square8bit"], ["arcade", "square8bit"],
  ["click", "click"], ["clicks", "click"],
]);
for (const word of VOICE_WORDS.keys()) VOCAB.add(word);

type MelodyName = keyof typeof MELODIES;
const MELODY_NOUNS: ReadonlyMap<string, MelodyName> = new Map([
  ["fanfare", "fanfare"], ["scale", "scale"], ["jingle", "tune"], ["tune", "tune"], ["melody", "tune"], ["song", "tune"],
  ["motif", "tune"], ["theme", "tune"], ["ditty", "tune"], ["riff", "tune"], ["chord", "arpeggio"], ["arpeggio", "arpeggio"],
  ["chime", "chime"], ["beep", "beep"], ["beeps", "beep"], ["bleep", "beep"], ["note", "note"], ["tone", "note"],
]);
for (const word of MELODY_NOUNS.keys()) VOCAB.add(word);

const MOODS: ReadonlyMap<string, MelodyName> = new Map([
  ["spooky", "spooky"], ["scary", "spooky"], ["creepy", "spooky"], ["eerie", "spooky"], ["haunted", "spooky"], ["haunting", "spooky"],
  ["ghostly", "spooky"], ["mysterious", "spooky"], ["victory", "victory"], ["victorious", "victory"], ["triumphant", "victory"],
  ["winning", "victory"], ["happy", "victory"], ["cheerful", "victory"], ["sad", "sad"], ["gloomy", "sad"], ["losing", "sad"],
]);
for (const word of MOODS.keys()) VOCAB.add(word);

const SOUND_VERBS = words("play plays playing sound make emit produce");
const SOUND_NOUNS = words("sound sounds noise noises sfx music notes");
const SOUND_LINKS = words("on with using");
const NOTE_WORD = /^([a-g][#b]?[1-7]|r)[whqes]?\.?$/;

const parseSound: PhraseParser = (t, i, ctx) => {
  let j = i;
  const verb = isAt(t, j, SOUND_VERBS) ? (wordAt(t, j) as string) : undefined;
  if (verb !== undefined) j++;
  let voice: HexVoice | undefined;
  let melody: MelodyName | undefined;
  let mood: MelodyName | undefined;
  let notes: string | undefined;
  let tempo: number | undefined;
  let noun = false;
  let soundSpeed: VisualEffectSpeed | undefined;
  const setVoice = (next: HexVoice): boolean => {
    if (voice !== undefined && voice !== next) return false;
    voice = next;
    return true;
  };
  for (;;) {
    const token = t[j];
    const word = wordAt(t, j);
    if (word !== undefined && (ARTICLES.has(word) || word === "some" || word === "short" || word === "little")) {
      j++;
      continue;
    }
    if (word !== undefined && SOUND_LINKS.has(word) && VOICE_WORDS.has(wordAt(t, skip(t, j + 1, ARTICLES)) ?? "")) {
      j = skip(t, j + 1, ARTICLES);
      continue;
    }
    if (word === "click" || word === "clicks") {
      // The click voice only when the phrase is clearly about sound.
      if (verb === undefined && !isAt(t, j + 1, SOUND_NOUNS)) break;
      if (!setVoice("click")) return null;
      j++;
      continue;
    }
    if (word !== undefined && VOICE_WORDS.has(word)) {
      if (!setVoice(VOICE_WORDS.get(word) as HexVoice)) return null;
      j++;
      if (word === "square" && wordAt(t, j) === "wave") j++;
      continue;
    }
    if (word === "c" && wordAt(t, j + 1) === "major" && wordAt(t, j + 2) === "scale") {
      melody = "scale";
      j += 3;
      continue;
    }
    if (word !== undefined && MELODY_NOUNS.has(word)) {
      if (melody !== undefined) return null;
      melody = MELODY_NOUNS.get(word);
      j++;
      continue;
    }
    if (word !== undefined && MOODS.has(word)) {
      mood = MOODS.get(word);
      j++;
      continue;
    }
    if (word !== undefined && SOUND_NOUNS.has(word)) {
      noun = true;
      j++;
      continue;
    }
    // "play a sad tune slowly on the flute": a speed inside the phrase sets the tempo.
    const speedWord = j > i && soundSpeed === undefined ? parseSpeed(t, j, ctx) : null;
    if (speedWord?.speed !== undefined) {
      soundSpeed = speedWord.speed;
      j = speedWord.end;
      continue;
    }
    if (token?.type === "string" && notes === undefined) {
      if (token.value.trim() === "" || !printable(token.value) || parseNoteSequence(token.value).invalid.length > 0) return null;
      notes = token.value.trim().replace(/\s+/g, " ");
      j++;
      continue;
    }
    if (token?.type === "word" && notes === undefined && NOTE_WORD.test(token.word) && /\d/.test(token.word)) {
      const run: string[] = [];
      while (t[j]?.type === "word" && NOTE_WORD.test(wordAt(t, j) as string)) run.push(wordAt(t, j++) as string);
      notes = run.join(" ");
      continue;
    }
    if (tempo === undefined) {
      const k = word === "at" ? j + 1 : j;
      if (wordAt(t, k) === "tempo") {
        const n = readNumber(t, k + 1);
        if (!n) return null;
        tempo = n.value;
        j = n.end;
        if (wordAt(t, j) === "bpm") j++;
        continue;
      }
      const n = readNumber(t, k);
      if (n && wordAt(t, n.end) === "bpm") {
        tempo = n.value;
        j = n.end + 1;
        continue;
      }
    }
    break;
  }
  if (j === i) return null;
  if (verb === undefined && voice === undefined && melody === undefined && !(noun && mood !== undefined)) return null;
  if (verb === "make" || verb === "sound" || verb === "emit" || verb === "produce") {
    // "make a boing sound", "sound a beep": something to sound is required.
    if (voice === undefined && melody === undefined && mood === undefined) return null;
  }
  if (verb !== undefined && voice === undefined && melody === undefined && mood === undefined && notes === undefined && !noun) return null;
  if (mood !== undefined && melody === undefined && !noun && voice === undefined) return null;
  const tune = mood ?? melody;
  const finalVoice = voice ?? (tune === "beep" || tune === "victory" ? "square8bit" : "harpsichord");
  const finalNotes = notes ?? MELODIES[tune ?? "note"];
  const finalTempo = tempo ?? (soundSpeed === undefined ? 120 : SOUND_SPEED_TEMPO[soundSpeed]);
  if (soundSpeed !== undefined) tempo ??= finalTempo;
  if (!Number.isInteger(finalTempo) || finalTempo < 20 || finalTempo > 400) return null;
  const statement = play(finalVoice, finalNotes, finalTempo);
  return { end: j, statements: [tempo === undefined ? ({ ...statement, tempoDefault: true }) as MaybeDefaultTempo : statement] };
};

// ----- dialogs -------------------------------------------------------------------------------

const ANSWER_VERBS = words("answer say says alert tell display show popup announce notify warn greet");
const AUDIENCE = words("user player me them us him her everyone");
const DIALOG_NOUNS = words("message alert dialog dialogue popup box notice greeting");
const SAYING = words("saying says reading that which");
const LABEL_WORDS = words("yes no ok okay cancel maybe continue quit retry later sure nope stop");
const PHRASE_VERBS = words("go play put add subtract hide show ask answer say wait fetch set store save beep visual dissolve");

function readButtons(t: Toks, i: number): Parsed<HexExprNode[]> | null {
  if (wordAt(t, i) !== "with") return null;
  let j = i + 1;
  if (isAt(t, j, words("buttons button options choices answers"))) j++;
  const labels: HexExprNode[] = [];
  for (;;) {
    const token = t[j];
    if (token?.type === "string" && printable(token.value) && token.value !== "") labels.push(lit(token.value));
    else if (token?.type === "word" && (LABEL_WORDS.has(token.word) || (/^[A-Z][A-Za-z]*$/.test(token.raw) && isNameWord(t, j)))) labels.push(lit(token.raw));
    else break;
    j++;
    if (labels.length === 3 || !isAt(t, j, words("or and"))) break;
    j++;
  }
  if (labels.length === 0) return null;
  if (isAt(t, j - 1, words("or and"))) return null;
  return { value: labels, end: j };
}

const parseAnswer: PhraseParser = (t, i, ctx) => {
  if (!isAt(t, i, ANSWER_VERBS)) {
    // "a message saying 'Hi'"
    const j = skip(t, i, ARTICLES);
    if (!isAt(t, j, words("message alert dialog popup"))) return null;
  }
  const verb = wordAt(t, i) as string;
  let j = isAt(t, i, ANSWER_VERBS) ? i + 1 : i;
  j = skip(t, j, ARTICLES);
  if (isAt(t, j, AUDIENCE)) j++;
  j = skip(t, j, ARTICLES);
  let dialog = false;
  if (isAt(t, j, words("welcome")) && isAt(t, j + 1, DIALOG_NOUNS)) {
    // "a welcome message"
    j += 2;
    while (isAt(t, j, DIALOG_NOUNS)) j++;
    const buttons = readButtons(t, j);
    ctx.itWritten = true;
    return statements(buttons ? buttons.end : j, answer(lit("Welcome!"), buttons?.value ?? []));
  }
  while (isAt(t, j, DIALOG_NOUNS)) {
    dialog = true;
    j++;
  }
  if (isAt(t, j, SAYING)) {
    j++;
    if (isAt(t, j, words("says reads"))) j++;
  }
  if (wordAt(t, j) === "with" && wordAt(t, j + 1) === "the" && wordAt(t, j + 2) === "text") j += 3;
  const explicitVerb = isAt(t, i, ANSWER_VERBS);
  if ((verb === "show" || verb === "display") && !dialog && t[j]?.type !== "string") {
    // "show the date": only values that cannot be a part.
    const value = readValue(t, j, ctx, false);
    if (!value || value.value.kind === "ReadContainer") return null;
    if (wordAt(t, value.end) === "in" || wordAt(t, value.end) === "into") return null;
    ctx.itWritten = true;
    return statements(value.end, answer(value.value));
  }
  let content: HexExprNode | undefined;
  let end = j;
  const value = readValue(t, j, ctx, false);
  if (value) {
    content = value.value;
    end = value.end;
  } else if (explicitVerb && (verb === "say" || verb === "tell" || verb === "greet" || verb === "answer" || verb === "says")
    && !isAt(t, j - 1, ARTICLES) && !isAt(t, j, ARTICLES)) {
    // Plain words ("say hello there"), but never a noun phrase such as "say the score".
    const run: string[] = [];
    let k = j;
    while (t[k]?.type === "word" && wordAt(t, k) !== "with" && !PHRASE_VERBS.has(wordAt(t, k) as string)) run.push((t[k] as { raw: string }).raw), k++;
    if (run.length > 0 && (t[k] === undefined || wordAt(t, k) === "with")) {
      content = lit(run.join(" "));
      end = k;
    } else if (run.length === 0 && verb === "greet") {
      content = lit("Hello!");
      end = k;
    }
  }
  if (content === undefined) return null;
  if (content.kind === "Literal" && typeof content.value === "string" && !printable(content.value)) return null;
  const buttons = readButtons(t, end);
  ctx.itWritten = true;
  return statements(buttons ? buttons.end : end, answer(content, buttons?.value ?? []));
};

const ASK_VERBS = words("ask asks prompt request query");
const ASK_DETERMINERS = words("the their your his her its my our player user players users visitor");
const ASK_STOP = words("store save keep put and then with into in");

const parseAsk: PhraseParser = (t, i, ctx) => {
  if (!isAt(t, i, ASK_VERBS)) return null;
  let j = i + 1;
  if (isAt(t, j, AUDIENCE) || isAt(t, j, ARTICLES)) {
    j = skip(t, j, ARTICLES);
    if (isAt(t, j, AUDIENCE)) j++;
  }
  const token = t[j];
  if (token?.type === "string") {
    if (!printable(token.value) || token.value === "") return null;
    const buttons = readButtons(t, j + 1);
    if (buttons) {
      // "ask 'Are you sure?' with Yes or No": a choice, which is an answer dialog.
      ctx.itWritten = true;
      return statements(buttons.end, answer(lit(token.value), buttons.value));
    }
    ctx.itWritten = true;
    return statements(j + 1, ask(lit(token.value)));
  }
  if (wordAt(t, j) === "for") j++;
  else if (wordAt(t, j) === "to" && isAt(t, j + 1, words("enter type give provide input tell"))) j += 2;
  else if (wordAt(t, i) !== "ask" && wordAt(t, i) !== "prompt") return null;
  j = skip(t, j, ASK_DETERMINERS);
  const noun: string[] = [];
  while (noun.length < 3 && t[j]?.type === "word" && !ASK_STOP.has(wordAt(t, j) as string) && !PHRASE_VERBS.has(wordAt(t, j) as string)
    && !STOPWORDS.has(wordAt(t, j) as string) && IDENTIFIER_RAW.test((t[j] as { raw: string }).raw)) {
    noun.push(wordAt(t, j) as string);
    j++;
  }
  if (noun.length === 0) return null;
  ctx.itWritten = true;
  return statements(j, ask(lit(`What is your ${noun.join(" ")}?`)));
};

// ----- put / store / set container ----------------------------------------------------------

const PUT_VERBS = words("put place insert write type copy paste enter");
const STORE_VERBS = words("store stores storing save saves saving keep remember record stash");
const INTO = words("into in to onto inside as");
const CLEAR_VERBS = words("clear empty erase blank");
const SHOW_IN_VERBS = words("show display print output write");

function readStoredValue(t: Toks, i: number, ctx: Ctx): Parsed<HexExprNode> | null {
  // "store it", "save the answer", "store the name" (after ask)
  const j = skip(t, i, ARTICLES);
  if (ctx.itWritten && (wordAt(t, j) === "it" || (j > i && isAt(t, j, IT_NOUN_WORDS)) || wordAt(t, j) === "that")) {
    return { value: itVar(), end: j + 1 };
  }
  return readValue(t, i, ctx, false);
}

function readMode(t: Toks, i: number): Parsed<"into" | "after" | "before"> | null {
  if (wordAt(t, i) === "after") return { value: "after", end: i + 1 };
  if (wordAt(t, i) === "before") return { value: "before", end: i + 1 };
  if (wordAt(t, i) === "at" && wordAt(t, i + 1) === "the" && isAt(t, i + 2, words("end start beginning")) && wordAt(t, i + 3) === "of") {
    return { value: wordAt(t, i + 2) === "end" ? "after" : "before", end: i + 4 };
  }
  if (isAt(t, i, INTO)) return { value: "into", end: i + 1 };
  return null;
}

const parsePut: PhraseParser = (t, i, ctx) => {
  const verb = wordAt(t, i);
  if (verb === undefined) return null;
  if (PUT_VERBS.has(verb) || SHOW_IN_VERBS.has(verb)) {
    const value = readValue(t, i + 1, ctx, false);
    if (!value) return null;
    const mode = readMode(t, value.end);
    if (!mode) return null;
    if (SHOW_IN_VERBS.has(verb) && !PUT_VERBS.has(verb) && mode.value !== "into") return null;
    const destination = readContainer(t, mode.end, true);
    if (!destination) return null;
    return statements(destination.end, put(value.value, destination.value, mode.value));
  }
  if (STORE_VERBS.has(verb)) {
    let j = i + 1;
    let value: HexExprNode | undefined;
    if (!isAt(t, j, INTO)) {
      const stored = readStoredValue(t, j, ctx);
      if (!stored) return null;
      value = stored.value;
      j = stored.end;
    } else if (ctx.itWritten) {
      value = itVar();
    } else {
      return null;
    }
    if (!isAt(t, j, INTO)) return null;
    const destination = readContainer(t, j + 1, true);
    if (!destination) return null;
    return statements(destination.end, put(value, destination.value));
  }
  if (verb === "set" || verb === "change") {
    const destination = readContainer(t, i + 1, true);
    if (!destination || wordAt(t, destination.end) !== "to") return null;
    const value = readValue(t, destination.end + 1, ctx, false);
    if (!value) return null;
    return statements(value.end, put(value.value, destination.value));
  }
  if (verb === "reset") {
    const destination = readContainer(t, i + 1, true);
    if (!destination) return null;
    let j = destination.end;
    if (wordAt(t, j) === "back") j++;
    if (wordAt(t, j) !== "to") return null;
    const value = readValue(t, j + 1, ctx, false);
    if (!value) return null;
    return statements(value.end, put(value.value, destination.value));
  }
  if (verb === "fill") {
    const destination = readContainer(t, i + 1, true);
    if (!destination || wordAt(t, destination.end) !== "with") return null;
    const value = readValue(t, destination.end + 1, ctx, false);
    if (!value) return null;
    return statements(value.end, put(value.value, destination.value));
  }
  if (CLEAR_VERBS.has(verb)) {
    let j = i + 1;
    if (wordAt(t, j) === "out") j++;
    const destination = readContainer(t, j, true);
    if (!destination) return null;
    return statements(destination.end, put(emptyText(), destination.value));
  }
  if (verb === "append" || verb === "prepend") {
    const value = readValue(t, i + 1, ctx, false);
    if (!value || !isAt(t, value.end, words("to onto"))) return null;
    const destination = readContainer(t, value.end + 1, true);
    if (!destination) return null;
    return statements(destination.end, put(value.value, destination.value, verb === "append" ? "after" : "before"));
  }
  return null;
};

// ----- get / roll ----------------------------------------------------------------------------

const parseGet: PhraseParser = (t, i, ctx) => {
  const verb = wordAt(t, i);
  if (verb === "roll" || verb === "throw") {
    const j = skip(t, i + 1, words("a the one"));
    if (!isAt(t, j, words("die dice d6"))) return null;
    ctx.itWritten = true;
    return statements(j + 1, getValue(random(lit(6))));
  }
  if (verb === "get" || verb === "pick" || verb === "choose" || verb === "generate") {
    const value = readValue(t, i + 1, ctx, false);
    if (!value) return null;
    if (verb !== "get" && !(value.value.kind === "FunctionCall" || value.value.kind === "BinaryOp")) return null;
    ctx.itWritten = true;
    return statements(value.end, getValue(value.value));
  }
  return null;
};

// ----- arithmetic ----------------------------------------------------------------------------

const POINT_WORDS = words("point points");
const INCREASE = words("increase increases raise increment bump boost");
const DECREASE = words("decrease decreases decrement lower reduce drop");

function readAmount(t: Toks, i: number, ctx: Ctx): Parsed<HexExprNode> | null {
  const value = readValue(t, i, ctx, false);
  if (!value) return null;
  if (value.value.kind === "Literal" && typeof value.value.value !== "number") return null;
  const end = isAt(t, value.end, POINT_WORDS) ? value.end + 1 : value.end;
  return { value: value.value, end };
}

function countLoop(t: Toks, i: number): Phrase | null {
  // count [up|down] [from A] to B in <field> [one per second]
  let j = i + 1;
  let down = false;
  if (wordAt(t, j) === "down") {
    down = true;
    j++;
  } else if (wordAt(t, j) === "up") {
    j++;
  }
  let start: number | undefined;
  if (wordAt(t, j) === "from") {
    const a = readNumber(t, j + 1);
    if (!a) return null;
    start = a.value;
    j = a.end;
  }
  let end: number | undefined;
  if (wordAt(t, j) === "to") {
    const b = readNumber(t, j + 1);
    if (!b) return null;
    end = b.value;
    j = b.end;
  }
  if (down) {
    if (start === undefined) return null;
    end ??= 1;
  } else {
    if (end === undefined) return null;
    start ??= 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || (down ? start <= end : start >= end)) return null;
  if (!isAt(t, j, words("in into on"))) return null;
  const destination = readContainer(t, j + 1, true);
  if (!destination) return null;
  j = destination.end;
  const body: HexStatementNode[] = [put(variable("i"), destination.value)];
  // "one per second", "one number per second", "every second", "each second"
  let k = j;
  if (wordAt(t, k) === "one") k++;
  if (wordAt(t, k) === "number") k++;
  if (isAt(t, k, words("per every each a")) && wordAt(t, k + 1) === "second") {
    body.push(wait(1, "seconds"));
    j = k + 2;
  }
  return statements(j, repeat({ type: "range", varName: "i", start: lit(start), end: lit(end), direction: down ? "down" : "up" }, body));
}

const parseMath: PhraseParser = (t, i, ctx) => {
  const verb = wordAt(t, i);
  if (verb === undefined) return null;
  if (verb === "add" || verb === "give") {
    const amount = readAmount(t, i + 1, ctx);
    if (!amount || !isAt(t, amount.end, words("to onto"))) return null;
    const destination = readContainer(t, amount.end + 1, true);
    return destination ? statements(destination.end, math("add", amount.value, destination.value)) : null;
  }
  if (verb === "subtract" || verb === "deduct" || verb === "remove" || verb === "take") {
    let j = i + 1;
    if (verb === "take" && wordAt(t, j) === "away") j++;
    const amount = readAmount(t, j, ctx);
    if (!amount || wordAt(t, amount.end) !== "from") return null;
    const destination = readContainer(t, amount.end + 1, true);
    return destination ? statements(destination.end, math("subtract", amount.value, destination.value)) : null;
  }
  if (INCREASE.has(verb) || DECREASE.has(verb)) {
    const destination = readContainer(t, i + 1, true);
    if (!destination) return null;
    let amount: HexExprNode = lit(1);
    let end = destination.end;
    if (wordAt(t, end) === "by") {
      const by = readAmount(t, end + 1, ctx);
      if (!by) return null;
      amount = by.value;
      end = by.end;
    }
    return statements(end, math(INCREASE.has(verb) ? "add" : "subtract", amount, destination.value));
  }
  if (verb === "multiply" || verb === "divide") {
    const destination = readContainer(t, i + 1, true);
    if (!destination || wordAt(t, destination.end) !== "by") return null;
    const amount = readAmount(t, destination.end + 1, ctx);
    return amount ? statements(amount.end, math(verb, amount.value, destination.value)) : null;
  }
  if (verb === "double" || verb === "triple" || verb === "halve") {
    const destination = readContainer(t, i + 1, true);
    if (!destination) return null;
    const statement = verb === "halve"
      ? math("divide", lit(2), destination.value)
      : math("multiply", lit(verb === "double" ? 2 : 3), destination.value);
    return statements(destination.end, statement);
  }
  if (verb === "count") {
    const j = skip(t, i + 1, ARTICLES);
    if (isAt(t, j, words("clicks taps presses visits")) && isAt(t, j + 1, words("in into with using on"))) {
      const destination = readContainer(t, j + 2, true);
      return destination ? statements(destination.end, math("add", lit(1), destination.value)) : null;
    }
    return countLoop(t, i);
  }
  return null;
};

// ----- properties ----------------------------------------------------------------------------

const HIDE_VERBS = words("hide hides conceal");
const SHOW_VERBS = words("show shows reveal unhide");
const ENABLE_VERBS = words("enable activate");
const DISABLE_VERBS = words("disable deactivate");
const CHECK_VERBS = words("check tick hilite highlight turnon");
const UNCHECK_VERBS = words("uncheck untick unhilite unhighlight deselect turnoff");
const STATE_ADJECTIVES: ReadonlyMap<string, [HexPropertyName, boolean]> = new Map([
  ["invisible", ["visible", false]], ["hidden", ["visible", false]], ["visible", ["visible", true]], ["shown", ["visible", true]],
  ["disabled", ["enabled", false]], ["inactive", ["enabled", false]], ["enabled", ["enabled", true]], ["active", ["enabled", true]],
  ["disappear", ["visible", false]], ["vanish", ["visible", false]], ["appear", ["visible", true]], ["reappear", ["visible", true]],
  ["checked", ["hilite", true]], ["unchecked", ["hilite", false]], ["locked", ["lockText", true]], ["unlocked", ["lockText", false]],
]);
for (const word of STATE_ADJECTIVES.keys()) VOCAB.add(word);

const PROPERTY_PHRASES: readonly [string[], HexPropertyName][] = [
  [["text", "size"], "textSize"], [["font", "size"], "textSize"], [["size"], "textSize"], [["text", "font"], "textFont"],
  [["font"], "textFont"], [["text", "alignment"], "textAlign"], [["alignment"], "textAlign"], [["text", "align"], "textAlign"],
  [["name"], "name"], [["title"], "title"], [["label"], "title"], [["location"], "location"], [["position"], "location"],
  [["visible"], "visible"], [["enabled"], "enabled"], [["hilite"], "hilite"], [["highlight"], "hilite"],
];
for (const [phrase] of PROPERTY_PHRASES) for (const word of phrase) VOCAB.add(word);

function readPropertyName(t: Toks, i: number): Parsed<HexPropertyName> | null {
  for (const [phrase, property] of PROPERTY_PHRASES) {
    if (phrase.every((word, k) => wordAt(t, i + k) === word)) return { value: property, end: i + phrase.length };
  }
  return null;
}

const TEXT_SIZES = new Set([9, 10, 12, 14, 18, 24]);
const TEXT_FONTS = new Map([["system", "System"], ["sans", "Sans"], ["mono", "Mono"], ["serif", "Serif"]]);
const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const BOOLEAN_WORDS: ReadonlyMap<string, boolean> = new Map([
  ["true", true], ["false", false], ["on", true], ["off", false], ["yes", true], ["no", false],
]);

/** The value of `set <property> of <object> to ...`, checked so that the store will accept it. */
function readPropertyValue(t: Toks, i: number, property: HexPropertyName, ctx: Ctx): Parsed<HexExprNode> | null {
  const token = t[i];
  const word = wordAt(t, i);
  switch (property) {
    case "textSize": {
      const n = readNumber(t, i);
      return n && TEXT_SIZES.has(n.value) ? { value: lit(n.value), end: n.end } : null;
    }
    case "textFont": {
      const name = token?.type === "string" ? token.value.toLowerCase() : word;
      const font = name === undefined ? undefined : TEXT_FONTS.get(name);
      return font ? { value: lit(font), end: i + 1 } : null;
    }
    case "textAlign": {
      const name = token?.type === "string" ? token.value.toLowerCase() : word === "centre" ? "center" : word;
      return name !== undefined && TEXT_ALIGNS.has(name) ? { value: lit(name), end: i + 1 } : null;
    }
    case "visible": case "enabled": case "hilite": {
      const flag = word === undefined ? undefined : BOOLEAN_WORDS.get(word);
      return flag === undefined ? null : { value: lit(flag), end: i + 1 };
    }
    case "location":
      return token?.type === "point" ? { value: lit(token.value), end: i + 1 } : null;
    case "name": case "title": {
      const value = readValue(t, i, ctx, false);
      return value && value.value.kind !== "ReadContainer" ? value : null;
    }
    default:
      return null;
  }
}

function setChecked(property: HexPropertyName, object: ObjectRef, value: HexExprNode, end: number): Phrase | null {
  return propertyAllowed(property, object.kind) ? statements(end, setProperty(property, object.target, value)) : null;
}

function readTimes(t: Toks, i: number): Parsed<number> | null {
  const word = wordAt(t, i);
  if (word === "twice") return { value: 2, end: i + 1 };
  if (word === "thrice") return { value: 3, end: i + 1 };
  if (word === "once") return { value: 1, end: i + 1 };
  const n = readNumber(t, i);
  if (n && wordAt(t, n.end) === "times" && Number.isInteger(n.value) && n.value >= 1 && n.value <= 100) {
    let end = n.end + 1;
    if (wordAt(t, end) === "in" && wordAt(t, end + 1) === "a" && wordAt(t, end + 2) === "row") end += 3;
    return { value: n.value, end };
  }
  return null;
}

const parseProperty: PhraseParser = (t, i, ctx) => {
  const verb = wordAt(t, i);
  if (verb === undefined) return null;
  const objectAfter = (k: number): Parsed<ObjectRef> | null => readObject(t, k, ctx);
  if (HIDE_VERBS.has(verb) || SHOW_VERBS.has(verb)) {
    const object = objectAfter(i + 1);
    if (!object) return null;
    return setChecked("visible", object.value, lit(SHOW_VERBS.has(verb)), object.end);
  }
  if (ENABLE_VERBS.has(verb) || DISABLE_VERBS.has(verb)) {
    const object = objectAfter(i + 1);
    if (!object) return null;
    return setChecked("enabled", object.value, lit(ENABLE_VERBS.has(verb)), object.end);
  }
  if (verb === "lock" || verb === "unlock") {
    const object = objectAfter(i + 1);
    if (!object) return null;
    return setChecked("lockText", object.value, lit(verb === "lock"), object.end);
  }
  if (CHECK_VERBS.has(verb) || UNCHECK_VERBS.has(verb)) {
    const object = objectAfter(i + 1);
    if (!object) return null;
    return setChecked("hilite", object.value, lit(CHECK_VERBS.has(verb)), object.end);
  }
  if (verb === "toggle") {
    let j = skip(t, i + 1, ARTICLES);
    let property: HexPropertyName = "hilite";
    if (isAt(t, j, words("visibility hilite highlight")) && wordAt(t, j + 1) === "of") {
      property = wordAt(t, j) === "visibility" ? "visible" : "hilite";
      j += 2;
    } else {
      j = i + 1;
    }
    const object = objectAfter(j);
    if (!object) return null;
    let end = object.end;
    if (property === "hilite" && wordAt(t, end) === "visibility") {
      property = "visible";
      end++;
    }
    return setChecked(property, object.value, not(readProperty(property, object.value.target)), end);
  }
  if (verb === "make" || verb === "turn") {
    const object = objectAfter(i + 1);
    if (!object) return null;
    const adjective = wordAt(t, object.end);
    const state = adjective === undefined ? undefined : STATE_ADJECTIVES.get(adjective);
    if (!state) return null;
    return setChecked(state[0], object.value, lit(state[1]), object.end + 1);
  }
  if (verb === "rename") {
    const object = objectAfter(i + 1);
    if (!object || !isAt(t, object.end, words("to as"))) return null;
    const value = readPropertyValue(t, object.end + 1, "name", ctx);
    if (!value) return null;
    return setChecked("name", object.value, value.value, value.end);
  }
  if (verb === "set" || verb === "change") {
    const j = skip(t, i + 1, ARTICLES);
    const property = readPropertyName(t, j);
    if (!property || wordAt(t, property.end) !== "of") return null;
    const object = objectAfter(property.end + 1);
    if (!object || wordAt(t, object.end) !== "to") return null;
    const value = readPropertyValue(t, object.end + 1, property.value, ctx);
    if (!value) return null;
    return setChecked(property.value, object.value, value.value, value.end);
  }
  if (verb === "mark" || verb === "unmark") {
    const object = objectAfter(i + 1);
    if (!object) return null;
    return setChecked("marked", object.value, lit(verb === "mark"), object.end);
  }
  if (verb === "move") {
    const object = objectAfter(i + 1);
    if (!object || wordAt(t, object.end) !== "to") return null;
    const value = readPropertyValue(t, object.end + 1, "location", ctx);
    if (!value) return null;
    return setChecked("location", object.value, value.value, value.end);
  }
  if (verb === "flash" || verb === "blink" || verb === "flicker") {
    const object = objectAfter(i + 1);
    if (!object || (object.value.kind !== "button" && object.value.kind !== "field")) return null;
    const times = readTimes(t, object.end);
    return statements(times?.end ?? object.end, flash(object.value.target, object.value.kind, times?.value ?? 3));
  }
  if (verb === "shake" || verb === "wiggle" || verb === "jiggle" || verb === "wobble" || verb === "rattle") {
    const object = objectAfter(i + 1);
    if (!object || object.value.target.objectType !== "me" || (ctx.kind !== "button" && ctx.kind !== "field")) return null;
    const times = readTimes(t, object.end);
    return statements(times?.end ?? object.end, ...shakeMe(times?.value ?? 3));
  }
  // "the button disappears"
  const object = objectAfter(i);
  if (object) {
    let end = object.end;
    if (isAt(t, end, words("is becomes gets"))) end++;
    const adjective = wordAt(t, end)?.replace(/s$/, "");
    const state = adjective === undefined ? undefined : STATE_ADJECTIVES.get(adjective);
    if (state && (state[0] === "visible")) return setChecked(state[0], object.value, lit(state[1]), end + 1);
  }
  return null;
};

// ----- wait ----------------------------------------------------------------------------------

const WAIT_VERBS = words("wait pause sleep delay hold");

function readDuration(t: Toks, i: number): Parsed<HexStatementNode> | null {
  let j = i;
  if (wordAt(t, j) === "about") j++;
  if (wordAt(t, j) === "half" && wordAt(t, j + 1) === "a" && isAt(t, j + 2, words("second sec"))) {
    return { value: wait(30, "ticks"), end: j + 3 };
  }
  let amount: number | undefined;
  if (isAt(t, j, words("a an")) && isAt(t, j + 1, words("second sec tick minute"))) {
    amount = 1;
    j++;
  } else {
    const n = readNumber(t, j);
    if (!n) return null;
    amount = n.value;
    j = n.end;
  }
  const unit = wordAt(t, j);
  if (unit === "second" || unit === "seconds" || unit === "sec" || unit === "secs") return { value: wait(amount, "seconds"), end: j + 1 };
  if (unit === "tick" || unit === "ticks") return { value: wait(amount, "ticks"), end: j + 1 };
  if (unit === "minute" || unit === "minutes") return { value: wait(amount * 60, "seconds"), end: j + 1 };
  if (unit === "millisecond" || unit === "milliseconds" || unit === "ms") {
    const ticks = Math.round((amount * 60) / 1000);
    return ticks >= 1 ? { value: wait(ticks, "ticks"), end: j + 1 } : null;
  }
  return null;
}
words("about half second seconds sec secs tick ticks minute minutes millisecond milliseconds ms later for");

const parseWait: PhraseParser = (t, i) => {
  const word = wordAt(t, i);
  if (word !== undefined && WAIT_VERBS.has(word)) {
    let j = i + 1;
    if (word === "hold" && wordAt(t, j) === "on") j++;
    if (wordAt(t, j) === "for") j++;
    const duration = readDuration(t, j);
    return duration ? statements(duration.end, duration.value) : null;
  }
  if (word === "after") {
    const duration = readDuration(t, i + 1);
    return duration ? statements(duration.end, duration.value) : null;
  }
  const duration = readDuration(t, i);
  if (duration && wordAt(t, duration.end) === "later") return statements(duration.end + 1, duration.value);
  return null;
};

// ----- fetch ---------------------------------------------------------------------------------

const FETCH_VERBS = words("fetch load download get retrieve grab pull read");
const JSON_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[\d+\])*$/;
words("from json data path key");

const parseFetch: PhraseParser = (t, i, ctx) => {
  if (!isAt(t, i, FETCH_VERBS)) return null;
  let j = i + 1;
  // Up to three words describing the data before "from <url>".
  let described = 0;
  while (t[j]?.type === "word" && wordAt(t, j) !== "from" && described < 4) {
    j++;
    described++;
  }
  if (wordAt(t, j) === "from") j++;
  const url = t[j];
  if (url?.type !== "url" || !url.value.toLowerCase().startsWith("https://") || !printable(url.value)) return null;
  j++;
  let jsonPath: string | undefined;
  if (isAt(t, j, words("at path key"))) {
    let k = j + 1;
    if (wordAt(t, j) === "at" && isAt(t, k, words("path key"))) k++;
    const token = t[k];
    const path = token?.type === "string" ? token.value : token?.type === "word" ? token.raw : undefined;
    if (path === undefined || !JSON_PATH.test(path)) return null;
    jsonPath = path;
    j = k + 1;
  }
  if (!isAt(t, j, words("into in to"))) return null;
  const destination = readContainer(t, j + 1, true);
  if (!destination) return null;
  ctx.itWritten = true;
  return statements(destination.end, fetchJson(url.value, destination.value, jsonPath));
};

// ----- repeat modifier -----------------------------------------------------------------------

const parseRepeat: PhraseParser = (t, i) => {
  let j = i;
  if (wordAt(t, j) === "repeat" || wordAt(t, j) === "do") j++;
  if (wordAt(t, j) === "it" || wordAt(t, j) === "this") return null;
  const times = readTimes(t, j);
  if (!times) return null;
  return { end: times.end, repeat: times.value };
};
words("twice thrice once times row repeat do");

/** Tried in this order at every phrase start; the first that matches wins. */
const PHRASE_PARSERS: readonly PhraseParser[] = [
  parseRepeat, parseWait, parseFetch, parseAsk, parseGet, parsePut, parseMath, parseProperty,
  parseAnswer, parseSound, parseEffect, parseSpeed, parseGo,
];

// ---------------------------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------------------------

const COMPARATORS: readonly (readonly [string[], HexBinaryOp])[] = (
  [
    ["is greater than or equal to", ">="], ["is less than or equal to", "<="], ["is at least", ">="], ["is at most", "<="],
    ["is no more than", "<="], ["is not equal to", "<>"], ["does not equal", "<>"], ["doesnt equal", "<>"],
    ["is different from", "<>"], ["not equal to", "<>"], ["is not", "<>"], ["isnt", "<>"], ["are not", "<>"],
    ["is greater than", ">"], ["is more than", ">"], ["is bigger than", ">"], ["is higher than", ">"], ["is above", ">"],
    ["is over", ">"], ["greater than", ">"], ["more than", ">"], ["bigger than", ">"], ["higher than", ">"], ["exceeds", ">"],
    ["goes over", ">"], ["gets over", ">"], ["is less than", "<"], ["is smaller than", "<"], ["is lower than", "<"],
    ["is below", "<"], ["is under", "<"], ["less than", "<"], ["fewer than", "<"], ["smaller than", "<"], ["lower than", "<"],
    ["drops below", "<"], ["falls below", "<"], ["reaches", ">="], ["is equal to", "="], ["equals", "="], ["is exactly", "="],
    ["is", "="], ["are", "="], ["was", "="], ["contains", "contains"], ["includes", "contains"],
  ] as const
).map(([phrase, op]) => {
  const list = phrase.split(" ");
  for (const word of list) VOCAB.add(word);
  return [list, op as HexBinaryOp] as const;
});

function readComparator(t: Toks, i: number): Parsed<HexBinaryOp> | null {
  const token = t[i];
  if (token?.type === "op") return { value: token.value as HexBinaryOp, end: i + 1 };
  for (const [phrase, op] of COMPARATORS) {
    if (phrase.every((word, k) => wordAt(t, i + k) === word)) return { value: op, end: i + phrase.length };
  }
  return null;
}

const CHOOSE_VERBS = words("clicks clicked chooses chose picks picked selects selected says said answers answered types typed enters entered");
const CHECKED_WORDS = words("checked hilited highlighted selected ticked on");
const UNCHECKED_WORDS = words("unchecked unticked off");

function readCondition(t: Toks, i: number, ctx: Ctx): Parsed<HexExprNode> | null {
  // "the user clicks Yes", "they answered 'No'"
  {
    let j = skip(t, i, ARTICLES);
    if (isAt(t, j, words("user player they you"))) {
      j++;
      if (isAt(t, j, CHOOSE_VERBS) && ctx.itWritten) {
        const token = t[j + 1];
        const label = token?.type === "string" ? token.value : token?.type === "word" ? token.raw : undefined;
        if (label !== undefined && printable(label) && label !== "") return { value: binary("=", itVar(), lit(label)), end: j + 2 };
      }
    }
  }
  // "this checkbox is checked", "button 'X' is hidden"
  // "it" in a condition is the result variable, not the object.
  const object = wordAt(t, i) === "it" ? null : readObject(t, i, ctx);
  {
    if (object) {
      let j = object.end;
      if (isAt(t, j, words("is gets"))) j++;
      let negate = false;
      if (wordAt(t, j) === "not") {
        negate = true;
        j++;
      }
      const word = wordAt(t, j);
      let property: HexPropertyName | undefined;
      let flag = true;
      if (word !== undefined && CHECKED_WORDS.has(word)) property = "hilite";
      else if (word !== undefined && UNCHECKED_WORDS.has(word)) [property, flag] = ["hilite", false];
      else if (word === "visible" || word === "shown") property = "visible";
      else if (word === "hidden" || word === "invisible") [property, flag] = ["visible", false];
      if (property !== undefined && propertyAllowed(property, object.value.kind)) {
        return { value: binary("=", readProperty(property, object.value.target), lit(negate ? !flag : flag)), end: j + 1 };
      }
    }
  }
  const left = readValue(t, i, ctx, true);
  if (!left) return null;
  let j = left.end;
  if (isAt(t, j, words("is are")) && (wordAt(t, j + 1) === "empty" || (wordAt(t, j + 1) === "not" && wordAt(t, j + 2) === "empty"))) {
    const negate = wordAt(t, j + 1) === "not";
    return { value: binary(negate ? "<>" : "=", left.value, emptyText()), end: j + (negate ? 3 : 2) };
  }
  const op = readComparator(t, j);
  if (!op) return null;
  j = op.end;
  const right = readValue(t, j, ctx, false);
  if (right) return { value: binary(op.value, left.value, right.value), end: right.end };
  const token = t[j];
  if (token?.type === "word" && (LABEL_WORDS.has(token.word) || isNameWord(t, j)) && IDENTIFIER_RAW.test(token.raw)) {
    return { value: binary(op.value, left.value, lit(token.raw)), end: j + 1 };
  }
  return null;
}
words("if unless else otherwise not");

// ---------------------------------------------------------------------------------------------
// Clauses and assembly
// ---------------------------------------------------------------------------------------------

type ClauseResult =
  | { kind: "plain"; statements: HexStatementNode[] }
  | { kind: "if"; condition: HexExprNode; statements: HexStatementNode[] }
  | { kind: "else"; statements: HexStatementNode[] }
  | { kind: "error"; reason: string; unknown: string[] };

/** Marks a PlaySound whose tempo was not given, so a speed word may set it (removed before output). */
type MaybeDefaultTempo = HexStatementNode & { tempoDefault?: boolean };

function withoutTempoFlag(statement: MaybeDefaultTempo): HexStatementNode {
  if (!("tempoDefault" in statement)) return statement;
  const copy: MaybeDefaultTempo = { ...statement };
  delete copy.tempoDefault;
  return copy;
}

const SOUND_SPEED_TEMPO: Readonly<Record<VisualEffectSpeed, number>> = { verySlow: 60, slow: 80, normal: 120, fast: 180 };

function compileClause(t: Toks, ctx: Ctx): ClauseResult {
  let i = 0;
  let header: { kind: "if"; condition: HexExprNode } | { kind: "else" } | undefined;
  const first = wordAt(t, 0);
  if (first === "if" && wordAt(t, 1) === "not") {
    header = { kind: "else" };
    i = 2;
  } else if (first === "if" || first === "unless") {
    const condition = readCondition(t, 1, ctx);
    if (!condition) return { kind: "error", reason: "I could not read the condition after \"if\".", unknown: [] };
    header = { kind: "if", condition: first === "unless" ? not(condition.value) : condition.value };
    i = condition.end;
    if (wordAt(t, i) === "then") i++;
  } else if (first === "else" || first === "otherwise") {
    header = { kind: "else" };
    i = 1;
  } else if (first === "or" && wordAt(t, 1) === "else") {
    header = { kind: "else" };
    i = 2;
  }
  const body: MaybeDefaultTempo[] = [];
  const unknown: string[] = [];
  let repeatCount: number | undefined;
  let speed: VisualEffectSpeed | undefined;
  while (i < t.length) {
    if (isAt(t, i, STOPWORDS)) {
      i++;
      continue;
    }
    let phrase: Phrase | null = null;
    for (const parser of PHRASE_PARSERS) {
      phrase = parser(t, i, ctx);
      if (phrase && phrase.end > i) break;
      phrase = null;
    }
    if (!phrase) {
      unknown.push(rawAt(t, i));
      i++;
      continue;
    }
    if (phrase.statements) body.push(...phrase.statements);
    if (phrase.repeat !== undefined) {
      if (repeatCount !== undefined) return { kind: "error", reason: "That spell repeats twice in one step.", unknown: [] };
      repeatCount = phrase.repeat;
    }
    if (phrase.speed !== undefined) {
      if (speed !== undefined) return { kind: "error", reason: "That spell names two speeds in one step.", unknown: [] };
      speed = phrase.speed;
    }
    i = phrase.end;
  }
  if (unknown.length > 0) return { kind: "error", reason: "", unknown };
  if (speed !== undefined) {
    const effects = body.filter((statement) => statement.kind === "QueueVisualEffect");
    const sounds = body.filter((statement) => statement.kind === "PlaySound" && statement.tempoDefault);
    if (effects.length > 0) {
      for (let k = 0; k < body.length; k++) if (body[k].kind === "QueueVisualEffect") body[k] = { ...(body[k] as Extract<HexStatementNode, { kind: "QueueVisualEffect" }>), speed };
    } else if (sounds.length > 0) {
      for (let k = 0; k < body.length; k++) {
        const statement = body[k];
        if (statement.kind === "PlaySound" && statement.tempoDefault) body[k] = { ...statement, tempo: SOUND_SPEED_TEMPO[speed] };
      }
    } else {
      return { kind: "error", reason: "A speed word needs a visual effect or a sound in the same step.", unknown: [] };
    }
  }
  let result: HexStatementNode[] = body.map(withoutTempoFlag);
  if (repeatCount !== undefined && repeatCount > 1) {
    if (result.length === 0) return { kind: "error", reason: "\"times\" needs something to repeat in the same step.", unknown: [] };
    const looped = result.some((statement) => statement.kind === "PlaySound") && !result.some((statement) => statement.kind === "Wait")
      ? [...result, wait(15, "ticks")]
      : result;
    result = [repeatTimes(repeatCount, looped)];
  }
  if (header?.kind === "if") return { kind: "if", condition: header.condition, statements: result };
  if (header?.kind === "else") return { kind: "else", statements: result };
  return { kind: "plain", statements: result };
}

/** Moves each queued visual effect right before the `go` it belongs to (§3.2 rule 7). */
function placeEffects(list: HexStatementNode[]): HexStatementNode[] | string {
  const out: HexStatementNode[] = [];
  for (const statement of list) {
    if (statement.kind === "IfCondition") {
      const thenBranch = placeEffects(statement.thenBranch);
      if (typeof thenBranch === "string") return thenBranch;
      const elseBranch = statement.elseBranch ? placeEffects(statement.elseBranch) : undefined;
      if (typeof elseBranch === "string") return elseBranch;
      out.push(ifThen(statement.condition, thenBranch, elseBranch));
    } else if (statement.kind === "RepeatLoop") {
      const body = placeEffects(statement.body);
      if (typeof body === "string") return body;
      out.push({ ...statement, body });
    } else {
      out.push(statement);
    }
  }
  if (!out.some((statement) => statement.kind === "QueueVisualEffect")) return out;
  const goIndexes = out.flatMap((statement, index) => (statement.kind === "GoToCard" ? [index] : []));
  if (goIndexes.length === 0) return "A visual effect is shown when the script goes to another card; say which card to go to.";
  // Each effect belongs to the first unclaimed `go` after it ("dissolve to the next card"), else
  // to the nearest unclaimed `go` before it ("go to the next card with a dissolve").
  const claimed = new Map<number, HexStatementNode>();
  for (let index = 0; index < out.length; index++) {
    const statement = out[index];
    if (statement.kind !== "QueueVisualEffect") continue;
    const after = goIndexes.find((go) => go > index && !claimed.has(go));
    const before = [...goIndexes].reverse().find((go) => go < index && !claimed.has(go));
    const go = after ?? before;
    if (go === undefined) return "That spell has more visual effects than card changes.";
    claimed.set(go, statement);
  }
  const result: HexStatementNode[] = [];
  out.forEach((statement, index) => {
    if (statement.kind === "QueueVisualEffect") return;
    const queued = claimed.get(index);
    if (queued) result.push(queued);
    result.push(statement);
  });
  return result;
}

type Compiled = { ok: true; ast: HexScriptAST } | { ok: false; reason: string };

/** The Tier 1 local compiler (no Grimoire lookup, no acceptance pipeline). */
export function compileTier1(prompt: string, context: SpellContext): Compiled {
  const tokens = mergeCompounds(correctWords(tokenize(prompt)));
  const other = tokens.find((token) => token.type === "other");
  if (other) return { ok: false, reason: `I did not understand "${rawAt([other], 0)}" in that spell.` };
  const trigger = extractTrigger(tokens);
  if ("error" in trigger) return { ok: false, reason: trigger.error };
  const ctx: Ctx = { kind: context.objectKind, itWritten: false };
  const body: HexStatementNode[] = [];
  let open: { node: Extract<HexStatementNode, { kind: "IfCondition" }>; branch: "then" | "else"; sentence: number } | null = null;
  const sentences = splitSentences(trigger.tokens);
  const unknown: string[] = [];
  for (let s = 0; s < sentences.length; s++) {
    const clauses = sentences[s];
    for (let c = 0; c < clauses.length; c++) {
      const clause = compileClause(clauses[c], ctx);
      if (clause.kind === "error") {
        if (clause.reason) return { ok: false, reason: clause.reason };
        unknown.push(...clause.unknown);
        continue;
      }
      if (clause.kind === "if") {
        const node = ifThen(clause.condition, clause.statements) as Extract<HexStatementNode, { kind: "IfCondition" }>;
        body.push(node);
        open = { node, branch: "then", sentence: s };
      } else if (clause.kind === "else") {
        const attachable = open !== null && open.branch === "then"
          && (open.sentence === s || (open.sentence === s - 1 && c === 0));
        if (!open || !attachable) return { ok: false, reason: "\"Otherwise\" needs an \"if\" right before it." };
        open.node.elseBranch = clause.statements;
        open.branch = "else";
        open.sentence = s;
      } else if (open !== null && open.sentence === s) {
        (open.branch === "then" ? open.node.thenBranch : (open.node.elseBranch ??= [])).push(...clause.statements);
      } else {
        open = null;
        body.push(...clause.statements);
      }
    }
  }
  if (unknown.length > 0) {
    const shown = [...new Set(unknown)].slice(0, 5).map((word) => `"${word}"`).join(", ");
    return { ok: false, reason: `I did not understand ${shown} in that spell.` };
  }
  for (const statement of body) {
    if (statement.kind === "IfCondition" && statement.thenBranch.length === 0) {
      return { ok: false, reason: "The \"if\" in that spell has nothing to do." };
    }
  }
  if (body.length === 0) return { ok: false, reason: "I did not find anything to do in that spell." };
  const placed = placeEffects(body);
  if (typeof placed === "string") return { ok: false, reason: placed };
  const eventName = trigger.eventName ?? DEFAULT_HANDLER[context.objectKind];
  return { ok: true, ast: script(eventName, placed) };
}

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

const stem = (word: string): string => word.replace(/(ing|ed|es|s)$/, "") || word;

function contentWords(text: string): Set<string> {
  const tokens = mergeCompounds(correctWords(tokenize(text)));
  const out = new Set<string>();
  for (const token of tokens) {
    if (token.type !== "word") continue;
    if (STOPWORDS.has(token.word) || STRUCTURAL.has(token.word) || ARTICLES.has(token.word)) continue;
    out.add(stem(token.word));
  }
  return out;
}

const GRIMOIRE_WORDS: readonly Set<string>[] = GRIMOIRE.map((entry) => contentWords(entry.prompt));

/** The Grimoire spells closest to `prompt` (most shared words first); never empty. */
export function suggestGrimoire(prompt: string, count = SUGGESTION_COUNT): GrimoireEntry[] {
  const wanted = contentWords(prompt);
  const scored = GRIMOIRE.map((entry, index) => {
    const entryWords = GRIMOIRE_WORDS[index];
    let shared = 0;
    for (const word of wanted) if (entryWords.has(word)) shared++;
    return { entry, index, score: shared / Math.sqrt(Math.max(1, entryWords.size)) };
  });
  const matching = scored.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const chosen = matching.length > 0 ? matching : scored;
  return chosen.slice(0, count).map((item) => item.entry);
}

// ---------------------------------------------------------------------------------------------
// Hints for the preview
// ---------------------------------------------------------------------------------------------

/** Messages that start at the card (§3), so a button or field never receives them. */
const CARD_LEVEL_MESSAGES = new Set([
  "opencard", "closecard", "openbackground", "closebackground", "openstack", "closestack", "newcard", "deletecard", "idle",
]);

/** A note for the preview when a handler can never run in this object's script, else undefined. */
export function handlerHint(ast: HexScriptAST, objectKind: SpellObjectKind): string | undefined {
  if (objectKind !== "button" && objectKind !== "field") return undefined;
  const handler = Object.values(ast.handlers).find((candidate) => CARD_LEVEL_MESSAGES.has(candidate.eventName.toLowerCase()));
  return handler
    ? `${handler.eventName} is sent to the card, not to a ${objectKind}: apply this spell to the card, background or stack instead.`
    : undefined;
}
