/**
 * Showcase stack "HexSynth Sequencer" (spec 04 task 8, design.md §7; design spec §9): a keyboard
 * card and a 16-step sequencer card, both played with `play` (PlaySound) through the procedural
 * WebAudio synth. No audio files.
 *
 * - Keyboard: eight white and five black keys. A radio-button family picks the voice; each key's
 *   `mouseDown` reads the radio hilites and plays its note with that voice (the `play` grammar
 *   takes a literal voice and note string, so every key carries its own short `if` chain).
 * - Sequencer: three rows of 16 checkBox steps (Lead, Bass, Drum). Play sets the global `playing`;
 *   the card's `idle` handler then plays the current step and moves the playhead, one step per
 *   `idle` message (every 200 ms). Each step is its own top-level dispatch, so the loop never runs
 *   into the 10,000-step gas limit. Leaving the card stops playback.
 *
 * Art: canonical rleData drawn by scripts/buildPresetArt.ts (src/presets/presetArt.ts).
 */
import type { HexVoice } from "../core/ast.ts";
import type { HexPart, HexStack } from "../core/schema.ts";
import { PRESET_ART } from "./presetArt.ts";
import { background, button, card, field, hexTalk, rect, stack } from "./presetKit.ts";

export const RETRO_SYNTH_NAME = "HexSynth Sequencer";

const BG = "bkg_hs_panel";
const TITLE = "prt_hs_title";
const INFO = "prt_hs_info";

// ---------------------------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------------------------

/** Radio buttons (family 1) and the voice each selects; the first is the default. */
export const SYNTH_VOICES: readonly { name: string; voice: HexVoice }[] = [
  { name: "Harpsichord", voice: "harpsichord" },
  { name: "Square 8-bit", voice: "square8bit" },
  { name: "Flute", voice: "flute" },
  { name: "Boing", voice: "boing" },
];

const WHITE_KEYS = ["c4", "d4", "e4", "f4", "g4", "a4", "b4", "c5"] as const;
/** Black keys: the white key they follow and their note. */
const BLACK_KEYS = [
  { after: 0, note: "c#4" },
  { after: 1, note: "eb4" },
  { after: 3, note: "f#4" },
  { after: 4, note: "g#4" },
  { after: 5, note: "bb4" },
] as const;

const KEY_LEFT = 96;
const KEY_TOP = 152;
const KEY_PITCH = 40;

/** `mouseDown` of a key: plays `note` with the voice whose radio button is hilited (default harpsichord). */
export function keyScript(note: string): string {
  const [fallback, ...others] = SYNTH_VOICES;
  const lines = ["on mouseDown"];
  others.forEach(({ name, voice }, i) => {
    const indent = "  ".repeat(i + 1);
    lines.push(`${indent}if the hilite of card button "${name}" then`, `${indent}  play ${voice} "${note}q"`, `${indent}else`);
  });
  lines.push(`${"  ".repeat(others.length + 1)}play ${fallback.voice} "${note}q"`);
  for (let i = others.length; i >= 1; i--) lines.push(`${"  ".repeat(i)}end if`);
  lines.push("end mouseDown");
  return hexTalk(...lines);
}

function keyboardParts(): HexPart[] {
  const voices = SYNTH_VOICES.map(({ name }, i) =>
    button(`prt_hs_voice_${i + 1}`, "card", name, rect(196, 54 + i * 20, 120, 18), {
      style: "radioButton", family: 1, hilite: i === 0,
    }));
  const white = WHITE_KEYS.map((note, i) =>
    button(`prt_hs_key_${note}`, "card", `Key ${note.toUpperCase()}`, rect(KEY_LEFT + i * KEY_PITCH, KEY_TOP, KEY_PITCH + 1, 112), {
      style: "rectangle", title: note[0].toUpperCase(), scriptSource: keyScript(note),
    }));
  // After the white keys, so they are drawn on top and hit first. A hilited rectangle is drawn inverted (dark).
  const black = BLACK_KEYS.map(({ after, note }) =>
    button(`prt_hs_key_${note.replace("#", "s")}`, "card", `Key ${note.toUpperCase()}`, rect(KEY_LEFT + (after + 1) * KEY_PITCH - 12, KEY_TOP, 24, 68), {
      style: "rectangle", showName: false, autoHilite: false, hilite: true, scriptSource: keyScript(note),
    }));
  return [...voices, ...white, ...black];
}

// ---------------------------------------------------------------------------------------------
// Sequencer
// ---------------------------------------------------------------------------------------------

export const STEP_COUNT = 16;
const STEP_LEFT = 104;
const STEP_PITCH = 24;
const PLAYHEAD_Y = 218;

/** Lead pitch of each step (C minor pentatonic arpeggio). */
export const LEAD_NOTES: readonly string[] = [
  "c4", "eb4", "g4", "bb4", "c5", "bb4", "g4", "eb4", "f4", "ab4", "c5", "eb5", "d5", "c5", "bb4", "g4",
];

/** Rows of the step grid and the steps that start switched on. */
export const SEQUENCER_TRACKS = [
  { name: "Lead", y: 120, on: [1, 2, 3, 4, 5, 7, 9, 10, 11, 12, 13, 15] },
  { name: "Bass", y: 152, on: [1, 4, 7, 9, 12, 15] },
  { name: "Drum", y: 184, on: [1, 3, 5, 7, 9, 11, 13, 15] },
] as const;

/** Card button `<track> <step>`, e.g. "Lead 3". */
export const stepName = (track: string, step: number): string => `${track} ${step}`;

const SEQUENCER_SCRIPT = hexTalk(
  "on openCard",
  "  global playing, beat",
  '  put "off" into playing',
  "  put 0 into beat",
  `  set the location of card button "Playhead" to "${STEP_LEFT + 8},${PLAYHEAD_Y}"`,
  "  pass openCard",
  "end openCard",
  "",
  "on closeCard",
  "  global playing",
  '  put "off" into playing',
  "end closeCard",
  "",
  "on idle",
  "  global playing, beat",
  '  if playing <> "on" then exit idle',
  "  add 1 to beat",
  `  if beat > ${STEP_COUNT} then put 1 into beat`,
  `  set the location of card button "Playhead" to ${STEP_LEFT - STEP_PITCH + 8} + beat * ${STEP_PITCH} & "," & ${PLAYHEAD_Y}`,
  '  if the hilite of card button ("Lead " & beat) then',
  ...LEAD_NOTES.map((note, i) => `    if beat = ${i + 1} then play harpsichord tempo 150 "${note}e"`),
  "  end if",
  '  if the hilite of card button ("Bass " & beat) then',
  '    if beat < 9 then play square8bit tempo 150 "c3e"',
  '    if beat >= 9 and beat < 13 then play square8bit tempo 150 "ab2e"',
  '    if beat >= 13 then play square8bit tempo 150 "bb2e"',
  "  end if",
  '  if the hilite of card button ("Drum " & beat) then play click "c4s"',
  "end idle",
);

function sequencerParts(): HexPart[] {
  const parts: HexPart[] = [];
  for (const track of SEQUENCER_TRACKS) {
    parts.push(field(`prt_hs_label_${track.name.toLowerCase()}`, "card", `${track.name} Label`, rect(24, track.y, 72, 20), {
      style: "transparent", content: track.name, textFont: "System", textAlign: "right",
    }));
    for (let step = 1; step <= STEP_COUNT; step++) {
      const on = (track.on as readonly number[]).includes(step);
      parts.push(button(`prt_hs_${track.name.toLowerCase()}_${step}`, "card", stepName(track.name, step), rect(STEP_LEFT + (step - 1) * STEP_PITCH, track.y, 18, 20), {
        style: "checkBox", showName: false, hilite: on,
      }));
    }
  }
  parts.push(
    button("prt_hs_playhead", "card", "Playhead", rect(STEP_LEFT + 2, PLAYHEAD_Y - 3, 12, 6), {
      style: "rectangle", showName: false, autoHilite: false, hilite: true,
    }),
    button("prt_hs_play", "card", "Play", rect(104, 234, 80, 24), {
      style: "default",
      scriptSource: hexTalk(
        "on mouseUp",
        "  global playing, beat",
        '  put "on" into playing',
        "  put 0 into beat",
        "end mouseUp",
      ),
    }),
    button("prt_hs_stop", "card", "Stop", rect(196, 238, 80, 20), {
      scriptSource: hexTalk(
        "on mouseUp",
        "  global playing",
        '  put "off" into playing',
        "end mouseUp",
      ),
    }),
    button("prt_hs_clear", "card", "Clear", rect(288, 238, 80, 20), {
      scriptSource: hexTalk(
        "on mouseUp",
        `  repeat with i = 1 to ${STEP_COUNT}`,
        ...SEQUENCER_TRACKS.map((track) => `    set the hilite of card button ("${track.name} " & i) to false`),
        "  end repeat",
        "end mouseUp",
      ),
    }),
  );
  return parts;
}

// ---------------------------------------------------------------------------------------------
// Stack
// ---------------------------------------------------------------------------------------------

const navScript = (cardName: string) => hexTalk(
  "on mouseUp",
  "  visual effect wipe left fast",
  `  go to card "${cardName}"`,
  "end mouseUp",
);

export function createRetroSynthStack(): HexStack {
  const panel = background(BG, "Synth Panel", PRESET_ART.synthBackground, [
    field(TITLE, "background", "Title", rect(16, 6, 480, 28), {
      textFont: "Serif", textSize: 18, textAlign: "center", textStyle: ["bold"],
    }),
    button("prt_hs_nav_keyboard", "background", "Keyboard", rect(16, 309, 96, 24), { scriptSource: navScript("Keyboard") }),
    button("prt_hs_nav_sequencer", "background", "Sequencer", rect(120, 309, 104, 24), { scriptSource: navScript("Sequencer") }),
    field(INFO, "background", "Info", rect(232, 306, 264, 30), { textSize: 9 }),
  ]);

  const keyboard = card("crd_hs_keyboard", "Keyboard", BG, {
    rleData: PRESET_ART.synthKeyboard,
    bgFieldContents: {
      [TITLE]: `${RETRO_SYNTH_NAME}: Keyboard`,
      [INFO]: "Pick a voice and click the keys. Synthesized live, no audio files.",
    },
    parts: keyboardParts(),
  });

  const sequencer = card("crd_hs_sequencer", "Sequencer", BG, {
    rleData: PRESET_ART.synthSequencer,
    bgFieldContents: {
      [TITLE]: `${RETRO_SYNTH_NAME}: 16 Steps`,
      [INFO]: "Tick the steps and press Play. The idle message plays one step every 200 ms.",
    },
    scriptSource: SEQUENCER_SCRIPT,
    parts: sequencerParts(),
  });

  return stack({
    id: "stk_hexsynth",
    name: RETRO_SYNTH_NAME,
    theme: "AmberCRT",
    backgrounds: [panel],
    cards: [keyboard, sequencer],
  });
}
