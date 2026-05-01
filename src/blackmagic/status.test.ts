import { describe, expect, it } from "vitest";
import { decodeCameraStatus, decodeCameraStatusDataView } from "./status";

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
    });
  });

  it("masks status values to one byte", () => {
    expect(decodeCameraStatus(0x120).raw).toBe(0x20);
    expect(decodeCameraStatus(0x120).cameraReady).toBe(true);
  });

  it("decodes status from a DataView", () => {
    expect(decodeCameraStatusDataView(new DataView(Uint8Array.of(0x24).buffer))).toMatchObject({
      paired: true,
      cameraReady: true,
    });
  });
});
