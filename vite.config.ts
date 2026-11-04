/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// Studio build. The player build (vite.player.config.ts) is added by spec 04.
export default defineConfig({
  // Public base path. GitHub Pages serves the app from a sub-path (BASE_PATH=/hexcard-resurrection/,
  // set by .github/workflows/deploy.yml); local dev and tests use "/".
  base: process.env.BASE_PATH || "/",
  plugins: [react()],
  test: {
    // src/core and src/engine must be testable in Node without a browser.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
