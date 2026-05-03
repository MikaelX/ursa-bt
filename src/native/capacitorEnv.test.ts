import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: vi.fn(() => "web"),
    isNativePlatform: vi.fn(() => false),
  },
}));

import { Capacitor } from "@capacitor/core";
import { getCapacitorPlatform, isNativeShell } from "./capacitorEnv";

describe("capacitorEnv", () => {
  beforeEach(() => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue("web");
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
  });

  it("reports web when Capacitor is web", () => {
    expect(getCapacitorPlatform()).toBe("web");
    expect(isNativeShell()).toBe(false);
  });

  it("reports ios when Capacitor is native ios", () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue("ios");
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(getCapacitorPlatform()).toBe("ios");
    expect(isNativeShell()).toBe(true);
  });

  it("maps unknown platforms to web bucket", () => {
    vi.mocked(Capacitor.getPlatform).mockReturnValue("electron");
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true);
    expect(getCapacitorPlatform()).toBe("web");
  });
});
