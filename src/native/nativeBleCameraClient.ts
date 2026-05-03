import { Capacitor } from "@capacitor/core";
import {
  BleClient,
  type BleCharacteristic,
  type BleClientInterface,
  type BleService,
  type ScanResult,
  toArrayBufferDataView,
} from "@capacitor-community/bluetooth-le";
import {
  BLACKMAGIC_CAMERA_SERVICE,
  CAMERA_STATUS_CHARACTERISTIC,
  DEVICE_NAME_CHARACTERISTIC,
  INCOMING_CAMERA_CONTROL_CHARACTERISTIC,
  OUTGOING_CAMERA_CONTROL_CHARACTERISTIC,
  BLE_AUTO_RECONNECT_INTERVAL_MS,
} from "../blackmagic/constants";
import type { ConnectionState } from "../blackmagic/bleClient";
import { decodeCameraStatusDataView, type CameraStatus } from "../blackmagic/status";
import type { CameraClient } from "../ui/cameraClientTypes";
import { isNativeShell } from "./capacitorEnv";

/**
 * @file nativeBleCameraClient.ts
 *
 * bm-bluetooth — Capacitor / native **`@capacitor-community/bluetooth-le`** implementation of {@link CameraClient},
 * pairing the same UUID map as `./blackmagic/constants` with iOS/Android GATT quirks (scan UX, persisted peripheral ids).
 *
 * **Private** repo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Options & lowercase UUID shim (BLE stack lookups)
// ─────────────────────────────────────────────────────────────────────────────

export interface NativeBleCameraClientOptions {
  /** Injectable for tests; defaults to Capacitor {@link BleClient}. */
  ble?: BleClientInterface;
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

const SVC = BLACKMAGIC_CAMERA_SERVICE.toLowerCase();
const CHAR_OUT = OUTGOING_CAMERA_CONTROL_CHARACTERISTIC.toLowerCase();
const CHAR_IN = INCOMING_CAMERA_CONTROL_CHARACTERISTIC.toLowerCase();
const CHAR_STATUS = CAMERA_STATUS_CHARACTERISTIC.toLowerCase();
const CHAR_DEVNAME = DEVICE_NAME_CHARACTERISTIC.toLowerCase();

function normUuid(uuid: string): string {
  return uuid.trim().toLowerCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan heuristics + last-connected persistence (localStorage)
// ─────────────────────────────────────────────────────────────────────────────

/** True if this advertisement is likely a Blackmagic camera (service in adv payload or recognizable name). */
export function scanMatchesBlackmagicDiscovery(r: ScanResult): boolean {
  const nameCandidates = [r.localName, r.device?.name];
  for (const n of nameCandidates) {
    if (typeof n === "string" && bmCameraAdvertisedNameLooksLikely(n)) return true;
  }

  const uuidBuckets = [...(r.uuids ?? []), ...(r.device?.uuids ?? [])];
  if (uuidBuckets.some((u) => normUuid(u) === SVC)) return true;

  if (r.serviceData && typeof r.serviceData === "object") {
    for (const key of Object.keys(r.serviceData)) {
      if (normUuid(key) === SVC) return true;
    }
  }

  return false;
}

function bmCameraAdvertisedNameLooksLikely(name: string): boolean {
  const t = name.trim();
  if (t.length < 3) return false;

  const tokensNeedWordBoundary =
    /\b(blackmagic|ursa)\b/i.test(t) ||
    /\bpocket[^\w]?cinema\b/i.test(t) ||
    /\bcinema[^\w]?camera\b/i.test(t) ||
    /\bmicro[^\w]?cinema\b/i.test(t);

  const compactProductIds = /\b(BMCC|bmpcc|bmp4k|bmp6k|bmp6kpro)\b/i.test(t);

  return tokensNeedWordBoundary || compactProductIds;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const LAST_NATIVE_BLE_LS = "bm-last-native-ble-v1";

/** Persisted after a successful native GATT session for reload / “last camera” reconnect. */
export interface LastNativeBleSnapshot {
  peripheralId: string;
  nameHint?: string;
  logicalId: string;
}

export function readLastNativeBleSnapshot(): LastNativeBleSnapshot | undefined {
  if (typeof localStorage === "undefined") return undefined;
  try {
    const raw = localStorage.getItem(LAST_NATIVE_BLE_LS);
    if (!raw) return undefined;
    const o = JSON.parse(raw) as LastNativeBleSnapshot;
    if (typeof o.peripheralId !== "string" || !o.peripheralId) return undefined;
    if (typeof o.logicalId !== "string") return undefined;
    return o;
  } catch {
    return undefined;
  }
}

function writeLastNativeBleSnapshot(snapshot: LastNativeBleSnapshot): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LAST_NATIVE_BLE_LS, JSON.stringify(snapshot));
  } catch {
    /* quota / private mode */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Peripheral row model + BLE plumbing helpers
// ─────────────────────────────────────────────────────────────────────────────

function deriveDisplayDeviceId(deviceName: string | undefined, fallbackId: string): string {
  const name = deviceName?.trim();
  if (name && name.length > 0) return name;
  return fallbackId;
}

function uint8ToDataView(bytes: Uint8Array): DataView {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new DataView(copy.buffer);
}

function scanResultToHit(r: ScanResult): NativeBleScanHit {
  const nameGuess = [r.localName, r.device.name].find((s) => typeof s === "string" && s.trim().length > 0)?.trim();
  const rssi = typeof r.rssi === "number" ? r.rssi : undefined;
  const tail =
    typeof r.device.deviceId === "string" && r.device.deviceId.includes("-")
      ? r.device.deviceId.split("-").pop()
      : r.device.deviceId?.slice?.(0, 8);
  let label = nameGuess ?? `Unknown · ${tail ?? "BLE"}`;
  if (rssi !== undefined && !label.includes("dBm")) {
    label += ` · ${rssi} dBm`;
  }
  return { deviceId: r.device.deviceId, label, rssi };
}

function connectedBleDeviceToHit(device: { deviceId: string; name?: string }): NativeBleScanHit {
  const nameGuess = device.name?.trim();
  const tail =
    device.deviceId.includes("-") ? device.deviceId.split("-").pop() : device.deviceId.slice(0, 8);
  const label = nameGuess
    ? `${nameGuess} · on this phone`
    : `Bluetooth · ${tail ?? device.deviceId} · on this phone — tap`;
  return { deviceId: device.deviceId, label, linkedOnPhone: true };
}

/** One row in the in-app “Found devices” list (native scan). */
export interface NativeBleScanHit {
  deviceId: string;
  label: string;
  rssi?: number;
  linkedOnPhone?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Service discovery helpers
// ─────────────────────────────────────────────────────────────────────────────

function findCharacteristic(services: BleService[], characteristicUuid: string): BleCharacteristic | undefined {
  const chUuid = normUuid(characteristicUuid);
  for (const service of services) {
    if (normUuid(service.uuid) !== normUuid(BLACKMAGIC_CAMERA_SERVICE)) continue;
    const ch = service.characteristics.find((c) => normUuid(c.uuid) === chUuid);
    if (ch) return ch;
  }
  return undefined;
}

async function writeCharacteristicValue(
  ble: BleClientInterface,
  deviceId: string,
  services: BleService[],
  characteristicUuid: string,
  bytes: Uint8Array,
): Promise<void> {
  const ch = findCharacteristic(services, characteristicUuid);
  const dv = toArrayBufferDataView(uint8ToDataView(bytes));
  if (ch?.properties.write) {
    await ble.write(deviceId, SVC, normUuid(characteristicUuid), dv);
    return;
  }
  if (ch?.properties.writeWithoutResponse) {
    await ble.writeWithoutResponse(deviceId, SVC, normUuid(characteristicUuid), dv);
    return;
  }
  await ble.write(deviceId, SVC, normUuid(characteristicUuid), dv);
}

/**
 * {@link CameraClient} for Capacitor using `@capacitor-community/bluetooth-le` (CoreBluetooth / Android GATT).
 */
export class NativeBleCameraClient implements CameraClient {
  private readonly ble: BleClientInterface;
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

  private autoReconnect: boolean;
  private explicitDisconnect = false;
  private reconnectAttempts = 0;
  private reconnectTimer: unknown = undefined;

  private bleInitialized = false;
  private notificationsActive = false;
  private connected = false;
  /** True while `requestLEScan` is active (in-app Found devices list). */
  private discovering = false;
  /** Opaque peripheral id from the OS; retained across unexpected disconnect for `getDevices` reconnect. */
  private gattDeviceId: string | undefined;
  private lastAdvertisedName: string | undefined;
  private cachedServices: BleService[] | undefined;

  constructor(options: NativeBleCameraClientOptions = {}) {
    this.ble = options.ble ?? BleClient;
    this.onStatus = options.onStatus;
    this.onIncomingControl = options.onIncomingControl;
    this.onDisconnect = options.onDisconnect;
    this.onLog = options.onLog;
    this.onReconnectScheduled = options.onReconnectScheduled;
    this.onReconnectAttempt = options.onReconnectAttempt;
    this.onReconnectSucceeded = options.onReconnectSucceeded;
    this.onReconnectFailed = options.onReconnectFailed;
    this.controllerName = options.controllerName ?? "BM Bluetooth Native";
    this.autoReconnect = options.autoReconnect ?? true;
    this.setTimeoutImpl = options.setTimeout ?? ((cb, ms) => globalThis.setTimeout(cb, ms));
    this.clearTimeoutImpl = options.clearTimeout ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>));
  }

  get isSupported(): boolean {
    return isNativeShell();
  }

  get isConnected(): boolean {
    return this.connected;
  }

  get autoReconnectEnabled(): boolean {
    return this.autoReconnect;
  }

  setAutoReconnect(enabled: boolean): void {
    this.autoReconnect = enabled;
    if (!enabled) this.cancelPendingReconnect();
  }

  get isScanningBle(): boolean {
    return this.discovering;
  }

  /**
   * Continuous scan for the in-app list. Stops when {@link stopBleScan} runs, you connect, or leave the Connect view.
   * Broad scan (no advertised service filter); still pass `optionalServices` for Web-style discovery hints.
   * Only devices that advertise the BM service UUID or match a recognizable camera name surface in callbacks.
   */
  async startBleScan(onHit: (hit: NativeBleScanHit) => void): Promise<void> {
    if (!this.isSupported) return;
    await this.ensureBleInitialized();
    await this.stopBleScanQuiet();
    this.discovering = true;
    this.log("Native BLE: LE scan (in-app Found devices)");

    await this.ble.requestLEScan({ optionalServices: [SVC], allowDuplicates: false }, (result) => {
      if (!this.discovering) return;
      if (!scanMatchesBlackmagicDiscovery(result)) return;
      onHit(scanResultToHit(result));
    });

    try {
      const cds = await this.ble.getConnectedDevices([BLACKMAGIC_CAMERA_SERVICE]).catch(() => []);
      if (!this.discovering) return;
      const seen = new Set<string>();
      for (const d of cds ?? []) {
        if (seen.has(d.deviceId)) continue;
        seen.add(d.deviceId);
        onHit(connectedBleDeviceToHit(d));
      }
    } catch {
      /* ignore */
    }
  }

  async stopBleScan(): Promise<void> {
    await this.stopBleScanQuiet();
  }

  private async stopBleScanQuiet(): Promise<void> {
    if (!this.discovering) return;
    this.discovering = false;
    await this.ble.stopLEScan().catch(() => {});
  }

  /** Connect without the OS picker — use a `deviceId` from {@link startBleScan}. */
  async connectToScannedDevice(deviceId: string, advertisedNameHint?: string): Promise<ConnectionState> {
    const id = deviceId.trim();
    if (!id) throw new Error("Missing Bluetooth device id.");
    await this.prepareBleSessionPick();
    this.log(`Native BLE: connect to scanned device (${advertisedNameHint?.trim() || id})`);
    return this.finalizeSession(id, advertisedNameHint);
  }

  private async prepareBleSessionPick(): Promise<void> {
    if (!this.isSupported) {
      throw new Error("Native BLE transport is only available inside the Capacitor shell.");
    }
    this.cancelPendingReconnect();
    this.explicitDisconnect = false;
    await this.stopBleScanQuiet();
    await this.ensureBleInitialized();
    await this.stopGattNotificationsQuiet();
    if (this.gattDeviceId) {
      const prev = this.gattDeviceId;
      this.gattDeviceId = undefined;
      this.cachedServices = undefined;
      await this.ble.disconnect(prev).catch(() => {});
    }
  }

  async connect(): Promise<ConnectionState> {
    await this.prepareBleSessionPick();

    this.log("Native BLE: scan / pick camera (Broad LE scan — pick your Blackmagic device)");
    // iOS/Android: do **not** filter by advertised service UUID — many BM cameras omit the
    // Camera Control UUID from connectable adverts, so a service-filtered scan sees nothing.
    // GATT discovery after connect still requires the BM service characteristics.
    const device = await this.ble.requestDevice({
      optionalServices: [SVC],
      ...(Capacitor.getPlatform() === "ios" ? { displayMode: "list" as const } : {}),
    });

    return this.finalizeSession(device.deviceId, device.name);
  }

  disconnect(): void {
    this.explicitDisconnect = true;
    this.cancelPendingReconnect();
    void this.stopBleScanQuiet();
    this.connected = false;
    const peripheralId = this.gattDeviceId;
    void this.stopGattNotificationsQuiet()
      .catch(() => {})
      .finally(() => {
        this.cachedServices = undefined;
        if (peripheralId) void this.ble.disconnect(peripheralId).catch(() => {});
        this.gattDeviceId = undefined;
        this.onDisconnect?.();
      });
  }

  async writeCommand(packet: Uint8Array): Promise<void> {
    const id = this.gattDeviceId;
    const services = this.cachedServices;
    if (!id || !services?.length) {
      throw new Error("Outgoing camera control characteristic is not ready.");
    }
    await writeCharacteristicValue(this.ble, id, services, CHAR_OUT, packet);
  }

  async triggerPairing(): Promise<void> {
    await this.setPower(true);
  }

  async setPower(on: boolean): Promise<void> {
    const id = this.gattDeviceId;
    const services = this.cachedServices;
    if (!id || !services?.length) {
      throw new Error("Camera status characteristic is not ready.");
    }
    await writeCharacteristicValue(this.ble, id, services, CHAR_STATUS, Uint8Array.of(on ? 0x01 : 0x00));
  }

  async tryRestoreConnection(): Promise<ConnectionState | undefined> {
    const snap = readLastNativeBleSnapshot();
    if (!snap?.peripheralId) return undefined;
    try {
      this.log(`Native BLE: restoring last camera (${snap.nameHint ?? snap.logicalId})`);
      return await this.connectToScannedDevice(snap.peripheralId, snap.nameHint);
    } catch (error) {
      this.log(`Native BLE: restore last camera failed (${errorMessage(error)})`);
      return undefined;
    }
  }

  private log(message: string): void {
    this.onLog?.(message);
  }

  private async ensureBleInitialized(): Promise<void> {
    if (this.bleInitialized) return;
    try {
      await this.ble.initialize({
        androidNeverForLocation: true,
      });
    } catch (error) {
      const msg = errorMessage(error);
      if (/BLE unsupported/i.test(msg)) {
        throw new Error(
          "Bluetooth LE is unavailable in this environment (iOS Simulator has no BLE). Use a physical iPhone for camera BLE, or use Join to test relay/UI.",
        );
      }
      throw error;
    }
    this.bleInitialized = true;
  }

  private readonly handleBleDisconnected = (disconnectedId: string): void => {
    if (disconnectedId !== this.gattDeviceId) return;
    void this.stopGattNotificationsQuiet().finally(() => {
      this.connected = false;
      this.cachedServices = undefined;
      this.notificationsActive = false;
      if (!this.explicitDisconnect) {
        this.onDisconnect?.();
      }

      if (!this.explicitDisconnect && this.autoReconnect && this.lastDeviceIdKnown()) {
        this.scheduleReconnect();
      }
    });
  };

  private lastDeviceIdKnown(): boolean {
    return Boolean(this.gattDeviceId ?? undefined);
  }

  private async finalizeSession(deviceId: string, advertisedName?: string): Promise<ConnectionState> {
    this.gattDeviceId = deviceId;
    this.lastAdvertisedName = advertisedName;

    await this.ble.connect(deviceId, (id) => this.handleBleDisconnected(id));

    if (Capacitor.getPlatform() === "android") {
      try {
        await this.ble.createBond(deviceId);
      } catch (e) {
        this.log(`Native BLE: createBond: ${errorMessage(e)}`);
      }
    }

    await this.ble.startNotifications(deviceId, SVC, CHAR_IN, (value) => {
      const dv = toArrayBufferDataView(value);
      this.onIncomingControl?.(dv);
    });

    await this.ble.startNotifications(deviceId, SVC, CHAR_STATUS, (value) => {
      const dv = toArrayBufferDataView(value);
      this.onStatus?.(decodeCameraStatusDataView(dv));
    });
    this.notificationsActive = true;

    this.cachedServices = await this.ble.getServices(deviceId);

    try {
      const ch = findCharacteristic(this.cachedServices, CHAR_DEVNAME);
      if (ch?.properties.write || ch?.properties.writeWithoutResponse) {
        const enc = new TextEncoder().encode(this.controllerName.slice(0, 32));
        await writeCharacteristicValue(this.ble, deviceId, this.cachedServices, CHAR_DEVNAME, enc);
        this.log(`Native BLE: controller name sent (${this.controllerName})`);
      } else {
        this.log("Native BLE: device name characteristic unavailable — skipping");
      }
    } catch {
      this.log("Native BLE: controller name write failed — continuing");
    }

    await writeCharacteristicValue(this.ble, deviceId, this.cachedServices, CHAR_STATUS, Uint8Array.of(0x01));

    this.connected = true;

    const deviceName = advertisedName?.trim() || "Unknown Blackmagic Camera";
    const logicalId = deriveDisplayDeviceId(advertisedName, deviceId);

    writeLastNativeBleSnapshot({
      peripheralId: deviceId,
      nameHint: deviceName,
      logicalId,
    });

    return {
      deviceId: logicalId,
      deviceName,
      connected: true,
    };
  }

  private async stopGattNotificationsQuiet(): Promise<void> {
    if (!this.notificationsActive || !this.gattDeviceId) return;
    const id = this.gattDeviceId;
    try {
      await this.ble.stopNotifications(id, SVC, CHAR_IN);
    } catch {
      /* ignore */
    }
    try {
      await this.ble.stopNotifications(id, SVC, CHAR_STATUS);
    } catch {
      /* ignore */
    }
    this.notificationsActive = false;
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== undefined) return;

    const attemptNumber = this.reconnectAttempts + 1;

    this.log(
      `Native BLE auto-reconnect: scheduling attempt ${attemptNumber} in ${(BLE_AUTO_RECONNECT_INTERVAL_MS / 1000).toFixed(0)}s`,
    );
    this.onReconnectScheduled?.(BLE_AUTO_RECONNECT_INTERVAL_MS, attemptNumber);

    this.reconnectTimer = this.setTimeoutImpl(() => {
      this.reconnectTimer = undefined;
      void this.attemptReconnect();
    }, BLE_AUTO_RECONNECT_INTERVAL_MS);
  }

  private async attemptReconnect(): Promise<void> {
    const savedId = this.gattDeviceId;
    if (this.explicitDisconnect || !this.autoReconnect || !savedId) return;

    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    this.log(`Native BLE auto-reconnect: attempt ${attempt}`);
    this.onReconnectAttempt?.(attempt);

    try {
      await this.ensureBleInitialized();
      await this.stopGattNotificationsQuiet();

      const devices = await this.ble.getDevices([savedId]);
      const device = devices[0];
      if (!device) {
        throw new Error("Previously selected Bluetooth device was not found.");
      }

      const state = await this.finalizeSession(device.deviceId, device.name ?? this.lastAdvertisedName);
      this.reconnectAttempts = 0;
      this.onReconnectSucceeded?.(state);
      this.log(`Native BLE auto-reconnect: succeeded on attempt ${attempt}`);
    } catch (error) {
      this.log(`Native BLE auto-reconnect: attempt ${attempt} failed (${errorMessage(error)})`);
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
}
