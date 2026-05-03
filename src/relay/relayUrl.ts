declare const __APP_ENVIRONMENT__: string;

/**
 * @file relayUrl.ts
 *
 * bm-bluetooth — Resolve relay coordinator HTTP + WebSocket bases from **`__APP_ENVIRONMENT__`** (Vite `ENVIRONMENT`).
 * Default hub is **`https://bt.bm.almiro.se`**; set **`ENVIRONMENT=LOCAL`** at build time to use same-origin
 * (Vite dev + `/api` proxy) or a 5173 fallback when `window` is missing.
 *
 * **Private** repo.
 */

const DEFAULT_RELAY_HUB = "https://bt.bm.almiro.se";

/** Same origin as the page (Vite dev + `/api` proxy), or a dev fallback when `window` is missing. */
function localRelayBaseUrl(): URL {
  if (typeof window !== "undefined") {
    try {
      return new URL(window.location.origin);
    } catch {
      // ignore
    }
  }
  return new URL("http://127.0.0.1:5173");
}

function useLocalRelayHub(): boolean {
  return String(__APP_ENVIRONMENT__).trim().toUpperCase() === "LOCAL";
}

function relayBaseUrl(): URL {
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
