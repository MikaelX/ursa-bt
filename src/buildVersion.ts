/** Package version baked at build time (`vite.config.ts` → `__BUILD_APP_VERSION__`). */
export function buildAppVersion(): string {
  return typeof __BUILD_APP_VERSION__ === "string" ? __BUILD_APP_VERSION__ : "dev";
}
