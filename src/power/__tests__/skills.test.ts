/// <reference types="node" />
// The skills of the power (spec 07 Requirements 10.4, 12.2 to 12.11, 17.4; design §Skills): every
// marked skill example run through the tools, and the reference files checked for drift against
// design spec §2.1, PATTERNS, TEXT_SIZE_TABLE and the cmaps of the bundled fonts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { BUTTON_TEXT } from "../../engine/graphics/partRenderer.ts";
import { PATTERNS } from "../../engine/graphics/patterns.ts";
import { TEXT_SIZE_TABLE, TEXT_SIZES, tableFontFiles, type FontFileName } from "../../engine/graphics/textRaster.ts";
import { coveredCodePoints, formatCodePoint } from "../nodeTextBackend.ts";
import { FONTS, makeCaller } from "./toolFixtures.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SKILLS_DIR = join(REPO_ROOT, "powers", "hexcard", "skills");
const AUTHOR_SKILL = join(SKILLS_DIR, "author-hexcard-stack");

const { call } = makeCaller();

// ---------------------------------------------------------------------------------------------
// Reading the skill files
// ---------------------------------------------------------------------------------------------

/** Every `.md` file below `dir`, as absolute paths in name order. */
function markdownFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...markdownFiles(path));
    else if (name.endsWith(".md")) files.push(path);
  }
  return files;
}

interface FencedBlock {
  info: string;
  body: string;
  /** 1-based line of the opening fence. */
  line: number;
}

/** The fenced code blocks of a Markdown text (CommonMark fences of ``` or ~~~, at most 3 spaces of indent). */
function fencedBlocks(text: string, where: string): FencedBlock[] {
  const lines = text.split("\n");
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (open === null) continue;
    const fence = open[1];
    const close = new RegExp(`^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
    const end = lines.findIndex((line, j) => j > i && close.test(line));
    if (end < 0) throw new Error(`${where}:${i + 1}: unclosed fenced block`);
    blocks.push({ info: open[2].trim(), body: lines.slice(i + 1, end).join("\n"), line: i + 1 });
    i = end;
  }
  return blocks;
}

interface SkillExample {
  kind: string;
  attributes: Record<string, string>;
  body: string;
  /** `<file relative to skills/>:<line>`, for failure messages. */
  where: string;
}

/** The marked examples of a fenced-block list: info string `<language> hexcard:<kind> [key=value ...]`. */
function examplesOf(blocks: readonly FencedBlock[], file: string): SkillExample[] {
  const examples: SkillExample[] = [];
  for (const block of blocks) {
    const words = block.info.split(/\s+/).filter((word) => word !== "");
    const where = `${file}:${block.line}`;
    const markerAt = words.findIndex((word) => word.startsWith("hexcard:"));
    if (markerAt < 0) continue;
    if (markerAt !== 1) throw new Error(`${where}: the hexcard: marker must follow the language word`);
    const attributes: Record<string, string> = {};
    for (const word of words.slice(2)) {
      const pair = /^([a-z-]+)=(\S+)$/.exec(word);
      if (pair === null) throw new Error(`${where}: "${word}" is not a key=value attribute`);
      attributes[pair[1]] = pair[2];
    }
    examples.push({ kind: words[1].slice("hexcard:".length), attributes, body: block.body, where });
  }
  return examples;
}

function skillExamples(skillDir: string): SkillExample[] {
  return markdownFiles(skillDir).flatMap((path) => {
    const file = relative(SKILLS_DIR, path);
    return examplesOf(fencedBlocks(readFileSync(path, "utf8"), file), file);
  });
}

const readSkill = (path: string): string => readFileSync(join(AUTHOR_SKILL, path), "utf8");
/** SKILL.md with every run of white space as one space, so wrapped sentences still match. */
const skillProse = (): string => readSkill("SKILL.md").replace(/\s+/g, " ");

describe("skill example reader", () => {
  it("finds marked blocks of both fence kinds and skips unmarked ones", () => {
    const text = ["```json hexcard:stack", "{}", "```", "~~~text", "```json hexcard:draw id=x", "~~~", "```json hexcard:draw id=a", "[]", "````"].join("\n");
    const examples = examplesOf(fencedBlocks(text, "sample.md"), "sample.md");
    expect(examples.map((example) => [example.kind, example.attributes, example.body])).toEqual([
      ["stack", {}, "{}"],
      ["draw", { id: "a" }, "[]"],
    ]);
    expect(() => fencedBlocks("```json\n{}", "sample.md")).toThrow(/unclosed/);
  });
});

// ---------------------------------------------------------------------------------------------
// author-hexcard-stack: the examples (Requirements 12.2, 12.4, 12.6, 17.4)
// ---------------------------------------------------------------------------------------------

describe("author-hexcard-stack examples (Requirement 17.4)", () => {
  const examples = skillExamples(AUTHOR_SKILL);
  const stacks = examples.filter((example) => example.kind === "stack");
  const drawings = examples.filter((example) => example.kind === "draw");

  it("uses only the stack and drawing markers", () => {
    for (const example of examples) expect(["stack", "draw"], example.where).toContain(example.kind);
  });

  it("holds at least one stack example and one drawing example", () => {
    expect(stacks.length, "author-hexcard-stack holds no stack example").toBeGreaterThan(0);
    expect(drawings.length, "author-hexcard-stack holds no drawing example").toBeGreaterThan(0);
    expect(
      stacks.some((example) => example.attributes["rle-from"] !== undefined),
      "author-hexcard-stack holds no stack example with the rleData of a drawing example (Requirement 12.6)",
    ).toBe(true);
  });

  it("passes every stack example through validate_stack with ok true, no script error and no note", async () => {
    for (const example of stacks) {
      const result = await call("validate_stack", { stack: example.body });
      expect(result.isError, example.where).toBe(false);
      expect(result.json, example.where).toMatchObject({ ok: true, errors: [], scriptErrors: [], notes: [] });
    }
  });

  it("passes every drawing example through draw_layer with ok true, no note and no uncovered character", async () => {
    for (const example of drawings) {
      const result = await call("draw_layer", JSON.parse(example.body));
      expect(result.isError, example.where).toBe(false);
      expect(result.json, example.where).toMatchObject({ ok: true, notes: [], uncoveredCharacters: [] });
    }
  });

  it("holds the drawing's rleData in a layer of its layer kind for every rle-from stack example", async () => {
    const drawn = new Map<string, { layer: string; rleData: string }>();
    for (const example of drawings) {
      const id = example.attributes.id;
      expect(id, `${example.where}: a drawing example needs an id`).toBeDefined();
      expect(drawn.has(id), `${example.where}: the drawing id ${id} is used twice`).toBe(false);
      const args = JSON.parse(example.body) as { layer: string };
      const result = await call("draw_layer", args);
      drawn.set(id, { layer: args.layer, rleData: result.json.rleData as string });
    }
    for (const example of stacks) {
      const from = example.attributes["rle-from"];
      if (from === undefined) continue;
      const drawing = drawn.get(from);
      expect(drawing, `${example.where}: no drawing example has the id ${from}`).toBeDefined();
      const stack = JSON.parse(example.body) as { backgrounds: { bitmap: { rleData: string } }[]; cards: { bitmap: { rleData: string } }[] };
      const layers = (drawing!.layer === "background" ? stack.backgrounds : stack.cards).map((object) => object.bitmap.rleData);
      expect(layers, `${example.where}: no ${drawing!.layer} layer holds the rleData of ${from}`).toContain(drawing!.rleData);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// author-hexcard-stack: the reference files (Requirements 12.7, 12.9, 12.10)
// ---------------------------------------------------------------------------------------------

/** Lines of a text without the blank lines at its start and end, joined again. */
function trimBlankLines(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start].trim() === "") start++;
  while (end > start && lines[end - 1].trim() === "") end--;
  return lines.slice(start, end).join("\n");
}

/** Design spec §2.1: the lines after the `### 2.1.` heading up to the line before the `---` that ends section 2. */
function designSection21(): string {
  const lines = readFileSync(join(REPO_ROOT, "hexcard_design_spec.md"), "utf8").split("\n");
  const heading = lines.findIndex((line) => line.startsWith("### 2.1."));
  const rule = lines.findIndex((line, i) => i > heading && line === "---");
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(rule).toBeGreaterThan(heading);
  return trimBlankLines(lines.slice(heading + 1, rule));
}

/** The `## Pattern <n>` sections of references/patterns.md, as PATTERNS gives them. */
function expectedPatternSections(): string {
  return PATTERNS.map((pattern, index) => {
    const rows = [...pattern].map((byte) => [...byte.toString(2).padStart(8, "0")].map((bit) => (bit === "1" ? "#" : ".")).join(""));
    return `\n## Pattern ${index}\n\n\`\`\`text\n${rows.join("\n")}\n\`\`\`\n`;
  }).join("");
}

/** `U+XXXX` and `U+XXXX-U+YYYY` runs of ascending code points. */
function codePointRuns(codePoints: readonly number[]): string {
  const runs: string[] = [];
  for (let i = 0; i < codePoints.length; ) {
    let j = i;
    while (j + 1 < codePoints.length && codePoints[j + 1] === codePoints[j] + 1) j++;
    runs.push(i === j ? formatCodePoint(codePoints[i]) : `${formatCodePoint(codePoints[i])}-${formatCodePoint(codePoints[j])}`);
    i = j + 1;
  }
  return runs.join(", ");
}

/** The `## <file>` sections of references/fonts.md, as TEXT_SIZE_TABLE and the parsed cmaps give them. */
function expectedFontSections(): string {
  return tableFontFiles()
    .map((file: FontFileName) => {
      const groups: string[] = [];
      for (const font of ["System", "Sans", "Mono", "Serif"] as const) {
        for (const bold of [false, true]) {
          const sizes = TEXT_SIZES.filter((size) => {
            const entry = TEXT_SIZE_TABLE[font][size];
            return (bold && entry.boldFile !== undefined ? entry.boldFile : entry.file) === file;
          });
          if (sizes.length > 0) groups.push(`${font} ${bold ? "bold" : "regular"} ${sizes.join(", ")}`);
        }
      }
      const beyond = [...coveredCodePoints(FONTS, file)].filter((codePoint) => codePoint < 0x20 || codePoint > 0x7e).sort((a, b) => a - b);
      return `\n## ${file}\n\nSelected by: ${groups.join("; ")}\n\nCovered beyond printable ASCII: ${codePointRuns(beyond)}\n`;
    })
    .join("");
}

/** The text from the first `## ` heading to the end. */
const sectionsOf = (text: string): string => text.slice(text.indexOf("\n## "));

describe("author-hexcard-stack reference files", () => {
  it("references/schema.md holds design spec §2.1 verbatim after its source line (Requirement 12.10)", () => {
    const lines = readSkill("references/schema.md").split("\n");
    expect(lines[0]).toMatch(/^Source: `hexcard_design_spec\.md` §2\.1/);
    expect(lines[1]).toBe("");
    expect(trimBlankLines(lines.slice(1)), "references/schema.md differs from hexcard_design_spec.md §2.1").toBe(designSection21());
  });

  it("references/patterns.md lists PATTERNS by index with the alignment rule (Requirement 12.7)", () => {
    const text = readSkill("references/patterns.md");
    expect(PATTERNS).toHaveLength(38);
    expect(sectionsOf(text), "references/patterns.md differs from PATTERNS").toBe(expectedPatternSections());
    expect(text.replace(/\s+/g, " ")).toContain("the pixel at (x, y) takes the character at row `y mod 8`, column `x mod 8`");
  });

  it("references/fonts.md lists each font file's settings and covered characters (Requirement 12.9)", () => {
    const text = readSkill("references/fonts.md");
    expect(sectionsOf(text), "references/fonts.md differs from TEXT_SIZE_TABLE or the fonts' cmaps").toBe(expectedFontSections());
    expect(BUTTON_TEXT).toEqual({ font: "System", size: 12 });
    expect(text).toContain("Button titles always use `System regular 12`");
  });

  it("SKILL.md names each reference file", () => {
    const prose = skillProse();
    for (const file of ["references/schema.md", "references/patterns.md", "references/fonts.md"]) {
      expect(prose).toContain(`\`${file}\``);
      expect(statSync(join(AUTHOR_SKILL, file)).isFile()).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// author-hexcard-stack: required statements (Requirements 10.4, 12.9, 12.11)
// ---------------------------------------------------------------------------------------------

describe("author-hexcard-stack statements", () => {
  it("states the pixel-match limit of Requirement 10.4", () => {
    const prose = skillProse();
    expect(prose).toContain("matches the studio's card pixel for pixel only for covered characters");
    expect(prose).toContain("measured only in headless Chrome 157 on Linux");
    expect(prose).toContain("other browsers and operating systems were not checked");
  });

  it("states the Node.js requirement and the node --version check of Requirement 12.11", () => {
    const prose = skillProse();
    expect(prose).toContain("need Node.js 22.13 or later, except 23.0 to 23.4");
    expect(prose).toContain("`node --version`, run with the PATH that Kiro uses, must print `v22.13.0` or a later version");
    for (const minor of [0, 1, 2, 3, 4]) expect(prose).toContain(`\`v23.${minor}.\``);
  });

  it("recommends printable ASCII for all card text (Requirement 12.9)", () => {
    expect(skillProse()).toContain("Use printable ASCII (U+0020 to U+007E) for all text a card shows");
  });
});
