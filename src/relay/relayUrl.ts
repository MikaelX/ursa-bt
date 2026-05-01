/** WebSocket URL for relay (same origin as SPA; nginx terminates TLS → wss). */
export function getRelaySocketUrl(): string {
  if (typeof window === "undefined" || typeof window.location?.host !== "string") {
    const port = 4000;
    return `ws://127.0.0.1:${port}/api/relay/socket`;
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/relay/socket`;
}

/** HTTP base for relay REST (sessions list); same-origin as SPA. */
export function getRelaySessionsUrl(): string {
  return "/api/relay/sessions";
}
