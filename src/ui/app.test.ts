import { beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type CameraClient } from "./app";
import { commands } from "../blackmagic/protocol";
import { emptyBanksFile, type Bank, type BanksFile } from "../banks/bank";
import type { BanksApi } from "../banks/banksClient";

function createFakeBanks(): BanksApi & { state: BanksFile } {
  const state = emptyBanksFile();
  return {
    state,
    async load() {
      return state;
    },
    async saveBank(_d: string, slot: number, bank: Bank) {
      state.banks[slot] = bank;
      state.loadedSlot = slot;
      state.updatedAt = Date.now();
      return state;
    },
    async setLoadedSlot(_d: string, slot: number | null) {
      state.loadedSlot = slot;
      return state;
    },
    async saveLastState() {
      return undefined;
    },
  };
}

function createFakeClient(): CameraClient {
  let autoReconnect = true;
  const setAutoReconnect = vi.fn((value: boolean) => {
    autoReconnect = value;
  });

  return {
    isSupported: true,
    isConnected: false,
    get autoReconnectEnabled() {
      return autoReconnect;
    },
    connect: vi.fn(async () => ({
      deviceId: "camera-1",
      deviceName: "URSA Broadcast",
      connected: true,
    })),
    disconnect: vi.fn(),
    writeCommand: vi.fn(async () => undefined),
    triggerPairing: vi.fn(async () => undefined),
    setPower: vi.fn(async () => undefined),
    setAutoReconnect,
  };
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("createApp", () => {
  let root: HTMLDivElement;
  let client: CameraClient;
  let banks: ReturnType<typeof createFakeBanks>;

  beforeEach(() => {
    root = document.createElement("div");
    client = createFakeClient();
    banks = createFakeBanks();
    createApp(root, { client, banks });
  });

  it("shows connect affordance and disables recording before connection", () => {
    expect(root.querySelector<HTMLButtonElement>("[data-connect-toggle]")?.disabled).toBe(false);
    expect(root.querySelector<HTMLButtonElement>("[data-record-start]")?.disabled).toBe(true);
  });

  it("connects and enables controls", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    expect(client.connect).toHaveBeenCalledOnce();
    expect(root.querySelector("[data-connection]")?.textContent).toContain("URSA Broadcast");
    expect(root.querySelector<HTMLButtonElement>("[data-record-start]")?.disabled).toBe(false);
  });

  it("toggles power on and off", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    click(root.querySelector("[data-power]")!);
    await flushPromises();
    expect(client.setPower).toHaveBeenLastCalledWith(true);
    expect(root.querySelector("[data-log]")?.textContent).toContain("Power on");

    click(root.querySelector("[data-power]")!);
    await flushPromises();
    expect(client.setPower).toHaveBeenLastCalledWith(true);
  });

  it("sends record commands", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    click(root.querySelector("[data-record-start]")!);
    await flushPromises();

    expect(client.writeCommand).toHaveBeenCalledWith(commands.recordStart());
    expect(root.querySelector("[data-log]")?.textContent).toContain("Record start");
  });

  it("second REC tap opens confirm modal without sending record start again", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    click(root.querySelector("[data-record-start]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    click(root.querySelector("[data-record-start]")!);
    await flushPromises();

    expect(client.writeCommand).not.toHaveBeenCalled();
    const modal = root.querySelector<HTMLElement>("[data-record-stop-confirm-modal]");
    expect(modal?.hidden).toBe(false);
  });

  it("record stop confirm modal cancel closes without stopping", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    click(root.querySelector("[data-record-start]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    click(root.querySelector("[data-record-start]")!);
    await flushPromises();
    click(root.querySelector("[data-record-stop-cancel]")!);
    await flushPromises();

    expect(client.writeCommand).not.toHaveBeenCalled();
    expect(root.querySelector<HTMLElement>("[data-record-stop-confirm-modal]")?.hidden).toBe(true);
  });

  it("record stop confirm sends record stop", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    click(root.querySelector("[data-record-start]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    click(root.querySelector("[data-record-start]")!);
    await flushPromises();
    click(root.querySelector("[data-record-stop-confirm]")!);
    await flushPromises();

    expect(client.writeCommand).toHaveBeenCalledWith(commands.recordStop());
    expect(root.querySelector("[data-log]")?.textContent).toContain("Record stop");
  });

  it("STOP button stops without confirm modal", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    click(root.querySelector("[data-record-start]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    click(root.querySelector("[data-record-stop]")!);
    await flushPromises();

    expect(client.writeCommand).toHaveBeenCalledWith(commands.recordStop());
    expect(root.querySelector<HTMLElement>("[data-record-stop-confirm-modal]")?.hidden).toBe(true);
  });

  it("sends focus from the horizontal fader drag", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    const fader = root.querySelector<HTMLElement>('[data-h-fader="focus"]')!;
    const handle = fader.querySelector<HTMLElement>("[data-h-fader-handle]")!;
    Object.defineProperty(fader, "clientWidth", { value: 200, configurable: true });
    Object.defineProperty(handle, "offsetWidth", { value: 26, configurable: true });
    fader.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 200, bottom: 44, width: 200, height: 44, x: 0, y: 0, toJSON: () => undefined }) as DOMRect;
    fader.setPointerCapture = () => undefined;
    fader.releasePointerCapture = () => undefined;

    fader.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 100, clientY: 22, bubbles: true }));
    fader.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 60, clientY: 22, bubbles: true }));
    fader.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 60, clientY: 22, bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 80));

    const calls = (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls;
    const focusCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 0 && p[5] === 0;
    });
    expect(focusCall).toBeDefined();
  });

  it("iris joystick: vertical drag sends iris only (no master black on horizontal)", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    const joystick = root.querySelector<HTMLElement>("[data-iris-joystick]")!;
    const handle = root.querySelector<HTMLElement>("[data-iris-joystick-handle]")!;
    Object.defineProperty(joystick, "clientHeight", { value: 220, configurable: true });
    Object.defineProperty(joystick, "clientWidth", { value: 88, configurable: true });
    Object.defineProperty(handle, "offsetHeight", { value: 56, configurable: true });
    Object.defineProperty(handle, "offsetWidth", { value: 36, configurable: true });
    joystick.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 88, bottom: 220, width: 88, height: 220, x: 0, y: 0, toJSON: () => undefined }) as DOMRect;
    joystick.setPointerCapture = () => undefined;
    joystick.releasePointerCapture = () => undefined;

    joystick.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 44, clientY: 110, bubbles: true }));
    joystick.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 60, clientY: 60, bubbles: true }));
    joystick.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 60, clientY: 60, bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 80));

    const calls = (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls;
    const irisCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 0 && p[5] === 3;
    });
    const liftCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 8 && p[5] === 0;
    });
    expect(irisCall).toBeDefined();
    expect(liftCall).toBeUndefined();
  });

  it("master black knob: dragging the wheel sends a color-correction lift command, not iris/gain", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    const knob = root.querySelector<HTMLElement>("[data-iris-wheel]")!;
    knob.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 80, bottom: 80, width: 80, height: 80, x: 0, y: 0, toJSON: () => undefined }) as DOMRect;
    knob.setPointerCapture = () => undefined;
    knob.releasePointerCapture = () => undefined;

    knob.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 80, clientY: 40, bubbles: true }));
    knob.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 40, clientY: 80, bubbles: true }));
    knob.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 40, clientY: 80, bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 100));

    const calls = (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls;
    const masterBlackCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 8 && p[5] === 0;
    });
    const gainCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 1 && p[5] === 13;
    });
    const irisCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 0 && p[5] === 3;
    });
    expect(masterBlackCall).toBeDefined();
    expect(gainCall).toBeUndefined();
    expect(irisCall).toBeUndefined();
  });

  it("selects a camera from the LED pillar (sends Camera ID + sets destination byte)", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    click(root.querySelector('[data-camera-led][data-camera-id="3"]')!);
    await flushPromises();

    expect(root.querySelector('[data-camera-led][data-camera-id="3"]')?.classList.contains("on")).toBe(true);

    const calls = (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls;
    const cameraIdCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 12 && p[5] === 5;
    });
    expect(cameraIdCall).toBeDefined();
    const idPacket = cameraIdCall![0] as Uint8Array;
    expect(idPacket[0]).toBe(3);
    expect(idPacket[8]).toBe("3".charCodeAt(0));

    click(root.querySelector('[data-record-start]')!);
    await flushPromises();
    const recordCall = calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 10 && p[5] === 1;
    });
    expect(recordCall).toBeDefined();
    expect((recordCall![0] as Uint8Array)[0]).toBe(3);
  });

  it("BARS requires 1s hold to enable, tap-to-disable when active", async () => {
    vi.useFakeTimers();
    try {
      click(root.querySelector("[data-connect-toggle]")!);
      await vi.runOnlyPendingTimersAsync();

      const button = root.querySelector<HTMLButtonElement>("[data-color-bars]")!;
      button.setPointerCapture = () => undefined;
      button.releasePointerCapture = () => undefined;

      const barsCalls = (): Array<unknown[]> => (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls.filter((args) => {
        const p = args[0] as Uint8Array;
        return p[4] === 4 && p[5] === 4;
      });

      button.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, bubbles: true }));
      expect(button.classList.contains("arming")).toBe(true);
      vi.advanceTimersByTime(400);
      button.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, bubbles: true }));
      expect(button.classList.contains("active")).toBe(false);
      expect(button.classList.contains("arming")).toBe(false);
      expect(barsCalls().length).toBe(0);

      button.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 2, bubbles: true }));
      expect(button.classList.contains("arming")).toBe(true);
      vi.advanceTimersByTime(1000);
      expect(button.classList.contains("active")).toBe(true);
      expect(button.classList.contains("arming")).toBe(false);
      button.dispatchEvent(new PointerEvent("pointerup", { pointerId: 2, bubbles: true }));
      await vi.runOnlyPendingTimersAsync();

      const onCalls = barsCalls();
      expect(onCalls.length).toBe(1);
      expect((onCalls[0]![0] as Uint8Array)[8]).toBe(30);

      button.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 3, bubbles: true }));
      button.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, bubbles: true }));
      await vi.runOnlyPendingTimersAsync();
      expect(button.classList.contains("active")).toBe(false);

      const finalCalls = barsCalls();
      expect(finalCalls.length).toBe(2);
      expect((finalCalls[1]![0] as Uint8Array)[8]).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("video slideout sends dynamic range, sharpening, display LUT and auto WB", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    click(root.querySelector("[data-video-toggle]")!);
    click(root.querySelector('[data-video-dynamic-range] [data-value="1"]')!);
    click(root.querySelector('[data-video-sharpening] [data-value="2"]')!);
    click(root.querySelector("[data-video-set-auto-wb]")!);

    const lutSelect = root.querySelector<HTMLSelectElement>("[data-video-display-lut]")!;
    lutSelect.value = "2";
    lutSelect.dispatchEvent(new Event("change", { bubbles: true }));

    const lutEnabled = root.querySelector<HTMLInputElement>("[data-video-display-lut-enabled]")!;
    lutEnabled.checked = true;
    lutEnabled.dispatchEvent(new Event("change", { bubbles: true }));

    await flushPromises();

    const calls = (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls;
    const find = (cat: number, par: number) => calls.find((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === cat && p[5] === par;
    });
    expect(find(1, 7)).toBeDefined();
    expect(find(1, 8)).toBeDefined();
    expect(find(1, 3)).toBeDefined();
    expect(find(1, 15)).toBeDefined();
  });

  it("steps gain, iso, shutter and white balance via stepper buttons", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    click(root.querySelector('[data-stepper-up="gain"]')!);
    click(root.querySelector('[data-stepper-up="iso"]')!);
    click(root.querySelector('[data-stepper-down="shutter"]')!);
    click(root.querySelector('[data-stepper-up="wb"]')!);
    click(root.querySelector('[data-stepper-up="tint"]')!);
    click(root.querySelector('[data-stepper-down="tint"]')!);
    await flushPromises();

    expect(client.writeCommand).toHaveBeenCalledWith(commands.gain(1));
    expect(client.writeCommand).toHaveBeenCalledWith(commands.iso(500));
    expect(client.writeCommand).toHaveBeenCalledWith(commands.shutterAngle(172.8));
    expect(client.writeCommand).toHaveBeenCalledWith(commands.whiteBalance(5700, 0));
    expect(client.writeCommand).toHaveBeenCalledWith(commands.whiteBalance(5600, 5));
    expect(client.writeCommand).toHaveBeenCalledWith(commands.whiteBalance(5600, -5));
  });

  it("audio mini-faders send L/R input level commands and ND stepper sends ND command", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    const dragFader = (selector: string, dy: number): void => {
      const fader = root.querySelector<HTMLElement>(selector)!;
      const handle = fader.querySelector<HTMLElement>("[data-mini-fader-handle]")!;
      Object.defineProperty(fader, "clientHeight", { value: 160, configurable: true });
      Object.defineProperty(handle, "offsetHeight", { value: 40, configurable: true });
      fader.getBoundingClientRect = () =>
        ({ left: 0, top: 0, right: 60, bottom: 160, width: 60, height: 160, x: 0, y: 0, toJSON: () => undefined }) as DOMRect;
      fader.setPointerCapture = () => undefined;
      fader.releasePointerCapture = () => undefined;
      fader.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 30, clientY: 80, bubbles: true }));
      fader.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 80 + dy, bubbles: true }));
      fader.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 30, clientY: 80 + dy, bubbles: true }));
    };

    dragFader('[data-mini-fader="audio-left"]', -24);
    await new Promise((resolve) => setTimeout(resolve, 80));

    dragFader('[data-mini-fader="audio-right"]', 12);
    await new Promise((resolve) => setTimeout(resolve, 80));

    click(root.querySelector('[data-stepper-up="nd"]')!);
    await flushPromises();

    const calls = (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls;
    const audioLR = calls.filter((args) => {
      const p = args[0] as Uint8Array;
      return p[4] === 2 && p[5] === 5;
    });
    expect(audioLR.length).toBeGreaterThanOrEqual(2);
    expect(client.writeCommand).toHaveBeenCalledWith(commands.ndFilterStops(0.6));
  });

  it("STORE arms then saves the current snapshot to a bank slot", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    click(root.querySelector("[data-scene-store]")!);
    expect(root.querySelector("[data-scene-store]")?.classList.contains("armed")).toBe(true);

    click(root.querySelector('[data-scene-bank][data-bank-slot="2"]')!);
    await flushPromises();
    await flushPromises();

    expect(banks.state.banks[2]).not.toBeNull();
    expect(banks.state.loadedSlot).toBe(2);
    expect(root.querySelector('[data-scene-bank][data-bank-slot="2"]')?.classList.contains("loaded")).toBe(true);
    expect(root.querySelector("[data-scene-store]")?.classList.contains("armed")).toBe(false);
  });

  it("STORE captures audio fader changes into the saved bank", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    const fader = root.querySelector<HTMLElement>('[data-mini-fader="audio-left"]')!;
    const handle = fader.querySelector<HTMLElement>("[data-mini-fader-handle]")!;
    Object.defineProperty(fader, "clientHeight", { value: 160, configurable: true });
    Object.defineProperty(handle, "offsetHeight", { value: 40, configurable: true });
    fader.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 60, bottom: 160, width: 60, height: 160, x: 0, y: 0, toJSON: () => undefined }) as DOMRect;
    fader.setPointerCapture = () => undefined;
    fader.releasePointerCapture = () => undefined;
    fader.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 30, clientY: 80, bubbles: true }));
    fader.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 30, clientY: 50, bubbles: true }));
    fader.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 30, clientY: 50, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 80));

    click(root.querySelector("[data-scene-store]")!);
    click(root.querySelector('[data-scene-bank][data-bank-slot="3"]')!);
    await flushPromises();
    await flushPromises();

    const stored = banks.state.banks[3];
    expect(stored).not.toBeNull();
    expect(stored?.audio?.inputLevels?.left).toBeGreaterThan(0.5);
  });

  it("loading a non-empty bank pushes its commands and lights the LED", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();

    banks.state.banks[1] = {
      gainDb: -3,
      iso: 200,
      color: {
        lift: { red: 0, green: 0, blue: 0, luma: 0 },
        gamma: { red: 0, green: 0, blue: 0, luma: 0 },
        gain: { red: 1, green: 1, blue: 1, luma: 1 },
        offset: { red: 0, green: 0, blue: 0, luma: 0 },
      },
    };

    click(root.querySelector('[data-scene-bank][data-bank-slot="1"]')!);
    for (let i = 0; i < 25; i += 1) await Promise.resolve();

    expect(client.writeCommand).toHaveBeenCalledWith(commands.gain(-3));
    expect(client.writeCommand).toHaveBeenCalledWith(commands.iso(200));
    expect(banks.state.loadedSlot).toBe(1);
    expect(root.querySelector('[data-scene-bank][data-bank-slot="1"]')?.classList.contains("loaded")).toBe(true);
  });

  it("dragging a paint knob sends the corresponding color command", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    const cell = root.querySelector<HTMLElement>(
      '[data-paint-cell][data-group="lift"][data-channel="luma"]',
    )!;
    const knob = cell.querySelector<HTMLElement>("[data-knob]")!;

    knob.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 40, bottom: 40, width: 40, height: 40, x: 0, y: 0, toJSON: () => undefined }) as DOMRect;
    knob.setPointerCapture = () => undefined;
    knob.releasePointerCapture = () => undefined;

    knob.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 40, clientY: 20, bubbles: true }));
    knob.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 20, clientY: 40, bubbles: true }));
    knob.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 20, clientY: 40, bubbles: true }));

    await new Promise((resolve) => setTimeout(resolve, 80));

    const liftCalls = (client.writeCommand as ReturnType<typeof vi.fn>).mock.calls.filter((args) => {
      const packet = args[0] as Uint8Array;
      return packet[4] === 8 && packet[5] === 0;
    });
    expect(liftCalls.length).toBeGreaterThan(0);
  });

  it("clicking an empty bank logs and does not write commands", async () => {
    click(root.querySelector("[data-connect-toggle]")!);
    await flushPromises();
    (client.writeCommand as ReturnType<typeof vi.fn>).mockClear();

    click(root.querySelector('[data-scene-bank][data-bank-slot="4"]')!);
    await flushPromises();

    expect(client.writeCommand).not.toHaveBeenCalled();
    expect(root.querySelector("[data-log]")?.textContent).toContain("Bank 5 is empty");
  });
});

describe("relay sessions list", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows hosted sessions on Connect without opening Join modal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          sessions: [{ id: "sid-aa", name: "Wireless LAN", deviceId: "camera-a" }],
        }),
      }),
    );
    const r = document.createElement("div");
    createApp(r, { client: createFakeClient(), banks: createFakeBanks() });
    await flushPromises();
    await flushPromises();
    expect(globalThis.fetch).toHaveBeenCalled();
    const firstReq = vi.mocked(globalThis.fetch).mock.calls[0]?.[0];
    expect(String(firstReq)).toContain("/api/relay/sessions");
    expect(r.querySelector("[data-relay-session-list-inline] .relay-session-row")?.textContent).toContain(
      "Wireless LAN",
    );
  });
});
