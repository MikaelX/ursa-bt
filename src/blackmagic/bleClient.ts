import {
  BLACKMAGIC_CAMERA_SERVICE,
  CAMERA_STATUS_CHARACTERISTIC,
  DEVICE_NAME_CHARACTERISTIC,
  INCOMING_CAMERA_CONTROL_CHARACTERISTIC,
  OUTGOING_CAMERA_CONTROL_CHARACTERISTIC,
  BLE_AUTO_RECONNECT_INTERVAL_MS,
} from "./constants";
import { decodeCameraStatusDataView, type CameraStatus } from "./status";

/**
 * @file bleClient.ts
 *
 * bm-bluetooth — Web Bluetooth GATT wiring for Blackmagic cameras: pairing, handshake,
 * outgoing command packets, subscribed status/autofocus telemetry, and auto-reconnect.
 *
 * See `docs/BlackmagicCameraControl.pdf` for protocol framing; GATT UUIDs live in `./constants`.
 *
 * This repository is **private**; no SPDX license identifier is declared in `package.json`.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Web Bluetooth–shaped types (narrow enough for typed tests without bundling typings)
// ─────────────────────────────────────────────────────────────────────────────

/** Minimal navigator.bluetooth API surface used here (also mockable for unit tests). */
export interface BluetoothLike {
  /** Chrome / Edge device chooser bounded by advertised service UUIDs. */
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDeviceLike>;
  /** Silent reconnect helper (may require `#enable-web-bluetooth-new-permissions-backend`). */
  getDevices?: () => Promise<BluetoothDeviceLike[]>;
}

/** Subset of `BluetoothDevice` events and fields required for GATT. */
export interface BluetoothDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServerLike;
}

/** Narrow GATT server view for handshake + teardown. */
export interface BluetoothRemoteGATTServerLike {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTServiceLike>;
}

export interface BluetoothRemoteGATTServiceLike {
  getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

/** Characteristic with notification + firmware-specific write quirks. */
export interface BluetoothRemoteGATTCharacteristicLike extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  writeValue(value: Uint8Array): Promise<void>;
  writeValueWithResponse?: (value: Uint8Array) => Promise<void>;
  writeValueWithoutResponse?: (value: Uint8Array) => Promise<void>;
}

/** Filter sent to Chromium’s picker; restricts to advertised Blackmagic service. */
export interface RequestDeviceOptions {
  filters: Array<{ services: string[] }>;
  optionalServices: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Callback / configuration hooks
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Constructor options tuning logging, telemetry fan-out, and reconnect policy.
 *
 * Pass `bluetooth`, `setTimeout`, and `clearTimeout` stubs to simulate hardware in isolation.
 */
export interface BlackmagicBleClientOptions {
  bluetooth?: BluetoothLike;
  /** Emits decoded {@link CameraStatus} frames from subscribed notifications. */
  onStatus?: (status: CameraStatus) => void;
  /** Raw vendor packets from Incoming Camera Control characteristic. */
  onIncomingControl?: (data: DataView) => void;
  /** Surface-level disconnect notifications (silent drop or explicit disconnect). */
  onDisconnect?: () => void;
  onLog?: (message: string) => void;
  onReconnectScheduled?: (delayMs: number, attempt: number) => void;
  onReconnectAttempt?: (attempt: number) => void;
  onReconnectSucceeded?: (state: ConnectionState) => void;
  onReconnectFailed?: (attempt: number, error: unknown) => void;
  /** Stored on camera via Device Name characteristic (truncated internally). */
  controllerName?: string;
  /** When true (default), replays handshake after unsolicited GATT disconnect. */
  autoReconnect?: boolean;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

/** Snapshot surfaced to UI/state stores after handshake success. */
export interface ConnectionState {
  deviceId: string;
  deviceName: string;
  connected: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// BlackmagicBleClient
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stateful Web Bluetooth façade for pairing and streaming Blackmagic command channels.
 *
 * @remarks Lifecycle: call {@link BlackmagicBleClient.connect} after user gesture, or
 * {@link BlackmagicBleClient.tryRestoreConnection} on reload once permissions exist.
 * Tear down deliberately with {@link BlackmagicBleClient.disconnect} to suppress auto reconnect.
 */
export class BlackmagicBleClient {
  private readonly bluetooth?: BluetoothLike;
  private readonly onStatus?: (status: CameraStatus) => void;
  private readonly onIncomingControl?: (data: DataView) => void;
  private readonly onDisconnect?: () => void;
  private readonly onLog?: (message: string) => void;
  private readonly onReconnectScheduled?: (delayMs: number, attempt: number) => void;
  private readonly onReconnectAttempt?: (attempt: number) => void;
  private readonly onReconnectSucceeded?: (state: ConnectionState) => void;
  private readonly onReconnectFailed?: (attempt: number, error: unknown) => void;
  private readonly controllerName: string;
  private readonly setTimeoutImpl: (callback: () => void, delayMs: number) => unknown;
  private readonly clearTimeoutImpl: (handle: unknown) => void;

  private device?: BluetoothDeviceLike;
  private server?: BluetoothRemoteGATTServerLike;
  private outgoingControl?: BluetoothRemoteGATTCharacteristicLike;
  private incomingControl?: BluetoothRemoteGATTCharacteristicLike;
  private cameraStatus?: BluetoothRemoteGATTCharacteristicLike;
  private deviceName?: BluetoothRemoteGATTCharacteristicLike;

  private autoReconnect: boolean;
  private explicitDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = undefined;

  /**
   * Wires observers and resolves browser APIs (`navigator.bluetooth`) unless overridden for tests.
   */
  constructor(options: BlackmagicBleClientOptions = {}) {
    this.bluetooth = options.bluetooth ?? getNavigatorBluetooth();
    this.onStatus = options.onStatus;
    this.onIncomingControl = options.onIncomingControl;
    this.onDisconnect = options.onDisconnect;
    this.onLog = options.onLog;
    this.onReconnectScheduled = options.onReconnectScheduled;
    this.onReconnectAttempt = options.onReconnectAttempt;
    this.onReconnectSucceeded = options.onReconnectSucceeded;
    this.onReconnectFailed = options.onReconnectFailed;
    this.controllerName = options.controllerName ?? "BM Bluetooth Web";
    this.autoReconnect = options.autoReconnect ?? true;
    this.setTimeoutImpl = options.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  }

  /**
   * Toggles exponential-less fixed-interval auto reconnect loops.
   * Disabling clears any pending timers without touching an active physical link.
   */
  setAutoReconnect(enabled: boolean): void {
    this.autoReconnect = enabled;
    if (!enabled) {
      this.cancelPendingReconnect();
    }
  }

  get autoReconnectEnabled(): boolean {
    return this.autoReconnect;
  }

  /** True when navigator exposes Web Bluetooth primitives. */
  get isSupported(): boolean {
    return Boolean(this.bluetooth);
  }

  /** Mirrors `GattConnected` heuristic using cached server reference post-handshake. */
  get isConnected(): boolean {
    return Boolean(this.server?.connected);
  }

  // --- Connection entry points (chooser vs silent reconnect) ---

  /**
   * Displays the Chromium Bluetooth chooser constrained to advertised Blackmagic service UUID,
   * then performs full GATT handshake and notification setup.
   *
   * @returns Fresh {@link ConnectionState} identifiers for UX + persistence helpers.
   * @throws When Web Bluetooth is absent or handshake fails mid-flight.
   */
  async connect(): Promise<ConnectionState> {
    if (!this.bluetooth) {
      throw new Error("Web Bluetooth is not available in this browser.");
    }

    this.cancelPendingReconnect();
    this.explicitDisconnect = false;

    this.log("Opening Chrome Bluetooth device chooser");
    this.device = await this.bluetooth.requestDevice({
      filters: [{ services: [BLACKMAGIC_CAMERA_SERVICE] }],
      optionalServices: [BLACKMAGIC_CAMERA_SERVICE],
    });

    this.device.addEventListener("gattserverdisconnected", this.handleDisconnect);

    this.log(`Selected ${this.device.name ?? "unnamed Bluetooth device"}`);
    return this.runHandshake();
  }

  /**
   * Attempts handshake against previously paired devices without user gesture (`getDevices`).
   *
   * @returns Undefined when unsupported, unavailable, or no candidate responds cleanly.
   * @remarks Prefer enabling Chrome flag `#enable-web-bluetooth-new-permissions-backend`; otherwise silently returns logs only.
   */
  async tryRestoreConnection(): Promise<ConnectionState | undefined> {
    if (!this.bluetooth?.getDevices) {
      this.log(
        "navigator.bluetooth.getDevices() unavailable - enable chrome://flags/#enable-web-bluetooth-new-permissions-backend to allow silent reconnect on reload",
      );
      return undefined;
    }

    let devices: BluetoothDeviceLike[];
    try {
      devices = await this.bluetooth.getDevices();
    } catch (error) {
      this.log(`Could not list previously paired devices: ${errorMessage(error)}`);
      return undefined;
    }

    if (devices.length === 0) {
      this.log("No previously paired Bluetooth devices found");
      return undefined;
    }

    this.cancelPendingReconnect();
    this.explicitDisconnect = false;

    for (const device of devices) {
      if (!device.gatt) continue;

      this.log(`Attempting silent reconnect to ${device.name ?? device.id}`);
      this.device = device;
      device.addEventListener("gattserverdisconnected", this.handleDisconnect);

      try {
        return await this.runHandshake();
      } catch (error) {
        this.log(`Silent reconnect to ${device.name ?? device.id} failed: ${errorMessage(error)}`);
        device.removeEventListener("gattserverdisconnected", this.handleDisconnect);
        this.clearConnection();
        this.device = undefined;
      }
    }

    this.log("Silent reconnect: no paired device responded; click Connect to pair manually");
    return undefined;
  }

  /** Idempotent teardown: stops reconnect scheduling, emits UI hooks, resets characteristics. */
  disconnect(): void {
    this.explicitDisconnect = true;
    this.cancelPendingReconnect();
    this.server?.disconnect();
    this.clearConnection();
    this.onDisconnect?.();
  }

  /**
   * Serializes arbitrary camera command payloads outbound on Outgoing characteristic.
   * @throws Before handshake resolves outgoing handle.
   */
  async writeCommand(packet: Uint8Array): Promise<void> {
    if (!this.outgoingControl) {
      throw new Error("Outgoing camera control characteristic is not ready.");
    }

    await writeCharacteristic(this.outgoingControl, packet);
  }

  /**
   * Legacy helper to provoke pairing dialogs by toggling standby bit on status characteristic.
   * @remarks Prefer documenting camera-side PIN UX in product manuals; BLE stack must be subscribed.
   */
  async triggerPairing(): Promise<void> {
    await this.setPower(true);
  }

  /**
   * Vendor-specific power/standby bit write on Camera Status characteristic.
   *
   * @param on `0x01` powers transceiver-facing path; `0x00` soft-off path.
   * @throws If notifications setup has not progressed far enough yet.
   */
  async setPower(on: boolean): Promise<void> {
    if (!this.cameraStatus) {
      throw new Error("Camera status characteristic is not ready.");
    }

    await writeCharacteristic(this.cameraStatus, Uint8Array.of(on ? 0x01 : 0x00));
  }

  // --- Notification plumbing ---

  private async startNotifications(): Promise<void> {
    if (!this.incomingControl || !this.cameraStatus) {
      throw new Error("Camera notification characteristics are not ready.");
    }

    this.incomingControl.addEventListener("characteristicvaluechanged", this.handleIncomingControl);
    this.cameraStatus.addEventListener("characteristicvaluechanged", this.handleStatus);

    await this.incomingControl.startNotifications();
    await this.cameraStatus.startNotifications();
  }

  private readonly handleIncomingControl = (event: Event): void => {
    const value = characteristicValueFromEvent(event);

    if (value) {
      this.onIncomingControl?.(value);
    }
  };

  private readonly handleStatus = (event: Event): void => {
    const value = characteristicValueFromEvent(event);

    if (value) {
      this.onStatus?.(decodeCameraStatusDataView(value));
    }
  };

  private readonly handleDisconnect = (): void => {
    this.clearConnection();
    if (!this.explicitDisconnect) {
      this.onDisconnect?.();
    }

    if (!this.explicitDisconnect && this.autoReconnect && this.device) {
      this.scheduleReconnect();
    }
  };

  /** Clears JS references + event listeners—does not forcibly dispose OS-level bonding. */
  private clearConnection(): void {
    this.incomingControl?.removeEventListener("characteristicvaluechanged", this.handleIncomingControl);
    this.cameraStatus?.removeEventListener("characteristicvaluechanged", this.handleStatus);
    this.server = undefined;
    this.outgoingControl = undefined;
    this.incomingControl = undefined;
    this.cameraStatus = undefined;
    this.deviceName = undefined;
  }

  /**
   * Discovers UUIDs under Blackmagic Camera Service, enables notifications,
   * writes preferred controller moniker, primes pairing handshake artifact.
   */
  private async runHandshake(): Promise<ConnectionState> {
    if (!this.device) {
      throw new Error("No Bluetooth device selected.");
    }

    if (!this.device.gatt) {
      throw new Error("Selected Bluetooth device does not expose GATT.");
    }

    this.server = await this.device.gatt.connect();
    this.log("GATT connected");

    const service = await this.server.getPrimaryService(BLACKMAGIC_CAMERA_SERVICE);
    this.log("Blackmagic Camera Service found");

    this.outgoingControl = await service.getCharacteristic(OUTGOING_CAMERA_CONTROL_CHARACTERISTIC);
    this.incomingControl = await service.getCharacteristic(INCOMING_CAMERA_CONTROL_CHARACTERISTIC);
    this.cameraStatus = await service.getCharacteristic(CAMERA_STATUS_CHARACTERISTIC);
    this.deviceName = await getOptionalCharacteristic(service, DEVICE_NAME_CHARACTERISTIC);
    this.log("Camera control characteristics ready");

    await this.startNotifications();
    this.log("Notifications started");

    await this.writeControllerName();
    await this.triggerPairing();
    this.log("Camera Status 0x01 written");

    return {
      deviceId: deriveDeviceId(this.device),
      deviceName: this.device.name ?? "Unknown Blackmagic Camera",
      connected: this.isConnected,
    };
  }

  // --- Automatic reconnection backoff (fixed cadence via constants) ---

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;

    const attemptNumber = this.reconnectAttempts + 1;

    this.log(
      `Auto-reconnect: scheduling attempt ${attemptNumber} in ${(BLE_AUTO_RECONNECT_INTERVAL_MS / 1000).toFixed(0)}s`,
    );
    this.onReconnectScheduled?.(BLE_AUTO_RECONNECT_INTERVAL_MS, attemptNumber);

    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, BLE_AUTO_RECONNECT_INTERVAL_MS);
  }

  private async attemptReconnect(): Promise<void> {
    if (this.explicitDisconnect || !this.autoReconnect || !this.device) {
      return;
    }

    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    this.log(`Auto-reconnect: attempt ${attempt}`);
    this.onReconnectAttempt?.(attempt);

    try {
      const state = await this.runHandshake();
      this.reconnectAttempts = 0;
      this.log(`Auto-reconnect: succeeded on attempt ${attempt}`);
      this.onReconnectSucceeded?.(state);
    } catch (error) {
      this.log(`Auto-reconnect: attempt ${attempt} failed (${errorMessage(error)})`);
      this.onReconnectFailed?.(attempt, error);

      if (!this.explicitDisconnect && this.autoReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /** Clears backoff timer **and** attempt counter — used on successful manual connect too. */
  private cancelPendingReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
  }

  /** Best-effort write of truncated UTF-8 controller label for on-camera attribution. */
  private async writeControllerName(): Promise<void> {
    if (!this.deviceName) {
      this.log("Device Name characteristic unavailable");
      return;
    }

    const value = new TextEncoder().encode(this.controllerName.slice(0, 32));
    await writeCharacteristic(this.deviceName, value);
    this.log(`Controller name sent: ${this.controllerName}`);
  }

  private log(message: string): void {
    this.onLog?.(message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Browser capability probe + BLE helpers (module-local)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors {@link BluetoothLike} presence probe for feature gating banners.
 *
 * Must not throw; callable during module init diagnostics.
 */
export function isWebBluetoothSupported(): boolean {
  return Boolean(getNavigatorBluetooth());
}

/**
 * Sends payload using response-mode write when firmware advertises compatibility.
 * Fallback keeps legacy stacks working with `writeValue` default semantics.
 */
function writeCharacteristic(
  characteristic: BluetoothRemoteGATTCharacteristicLike,
  value: Uint8Array,
): Promise<void> {
  if (characteristic.writeValueWithResponse) {
    return characteristic.writeValueWithResponse(value);
  }

  return characteristic.writeValue(value);
}

/** Extract newest `value` snapshot from Chromium notification baton. */
function characteristicValueFromEvent(event: Event): DataView | undefined {
  const characteristic = event.target as BluetoothRemoteGATTCharacteristicLike | null;
  return characteristic?.value;
}

/** Swallows missing optional Device Information exposes without failing handshake. */
async function getOptionalCharacteristic(
  service: BluetoothRemoteGATTServiceLike,
  characteristic: string,
): Promise<BluetoothRemoteGATTCharacteristicLike | undefined> {
  try {
    return await service.getCharacteristic(characteristic);
  } catch {
    return undefined;
  }
}

/** Runtime guard for SSR / unsupported browsers returning `navigator` without bluetooth. */
function getNavigatorBluetooth(): BluetoothLike | undefined {
  return (globalThis.navigator as { bluetooth?: BluetoothLike } | undefined)?.bluetooth;
}

/** Normalizes catch branches for textual logging without leaking `unknown` internals. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Derive a stable storage key for a Bluetooth device.
 *
 * Web Bluetooth does not expose the actual BT MAC address (browsers anonymize
 * it with an origin-scoped opaque `device.id`). Blackmagic cameras, however,
 * advertise their MAC-suffix (e.g. "A:24C4E55C") as the BLE device name, which
 * is the closest stable identifier we can persist against.
 *
 * Prefer the advertised name; fall back to `device.id` if no name is exposed.
 */
function deriveDeviceId(device: BluetoothDeviceLike): string {
  const name = device.name?.trim();
  if (name && name.length > 0) {
    return name;
  }
  return device.id;
}
