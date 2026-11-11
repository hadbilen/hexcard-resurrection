/// <reference types="node" />
/**
 * Spec 04 task 8: the showcase stacks (Requirements 7.1-7.3, 7.5).
 * - every preset passes the stack validator and the loader's layer decoding, and every script
 *   compiles with zero errors (7.2);
 * - the rleData is canonical: it is exactly what scripts/buildPresetArt.ts produces with the
 *   spec 03 encoder, and it re-encodes to itself;
 * - the stacks play end to end through the real store, message bus, VM and VM host, including
 *   HexOracle's offline fallback (7.3).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { HexScriptAST, HexStatementNode, HexVoice } from "../../core/ast.ts";
import { createMessageBus, type HexMessage } from "../../core/messageBus.ts";
import { parseHexTalk } from "../../core/parser.ts";
import type { HexButtonPart, HexStack } from "../../core/schema.ts";
import { validateStack } from "../../core/stackValidator.ts";
import { createHexStore, readFieldText, type HexStore } from "../../core/store.ts";
import type { FetchResult } from "../../core/vm.ts";
import { parseNoteSequence } from "../../engine/audio/synth.ts";
import { decodeBitmapRLE, encodeBitmapRLE } from "../../engine/graphics/rleCodec.ts";
import { checkStack } from "../../storage/stackLoader.ts";
import { createVmHost } from "../../ui/vmHost.ts";
import { PRESET_ART_PATH, renderPresetArtModule } from "../../../scripts/buildPresetArt.ts";
import { ORACLE_CITIES, OFFLINE_STATUS_PREFIX, oracleSky, oracleUrl } from "../apiWeatherOracle.ts";
import { FIRST_LAUNCH_SHOWCASE, SHOWCASE_STACKS, findShowcase } from "../index.ts";
import { PRESET_ART } from "../presetArt.ts";
import { LEAD_NOTES } from "../retroSynthDeck.ts";

// Per-test budget for the heavy test, so CPU contention in the parallel suite cannot time it out.
const HEAVY_TEST_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

function scriptedObjects(stack: HexStack): Array<{ id: string; scriptSource: string }> {
  return [
    stack,
    ...stack.backgrounds,
    ...stack.backgrounds.flatMap((background) => background.parts),
    ...stack.cards,
    ...stack.cards.flatMap((card) => card.parts),
  ];
}

function collectSounds(statements: readonly HexStatementNode[], out: Array<{ voice: HexVoice; notes: string }>): void {
  for (const statement of statements) {
    if (statement.kind === "PlaySound") out.push({ voice: statement.voice, notes: statement.notes });
    if (statement.kind === "IfCondition") {
      collectSounds(statement.thenBranch, out);
      collectSounds(statement.elseBranch ?? [], out);
    }
    if (statement.kind === "RepeatLoop") collectSounds(statement.body, out);
  }
}

function soundsOf(ast: HexScriptAST): Array<{ voice: HexVoice; notes: string }> {
  const out: Array<{ voice: HexVoice; notes: string }> = [];
  for (const handler of Object.values(ast.handlers)) collectSounds(handler.body, out);
  return out;
}

/** Real store, bus, VM and VM host; dialogs answer with their last (default) button. */
function play(stack: HexStack, fetchJson: (url: string, path?: string) => Promise<FetchResult> = async () => ({ ok: false, reason: "network error" })) {
  const store: HexStore = createHexStore({ stack, compile: parseHexTalk });
  const sounds: Array<{ voice: HexVoice; notes: string }> = [];
  const answers: string[] = [];
  const fetched: Array<{ url: string; path?: string }> = [];
  const errors: unknown[] = [];
  let bus: ReturnType<typeof createMessageBus> | undefined;
  const host = createVmHost({
    store,
    bus: () => bus!,
    dialogs: {
      answer: async (prompt, buttons) => {
        answers.push(prompt);
        return buttons[buttons.length - 1] ?? "OK";
      },
      ask: async (_prompt, defaultAnswer) => defaultAnswer,
    },
    playSound: (voice, _tempo, notes) => sounds.push({ voice, notes }),
    fetchJson: (url, path) => {
      fetched.push({ url, path });
      return fetchJson(url, path);
    },
  });
  bus = createMessageBus({
    store,
    host,
    isPageVisible: () => true,
    isModalOpen: () => false,
    scheduleInterval: () => () => undefined,
    onError: (error) => errors.push(error),
    warn: () => undefined,
  });
  const settle = async (): Promise<void> => {
    do await new Promise((resolve) => setTimeout(resolve, 0));
    while (bus!.isRunning() || bus!.pendingCount() > 0);
  };
  const post = async (...messages: HexMessage[]): Promise<void> => {
    for (const message of messages) bus!.post(message);
    await settle();
  };
  const click = (partId: string) => post({ name: "mouseUp", params: [], targetId: partId });
  const field = (name: string, cardId = store.getSnapshot().currentCardId): string => {
    const { stack: current } = store.getSnapshot();
    const card = current.cards.find((candidate) => candidate.id === cardId)!;
    const own = card.parts.find((part) => part.name === name);
    if (own) return readFieldText(current, cardId, "card", own.id);
    const background = current.backgrounds.find((candidate) => candidate.id === card.backgroundId)!;
    const shared = background.parts.find((part) => part.name === name)!;
    return readFieldText(current, cardId, "background", shared.id);
  };
  const part = (id: string) => store.getSnapshot().stack.cards.flatMap((card) => card.parts).find((candidate) => candidate.id === id)!;
  const cardName = () => store.getSnapshot().stack.cards.find((card) => card.id === store.getSnapshot().currentCardId)!.name;
  return { store, bus, sounds, answers, fetched, errors, settle, post, click, field, part, cardName };
}

// ---------------------------------------------------------------------------------------------
// Requirement 7.2: validation, compilation, canonical art
// ---------------------------------------------------------------------------------------------

describe("showcase stacks", () => {
  it("offers the three showcase stacks by name and opens the Haunted Stack first (Req 7.1, 7.4, 7.5)", () => {
    expect(SHOWCASE_STACKS.map((entry) => entry.name)).toEqual(["The Haunted Stack of 1987", "HexSynth Sequencer", "HexOracle 1987"]);
    expect(FIRST_LAUNCH_SHOWCASE.name).toBe("The Haunted Stack of 1987");
    for (const entry of SHOWCASE_STACKS) expect(findShowcase(entry.id)).toBe(entry);
    expect(findShowcase("nope")).toBeUndefined();
  });

  describe.each(SHOWCASE_STACKS.map((entry) => [entry.name, entry] as const))("%s", (_name, entry) => {
    const stack = entry.create();

    it("passes the stack validator and the loader's bitmap decoding (Req 7.2)", () => {
      expect(stack.schemaVersion).toBe("2.0.0");
      expect(validateStack(stack)).toEqual({ ok: true, stack });
      expect(checkStack(stack).ok).toBe(true);
      expect(stack.name).toBe(entry.name);
    });

    it("compiles every script with zero errors (Req 7.2)", () => {
      const store = createHexStore({ stack, compile: parseHexTalk });
      const objects = scriptedObjects(stack).filter((object) => object.scriptSource !== "");
      expect(objects.length).toBeGreaterThan(0);
      for (const object of objects) expect({ id: object.id, errors: store.getCompiled(object.id).errors }).toEqual({ id: object.id, errors: [] });
    });

    it("plays only note strings the synth understands", () => {
      const sounds = scriptedObjects(stack).flatMap((object) => soundsOf(parseHexTalk(object.scriptSource).ast));
      expect(sounds.length).toBeGreaterThan(0);
      for (const { notes } of sounds) expect({ notes, invalid: parseNoteSequence(notes).invalid }).toEqual({ notes, invalid: [] });
    });

    it("uses only generated preset art in its bitmap layers", () => {
      const art = new Set<string>(Object.values(PRESET_ART));
      for (const layer of [...stack.backgrounds, ...stack.cards].map((owner) => owner.bitmap.rleData)) {
        expect(layer === "" || art.has(layer)).toBe(true);
      }
    });
  });

  it("every preset layer is canonical rleData: it re-encodes to itself", () => {
    for (const [name, rleData] of Object.entries(PRESET_ART)) {
      const fill = name.endsWith("Background") ? 1 : 0;
      expect({ name, same: encodeBitmapRLE(decodeBitmapRLE(rleData, fill)) === rleData }).toEqual({ name, same: true });
    }
  });

  it("src/presets/presetArt.ts is exactly the output of scripts/buildPresetArt.ts", () => {
    expect(readFileSync(PRESET_ART_PATH, "utf8")).toBe(renderPresetArtModule());
  }, HEAVY_TEST_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------------------------
// End to end through the bus
// ---------------------------------------------------------------------------------------------

describe("The Haunted Stack of 1987", () => {
  it("can be won, keeping the inventory in per-card background fields", async () => {
    const game = play(findShowcase("hauntedMansion")!.create());
    game.bus.openCurrentStack();
    await game.settle();
    expect(game.cardName()).toBe("Gate");

    await game.click("prt_hm_enter");
    expect(game.cardName()).toBe("Hall");
    expect(game.sounds.map((sound) => sound.voice)).toContain("harpsichord");

    await game.click("prt_hm_cellar_door");
    expect(game.cardName()).toBe("Hall"); // locked
    await game.click("prt_hm_front_door");
    expect(game.cardName()).toBe("Hall"); // no amulet yet

    await game.click("prt_hm_to_library");
    await game.click("prt_hm_take_key");
    expect(game.field("Inventory")).toContain("Brass Key");
    expect(game.part("prt_hm_take_key").visible).toBe(false);
    await game.click("prt_hm_library_back");

    await game.click("prt_hm_take_candle");
    await game.click("prt_hm_cellar_door");
    expect(game.cardName()).toBe("Cellar");
    await game.click("prt_hm_open_coffin");
    expect(game.field("Inventory")).toContain("Silver Amulet");
    await game.click("prt_hm_climb_stairs");
    await game.click("prt_hm_front_door");
    expect(game.cardName()).toBe("Dawn");

    expect(game.errors).toEqual([]);
    // sharedText: false — the Gate card still shows the inventory it had when it was left.
    expect(game.field("Inventory", "crd_hm_gate")).toBe("(empty pockets)");
    expect(game.field("Inventory", "crd_hm_dawn")).toContain("Candle");
    expect(game.field("Title", "crd_hm_dawn")).toBe("Dawn");

    await game.click("prt_hm_play_again");
    expect(game.cardName()).toBe("Gate");
    await game.click("prt_hm_enter");
    await game.click("prt_hm_to_library");
    expect(game.part("prt_hm_take_key").visible).toBe(true); // a new game puts the key back
    expect(game.errors).toEqual([]);
  });
});

describe("HexSynth Sequencer", () => {
  it("keys play their note with the selected voice", async () => {
    const synth = play(findShowcase("retroSynthDeck")!.create());
    await synth.post({ name: "mouseDown", params: [], targetId: "prt_hs_key_c4" });
    await synth.post({ name: "mouseDown", params: [], targetId: "prt_hs_key_fs4" });
    expect(synth.sounds).toEqual([{ voice: "harpsichord", notes: "c4q" }, { voice: "harpsichord", notes: "f#4q" }]);

    synth.store.applyRuntime({ type: "setPartProperty", partId: "prt_hs_voice_1", property: "hilite", value: false });
    synth.store.applyRuntime({ type: "setPartProperty", partId: "prt_hs_voice_3", property: "hilite", value: true });
    await synth.post({ name: "mouseDown", params: [], targetId: "prt_hs_key_c5" });
    expect(synth.sounds.at(-1)).toEqual({ voice: "flute", notes: "c5q" });
    expect(synth.errors).toEqual([]);
  });

  it("idle plays one step per message and moves the playhead", async () => {
    const synth = play(findShowcase("retroSynthDeck")!.create());
    await synth.click("prt_hs_nav_sequencer");
    expect(synth.cardName()).toBe("Sequencer");
    await synth.click("prt_hs_play");
    const idle = (): Promise<void> => synth.post({ name: "idle", params: [], targetId: synth.store.getSnapshot().currentCardId });

    await idle(); // step 1: lead, bass and drum are on
    expect(synth.sounds).toEqual([
      { voice: "harpsichord", notes: `${LEAD_NOTES[0]}e` },
      { voice: "square8bit", notes: "c3e" },
      { voice: "click", notes: "c4s" },
    ]);
    expect(synth.part("prt_hs_playhead").rect.x).toBe(106);

    await idle(); // step 2: lead only
    expect(synth.sounds.slice(3)).toEqual([{ voice: "harpsichord", notes: `${LEAD_NOTES[1]}e` }]);
    expect(synth.part("prt_hs_playhead").rect.x).toBe(130);

    await synth.click("prt_hs_stop");
    await idle();
    expect(synth.sounds).toHaveLength(4);

    await synth.click("prt_hs_clear");
    const steps = synth.store.getSnapshot().stack.cards[1].parts.filter((part): part is HexButtonPart => part.type === "button" && part.style === "checkBox");
    expect(steps).toHaveLength(48);
    expect(steps.every((step) => !step.hilite)).toBe(true);
    expect(synth.errors).toEqual([]);
  });
});

describe("HexOracle 1987", () => {
  it("starts with Istanbul as the hilited default city", () => {
    expect(ORACLE_CITIES.map((city) => city.name)).toEqual(["Istanbul", "Berlin", "Tokyo", "Toronto"]);
    const oracleCard = findShowcase("apiWeatherOracle")!.create().cards.find((card) => card.name === "Oracle")!;
    const hilited = oracleCard.parts.filter((part): part is HexButtonPart => part.type === "button" && part.style === "radioButton" && part.hilite);
    expect(hilited.map((part) => part.id)).toEqual(["prt_mo_city_istanbul"]);
  });

  it("shows the bundled offline sample data when the API cannot be reached (Req 7.3)", async () => {
    const oracle = play(findShowcase("apiWeatherOracle")!.create(), async () => ({ ok: false, reason: "network error" }));
    await oracle.click("prt_mo_consult");
    const sample = ORACLE_CITIES[0].sample;
    expect(oracle.errors).toEqual([]);
    expect(oracle.fetched).toEqual([{ url: oracleUrl(ORACLE_CITIES[0]), path: undefined }]); // the rest are skipped
    expect(oracle.field("Temperature")).toBe(`Temp ${sample.temperature} C`);
    expect(oracle.field("Wind")).toBe(`Wind ${sample.wind} km/h`);
    expect(oracle.field("Range")).toBe(`High ${sample.high} Low ${sample.low}`);
    expect(oracle.field("Sky")).toBe(oracleSky(Number(sample.code)).sky);
    expect(oracle.field("Status").startsWith(`${OFFLINE_STATUS_PREFIX} (error: network error)`)).toBe(true);
  });

  it("shows live readings for the selected city from one request per Consult", async () => {
    // The shape of an Open-Meteo forecast response; the VM host caches it and applies each JSON path.
    const live = JSON.stringify({
      current: { temperature_2m: 3.5, wind_speed_10m: 30.1, weather_code: 95 },
      daily: { temperature_2m_max: [6.0], temperature_2m_min: [-1.2] },
    });
    const oracle = play(findShowcase("apiWeatherOracle")!.create(), async () => ({ ok: true, value: live }));
    const berlin = ORACLE_CITIES[1];
    oracle.store.applyRuntime({ type: "setPartProperty", partId: "prt_mo_city_istanbul", property: "hilite", value: false });
    oracle.store.applyRuntime({ type: "setPartProperty", partId: `prt_mo_city_${berlin.name.toLowerCase()}`, property: "hilite", value: true });
    await oracle.click("prt_mo_consult");
    expect(oracle.errors).toEqual([]);
    // Five JSON paths, one network request for the whole document.
    expect(oracle.fetched).toEqual([{ url: oracleUrl(berlin), path: undefined }]);
    expect(oracleUrl(berlin).startsWith("https://api.open-meteo.com/")).toBe(true);
    expect(oracle.field("Temperature")).toBe("Temp 3.5 C");
    expect(oracle.field("Wind")).toBe("Wind 30.1 km/h");
    expect(oracle.field("Sky")).toBe("Thunderstorm");
    expect(oracle.field("Range")).toBe("High 6 Low -1.2");
    expect(oracle.field("Status").startsWith("Live from Open-Meteo for Berlin")).toBe(true);
  });

  it("lists the offline samples on the Almanac card", () => {
    const stack = findShowcase("apiWeatherOracle")!.create();
    const almanac = stack.cards.find((card) => card.name === "Almanac")!;
    const text = almanac.parts.map((part) => (part.type === "field" ? part.content : "")).join("\n");
    for (const city of ORACLE_CITIES) expect(text).toContain(`${city.name}: ${city.sample.temperature} C`);
  });
});
