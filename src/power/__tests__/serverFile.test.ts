/// <reference types="node" />
// The committed server file (spec 07 Requirements 3.2 to 3.6, 2.5, 14.5; design §Build script,
// §Testing Strategy): staleness, reproducible builds, and what the file may import and reference.

import { builtinModules } from "node:module";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { parseAst } from "vite";
import { beforeAll, describe, expect, it } from "vitest";
import { tableFontFiles } from "../../engine/graphics/textRaster.ts";
import { BUILD_POWER_COMMAND, SERVER_FILE_PATH, buildPowerServer, type PowerBuild } from "../../../scripts/buildPowerServer.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");

/** Requirement 3.2: modules the server file must not import (also without `node:` and as a sub-path). */
const FORBIDDEN_MODULES = [
  "fs", "fs/promises", "net", "http", "https", "http2", "tls", "dgram", "dns", "child_process",
  "worker_threads", "cluster", "vm", "inspector", "module",
];
/** Requirement 3.3: network globals. */
const NETWORK_GLOBALS = new Set(["fetch", "WebSocket", "EventSource", "XMLHttpRequest"]);
const GLOBAL_OBJECTS = new Set(["globalThis", "global", "self", "window"]);

type AstNode = { type: string; [key: string]: unknown };
const isNode = (value: unknown): value is AstNode =>
  typeof value === "object" && value !== null && typeof (value as { type?: unknown }).type === "string";

/** Calls `visit(node, parent, key)` for every node of the tree. */
function walk(node: AstNode, visit: (node: AstNode, parent: AstNode | null, key: string) => void, parent: AstNode | null = null, key = ""): void {
  visit(node, parent, key);
  for (const [childKey, value] of Object.entries(node)) {
    if (Array.isArray(value)) {
      for (const item of value) if (isNode(item)) walk(item, visit, node, childKey);
    } else if (isNode(value)) {
      walk(value, visit, node, childKey);
    }
  }
}

/** The name a member expression reads, for `a.b` and `a["b"]`. */
function memberName(member: AstNode): string | undefined {
  const property = member.property as AstNode;
  if (!member.computed && property.type === "Identifier") return property.name as string;
  if (member.computed && property.type === "Literal" && typeof property.value === "string") return property.value;
  return undefined;
}

/** True when an Identifier at (parent, key) names a variable rather than a property or label. */
function isReference(parent: AstNode | null, key: string): boolean {
  if (parent === null) return true;
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return false;
  if ((parent.type === "Property" || parent.type === "MethodDefinition" || parent.type === "PropertyDefinition") && key === "key" && !parent.computed) return false;
  if (parent.type.endsWith("Specifier") || parent.type.startsWith("Labeled") || parent.type === "BreakStatement" || parent.type === "ContinueStatement") return false;
  return true;
}

interface Findings {
  importSources: string[];
  dynamicImports: number;
  references: string[];
  globalReads: string[];
  processReads: string[];
}

function inspect(code: string): Findings {
  const findings: Findings = { importSources: [], dynamicImports: 0, references: [], globalReads: [], processReads: [] };
  walk(parseAst(code) as unknown as AstNode, (node, parent, key) => {
    if (node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || (node.type === "ExportNamedDeclaration" && node.source)) {
      findings.importSources.push((node.source as AstNode).value as string);
    } else if (node.type === "ImportExpression") {
      findings.dynamicImports += 1;
    } else if (node.type === "Identifier" && isReference(parent, key)) {
      const name = node.name as string;
      if (NETWORK_GLOBALS.has(name) || name === "require") findings.references.push(name);
    } else if (node.type === "MemberExpression" && (node.object as AstNode).type === "Identifier") {
      const object = (node.object as AstNode).name as string;
      const name = memberName(node);
      if (name === undefined) return;
      if (GLOBAL_OBJECTS.has(object) && (NETWORK_GLOBALS.has(name) || name === "require")) findings.globalReads.push(`${object}.${name}`);
      if (object === "process" && (name === "env" || name === "getBuiltinModule")) findings.processReads.push(`process.${name}`);
    }
  });
  return findings;
}

describe("the committed server file", () => {
  let power: PowerBuild;
  let committed: string | null;
  let mtimeBefore: number | undefined;

  beforeAll(async () => {
    mtimeBefore = existsSync(SERVER_FILE_PATH) ? statSync(SERVER_FILE_PATH).mtimeMs : undefined;
    power = await buildPowerServer();
    committed = existsSync(SERVER_FILE_PATH) ? readFileSync(SERVER_FILE_PATH, "utf8") : null;
  }, 60_000);

  it("is exactly what the build script produces from the working tree (Requirement 3.5)", () => {
    expect(BUILD_POWER_COMMAND).toBe("npm run build:power");
    if (committed === null) expect.fail(`powers/hexcard/server/hexcard-mcp.mjs is missing; run ${BUILD_POWER_COMMAND}`);
    if (committed !== power.serverFile) {
      expect.fail(`powers/hexcard/server/hexcard-mcp.mjs is out of date with the sources; run ${BUILD_POWER_COMMAND}`);
    }
    // The check never writes the committed file.
    expect(statSync(SERVER_FILE_PATH).mtimeMs).toBe(mtimeBefore);
  });

  it("is run by the build:power script, and npm run build neither builds nor copies it (Requirement 3.6)", () => {
    const scripts = (JSON.parse(readFileSync(`${REPO_ROOT}/package.json`, "utf8")) as { scripts: Record<string, string> }).scripts;
    expect(scripts["build:power"]).toContain("./scripts/buildPowerServer.ts");
    expect(scripts["build:power"]).toContain("runnerImport");
    for (const name of ["build", "build:player"]) {
      expect(scripts[name]).not.toMatch(/build:power|buildPowerServer|powers\//);
    }
  });

  it("builds byte-identically in another time zone and holds no local path or file URL (Requirement 3.4)", async () => {
    const saved = process.env.TZ;
    process.env.TZ = saved === "Pacific/Chatham" ? "America/St_Johns" : "Pacific/Chatham";
    let second: PowerBuild;
    try {
      second = await buildPowerServer();
    } finally {
      if (saved === undefined) delete process.env.TZ;
      else process.env.TZ = saved;
    }
    expect(second.serverFile === power.serverFile).toBe(true);
    expect(power.serverFile.includes(REPO_ROOT)).toBe(false);
    expect(power.serverFile.includes(homedir())).toBe(false);
    expect(power.serverFile.includes("file://")).toBe(false);
    expect(power.serverFile.startsWith("// GENERATED by scripts/buildPowerServer.ts")).toBe(true);
  }, 60_000);

  it("imports only allowed node: built-ins and loads modules in no other way (Requirements 3.2, 3.3)", () => {
    const findings = inspect(power.serverFile);
    expect(findings.importSources.length).toBeGreaterThan(0);
    for (const source of findings.importSources) {
      expect(source.startsWith("node:"), source).toBe(true);
      const bare = source.slice("node:".length);
      expect(builtinModules, source).toContain(bare);
      for (const forbidden of FORBIDDEN_MODULES) {
        expect(bare === forbidden || bare.startsWith(`${forbidden}/`), source).toBe(false);
      }
    }
    expect(findings.dynamicImports).toBe(0);
  });

  it("references no network global, require, process.getBuiltinModule or process.env (Requirements 2.5, 3.2, 3.3)", () => {
    const findings = inspect(power.serverFile);
    expect(findings.references).toEqual([]);
    expect(findings.globalReads).toEqual([]);
    expect(findings.processReads).toEqual([]);
  });

  it("the inspection finds each forbidden form in a sample", () => {
    const findings = inspect(
      [
        'import fs from "node:fs";',
        'export * from "node:dns/promises";',
        "fetch('x'); const r = require('y'); globalThis.WebSocket; self['XMLHttpRequest'];",
        "process.env.HOME; process.getBuiltinModule('fs'); import('z');",
        "const o = { fetch: 1 }; o.fetch; const fetchJson = 2;",
      ].join("\n"),
    );
    expect(findings.importSources).toEqual(["node:fs", "node:dns/promises"]);
    expect(findings.references).toEqual(["fetch", "require"]);
    expect(findings.globalReads).toEqual(["globalThis.WebSocket", "self.XMLHttpRequest"]);
    expect(findings.processReads).toEqual(["process.env", "process.getBuiltinModule"]);
    expect(findings.dynamicImports).toBe(1);
  });

  it("bundles no react module (Requirement 14.5)", () => {
    expect(power.bundledPackages).not.toContain("react");
    expect(power.bundledPackages).not.toContain("react-dom");
    expect(power.bundledPackages).toEqual(["zod"]);
  });

  it("carries the exact bytes of every font file of the size table as a base64 data: URL (Requirement 3.1)", () => {
    const files = tableFontFiles();
    expect(files).toHaveLength(9);
    for (const file of files) {
      const base64 = readFileSync(`${REPO_ROOT}/public/fonts/${file}`).toString("base64");
      expect(power.serverFile.includes(`"data:font/ttf;base64,${base64}"`), file).toBe(true);
      expect(power.serverFile.split(base64).length - 1, `${file} appears once`).toBe(1);
    }
    // No second copy of any font in another form: the file names are not read at run time.
    expect(power.serverFile).not.toMatch(/import\.meta\.glob/);
  });
  it("imports node:zlib for the PNG encoder and nothing beyond node:url, node:path and node:zlib (Requirements 2.4, 3.2)", () => {
    expect(inspect(power.serverFile).importSources.sort()).toEqual(["node:path", "node:url", "node:zlib"]);
  });
});
