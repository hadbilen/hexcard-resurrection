/// <reference types="node" />
// The power package (spec 07 Requirements 1.1 to 1.7, 2.1 to 2.3; design §Power package, §Licence
// files): plugin.json, mcp.json, the folder entries and the licence texts.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { POWER_DIR, SERVER_FILE_ARG, buildPowerServer, packagesOf, type PowerBuild } from "../../../scripts/buildPowerServer.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const readRepo = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");
const readPower = (path: string): string => readFileSync(join(POWER_DIR, path), "utf8");
const pluginText = readPower("plugin.json");
const mcpText = readPower("mcp.json");
const plugin = JSON.parse(pluginText) as Record<string, unknown>;
const mcp = JSON.parse(mcpText) as Record<string, unknown>;

/** Every entry below `dir`, folders included, as paths relative to POWER_DIR. */
function walk(dir: string): string[] {
  const entries: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    entries.push(relative(POWER_DIR, path));
    const stat = lstatSync(path);
    if (stat.isDirectory()) entries.push(...walk(path));
  }
  return entries;
}

/** The text inside the fenced block under `heading` (test-side reading of LICENSES.md). */
function fontLicenceBlock(heading: string): string {
  const lines = readRepo("public/fonts/LICENSES.md").split("\n");
  const start = lines.indexOf(heading);
  expect(start).toBeGreaterThanOrEqual(0);
  const open = lines.findIndex((line, i) => i > start && line.startsWith("```"));
  const close = lines.findIndex((line, i) => i > open && line.startsWith("```"));
  return lines.slice(open + 1, close).join("\n");
}

/** The files of the power folder, as text. */
function powerFileTexts(): string[] {
  return walk(POWER_DIR)
    .filter((path) => lstatSync(join(POWER_DIR, path)).isFile())
    .map((path) => readPower(path));
}

describe("power folder layout (Requirements 1.1, 1.6)", () => {
  it("has plugin.json and mcp.json at its root and no POWER.md anywhere", () => {
    expect(lstatSync(join(POWER_DIR, "plugin.json")).isFile()).toBe(true);
    expect(lstatSync(join(POWER_DIR, "mcp.json")).isFile()).toBe(true);
    const names = walk(POWER_DIR).map((path) => path.split("/").at(-1)!.toLowerCase());
    expect(names).not.toContain("power.md");
  });

  it("holds only regular files and folders, no symbolic link", () => {
    const entries = walk(POWER_DIR);
    expect(entries.length).toBeGreaterThan(0);
    for (const path of entries) {
      const stat = lstatSync(join(POWER_DIR, path));
      expect(stat.isSymbolicLink(), path).toBe(false);
      expect(stat.isFile() || stat.isDirectory(), path).toBe(true);
    }
  });

  it("has no file that the repository's .gitignore patterns match", () => {
    const files = walk(POWER_DIR).map((path) => join("powers", "hexcard", path));
    const check = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], { cwd: REPO_ROOT, input: files.join("\n"), encoding: "utf8" });
    // Status 1: no path is ignored; 0: some are (listed on stdout); 128: git failed.
    expect(check.stdout).toBe("");
    expect(check.status).toBe(1);
  });
});

describe("plugin.json (Requirements 1.2 to 1.5)", () => {
  it("has exactly the allowed fields with their fixed values", () => {
    expect(Object.keys(plugin).sort()).toEqual(
      ["$schema", "author", "description", "keywords", "license", "name", "repository", "version"].sort(),
    );
    expect(plugin.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    expect(plugin.name).toBe("hexcard");
    expect(plugin.repository).toBe("https://github.com/hadbilen/hexcard-resurrection");
    expect(plugin.license).toBe("MIT");
  });

  it("names the copyright holder of LICENSE as its only author field", () => {
    const holder = /^Copyright \(c\) \d{4} (.+)$/m.exec(readRepo("LICENSE"))?.[1];
    expect(holder).toBeDefined();
    expect(plugin.author).toEqual({ name: holder });
  });

  it("keeps version equal to package.json's version", () => {
    const pkg = JSON.parse(readRepo("package.json")) as { version: string };
    expect(typeof plugin.version).toBe("string");
    expect(plugin.version).toBe(pkg.version);
  });

  it("has exactly the four keywords", () => {
    const keywords = plugin.keywords as string[];
    expect(Array.isArray(keywords)).toBe(true);
    expect([...keywords].sort()).toEqual(["hexcard", "hexstack", "hextalk", "hypercard"]);
  });

  it("has a one-sentence printable ASCII description with the required words", () => {
    const description = plugin.description as string;
    expect(typeof description).toBe("string");
    expect(description.length).toBeLessThanOrEqual(200);
    expect(description).toMatch(/^[\x20-\x7e]+$/);
    expect(description.endsWith(".")).toBe(true);
    expect(description.slice(0, -1)).not.toMatch(/[.!?] /);
    const lower = description.toLowerCase();
    for (const word of ["validates", "compiles", "conjures", "draws", "previews"]) expect(lower).toMatch(new RegExp(`\\b${word}\\b`));
    expect(lower).toContain("hexcard stacks");
    expect(lower).toContain("node.js 22.13 or later, except 23.0 to 23.4");
  });
});

describe("mcp.json (Requirements 2.1 to 2.3)", () => {
  it("declares exactly one stdio server named hexcard with the same schema version as plugin.json", () => {
    expect(Object.keys(mcp).sort()).toEqual(["$schema", "mcpServers"]);
    expect(mcp.$schema).toBe("https://agent-plugins.org/schemas/1.0.0/mcp.schema.json");
    expect(String(mcp.$schema).split("/")[4]).toBe(String(plugin.$schema).split("/")[4]);
    const servers = mcp.mcpServers as Record<string, Record<string, unknown>>;
    expect(Object.keys(servers)).toEqual(["hexcard"]);
    expect(Object.keys(servers.hexcard).sort()).toEqual(["args", "command", "type"]);
    expect(servers.hexcard.type).toBe("stdio");
  });

  it("starts the bare command node with the four permission args and no cwd or env", () => {
    const server = (mcp.mcpServers as Record<string, Record<string, unknown>>).hexcard;
    expect(server.command).toBe("node");
    expect(server).not.toHaveProperty("cwd");
    expect(server).not.toHaveProperty("env");
    expect(server.args).toEqual([
      "--permission",
      `--allow-fs-read=${SERVER_FILE_ARG}`,
      "--disallow-code-generation-from-strings",
      SERVER_FILE_ARG,
    ]);
    expect(SERVER_FILE_ARG).toBe("${PLUGIN_ROOT}/server/hexcard-mcp.mjs");
  });

  it("has ${PLUGIN_ROOT} as its only ${...} text", () => {
    const placeholders = mcpText.match(/\$\{[^}]*\}/g) ?? [];
    expect(placeholders.length).toBeGreaterThan(0);
    expect(new Set(placeholders)).toEqual(new Set(["${PLUGIN_ROOT}"]));
  });

  it("names a server file that exists in the power folder", () => {
    const path = join(POWER_DIR, ...SERVER_FILE_ARG.slice("${PLUGIN_ROOT}/".length).split("/"));
    expect(lstatSync(path).isFile()).toBe(true);
  });
});

describe("licence files (Requirement 1.7)", () => {
  let power: PowerBuild;
  beforeAll(async () => {
    power = await buildPowerServer();
  }, 60_000);

  it("holds the repository's LICENSE unchanged", () => {
    expect(readPower("LICENSE")).toBe(readRepo("LICENSE"));
  });

  it("holds the licence notice of every bundled package", () => {
    expect(power.bundledPackages).toContain("zod");
    const texts = powerFileTexts();
    for (const name of power.bundledPackages) {
      const notice = readRepo(`node_modules/${name}/LICENSE`);
      expect(texts.some((text) => text.includes(notice)), name).toBe(true);
    }
  });

  it("holds the CC0 and OFL texts of public/fonts/LICENSES.md", () => {
    const texts = powerFileTexts();
    for (const heading of ["## Pixel Operator: Creative Commons Zero 1.0 Universal", "## Fairfax Serif: SIL Open Font License 1.1"]) {
      const block = fontLicenceBlock(heading);
      expect(block.length).toBeGreaterThan(100);
      expect(texts.some((text) => text.includes(block)), heading).toBe(true);
    }
    expect(fontLicenceBlock("## Fairfax Serif: SIL Open Font License 1.1")).toContain("Kreative Software");
  });

  it("matches the licence files the build script writes", () => {
    for (const [path, text] of Object.entries(power.licenceFiles)) expect(readPower(path), `${path}: run npm run build:power`).toBe(text);
  });

  it("derives bundled packages from node_modules segments of module ids", () => {
    expect(
      packagesOf([
        "/repo/src/core/parser.ts",
        "/repo/node_modules/zod/v4/core/util.js",
        "/repo/node_modules/@scope/pkg/index.js",
        "/repo/node_modules/a/node_modules/react/index.js",
        "\0vite/preload-helper",
      ]),
    ).toEqual(["@scope/pkg", "react", "zod"]);
  });
});

/**
 * The YAML front matter of a SKILL.md: `key: value` lines between the opening and closing `---`.
 * A double-quoted value is read as a JSON string (the skills use no YAML escapes beyond JSON's).
 */
function skillFrontMatter(skill: string): Record<string, string> {
  const text = readPower(`skills/${skill}/SKILL.md`);
  expect(text.startsWith("---\n"), `${skill}: SKILL.md must start with front matter`).toBe(true);
  const end = text.indexOf("\n---\n", 4);
  expect(end).toBeGreaterThan(0);
  const fields: Record<string, string> = {};
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([a-z-]+): (.+)$/.exec(line);
    expect(match, `${skill}: front matter line "${line}"`).not.toBeNull();
    const value = match![2];
    fields[match![1]] = value.startsWith('"') ? (JSON.parse(value) as string) : value;
  }
  return fields;
}

describe("skill front matter (Requirement 12.1)", () => {
  it("author-hexcard-stack has only a name equal to its folder and a description of the required words", () => {
    const fields = skillFrontMatter("author-hexcard-stack");
    expect(Object.keys(fields)).toEqual(["name", "description"]);
    expect(fields.name).toBe("author-hexcard-stack");
    expect(fields.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(fields.name.length).toBeLessThanOrEqual(64);
    const description = fields.description;
    expect(description.length).toBeGreaterThanOrEqual(1);
    expect(description.length).toBeLessThanOrEqual(1024);
    expect(description).toContain("HexCard");
    for (const activity of ["build", "check", "draw", "preview", "fix"]) expect(description).toMatch(new RegExp(`\\b${activity}`, "i"));
    for (const object of [".hexstack file", "cards", "backgrounds", "buttons", "fields", "pictures"]) expect(description).toContain(object);
  });
});
