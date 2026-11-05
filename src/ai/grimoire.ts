/**
 * HexAI Spellcaster Grimoire: 24 curated natural-language prompts with their HexScriptASTs
 * (spec 04 Requirement 4.1; design.md §4; hexcard_design_spec.md §4.4).
 *
 * The entries are `{ prompt, ast }` pairs. The ASTs are written as AST data with the builders
 * below (the AI layer outputs ASTs only; HexTalk is printed from them), and they go through the
 * same acceptance pipeline as every other AI result before they are previewed
 * (`acceptAst` in spellcaster.ts). The builders are shared with the Tier 1 compiler.
 *
 * Every prompt is plain ASCII so that the Spellcaster tab can show it in the bundled fonts.
 */
import type {
  HexBinaryOp,
  HexCardTarget,
  HexContainerTarget,
  HexExprNode,
  HexObjectTarget,
  HexPropertyName,
  HexRepeatHead,
  HexScriptAST,
  HexStatementNode,
  HexVoice,
} from "../core/ast.ts";
import type { VisualEffectSpeed, VisualEffectType } from "../core/schema.ts";

export interface GrimoireEntry {
  /** The natural-language spell shown in the Grimoire Preset Library. */
  prompt: string;
  /** The script it conjures; accepted by `validateAst`. */
  ast: HexScriptAST;
}

// ---------------------------------------------------------------------------------------------
// AST builders (fresh objects on every call)
// ---------------------------------------------------------------------------------------------

export type FieldTarget = Extract<HexContainerTarget, { scope: "field" }>;
export type PartLayer = "card" | "background";

export const lit = (value: string | number | boolean): HexExprNode => ({ kind: "Literal", value });
export const variable = (name: string): HexExprNode => ({ kind: "Variable", name });
/** The handler-local result variable that `ask`, `answer`, `get` and `fetch` write. */
export const itVar = (): HexExprNode => variable("it");
export const emptyText = (): HexExprNode => ({ kind: "Constant", name: "empty" });
export const builtIn = (name: Extract<HexExprNode, { kind: "BuiltIn" }>["name"]): HexExprNode => ({ kind: "BuiltIn", name });
export const binary = (op: HexBinaryOp, left: HexExprNode, right: HexExprNode): HexExprNode => ({ kind: "BinaryOp", op, left, right });
export const not = (operand: HexExprNode): HexExprNode => ({ kind: "UnaryOp", op: "not", operand });
/** `random(n)`: a whole number from 1 to n. */
export const random = (n: HexExprNode): HexExprNode => ({ kind: "FunctionCall", name: "random", args: [n] });

/** A field container; without a layer word HexTalk means a background field. */
export function fieldTarget(name: string | number, layer: PartLayer = "background"): FieldTarget {
  return { scope: "field", layer, selector: { by: "auto", value: lit(name) } };
}
export const varTarget = (name: string): HexContainerTarget => ({ scope: "variable", name });
export const readField = (source: FieldTarget): HexExprNode => ({ kind: "ReadContainer", source });
export const readProperty = (property: HexPropertyName, target: HexObjectTarget): HexExprNode =>
  ({ kind: "ReadProperty", property, target });

export const me = (): HexObjectTarget => ({ objectType: "me" });
export function partObject(objectType: "button" | "field", name: string | number, layer: PartLayer): HexObjectTarget {
  return { objectType, layer, selector: { by: "auto", value: lit(name) } };
}

export function script(eventName: string, body: HexStatementNode[]): HexScriptAST {
  return { handlers: { [eventName.toLowerCase()]: { eventName, params: [], body } } };
}

export const goTo = (target: HexCardTarget): HexStatementNode => ({ kind: "GoToCard", target });
export const goRelative = (dir: Extract<HexCardTarget, { type: "relative" }>["dir"]): HexStatementNode =>
  goTo({ type: "relative", dir });
export const goCard = (value: HexExprNode): HexStatementNode => goTo({ type: "auto", value });
export const effect = (name: VisualEffectType, speed: VisualEffectSpeed = "normal"): HexStatementNode =>
  ({ kind: "QueueVisualEffect", effect: name, speed });
export const play = (voice: HexVoice, notes: string, tempo = 120): HexStatementNode =>
  ({ kind: "PlaySound", voice, tempo, notes });
export const answer = (prompt: HexExprNode, buttons: HexExprNode[] = []): HexStatementNode =>
  ({ kind: "ShowAnswerDialog", prompt, buttons });
export const ask = (prompt: HexExprNode): HexStatementNode => ({ kind: "ShowAskDialog", prompt });
export const put = (value: HexExprNode, destination: HexContainerTarget, mode: "into" | "after" | "before" = "into"): HexStatementNode =>
  ({ kind: "PutValue", mode, value, destination });
export const getValue = (value: HexExprNode): HexStatementNode => ({ kind: "GetValue", value });
export const math = (op: "add" | "subtract" | "multiply" | "divide", amount: HexExprNode, destination: HexContainerTarget): HexStatementNode =>
  ({ kind: "MathMutation", op, amount, destination });
export const setProperty = (property: HexPropertyName, target: HexObjectTarget, value: HexExprNode): HexStatementNode =>
  ({ kind: "SetProperty", property, target, value });
export const wait = (amount: number, unit: "ticks" | "seconds"): HexStatementNode => ({ kind: "Wait", amount: lit(amount), unit });
export const repeat = (head: HexRepeatHead, body: HexStatementNode[]): HexStatementNode => ({ kind: "RepeatLoop", head, body });
export const repeatTimes = (times: number, body: HexStatementNode[]): HexStatementNode =>
  repeat({ type: "count", times: lit(times) }, body);
export function ifThen(condition: HexExprNode, thenBranch: HexStatementNode[], elseBranch?: HexStatementNode[]): HexStatementNode {
  return elseBranch === undefined
    ? { kind: "IfCondition", condition, thenBranch }
    : { kind: "IfCondition", condition, thenBranch, elseBranch };
}
export const fetchJson = (url: string, destination: HexContainerTarget, jsonPath?: string): HexStatementNode =>
  jsonPath === undefined
    ? { kind: "FetchJson", url: lit(url), destination }
    : { kind: "FetchJson", url: lit(url), jsonPath, destination };

// ---------------------------------------------------------------------------------------------
// Shared script fragments (also emitted by the Tier 1 compiler)
// ---------------------------------------------------------------------------------------------

/** Note strings in the synth grammar (design.md §3). */
export const MELODIES = {
  fanfare: "c4e e4e g4e c5q g4e c5h",
  scale: "c4e d4e e4e f4e g4e a4e b4e c5q",
  victory: "c5s e5s g5s c6q g5s c6h",
  spooky: "e3q g3q a#3q a3h e3q g3q f#3h",
  sad: "c4q b3q a3q g3h",
  tune: "c4e e4e g4e e4e c4h",
  arpeggio: "c4e e4e g4e c5h",
  chime: "e5e c5h",
  beep: "a5e",
  note: "c4q",
} as const;

/**
 * Shakes `me`: it jumps 4 pixels either side of the pointer `times` times, then returns to where
 * it was. HexTalk has no chunk expressions, so the x of `the location of me` cannot be read; the
 * pointer, which is over the part during a mouse message, stands in for it.
 */
export function shakeMe(times: number): HexStatementNode[] {
  const at = (op: "+" | "-"): HexExprNode =>
    binary("&", binary("&", binary(op, builtIn("mouseH"), lit(4)), lit(",")), builtIn("mouseV"));
  return [
    put(readProperty("location", me()), varTarget("home")),
    repeatTimes(times, [
      setProperty("location", me(), at("+")),
      wait(2, "ticks"),
      setProperty("location", me(), at("-")),
      wait(2, "ticks"),
    ]),
    setProperty("location", me(), variable("home")),
  ];
}

/** Flashes a button (its hilite) or a field (its visibility) `times` times. */
export function flash(target: HexObjectTarget, kind: "button" | "field", times: number): HexStatementNode {
  const property: HexPropertyName = kind === "button" ? "hilite" : "visible";
  const on = kind === "button";
  return repeatTimes(times, [
    setProperty(property, target, lit(on)),
    wait(10, "ticks"),
    setProperty(property, target, lit(!on)),
    wait(10, "ticks"),
  ]);
}

/** Open-Meteo current temperature for Berlin (key-free, CORS-enabled, https). */
const BERLIN_TEMPERATURE_URL =
  "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m";

// ---------------------------------------------------------------------------------------------
// The 24 Grimoire spells
// ---------------------------------------------------------------------------------------------

const weather = fieldTarget("Weather");

export const GRIMOIRE: readonly GrimoireEntry[] = [
  {
    prompt: "Dissolve to next card and play a harpsichord fanfare",
    ast: script("mouseUp", [effect("dissolve"), goRelative("next"), play("harpsichord", MELODIES.fanfare)]),
  },
  {
    prompt: "Ask for player name, store in field 'HeroName', and add 50 to Score",
    ast: script("mouseUp", [
      ask(lit("What is your name?")),
      put(itVar(), fieldTarget("HeroName")),
      math("add", lit(50), fieldTarget("Score")),
    ]),
  },
  {
    prompt: "Shake button on click with boing sound",
    ast: script("mouseUp", [play("boing", MELODIES.note), ...shakeMe(3)]),
  },
  {
    prompt: "Go to the previous card with a wipe right",
    ast: script("mouseUp", [effect("wipeRight"), goRelative("prev")]),
  },
  {
    prompt: "Go back to the first card with an iris close",
    ast: script("mouseUp", [effect("irisClose"), goRelative("first")]),
  },
  {
    prompt: "Play a C major scale on the flute",
    ast: script("mouseUp", [play("flute", MELODIES.scale)]),
  },
  {
    prompt: "Play an 8-bit victory jingle",
    ast: script("mouseUp", [play("square8bit", MELODIES.victory, 160)]),
  },
  {
    prompt: "Beep three times",
    ast: script("mouseUp", [repeatTimes(3, [play("square8bit", MELODIES.beep), wait(15, "ticks")])]),
  },
  {
    prompt: "Show a welcome message when the card opens",
    ast: script("openCard", [answer(lit("Welcome!"))]),
  },
  {
    prompt: "Ask 'Are you sure?' with Yes or No and go to the next card on Yes",
    ast: script("mouseUp", [
      answer(lit("Are you sure?"), [lit("Yes"), lit("No")]),
      ifThen(binary("=", itVar(), lit("Yes")), [goRelative("next")]),
    ]),
  },
  {
    prompt: "Roll a die and put the result into field 'Die'",
    ast: script("mouseUp", [put(random(lit(6)), fieldTarget("Die"))]),
  },
  {
    prompt: "Count clicks in field 'Clicks'",
    ast: script("mouseUp", [math("add", lit(1), fieldTarget("Clicks"))]),
  },
  {
    prompt: "Hide this button when clicked",
    ast: script("mouseUp", [setProperty("visible", me(), lit(false))]),
  },
  {
    prompt: "Show button 'Secret' and hide field 'Clue'",
    ast: script("mouseUp", [
      setProperty("visible", partObject("button", "Secret", "card"), lit(true)),
      setProperty("visible", partObject("field", "Clue", "background"), lit(false)),
    ]),
  },
  {
    prompt: "Toggle the hilite of this button",
    ast: script("mouseUp", [setProperty("hilite", me(), not(readProperty("hilite", me())))]),
  },
  {
    prompt: "Put the current time into field 'Clock' on every idle",
    ast: script("idle", [put(builtIn("time"), fieldTarget("Clock"))]),
  },
  {
    prompt: "Put today's date into field 'Date' when the card opens",
    ast: script("openCard", [put(builtIn("date"), fieldTarget("Date"))]),
  },
  {
    prompt: "Fetch the current temperature in Berlin into field 'Weather'",
    ast: script("mouseUp", [
      fetchJson(BERLIN_TEMPERATURE_URL, weather, "current.temperature_2m"),
      ifThen(binary("contains", itVar(), lit("error:")), [put(lit("No signal from Berlin"), fieldTarget("Weather"))]),
    ]),
  },
  {
    prompt: "Count down from 10 to 1 in field 'Timer', one number per second",
    ast: script("mouseUp", [
      repeat({ type: "range", varName: "i", start: lit(10), end: lit(1), direction: "down" }, [
        put(variable("i"), fieldTarget("Timer")),
        wait(1, "seconds"),
      ]),
      answer(lit("Time is up!")),
    ]),
  },
  {
    prompt: "If field 'Score' is over 100 go to card 'Victory', otherwise say 'Keep trying'",
    ast: script("mouseUp", [
      ifThen(
        binary(">", readField(fieldTarget("Score")), lit(100)),
        [goCard(lit("Victory"))],
        [answer(lit("Keep trying"))],
      ),
    ]),
  },
  {
    prompt: "Go to a random card",
    ast: script("mouseUp", [goCard(random(builtIn("numberOfCards")))]),
  },
  {
    prompt: "Flash this button three times",
    ast: script("mouseUp", [flash(me(), "button", 3)]),
  },
  {
    prompt: "Clear field 'Answer' and reset the score to 0",
    ast: script("mouseUp", [put(emptyText(), fieldTarget("Answer")), put(lit(0), fieldTarget("score"))]),
  },
  {
    prompt: "Play a spooky harpsichord motif slowly, then dissolve slowly to the next card",
    ast: script("mouseUp", [play("harpsichord", MELODIES.spooky, 80), effect("dissolve", "slow"), goRelative("next")]),
  },
];
