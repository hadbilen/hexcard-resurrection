/**
 * Showcase stack "The Haunted Stack of 1987" (spec 04 task 8, design.md §7; design spec §9):
 * a five-card 1-bit mystery. Find the candle and the cellar key, take the amulet from the coffin,
 * and the front door lets you out at dawn.
 *
 * - One background ("Mansion") holds the room title, the room description and the inventory as
 *   background fields with `sharedText: false`, so every card keeps its own text in
 *   `bgFieldContents` (HyperCard's record semantics). The "Inventory" caption is the one
 *   `sharedText: true` field.
 * - The game state lives in the runtime global `inventory` (never persisted). The background's
 *   `openCard` handler copies it into the current card's Inventory field; card `openCard`
 *   handlers show or hide the pick-up buttons from it and then `pass openCard`. Because the
 *   buttons are derived from `inventory` on every visit, a reloaded stack is always playable.
 * - Card changes use the LFSR `dissolve` (and `iris open` for the ending); harpsichord motifs
 *   play on entering, picking things up and winning.
 *
 * Art: canonical rleData drawn by scripts/buildPresetArt.ts (src/presets/presetArt.ts).
 */
import type { HexStack } from "../core/schema.ts";
import { PRESET_ART } from "./presetArt.ts";
import { background, button, card, field, hexTalk, rect, stack } from "./presetKit.ts";

export const HAUNTED_MANSION_NAME = "The Haunted Stack of 1987";

const BG = "bkg_hm_mansion";
const TITLE = "prt_hm_title";
const DESCRIPTION = "prt_hm_description";
const INVENTORY = "prt_hm_inventory";

const EMPTY_POCKETS = "(empty pockets)";

const BACKGROUND_SCRIPT = hexTalk(
  "on openCard",
  "  global inventory",
  "  if inventory is empty then",
  `    put "${EMPTY_POCKETS}" into field "Inventory"`,
  "  else",
  '    put inventory into field "Inventory"',
  "  end if",
  "end openCard",
);

const STACK_SCRIPT = hexTalk(
  "on openStack",
  "  global inventory",
  "  put empty into inventory",
  "end openStack",
);

/** Bottom button bar: four slots in the light bar the background draws at y 305. */
const slot = (index: number, width = 112) => rect(16 + index * 120, 309, width, 24);

/** A pick-up button: adds `item` to the inventory once and hides itself. */
function pickUpScript(item: string, message: string): string {
  return hexTalk(
    "on mouseUp",
    "  global inventory",
    `  if inventory contains "${item}" then exit mouseUp`,
    `  put "${item}" & return after inventory`,
    '  put inventory into field "Inventory"',
    "  set the visible of me to false",
    '  play harpsichord tempo 160 "a4s c5s e5s a5q"',
    `  answer "${message}"`,
    "end mouseUp",
  );
}

/** Card `openCard`: shows `buttonName` only while `item` is not carried, then passes to the background. */
function showUntilTaken(buttonName: string, item: string, extra: string[] = []): string {
  return hexTalk(
    "on openCard",
    "  global inventory",
    `  set the visible of card button "${buttonName}" to not (inventory contains "${item}")`,
    ...extra,
    "  pass openCard",
    "end openCard",
  );
}

const roomText = (title: string, description: string) => ({ [TITLE]: title, [DESCRIPTION]: description, [INVENTORY]: EMPTY_POCKETS });

export function createHauntedMansionStack(): HexStack {
  const mansion = background(BG, "Mansion", PRESET_ART.hauntedBackground, [
    field(TITLE, "background", "Title", rect(16, 6, 480, 28), {
      textFont: "Serif", textSize: 18, textAlign: "center", textStyle: ["bold"],
    }),
    field(DESCRIPTION, "background", "Description", rect(16, 228, 320, 74)),
    field("prt_hm_inventory_label", "background", "Inventory Label", rect(344, 228, 152, 20), {
      content: "Inventory", sharedText: true, textFont: "System", textAlign: "center",
    }),
    field(INVENTORY, "background", "Inventory", rect(344, 247, 152, 55)),
  ], BACKGROUND_SCRIPT);

  const gate = card("crd_hm_gate", "Gate", BG, {
    rleData: PRESET_ART.hauntedGate,
    bgFieldContents: roomText(
      HAUNTED_MANSION_NAME,
      "October 31st, 1987. Your car died at the gates of the old Hollowmere house. Thunder rolls. Up in the tower, a single window is lit...",
    ),
    parts: [
      button("prt_hm_enter", "card", "Enter the Mansion", rect(176, 309, 160, 24), {
        style: "default",
        scriptSource: hexTalk(
          "on mouseUp",
          "  global inventory",
          "  put empty into inventory",
          '  play harpsichord tempo 100 "d4e f4e a4e d5q c#5e a4h"',
          "  visual effect dissolve",
          '  go to card "Hall"',
          "end mouseUp",
        ),
      }),
    ],
  });

  const hall = card("crd_hm_hall", "Hall", BG, {
    rleData: PRESET_ART.hauntedHall,
    bgFieldContents: roomText(
      "The Great Hall",
      "Portrait eyes follow you. A candle burns on the side table, one door leads to the library, and a heavy door bears a brass keyhole.",
    ),
    scriptSource: showUntilTaken("Take Candle", "Candle"),
    parts: [
      button("prt_hm_to_library", "card", "Library", slot(0), {
        scriptSource: hexTalk(
          "on mouseUp",
          "  visual effect dissolve",
          '  go to card "Library"',
          "end mouseUp",
        ),
      }),
      button("prt_hm_cellar_door", "card", "Cellar Door", slot(1), {
        scriptSource: hexTalk(
          "on mouseUp",
          "  global inventory",
          '  if not (inventory contains "Brass Key") then',
          '    play click "c4s r c4s"',
          '    answer "The cellar door is locked. The keyhole is made of brass."',
          "    exit mouseUp",
          "  end if",
          '  if not (inventory contains "Candle") then',
          '    answer "The key turns, but the stairs vanish into total darkness. You need a light."',
          "    exit mouseUp",
          "  end if",
          '  play harpsichord tempo 80 "d3q a2q f3q d3h"',
          "  visual effect dissolve slow",
          '  go to card "Cellar"',
          "end mouseUp",
        ),
      }),
      button("prt_hm_front_door", "card", "Front Door", slot(2), {
        scriptSource: hexTalk(
          "on mouseUp",
          "  global inventory",
          '  if inventory contains "Silver Amulet" then',
          "    visual effect iris open slow",
          '    go to card "Dawn"',
          "  else",
          '    play boing "c3q"',
          '    answer "The front door will not open. Something in this house is holding you here..."',
          "  end if",
          "end mouseUp",
        ),
      }),
      button("prt_hm_take_candle", "card", "Take Candle", slot(3), {
        scriptSource: pickUpScript("Candle", "You take the candle. Its flame does not flicker, not even in the draft."),
      }),
    ],
  });

  const library = card("crd_hm_library", "Library", BG, {
    rleData: PRESET_ART.hauntedLibrary,
    bgFieldContents: roomText(
      "The Library",
      "Shelves of forgotten stacks and HexTalk manuals. A diary lies open on the desk. Something glints behind the third volume.",
    ),
    scriptSource: showUntilTaken("Take Key", "Brass Key"),
    parts: [
      button("prt_hm_read_diary", "card", "Read Diary", slot(0), {
        scriptSource: hexTalk(
          "on mouseUp",
          '  play flute tempo 90 "e5q d5e c5e b4h"',
          "  answer \"'Oct 31, 1987. The stack must stay closed. I hid the cellar key behind the manuals. The amulet sleeps below.'\"",
          "end mouseUp",
        ),
      }),
      button("prt_hm_take_key", "card", "Take Key", slot(1), {
        scriptSource: pickUpScript("Brass Key", "Behind the third volume you find a cold brass key."),
      }),
      button("prt_hm_library_back", "card", "Back to Hall", slot(3), {
        scriptSource: hexTalk(
          "on mouseUp",
          "  visual effect dissolve",
          '  go to card "Hall"',
          "end mouseUp",
        ),
      }),
    ],
  });

  const cellar = card("crd_hm_cellar", "Cellar", BG, {
    rleData: PRESET_ART.hauntedCellar,
    bgFieldContents: roomText(
      "The Cellar",
      "Stone vaults sweat in the candlelight. An old coffin rests in the middle of the floor. Its lid is not nailed shut.",
    ),
    parts: [
      button("prt_hm_open_coffin", "card", "Open Coffin", slot(0), {
        scriptSource: hexTalk(
          "on mouseUp",
          "  global inventory",
          '  if inventory contains "Silver Amulet" then',
          '    answer "The coffin is empty now. Better not stay to find out where its owner went."',
          "    exit mouseUp",
          "  end if",
          '  play harpsichord tempo 70 "a2q e3q a3q c4q e4h. r a4w"',
          '  put "Silver Amulet" & return after inventory',
          '  put inventory into field "Inventory"',
          '  answer "The lid creaks open. Inside lies a silver amulet, warm to the touch." with "Take it"',
          "end mouseUp",
        ),
      }),
      button("prt_hm_climb_stairs", "card", "Climb Stairs", slot(3), {
        scriptSource: hexTalk(
          "on mouseUp",
          "  visual effect dissolve",
          '  go to card "Hall"',
          "end mouseUp",
        ),
      }),
    ],
  });

  const dawn = card("crd_hm_dawn", "Dawn", BG, {
    rleData: PRESET_ART.hauntedDawn,
    bgFieldContents: roomText(
      "Dawn",
      "The front door swings open. As the sun rises, the amulet crumbles into silver dust. You made it out of the stack alive. Happy Halloween!",
    ),
    scriptSource: hexTalk(
      "on openCard",
      '  play harpsichord tempo 140 "c4e e4e g4e c5q g4e c5h"',
      "  pass openCard",
      "end openCard",
    ),
    parts: [
      button("prt_hm_play_again", "card", "Play Again", rect(176, 309, 160, 24), {
        style: "default",
        scriptSource: hexTalk(
          "on mouseUp",
          "  global inventory",
          "  put empty into inventory",
          "  visual effect dissolve slow",
          '  go to card "Gate"',
          "end mouseUp",
        ),
      }),
    ],
  });

  return stack({
    id: "stk_haunted_1987",
    name: HAUNTED_MANSION_NAME,
    theme: "MidnightHex",
    backgrounds: [mansion],
    cards: [gate, hall, library, cellar, dawn],
    scriptSource: STACK_SCRIPT,
  });
}
