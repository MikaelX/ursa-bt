export const enum CameraStatusFlag {
  PowerOn = 0x01,
  Connected = 0x02,
  Paired = 0x04,
  VersionsVerified = 0x08,
  InitialPayloadReceived = 0x10,
  CameraReady = 0x20,
}

/** Bits of the first status byte documented as flags in the Blackmagic BLE / camera control docs (low 6 bits). */
export const CAMERA_STATUS_KNOWN_FLAG_BITS = 0x3f;

export interface CameraStatus {
  raw: number;
  powerOn: boolean;
  connected: boolean;
  paired: boolean;
  versionsVerified: boolean;
  initialPayloadReceived: boolean;
  cameraReady: boolean;
  labels: string[];
  /** Full notification value as hex (may be empty if the characteristic sent no bytes). */
  payloadHex: string;
  /** Hex of bytes after the first, when present — not interpreted in-app; compare with BlackmagicCameraControl.pdf. */
  trailingPayloadHex?: string;
  /** Byte 0 bits outside {@link CAMERA_STATUS_KNOWN_FLAG_BITS} (e.g. 0x40 / 0x80); meaning is camera/firmware-specific. */
  statusByteReservedBits: number;
}

const STATUS_LABELS: Array<[CameraStatusFlag, string]> = [
  [CameraStatusFlag.PowerOn, "Power On"],
  [CameraStatusFlag.Connected, "Connected"],
  [CameraStatusFlag.Paired, "Paired"],
  [CameraStatusFlag.VersionsVerified, "Versions Verified"],
  [CameraStatusFlag.InitialPayloadReceived, "Initial Payload Received"],
  [CameraStatusFlag.CameraReady, "Camera Ready"],
];

function buildCameraStatus(rawByte: number, payload: Uint8Array): CameraStatus {
  const raw = rawByte & 0xff;

  return {
    raw,
    powerOn: hasFlag(raw, CameraStatusFlag.PowerOn),
    connected: hasFlag(raw, CameraStatusFlag.Connected),
    paired: hasFlag(raw, CameraStatusFlag.Paired),
    versionsVerified: hasFlag(raw, CameraStatusFlag.VersionsVerified),
    initialPayloadReceived: hasFlag(raw, CameraStatusFlag.InitialPayloadReceived),
    cameraReady: hasFlag(raw, CameraStatusFlag.CameraReady),
    labels: STATUS_LABELS.filter(([flag]) => hasFlag(raw, flag)).map(([, label]) => label),
    payloadHex: bytesToHex(payload),
    trailingPayloadHex: payload.length > 1 ? bytesToHex(payload.subarray(1)) : undefined,
    statusByteReservedBits: raw & ~CAMERA_STATUS_KNOWN_FLAG_BITS,
  };
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length === 0 || clean.length % 2 !== 0) {
    return new Uint8Array();
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Decode the full Camera Status characteristic value (all bytes). */
export function decodeCameraStatusPayload(payload: Uint8Array): CameraStatus {
  const rawByte = payload.length > 0 ? (payload[0] ?? 0) : 0;
  return buildCameraStatus(rawByte, payload);
}

export function decodeCameraStatusFromHex(payloadHex: string): CameraStatus {
  return decodeCameraStatusPayload(hexToBytes(payloadHex));
}

/** Single-byte fallback when only the status flags byte is known (e.g. legacy relay). */
export function decodeCameraStatus(value: number): CameraStatus {
  const raw = value & 0xff;
  return buildCameraStatus(raw, Uint8Array.of(raw));
}

export function decodeCameraStatusDataView(value: DataView): CameraStatus {
  if (value.byteLength <= 0) {
    return decodeCameraStatusPayload(new Uint8Array());
  }
  const payload = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return decodeCameraStatusPayload(payload);
}

/** One debug log line: known flags, full hex, reserved bits, trailing bytes note. */
export function formatCameraStatusLogLine(status: CameraStatus): string {
  const head = `Status 0x${status.raw.toString(16).padStart(2, "0")}: ${status.labels.join(", ") || "None"}`;
  const parts = [head, `payload=${status.payloadHex || "(empty)"}`];
  if (status.statusByteReservedBits !== 0) {
    parts.push(`byte0Reserved=0x${status.statusByteReservedBits.toString(16)}`);
  }
  if (status.trailingPayloadHex) {
    parts.push(`bytes[1..]=${status.trailingPayloadHex} (not decoded; see cam PDF)`);
  }
  return parts.join(" | ");
}

function hasFlag(value: number, flag: CameraStatusFlag): boolean {
  return (value & flag) === flag;
}
