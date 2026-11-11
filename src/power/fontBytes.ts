// The bundled font files as bytes (spec 07 Requirement 3.1; design §fontBytes.ts).
//
// Vite's `?inline` asset handling turns each file of public/fonts/ into a base64 `data:` URL, in
// Vitest and in the server file alike (the pattern src/player/main.ts uses), so the server carries
// the exact bytes of every font and never reads a file at run time.
import { tableFontFiles, type FontFileName } from "../engine/graphics/textRaster.ts";
import type { FontBytes } from "./nodeTextBackend.ts";

/** Every bundled font file as a base64 `data:` URL, keyed by its path relative to this module. */
const INLINED_FONTS = import.meta.glob<string>("../../public/fonts/*.ttf", { query: "?inline", import: "default", eager: true });

const BASE64_DATA_URL = /^data:[^,;]*;base64,/;

/** Every file tableFontFiles() names, as bytes. Throws if one is missing or not a base64 data: URL. */
export function bundledFontBytes(): FontBytes {
  const bytes: Partial<Record<FontFileName, Uint8Array>> = {};
  for (const file of tableFontFiles()) {
    const url = INLINED_FONTS[`../../public/fonts/${file}`];
    if (typeof url !== "string") throw new Error(`fontBytes: the font file ${file} is not bundled`);
    const prefix = BASE64_DATA_URL.exec(url);
    if (prefix === null) throw new Error(`fontBytes: the font file ${file} is not inlined as a base64 data: URL`);
    const binary = atob(url.slice(prefix[0].length));
    const data = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
    bytes[file] = data;
  }
  return bytes as FontBytes;
}
