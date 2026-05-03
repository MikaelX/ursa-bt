import { decodeConfigurationPacket, type DecodedConfigurationPacket } from "./protocol";
import type { CameraStatus } from "./status";

/**
 * @file cameraState.ts
 *
 * bm-bluetooth — Single UI-facing snapshot aggregated from BLE notifications (`ingestIncomingPacket`),
 * optimistic mirrors (`apply*`), relay bootstrap merges, and telemetry status bytes.
 *
 * Maps decoded {@link DecodedConfigurationPacket} tuples into nested {@link CameraSnapshot} buckets.
 *
 * Companion docs: `docs/BlackmagicCameraControl.pdf`; packet labels in `./protocol`. **Private** repo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Relay / BLE merge heuristics
// ─────────────────────────────────────────────────────────────────────────────

/** URSA ND is not reported reliably over Bluetooth; ignore incoming ND fields from the camera only. */
function snapshotDeviceIsUrsaForBleNd(name: string | undefined): boolean {
  if (!name?.trim()) return false;
  return name.toUpperCase().includes("URSA");
}

function isRelayPanelSyncDecoded(packet: DecodedConfigurationPacket): boolean {
  if (packet.category === 4 && (packet.parameter === 4 || packet.parameter === 6)) return true;
  if (packet.category === 0 && packet.parameter === 8) return true;
  if (
    packet.category === 1 &&
    (packet.parameter === 3 ||
      packet.parameter === 4 ||
      packet.parameter === 9 ||
      packet.parameter === 13 ||
      packet.parameter === 14 ||
      packet.parameter === 15 ||
      packet.parameter === 16 ||
      packet.parameter === 17)
  ) {
    return true;
  }
  if (packet.category === 9 && (packet.parameter === 0 || packet.parameter === 2)) return true;
  // Color correction (lift / gamma / gain / offset / contrast / luma mix / hue+sat)
  if (packet.category === 8 && packet.parameter >= 0 && packet.parameter <= 6) return true;
  // Audio: mic, phones, speaker, input type, L/R channel gain, phantom (joiner → host mirror + panel_sync)
  if (packet.category === 2 && packet.parameter >= 0 && packet.parameter <= 6) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Snapshot wire model (`CameraSnapshot` + listeners)
// ─────────────────────────────────────────────────────────────────────────────

export interface LiftGainGamma {
  red: number;
  green: number;
  blue: number;
  luma: number;
}

export interface CameraSnapshot {
  status?: CameraStatus;
  cameraNumber?: number;
  recording: boolean;
  transportMode?: number;
  codec?: { basic: number; variant: number };
  recordingFormat?: {
    frameRate?: number;
    sensorFrameRate?: number;
    frameWidth?: number;
    frameHeight?: number;
  };
  offSpeedFrameRate?: number;
  whiteBalance?: { temperature: number; tint: number };
  autoExposureMode?: number;
  shutterAngle?: number;
  shutterSpeed?: number;
  iso?: number;
  gainDb?: number;
  lens: {
    focus?: number;
    aperture?: number;
    apertureFstop?: number;
    apertureNormalised?: number;
    opticalImageStabilisation?: boolean;
    /** Zoom position 0–1 from lens parameter 8 (normalised). */
    zoom?: number;
    /** Focal length mm from lens parameter 7 when reported. */
    zoomMm?: number;
  };
  color: {
    lift: LiftGainGamma;
    gamma: LiftGainGamma;
    gain: LiftGainGamma;
    offset: LiftGainGamma;
    contrast?: { pivot: number; adjust: number };
    saturation?: number;
    hue?: number;
    lumaMix?: number;
  };
  audio: {
    micLevel?: number;
    headphoneLevel?: number;
    headphoneProgramMix?: number;
    speakerLevel?: number;
    inputType?: number;
    inputLevels?: { left: number; right: number };
    phantomPower?: boolean;
  };
  ndFilterStops?: number;
  ndFilterDisplayMode?: number;
  dynamicRange?: number;
  sharpeningLevel?: number;
  displayLut?: { selected: number; enabled: boolean };
  /** Display outputs toggled locally or via relay; not always echoed on BLE incoming. */
  unitOutputs?: { colorBars: boolean; programReturnFeed: boolean };
  /**
   * Chassis / video UI: "auto WB" one-shot armed (Set auto WB); not a separate BLE status byte.
   * Cleared on Restore auto WB, manual WB/tint steps, or when the camera reports WB (param 2).
   */
  autoWhiteBalanceActive?: boolean;
  exposureUs?: number;
  tally?: {
    programMe: boolean;
    previewMe: boolean;
    brightness?: { master?: number; front?: number; rear?: number };
  };
  metadata: {
    reelNumber?: number;
    sceneTags?: number[];
    sceneId?: string;
    takeNumber?: number;
    goodTake?: boolean;
    slateForName?: string;
    slateForType?: number;
    cameraId?: string;
  };
  deviceName?: string;
  lastUpdateMs?: number;
  updatedKeys: string[];
}

export type SnapshotListener = (snapshot: CameraSnapshot) => void;

export interface IngestIncomingResult {
  decoded: DecodedConfigurationPacket | undefined;
  /** Keys updated on the live snapshot; empty if the packet was not mapped to UI/state. */
  changedKeys: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults & JSON bridge for relay `panel_sync`
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_LGG = (): LiftGainGamma => ({ red: 0, green: 0, blue: 0, luma: 0 });

function createEmptySnapshot(): CameraSnapshot {
  return {
    recording: false,
    lens: {},
    color: {
      lift: EMPTY_LGG(),
      gamma: EMPTY_LGG(),
      gain: { red: 0, green: 0, blue: 0, luma: 0 },
      offset: EMPTY_LGG(),
    },
    audio: {},
    metadata: {},
    unitOutputs: { colorBars: false, programReturnFeed: false },
    ndFilterStops: 0,
    ndFilterDisplayMode: 0,
    updatedKeys: [],
  };
}

/**
 * JSON snapshot used on relay **`panel_sync`** / bootstrap payloads.
 * Drops `updatedKeys` + `lastUpdateMs` bookkeeping so joiners hydrate clean objects.
 */
export function serializeCameraSnapshotForRelay(snapshot: CameraSnapshot): Record<string, unknown> {
  try {
    const raw = JSON.parse(JSON.stringify(snapshot)) as Record<string, unknown>;
    delete raw.updatedKeys;
    delete raw.lastUpdateMs;
    return raw;
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Mutable store + emitter (`CameraState`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Central reactive camera model for the SPA: exposes {@link CameraSnapshot} plus subscribe/reset semantics.
 *
 * @remarks Incoming BLE traffic mutates shallow copies via {@link CameraState.ingestIncomingPacket}.
 * Relay joiners hydrate through {@link CameraState.hydrateFromRelayExport} instead of redoing handshake.
 */
export class CameraState {
  private snapshot: CameraSnapshot = createEmptySnapshot();
  private readonly listeners = new Set<SnapshotListener>();

  get current(): CameraSnapshot {
    return this.snapshot;
  }

  subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // --- Lifecycle & identity hooks ---

  reset(): void {
    this.snapshot = createEmptySnapshot();
    this.emit(["reset"]);
  }

  /** Apply a serialized snapshot pushed by the BLE host after joining the relay session. */
  hydrateFromRelayExport(imported: unknown): void {
    if (!imported || typeof imported !== "object") return;
    let raw: Partial<CameraSnapshot>;
    try {
      raw = JSON.parse(JSON.stringify(imported)) as Partial<CameraSnapshot>;
    } catch {
      return;
    }
    const merged = relayMergeImportedSnapshot(createEmptySnapshot(), raw);
    this.snapshot = merged;
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  setDeviceName(name: string): void {
    this.update(["deviceName"], (draft) => {
      draft.deviceName = name;
    });
  }

  clearDeviceName(): void {
    this.update(["deviceName"], (draft) => {
      delete draft.deviceName;
    });
  }

  /**
   * Drop presentation fields that came from the live camera over BLE. Called when the
   * GATT session ends so the UI does not keep showing stale power/status/recording.
   */
  clearForLocalBleDisconnect(): void {
    this.update(["localBleDisconnect"], (draft) => {
      delete draft.status;
      delete draft.deviceName;
      draft.recording = false;
      delete draft.transportMode;
    });
  }

  // --- BLE ingestion ---

  ingestStatus(status: CameraStatus): void {
    this.update(["status"], (draft) => {
      draft.status = status;
    });
  }

  ingestIncomingPacket(data: DataView | Uint8Array): IngestIncomingResult {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const decoded = decodeConfigurationPacket(bytes);

    if (!decoded) {
      return { decoded: undefined, changedKeys: [] };
    }

    const changedKeys = applyDecoded(this.snapshot, decoded, "ble-incoming");

    if (changedKeys.length > 0) {
      this.emit(changedKeys);
    }

    return { decoded, changedKeys };
  }

  // --- Optimistic UI mirrors (not always echoed inbound on BLE) ---

  /** Optimistic ND stops (e.g. URSA mechanical wheel — UI / banks / relay only). */
  applyNdFilterStopsWrite(stops: number): void {
    this.update(["ndFilterStops"], (draft) => {
      draft.ndFilterStops = stops;
    });
  }

  setRecording(recording: boolean): void {
    this.update(["recording"], (draft) => {
      draft.recording = recording;
    });
  }

  setCameraNumber(cameraNumber: number): void {
    this.update(["cameraNumber"], (draft) => {
      draft.cameraNumber = cameraNumber;
    });
  }

  /** Optimistic master gain (dB); camera may not echo every write over BLE. */
  applyGainDbWrite(gainDb: number): void {
    this.update(["gainDb"], (draft) => {
      draft.gainDb = gainDb;
    });
  }

  /** Optimistic ISO; camera may not echo every write over BLE. */
  applyIsoWrite(iso: number): void {
    this.update(["iso"], (draft) => {
      draft.iso = iso;
    });
  }

  /** Mirrors the auto-WB toggle LED (Set / Restore auto WB); host + joiners stay aligned over relay. */
  setAutoWhiteBalanceActive(active: boolean): void {
    this.update(["autoWhiteBalanceActive"], (draft) => {
      draft.autoWhiteBalanceActive = active;
    });
  }

  /**
   * Optimistically merge an audio write into the snapshot. Use this for parameters
   * the camera does not reliably echo, so banks/last-state still capture them.
   */
  applyAudioWrite(patch: Partial<CameraSnapshot["audio"]>): void {
    const keys = Object.keys(patch).map((k) => `audio.${k}`);
    this.update(keys, (draft) => {
      draft.audio = { ...draft.audio, ...patch };
    });
  }

  /**
   * Optimistically merge a color-correction write into the snapshot. The camera
   * does not reliably echo color values, so we mirror what we just sent so that
   * banks/last-state and the live UI stay accurate.
   */
  applyColorWrite(patch: Partial<CameraSnapshot["color"]>): void {
    const keys = Object.keys(patch).map((k) => `color.${k}`);
    this.update(keys, (draft) => {
      draft.color = {
        ...draft.color,
        ...patch,
        lift: patch.lift ? { ...draft.color.lift, ...patch.lift } : draft.color.lift,
        gamma: patch.gamma ? { ...draft.color.gamma, ...patch.gamma } : draft.color.gamma,
        gain: patch.gain ? { ...draft.color.gain, ...patch.gain } : draft.color.gain,
        offset: patch.offset ? { ...draft.color.offset, ...patch.offset } : draft.color.offset,
        contrast: patch.contrast
          ? { ...(draft.color.contrast ?? { pivot: 0.5, adjust: 1 }), ...patch.contrast }
          : draft.color.contrast,
      };
    });
  }

  /**
   * Reset color-correction state to neutral defaults (matches camera "Color Reset").
   */
  resetColor(): void {
    this.update(["color.reset"], (draft) => {
      draft.color = {
        lift: EMPTY_LGG(),
        gamma: EMPTY_LGG(),
        gain: { red: 0, green: 0, blue: 0, luma: 0 },
        offset: EMPTY_LGG(),
        contrast: { pivot: 0.5, adjust: 1 },
        lumaMix: 1,
        hue: 0,
        saturation: 1,
      };
    });
  }

  applyTallyBrightnessWrite(patch: { master?: number; front?: number; rear?: number }): void {
    const keys = Object.keys(patch).map((k) => `tally.brightness.${k}`);
    this.update(keys, (draft) => {
      const existing = draft.tally ?? { programMe: false, previewMe: false };
      draft.tally = { ...existing, brightness: { ...(existing.brightness ?? {}), ...patch } };
    });
  }

  applyMetadataWrite(patch: Partial<CameraSnapshot["metadata"]>): void {
    const keys = Object.keys(patch).map((k) => `metadata.${k}`);
    this.update(keys, (draft) => {
      draft.metadata = { ...draft.metadata, ...patch };
    });
  }

  /** Mirror display LUT UI when the camera does not echo the write. */
  applyDisplayLutWrite(patch: Partial<NonNullable<CameraSnapshot["displayLut"]>>): void {
    const keys = Object.keys(patch).map((k) => `displayLut.${k}`);
    this.update(keys, (draft) => {
      draft.displayLut = { ...(draft.displayLut ?? { selected: 0, enabled: false }), ...patch };
    });
  }

  applyUnitOutputsWrite(patch: Partial<NonNullable<CameraSnapshot["unitOutputs"]>>): void {
    const keys = Object.keys(patch).map((k) => `unitOutputs.${k}`);
    this.update(keys, (draft) => {
      const cur = draft.unitOutputs ?? { colorBars: false, programReturnFeed: false };
      draft.unitOutputs = { ...cur, ...patch };
    });
  }

  // --- Relay joiner/host panel sync merges ---

  /**
   * Apply command bytes that affect shared panel state (bars, LUT, color, etc.)
   * so the host can mirror joiner writes before broadcasting `panel_sync`.
   */
  applyRelayPanelSyncFromCommandBytes(bytes: Uint8Array): boolean {
    const decoded = decodeConfigurationPacket(bytes);
    if (!decoded || !isRelayPanelSyncDecoded(decoded)) return false;
    const keys = applyDecoded(this.snapshot, decoded, "relay-command");
    if (keys.length === 0) return false;
    this.emit(keys);
    return true;
  }

  /** Merge a partial snapshot from the host (bars, LUT, color, camera id, …). */
  relayPanelSyncPatch(partial: Record<string, unknown>): void {
    if (!partial || typeof partial !== "object") return;
    let raw: Partial<CameraSnapshot>;
    try {
      raw = JSON.parse(JSON.stringify(partial)) as Partial<CameraSnapshot>;
    } catch {
      return;
    }
    const merged = relayMergeImportedSnapshot(this.snapshot, raw);
    merged.updatedKeys = ["relay-panel-sync"];
    merged.lastUpdateMs = Date.now();
    this.snapshot = merged;
    this.listeners.forEach((listener) => listener(this.snapshot));
  }

  // --- Immutable-ish update plumbing ---

  private update(keys: string[], mutate: (draft: CameraSnapshot) => void): void {
    const next = { ...this.snapshot, updatedKeys: keys, lastUpdateMs: Date.now() };
    next.lens = { ...this.snapshot.lens };
    next.color = {
      ...this.snapshot.color,
      lift: { ...this.snapshot.color.lift },
      gamma: { ...this.snapshot.color.gamma },
      gain: { ...this.snapshot.color.gain },
      offset: { ...this.snapshot.color.offset },
    };
    next.audio = { ...this.snapshot.audio };
    next.metadata = { ...this.snapshot.metadata };
    mutate(next);
    this.snapshot = next;
    this.listeners.forEach((listener) => listener(next));
  }

  private emit(keys: string[]): void {
    this.update(keys, () => undefined);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Relay sniffing helpers (mirrored panel deltas)
// ─────────────────────────────────────────────────────────────────────────────

/** True when a successful BLE write of this packet should trigger relay `panel_sync` from the host. */
export function shouldRelayPanelSyncCommand(packet: Uint8Array): boolean {
  const decoded = decodeConfigurationPacket(packet);
  return decoded !== undefined && isRelayPanelSyncDecoded(decoded);
}

/**
 * Materialize decoded tuples onto the authoritative snapshot bucket used by relays + UI.
 *
 * @param source Distinguishes joiner-command mirroring paths from live BLE ingestion (URSA ND guard).
 */
function applyDecoded(
  snapshot: CameraSnapshot,
  packet: DecodedConfigurationPacket,
  source: "ble-incoming" | "relay-command",
): string[] {
  const changed: string[] = [];
  const [v0 = 0, v1 = 0, v2 = 0, v3 = 0, v4 = 0] = packet.values;

  const mark = (key: string): void => {
    changed.push(key);
  };

  switch (packet.category) {
    case 0: // Lens
      switch (packet.parameter) {
        case 0:
          snapshot.lens.focus = v0;
          mark("lens.focus");
          break;
        case 2:
          snapshot.lens.apertureFstop = v0;
          mark("lens.apertureFstop");
          break;
        case 3:
          snapshot.lens.apertureNormalised = v0;
          mark("lens.apertureNormalised");
          break;
        case 6:
          snapshot.lens.opticalImageStabilisation = v0 !== 0;
          mark("lens.opticalImageStabilisation");
          break;
        case 7:
          snapshot.lens.zoomMm = v0;
          mark("lens.zoomMm");
          break;
        case 8:
          snapshot.lens.zoom = v0;
          mark("lens.zoom");
          break;
      }
      break;
    case 1: // Video
      switch (packet.parameter) {
        case 2:
          snapshot.whiteBalance = { temperature: v0, tint: v1 };
          snapshot.autoWhiteBalanceActive = false;
          mark("whiteBalance");
          break;
        case 3:
          snapshot.autoWhiteBalanceActive = true;
          mark("autoWhiteBalanceActive");
          break;
        case 4:
          snapshot.autoWhiteBalanceActive = false;
          mark("autoWhiteBalanceActive");
          break;
        case 5:
          snapshot.exposureUs = v0;
          mark("exposureUs");
          break;
        case 7:
          snapshot.dynamicRange = v0;
          mark("dynamicRange");
          break;
        case 8:
          snapshot.sharpeningLevel = v0;
          mark("sharpeningLevel");
          break;
        case 15:
          snapshot.displayLut = { selected: v0, enabled: v1 !== 0 };
          mark("displayLut");
          break;
        case 9: {
          snapshot.recordingFormat = mergeRecordingFormat(snapshot.recordingFormat, packet.values);
          mark("recordingFormat");
          break;
        }
        case 10:
          snapshot.autoExposureMode = v0;
          mark("autoExposureMode");
          break;
        case 11:
          snapshot.shutterAngle = v0;
          mark("shutterAngle");
          break;
        case 12:
          snapshot.shutterSpeed = v0;
          mark("shutterSpeed");
          break;
        case 13:
          snapshot.gainDb = v0;
          mark("gainDb");
          break;
        case 14:
          snapshot.iso = v0;
          mark("iso");
          break;
        case 16: {
          if (source === "ble-incoming" && snapshotDeviceIsUrsaForBleNd(snapshot.deviceName)) {
            break;
          }
          snapshot.ndFilterStops = v0;
          mark("ndFilterStops");
          if (packet.values.length >= 2) {
            const mode = Math.round(packet.values[1] ?? 0);
            snapshot.ndFilterDisplayMode = Math.min(2, Math.max(0, mode));
            mark("ndFilterDisplayMode");
          }
          break;
        }
        case 17: {
          if (source === "ble-incoming" && snapshotDeviceIsUrsaForBleNd(snapshot.deviceName)) {
            break;
          }
          snapshot.ndFilterDisplayMode = Math.round(v0);
          mark("ndFilterDisplayMode");
          break;
        }
      }
      break;
    case 2: // Audio
      switch (packet.parameter) {
        case 0:
          snapshot.audio.micLevel = v0;
          mark("audio.micLevel");
          break;
        case 1:
          snapshot.audio.headphoneLevel = v0;
          mark("audio.headphoneLevel");
          break;
        case 2:
          snapshot.audio.headphoneProgramMix = v0;
          mark("audio.headphoneProgramMix");
          break;
        case 3:
          snapshot.audio.speakerLevel = v0;
          mark("audio.speakerLevel");
          break;
        case 4:
          snapshot.audio.inputType = v0;
          mark("audio.inputType");
          break;
        case 5:
          snapshot.audio.inputLevels = { left: v0, right: v1 };
          mark("audio.inputLevels");
          break;
        case 6:
          snapshot.audio.phantomPower = v0 !== 0;
          mark("audio.phantomPower");
          break;
      }
      break;
    case 4: // Display (bars / program return — may not echo on incoming)
      switch (packet.parameter) {
        case 4: {
          const uo = snapshot.unitOutputs ?? { colorBars: false, programReturnFeed: false };
          snapshot.unitOutputs = { ...uo, colorBars: v0 !== 0 };
          mark("unitOutputs.colorBars");
          break;
        }
        case 6: {
          const uo = snapshot.unitOutputs ?? { colorBars: false, programReturnFeed: false };
          snapshot.unitOutputs = { ...uo, programReturnFeed: v0 !== 0 };
          mark("unitOutputs.programReturnFeed");
          break;
        }
      }
      break;
    case 8: // Color correction
      switch (packet.parameter) {
        case 0:
          snapshot.color.lift = { red: v0, green: v1, blue: v2, luma: v3 };
          mark("color.lift");
          break;
        case 1:
          snapshot.color.gamma = { red: v0, green: v1, blue: v2, luma: v3 };
          mark("color.gamma");
          break;
        case 2:
          snapshot.color.gain = { red: v0, green: v1, blue: v2, luma: v3 };
          mark("color.gain");
          break;
        case 3:
          snapshot.color.offset = { red: v0, green: v1, blue: v2, luma: v3 };
          mark("color.offset");
          break;
        case 4:
          snapshot.color.contrast = { pivot: v0, adjust: v1 };
          mark("color.contrast");
          break;
        case 5:
          snapshot.color.lumaMix = v0;
          mark("color.lumaMix");
          break;
        case 6:
          snapshot.color.hue = v0;
          snapshot.color.saturation = v1;
          mark("color.hueSat");
          break;
      }
      break;
    case 9: // Recording format
      if (packet.parameter === 0) {
        snapshot.recordingFormat = mergeRecordingFormat(snapshot.recordingFormat, packet.values);
        mark("recordingFormat");
      } else if (packet.parameter === 2) {
        snapshot.offSpeedFrameRate = v0;
        mark("offSpeedFrameRate");
      }
      break;
    case 10: // Media / transport
      if (packet.parameter === 0) {
        snapshot.codec = { basic: v0, variant: v1 };
        mark("codec");
      } else if (packet.parameter === 1) {
        snapshot.transportMode = v0;
        snapshot.recording = v0 === 2;
        mark("transport");
      }
      break;
    case 5: { // Tally brightness (writes echo back as fixed16)
      const existing = snapshot.tally ?? { programMe: false, previewMe: false };
      const brightness = { ...(existing.brightness ?? {}) };
      if (packet.parameter === 0) brightness.master = v0;
      else if (packet.parameter === 1) brightness.front = v0;
      else if (packet.parameter === 2) brightness.rear = v0;
      snapshot.tally = { ...existing, brightness };
      mark("tally.brightness");
      break;
    }
    case 12: // Metadata (mostly strings, we keep raw for debug)
      if (packet.parameter === 0) {
        snapshot.metadata.reelNumber = v0;
        mark("metadata.reelNumber");
      } else if (packet.parameter === 1) {
        snapshot.metadata.sceneTags = packet.values;
        mark("metadata.sceneTags");
      } else if (packet.parameter === 2) {
        snapshot.metadata.sceneId = stringFromValues(packet.values);
        mark("metadata.sceneId");
      } else if (packet.parameter === 3) {
        snapshot.metadata.takeNumber = v0;
        mark("metadata.takeNumber");
      } else if (packet.parameter === 4) {
        snapshot.metadata.goodTake = v0 !== 0;
        mark("metadata.goodTake");
      } else if (packet.parameter === 5) {
        snapshot.metadata.cameraId = packet.stringValue ?? stringFromValues(packet.values);
        mark("metadata.cameraId");
      } else if (packet.parameter === 14) {
        snapshot.metadata.slateForType = v0;
        mark("metadata.slateForType");
      } else if (packet.parameter === 15) {
        snapshot.metadata.slateForName = stringFromValues(packet.values);
        mark("metadata.slateForName");
      }
      break;
  }

  void v4;
  return changed;
}

// ─────────────────────────────────────────────────────────────────────────────
// Deep merge utilities for bootstrap / partial relay patches
// ─────────────────────────────────────────────────────────────────────────────

/** Deep-merge relay JSON into defaults so joining clients inherit the master's live panel snapshot. */
function relayMergeImportedSnapshot(base: CameraSnapshot, p: Partial<CameraSnapshot>): CameraSnapshot {
  const metadata = {
    ...base.metadata,
    ...p.metadata,
    sceneTags:
      Array.isArray(p.metadata?.sceneTags)
        ? [...p.metadata.sceneTags]
        : base.metadata.sceneTags
          ? [...base.metadata.sceneTags]
          : undefined,
  };

  const next: CameraSnapshot = {
    ...base,
    ...p,
    status: p.status !== undefined ? p.status : base.status,
    recording: typeof p.recording === "boolean" ? p.recording : base.recording,
    lens: { ...base.lens, ...p.lens },
    audio: { ...base.audio, ...p.audio },
    metadata,
    color: {
      ...base.color,
      ...p.color,
      lift: { ...base.color.lift, ...p.color?.lift },
      gamma: { ...base.color.gamma, ...p.color?.gamma },
      gain: { ...base.color.gain, ...p.color?.gain },
      offset: { ...base.color.offset, ...p.color?.offset },
      contrast:
        p.color?.contrast !== undefined
          ? { ...(base.color.contrast ?? { pivot: 0.5, adjust: 1 }), ...p.color.contrast }
          : base.color.contrast,
    },
    tally: p.tally
      ? {
          ...(base.tally ?? { programMe: false, previewMe: false }),
          ...p.tally,
          brightness: {
            ...(base.tally?.brightness ?? {}),
            ...(p.tally.brightness ?? {}),
          },
        }
      : base.tally,
    codec:
      p.codec !== undefined ? { ...(base.codec ?? { basic: 0, variant: 0 }), ...p.codec } : base.codec,
    recordingFormat:
      p.recordingFormat !== undefined
        ? { ...(base.recordingFormat ?? {}), ...p.recordingFormat }
        : base.recordingFormat,
    displayLut:
      p.displayLut !== undefined
        ? { ...(base.displayLut ?? { selected: 0, enabled: false }), ...p.displayLut }
        : base.displayLut,
    unitOutputs:
      p.unitOutputs !== undefined
        ? {
            ...(base.unitOutputs ?? { colorBars: false, programReturnFeed: false }),
            ...p.unitOutputs,
          }
        : base.unitOutputs,
    whiteBalance:
      p.whiteBalance !== undefined
        ? { ...(base.whiteBalance ?? { temperature: 0, tint: 0 }), ...p.whiteBalance }
        : base.whiteBalance,
    autoWhiteBalanceActive:
      typeof p.autoWhiteBalanceActive === "boolean"
        ? p.autoWhiteBalanceActive
        : base.autoWhiteBalanceActive,
    gainDb: typeof p.gainDb === "number" && !Number.isNaN(p.gainDb) ? p.gainDb : base.gainDb,
    exposureUs:
      typeof p.exposureUs === "number" && !Number.isNaN(p.exposureUs) ? p.exposureUs : base.exposureUs,
    shutterSpeed:
      typeof p.shutterSpeed === "number" && !Number.isNaN(p.shutterSpeed) ? p.shutterSpeed : base.shutterSpeed,
    iso: typeof p.iso === "number" ? p.iso : base.iso,
    ndFilterStops: typeof p.ndFilterStops === "number" ? p.ndFilterStops : base.ndFilterStops,
    ndFilterDisplayMode:
      typeof p.ndFilterDisplayMode === "number" ? p.ndFilterDisplayMode : base.ndFilterDisplayMode,
    deviceName: typeof p.deviceName === "string" && p.deviceName.length > 0 ? p.deviceName : base.deviceName,
  };

  next.updatedKeys = ["relay-bootstrap"];
  next.lastUpdateMs = Date.now();

  return next;
}

/**
 * Merge an incoming recording-format payload into the existing snapshot.
 *
 * The camera typically sends two packets: a full one with frameRate + resolution,
 * followed by an update with only frameRate populated (resolution fields = 0).
 * Treat zero as "no value" so we don't blow away the resolution we already have.
 */
function mergeRecordingFormat(
  existing: CameraSnapshot["recordingFormat"],
  values: number[],
): NonNullable<CameraSnapshot["recordingFormat"]> {
  const [frameRate = 0, sensorFrameRate = 0, frameWidth = 0, frameHeight = 0] = values;
  const next = { ...(existing ?? {}) };
  if (frameRate > 0) next.frameRate = frameRate;
  if (sensorFrameRate > 0) next.sensorFrameRate = sensorFrameRate;
  if (frameWidth > 0) next.frameWidth = frameWidth;
  if (frameHeight > 0) next.frameHeight = frameHeight;
  return next;
}

function stringFromValues(values: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(values));
  } catch {
    return values.map((value) => value.toString(16).padStart(2, "0")).join(" ");
  }
}
