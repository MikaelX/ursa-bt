/** Shared contract used by BLE client and relay-join shim. */
import type { ConnectionState } from "../blackmagic/bleClient";

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
