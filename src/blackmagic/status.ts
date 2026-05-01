export const enum CameraStatusFlag {
  PowerOn = 0x01,
  Connected = 0x02,
  Paired = 0x04,
  VersionsVerified = 0x08,
  InitialPayloadReceived = 0x10,
  CameraReady = 0x20,
}

export interface CameraStatus {
  raw: number;
  powerOn: boolean;
  connected: boolean;
  paired: boolean;
  versionsVerified: boolean;
  initialPayloadReceived: boolean;
  cameraReady: boolean;
  labels: string[];
}

const STATUS_LABELS: Array<[CameraStatusFlag, string]> = [
  [CameraStatusFlag.PowerOn, "Power On"],
  [CameraStatusFlag.Connected, "Connected"],
  [CameraStatusFlag.Paired, "Paired"],
  [CameraStatusFlag.VersionsVerified, "Versions Verified"],
  [CameraStatusFlag.InitialPayloadReceived, "Initial Payload Received"],
  [CameraStatusFlag.CameraReady, "Camera Ready"],
];

export function decodeCameraStatus(value: number): CameraStatus {
  const raw = value & 0xff;

  return {
    raw,
    powerOn: hasFlag(raw, CameraStatusFlag.PowerOn),
    connected: hasFlag(raw, CameraStatusFlag.Connected),
    paired: hasFlag(raw, CameraStatusFlag.Paired),
    versionsVerified: hasFlag(raw, CameraStatusFlag.VersionsVerified),
    initialPayloadReceived: hasFlag(raw, CameraStatusFlag.InitialPayloadReceived),
    cameraReady: hasFlag(raw, CameraStatusFlag.CameraReady),
    labels: STATUS_LABELS.filter(([flag]) => hasFlag(raw, flag)).map(([, label]) => label),
  };
}

export function decodeCameraStatusDataView(value: DataView): CameraStatus {
  return decodeCameraStatus(value.byteLength > 0 ? value.getUint8(0) : 0);
}

function hasFlag(value: number, flag: CameraStatusFlag): boolean {
  return (value & flag) === flag;
}
