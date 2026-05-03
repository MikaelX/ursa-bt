import { describe, expect, it } from "vitest";
import { commands, decodeConfigurationPacket } from "./protocol.js";

/** Sensor gain CCmd must match `server/atem/blePacketToAtem.ts` category 1 / parameter 13. */
describe("protocol gain vs ATEM CC video gain", () => {
  it("encodes BLE packet as video category 1 parameter 13", () => {
    const p = commands.gain(18);
    const d = decodeConfigurationPacket(p);
    expect(d).toBeDefined();
    expect(d!.category).toBe(1);
    expect(d!.parameter).toBe(13);
    expect(d!.values[0]).toBe(18);
  });
});
