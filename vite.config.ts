/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Studio build. The player build (vite.player.config.ts) is added by spec 04.
export default defineConfig({
  plugins: [react()],
  test: {
    // src/core and src/engine must be testable in Node without a browser.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
