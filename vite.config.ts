import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { BANKS_DEV_PORT } from "./src/banks/devServerPort";

const repoRoot = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf-8")) as { version?: string };
const appVersion = typeof pkg.version === "string" ? pkg.version : "0.0.0";

/** Embedded WebView loads from `capacitor://` / relative paths — needs asset-relative URLs. Browser/hosted builds keep `/`. */
const capacitorBuild = process.env.CAPACITOR_BUILD === "1";

/** Baked into the client: relay hub `https://bt.bm.almiro.se` unless `ENVIRONMENT=LOCAL` (same-origin / Vite proxy). */
const appEnvironment =
  typeof process.env.ENVIRONMENT === "string" && process.env.ENVIRONMENT.trim() !== ""
    ? process.env.ENVIRONMENT.trim()
    : "development";

export default defineConfig({
  define: {
    __BUILD_APP_VERSION__: JSON.stringify(appVersion),
    __APP_ENVIRONMENT__: JSON.stringify(appEnvironment),
  },
  base: capacitorBuild ? "./" : "/",
  server: {
    proxy: {
      "/api": {
        target:
          process.env.BANKS_SERVER_URL ?? `http://127.0.0.1:${BANKS_DEV_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(repoRoot, "index.html"),
        patterns: resolve(repoRoot, "patterns.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
