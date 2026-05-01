import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BLACKMAGIC_CAMERA_SERVICE,
  CAMERA_STATUS_CHARACTERISTIC,
  DEVICE_NAME_CHARACTERISTIC,
  INCOMING_CAMERA_CONTROL_CHARACTERISTIC,
  OUTGOING_CAMERA_CONTROL_CHARACTERISTIC,
} from "./constants";
import {
  BlackmagicBleClient,
  type BluetoothDeviceLike,
  type BluetoothLike,
  type BluetoothRemoteGATTCharacteristicLike,
  type BluetoothRemoteGATTServerLike,
  type BluetoothRemoteGATTServiceLike,
} from "./bleClient";

class MockCharacteristic
  extends EventTarget
  implements BluetoothRemoteGATTCharacteristicLike
{
  value?: DataView;
  readonly startNotifications = vi.fn(async () => this);
  readonly writeValue = vi.fn(async () => undefined);
  readonly writeValueWithResponse = vi.fn(async () => undefined);
  readonly writeValueWithoutResponse = vi.fn(async () => undefined);

  emit(value: number[]): void {
    this.value = new DataView(Uint8Array.from(value).buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class MockDevice extends EventTarget implements BluetoothDeviceLike {
  readonly id = "device-1";
  readonly name = "URSA Broadcast";

  constructor(readonly gatt: BluetoothRemoteGATTServerLike) {
    super();
  }
}

describe("BlackmagicBleClient", () => {
  let outgoing: MockCharacteristic;
  let incoming: MockCharacteristic;
  let status: MockCharacteristic;
  let deviceName: MockCharacteristic;
  let bluetooth: BluetoothLike;
  let server: BluetoothRemoteGATTServerLike;

  beforeEach(() => {
    outgoing = new MockCharacteristic();
    incoming = new MockCharacteristic();
    status = new MockCharacteristic();
    deviceName = new MockCharacteristic();

    const service: BluetoothRemoteGATTServiceLike = {
      getCharacteristic: vi.fn(async (uuid: string) => {
        if (uuid === OUTGOING_CAMERA_CONTROL_CHARACTERISTIC) return outgoing;
        if (uuid === INCOMING_CAMERA_CONTROL_CHARACTERISTIC) return incoming;
        if (uuid === CAMERA_STATUS_CHARACTERISTIC) return status;
        if (uuid === DEVICE_NAME_CHARACTERISTIC) return deviceName;
        throw new Error(`Unexpected characteristic ${uuid}`);
      }),
    };

    server = {
      connected: true,
      connect: vi.fn(async () => server),
      disconnect: vi.fn(),
      getPrimaryService: vi.fn(async (uuid: string) => {
        expect(uuid).toBe(BLACKMAGIC_CAMERA_SERVICE);
        return service;
      }),
    };

    bluetooth = {
      requestDevice: vi.fn(async () => new MockDevice(server)),
    };
  });

  it("requests a Blackmagic camera device and connects GATT", async () => {
    const client = new BlackmagicBleClient({ bluetooth });
    const state = await client.connect();

    expect(bluetooth.requestDevice).toHaveBeenCalledWith({
      filters: [{ services: [BLACKMAGIC_CAMERA_SERVICE] }],
      optionalServices: [BLACKMAGIC_CAMERA_SERVICE],
    });
    expect(state).toEqual({
      deviceId: "URSA Broadcast",
      deviceName: "URSA Broadcast",
      connected: true,
    });
    expect(incoming.startNotifications).toHaveBeenCalledOnce();
    expect(status.startNotifications).toHaveBeenCalledOnce();
    expect(deviceName.writeValueWithResponse).toHaveBeenCalledWith(
      new TextEncoder().encode("BM Bluetooth Web"),
    );
    expect(status.writeValueWithResponse).toHaveBeenCalledWith(Uint8Array.of(0x01));
    expect(status.startNotifications.mock.invocationCallOrder[0]).toBeLessThan(
      status.writeValueWithResponse.mock.invocationCallOrder[0]!,
    );
  });

  it("falls back to device.id when the camera advertises no BLE name", async () => {
    class UnnamedDevice extends EventTarget implements BluetoothDeviceLike {
      readonly id = "device-no-name";
      readonly name = undefined;
      constructor(readonly gatt: BluetoothRemoteGATTServerLike) {
        super();
      }
    }
    bluetooth.requestDevice = vi.fn(async () => new UnnamedDevice(server));

    const client = new BlackmagicBleClient({ bluetooth });
    const state = await client.connect();
    expect(state.deviceId).toBe("device-no-name");
  });

  it("throws when Web Bluetooth is unavailable", async () => {
    const client = new BlackmagicBleClient({ bluetooth: undefined });

    await expect(client.connect()).rejects.toThrow("Web Bluetooth is not available");
  });

  it("writes outgoing command packets", async () => {
    const client = new BlackmagicBleClient({ bluetooth });
    await client.connect();

    await client.writeCommand(Uint8Array.of(1, 2, 3));

    expect(outgoing.writeValueWithResponse).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3));
  });

  it("writes camera status power-on to trigger pairing", async () => {
    const client = new BlackmagicBleClient({ bluetooth });
    await client.connect();
    status.writeValueWithResponse.mockClear();

    await client.triggerPairing();

    expect(status.writeValueWithResponse).toHaveBeenCalledWith(Uint8Array.of(0x01));
  });

  it("logs each connection handshake step", async () => {
    const onLog = vi.fn();
    const client = new BlackmagicBleClient({ bluetooth, onLog });

    await client.connect();

    expect(onLog).toHaveBeenCalledWith("Opening Chrome Bluetooth device chooser");
    expect(onLog).toHaveBeenCalledWith("GATT connected");
    expect(onLog).toHaveBeenCalledWith("Camera Status 0x01 written");
    expect(onLog).toHaveBeenCalledWith("Notifications started");
  });

  it("emits decoded status notifications", async () => {
    const onStatus = vi.fn();
    const client = new BlackmagicBleClient({ bluetooth, onStatus });
    await client.connect();

    status.emit([0x24]);

    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        paired: true,
        cameraReady: true,
        payloadHex: "24",
        statusByteReservedBits: 0,
      }),
    );
  });

  it("emits incoming camera control notifications", async () => {
    const onIncomingControl = vi.fn();
    const client = new BlackmagicBleClient({ bluetooth, onIncomingControl });
    await client.connect();

    incoming.emit([1, 2, 3]);

    expect(onIncomingControl).toHaveBeenCalledWith(expect.any(DataView));
    expect(onIncomingControl.mock.calls[0]?.[0].getUint8(2)).toBe(3);
  });

  it("clears state and notifies on disconnect", async () => {
    const onDisconnect = vi.fn();
    const client = new BlackmagicBleClient({ bluetooth, onDisconnect });
    await client.connect();

    expect(client.isConnected).toBe(true);
    client.disconnect();

    expect(server.disconnect).toHaveBeenCalledOnce();
    expect(client.isConnected).toBe(false);
  });

  it("auto-reconnects on unexpected disconnect", async () => {
    const onReconnectScheduled = vi.fn();
    const onReconnectAttempt = vi.fn();
    const onReconnectSucceeded = vi.fn();
    const pendingTimers: Array<() => void> = [];
    const fakeSetTimeout = vi.fn((cb: () => void) => {
      pendingTimers.push(cb);
      return pendingTimers.length;
    });

    const client = new BlackmagicBleClient({
      bluetooth,
      onReconnectScheduled,
      onReconnectAttempt,
      onReconnectSucceeded,
      setTimeout: fakeSetTimeout as unknown as (cb: () => void, ms: number) => unknown,
      clearTimeout: vi.fn(),
    });

    await client.connect();
    const device = await ((bluetooth.requestDevice as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<BluetoothDeviceLike>);

    device.dispatchEvent(new Event("gattserverdisconnected"));

    expect(onReconnectScheduled).toHaveBeenCalledWith(2000, 1);
    expect(fakeSetTimeout).toHaveBeenCalledOnce();

    pendingTimers.shift()!();
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    expect(onReconnectAttempt).toHaveBeenCalledWith(1);
    expect(onReconnectSucceeded).toHaveBeenCalledOnce();
  });

  it("does not auto-reconnect after explicit disconnect", async () => {
    const onReconnectScheduled = vi.fn();
    const fakeSetTimeout = vi.fn();
    const client = new BlackmagicBleClient({
      bluetooth,
      onReconnectScheduled,
      setTimeout: fakeSetTimeout as unknown as (cb: () => void, ms: number) => unknown,
      clearTimeout: vi.fn(),
    });

    await client.connect();
    const device = await ((bluetooth.requestDevice as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<BluetoothDeviceLike>);
    client.disconnect();
    device.dispatchEvent(new Event("gattserverdisconnected"));

    expect(onReconnectScheduled).not.toHaveBeenCalled();
    expect(fakeSetTimeout).not.toHaveBeenCalled();
  });

  it("tryRestoreConnection silently reconnects to a previously paired device", async () => {
    const previouslyPaired = new MockDevice(server);
    (bluetooth as BluetoothLike).getDevices = vi.fn(async () => [previouslyPaired]);

    const client = new BlackmagicBleClient({ bluetooth });
    const state = await client.tryRestoreConnection();

    expect(state).toEqual({ deviceId: "URSA Broadcast", deviceName: "URSA Broadcast", connected: true });
    expect(bluetooth.requestDevice).not.toHaveBeenCalled();
    expect(server.connect).toHaveBeenCalledOnce();
  });

  it("tryRestoreConnection returns undefined when no devices are paired", async () => {
    (bluetooth as BluetoothLike).getDevices = vi.fn(async () => []);
    const client = new BlackmagicBleClient({ bluetooth });

    const state = await client.tryRestoreConnection();

    expect(state).toBeUndefined();
    expect(server.connect).not.toHaveBeenCalled();
  });

  it("tryRestoreConnection returns undefined when getDevices is unavailable", async () => {
    const onLog = vi.fn();
    const client = new BlackmagicBleClient({ bluetooth, onLog });

    const state = await client.tryRestoreConnection();

    expect(state).toBeUndefined();
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining("getDevices() unavailable"));
  });

  it("setAutoReconnect(false) cancels future reconnect", async () => {
    const onReconnectScheduled = vi.fn();
    const clearTimeoutSpy = vi.fn();
    const fakeSetTimeout = vi.fn(() => 42);
    const client = new BlackmagicBleClient({
      bluetooth,
      onReconnectScheduled,
      setTimeout: fakeSetTimeout as unknown as (cb: () => void, ms: number) => unknown,
      clearTimeout: clearTimeoutSpy,
    });

    await client.connect();
    const device = await ((bluetooth.requestDevice as ReturnType<typeof vi.fn>).mock.results[0]!.value as Promise<BluetoothDeviceLike>);

    device.dispatchEvent(new Event("gattserverdisconnected"));
    expect(onReconnectScheduled).toHaveBeenCalledOnce();

    client.setAutoReconnect(false);
    expect(clearTimeoutSpy).toHaveBeenCalledWith(42);
  });
});
