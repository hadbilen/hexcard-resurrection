import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The app is served from a sub-path on GitHub Pages (BASE_PATH=/hexcard-resurrection/), so every
// runtime asset URL must be built from import.meta.env.BASE_URL. A root-absolute font path would
// load from the site root and 404 there.

const SRC_DIR = fileURLToPath(new URL("../../../", import.meta.url));
const TEXT_FILE = /\.(ts|tsx|css|html|json|md)$/;

/** A fonts directory at the site root: the slash is not preceded by a path-segment character or a relative dot. */
const ROOT_FONTS_PATH = /(?<![\w.-])\/fonts\//;

function sourceFiles(): string[] {
  return readdirSync(SRC_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && TEXT_FILE.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("runtime asset URLs", () => {
  it("the root-absolute fonts pattern matches only paths that start at the site root", () => {
    const rootFonts = ["", "fonts", "PixelOperator.ttf"].join("/");
    expect(ROOT_FONTS_PATH.test(`"${rootFonts}"`)).toBe(true);
    expect(ROOT_FONTS_PATH.test(`url(${rootFonts})`)).toBe(true);
    expect(ROOT_FONTS_PATH.test(`"public${rootFonts}"`)).toBe(false);
    expect(ROOT_FONTS_PATH.test(`".${rootFonts}"`)).toBe(false);
    expect(ROOT_FONTS_PATH.test("`${import.meta.env.BASE_URL}fonts/`")).toBe(false);
  });

  it("no source file under src/ loads fonts from the site root", () => {
    const files = sourceFiles();
    expect(files.map((file) => relative(SRC_DIR, file))).toContain(join("engine", "graphics", "textRaster.ts"));
    const offenders = files
      .filter((file) => ROOT_FONTS_PATH.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_DIR, file));
    expect(offenders).toEqual([]);
  });
});
