import { describe, expect, it, vi } from "vitest";
import { CameraState, shouldRelayPanelSyncCommand } from "./cameraState";
import { commands, encodeConfigurationCommand, fixed16Payload, CameraControlDataType } from "./protocol";
import type { CameraStatus } from "./status";

describe("CameraState", () => {
  it("ingests white balance and gain packets", () => {
    const state = new CameraState();
    const wbPacket = commands.whiteBalance(5600, 10);
    const gainPacket = commands.gain(6);

    state.ingestIncomingPacket(wbPacket);
    state.ingestIncomingPacket(gainPacket);

    expect(state.current.whiteBalance).toEqual({ temperature: 5600, tint: 10 });
    expect(state.current.gainDb).toBe(6);
  });

  it("derives recording flag from transport mode 2 (Record)", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.recordStop());
    expect(state.current.recording).toBe(false);

    state.ingestIncomingPacket(commands.recordStart());
    expect(state.current.recording).toBe(true);
    expect(state.current.transportMode).toBe(2);
  });

  it("ingests shutter angle (param 11), shutter speed (param 12) and auto-exp (param 10) into the right fields", () => {
    const state = new CameraState();

    state.ingestIncomingPacket(commands.shutterAngle(180));
    expect(state.current.shutterAngle).toBe(18000);

    state.ingestIncomingPacket(commands.shutterSpeed(50));
    expect(state.current.shutterSpeed).toBe(50);

    state.ingestIncomingPacket(commands.autoExposureMode(1));
    expect(state.current.autoExposureMode).toBe(1);
  });

  it("does not clobber shutterAngle when the camera reports unrelated params 7/8", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.shutterAngle(200));
    expect(state.current.shutterAngle).toBe(20000);

    state.ingestIncomingPacket(new Uint8Array([0xff, 0x05, 0x00, 0x00, 0x01, 0x07, 0x01, 0x02, 0x02]));
    state.ingestIncomingPacket(new Uint8Array([0xff, 0x05, 0x00, 0x00, 0x01, 0x08, 0x01, 0x02, 0x02]));

    expect(state.current.shutterAngle).toBe(20000);
  });

  it("decodes lift adjust into color.lift", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.lift(0.1, -0.05, 0.2, 0));

    expect(state.current.color.lift.red).toBeCloseTo(0.1, 2);
    expect(state.current.color.lift.green).toBeCloseTo(-0.05, 2);
    expect(state.current.color.lift.blue).toBeCloseTo(0.2, 2);
  });

  it("round-trips contrast, luma mix and color (hue/sat) packets", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.contrast(0.5, 1.2));
    state.ingestIncomingPacket(commands.lumaMix(0.7));
    state.ingestIncomingPacket(commands.colorAdjust(-0.25, 1.4));

    expect(state.current.color.contrast?.pivot).toBeCloseTo(0.5, 2);
    expect(state.current.color.contrast?.adjust).toBeCloseTo(1.2, 2);
    expect(state.current.color.lumaMix).toBeCloseTo(0.7, 2);
    expect(state.current.color.hue).toBeCloseTo(-0.25, 2);
    expect(state.current.color.saturation).toBeCloseTo(1.4, 2);
  });

  it("clamps color-correction commands to PDF ranges", () => {
    expect(Array.from(commands.gamma(10, -10, 0, 0)).slice(8, 12)).toEqual(
      Array.from(commands.gamma(4, -4, 0, 0)).slice(8, 12),
    );

    const overshoot = Array.from(commands.videoGain(-5, 99, 1, 1)).slice(8, 16);
    const clampedRed = overshoot.slice(0, 2);
    expect(clampedRed).toEqual([0, 0]);
    const clampedGreen = overshoot.slice(2, 4);
    expect(clampedGreen).toEqual([255, 127]);
  });

  it("ingests audio packets (mic, headphone, L/R input levels, phantom power)", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.micLevel(0.42));
    state.ingestIncomingPacket(commands.headphoneLevel(0.7));
    state.ingestIncomingPacket(commands.audioInputLevels(0.6, 0.3));
    state.ingestIncomingPacket(commands.audioInputType(2));
    state.ingestIncomingPacket(commands.phantomPower(true));

    expect(state.current.audio.micLevel).toBeCloseTo(0.42, 2);
    expect(state.current.audio.headphoneLevel).toBeCloseTo(0.7, 2);
    expect(state.current.audio.inputLevels?.left).toBeCloseTo(0.6, 2);
    expect(state.current.audio.inputLevels?.right).toBeCloseTo(0.3, 2);
    expect(state.current.audio.inputType).toBe(2);
    expect(state.current.audio.phantomPower).toBe(true);
  });

  it("ingests ND filter stops (Video param 16)", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.ndFilterStops(1.8));
    expect(state.current.ndFilterStops).toBeCloseTo(1.8, 1);
    expect(state.current.ndFilterDisplayMode).toBe(0);
  });

  it("ingests ND display mode from second Fixed16 on Video param 16", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.ndFilterStops(1.2, 2));
    expect(state.current.ndFilterStops).toBeCloseTo(1.2, 1);
    expect(state.current.ndFilterDisplayMode).toBe(2);
  });

  it("does not overwrite ndFilterDisplayMode when Video param 16 carries only stops", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.ndFilterStops(0.9, 1));
    expect(state.current.ndFilterDisplayMode).toBe(1);
    const stopsOnly = encodeConfigurationCommand({
      category: 1,
      parameter: 16,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(0.3),
    });
    state.ingestIncomingPacket(stopsOnly);
    expect(state.current.ndFilterStops).toBeCloseTo(0.3, 1);
    expect(state.current.ndFilterDisplayMode).toBe(1);
  });

  it("ignores ND from BLE incoming when device is URSA; still applies ND from relay command bytes", () => {
    const state = new CameraState();
    state.setDeviceName("URSA Broadcast");
    state.applyNdFilterStopsWrite(2);
    state.ingestIncomingPacket(commands.ndFilterStops(0, 0));
    expect(state.current.ndFilterStops).toBeCloseTo(2, 1);
    expect(state.applyRelayPanelSyncFromCommandBytes(commands.ndFilterStops(4, 0))).toBe(true);
    expect(state.current.ndFilterStops).toBeCloseTo(4, 1);
  });

  it("ingests display color bars and program return (category 4)", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.colorBars(30));
    expect(state.current.unitOutputs?.colorBars).toBe(true);
    state.ingestIncomingPacket(commands.colorBars(0));
    expect(state.current.unitOutputs?.colorBars).toBe(false);

    state.ingestIncomingPacket(commands.programReturnFeed(15));
    expect(state.current.unitOutputs?.programReturnFeed).toBe(true);
    state.ingestIncomingPacket(commands.programReturnFeed(0));
    expect(state.current.unitOutputs?.programReturnFeed).toBe(false);
  });

  it("relayPanelSyncPatch merges unitOutputs without resetting unrelated fields", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.gain(6));
    state.relayPanelSyncPatch({ unitOutputs: { colorBars: true, programReturnFeed: false } });
    expect(state.current.gainDb).toBe(6);
    expect(state.current.unitOutputs?.colorBars).toBe(true);
  });

  it("relayPanelSyncPatch merges status (paired) without resetting unrelated fields", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.gain(6));
    const st: CameraStatus = {
      raw: 0x07,
      powerOn: true,
      connected: true,
      paired: true,
      versionsVerified: false,
      initialPayloadReceived: false,
      cameraReady: false,
      labels: ["Power On", "Connected", "Paired"],
      payloadHex: "07",
      statusByteReservedBits: 0,
    };
    state.relayPanelSyncPatch({ status: st });
    expect(state.current.gainDb).toBe(6);
    expect(state.current.status?.paired).toBe(true);
    expect(state.current.status?.raw).toBe(0x07);
  });

  it("shouldRelayPanelSyncCommand is true for auto WB set/restore", () => {
    expect(shouldRelayPanelSyncCommand(commands.setAutoWhiteBalance())).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.restoreAutoWhiteBalance())).toBe(true);
  });

  it("shouldRelayPanelSyncCommand is true for program return and color bars", () => {
    expect(shouldRelayPanelSyncCommand(commands.programReturnFeed(30))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.programReturnFeed(0))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.colorBars(30))).toBe(true);
  });

  it("shouldRelayPanelSyncCommand is true for master gain and ISO", () => {
    expect(shouldRelayPanelSyncCommand(commands.gain(6))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.iso(800))).toBe(true);
  });

  it("shouldRelayPanelSyncCommand is true for ND stops and ND display mode", () => {
    expect(shouldRelayPanelSyncCommand(commands.ndFilterStops(1.2, 0))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.ndFilterDisplayMode(1))).toBe(true);
  });

  it("shouldRelayPanelSyncCommand is true for audio channel and related audio writes", () => {
    expect(shouldRelayPanelSyncCommand(commands.audioInputLevels(0.55, 0.44))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.micLevel(0.5))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.headphoneLevel(0.6))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.speakerLevel(0.4))).toBe(true);
  });

  it("applyRelayPanelSyncFromCommandBytes mirrors audio input L/R from forwarded joiner bytes", () => {
    const state = new CameraState();
    expect(state.applyRelayPanelSyncFromCommandBytes(commands.audioInputLevels(0.72, 0.28))).toBe(true);
    expect(state.current.audio.inputLevels?.left).toBeCloseTo(0.72, 2);
    expect(state.current.audio.inputLevels?.right).toBeCloseTo(0.28, 2);
  });

  it("shouldRelayPanelSyncCommand is true for zoom, project FPS, and off-speed", () => {
    expect(shouldRelayPanelSyncCommand(commands.zoomNormalised(0.42))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.recordingFormat(50, 50, 1920, 1080))).toBe(true);
    expect(shouldRelayPanelSyncCommand(commands.offSpeedFrameRate(120))).toBe(true);
  });

  it("ingests auto WB set/restore and clears LED on incoming white balance", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.setAutoWhiteBalance());
    expect(state.current.autoWhiteBalanceActive).toBe(true);
    state.ingestIncomingPacket(commands.restoreAutoWhiteBalance());
    expect(state.current.autoWhiteBalanceActive).toBe(false);
    state.setAutoWhiteBalanceActive(true);
    state.ingestIncomingPacket(commands.whiteBalance(4800, 12));
    expect(state.current.autoWhiteBalanceActive).toBe(false);
    expect(state.current.whiteBalance).toEqual({ temperature: 4800, tint: 12 });
  });

  it("relayPanelSyncPatch merges autoWhiteBalanceActive", () => {
    const state = new CameraState();
    state.relayPanelSyncPatch({ autoWhiteBalanceActive: true });
    expect(state.current.autoWhiteBalanceActive).toBe(true);
    state.relayPanelSyncPatch({ autoWhiteBalanceActive: false });
    expect(state.current.autoWhiteBalanceActive).toBe(false);
  });

  it("applyRelayPanelSyncFromCommandBytes mirrors lift from forwarded joiner bytes", () => {
    const state = new CameraState();
    const ok = state.applyRelayPanelSyncFromCommandBytes(commands.lift(0.5, -0.25, 0.1, 0));
    expect(ok).toBe(true);
    expect(state.current.color.lift.red).toBeCloseTo(0.5, 2);
    expect(state.current.color.lift.green).toBeCloseTo(-0.25, 2);
  });

  it("applyRelayPanelSyncFromCommandBytes mirrors program return from forwarded joiner bytes", () => {
    const state = new CameraState();
    expect(state.applyRelayPanelSyncFromCommandBytes(commands.programReturnFeed(30))).toBe(true);
    expect(state.current.unitOutputs?.programReturnFeed).toBe(true);
    expect(state.applyRelayPanelSyncFromCommandBytes(commands.programReturnFeed(0))).toBe(true);
    expect(state.current.unitOutputs?.programReturnFeed).toBe(false);
  });

  it("applyRelayPanelSyncFromCommandBytes mirrors master gain from forwarded joiner bytes", () => {
    const state = new CameraState();
    expect(state.applyRelayPanelSyncFromCommandBytes(commands.gain(12))).toBe(true);
    expect(state.current.gainDb).toBe(12);
  });

  it("relayPanelSyncPatch merges gainDb and iso", () => {
    const state = new CameraState();
    state.relayPanelSyncPatch({ gainDb: 18, iso: 400 });
    expect(state.current.gainDb).toBe(18);
    expect(state.current.iso).toBe(400);
  });

  it("relayPanelSyncPatch merges ndFilterStops and ndFilterDisplayMode", () => {
    const state = new CameraState();
    state.relayPanelSyncPatch({ ndFilterStops: 2.4, ndFilterDisplayMode: 1 });
    expect(state.current.ndFilterStops).toBeCloseTo(2.4, 1);
    expect(state.current.ndFilterDisplayMode).toBe(1);
  });

  it("applyRelayPanelSyncFromCommandBytes mirrors ND from forwarded joiner bytes", () => {
    const state = new CameraState();
    expect(state.applyRelayPanelSyncFromCommandBytes(commands.ndFilterStops(0.6, 2))).toBe(true);
    expect(state.current.ndFilterStops).toBeCloseTo(0.6, 1);
    expect(state.current.ndFilterDisplayMode).toBe(2);
  });

  it("ingests new Video params (dynamic range, sharpening, display LUT, exposure us)", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.dynamicRange(2));
    state.ingestIncomingPacket(commands.sharpening(1));
    state.ingestIncomingPacket(commands.displayLut(3, true));
    state.ingestIncomingPacket(commands.exposureUs(16667));

    expect(state.current.dynamicRange).toBe(2);
    expect(state.current.sharpeningLevel).toBe(1);
    expect(state.current.displayLut).toEqual({ selected: 3, enabled: true });
    expect(state.current.exposureUs).toBe(16667);
  });

  it("ingests metadata camera ID string", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.metadataCameraId("Cam A"));
    expect(state.current.metadata.cameraId).toBe("Cam A");
  });

  it("ingests Recording format / Storage media (cat 9 param 6) tail int8 as body camera number", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(new Uint8Array([0xff, 0x06, 0x00, 0x00, 0x09, 0x06, 0x01, 0x02, 0x00, 0x06]));
    expect(state.current.cameraNumber).toBe(6);
    expect(state.current.metadata.cameraId).toBe("6");
  });

  it("ingests tally brightness echoes per sub-parameter", () => {
    const state = new CameraState();
    state.ingestIncomingPacket(commands.tallyBrightness(1));
    state.ingestIncomingPacket(commands.frontTallyBrightness(0.5));
    state.ingestIncomingPacket(commands.rearTallyBrightness(0.25));

    expect(state.current.tally?.brightness?.master).toBeCloseTo(1, 2);
    expect(state.current.tally?.brightness?.front).toBeCloseTo(0.5, 2);
    expect(state.current.tally?.brightness?.rear).toBeCloseTo(0.25, 2);
  });

  it("notifies subscribers with the latest snapshot", () => {
    const state = new CameraState();
    const listener = vi.fn();
    state.subscribe(listener);

    state.setCameraNumber(3);
    expect(state.current.cameraNumber).toBe(3);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ cameraNumber: 3 }));
  });

  it("relay merge does not use ATEM switcher deviceName as the camera product", () => {
    const state = new CameraState();
    state.setDeviceName("URSA Broadcast");
    state.relayPanelSyncPatch({ deviceName: "ATEM Television Studio HD8 ISO" });
    expect(state.current.deviceName).toBe("URSA Broadcast");
  });

  it("relay bootstrap does not hydrate ATEM switcher name into deviceName", () => {
    const state = new CameraState();
    state.hydrateFromRelayExport({
      deviceName: "ATEM Mini Extreme ISO",
      gainDb: 3,
    });
    expect(state.current.deviceName).toBeUndefined();
    expect(state.current.gainDb).toBe(3);
  });

  it("setDeviceName ignores ATEM switcher names and keeps the previous camera name", () => {
    const state = new CameraState();
    state.setDeviceName("URSA Broadcast");
    state.setDeviceName("ATEM Constellation 8K");
    expect(state.current.deviceName).toBe("URSA Broadcast");
  });

  it("hydrates relay bootstrap snapshot (nested colour + tally)", () => {
    const state = new CameraState();
    state.hydrateFromRelayExport({
      recording: true,
      gainDb: 12,
      cameraNumber: 4,
      color: {
        lift: { red: 0.1, green: 0, blue: 0, luma: 0 },
      },
      tally: {
        programMe: true,
        brightness: { master: 0.8 },
      },
    });

    expect(state.current.recording).toBe(true);
    expect(state.current.gainDb).toBe(12);
    expect(state.current.cameraNumber).toBe(4);
    expect(state.current.color.lift.red).toBeCloseTo(0.1, 2);
    expect(state.current.tally?.programMe).toBe(true);
    expect(state.current.tally?.brightness?.master).toBeCloseTo(0.8, 2);
    expect(state.current.updatedKeys).toContain("relay-bootstrap");
  });
});
