import { describe, expect, it } from "vitest";
import { commands, decodeConfigurationPacket } from "../blackmagic/protocol.js";
import { bleDecodedHandledByAtemBridge } from "./atemBleForwardGuard.js";

describe("bleDecodedHandledByAtemBridge", () => {
  it("accepts video gain", () => {
    const d = decodeConfigurationPacket(commands.gain(12));
    expect(d).toBeDefined();
    expect(bleDecodedHandledByAtemBridge(d!)).toBe(true);
  });

  it("rejects video ISO (not applied on ATEM bridge yet)", () => {
    const d = decodeConfigurationPacket(commands.iso(800));
    expect(d).toBeDefined();
    expect(bleDecodedHandledByAtemBridge(d!)).toBe(false);
  });

  it("rejects shutter speed (no-op on bridge)", () => {
    const d = decodeConfigurationPacket(commands.shutterSpeed(50));
    expect(d).toBeDefined();
    expect(bleDecodedHandledByAtemBridge(d!)).toBe(false);
  });
});
