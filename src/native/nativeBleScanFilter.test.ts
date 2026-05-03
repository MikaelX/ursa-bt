import { describe, expect, it } from "vitest";
import type { ScanResult } from "@capacitor-community/bluetooth-le";
import { BLACKMAGIC_CAMERA_SERVICE } from "../blackmagic/constants";
import { scanMatchesBlackmagicDiscovery } from "./nativeBleCameraClient";

function r(partial: Partial<ScanResult> & { device: ScanResult["device"] }): ScanResult {
  return {
    ...partial,
    device: partial.device,
  };
}

describe("scanMatchesBlackmagicDiscovery", () => {
  const bmSvc = BLACKMAGIC_CAMERA_SERVICE.toLowerCase();

  it("accepts advertised Blackmagic camera service UUID", () => {
    expect(
      scanMatchesBlackmagicDiscovery(
        r({
          device: { deviceId: "x" },
          uuids: [bmSvc, "00001800-0000-1000-8000-00805f9b34fb"],
        }),
      ),
    ).toBe(true);
  });

  it("accepts service UUID only on BleDevice.uuids", () => {
    expect(
      scanMatchesBlackmagicDiscovery(
        r({
          device: { deviceId: "x", uuids: [bmSvc] },
        }),
      ),
    ).toBe(true);
  });

  it("accepts recognizable camera names without service list", () => {
    expect(
      scanMatchesBlackmagicDiscovery(r({ device: { deviceId: "x", name: "URSA Broadcast A:x" }, localName: "URSA Broadcast A:x" })),
    ).toBe(true);
    expect(
      scanMatchesBlackmagicDiscovery(r({ device: { deviceId: "x", name: "Blackmagic Pocket Cinema Camera 6K" } })),
    ).toBe(true);
  });

  it("rejects random TVs and unnamed peripherals", () => {
    expect(
      scanMatchesBlackmagicDiscovery(r({ device: { deviceId: "x", name: "[TV] Samsung Q70 Series (65)" } })),
    ).toBe(false);
    expect(
      scanMatchesBlackmagicDiscovery(r({ device: { deviceId: "unknown-uuid-tail" }, rssi: -50 })),
    ).toBe(false);
  });
});
