import type { ConnectionState } from "../blackmagic/bleClient";
import type { CameraClient } from "../ui/cameraClientTypes";

/**
 * @file nullBleCameraClient.ts
 *
 * bm-bluetooth — Stub {@link CameraClient} when ATEM CCU hosting owns transport on the coordinator (no local GATT).
 * `connect()` is a hard guard so callers fail fast rather than dangling WebBluetooth state.
 */

/** BLE stand-in when the relay host session is backed by ATEM CCU on the server (no local GATT). */
export const nullBleCameraClient: CameraClient = {
  isSupported: true,
  isConnected: false,
  autoReconnectEnabled: false,
  async connect(): Promise<ConnectionState> {
    throw new Error("Bluetooth is not used for ATEM CCU relay hosting.");
  },
  disconnect(): void {},
  async writeCommand(_packet: Uint8Array): Promise<void> {},
  async triggerPairing(): Promise<void> {},
  async setPower(_on: boolean): Promise<void> {},
  setAutoReconnect(_enabled: boolean): void {},
};
