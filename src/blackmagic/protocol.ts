/**
 * @file protocol.ts
 *
 * bm-bluetooth — Encode / decode Blackmagic **Change Configuration** packets (category × parameter payloads)
 * for the outbound/incoming BLE control characteristics. Mirrors the vendor PDF against human-readable enums.
 *
 * Consumers: `./cameraState` ingestion, `./bleClient` writers, relay forwarders. **Private** repo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Framing constants & wire enums
// ─────────────────────────────────────────────────────────────────────────────

const COMMAND_CHANGE_CONFIGURATION = 0;
const HEADER_LENGTH = 4;
const CONFIG_COMMAND_LENGTH = 4;
const BROADCAST_DESTINATION = 255;
const FIXED16_MAX = (32767 / 2048);

export enum CameraControlDataType {
  VoidOrBool = 0,
  Int8 = 1,
  Int16 = 2,
  Int32 = 3,
  Int64 = 4,
  String = 5,
  Fixed16 = 128,
}

export enum CameraControlOperation {
  Assign = 0,
  Offset = 1,
}

export interface ConfigurationCommand {
  category: number;
  parameter: number;
  dataType: CameraControlDataType;
  operation?: CameraControlOperation;
  payload?: number[];
  destination?: number;
}

export interface DecodedConfigurationPacket {
  destination: number;
  commandLength: number;
  commandId: number;
  category: number;
  categoryName: string;
  parameter: number;
  parameterName: string;
  dataType: CameraControlDataType | number;
  operation: CameraControlOperation | number;
  values: number[];
  stringValue?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Encode & typed payload shards
// ─────────────────────────────────────────────────────────────────────────────

export function encodeConfigurationCommand(command: ConfigurationCommand): Uint8Array {
  const payload = command.payload ?? [];
  const commandLength = CONFIG_COMMAND_LENGTH + payload.length;
  const unpaddedLength = HEADER_LENGTH + commandLength;
  const paddedLength = Math.ceil(unpaddedLength / 4) * 4;
  const packet = new Uint8Array(paddedLength);

  packet[0] = command.destination ?? BROADCAST_DESTINATION;
  packet[1] = commandLength;
  packet[2] = COMMAND_CHANGE_CONFIGURATION;
  packet[3] = 0;
  packet[4] = command.category;
  packet[5] = command.parameter;
  packet[6] = command.dataType;
  packet[7] = command.operation ?? CameraControlOperation.Assign;
  packet.set(payload, 8);

  return packet;
}

export function boolPayload(value: boolean): number[] {
  return [value ? 1 : 0];
}

export function int8Payload(...values: number[]): number[] {
  return values.map((value) => toSignedInteger(value, -128, 127) & 0xff);
}

export function int16Payload(...values: number[]): number[] {
  return values.flatMap((value) => littleEndianBytes(toSignedInteger(value, -32768, 32767), 2));
}

export function int32Payload(...values: number[]): number[] {
  return values.flatMap((value) =>
    littleEndianBytes(toSignedInteger(value, -2147483648, 2147483647), 4),
  );
}

export function fixed16Payload(...values: number[]): number[] {
  return int16Payload(...values.map((value) => Math.round(value * 2048)));
}

export function stringPayload(value: string): number[] {
  const encoder = new TextEncoder();
  return Array.from(encoder.encode(value));
}

export function toHex(packet: ArrayLike<number>): string {
  return Array.from(packet, (byte) => byte.toString(16).padStart(2, "0")).join(" ");
}

// ─────────────────────────────────────────────────────────────────────────────
// Decode ingress packets (incoming characteristic notifications)
// ─────────────────────────────────────────────────────────────────────────────

export function decodeConfigurationPacket(packet: ArrayLike<number>): DecodedConfigurationPacket | undefined {
  if (packet.length < 8 || packet[2] !== COMMAND_CHANGE_CONFIGURATION) {
    return undefined;
  }

  const commandLength = packet[1] ?? 0;
  const dataLength = Math.max(0, commandLength - CONFIG_COMMAND_LENGTH);
  const category = packet[4] ?? 0;
  const parameter = packet[5] ?? 0;
  const dataType = packet[6] ?? 0;
  const operation = packet[7] ?? 0;
  const rawData = Array.from(packet).slice(8, 8 + dataLength);
  const values = decodeValues(dataType, rawData);
  const stringValue = dataType === CameraControlDataType.String ? decodeString(rawData) : undefined;

  return {
    destination: packet[0] ?? 0,
    commandLength,
    commandId: packet[2] ?? 0,
    category,
    categoryName: categoryName(category),
    parameter,
    parameterName: parameterName(category, parameter),
    dataType,
    operation,
    values,
    stringValue,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Opinionated outbound packet factories (`commands.*`)
// ─────────────────────────────────────────────────────────────────────────────

export const commands = {
  recordStart: () =>
    encodeConfigurationCommand({
      category: 10,
      parameter: 1,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(2),
    }),

  recordStop: () =>
    encodeConfigurationCommand({
      category: 10,
      parameter: 1,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(0),
    }),

  autoFocus: () =>
    encodeConfigurationCommand({
      category: 0,
      parameter: 1,
      dataType: CameraControlDataType.VoidOrBool,
    }),

  focus: (normalised: number) =>
    encodeConfigurationCommand({
      category: 0,
      parameter: 0,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(normalised, 0, 1)),
    }),

  /** Lens zoom 0–1 (category 0 parameter 8). */
  zoomNormalised: (normalised: number) =>
    encodeConfigurationCommand({
      category: 0,
      parameter: 8,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(normalised, 0, 1)),
    }),

  iris: (normalised: number) =>
    encodeConfigurationCommand({
      category: 0,
      parameter: 3,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(normalised, 0, 1)),
    }),

  whiteBalance: (temperature: number, tint = 0) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 2,
      dataType: CameraControlDataType.Int16,
      payload: int16Payload(temperature, tint),
    }),

  gain: (db: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 13,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(db),
    }),

  iso: (iso: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 14,
      dataType: CameraControlDataType.Int32,
      payload: int32Payload(iso),
    }),

  autoExposureMode: (mode: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 10,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(mode), 0, 4)),
    }),

  shutterAngle: (degrees: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 11,
      dataType: CameraControlDataType.Int32,
      payload: int32Payload(Math.round(clamp(degrees, 11, 360) * 100)),
    }),

  shutterSpeed: (oneOver: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 12,
      dataType: CameraControlDataType.Int32,
      payload: int32Payload(oneOver),
    }),

  aperture: (fstopStep: number) =>
    encodeConfigurationCommand({
      category: 0,
      parameter: 2,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(fstopStep),
    }),

  masterBlack: (adjust: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 0,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(0, 0, 0, clamp(adjust, -2, 2)),
    }),

  lift: (red: number, green: number, blue: number, luma: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 0,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(
        clamp(red, -2, 2),
        clamp(green, -2, 2),
        clamp(blue, -2, 2),
        clamp(luma, -2, 2),
      ),
    }),

  gamma: (red: number, green: number, blue: number, luma: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 1,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(
        clamp(red, -4, 4),
        clamp(green, -4, 4),
        clamp(blue, -4, 4),
        clamp(luma, -4, 4),
      ),
    }),

  videoGain: (red: number, green: number, blue: number, luma: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 2,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(
        clamp(red, 0, FIXED16_MAX),
        clamp(green, 0, FIXED16_MAX),
        clamp(blue, 0, FIXED16_MAX),
        clamp(luma, 0, FIXED16_MAX),
      ),
    }),

  offset: (red: number, green: number, blue: number, luma: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 3,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(
        clamp(red, -8, 8),
        clamp(green, -8, 8),
        clamp(blue, -8, 8),
        clamp(luma, -8, 8),
      ),
    }),

  contrast: (pivot: number, adjust: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 4,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(pivot, 0, 1), clamp(adjust, 0, 2)),
    }),

  lumaMix: (mix: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 5,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(mix, 0, 1)),
    }),

  colorAdjust: (hue: number, saturation: number) =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 6,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(hue, -1, 1), clamp(saturation, 0, 2)),
    }),

  colorReset: () =>
    encodeConfigurationCommand({
      category: 8,
      parameter: 7,
      dataType: CameraControlDataType.VoidOrBool,
    }),

  stillCapture: () =>
    encodeConfigurationCommand({
      category: 10,
      parameter: 3,
      dataType: CameraControlDataType.VoidOrBool,
    }),

  autoAperture: () =>
    encodeConfigurationCommand({
      category: 0,
      parameter: 5,
      dataType: CameraControlDataType.VoidOrBool,
    }),

  micLevel: (level: number) =>
    encodeConfigurationCommand({
      category: 2,
      parameter: 0,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(level, 0, 1)),
    }),

  headphoneLevel: (level: number) =>
    encodeConfigurationCommand({
      category: 2,
      parameter: 1,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(level, 0, 1)),
    }),

  headphoneProgramMix: (mix: number) =>
    encodeConfigurationCommand({
      category: 2,
      parameter: 2,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(mix, 0, 1)),
    }),

  speakerLevel: (level: number) =>
    encodeConfigurationCommand({
      category: 2,
      parameter: 3,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(level, 0, 1)),
    }),

  audioInputType: (inputType: number) =>
    encodeConfigurationCommand({
      category: 2,
      parameter: 4,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(inputType), 0, 3)),
    }),

  audioInputLevels: (left: number, right: number) =>
    encodeConfigurationCommand({
      category: 2,
      parameter: 5,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(left, 0, 1), clamp(right, 0, 1)),
    }),

  phantomPower: (on: boolean) =>
    encodeConfigurationCommand({
      category: 2,
      parameter: 6,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(on ? 1 : 0),
    }),

  /** @param displayMode 0 = stops, 1 = density, 2 = transmittance (manual reference on body). */
  ndFilterStops: (stops: number, displayMode = 0) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 16,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(stops, 0, 6), clamp(Math.round(displayMode), 0, 2)),
    }),

  ndFilterDisplayMode: (mode: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 17,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(mode), 0, 2)),
    }),

  setAutoWhiteBalance: () =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 3,
      dataType: CameraControlDataType.VoidOrBool,
    }),

  restoreAutoWhiteBalance: () =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 4,
      dataType: CameraControlDataType.VoidOrBool,
    }),

  exposureUs: (microseconds: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 5,
      dataType: CameraControlDataType.Int32,
      payload: int32Payload(Math.max(0, Math.round(microseconds))),
    }),

  dynamicRange: (mode: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 7,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(mode), 0, 2)),
    }),

  sharpening: (level: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 8,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(level), 0, 3)),
    }),

  displayLut: (selected: number, enabled: boolean) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 15,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(selected), 0, 3), enabled ? 1 : 0),
    }),

  colorBars: (seconds: number) =>
    encodeConfigurationCommand({
      category: 4,
      parameter: 4,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(seconds), 0, 30)),
    }),

  /** Display 4.6 — 0 = off, 1–30 = on with timeout (seconds). */
  programReturnFeed: (seconds: number) =>
    encodeConfigurationCommand({
      category: 4,
      parameter: 6,
      dataType: CameraControlDataType.Int8,
      payload: int8Payload(clamp(Math.round(seconds), 0, 30)),
    }),

  tallyBrightness: (level: number) =>
    encodeConfigurationCommand({
      category: 5,
      parameter: 0,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(level, 0, 1)),
    }),

  frontTallyBrightness: (level: number) =>
    encodeConfigurationCommand({
      category: 5,
      parameter: 1,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(level, 0, 1)),
    }),

  rearTallyBrightness: (level: number) =>
    encodeConfigurationCommand({
      category: 5,
      parameter: 2,
      dataType: CameraControlDataType.Fixed16,
      payload: fixed16Payload(clamp(level, 0, 1)),
    }),

  metadataCameraId: (id: string) =>
    encodeConfigurationCommand({
      category: 12,
      parameter: 5,
      dataType: CameraControlDataType.String,
      payload: stringPayload(id),
    }),

  /**
   * Video / recording frame rate and raster (category 1 parameter 9).
   * Use width × height from the live snapshot so the camera keeps the current format.
   */
  recordingFormat: (frameRate: number, sensorFrameRate: number, frameWidth: number, frameHeight: number) =>
    encodeConfigurationCommand({
      category: 1,
      parameter: 9,
      dataType: CameraControlDataType.Int32,
      payload: int32Payload(
        Math.round(frameRate),
        Math.round(sensorFrameRate),
        Math.round(frameWidth),
        Math.round(frameHeight),
      ),
    }),

  /** Off-speed / sensor frame rate target (category 9 parameter 2). */
  offSpeedFrameRate: (fps: number) =>
    encodeConfigurationCommand({
      category: 9,
      parameter: 2,
      dataType: CameraControlDataType.Int32,
      payload: int32Payload(Math.round(fps)),
    }),
};

// ─────────────────────────────────────────────────────────────────────────────
// Packet mutation & decoding internals
// ─────────────────────────────────────────────────────────────────────────────

/** Clone bytes while overriding camera destination selector (broadcast → explicit body). */
export function withDestination(packet: Uint8Array, destination: number): Uint8Array {
  const copy = new Uint8Array(packet);
  copy[0] = destination;
  return copy;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function toSignedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Expected finite number, got ${value}`);
  }

  const integer = Math.trunc(value);

  if (integer < min || integer > max) {
    throw new Error(`Value ${value} is outside ${min}..${max}`);
  }

  return integer;
}

function littleEndianBytes(value: number, byteCount: number): number[] {
  const bytes: number[] = [];

  for (let offset = 0; offset < byteCount; offset += 1) {
    bytes.push((value >> (offset * 8)) & 0xff);
  }

  return bytes;
}

function decodeValues(dataType: number, bytes: number[]): number[] {
  switch (dataType) {
    case CameraControlDataType.VoidOrBool:
    case CameraControlDataType.Int8:
      return bytes.map((byte) => signedFromBytes([byte]));
    case CameraControlDataType.Int16:
      return chunk(bytes, 2).map(signedFromBytes);
    case CameraControlDataType.Int32:
      return chunk(bytes, 4).map(signedFromBytes);
    case CameraControlDataType.Int64:
      return chunk(bytes, 8).map((valueBytes) => Number(signedBigFromBytes(valueBytes)));
    case CameraControlDataType.Fixed16:
      return chunk(bytes, 2).map((valueBytes) => signedFromBytes(valueBytes) / 2048);
    case CameraControlDataType.String:
      return bytes;
    default:
      return bytes;
  }
}

function signedBigFromBytes(bytes: number[]): bigint {
  let value = 0n;

  for (let index = 0; index < bytes.length; index += 1) {
    value |= BigInt(bytes[index] ?? 0) << BigInt(index * 8);
  }

  const bits = BigInt(bytes.length * 8);
  const signBit = 1n << (bits - 1n);

  if ((value & signBit) !== 0n) {
    value -= 1n << bits;
  }

  return value;
}

function decodeString(bytes: number[]): string {
  try {
    return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bytes)).replace(/\0+$/, "");
  } catch {
    return String.fromCharCode(...bytes);
  }
}

function signedFromBytes(bytes: number[]): number {
  let value = 0;

  bytes.forEach((byte, index) => {
    value |= byte << (index * 8);
  });

  const bits = bytes.length * 8;
  const signBit = 1 << (bits - 1);

  if ((value & signBit) !== 0) {
    value -= 2 ** bits;
  }

  return value;
}

function chunk(bytes: number[], size: number): number[][] {
  const chunks: number[][] = [];

  for (let index = 0; index + size <= bytes.length; index += size) {
    chunks.push(bytes.slice(index, index + size));
  }

  return chunks;
}

function categoryName(category: number): string {
  return (
    {
      0: "Lens",
      1: "Video",
      2: "Audio",
      3: "Output",
      4: "Display",
      5: "Tally",
      6: "Reference",
      7: "Configuration",
      8: "Color Correction",
      9: "Recording Format",
      10: "Media",
      11: "PTZ Control",
      12: "Metadata",
    } satisfies Record<number, string>
  )[category] ?? `Category ${category}`;
}

function parameterName(category: number, parameter: number): string {
  const names: Record<number, Record<number, string>> = {
    0: {
      0: "Focus",
      1: "Instantaneous autofocus",
      2: "Aperture f-stop",
      3: "Aperture normalised",
      4: "Aperture ordinal",
      5: "Instantaneous auto aperture",
      6: "Optical image stabilisation",
      7: "Zoom (absolute mm)",
      8: "Zoom (normalised)",
      9: "Continuous zoom (speed)",
    },
    1: {
      0: "Video mode",
      1: "Gain (dB deprecated)",
      2: "Manual White Balance",
      3: "Set auto WB",
      4: "Restore auto WB",
      5: "Exposure (us)",
      6: "Exposure (ordinal)",
      7: "Dynamic range mode",
      8: "Video sharpening level",
      9: "Recording format",
      10: "Set auto exposure mode",
      11: "Shutter angle",
      12: "Shutter speed",
      13: "Gain",
      14: "ISO",
      15: "Display LUT",
      16: "ND filter stops",
      17: "ND filter display mode",
    },
    2: {
      0: "Mic level",
      1: "Headphone level",
      2: "Headphone program mix",
      3: "Speaker level",
      4: "Input type",
      5: "Input levels (L,R)",
      6: "Phantom power",
    },
    4: {
      0: "Brightness",
      1: "Exposure and focus tools",
      2: "Zebra level",
      3: "Peaking level",
      4: "Color bars enable",
      5: "Focus assist",
      6: "Program return feed enable",
      7: "Timecode source",
    },
    5: {
      0: "Tally brightness",
      1: "Front tally brightness",
      2: "Rear tally brightness",
    },
    7: {
      0: "Real time clock",
      1: "System language",
      2: "Timezone",
      3: "Location",
    },
    8: {
      0: "Lift adjust",
      1: "Gamma adjust",
      2: "Gain adjust",
      3: "Offset adjust",
      4: "Contrast adjust",
      5: "Luma mix",
      6: "Color adjust",
      7: "Correction reset",
    },
    9: {
      0: "Recording format",
      1: "Transport mode",
      2: "Off-speed frame rate",
      5: "File specification",
      6: "Storage media",
      7: "Playback control",
    },
    10: {
      0: "Codec",
      1: "Transport mode",
      2: "Playback control",
      3: "Still capture",
    },
    12: {
      0: "Reel",
      1: "Scene tags",
      2: "Scene",
      3: "Take",
      4: "Good take",
      5: "Camera ID",
      6: "Camera operator",
      7: "Director",
      8: "Project name",
      9: "Slate type",
      10: "Slate name",
      11: "Lens type",
      12: "Lens iris",
      13: "Lens focal length",
      14: "Slate for type",
      15: "Slate for name",
    },
  };

  return names[category]?.[parameter] ?? `Parameter ${parameter}`;
}
