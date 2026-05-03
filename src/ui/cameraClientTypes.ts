import type { ConnectionState } from "../blackmagic/bleClient";

/**
 * @file cameraClientTypes.ts
 *
 * bm-bluetooth — Narrow transport interface shared by Chromium WebBluetooth, Capacitor native BLE, relay join stubs, etc.
 */

/** Commands + lifecycle slots common to BLE + relay transports. */
export interface CameraClient {
  readonly isSupported: boolean;
  readonly isConnected: boolean;
  readonly autoReconnectEnabled: boolean;
  connect(): Promise<ConnectionState>;
  disconnect(): void;
  writeCommand(packet: Uint8Array): Promise<void>;
  triggerPairing(): Promise<void>;
  setPower(on: boolean): Promise<void>;
  setAutoReconnect(enabled: boolean): void;
  tryRestoreConnection?(): Promise<ConnectionState | undefined>;
}
