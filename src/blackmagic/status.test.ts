import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  decodeCameraStatus,
  decodeCameraStatusDataView,
  decodeCameraStatusFromHex,
  decodeCameraStatusPayload,
} from "./status";

describe("decodeCameraStatus", () => {
  it("decodes an empty status", () => {
    expect(decodeCameraStatus(0)).toMatchObject({
      raw: 0,
      powerOn: false,
      connected: false,
      paired: false,
      versionsVerified: false,
      initialPayloadReceived: false,
      cameraReady: false,
      labels: [],
      payloadHex: "00",
      statusByteReservedBits: 0,
    });
  });

  it("decodes all documented status flags", () => {
    expect(decodeCameraStatus(0x3f)).toMatchObject({
      raw: 0x3f,
      powerOn: true,
      connected: true,
      paired: true,
      versionsVerified: true,
      initialPayloadReceived: true,
      cameraReady: true,
      labels: [
        "Power On",
        "Connected",
        "Paired",
        "Versions Verified",
        "Initial Payload Received",
        "Camera Ready",
      ],
      payloadHex: "3f",
      statusByteReservedBits: 0,
    });
  });

  it("masks status values to one byte", () => {
    expect(decodeCameraStatus(0x120).raw).toBe(0x20);
    expect(decodeCameraStatus(0x120).cameraReady).toBe(true);
    expect(decodeCameraStatus(0x120).payloadHex).toBe("20");
  });

  it("decodes status from a DataView", () => {
    expect(decodeCameraStatusDataView(new DataView(Uint8Array.of(0x24).buffer))).toMatchObject({
      paired: true,
      cameraReady: true,
      payloadHex: "24",
      trailingPayloadHex: undefined,
      statusByteReservedBits: 0,
    });
  });

  it("captures trailing bytes and reserved bits in byte 0", () => {
    const status = decodeCameraStatusPayload(Uint8Array.of(0xc1, 0xab, 0xcd));
    expect(status.raw).toBe(0xc1);
    expect(status.powerOn).toBe(true);
    expect(status.payloadHex).toBe(bytesToHex(Uint8Array.of(0xc1, 0xab, 0xcd)));
    expect(status.trailingPayloadHex).toBe("abcd");
    expect(status.statusByteReservedBits).toBe(0xc0);
  });

  it("round-trips relay-style hex", () => {
    const hex = "240102";
    const s = decodeCameraStatusFromHex(hex);
    expect(s.raw).toBe(0x24);
    expect(s.trailingPayloadHex).toBe("0102");
  });
});
