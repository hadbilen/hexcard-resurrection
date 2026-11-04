/**
 * The showcase stacks offered by File > Open Showcase Stack (spec 04 Requirements 7.1, 7.5).
 * The first entry is opened on first launch (Requirement 7.4). Each `create()` returns a fresh
 * stack; callers load it through the stack loader like any other untrusted stack.
 */
import type { HexStack } from "../core/schema.ts";
import { HAUNTED_MANSION_NAME, createHauntedMansionStack } from "./hauntedMansion.ts";
import { RETRO_SYNTH_NAME, createRetroSynthStack } from "./retroSynthDeck.ts";
import { WEATHER_ORACLE_NAME, createWeatherOracleStack } from "./apiWeatherOracle.ts";

export interface ShowcaseStack {
  id: string;
  name: string;
  description: string;
  create: () => HexStack;
}

export const SHOWCASE_STACKS: readonly ShowcaseStack[] = [
  {
    id: "hauntedMansion",
    name: HAUNTED_MANSION_NAME,
    description: "A five-card 1-bit mystery with dissolves and harpsichord.",
    create: createHauntedMansionStack,
  },
  {
    id: "retroSynthDeck",
    name: RETRO_SYNTH_NAME,
    description: "A keyboard and a 16-step sequencer, all synthesized.",
    create: createRetroSynthStack,
  },
  {
    id: "apiWeatherOracle",
    name: WEATHER_ORACLE_NAME,
    description: "Live weather through fetch, with an offline almanac.",
    create: createWeatherOracleStack,
  },
];

/** The stack opened when HexCard starts with nothing to restore (Requirement 7.4). */
export const FIRST_LAUNCH_SHOWCASE: ShowcaseStack = SHOWCASE_STACKS[0];

export function findShowcase(id: string): ShowcaseStack | undefined {
  return SHOWCASE_STACKS.find((entry) => entry.id === id);
}
