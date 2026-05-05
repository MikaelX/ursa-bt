declare const __APP_ENVIRONMENT__: string;

/**
 * @file relayUrl.ts
 *
 * bm-bluetooth — Resolve relay coordinator HTTP + WebSocket bases from **`__APP_ENVIRONMENT__`** (Vite `ENVIRONMENT`).
 * Default hub is **`https://bt.bm.almiro.se`**; set **`ENVIRONMENT=LOCAL`** at build time to use same-origin
 * (Vite dev + `/api` proxy) or a 5173 fallback when `window` is missing.
 *
 * Debug tab: `localStorage` key {@link DEBUG_RELAY_HUB_LOCALHOST_LS} forces **`http://127.0.0.1:5173`**
 * (Vite `/api` proxy → banks/relay server) while the app is otherwise built for production.
 *
 * **Private** repo.
 */

const DEFAULT_RELAY_HUB = "https://bt.bm.almiro.se";

/** When set to `1`, relay HTTP + WS use `127.0.0.1:5173` (see Debug view). */
export const DEBUG_RELAY_HUB_LOCALHOST_LS = "bm-debug-relay-hub-localhost";

/** Vite default; `/api` must proxy to the Node server that runs the relay coordinator. */
const DEBUG_RELAY_LOCALHOST_ORIGIN = "http://127.0.0.1:5173";

/** Same origin as the page (Vite dev + `/api` proxy), or a dev fallback when `window` is missing. */
function localRelayBaseUrl(): URL {
  if (typeof window !== "undefined") {
    try {
      return new URL(window.location.origin);
    } catch {
      // ignore
    }
  }
  return new URL(DEBUG_RELAY_LOCALHOST_ORIGIN);
}

function useDebugRelayHubLocalhost(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(DEBUG_RELAY_HUB_LOCALHOST_LS) === "1";
  } catch {
    return false;
  }
}

function useLocalRelayHub(): boolean {
  return String(__APP_ENVIRONMENT__).trim().toUpperCase() === "LOCAL";
}

function relayBaseUrl(): URL {
  if (useDebugRelayHubLocalhost()) {
    return new URL(DEBUG_RELAY_LOCALHOST_ORIGIN);
  }
  if (useLocalRelayHub()) {
    return localRelayBaseUrl();
  }
  return new URL(DEFAULT_RELAY_HUB);
}

/** WebSocket URL for relay. */
export function getRelaySocketUrl(): string {
  const base = relayBaseUrl();
  const wsProto = base.protocol === "https:" ? "wss:" : "ws:";
  return `${wsProto}//${base.host}/api/relay/socket`;
}

/** HTTP URL for relay session list (hosted sessions). */
export function getRelaySessionsUrl(): string {
  const base = relayBaseUrl();
  return new URL("/api/relay/sessions", base.origin).href;
}
