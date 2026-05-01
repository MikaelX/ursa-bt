import { decodeConfigurationPacket, type DecodedConfigurationPacket } from "./protocol";
import type { CameraStatus } from "./status";

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
    zoom?: number;
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

const EMPTY_LGG = (): LiftGainGamma => ({ red: 0, green: 0, blue: 0, luma: 0 });

function createEmptySnapshot(): CameraSnapshot {
  return {
    recording: false,
    lens: {},
    color: {
      lift: EMPTY_LGG(),
      gamma: EMPTY_LGG(),
      gain: { red: 1, green: 1, blue: 1, luma: 1 },
      offset: EMPTY_LGG(),
    },
    audio: {},
    metadata: {},
    updatedKeys: [],
  };
}

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

  reset(): void {
    this.snapshot = createEmptySnapshot();
    this.emit(["reset"]);
  }

  setDeviceName(name: string): void {
    this.update(["deviceName"], (draft) => {
      draft.deviceName = name;
    });
  }

  ingestStatus(status: CameraStatus): void {
    this.update(["status"], (draft) => {
      draft.status = status;
    });
  }

  ingestIncomingPacket(data: DataView | Uint8Array): DecodedConfigurationPacket | undefined {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const decoded = decodeConfigurationPacket(bytes);

    if (!decoded) {
      return undefined;
    }

    const changedKeys = applyDecoded(this.snapshot, decoded);

    if (changedKeys.length > 0) {
      this.emit(changedKeys);
    }

    return decoded;
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
        gain: { red: 1, green: 1, blue: 1, luma: 1 },
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

function applyDecoded(
  snapshot: CameraSnapshot,
  packet: DecodedConfigurationPacket,
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
          snapshot.lens.zoom = v0;
          mark("lens.zoom");
          break;
      }
      break;
    case 1: // Video
      switch (packet.parameter) {
        case 2:
          snapshot.whiteBalance = { temperature: v0, tint: v1 };
          mark("whiteBalance");
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
        case 16:
          snapshot.ndFilterStops = v0;
          mark("ndFilterStops");
          break;
        case 17:
          snapshot.ndFilterDisplayMode = v0;
          mark("ndFilterDisplayMode");
          break;
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
