/**
 * Showcase stack "HexOracle 1987" (spec 04 task 8, design.md §7; design spec §9): a live weather
 * dashboard built on HexTalk `fetch`, with bundled offline sample data (Requirement 7.3).
 *
 * - Data source: Open-Meteo (https://open-meteo.com), key-free and CORS-enabled. Every request is
 *   a plain https GET made by the sandboxed `fetch` of design spec §4.3 (no credentials, no
 *   headers, 8 s timeout, 256 KB cap, JSON only); values are picked with JSON paths such as
 *   `current.temperature_2m` and `daily.temperature_2m_max[0]`. The five `fetch` statements share
 *   one URL, so the VM host's 60 s fetch cache (src/ui/vmHost.ts) sends at most one request per Consult.
 * - Offline fallback: the Consult button first puts the city's bundled sample reading into its
 *   variables, then fetches into the same variables. A failed `fetch` leaves its destination
 *   unchanged and sets `it` to "error: <reason>", so the sample reading stays and the status
 *   line says it is offline. After a failed first request the others are skipped.
 * - The "Almanac" card lists the same bundled samples; both are generated from `ORACLE_CITIES`.
 *
 * Art: canonical rleData drawn by scripts/buildPresetArt.ts (src/presets/presetArt.ts).
 */
import type { HexStack } from "../core/schema.ts";
import { PRESET_ART } from "./presetArt.ts";
import { background, button, card, field, hexTalk, rect, stack } from "./presetKit.ts";

export const WEATHER_ORACLE_NAME = "HexOracle 1987";

export const OPEN_METEO_FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

export interface OracleReading {
  temperature: string;
  wind: string;
  code: string;
  high: string;
  low: string;
}

/** Cities of the radio-button family; the first is selected. `sample` is the bundled offline reading. */
export const ORACLE_CITIES: readonly { name: string; latitude: number; longitude: number; sample: OracleReading }[] = [
  { name: "Istanbul", latitude: 41.01, longitude: 28.98, sample: { temperature: "15.2", wind: "21.3", code: "80", high: "17.4", low: "12.1" } },
  { name: "Berlin", latitude: 52.52, longitude: 13.41, sample: { temperature: "8.6", wind: "17.5", code: "61", high: "10.2", low: "5.9" } },
  { name: "Tokyo", latitude: 35.69, longitude: 139.69, sample: { temperature: "17.9", wind: "9.4", code: "3", high: "20.6", low: "14.3" } },
  { name: "Toronto", latitude: 43.65, longitude: -79.38, sample: { temperature: "11.3", wind: "14.8", code: "1", high: "14.0", low: "6.7" } },
];

/** WMO weather code ranges (inclusive) with the sky and the oracle's prophecy. */
export const ORACLE_SKIES: readonly { min: number; max: number; sky: string; prophecy: string }[] = [
  { min: 0, max: 0, sky: "Clear sky", prophecy: "The stars align. A fine day to ship a stack." },
  { min: 1, max: 3, sky: "Some clouds", prophecy: "Clouds drift like dialog boxes. Click OK and carry on." },
  { min: 45, max: 48, sky: "Fog", prophecy: "The mists hide your path. Trust the message path instead." },
  { min: 51, max: 57, sky: "Drizzle", prophecy: "A gentle drizzle. Your scripts will run, slowly but surely." },
  { min: 61, max: 67, sky: "Rain", prophecy: "Rain falls in 1-bit drops. Stay in and build a stack." },
  { min: 71, max: 77, sky: "Snow", prophecy: "Snow, white as an empty card. Draw something on it." },
  { min: 80, max: 82, sky: "Rain showers", prophecy: "Showers come and go, like an idle message." },
  { min: 85, max: 86, sky: "Snow showers", prophecy: "Flurries dissolve the world, pixel by pixel." },
  { min: 95, max: 99, sky: "Thunderstorm", prophecy: "Thunder! Save your stack. The oracle has spoken." },
];

export const UNKNOWN_SKY = { sky: "Mysterious skies", prophecy: "The oracle sees only static. Ask again later." } as const;

/** The sky entry for a WMO code (what the Consult button's script computes). */
export function oracleSky(code: number): { sky: string; prophecy: string } {
  return ORACLE_SKIES.find((entry) => code >= entry.min && code <= entry.max) ?? UNKNOWN_SKY;
}

const coordinate = (value: number): string => String(value);

const QUERY = "&current=temperature_2m,wind_speed_10m,weather_code&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1";

/** The request URL the script builds for `city`. */
export function oracleUrl(city: (typeof ORACLE_CITIES)[number]): string {
  return `${OPEN_METEO_FORECAST_URL}?latitude=${coordinate(city.latitude)}&longitude=${coordinate(city.longitude)}${QUERY}`;
}

/** Shown in the Status field after an offline reading; the script appends the reason and the city. */
export const OFFLINE_STATUS_PREFIX = "Offline";

function consultScript(): string {
  const [first, ...others] = ORACLE_CITIES;
  const choose = (city: (typeof ORACLE_CITIES)[number], indent: string): string[] => [
    `${indent}put "${city.name}" into city`,
    `${indent}put "latitude=${coordinate(city.latitude)}&longitude=${coordinate(city.longitude)}" into place`,
    `${indent}put "${city.sample.temperature}" into temp`,
    `${indent}put "${city.sample.wind}" into wind`,
    `${indent}put "${city.sample.code}" into code`,
    `${indent}put "${city.sample.high}" into high`,
    `${indent}put "${city.sample.low}" into low`,
  ];
  const later = (path: string, variable: string): string[] => [
    `    fetch url at "${path}" into ${variable}`,
    '    if it contains "error:" then put it into problem',
  ];
  return hexTalk(
    "on mouseUp",
    '  put "The oracle gazes into the mists..." into card field "Status"',
    "  -- the bundled sample reading first: a failed fetch leaves its destination unchanged",
    ...choose(first, "  "),
    ...others.flatMap((city) => [
      `  if the hilite of card button "${city.name}" then`,
      ...choose(city, "    "),
      "  end if",
    ]),
    `  put "${OPEN_METEO_FORECAST_URL}?" & place & "${QUERY}" into url`,
    '  fetch url at "current.temperature_2m" into temp',
    '  if it contains "error:" then',
    `    put "${OFFLINE_STATUS_PREFIX} (" & it & "): bundled almanac reading for " & city & "." into source`,
    "  else",
    "    put empty into problem",
    ...later("current.wind_speed_10m", "wind"),
    ...later("current.weather_code", "code"),
    ...later("daily.temperature_2m_max[0]", "high"),
    ...later("daily.temperature_2m_min[0]", "low"),
    "    if problem is empty then",
    '      put "Live from Open-Meteo for " & city & " at " & the time & "." into source',
    "    else",
    '      put "Partly live for " & city & "; some values are from the almanac (" & problem & ")." into source',
    "    end if",
    "  end if",
    `  put "${UNKNOWN_SKY.sky}" into sky`,
    `  put "${UNKNOWN_SKY.prophecy}" into prophecy`,
    ...ORACLE_SKIES.flatMap((entry) => [
      entry.min === entry.max ? `  if code = ${entry.min} then` : `  if code >= ${entry.min} and code <= ${entry.max} then`,
      `    put "${entry.sky}" into sky`,
      `    put "${entry.prophecy}" into prophecy`,
      "  end if",
    ]),
    '  put "Temp " & temp & " C" into card field "Temperature"',
    '  put sky into card field "Sky"',
    '  put "Wind " & wind & " km/h" into card field "Wind"',
    '  put "High " & high & " Low " & low into card field "Range"',
    '  put prophecy into card field "Prophecy"',
    '  put source into card field "Status"',
    '  play flute tempo 90 "e5e g5e b5q"',
    "end mouseUp",
  );
}

/** The Almanac card's text: every bundled sample reading. */
export function almanacText(): string {
  const lines = ["Bundled offline almanac", "Used when the oracle cannot reach Open-Meteo.", ""];
  for (const { name, sample } of ORACLE_CITIES) {
    lines.push(`${name}: ${sample.temperature} C, ${oracleSky(Number(sample.code)).sky}`);
    lines.push(`  wind ${sample.wind} km/h, ${sample.low} to ${sample.high} C`);
  }
  return lines.join("\n");
}

const navScript = (cardName: string) => hexTalk(
  "on mouseUp",
  "  visual effect barn door open fast",
  `  go to card "${cardName}"`,
  "end mouseUp",
);

export function createWeatherOracleStack(): HexStack {
  const BG = "bkg_mo_oracle";
  const oracleBackground = background(BG, "Oracle", PRESET_ART.oracleBackground, [
    field("prt_mo_title", "background", "Title", rect(16, 6, 480, 28), {
      content: WEATHER_ORACLE_NAME, sharedText: true, textFont: "Serif", textSize: 18, textAlign: "center", textStyle: ["bold"],
    }),
    button("prt_mo_nav_oracle", "background", "Oracle", rect(16, 309, 84, 24), { scriptSource: navScript("Oracle") }),
    button("prt_mo_nav_almanac", "background", "Almanac", rect(108, 309, 84, 24), { scriptSource: navScript("Almanac") }),
  ]);

  const readout = (id: string, name: string, at: ReturnType<typeof rect>, content: string, options: Parameters<typeof field>[4] = {}) =>
    field(id, "card", name, at, { content, ...options });

  const oracle = card("crd_mo_oracle", "Oracle", BG, {
    parts: [
      ...ORACLE_CITIES.map((city, i) =>
        button(`prt_mo_city_${city.name.toLowerCase()}`, "card", city.name, rect(208, 46 + i * 20, 112, 18), {
          style: "radioButton", family: 1, hilite: i === 0,
        })),
      button("prt_mo_consult", "card", "Consult the Oracle", rect(332, 56, 156, 26), {
        style: "default", scriptSource: consultScript(),
      }),
      readout("prt_mo_temperature", "Temperature", rect(208, 132, 288, 28), "Temp ? C", { textFont: "Mono", textSize: 18 }),
      readout("prt_mo_sky", "Sky", rect(208, 164, 288, 20), "Skies unknown", { textFont: "System" }),
      readout("prt_mo_wind", "Wind", rect(208, 188, 140, 20), "Wind ? km/h"),
      readout("prt_mo_range", "Range", rect(352, 188, 144, 20), "High ? Low ?"),
      readout("prt_mo_prophecy", "Prophecy", rect(208, 214, 288, 80), "Choose a city and consult the oracle.", {
        textFont: "Serif", textSize: 14,
      }),
      readout("prt_mo_status", "Status", rect(200, 306, 296, 30), "Weather data: Open-Meteo.com (no key needed).", {
        style: "opaque", textSize: 9,
      }),
    ],
  });

  const almanac = card("crd_mo_almanac", "Almanac", BG, {
    parts: [readout("prt_mo_almanac", "Almanac", rect(208, 46, 288, 250), almanacText(), { style: "scrolling" })],
  });

  return stack({
    id: "stk_hexoracle",
    name: WEATHER_ORACLE_NAME,
    theme: "GreenPhosphor",
    backgrounds: [oracleBackground],
    cards: [oracle, almanac],
  });
}
