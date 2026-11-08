// Ambient module declarations for the studio's Vite-only modules.

/**
 * The built standalone player bundle (`dist-player/player.js`) as text, or `null` when it has not
 * been built (`npm run build` runs `build:player` first). Implemented by the `hexcard-player`
 * plugin in `vite.config.ts`; imported lazily by File > Export Standalone HTML.
 */
declare module "virtual:hexcard-player" {
  const playerSource: string | null;
  export default playerSource;
}
