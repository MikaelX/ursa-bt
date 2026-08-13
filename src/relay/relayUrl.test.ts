import { afterEach, describe, expect, it } from "vitest";
import {
  DEBUG_RELAY_HUB_LOCALHOST_LS,
  getRelayAtemConnectorsUrl,
  getRelaySessionsUrl,
  getRelaySocketUrl,
} from "./relayUrl.js";

declare global {
  interface Window {
    Capacitor?: { isNativePlatform?: () => boolean };
  }
}

describe("relayUrl native shell", () => {
  afterEach(() => {
    localStorage.removeItem(DEBUG_RELAY_HUB_LOCALHOST_LS);
    delete window.Capacitor;
  });

  it("uses production hub on Capacitor even when debug localhost localStorage is set", () => {
    localStorage.setItem(DEBUG_RELAY_HUB_LOCALHOST_LS, "1");
    window.Capacitor = { isNativePlatform: () => true };

    expect(getRelaySocketUrl()).toBe("wss://bt.bm.almiro.se/api/relay/socket");
    expect(getRelaySessionsUrl()).toBe("https://bt.bm.almiro.se/api/relay/sessions");
    expect(getRelayAtemConnectorsUrl()).toBe("https://bt.bm.almiro.se/api/relay/atem-connectors");
  });

  it("honours debug localhost override in browser", () => {
    localStorage.setItem(DEBUG_RELAY_HUB_LOCALHOST_LS, "1");
    window.Capacitor = { isNativePlatform: () => false };

    expect(getRelaySocketUrl()).toBe("ws://127.0.0.1:5173/api/relay/socket");
    expect(getRelaySessionsUrl()).toBe("http://127.0.0.1:5173/api/relay/sessions");
  });
});
