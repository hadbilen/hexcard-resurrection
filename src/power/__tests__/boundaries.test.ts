/// <reference types="node" />
// Module boundaries of spec 07 (Requirements 14.4, 14.5; design D2): the studio and the player
// never reach a src/power/ module, and src/core/ and src/engine/ never import React.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("../../", import.meta.url));
const rel = (path: string): string => relative(SRC, path).split("\\").join("/");

/** Every module specifier of `import ... from`, `export ... from`, `import "..."` and `import("...")`. */
function specifiersOf(code: string): string[] {
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\bfrom\s*)?["']([^"']+)["']/g)) found.push(match[1]);
  for (const match of code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]);
  return found;
}

/** The file a relative specifier names, or undefined (packages, virtual modules, missing files). */
function resolveRelative(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier.replace(/\?.*$/, ""));
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

/** Every file reachable from `entry` through relative imports. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.tsx?$/.test(file)) continue;
    for (const specifier of specifiersOf(readFileSync(file, "utf8"))) {
      const target = resolveRelative(file, specifier);
      if (target !== undefined && !seen.has(target)) queue.push(target);
    }
  }
  return seen;
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name)) files.push(path);
  }
  return files;
}

describe("module boundaries", () => {
  it("finds the specifiers of every import form", () => {
    expect(
      specifiersOf('import a from "./a.ts";\nimport type { B } from "./b";\nexport { c } from "../c.ts";\nimport "./d.ts";\nconst e = await import("./e.ts");\nimport {\n  f,\n} from "f";'),
    ).toEqual(["./a.ts", "./b", "../c.ts", "./d.ts", "f", "./e.ts"]);
  });

  for (const entry of ["main.tsx", "player/main.ts"]) {
    it(`reaches no src/power/ module from src/${entry} (Requirement 14.4)`, () => {
      const files = [...reachable(join(SRC, entry))].map(rel);
      // The walk follows the real graph: the stack store and the text rasterizer are reached.
      expect(files).toContain("core/store.ts");
      expect(files).toContain("engine/graphics/textRaster.ts");
      expect(files.filter((file) => file.startsWith("power/"))).toEqual([]);
    });
  }

  it("imports react or react-dom in no src/core/ or src/engine/ module (Requirement 14.5)", () => {
    const offenders: string[] = [];
    for (const file of [...sourceFiles(join(SRC, "core")), ...sourceFiles(join(SRC, "engine"))]) {
      const imports = specifiersOf(readFileSync(file, "utf8"));
      if (imports.some((specifier) => /^react(?:-dom)?(?:\/|$)/.test(specifier))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });
});
