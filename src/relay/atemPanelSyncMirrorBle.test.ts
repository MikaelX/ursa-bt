import { describe, expect, it } from "vitest";
import { decodeConfigurationPacket } from "../blackmagic/protocol";
import { blePacketsFromAtemPanelSyncClean } from "./atemPanelSyncMirrorBle";

describe("blePacketsFromAtemPanelSyncClean", () => {
  it("emits lens + video packets for a typical ATEM slice", () => {
    const clean = {
      deviceName: "ATEM CCU (cam 7)",
      lens: { focus: 0.2, apertureFstop: 5.63 },
      whiteBalance: { temperature: 5600, tint: 0 },
      gainDb: 2,
      exposureUs: 20000,
      shutterSpeed: 50,
    };
    const packets = blePacketsFromAtemPanelSyncClean(clean);
    expect(packets.length).toBeGreaterThanOrEqual(5);
    const decoded = packets.map((p) => decodeConfigurationPacket(p));
    expect(decoded.every((d) => d !== undefined)).toBe(true);
    const cats = decoded.map((d) => d!.category);
    expect(cats).toContain(0);
    expect(cats).toContain(1);
  });
});
