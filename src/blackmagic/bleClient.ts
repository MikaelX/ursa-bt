import {
  BLACKMAGIC_CAMERA_SERVICE,
  CAMERA_STATUS_CHARACTERISTIC,
  DEVICE_NAME_CHARACTERISTIC,
  INCOMING_CAMERA_CONTROL_CHARACTERISTIC,
  OUTGOING_CAMERA_CONTROL_CHARACTERISTIC,
} from "./constants";
import { decodeCameraStatusDataView, type CameraStatus } from "./status";

export interface BluetoothLike {
  requestDevice(options: RequestDeviceOptions): Promise<BluetoothDeviceLike>;
  getDevices?: () => Promise<BluetoothDeviceLike[]>;
}

export interface BluetoothDeviceLike extends EventTarget {
  id: string;
  name?: string;
  gatt?: BluetoothRemoteGATTServerLike;
}

export interface BluetoothRemoteGATTServerLike {
  connected: boolean;
  connect(): Promise<BluetoothRemoteGATTServerLike>;
  disconnect(): void;
  getPrimaryService(service: string): Promise<BluetoothRemoteGATTServiceLike>;
}

export interface BluetoothRemoteGATTServiceLike {
  getCharacteristic(characteristic: string): Promise<BluetoothRemoteGATTCharacteristicLike>;
}

export interface BluetoothRemoteGATTCharacteristicLike extends EventTarget {
  value?: DataView;
  startNotifications(): Promise<BluetoothRemoteGATTCharacteristicLike>;
  writeValue(value: Uint8Array): Promise<void>;
  writeValueWithResponse?: (value: Uint8Array) => Promise<void>;
  writeValueWithoutResponse?: (value: Uint8Array) => Promise<void>;
}

export interface RequestDeviceOptions {
  filters: Array<{ services: string[] }>;
  optionalServices: string[];
}

export interface BlackmagicBleClientOptions {
  bluetooth?: BluetoothLike;
  onStatus?: (status: CameraStatus) => void;
  onIncomingControl?: (data: DataView) => void;
  onDisconnect?: () => void;
  onLog?: (message: string) => void;
  onReconnectScheduled?: (delayMs: number, attempt: number) => void;
  onReconnectAttempt?: (attempt: number) => void;
  onReconnectSucceeded?: (state: ConnectionState) => void;
  onReconnectFailed?: (attempt: number, error: unknown) => void;
  controllerName?: string;
  autoReconnect?: boolean;
  setTimeout?: (callback: () => void, delayMs: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface ConnectionState {
  deviceId: string;
  deviceName: string;
  connected: boolean;
}

const RECONNECT_DELAYS_MS = [2000, 4000, 8000, 16000, 30000];

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

  setAutoReconnect(enabled: boolean): void {
    this.autoReconnect = enabled;
    if (!enabled) {
      this.cancelPendingReconnect();
    }
  }

  get autoReconnectEnabled(): boolean {
    return this.autoReconnect;
  }

  get isSupported(): boolean {
    return Boolean(this.bluetooth);
  }

  get isConnected(): boolean {
    return Boolean(this.server?.connected);
  }

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

  disconnect(): void {
    this.explicitDisconnect = true;
    this.cancelPendingReconnect();
    this.server?.disconnect();
    this.clearConnection();
  }

  async writeCommand(packet: Uint8Array): Promise<void> {
    if (!this.outgoingControl) {
      throw new Error("Outgoing camera control characteristic is not ready.");
    }

    await writeCharacteristic(this.outgoingControl, packet);
  }

  async triggerPairing(): Promise<void> {
    await this.setPower(true);
  }

  async setPower(on: boolean): Promise<void> {
    if (!this.cameraStatus) {
      throw new Error("Camera status characteristic is not ready.");
    }

    await writeCharacteristic(this.cameraStatus, Uint8Array.of(on ? 0x01 : 0x00));
  }

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
    this.onDisconnect?.();

    if (!this.explicitDisconnect && this.autoReconnect && this.device) {
      this.scheduleReconnect();
    }
  };

  private clearConnection(): void {
    this.incomingControl?.removeEventListener("characteristicvaluechanged", this.handleIncomingControl);
    this.cameraStatus?.removeEventListener("characteristicvaluechanged", this.handleStatus);
    this.server = undefined;
    this.outgoingControl = undefined;
    this.incomingControl = undefined;
    this.cameraStatus = undefined;
    this.deviceName = undefined;
  }

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
      deviceId: this.device.id,
      deviceName: this.device.name ?? "Unknown Blackmagic Camera",
      connected: this.isConnected,
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;

    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempts, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
    const attemptNumber = this.reconnectAttempts + 1;

    this.log(`Auto-reconnect: scheduling attempt ${attemptNumber} in ${(delay / 1000).toFixed(0)}s`);
    this.onReconnectScheduled?.(delay, attemptNumber);

    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, delay);
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

  private cancelPendingReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      this.clearTimeoutImpl(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.reconnectAttempts = 0;
  }

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

export function isWebBluetoothSupported(): boolean {
  return Boolean(getNavigatorBluetooth());
}

function writeCharacteristic(
  characteristic: BluetoothRemoteGATTCharacteristicLike,
  value: Uint8Array,
): Promise<void> {
  if (characteristic.writeValueWithResponse) {
    return characteristic.writeValueWithResponse(value);
  }

  return characteristic.writeValue(value);
}

function characteristicValueFromEvent(event: Event): DataView | undefined {
  const characteristic = event.target as BluetoothRemoteGATTCharacteristicLike | null;
  return characteristic?.value;
}

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

function getNavigatorBluetooth(): BluetoothLike | undefined {
  return (globalThis.navigator as { bluetooth?: BluetoothLike } | undefined)?.bluetooth;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
