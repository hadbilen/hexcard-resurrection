/// <reference types="vitest/config" />
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// Studio build. The player bundle is built first by vite.player.config.ts (`npm run build:player`).

const PLAYER_MODULE_ID = "virtual:hexcard-player";
const RESOLVED_PLAYER_MODULE_ID = `\0${PLAYER_MODULE_ID}`;
const PLAYER_BUNDLE = fileURLToPath(new URL("./dist-player/player.js", import.meta.url));

/**
 * `virtual:hexcard-player` (spec 04 design.md §6): `export default` the text of the built
 * `dist-player/player.js`, or `null` when it has not been built. File > Export Standalone HTML
 * imports it lazily, so Vitest and `npm run dev` work on a clean checkout. The file is checked on
 * every load; in dev a player build (or its removal) invalidates the module, so the next page load
 * sees the new state.
 */
function hexcardPlayerPlugin(): Plugin {
  return {
    name: "hexcard-player",
    resolveId(source) {
      return source === PLAYER_MODULE_ID ? RESOLVED_PLAYER_MODULE_ID : undefined;
    },
    load(id) {
      if (id !== RESOLVED_PLAYER_MODULE_ID) return undefined;
      if (!existsSync(PLAYER_BUNDLE)) return "export default null;\n";
      this.addWatchFile(PLAYER_BUNDLE);
      return `export default ${JSON.stringify(readFileSync(PLAYER_BUNDLE, "utf8"))};\n`;
    },
    configureServer(server) {
      server.watcher.add(PLAYER_BUNDLE);
      const invalidate = (file: string): void => {
        if (file !== PLAYER_BUNDLE) return;
        const module = server.moduleGraph.getModuleById(RESOLVED_PLAYER_MODULE_ID);
        if (module) server.moduleGraph.invalidateModule(module);
      };
      server.watcher.on("add", invalidate);
      server.watcher.on("change", invalidate);
      server.watcher.on("unlink", invalidate);
    },
  };
}

export default defineConfig({
  // Public base path. GitHub Pages serves the app from a sub-path (BASE_PATH=/hexcard-resurrection/,
  // set by .github/workflows/deploy.yml); local dev and tests use "/".
  base: process.env.BASE_PATH || "/",
  plugins: [react(), hexcardPlayerPlugin()],
  test: {
    // src/core and src/engine must be testable in Node without a browser.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
