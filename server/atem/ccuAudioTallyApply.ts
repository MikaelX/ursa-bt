/**
 * Applies ATEM Camera Control **Audio** (category 2) and **Tally** (category 5) commands into
 * buckets keyed by CC `source` / camera id. Mirrors {@link AtemCameraControlCategory} in
 * `@atem-connection/camera-control` (builder leaves these as unhandled).
 */
import { Commands } from "atem-connection";

/** Same numeric values as AtemCameraControlCategory / ids in @atem-connection/camera-control */
const CC_AUDIO = 2;
const CC_TALLY = 5;

/** Same as AtemCameraControlAudioParameter */
const AU_MIC = 0;
const AU_HEADPHONE = 1;
const AU_HEADPHONE_PROG_MIX = 2;
const AU_SPEAKER = 3;
const AU_INPUT_TYPE = 4;
const AU_INPUT_LEVELS = 5;
const AU_PHANTOM = 6;

/** Same as AtemCameraControlTallyParameter */
const TL_MASTER = 0;
const TL_FRONT = 1;
const TL_REAR = 2;

export type CcuAudioTallyBucket = {
  audio: {
    micLevel?: number;
    headphoneLevel?: number;
    headphoneProgramMix?: number;
    speakerLevel?: number;
    inputType?: number;
    inputLevels?: { left: number; right: number };
    phantomPower?: boolean;
  };
  tallyBrightness?: { master?: number; front?: number; rear?: number };
};

function ensureBucket(map: Map<number, CcuAudioTallyBucket>, source: number): CcuAudioTallyBucket {
  let b = map.get(source);
  if (!b) {
    b = { audio: {} };
    map.set(source, b);
  }
  return b;
}

function validFloat(cmd: Commands.CameraControlUpdateCommand, min: number): boolean {
  return (
    cmd.properties.type === Commands.CameraControlDataType.FLOAT &&
    cmd.properties.numberData.length >= min
  );
}

function validBool(cmd: Commands.CameraControlUpdateCommand, min: number): boolean {
  return (
    cmd.properties.type === Commands.CameraControlDataType.BOOL && cmd.properties.boolData.length >= min
  );
}

function validSint8(cmd: Commands.CameraControlUpdateCommand, min: number): boolean {
  return (
    cmd.properties.type === Commands.CameraControlDataType.SINT8 &&
    cmd.properties.numberData.length >= min
  );
}

/** Apply audio/tally CC commands; returns sources that received at least one applied field. */
export function applyCcuAudioTallyCommands(
  commands: Commands.CameraControlUpdateCommand[],
  buckets: Map<number, CcuAudioTallyBucket>,
): Set<number> {
  const touched = new Set<number>();
  for (const cmd of commands) {
    if (cmd.category === CC_AUDIO) {
      const b = ensureBucket(buckets, cmd.source);
      switch (cmd.parameter) {
        case AU_MIC:
          if (validFloat(cmd, 1)) {
            b.audio.micLevel = cmd.properties.numberData[0]!;
            touched.add(cmd.source);
          }
          break;
        case AU_HEADPHONE:
          if (validFloat(cmd, 1)) {
            b.audio.headphoneLevel = cmd.properties.numberData[0]!;
            touched.add(cmd.source);
          }
          break;
        case AU_HEADPHONE_PROG_MIX:
          if (validFloat(cmd, 1)) {
            b.audio.headphoneProgramMix = cmd.properties.numberData[0]!;
            touched.add(cmd.source);
          }
          break;
        case AU_SPEAKER:
          if (validFloat(cmd, 1)) {
            b.audio.speakerLevel = cmd.properties.numberData[0]!;
            touched.add(cmd.source);
          }
          break;
        case AU_INPUT_TYPE:
          if (validSint8(cmd, 1)) {
            b.audio.inputType = cmd.properties.numberData[0]!;
            touched.add(cmd.source);
          } else if (validFloat(cmd, 1)) {
            b.audio.inputType = cmd.properties.numberData[0]!;
            touched.add(cmd.source);
          }
          break;
        case AU_INPUT_LEVELS:
          if (validFloat(cmd, 2)) {
            b.audio.inputLevels = {
              left: cmd.properties.numberData[0]!,
              right: cmd.properties.numberData[1]!,
            };
            touched.add(cmd.source);
          }
          break;
        case AU_PHANTOM:
          if (validBool(cmd, 1)) {
            b.audio.phantomPower = cmd.properties.boolData[0]!;
            touched.add(cmd.source);
          }
          break;
        default:
          break;
      }
      continue;
    }

    if (cmd.category === CC_TALLY) {
      const b = ensureBucket(buckets, cmd.source);
      const brightness = { ...(b.tallyBrightness ?? {}) };
      let ok = false;
      if (cmd.parameter === TL_MASTER && validFloat(cmd, 1)) {
        brightness.master = cmd.properties.numberData[0]!;
        ok = true;
      } else if (cmd.parameter === TL_FRONT && validFloat(cmd, 1)) {
        brightness.front = cmd.properties.numberData[0]!;
        ok = true;
      } else if (cmd.parameter === TL_REAR && validFloat(cmd, 1)) {
        brightness.rear = cmd.properties.numberData[0]!;
        ok = true;
      }
      if (ok) {
        b.tallyBrightness = brightness;
        touched.add(cmd.source);
      }
    }
  }
  return touched;
}

/** Partial snapshot keys for relay merge (matches app {@link CameraSnapshot} audio / tally). */
export function ccuAudioTallyToSnapshotPatch(bucket: CcuAudioTallyBucket): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  if (Object.keys(bucket.audio).length > 0) {
    patch.audio = { ...bucket.audio };
  }
  if (bucket.tallyBrightness && Object.keys(bucket.tallyBrightness).length > 0) {
    patch.tally = {
      programMe: false,
      previewMe: false,
      brightness: { ...bucket.tallyBrightness },
    };
  }
  return patch;
}

/** Flat summary for relay trace sidecar `__atemCcuTrace` / server debug (audio + tally brightness bucket). */
export function audioTallyBucketTraceSummary(bucket: CcuAudioTallyBucket | undefined): Record<string, unknown> {
  if (!bucket) return {};
  const out: Record<string, unknown> = {};
  if (Object.keys(bucket.audio).length > 0) out.audio = { ...bucket.audio };
  const a = bucket.audio;
  /** ATEM CC “Input levels” (typically live meters; same values as `audio.inputLevels`). */
  if (a.inputLevels) {
    out.ccuAudioInputLevels = { left: a.inputLevels.left, right: a.inputLevels.right };
  }
  /** Camera / input mic fader (CC MicLevel). */
  if (a.micLevel !== undefined) out.ccuMicLevel = a.micLevel;
  if (bucket.tallyBrightness && Object.keys(bucket.tallyBrightness).length > 0) {
    out.tallyBrightness = { ...bucket.tallyBrightness };
  }
  return out;
}
