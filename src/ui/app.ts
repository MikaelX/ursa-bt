import { BlackmagicBleClient, type ConnectionState } from "../blackmagic/bleClient";
import { CameraState, type CameraSnapshot } from "../blackmagic/cameraState";
import { commands, toHex, withDestination } from "../blackmagic/protocol";
import type { CameraStatus } from "../blackmagic/status";
import {
  MASTER_BLACK_RANGE,
  PAINT_CHANNELS,
  PAINT_GROUPS,
  PAINT_RANGE,
  masterBlackToNormalised,
  normalisedToMasterBlack,
  paintValueToAngle,
  positionHFaderHandle,
  positionHorizontalFader,
  positionIrisHandle,
  positionMiniFaderHandle,
  positionVerticalFader,
  readFaderRange,
  renderPanelTemplate,
  initBluefyOfferModal,
  updatePanel,
  updateSceneBanks,
  valueToCenteredNorm,
  centeredNormToValue,
  type PaintChannel,
  type PaintGroup,
} from "./panel";
import { applyBankToCamera, applyColorBankToCamera, BANK_COUNT, buildBankFromSnapshot, emptyBanksFile, type Bank, type BanksFile } from "../banks/bank";
import { HttpBanksApi, NullBanksApi, type BanksApi } from "../banks/banksClient";

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

export interface AppOptions {
  client?: CameraClient;
  state?: CameraState;
  banks?: BanksApi;
}

export function createApp(root: HTMLElement, options: AppOptions = {}): void {
  const state = options.state ?? new CameraState();
  const banksApi: BanksApi = options.banks ?? (typeof fetch === "function" ? new HttpBanksApi() : new NullBanksApi());

  const log = (message: string): void => {
    const logList = root.querySelector<HTMLUListElement>("[data-log]");
    if (!logList) return;
    const item = document.createElement("li");
    item.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    logList.prepend(item);
  };

  let banks: BanksFile = emptyBanksFile();
  let storeArmed = false;
  let activeDeviceId: string | undefined;
  let lastStateSaveTimer: ReturnType<typeof setTimeout> | undefined;

  // The live "working" scene held in memory - always reflects the current panel
  // state (sliders, pots, knobs). Updated on every snapshot change and used to
  // detect divergence from the loaded bank.
  let currentScene: Bank = buildBankFromSnapshot(state.current);
  let loadedBankSnapshot: Bank | null = null;

  const isDirty = (): boolean => {
    if (banks.loadedSlot === null || !loadedBankSnapshot) return false;
    return JSON.stringify(currentScene) !== JSON.stringify(loadedBankSnapshot);
  };

  const renderBanks = (): void => {
    updateSceneBanks(root, {
      filledSlots: banks.banks.map((slot) => slot !== null),
      loadedSlot: banks.loadedSlot,
      storeArmed,
      dirty: isDirty(),
    });
  };

  const setStoreArmed = (armed: boolean): void => {
    storeArmed = armed;
    renderBanks();
  };

  const loadBanksFor = async (deviceId: string): Promise<void> => {
    activeDeviceId = deviceId;
    try {
      banks = await banksApi.load(deviceId);
      loadedBankSnapshot = banks.loadedSlot !== null ? banks.banks[banks.loadedSlot] ?? null : null;
      prevDirty = false;
      renderBanks();
      const savedCameraNumber = banks.lastState?.cameraNumber;
      if (savedCameraNumber !== undefined && state.current.cameraNumber !== savedCameraNumber) {
        state.setCameraNumber(savedCameraNumber);
        setOutgoingDestination(savedCameraNumber);
        log(`Restored camera id ${savedCameraNumber} for ${deviceId}`);
      } else if (savedCameraNumber !== undefined) {
        setOutgoingDestination(savedCameraNumber);
      }

      if (banks.lastState) {
        const lastColor = banks.lastState.color;
        state.applyColorWrite({
          lift: { ...lastColor.lift },
          gamma: { ...lastColor.gamma },
          gain: { ...lastColor.gain },
          offset: { ...lastColor.offset },
          contrast: lastColor.contrast ? { ...lastColor.contrast } : undefined,
          lumaMix: lastColor.lumaMix,
          hue: lastColor.hue,
          saturation: lastColor.saturation,
        });
        try {
          await applyColorBankToCamera(client, banks.lastState);
          log("Restored color settings from last session");
        } catch (error) {
          log(`Color restore failed: ${errorMessage(error)}`);
        }
      }
    } catch (error) {
      log(`Banks load failed: ${errorMessage(error)}`);
    }
  };

  const scheduleLastStateSave = (): void => {
    if (!activeDeviceId) return;
    if (lastStateSaveTimer) clearTimeout(lastStateSaveTimer);
    lastStateSaveTimer = setTimeout(() => {
      const deviceId = activeDeviceId;
      if (!deviceId) return;
      void banksApi.saveLastState(deviceId, currentScene).catch((error: unknown) => {
        log(`Last-state save failed: ${errorMessage(error)}`);
      });
    }, 1500);
  };

  const onStatus = (status: CameraStatus): void => {
    state.ingestStatus(status);
    renderStatusFlags(root, status);
    log(`Status 0x${status.raw.toString(16).padStart(2, "0")}: ${status.labels.join(", ") || "None"}`);
  };

  const onIncoming = (data: DataView): void => {
    const decoded = state.ingestIncomingPacket(data);
    const packet = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const hex = toHex(packet);

    if (decoded) {
      const display = decoded.stringValue
        ? JSON.stringify(decoded.stringValue)
        : `[${decoded.values.join(", ")}]`;
      log(`Incoming ${decoded.categoryName} / ${decoded.parameterName}: ${display} (${hex})`);
    } else {
      log(`Incoming: ${hex}`);
    }
  };

  let outgoingDestination = 255;
  const setOutgoingDestination = (dest: number): void => {
    outgoingDestination = Math.max(0, Math.min(255, Math.round(dest)));
  };

  const rawClient: CameraClient =
    options.client ??
    new BlackmagicBleClient({
      onStatus,
      onIncomingControl: onIncoming,
      onLog: (message) => log(message),
      onDisconnect: () => {
        setConnection(root, "Disconnected");
        connected = false;
        refreshControls();
        log("Disconnected");
      },
      onReconnectScheduled: (delayMs, attempt) => {
        setConnection(root, `Reconnecting in ${(delayMs / 1000).toFixed(0)}s (try ${attempt})…`);
      },
      onReconnectAttempt: (attempt) => {
        setConnection(root, `Reconnecting (try ${attempt})…`);
      },
      onReconnectSucceeded: (info) => {
        state.setDeviceName(info.deviceName);
        setConnection(root, `Connected to ${info.deviceName}`);
        connected = true;
        refreshControls();
        void loadBanksFor(info.deviceId);
        log(`Auto-reconnected: ${info.deviceName}`);
      },
    });

  const client: CameraClient = {
    get isSupported() { return rawClient.isSupported; },
    get isConnected() { return rawClient.isConnected; },
    get autoReconnectEnabled() { return rawClient.autoReconnectEnabled; },
    connect: () => rawClient.connect(),
    disconnect: () => rawClient.disconnect(),
    writeCommand: (packet: Uint8Array) => rawClient.writeCommand(withDestination(packet, outgoingDestination)),
    triggerPairing: () => rawClient.triggerPairing(),
    setPower: (on: boolean) => rawClient.setPower(on),
    setAutoReconnect: (enabled: boolean) => rawClient.setAutoReconnect(enabled),
    tryRestoreConnection: rawClient.tryRestoreConnection ? () => rawClient.tryRestoreConnection!() : undefined,
  };

  root.innerHTML = renderPanelTemplate(client.isSupported);
  attachClient(root, client);
  initBluefyOfferModal(root);

  let panelActive = true;
  let connected = false;
  const refreshControls = (): void => {
    setControlsEnabled(root, panelActive && connected);
    root.classList.toggle("panel-inactive", !panelActive);
    const connWrap = root.querySelector(".connection-controls");
    if (connWrap) {
      connWrap.classList.toggle("is-ble-connected", client.isConnected);
    }
    const disconnectBtn = root.querySelector<HTMLButtonElement>("[data-disconnect]");
    if (disconnectBtn) {
      disconnectBtn.disabled = !client.isConnected;
    }
    const btn = root.querySelector<HTMLButtonElement>("[data-panel-active]");
    if (btn) {
      btn.classList.toggle("active", panelActive);
      btn.setAttribute("aria-pressed", panelActive ? "true" : "false");
    }
  };
  refreshControls();
  renderBanks();

  let prevSnapshot: CameraSnapshot | null = null;
  let prevDirty = false;
  state.subscribe((snapshot) => {
    updatePanel(root, snapshot);
    pulseChangedControls(root, prevSnapshot, snapshot);
    prevSnapshot = snapshot;
    currentScene = buildBankFromSnapshot(snapshot);
    const nowDirty = isDirty();
    if (nowDirty !== prevDirty) {
      prevDirty = nowDirty;
      renderBanks();
    }
    scheduleLastStateSave();
  });

  bind(root, "[data-connect]", "click", async () => {
    try {
      setConnection(root, "Connecting...");
      const info = await client.connect();
      state.setDeviceName(info.deviceName);
      setConnection(root, `Connected to ${info.deviceName}`);
      connected = true;
      refreshControls();
      void loadBanksFor(info.deviceId);
      log(`Connected: ${info.deviceName}`);
    } catch (error) {
      setConnection(root, "Connection failed");
      log(errorMessage(error));
    }
  });

  bind(root, "[data-disconnect]", "click", () => {
    client.disconnect();
    setConnection(root, "Disconnected");
    connected = false;
    refreshControls();
    log("Disconnect requested");
  });

  const autoReconnectInput = root.querySelector<HTMLInputElement>("[data-auto-reconnect]");
  if (autoReconnectInput) {
    autoReconnectInput.checked = client.autoReconnectEnabled;
    autoReconnectInput.addEventListener("change", () => {
      client.setAutoReconnect(autoReconnectInput.checked);
      log(`Auto-reconnect ${autoReconnectInput.checked ? "enabled" : "disabled"}`);
    });
  }

  bind(root, "[data-power]", "click", async () => {
    const isOn = state.current.status?.powerOn ?? false;
    const next = !isOn;
    await runAction(log, next ? "Power on" : "Power off", () => client.setPower(next));
  });

  bindCommand(root, log, "[data-record-start]", "Record start", () => {
    state.setRecording(true);
    return commands.recordStart();
  });
  bindCommand(root, log, "[data-record-stop]", "Record stop", () => {
    state.setRecording(false);
    return commands.recordStop();
  });
  bindCommand(root, log, "[data-autofocus]", "Autofocus", () => commands.autoFocus());
  bindCommand(root, log, "[data-auto-aperture]", "Auto iris", () => commands.autoAperture());
  bindCommand(root, log, "[data-still-capture]", "Still capture", () => commands.stillCapture());
  bind(root, "[data-color-reset]", "click", async () => {
    state.resetColor();
    await sendCommand(log, "Color reset", commands.colorReset());
  });
  bindColorBars(root, (packet, label) => sendCommand(log, label, packet));
  bindProgramReturnFeed(root, (packet, label) => sendCommand(log, label, packet));
  bindCall(root, state, (packet, label) => sendCommand(log, label, packet));

  const advBtn = root.querySelector<HTMLButtonElement>("[data-color-adv]");
  const colorCard = root.querySelector<HTMLElement>("[data-color-card]");
  if (advBtn && colorCard) {
    advBtn.addEventListener("click", () => {
      const open = colorCard.hasAttribute("hidden");
      if (open) {
        colorCard.removeAttribute("hidden");
        advBtn.classList.add("active");
        advBtn.setAttribute("aria-pressed", "true");
        colorCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        requestAnimationFrame(() => updatePanel(root, state.current));
      } else {
        colorCard.setAttribute("hidden", "");
        advBtn.classList.remove("active");
        advBtn.setAttribute("aria-pressed", "false");
      }
    });
  }

  bindHFader(root, "focus", "Focus", (packet, label) => sendCommand(log, label, packet), (value) => commands.focus(value), () => state.current.lens.focus ?? 0.5);
  bindMasterBlackKnob(root, state, log, (packet, label) => sendCommand(log, label, packet));
  bindIrisJoystick(root, state, log, (packet, label) => sendCommand(log, label, packet));

  bindPaintKnobs(root, state, log, (packet, label) => sendCommand(log, label, packet));
  bindColorVerticalFaders(root, state, (packet, label) => sendCommand(log, label, packet));

  bindHorizontalFader(root, "contrast-pivot", "Contrast pivot",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.contrast(value, state.current.color.contrast?.adjust ?? 1),
    () => state.current.color.contrast?.pivot ?? 0.5,
    (value) => state.applyColorWrite({ contrast: { pivot: value, adjust: state.current.color.contrast?.adjust ?? 1 } }));
  bindHorizontalFader(root, "contrast-adjust", "Contrast adjust",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.contrast(state.current.color.contrast?.pivot ?? 0.5, value),
    () => state.current.color.contrast?.adjust ?? 1,
    (value) => state.applyColorWrite({ contrast: { pivot: state.current.color.contrast?.pivot ?? 0.5, adjust: value } }));
  bindHorizontalFader(root, "luma-mix", "Luma mix",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.lumaMix(value),
    () => state.current.color.lumaMix ?? 1,
    (value) => state.applyColorWrite({ lumaMix: value }));
  bindHorizontalFader(root, "hue", "Hue",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.colorAdjust(value, state.current.color.saturation ?? 1),
    () => state.current.color.hue ?? 0,
    (value) => state.applyColorWrite({ hue: value }));
  bindHorizontalFader(root, "saturation", "Saturation",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.colorAdjust(state.current.color.hue ?? 0, value),
    () => state.current.color.saturation ?? 1,
    (value) => state.applyColorWrite({ saturation: value }));

  bind(root, "[data-color-reset-card]", "click", async () => {
    state.resetColor();
    await sendCommand(log, "Color reset", commands.colorReset());
  });

  bind(root, "[data-auto-exp]", "click", async () => {
    const current = state.current.autoExposureMode ?? 0;
    const nextMode = current === 0 ? 1 : 0;
    const label = nextMode === 0 ? "Auto Exp off (Manual)" : "Auto Exp on (Iris)";
    await sendCommand(log, label, commands.autoExposureMode(nextMode));
  });

  bindStepper(root, "gain", async (direction) => {
    const next = stepGainDb(state.current.gainDb ?? 0, direction);
    await sendCommand(log, `Gain ${next > 0 ? "+" : ""}${next}dB`, commands.gain(next));
  });

  bindStepper(root, "iso", async (direction) => {
    const next = stepIso(state.current.iso ?? 400, direction);
    await sendCommand(log, `ISO ${next}`, commands.iso(next));
  });

  bindStepper(root, "shutter", async (direction) => {
    const currentDegrees = currentShutterDegrees(state.current.shutterAngle);
    const next = stepShutterAngle(currentDegrees, direction);
    await sendCommand(log, `Shutter angle ${next.toFixed(1)}°`, commands.shutterAngle(next));
  });

  bindStepper(root, "wb", async (direction) => {
    const current = state.current.whiteBalance ?? { temperature: 5600, tint: 0 };
    const next = stepWhiteBalance(current.temperature, direction);
    setAutoWbActive(root, false);
    await sendCommand(log, `White balance ${next}K`, commands.whiteBalance(next, current.tint));
  });

  bindStepper(root, "tint", async (direction) => {
    const current = state.current.whiteBalance ?? { temperature: 5600, tint: 0 };
    const next = stepTint(current.tint, direction);
    setAutoWbActive(root, false);
    await sendCommand(log, `Tint ${next > 0 ? "+" : ""}${next}`, commands.whiteBalance(current.temperature, next));
  });

  bindStepper(root, "nd", async (direction) => {
    const current = state.current.ndFilterStops ?? 0;
    const next = stepNdStops(current, direction);
    await sendCommand(log, `ND ${next.toFixed(1)} stops`, commands.ndFilterStops(next));
  });

  bind(root, "[data-panel-active]", "click", () => {
    panelActive = !panelActive;
    refreshControls();
    log(`Panel ${panelActive ? "active" : "inactive"} (readouts still live)`);
  });

  bindCardToggle(root, "[data-audio-toggle]", "[data-audio-card]");
  bindCardToggle(root, "[data-video-toggle]", "[data-video-card]");
  bindVideoCard(root, state, log, (packet, label) => sendCommand(log, label, packet));

  const sendPotPacket = (packet: Uint8Array, label: string): Promise<void> => sendCommand(log, label, packet);

  bindMiniFader(root, "audio-left", "Audio L gain", sendPotPacket, (value) => {
    const right = state.current.audio.inputLevels?.right ?? 0.5;
    state.applyAudioWrite({ inputLevels: { left: value, right } });
    return commands.audioInputLevels(value, right);
  }, () => state.current.audio.inputLevels?.left ?? 0.5);

  bindMiniFader(root, "audio-right", "Audio R gain", sendPotPacket, (value) => {
    const left = state.current.audio.inputLevels?.left ?? 0.5;
    state.applyAudioWrite({ inputLevels: { left, right: value } });
    return commands.audioInputLevels(left, value);
  }, () => state.current.audio.inputLevels?.right ?? 0.5);

  bindMiniFader(root, "audio-speaker", "Speaker", sendPotPacket, (value) => {
    state.applyAudioWrite({ speakerLevel: value });
    return commands.speakerLevel(value);
  }, () => state.current.audio.speakerLevel ?? 0.5);

  bindMiniFader(root, "audio-mic", "Mic", sendPotPacket, (value) => {
    state.applyAudioWrite({ micLevel: value });
    return commands.micLevel(value);
  }, () => state.current.audio.micLevel ?? 0.5);

  bindMiniFader(root, "audio-headphone", "Headphone", sendPotPacket, (value) => {
    state.applyAudioWrite({ headphoneLevel: value });
    return commands.headphoneLevel(value);
  }, () => state.current.audio.headphoneLevel ?? 0.5);

  bindMiniFader(root, "audio-program-mix", "HP mix", sendPotPacket, (value) => {
    state.applyAudioWrite({ headphoneProgramMix: value });
    return commands.headphoneProgramMix(value);
  }, () => state.current.audio.headphoneProgramMix ?? 0.5);

  bind(root, "[data-audio-reset]", "click", async () => {
    const DEFAULT_LEVEL = 0.5;
    state.applyAudioWrite({
      inputLevels: { left: DEFAULT_LEVEL, right: DEFAULT_LEVEL },
      micLevel: DEFAULT_LEVEL,
      headphoneLevel: DEFAULT_LEVEL,
      headphoneProgramMix: DEFAULT_LEVEL,
      speakerLevel: DEFAULT_LEVEL,
    });
    await sendCommand(log, "Audio reset: input L/R", commands.audioInputLevels(DEFAULT_LEVEL, DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: mic", commands.micLevel(DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: headphone", commands.headphoneLevel(DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: HP mix", commands.headphoneProgramMix(DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: speaker", commands.speakerLevel(DEFAULT_LEVEL));
  });

  bind(root, "[data-audio-input-type]", "change", async (event) => {
    const select = event.target as HTMLSelectElement;
    const value = Number(select.value);
    const labels = ["Internal mic", "Line", "Low mic", "High mic"];
    state.applyAudioWrite({ inputType: value });
    await sendCommand(log, `Audio input: ${labels[value] ?? value}`, commands.audioInputType(value));
  });


  root.querySelectorAll<HTMLButtonElement>("[data-camera-led]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.cameraId ?? "1");
      state.setCameraNumber(id);
      setOutgoingDestination(id);
      state.applyMetadataWrite({ cameraId: String(id) });
      await sendCommand(log, `Camera ${id} (dest + slate ID)`, commands.metadataCameraId(String(id)));
    });
  });

  bind(root, "[data-clear-log]", "click", () => {
    root.querySelector<HTMLUListElement>("[data-log]")?.replaceChildren();
  });

  bind(root, "[data-scene-store]", "click", () => {
    if (!activeDeviceId) {
      log("Connect a camera before storing a scene");
      return;
    }
    setStoreArmed(!storeArmed);
    log(storeArmed ? "STORE armed - tap a bank to save" : "STORE cancelled");
  });

  root.querySelectorAll<HTMLButtonElement>("[data-scene-bank]").forEach((button) => {
    button.addEventListener("click", async () => {
      const slot = Number(button.dataset.bankSlot ?? "0");
      if (Number.isNaN(slot) || slot < 0 || slot >= BANK_COUNT) return;

      if (storeArmed) {
        if (!activeDeviceId) return;
        const bank = buildBankFromSnapshot(state.current);
        try {
          banks = await banksApi.saveBank(activeDeviceId, slot, bank);
          setStoreArmed(false);
          loadedBankSnapshot = bank;
          prevDirty = false;
          renderBanks();
          log(`Stored current settings to bank ${slot + 1}`);
        } catch (error) {
          log(`Bank store failed: ${errorMessage(error)}`);
        }
        return;
      }

      const bank = banks.banks[slot];
      if (!bank) {
        log(`Bank ${slot + 1} is empty`);
        return;
      }

      try {
        await applyBankToCamera(client, bank);
        if (activeDeviceId) {
          banks = await banksApi.setLoadedSlot(activeDeviceId, slot);
        } else {
          banks = { ...banks, loadedSlot: slot };
        }
        loadedBankSnapshot = bank;
        prevDirty = false;
        renderBanks();
        log(`Loaded bank ${slot + 1}`);
      } catch (error) {
        log(`Bank load failed: ${errorMessage(error)}`);
      }
    });
  });

  if (client.tryRestoreConnection) {
    setConnection(root, "Looking for previously paired camera…");
    void client
      .tryRestoreConnection()
      .then((info) => {
        if (info) {
          state.setDeviceName(info.deviceName);
          setConnection(root, `Connected to ${info.deviceName}`);
          connected = true;
          refreshControls();
          void loadBanksFor(info.deviceId);
          log(`Restored connection: ${info.deviceName}`);
        } else {
          setConnection(root, "Disconnected");
        }
      })
      .catch((error) => {
        setConnection(root, "Disconnected");
        log(`Restore on reload failed: ${errorMessage(error)}`);
      });
  }

  async function sendCommand(
    logger: (message: string) => void,
    label: string,
    packet: Uint8Array,
  ): Promise<void> {
    await runAction(logger, label, () => client.writeCommand(packet), packet);
  }

  function bindCommand(
    scope: HTMLElement,
    logger: (message: string) => void,
    selector: string,
    label: string,
    createPacket: () => Uint8Array,
  ): void {
    bind(scope, selector, "click", async () => {
      const packet = createPacket();
      await runAction(logger, label, () => client.writeCommand(packet), packet);
    });
  }

}

function bindMasterBlackKnob(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const knob = root.querySelector<HTMLElement>("[data-iris-wheel]");
  if (!knob) return;

  const SENSITIVITY_DEG_PER_FULL_RANGE = 270;
  const minSendIntervalMs = 80;

  let dragging = false;
  let pointerId: number | null = null;
  let startAngle = 0;
  let startNorm = 0.5;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    state.applyColorWrite({ lift: { ...state.current.color.lift, luma: value } });
    void send(commands.masterBlack(value), `Master black ${value >= 0 ? "+" : ""}${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();

    const rect = knob.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    let delta = angle - startAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;

    const nextNorm = Math.max(0, Math.min(1, startNorm + delta / SENSITIVITY_DEG_PER_FULL_RANGE));
    const nextValue = normalisedToMasterBlack(nextNorm);
    pendingValue = Math.max(MASTER_BLACK_RANGE.min, Math.min(MASTER_BLACK_RANGE.max, Number(nextValue.toFixed(2))));

    const marker = root.querySelector<HTMLElement>("[data-iris-wheel-marker]");
    if (marker) {
      const angleDeg = masterBlackToNormalised(pendingValue) * 270 - 135;
      marker.style.transform = `rotate(${angleDeg}deg)`;
    }

    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    knob.releasePointerCapture(event.pointerId);
    flush(true);
    log("Master black knob released");
  };

  knob.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    knob.setPointerCapture(event.pointerId);

    const rect = knob.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    startAngle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    startNorm = masterBlackToNormalised(state.current.color.lift.luma ?? 0);
  });

  knob.addEventListener("pointermove", onPointerMove);
  knob.addEventListener("pointerup", stopDrag);
  knob.addEventListener("pointercancel", stopDrag);
  knob.style.touchAction = "none";
  knob.style.cursor = "grab";
}

function bindIrisJoystick(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const joystick = root.querySelector<HTMLElement>("[data-iris-joystick]");
  const handle = root.querySelector<HTMLElement>("[data-iris-joystick-handle]");
  if (!joystick || !handle) return;

  const minSendIntervalMs = 60;
  const verticalRangePx = (): number => joystick.clientHeight - 1.2 * 16 - handle.offsetHeight;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientY = 0;
  let startIris = 0.5;

  let pendingIris: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingIris === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    lastSent = now;
    const value = pendingIris;
    pendingIris = null;
    void send(commands.iris(value), `Iris joystick ${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();

    const dy = event.clientY - startClientY;
    const vRange = verticalRangePx() || 1;
    const nextIris = Math.max(0, Math.min(1, startIris - dy / vRange));
    pendingIris = Number(nextIris.toFixed(3));

    positionIrisHandle(joystick, handle, pendingIris);
    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    joystick.classList.remove("dragging");
    delete joystick.dataset.dragging;
    joystick.releasePointerCapture(event.pointerId);
    flush(true);
  };

  joystick.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    joystick.setPointerCapture(event.pointerId);
    joystick.classList.add("dragging");
    joystick.dataset.dragging = "true";

    startClientY = event.clientY;
    startIris = state.current.lens.apertureNormalised ?? 0.5;
  });

  joystick.addEventListener("pointermove", onPointerMove);
  joystick.addEventListener("pointerup", stopDrag);
  joystick.addEventListener("pointercancel", stopDrag);

  void log;
}

function bindColorBars(
  root: HTMLElement,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const button = root.querySelector<HTMLButtonElement>("[data-color-bars]");
  if (!button) return;

  const HOLD_MS = 1000;

  let active = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdPointerId: number | null = null;

  const setActive = (on: boolean): void => {
    if (active === on) return;
    active = on;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  };

  const setArming = (on: boolean): void => {
    button.classList.toggle("arming", on);
  };

  const cancelHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    holdPointerId = null;
    setArming(false);
  };

  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    if (button.disabled) return;

    if (active) {
      try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      setActive(false);
      void send(commands.colorBars(0), "Color bars off");
      return;
    }

    try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    holdPointerId = event.pointerId;
    setArming(true);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      setArming(false);
      holdPointerId = null;
      setActive(true);
      void send(commands.colorBars(30), "Color bars on (held 1s)");
    }, HOLD_MS);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (holdPointerId !== null && event.pointerId === holdPointerId) {
      cancelHold();
    }
    try { button.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  };

  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", onPointerEnd);
  button.addEventListener("pointercancel", onPointerEnd);
  button.addEventListener("pointerleave", (event) => {
    if (holdPointerId !== null && event.pointerId === holdPointerId) {
      cancelHold();
    }
  });
  button.style.touchAction = "none";
}

function bindProgramReturnFeed(
  root: HTMLElement,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const button = root.querySelector<HTMLButtonElement>("[data-program-return-feed]");
  if (!button) return;

  const HOLD_MS = 3000;

  let active = false;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let holdPointerId: number | null = null;

  const setActive = (on: boolean): void => {
    if (active === on) return;
    active = on;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  };

  const setArming = (on: boolean): void => {
    button.classList.toggle("arming", on);
  };

  const cancelHold = (): void => {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
    holdPointerId = null;
    setArming(false);
  };

  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    if (button.disabled) return;

    if (active) {
      try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      setActive(false);
      void send(commands.programReturnFeed(0), "Program return feed off");
      return;
    }

    try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    holdPointerId = event.pointerId;
    setArming(true);
    holdTimer = setTimeout(() => {
      holdTimer = null;
      setArming(false);
      holdPointerId = null;
      setActive(true);
      void send(commands.programReturnFeed(30), "Program return feed on (held 3s)");
    }, HOLD_MS);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (holdPointerId !== null && event.pointerId === holdPointerId) {
      cancelHold();
    }
    try { button.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
  };

  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", onPointerEnd);
  button.addEventListener("pointercancel", onPointerEnd);
  button.addEventListener("pointerleave", (event) => {
    if (holdPointerId !== null && event.pointerId === holdPointerId) {
      cancelHold();
    }
  });
  button.style.touchAction = "none";
}

/**
 * CALL: Blackmagic broadcast panels use this to flash the camera's tally LEDs
 * to get the operator's attention. The protocol has no dedicated "call"
 * parameter, so we briefly drive all tally brightness channels to full and
 * restore the previous values on release.
 */
function bindCall(
  root: HTMLElement,
  state: CameraState,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const button = root.querySelector<HTMLButtonElement>("[data-call]");
  if (!button) return;

  const FLASH_MS = 2000;

  let activePointerId: number | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let saved: { master: number; front: number; rear: number } | null = null;

  const setActive = (on: boolean): void => {
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  };

  const flashOn = (): void => {
    const t = state.current.tally?.brightness;
    saved = {
      master: t?.master ?? 1,
      front: t?.front ?? 0,
      rear: t?.rear ?? 0,
    };
    setActive(true);
    void send(commands.tallyBrightness(1), "Call (tally on)");
    void send(commands.frontTallyBrightness(1), "Call (front tally on)");
    void send(commands.rearTallyBrightness(1), "Call (rear tally on)");
  };

  const flashOff = (): void => {
    setActive(false);
    if (!saved) return;
    const restore = saved;
    saved = null;
    void send(commands.tallyBrightness(restore.master), "Call release (tally restore)");
    void send(commands.frontTallyBrightness(restore.front), "Call release (front tally restore)");
    void send(commands.rearTallyBrightness(restore.rear), "Call release (rear tally restore)");
  };

  const clearReleaseTimer = (): void => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    if (button.disabled) return;
    if (activePointerId !== null) return;

    activePointerId = event.pointerId;
    try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    clearReleaseTimer();
    flashOn();
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (activePointerId === null) flashOff();
    }, FLASH_MS);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    activePointerId = null;
    try { button.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    if (releaseTimer === null) flashOff();
  };

  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", onPointerEnd);
  button.addEventListener("pointercancel", onPointerEnd);
  button.style.touchAction = "none";
}

/**
 * The Blackmagic protocol exposes auto WB only as one-shot triggers
 * (set / restore), not as a persistent mode the camera reports back.
 * The chassis "W/B" button is therefore a UI-only toggle: first press
 * triggers Set Auto WB and lights the LED; second press triggers
 * Restore Auto WB and clears it.
 */
function bindAutoWhiteBalanceToggle(
  root: HTMLElement,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-video-set-auto-wb]"),
  );
  if (buttons.length === 0) return;

  buttons.forEach((button) => {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", async () => {
      const isActive = button.classList.contains("active");
      if (isActive) {
        setAutoWbActive(root, false);
        await send(commands.restoreAutoWhiteBalance(), "Restore auto WB");
      } else {
        setAutoWbActive(root, true);
        await send(commands.setAutoWhiteBalance(), "Set auto WB");
      }
    });
  });
}

function setAutoWbActive(root: HTMLElement, active: boolean): void {
  root.querySelectorAll<HTMLButtonElement>("[data-video-set-auto-wb]").forEach((button) => {
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function bindCardToggle(root: HTMLElement, buttonSelector: string, cardSelector: string): void {
  const button = root.querySelector<HTMLButtonElement>(buttonSelector);
  const card = root.querySelector<HTMLElement>(cardSelector);
  if (!button || !card) return;
  button.addEventListener("click", () => {
    const opening = card.hasAttribute("hidden");
    if (opening) {
      card.removeAttribute("hidden");
      button.classList.add("active");
      button.setAttribute("aria-pressed", "true");
      if (typeof card.scrollIntoView === "function") {
        card.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }
    } else {
      card.setAttribute("hidden", "");
      button.classList.remove("active");
      button.setAttribute("aria-pressed", "false");
    }
  });
}

const EXPOSURE_LADDER_US = [
  500, 1000, 2000, 4000, 8000, 16667, 20000, 25000, 33333, 40000, 41667, 50000, 60000, 80000, 100000,
];

function stepExposureUs(current: number, direction: 1 | -1): number {
  const idx = EXPOSURE_LADDER_US.findIndex((v) => v >= current);
  const baseIndex = idx === -1 ? EXPOSURE_LADDER_US.length - 1 : idx;
  const nextIndex = Math.max(0, Math.min(EXPOSURE_LADDER_US.length - 1, baseIndex + direction));
  return EXPOSURE_LADDER_US[nextIndex] ?? current;
}

function bindVideoCard(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  bindAutoWhiteBalanceToggle(root, send);
  bind(root, "[data-video-restore-auto-wb]", "click", async () => {
    setAutoWbActive(root, false);
    await send(commands.restoreAutoWhiteBalance(), "Restore auto WB");
  });

  const labelDynamic = ["Film", "Video", "Extended Video"];
  bindSegmented(root, "[data-video-dynamic-range]", (value) => {
    void send(commands.dynamicRange(value), `Dynamic range: ${labelDynamic[value] ?? value}`);
  });

  const labelSharp = ["Off", "Low", "Medium", "High"];
  bindSegmented(root, "[data-video-sharpening]", (value) => {
    void send(commands.sharpening(value), `Sharpening: ${labelSharp[value] ?? value}`);
  });

  const lutSelect = root.querySelector<HTMLSelectElement>("[data-video-display-lut]");
  const lutEnabled = root.querySelector<HTMLInputElement>("[data-video-display-lut-enabled]");
  const sendLut = (): void => {
    if (!lutSelect || !lutEnabled) return;
    const sel = Number(lutSelect.value);
    const en = lutEnabled.checked;
    void send(commands.displayLut(sel, en), `Display LUT ${["None","Custom","Film→Video","Film→ExtVideo"][sel] ?? sel}${en ? " on" : " off"}`);
  };
  lutSelect?.addEventListener("change", sendLut);
  lutEnabled?.addEventListener("change", sendLut);

  bindStepper(root, "exposure", async (direction) => {
    const next = stepExposureUs(state.current.exposureUs ?? 16667, direction);
    await send(commands.exposureUs(next), `Exposure ${next}µs`);
  });

  const sendTally = (packet: Uint8Array, label: string): Promise<void> => Promise.resolve(send(packet, label) as void);

  bindMiniFader(root, "tally-master", "Tally master", sendTally, (value) => {
    state.applyTallyBrightnessWrite({ master: value });
    return commands.tallyBrightness(value);
  }, () => state.current.tally?.brightness?.master ?? 1);

  bindMiniFader(root, "tally-front", "Tally front", sendTally, (value) => {
    state.applyTallyBrightnessWrite({ front: value });
    return commands.frontTallyBrightness(value);
  }, () => state.current.tally?.brightness?.front ?? 1);

  bindMiniFader(root, "tally-rear", "Tally rear", sendTally, (value) => {
    state.applyTallyBrightnessWrite({ rear: value });
    return commands.rearTallyBrightness(value);
  }, () => state.current.tally?.brightness?.rear ?? 1);

  void log;
}

function bindSegmented(
  root: HTMLElement,
  groupSelector: string,
  onSelect: (value: number) => void,
): void {
  const group = root.querySelector<HTMLElement>(groupSelector);
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>(".segmented-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const value = Number(opt.dataset.value ?? "0");
      group.querySelectorAll<HTMLButtonElement>(".segmented-option").forEach((o) => {
        const active = o === opt;
        o.classList.toggle("active", active);
        o.setAttribute("aria-checked", active ? "true" : "false");
      });
      onSelect(value);
    });
  });
}

function bindPaintKnobs(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const groupCommand: Record<PaintGroup, (red: number, green: number, blue: number, luma: number) => Uint8Array> = {
    lift: commands.lift,
    gamma: commands.gamma,
    gain: commands.videoGain,
  };

  const SENSITIVITY_DEG = 270;
  const minSendIntervalMs = 60;

  root.querySelectorAll<HTMLElement>("[data-paint-cell]").forEach((cell) => {
    const group = cell.dataset.group as PaintGroup | undefined;
    const channel = cell.dataset.channel as PaintChannel | undefined;
    if (!group || !channel) return;

    const knob = cell.querySelector<HTMLElement>("[data-knob]");
    const indicator = cell.querySelector<HTMLElement>("[data-knob-indicator]");
    const readout = cell.querySelector<HTMLElement>("[data-paint-value]");
    if (!knob) return;

    const range = PAINT_RANGE[group];
    const span = range.max - range.min;

    let dragging = false;
    let pointerId: number | null = null;
    let startAngle = 0;
    let startValue = range.default;
    let pendingValue: number | null = null;
    let lastSent = 0;
    let scheduled: number | null = null;

    const sendValue = (value: number): void => {
      const channels = readColorGroup(state, group);
      channels[channel] = value;
      state.applyColorWrite({ [group]: channels } as Partial<CameraSnapshot["color"]>);
      const packet = groupCommand[group](channels.red, channels.green, channels.blue, channels.luma);
      void send(packet, `${groupLabel(group)} ${channel} ${value.toFixed(2)}`);
    };

    const flush = (force: boolean): void => {
      if (pendingValue === null) return;
      const now = performance.now();
      if (!force && now - lastSent < minSendIntervalMs) {
        if (scheduled === null) {
          scheduled = window.setTimeout(() => {
            scheduled = null;
            flush(true);
          }, minSendIntervalMs - (now - lastSent));
        }
        return;
      }
      const value = pendingValue;
      pendingValue = null;
      lastSent = now;
      sendValue(value);
    };

    const updateVisuals = (value: number): void => {
      if (indicator) {
        indicator.style.transform = `rotate(${paintValueToAngle(group, value)}deg)`;
      }
      if (readout) {
        readout.textContent = value.toFixed(2);
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      event.preventDefault();
      const rect = knob.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const angle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
      let delta = angle - startAngle;
      if (delta > 180) delta -= 360;
      if (delta < -180) delta += 360;

      const next = Math.max(range.min, Math.min(range.max, startValue + (delta / SENSITIVITY_DEG) * span));
      pendingValue = Number(next.toFixed(3));
      updateVisuals(pendingValue);
      flush(false);
    };

    const stopDrag = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      dragging = false;
      pointerId = null;
      cell.classList.remove("dragging");
      delete cell.dataset.dragging;
      knob.releasePointerCapture(event.pointerId);
      flush(true);
    };

    knob.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      dragging = true;
      pointerId = event.pointerId;
      knob.setPointerCapture(event.pointerId);
      cell.classList.add("dragging");
      cell.dataset.dragging = "true";

      const rect = knob.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      startAngle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
      startValue = state.current.color[group][channel];
    });

    knob.addEventListener("pointermove", onPointerMove);
    knob.addEventListener("pointerup", stopDrag);
    knob.addEventListener("pointercancel", stopDrag);
  });

  void log;
}

function bindHFader(
  root: HTMLElement,
  faderAttr: string,
  label: string,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
  buildPacket: (value: number) => Uint8Array,
  readCurrent: () => number,
): void {
  const fader = root.querySelector<HTMLElement>(`[data-h-fader="${faderAttr}"]`);
  const handle = fader?.querySelector<HTMLElement>("[data-h-fader-handle]");
  if (!fader || !handle) return;

  const minSendIntervalMs = 60;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientX = 0;
  let startValue = 0.5;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    void send(buildPacket(value), `${label} ${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - startClientX;
    const horizontalRange = fader.clientWidth - handle.offsetWidth || 1;
    const next = Math.max(0, Math.min(1, startValue + dx / horizontalRange));
    pendingValue = Number(next.toFixed(3));

    positionHFaderHandle(fader, handle, pendingValue);
    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    startClientX = event.clientX;
    startValue = readCurrent();
  });

  fader.addEventListener("pointermove", onPointerMove);
  fader.addEventListener("pointerup", stopDrag);
  fader.addEventListener("pointercancel", stopDrag);
  fader.style.touchAction = "none";
  fader.style.cursor = "grab";
}

function bindMiniFader(
  root: HTMLElement,
  faderAttr: string,
  label: string,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
  buildPacket: (value: number) => Uint8Array,
  readCurrent: () => number,
): void {
  const fader = root.querySelector<HTMLElement>(`[data-mini-fader="${faderAttr}"]`);
  const handle = fader?.querySelector<HTMLElement>("[data-mini-fader-handle]");
  if (!fader || !handle) return;

  const cell = fader.closest<HTMLElement>(".audio-fader-cell");
  const readout = cell?.querySelector<HTMLElement>("[data-readout]");

  const minSendIntervalMs = 60;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientY = 0;
  let startValue = 0.5;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    void send(buildPacket(value), `${label} ${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dy = event.clientY - startClientY;
    const verticalRange = fader.clientHeight - handle.offsetHeight || 1;
    const next = Math.max(0, Math.min(1, startValue - dy / verticalRange));
    pendingValue = Number(next.toFixed(3));

    positionMiniFaderHandle(fader, handle, pendingValue);
    if (readout) readout.textContent = pendingValue.toFixed(2);

    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    startClientY = event.clientY;
    startValue = readCurrent();
  });

  fader.addEventListener("pointermove", onPointerMove);
  fader.addEventListener("pointerup", stopDrag);
  fader.addEventListener("pointercancel", stopDrag);
  fader.style.touchAction = "none";
  fader.style.cursor = "grab";
}


type StepDirection = 1 | -1;

function bindStepper(
  root: HTMLElement,
  id: string,
  handler: (direction: StepDirection) => Promise<void> | void,
): void {
  const upButton = root.querySelector<HTMLButtonElement>(`[data-stepper-up="${id}"]`);
  const downButton = root.querySelector<HTMLButtonElement>(`[data-stepper-down="${id}"]`);

  upButton?.addEventListener("click", () => void handler(1));
  downButton?.addEventListener("click", () => void handler(-1));
}

function stepGainDb(current: number, direction: StepDirection): number {
  const next = Math.round(current + direction);
  return clampNumber(next, -128, 127);
}

const ISO_LADDER = [100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 12800, 25600];

function stepIso(current: number, direction: StepDirection): number {
  const sorted = ISO_LADDER;
  const idx = sorted.findIndex((value) => value >= current);
  const baseIndex = idx === -1 ? sorted.length - 1 : idx;
  const nextIndex = clampNumber(baseIndex + direction, 0, sorted.length - 1);
  return sorted[nextIndex] ?? current;
}

const SHUTTER_LADDER = [11, 15, 22.5, 30, 45, 60, 72, 90, 120, 144, 150, 172.8, 180, 216, 270, 360];

function stepShutterAngle(current: number, direction: StepDirection): number {
  const idx = SHUTTER_LADDER.findIndex((value) => value >= current - 0.1);
  const baseIndex = idx === -1 ? SHUTTER_LADDER.length - 1 : idx;
  const nextIndex = clampNumber(baseIndex + direction, 0, SHUTTER_LADDER.length - 1);
  return SHUTTER_LADDER[nextIndex] ?? current;
}

function stepWhiteBalance(current: number, direction: StepDirection): number {
  const step = 100;
  const next = Math.round((current + step * direction) / step) * step;
  return clampNumber(next, 2500, 10000);
}

function stepTint(current: number, direction: StepDirection): number {
  const step = 5;
  const next = Math.round((current + step * direction) / step) * step;
  return clampNumber(next, -50, 50);
}

function stepNdStops(current: number, direction: StepDirection): number {
  const ladder = [0, 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2, 4.8, 5.4, 6.0];
  const tolerance = 0.05;
  let idx = ladder.findIndex((v) => Math.abs(v - current) <= tolerance);
  if (idx === -1) {
    idx = direction > 0 ? ladder.findIndex((v) => v > current) : [...ladder].reverse().findIndex((v) => v < current);
    if (idx === -1) idx = 0;
  } else {
    idx = clampNumber(idx + direction, 0, ladder.length - 1);
  }
  return ladder[idx]!;
}

function currentShutterDegrees(rawAngle: number | undefined): number {
  if (rawAngle === undefined) return 180;
  return rawAngle / 100;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const PULSE_TARGETS: Array<{
  selector: string;
  changed: (a: CameraSnapshot, b: CameraSnapshot) => boolean;
}> = [
  { selector: "[data-record]", changed: (a, b) => a.recording !== b.recording },
  { selector: "[data-iris-knob]", changed: (a, b) => a.lens.apertureNormalised !== b.lens.apertureNormalised },
  { selector: '[data-h-fader="focus"]', changed: (a, b) => a.lens.focus !== b.lens.focus },
  { selector: "[data-stepper='wb']", changed: (a, b) => a.whiteBalance?.temperature !== b.whiteBalance?.temperature },
  { selector: "[data-stepper='tint']", changed: (a, b) => a.whiteBalance?.tint !== b.whiteBalance?.tint },
  { selector: "[data-stepper='gain']", changed: (a, b) => a.gainDb !== b.gainDb },
  { selector: "[data-stepper='iso']", changed: (a, b) => a.iso !== b.iso },
  { selector: "[data-stepper='shutter']", changed: (a, b) => a.shutterAngle !== b.shutterAngle },
  { selector: "[data-stepper='nd']", changed: (a, b) => a.ndFilterStops !== b.ndFilterStops },
  { selector: "[data-auto-exp]", changed: (a, b) => a.autoExposureMode !== b.autoExposureMode },
];

function pulseChangedControls(
  root: HTMLElement,
  prev: CameraSnapshot | null,
  next: CameraSnapshot,
): void {
  if (!prev) return;
  for (const target of PULSE_TARGETS) {
    if (!target.changed(prev, next)) continue;
    const el = root.querySelector<HTMLElement>(target.selector);
    if (!el) continue;
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
    window.setTimeout(() => el.classList.remove("pulse"), 700);
  }
}

function bindColorVerticalFaders(
  root: HTMLElement,
  state: CameraState,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const groupCommand: Record<PaintGroup, (red: number, green: number, blue: number, luma: number) => Uint8Array> = {
    lift: commands.lift,
    gamma: commands.gamma,
    gain: commands.videoGain,
  };

  PAINT_GROUPS.forEach((group) => {
    PAINT_CHANNELS.forEach((channel) => {
      const cell = root.querySelector<HTMLElement>(
        `[data-color-input][data-group="${group}"][data-channel="${channel}"]`,
      );
      const fader = cell?.querySelector<HTMLElement>("[data-vfader]");
      const handle = cell?.querySelector<HTMLElement>("[data-vfader-handle]");
      const readout = cell?.querySelector<HTMLElement>("[data-color-readout]");
      if (!cell || !fader || !handle || !readout) return;

      bindVerticalFader(fader, handle, {
        readCurrent: () => state.current.color[group][channel],
        onChange: (value) => {
          readout.textContent = value.toFixed(2);
          fader.setAttribute("aria-valuenow", value.toFixed(2));
        },
        send: (value) => {
          const channels = readColorGroup(state, group);
          channels[channel] = value;
          state.applyColorWrite({ [group]: channels } as Partial<CameraSnapshot["color"]>);
          const packet = groupCommand[group](channels.red, channels.green, channels.blue, channels.luma);
          return send(packet, `${groupLabel(group)} ${channel} ${value.toFixed(2)}`);
        },
      });
    });
  });
}

interface FaderBindingOptions {
  readCurrent: () => number;
  onChange: (value: number) => void;
  send: (value: number) => Promise<void> | void;
}

function bindVerticalFader(
  fader: HTMLElement,
  handle: HTMLElement,
  opts: FaderBindingOptions,
): void {
  const range = readFaderRange(fader);
  const minSendIntervalMs = 60;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientY = 0;
  let startValue = 0;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    void opts.send(value);
  };

  positionVerticalFader(fader, handle, opts.readCurrent());

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    fader.dataset.dragging = "true";
    startClientY = event.clientY;
    startValue = opts.readCurrent();
  });

  fader.addEventListener("pointermove", (event) => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dy = event.clientY - startClientY;
    const verticalRange = (fader.clientHeight - handle.offsetHeight - 16) || 1;
    const startNorm = valueToCenteredNorm(startValue, range);
    const nextNorm = Math.max(0, Math.min(1, startNorm - dy / verticalRange));
    const next = centeredNormToValue(nextNorm, range);
    pendingValue = Number(next.toFixed(3));
    positionVerticalFader(fader, handle, pendingValue);
    opts.onChange(pendingValue);
    flush(false);
  });

  const stop = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    delete fader.dataset.dragging;
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };
  fader.addEventListener("pointerup", stop);
  fader.addEventListener("pointercancel", stop);
  fader.style.touchAction = "none";
}

function bindHorizontalFader(
  root: HTMLElement,
  attr: string,
  label: string,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
  buildPacket: (value: number) => Uint8Array,
  readCurrent: () => number,
  onOptimistic?: (value: number) => void,
): void {
  const fader = root.querySelector<HTMLElement>(`[data-hfader="${attr}"]`);
  const handle = fader?.querySelector<HTMLElement>("[data-hfader-handle]");
  if (!fader || !handle) return;

  const range = readFaderRange(fader);
  const minSendIntervalMs = 60;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientX = 0;
  let startValue = readCurrent();
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    onOptimistic?.(value);
    void send(buildPacket(value), `${label} ${value.toFixed(2)}`);
  };

  positionHorizontalFader(fader, handle, startValue);

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    fader.dataset.dragging = "true";
    startClientX = event.clientX;
    startValue = readCurrent();
  });

  fader.addEventListener("pointermove", (event) => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - startClientX;
    const horizontalRange = (fader.clientWidth - handle.offsetWidth - 16) || 1;
    const startNorm = valueToCenteredNorm(startValue, range);
    const nextNorm = Math.max(0, Math.min(1, startNorm + dx / horizontalRange));
    const next = centeredNormToValue(nextNorm, range);
    pendingValue = Number(next.toFixed(3));
    positionHorizontalFader(fader, handle, pendingValue);
    fader.setAttribute("aria-valuenow", pendingValue.toFixed(2));
    flush(false);
  });

  const stop = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    delete fader.dataset.dragging;
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };
  fader.addEventListener("pointerup", stop);
  fader.addEventListener("pointercancel", stop);
  fader.style.touchAction = "none";
}

function readColorGroup(
  state: CameraState,
  group: PaintGroup,
): Record<PaintChannel, number> {
  const current = state.current.color[group];
  return { red: current.red, green: current.green, blue: current.blue, luma: current.luma };
}

function groupLabel(group: PaintGroup): string {
  return group.charAt(0).toUpperCase() + group.slice(1);
}

function bind(root: HTMLElement, selector: string, eventName: string, handler: (event: Event) => void): void {
  const elements = root.querySelectorAll<HTMLElement>(selector);
  elements.forEach((element) => element.addEventListener(eventName, handler));
}

async function runAction(
  log: (message: string) => void,
  label: string,
  action: () => Promise<void>,
  packet?: Uint8Array,
): Promise<void> {
  const commandLog = packet ? ` (${toHex(packet)})` : "";

  try {
    await action();
    log(`${label}${commandLog}`);
  } catch (error) {
    log(`${label} failed: ${errorMessage(error)}`);
  }
}

function setConnection(root: HTMLElement, message: string): void {
  const element = root.querySelector<HTMLElement>("[data-connection]");
  if (element) {
    element.textContent = message;
  }
}

const ALWAYS_ENABLED_SELECTORS = ["[data-panel-active]", "[data-connect]", "[data-disconnect]", "[data-clear-log]"];

function setControlsEnabled(root: HTMLElement, enabled: boolean): void {
  root.querySelectorAll<HTMLElement>("[data-control]").forEach((element) => {
    if (ALWAYS_ENABLED_SELECTORS.some((sel) => element.matches(sel))) return;
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
      element.disabled = !enabled;
    }
  });
}

function renderStatusFlags(root: HTMLElement, status: CameraStatus): void {
  const statusList = root.querySelector<HTMLUListElement>("[data-status]");
  if (!statusList) return;

  const labels = status.labels.length > 0 ? status.labels : ["No flags set"];
  statusList.replaceChildren(
    ...labels.map((label) => {
      const item = document.createElement("li");
      item.textContent = label;
      return item;
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function attachClient(root: HTMLElement, client: CameraClient): void {
  (root as HTMLElement & { cameraClient?: CameraClient }).cameraClient = client;
}
