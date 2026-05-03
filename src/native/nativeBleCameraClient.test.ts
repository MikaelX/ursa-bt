import { describe, expect, it, vi } from "vitest";

vi.mock("@capacitor/core", () => ({
  Capacitor: {
    getPlatform: vi.fn(() => "ios"),
    isNativePlatform: vi.fn(() => true),
  },
}));

import type { BleClientInterface } from "@capacitor-community/bluetooth-le";
import { BLACKMAGIC_CAMERA_SERVICE } from "../blackmagic/constants";
import { NativeBleCameraClient } from "./nativeBleCameraClient";

const SVC = BLACKMAGIC_CAMERA_SERVICE.toLowerCase();

function createBleMock(): BleClientInterface {
  const noop = (): Promise<void> => Promise.resolve();
  const falsePromise = (): Promise<boolean> => Promise.resolve(false);

  const props = {
    initialize: vi.fn(() => Promise.resolve()),
    isEnabled: falsePromise,
    requestEnable: noop,
    enable: noop,
    disable: noop,
    startEnabledNotifications: noop,
    stopEnabledNotifications: noop,
    isLocationEnabled: falsePromise,
    openLocationSettings: noop,
    openBluetoothSettings: noop,
    openAppSettings: noop,
    setDisplayStrings: noop,
    requestDevice: vi.fn(() => Promise.resolve({ deviceId: "gatt-native-1", name: "Blackmagic URSA Broadcast" })),
    requestLEScan: vi.fn(() => Promise.resolve()),
    stopLEScan: noop,
    getDevices: vi.fn((ids: string[]) =>
      Promise.resolve(ids.map((deviceId) => ({ deviceId, name: "Blackmagic URSA Broadcast" }))),
    ),
    getBondedDevices: vi.fn(() => Promise.resolve([])),
    getConnectedDevices: vi.fn(() => Promise.resolve([])),
    connect: vi.fn(() => Promise.resolve()),
    createBond: vi.fn(() => Promise.resolve()),
    isBonded: vi.fn(() => Promise.resolve(false)),
    disconnect: vi.fn(() => Promise.resolve()),
    getServices: vi.fn(() =>
      Promise.resolve([
        {
          uuid: SVC,
          characteristics: [
            {
              uuid: "5dd3465f-1aee-4299-8493-d2eca2f8e1bb",
              properties: {
                broadcast: false,
                read: false,
                writeWithoutResponse: false,
                write: true,
                notify: false,
                indicate: false,
                authenticatedSignedWrites: false,
              },
              descriptors: [],
            },
            {
              uuid: "b864e140-76a0-416a-bf30-5876504537d9",
              properties: {
                broadcast: false,
                read: false,
                writeWithoutResponse: false,
                write: false,
                notify: true,
                indicate: false,
                authenticatedSignedWrites: false,
              },
              descriptors: [],
            },
            {
              uuid: "7fe8691d-95dc-4fc5-8abd-ca74339b51b9",
              properties: {
                broadcast: false,
                read: false,
                writeWithoutResponse: false,
                write: true,
                notify: true,
                indicate: false,
                authenticatedSignedWrites: false,
              },
              descriptors: [],
            },
            {
              uuid: "ffac0c52-c9fb-41a0-b063-cc76282eb89c",
              properties: {
                broadcast: false,
                read: false,
                writeWithoutResponse: false,
                write: true,
                notify: false,
                indicate: false,
                authenticatedSignedWrites: false,
              },
              descriptors: [],
            },
          ],
        },
      ]),
    ),
    discoverServices: noop,
    getMtu: vi.fn(() => Promise.resolve(247)),
    requestConnectionPriority: noop,
    readRssi: vi.fn(() => Promise.resolve(-40)),
    read: vi.fn(() => Promise.resolve(new DataView(new ArrayBuffer(1)))),
    write: vi.fn(() => Promise.resolve()),
    writeWithoutResponse: vi.fn(() => Promise.resolve()),
    readDescriptor: vi.fn(() => Promise.resolve(new DataView(new ArrayBuffer(1)))),
    writeDescriptor: vi.fn(() => Promise.resolve()),
    startNotifications: vi.fn(() => Promise.resolve()),
    stopNotifications: vi.fn(() => Promise.resolve()),
  };
  return props as unknown as BleClientInterface;
}

describe("NativeBleCameraClient", () => {
  it("runs initialize → pick device → connect → notifications → handshake writes", async () => {
    const ble = createBleMock();
    const client = new NativeBleCameraClient({
      ble,
      controllerName: "TestCtl",
      autoReconnect: false,
    });

    expect(client.isSupported).toBe(true);
    const state = await client.connect();

    expect(state.deviceId).toContain("Blackmagic");
    expect(ble.initialize).toHaveBeenCalled();
    expect(ble.requestDevice).toHaveBeenCalledWith({
      optionalServices: [SVC],
      displayMode: "list",
    });
    expect(ble.connect).toHaveBeenCalled();
    expect(ble.startNotifications).toHaveBeenCalledTimes(2);
    expect(ble.write).toHaveBeenCalled();
    expect(client.isConnected).toBe(true);
  });

  it("writes outgoing commands via BleClient.write", async () => {
    const ble = createBleMock();
    const client = new NativeBleCameraClient({ ble, autoReconnect: false });

    await client.connect();
    vi.mocked(ble.write).mockClear();

    await client.writeCommand(Uint8Array.of(0xaa, 0xbb));

    expect(ble.write).toHaveBeenCalledWith(
      "gatt-native-1",
      SVC,
      expect.any(String),
      expect.any(DataView),
    );
  });

  it("disconnect stops notifications and disconnects", async () => {
    const ble = createBleMock();
    const client = new NativeBleCameraClient({ ble, autoReconnect: false });

    await client.connect();
    client.disconnect();

    await vi.waitFor(() => {
      expect(ble.disconnect).toHaveBeenCalledWith("gatt-native-1");
    });

    expect(ble.stopNotifications).toHaveBeenCalled();
  });
});
