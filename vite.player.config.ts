import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Player build (spec 04 design.md §6): `src/player/main.ts` as one minified IIFE,
 * `dist-player/player.js`. The studio embeds its text in exported standalone HTML files through
 * `virtual:hexcard-player` (vite.config.ts), so `npm run build` runs this build first.
 *
 * The bundle makes no requests of its own: no public directory, no code splitting, and the fonts
 * are inlined as `data:` URLs by the player (`?inline` imports, Requirement 6.1).
 */
export default defineConfig({
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist-player",
    emptyOutDir: true,
    copyPublicDir: false,
    minify: true,
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL("./src/player/main.ts", import.meta.url)),
      name: "HexCardPlayer",
      formats: ["iife"],
      fileName: () => "player.js",
    },
  },
});
