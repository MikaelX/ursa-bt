import { resolve } from "node:path";
import { defineConfig } from "vitest/config";
import { BANKS_DEV_PORT } from "./src/banks/devServerPort";

export default defineConfig({
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
        main: resolve(__dirname, "index.html"),
        patterns: resolve(__dirname, "patterns.html"),
      },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
  },
});
