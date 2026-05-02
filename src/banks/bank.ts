import { commands } from "../blackmagic/protocol";
import type { CameraSnapshot, LiftGainGamma } from "../blackmagic/cameraState";

export const BANK_COUNT = 5;

export interface Bank {
  cameraNumber?: number;
  whiteBalance?: { temperature: number; tint: number };
  gainDb?: number;
  iso?: number;
  shutterAngle?: number;
  iris?: number;
  focus?: number;
  autoExposureMode?: number;
  color: {
    lift: LiftGainGamma;
    gamma: LiftGainGamma;
    gain: LiftGainGamma;
    offset: LiftGainGamma;
    contrast?: { pivot: number; adjust: number };
    lumaMix?: number;
    hue?: number;
    saturation?: number;
  };
  audio?: {
    micLevel?: number;
    headphoneLevel?: number;
    headphoneProgramMix?: number;
    speakerLevel?: number;
    inputType?: number;
    inputLevels?: { left: number; right: number };
    phantomPower?: boolean;
  };
  ndFilterStops?: number;
  /** 0 = stops, 1 = density, 2 = transmittance — echoed with ND stops (param 16). */
  ndFilterDisplayMode?: number;
  dynamicRange?: number;
  sharpeningLevel?: number;
  displayLut?: { selected: number; enabled: boolean };
  exposureUs?: number;
  tallyBrightness?: { master?: number; front?: number; rear?: number };
  metadataCameraId?: string;
}

export interface BanksFile {
  banks: Array<Bank | null>;
  loadedSlot: number | null;
  lastState: Bank | null;
  updatedAt: number;
}

export function emptyBanksFile(): BanksFile {
  return {
    banks: Array.from({ length: BANK_COUNT }, () => null),
    loadedSlot: null,
    lastState: null,
    updatedAt: Date.now(),
  };
}

export function buildBankFromSnapshot(snapshot: CameraSnapshot): Bank {
  return {
    cameraNumber: snapshot.cameraNumber,
    whiteBalance: snapshot.whiteBalance ? { ...snapshot.whiteBalance } : undefined,
    gainDb: snapshot.gainDb,
    iso: snapshot.iso,
    shutterAngle:
      snapshot.shutterAngle !== undefined
        ? snapshot.shutterAngle / 100
        : snapshot.shutterSpeed
          ? clampShutter(180)
          : undefined,
    iris: snapshot.lens.apertureNormalised,
    focus: snapshot.lens.focus,
    autoExposureMode: snapshot.autoExposureMode,
    color: {
      lift: { ...snapshot.color.lift },
      gamma: { ...snapshot.color.gamma },
      gain: { ...snapshot.color.gain },
      offset: { ...snapshot.color.offset },
      contrast: snapshot.color.contrast ? { ...snapshot.color.contrast } : undefined,
      lumaMix: snapshot.color.lumaMix,
      hue: snapshot.color.hue,
      saturation: snapshot.color.saturation,
    },
    audio:
      Object.keys(snapshot.audio).length > 0
        ? {
            micLevel: snapshot.audio.micLevel,
            headphoneLevel: snapshot.audio.headphoneLevel,
            headphoneProgramMix: snapshot.audio.headphoneProgramMix,
            speakerLevel: snapshot.audio.speakerLevel,
            inputType: snapshot.audio.inputType,
            inputLevels: snapshot.audio.inputLevels ? { ...snapshot.audio.inputLevels } : undefined,
            phantomPower: snapshot.audio.phantomPower,
          }
        : undefined,
    ndFilterStops: snapshot.ndFilterStops,
    ndFilterDisplayMode: snapshot.ndFilterDisplayMode,
    dynamicRange: snapshot.dynamicRange,
    sharpeningLevel: snapshot.sharpeningLevel,
    displayLut: snapshot.displayLut ? { ...snapshot.displayLut } : undefined,
    exposureUs: snapshot.exposureUs,
    tallyBrightness: snapshot.tally?.brightness ? { ...snapshot.tally.brightness } : undefined,
    metadataCameraId: snapshot.metadata.cameraId,
  };
}

export interface BankWriter {
  writeCommand(packet: Uint8Array): Promise<void>;
}

/**
 * Push only the color-correction portion of a bank to the camera.
 *
 * The camera does not reliably echo color values back, so on every reconnect
 * we replay our locally-stored values to keep the camera and the panel in sync.
 */
export async function applyColorBankToCamera(client: BankWriter, bank: Bank): Promise<void> {
  const send = (packet: Uint8Array): Promise<void> => client.writeCommand(packet);

  await send(commands.lift(bank.color.lift.red, bank.color.lift.green, bank.color.lift.blue, bank.color.lift.luma));
  await send(commands.gamma(bank.color.gamma.red, bank.color.gamma.green, bank.color.gamma.blue, bank.color.gamma.luma));
  await send(
    commands.videoGain(bank.color.gain.red, bank.color.gain.green, bank.color.gain.blue, bank.color.gain.luma),
  );
  await send(
    commands.offset(bank.color.offset.red, bank.color.offset.green, bank.color.offset.blue, bank.color.offset.luma),
  );

  if (bank.color.contrast) {
    await send(commands.contrast(bank.color.contrast.pivot, bank.color.contrast.adjust));
  }
  if (bank.color.lumaMix !== undefined) await send(commands.lumaMix(bank.color.lumaMix));
  if (bank.color.hue !== undefined || bank.color.saturation !== undefined) {
    await send(commands.colorAdjust(bank.color.hue ?? 0, bank.color.saturation ?? 1));
  }
}

export async function applyBankToCamera(
  client: BankWriter,
  bank: Bank,
  options?: { skipNdBle?: boolean },
): Promise<void> {
  const send = (packet: Uint8Array): Promise<void> => client.writeCommand(packet);

  if (bank.whiteBalance) {
    await send(commands.whiteBalance(bank.whiteBalance.temperature, bank.whiteBalance.tint));
  }
  if (bank.gainDb !== undefined) await send(commands.gain(bank.gainDb));
  if (bank.iso !== undefined) await send(commands.iso(bank.iso));
  if (bank.shutterAngle !== undefined) await send(commands.shutterAngle(bank.shutterAngle));
  if (bank.iris !== undefined) await send(commands.iris(bank.iris));
  if (bank.focus !== undefined) await send(commands.focus(bank.focus));
  if (bank.autoExposureMode !== undefined) await send(commands.autoExposureMode(bank.autoExposureMode));

  await send(commands.lift(bank.color.lift.red, bank.color.lift.green, bank.color.lift.blue, bank.color.lift.luma));
  await send(commands.gamma(bank.color.gamma.red, bank.color.gamma.green, bank.color.gamma.blue, bank.color.gamma.luma));
  await send(
    commands.videoGain(bank.color.gain.red, bank.color.gain.green, bank.color.gain.blue, bank.color.gain.luma),
  );
  await send(
    commands.offset(bank.color.offset.red, bank.color.offset.green, bank.color.offset.blue, bank.color.offset.luma),
  );

  if (bank.color.contrast) {
    await send(commands.contrast(bank.color.contrast.pivot, bank.color.contrast.adjust));
  }
  if (bank.color.lumaMix !== undefined) await send(commands.lumaMix(bank.color.lumaMix));
  if (bank.color.hue !== undefined || bank.color.saturation !== undefined) {
    await send(commands.colorAdjust(bank.color.hue ?? 0, bank.color.saturation ?? 1));
  }

  if (bank.audio) {
    const a = bank.audio;
    if (a.micLevel !== undefined) await send(commands.micLevel(a.micLevel));
    if (a.headphoneLevel !== undefined) await send(commands.headphoneLevel(a.headphoneLevel));
    if (a.headphoneProgramMix !== undefined) await send(commands.headphoneProgramMix(a.headphoneProgramMix));
    if (a.speakerLevel !== undefined) await send(commands.speakerLevel(a.speakerLevel));
    if (a.inputType !== undefined) await send(commands.audioInputType(a.inputType));
    if (a.inputLevels) await send(commands.audioInputLevels(a.inputLevels.left, a.inputLevels.right));
    if (a.phantomPower !== undefined) await send(commands.phantomPower(a.phantomPower));
  }

  if (!options?.skipNdBle && bank.ndFilterStops !== undefined) {
    await send(commands.ndFilterStops(bank.ndFilterStops, bank.ndFilterDisplayMode ?? 0));
  }

  if (bank.dynamicRange !== undefined) await send(commands.dynamicRange(bank.dynamicRange));
  if (bank.sharpeningLevel !== undefined) await send(commands.sharpening(bank.sharpeningLevel));
  if (bank.displayLut) await send(commands.displayLut(bank.displayLut.selected, bank.displayLut.enabled));
  if (bank.exposureUs !== undefined) await send(commands.exposureUs(bank.exposureUs));

  if (bank.tallyBrightness) {
    const t = bank.tallyBrightness;
    if (t.master !== undefined) await send(commands.tallyBrightness(t.master));
    if (t.front !== undefined) await send(commands.frontTallyBrightness(t.front));
    if (t.rear !== undefined) await send(commands.rearTallyBrightness(t.rear));
  }

  if (bank.metadataCameraId !== undefined) await send(commands.metadataCameraId(bank.metadataCameraId));
}

function clampShutter(deg: number): number {
  return Math.min(360, Math.max(11, deg));
}
