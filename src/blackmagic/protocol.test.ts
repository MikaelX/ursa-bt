import { describe, expect, it } from "vitest";
import {
  CameraControlDataType,
  commands,
  decodeConfigurationPacket,
  encodeConfigurationCommand,
  fixed16Payload,
  int16Payload,
  int32Payload,
  int8Payload,
  toHex,
} from "./protocol";

describe("Blackmagic Camera Control protocol", () => {
  it("encodes the official autofocus example packet", () => {
    expect(Array.from(commands.autoFocus())).toEqual([255, 4, 0, 0, 0, 1, 0, 0]);
  });

  it("supports directed commands", () => {
    const packet = encodeConfigurationCommand({
      destination: 4,
      category: 0,
      parameter: 1,
      dataType: CameraControlDataType.VoidOrBool,
    });

    expect(Array.from(packet)).toEqual([4, 4, 0, 0, 0, 1, 0, 0]);
  });

  it("pads command payloads to 32-bit boundaries", () => {
    const packet = commands.recordStart();

    expect(packet.byteLength).toBe(12);
    expect(Array.from(packet)).toEqual([255, 5, 0, 0, 10, 1, 1, 0, 2, 0, 0, 0]);
  });

  it("encodes little-endian integer payloads", () => {
    expect(int8Payload(-1, 2)).toEqual([255, 2]);
    expect(int16Payload(5600, -10)).toEqual([224, 21, 246, 255]);
    expect(int32Payload(10000)).toEqual([16, 39, 0, 0]);
  });

  it("encodes fixed16 values with 11 fractional bits", () => {
    expect(fixed16Payload(0.15)).toEqual([51, 1]);
    expect(Array.from(commands.focus(0.5))).toEqual([255, 6, 0, 0, 0, 0, 128, 0, 0, 4, 0, 0]);
  });

  it("encodes MVP command helpers", () => {
    expect(Array.from(commands.recordStop())).toEqual([255, 5, 0, 0, 10, 1, 1, 0, 0, 0, 0, 0]);
    expect(Array.from(commands.iris(1))).toEqual([255, 6, 0, 0, 0, 3, 128, 0, 0, 8, 0, 0]);
    expect(Array.from(commands.whiteBalance(3200, 5))).toEqual([
      255, 8, 0, 0, 1, 2, 2, 0, 128, 12, 5, 0,
    ]);
    expect(Array.from(commands.gain(6))).toEqual([255, 5, 0, 0, 1, 13, 1, 0, 6, 0, 0, 0]);
    expect(Array.from(commands.iso(400))).toEqual([255, 8, 0, 0, 1, 14, 3, 0, 144, 1, 0, 0]);
  });

  it("formats packets as lowercase hex", () => {
    expect(toHex(commands.autoFocus())).toBe("ff 04 00 00 00 01 00 00");
  });

  it("decodes incoming configuration packets", () => {
    expect(
      decodeConfigurationPacket(Uint8Array.from([255, 6, 0, 0, 10, 0, 1, 2, 2, 1])),
    ).toMatchObject({
      category: 10,
      categoryName: "Media",
      parameter: 0,
      parameterName: "Codec",
      values: [2, 1],
    });
  });

  it("decodes signed fixed16 incoming values", () => {
    expect(
      decodeConfigurationPacket(Uint8Array.from([255, 6, 0, 0, 4, 2, 128, 1, 51, 1, 0, 0])),
    ).toMatchObject({
      categoryName: "Display",
      values: [0.14990234375],
    });
  });

  it("throws for out-of-range payload values", () => {
    expect(() => int8Payload(128)).toThrow("outside");
    expect(() => int16Payload(32768)).toThrow("outside");
    expect(() => int32Payload(Number.POSITIVE_INFINITY)).toThrow("finite");
  });

  it("encodes new video command helpers", () => {
    expect(Array.from(commands.dynamicRange(1))).toEqual([255, 5, 0, 0, 1, 7, 1, 0, 1, 0, 0, 0]);
    expect(Array.from(commands.sharpening(2))).toEqual([255, 5, 0, 0, 1, 8, 1, 0, 2, 0, 0, 0]);
    expect(Array.from(commands.exposureUs(10000))).toEqual([255, 8, 0, 0, 1, 5, 3, 0, 16, 39, 0, 0]);
    expect(Array.from(commands.setAutoWhiteBalance())).toEqual([255, 4, 0, 0, 1, 3, 0, 0]);
    expect(Array.from(commands.restoreAutoWhiteBalance())).toEqual([255, 4, 0, 0, 1, 4, 0, 0]);
  });

  it("encodes display LUT with [selected, enabled] pair", () => {
    expect(Array.from(commands.displayLut(2, true))).toEqual([255, 6, 0, 0, 1, 15, 1, 0, 2, 1, 0, 0]);
    expect(Array.from(commands.displayLut(0, false))).toEqual([255, 6, 0, 0, 1, 15, 1, 0, 0, 0, 0, 0]);
  });

  it("encodes color bars enable as int8 0-30", () => {
    expect(Array.from(commands.colorBars(30))).toEqual([255, 5, 0, 0, 4, 4, 1, 0, 30, 0, 0, 0]);
    expect(Array.from(commands.colorBars(0))).toEqual([255, 5, 0, 0, 4, 4, 1, 0, 0, 0, 0, 0]);
  });

  it("encodes program return feed enable as display 4.6 int8 0-30", () => {
    expect(Array.from(commands.programReturnFeed(30))).toEqual([255, 5, 0, 0, 4, 6, 1, 0, 30, 0, 0, 0]);
    expect(Array.from(commands.programReturnFeed(0))).toEqual([255, 5, 0, 0, 4, 6, 1, 0, 0, 0, 0, 0]);
  });

  it("encodes tally brightness commands", () => {
    expect(Array.from(commands.tallyBrightness(1))).toEqual([255, 6, 0, 0, 5, 0, 128, 0, 0, 8, 0, 0]);
    expect(Array.from(commands.frontTallyBrightness(0.5))).toEqual([255, 6, 0, 0, 5, 1, 128, 0, 0, 4, 0, 0]);
    expect(Array.from(commands.rearTallyBrightness(0))).toEqual([255, 6, 0, 0, 5, 2, 128, 0, 0, 0, 0, 0]);
  });

  it("encodes metadata camera ID as a UTF-8 string payload", () => {
    const packet = commands.metadataCameraId("3");
    expect(packet[4]).toBe(12);
    expect(packet[5]).toBe(5);
    expect(packet[6]).toBe(CameraControlDataType.String);
    expect(packet[8]).toBe("3".charCodeAt(0));

    const longer = commands.metadataCameraId("CamA");
    expect(Array.from(longer.slice(8, 12))).toEqual([67, 97, 109, 65]);
  });
});
