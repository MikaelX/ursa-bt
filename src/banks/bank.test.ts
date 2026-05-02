import { describe, expect, it, vi } from "vitest";
import { applyBankToCamera, buildBankFromSnapshot, type Bank } from "./bank";
import { commands, decodeConfigurationPacket } from "../blackmagic/protocol";
import type { CameraSnapshot } from "../blackmagic/cameraState";

function snapshotFixture(): CameraSnapshot {
  return {
    recording: false,
    whiteBalance: { temperature: 5600, tint: 10 },
    autoExposureMode: 0,
    shutterAngle: 18000,
    iso: 800,
    gainDb: 6,
    lens: { focus: 0.42, apertureNormalised: 0.6 },
    color: {
      lift: { red: 0.1, green: 0, blue: -0.1, luma: 0 },
      gamma: { red: 0, green: 0, blue: 0, luma: 0.05 },
      gain: { red: 1.1, green: 1, blue: 0.9, luma: 1 },
      offset: { red: 0, green: 0, blue: 0, luma: 0 },
      contrast: { pivot: 0.5, adjust: 1.2 },
      lumaMix: 0.8,
      hue: 0.05,
      saturation: 1.1,
    },
    audio: {},
    metadata: {},
    updatedKeys: [],
  };
}

describe("applyBankToCamera", () => {
  it("writes one packet per settable parameter and respects the bank values", async () => {
    const bank: Bank = {
      whiteBalance: { temperature: 4200, tint: 5 },
      gainDb: -3,
      iso: 1600,
      shutterAngle: 90,
      iris: 0.5,
      focus: 0.25,
      autoExposureMode: 1,
      color: {
        lift: { red: 0.1, green: 0, blue: 0, luma: 0 },
        gamma: { red: 0, green: 0, blue: 0, luma: 0 },
        gain: { red: 1, green: 1, blue: 1, luma: 1 },
        offset: { red: 0, green: 0, blue: 0, luma: 0 },
        contrast: { pivot: 0.5, adjust: 1.0 },
        lumaMix: 0.7,
        hue: 0.1,
        saturation: 1.2,
      },
    };

    const writeCommand = vi.fn(async (_packet: Uint8Array) => undefined);
    await applyBankToCamera({ writeCommand }, bank);

    expect(writeCommand).toHaveBeenCalled();

    const payloads = writeCommand.mock.calls.map((args) => args[0]);
    const decoded = payloads
      .map((packet) => decodeConfigurationPacket(packet))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    expect(decoded.find((d) => d.category === 1 && d.parameter === 2)?.values).toEqual([4200, 5]);
    expect(decoded.find((d) => d.category === 1 && d.parameter === 13)?.values).toEqual([-3]);
    expect(decoded.find((d) => d.category === 1 && d.parameter === 14)?.values).toEqual([1600]);
    expect(decoded.find((d) => d.category === 1 && d.parameter === 11)?.values).toEqual([9000]);
    expect(decoded.find((d) => d.category === 1 && d.parameter === 10)?.values).toEqual([1]);
    expect(decoded.find((d) => d.category === 8 && d.parameter === 4)).toBeDefined();
    expect(decoded.find((d) => d.category === 8 && d.parameter === 5)).toBeDefined();
    expect(decoded.find((d) => d.category === 8 && d.parameter === 6)).toBeDefined();
  });

  it("buildBankFromSnapshot extracts the user-visible settings", () => {
    const bank = buildBankFromSnapshot(snapshotFixture());
    expect(bank.whiteBalance).toEqual({ temperature: 5600, tint: 10 });
    expect(bank.iso).toBe(800);
    expect(bank.gainDb).toBe(6);
    expect(bank.shutterAngle).toBe(180);
    expect(bank.iris).toBeCloseTo(0.6);
    expect(bank.focus).toBeCloseTo(0.42);
    expect(bank.color.lift.red).toBeCloseTo(0.1);
    expect(bank.color.contrast?.adjust).toBeCloseTo(1.2);
    expect(bank.color.hue).toBeCloseTo(0.05);
    expect(bank.color.saturation).toBeCloseTo(1.1);
    expect(bank.ndFilterStops).toBe(0);
    expect(bank.ndFilterDisplayMode).toBe(0);
    expect(bank.unitOutputs).toEqual({ colorBars: false, programReturnFeed: false });
  });

  it("buildBankFromSnapshot captures audio settings, cameraNumber and ND filter", () => {
    const snap = snapshotFixture();
    snap.cameraNumber = 4;
    snap.ndFilterStops = 1.8;
    snap.ndFilterDisplayMode = 2;
    snap.audio = {
      micLevel: 0.6,
      headphoneLevel: 0.4,
      headphoneProgramMix: 0.7,
      speakerLevel: 0.3,
      inputType: 2,
      inputLevels: { left: 0.55, right: 0.45 },
      phantomPower: true,
    };

    const bank = buildBankFromSnapshot(snap);
    expect(bank.cameraNumber).toBe(4);
    expect(bank.ndFilterStops).toBeCloseTo(1.8);
    expect(bank.ndFilterDisplayMode).toBe(2);
    expect(bank.audio?.micLevel).toBeCloseTo(0.6);
    expect(bank.audio?.inputLevels).toEqual({ left: 0.55, right: 0.45 });
    expect(bank.audio?.inputType).toBe(2);
    expect(bank.audio?.phantomPower).toBe(true);
  });

  it("applyBankToCamera writes audio + ND commands when the bank contains them", async () => {
    const bank: Bank = {
      color: {
        lift: { red: 0, green: 0, blue: 0, luma: 0 },
        gamma: { red: 0, green: 0, blue: 0, luma: 0 },
        gain: { red: 1, green: 1, blue: 1, luma: 1 },
        offset: { red: 0, green: 0, blue: 0, luma: 0 },
      },
      audio: {
        micLevel: 0.6,
        headphoneLevel: 0.4,
        headphoneProgramMix: 0.7,
        speakerLevel: 0.3,
        inputType: 1,
        inputLevels: { left: 0.55, right: 0.45 },
      },
      ndFilterStops: 1.2,
    };

    const writeCommand = vi.fn(async (_packet: Uint8Array) => undefined);
    await applyBankToCamera({ writeCommand }, bank);

    const payloads = writeCommand.mock.calls.map((args) => args[0]);
    const decoded = payloads
      .map((packet) => decodeConfigurationPacket(packet))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    expect(decoded.find((d) => d.category === 2 && d.parameter === 0)).toBeDefined();
    expect(decoded.find((d) => d.category === 2 && d.parameter === 1)).toBeDefined();
    expect(decoded.find((d) => d.category === 2 && d.parameter === 2)).toBeDefined();
    expect(decoded.find((d) => d.category === 2 && d.parameter === 3)).toBeDefined();
    expect(decoded.find((d) => d.category === 2 && d.parameter === 4)?.values).toEqual([1]);
    expect(decoded.find((d) => d.category === 2 && d.parameter === 5)?.values).toHaveLength(2);
    expect(decoded.find((d) => d.category === 1 && d.parameter === 16)?.values).toHaveLength(2);
  });

  it("applyBankToCamera sends color bars and program return when unitOutputs is saved on the bank", async () => {
    const bank: Bank = {
      color: {
        lift: { red: 0, green: 0, blue: 0, luma: 0 },
        gamma: { red: 0, green: 0, blue: 0, luma: 0 },
        gain: { red: 1, green: 1, blue: 1, luma: 1 },
        offset: { red: 0, green: 0, blue: 0, luma: 0 },
      },
      unitOutputs: { colorBars: true, programReturnFeed: false },
    };

    const writeCommand = vi.fn(async (_packet: Uint8Array) => undefined);
    await applyBankToCamera({ writeCommand }, bank);

    const payloads = writeCommand.mock.calls.map((args) => args[0]);
    const decoded = payloads
      .map((packet) => decodeConfigurationPacket(packet))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    const bars = decoded.find((d) => d.category === 4 && d.parameter === 4);
    expect(bars?.values?.[0]).toBeGreaterThan(0);
    expect(decoded.find((d) => d.category === 4 && d.parameter === 6)?.values?.[0]).toBe(0);
  });

  it("matches commands.* output exactly when the bank holds the same value", async () => {
    const bank: Bank = {
      gainDb: 0,
      color: {
        lift: { red: 0, green: 0, blue: 0, luma: 0 },
        gamma: { red: 0, green: 0, blue: 0, luma: 0 },
        gain: { red: 1, green: 1, blue: 1, luma: 1 },
        offset: { red: 0, green: 0, blue: 0, luma: 0 },
      },
    };

    const writeCommand = vi.fn(async (_packet: Uint8Array) => undefined);
    await applyBankToCamera({ writeCommand }, bank);

    expect(writeCommand).toHaveBeenCalledWith(commands.gain(0));
  });

  it("applyBankToCamera skips ND over BLE when skipNdBle is set", async () => {
    const bank: Bank = {
      color: {
        lift: { red: 0, green: 0, blue: 0, luma: 0 },
        gamma: { red: 0, green: 0, blue: 0, luma: 0 },
        gain: { red: 1, green: 1, blue: 1, luma: 1 },
        offset: { red: 0, green: 0, blue: 0, luma: 0 },
      },
      ndFilterStops: 2,
    };

    const writeCommand = vi.fn(async (_packet: Uint8Array) => undefined);
    await applyBankToCamera({ writeCommand }, bank, { skipNdBle: true });

    const payloads = writeCommand.mock.calls.map((args) => args[0]);
    const decoded = payloads
      .map((packet) => decodeConfigurationPacket(packet))
      .filter((d): d is NonNullable<typeof d> => d !== undefined);

    expect(decoded.find((d) => d.category === 1 && d.parameter === 16)).toBeUndefined();
  });
});
