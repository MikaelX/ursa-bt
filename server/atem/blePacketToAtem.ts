/**
 * Translates Blackmagic camera configuration packets (same wire format as BLE)
 * into ATEM CCU commands for the configured camera index.
 */
import type { AtemCameraControlDirectCommandSender } from "@atem-connection/camera-control";
import { VideoSharpeningLevel } from "@atem-connection/camera-control";
import { Commands } from "atem-connection";
import {
  CameraControlDataType,
  CameraControlOperation,
  decodeConfigurationPacket,
  type DecodedConfigurationPacket,
} from "../../src/blackmagic/protocol.js";
import { bleDecodedHandledByAtemBridge } from "../../src/relay/atemBleForwardGuard.js";

function clampSharpening(raw: number): VideoSharpeningLevel {
  const r = Math.round(raw);
  if (r <= VideoSharpeningLevel.Off) return VideoSharpeningLevel.Off;
  if (r >= VideoSharpeningLevel.High) return VideoSharpeningLevel.High;
  return r as VideoSharpeningLevel;
}

/** Apply one BLE-style configuration packet to ATEM CCU. Unsupported commands are skipped. */
export async function applyBlePacketToAtem(
  sender: AtemCameraControlDirectCommandSender,
  cameraId: number,
  packet: Uint8Array,
): Promise<void> {
  const decoded = decodeConfigurationPacket(packet);
  if (!decoded) return;
  await applyDecodedToAtem(sender, cameraId, decoded);
}

async function applyDecodedToAtem(
  sender: AtemCameraControlDirectCommandSender,
  cameraId: number,
  p: DecodedConfigurationPacket,
): Promise<void> {
  if (!bleDecodedHandledByAtemBridge(p)) return;
  const targetCameraId = targetCameraFromDestination(cameraId, p.destination);
  const rel = p.operation === CameraControlOperation.Offset;
  const [v0 = 0, v1 = 0, v2 = 0, v3 = 0] = p.values;

  switch (p.category) {
    case 0: {
      switch (p.parameter) {
        case 0:
          if (p.dataType === CameraControlDataType.Fixed16) {
            await sender.lensFocus(targetCameraId, v0, rel);
          }
          return;
        case 1:
          await sender.lensTriggerAutoFocus(targetCameraId);
          return;
        case 2:
          if (p.dataType === CameraControlDataType.Fixed16) {
            await sender.lensIrisFStop(targetCameraId, v0);
          }
          return;
        case 3:
          if (p.dataType === CameraControlDataType.Fixed16) {
            await sender.lensIrisNormalised(targetCameraId, v0);
          }
          return;
        case 5:
          await sender.lensTriggerAutoIris(targetCameraId);
          return;
        case 6:
          await sender.lensEnableOpticalImageStabilisation(targetCameraId, v0 !== 0);
          return;
        default:
          return;
      }
    }
    case 1: {
      switch (p.parameter) {
        case 2:
          await sender.videoManualWhiteBalance(targetCameraId, Math.round(v0), Math.round(v1));
          return;
        case 3:
          await sender.videoTriggerAutoWhiteBalance(targetCameraId);
          return;
        case 5:
          await sender.videoExposureUs(targetCameraId, Math.round(v0));
          return;
        case 8:
          await sender.videoSharpeningLevel(targetCameraId, clampSharpening(v0));
          return;
        case 12:
          return;
        case 13:
          await sender.videoGain(targetCameraId, Math.round(v0));
          return;
        case 14:
          return;
        case 16:
          await sender.videoNdFilterStop(targetCameraId, v0);
          return;
        default:
          return;
      }
    }
    case 4: {
      if (p.parameter === 4) {
        await sender.displayColorBars(targetCameraId, v0 !== 0);
        return;
      }
      if (p.parameter === 6) {
        await sender.outputOverlayEnable(targetCameraId, v0 !== 0);
        return;
      }
      return;
    }
    case 2:
      await sendGenericCameraControl(sender, targetCameraId, p);
      return;
    case 8: {
      switch (p.parameter) {
        case 0:
          await sender.colorLiftAdjust(targetCameraId, v0, v1, v2, v3);
          return;
        case 1:
          await sender.colorGammaAdjust(targetCameraId, v0, v1, v2, v3);
          return;
        case 2:
          await sender.colorGainAdjust(targetCameraId, v0, v1, v2, v3);
          return;
        case 3:
          await sender.colorOffsetAdjust(targetCameraId, v0, v1, v2, v3);
          return;
        case 4:
          await sender.colorContrastAdjust(targetCameraId, v1, v0);
          return;
        case 5:
          await sender.colorLumaMix(targetCameraId, v0);
          return;
        case 6:
          await sender.colorHueSaturationAdjust(targetCameraId, v0, v1);
          return;
        case 7:
          await sender.colorResetAllToDefault(targetCameraId);
          return;
        default:
          return;
      }
    }
    case 10: {
      if (p.parameter === 1 && p.dataType === CameraControlDataType.Int8) {
        if (Math.round(v0) === 2) await sender.mediaTriggerSetRecording(targetCameraId);
        else if (Math.round(v0) === 0) await sender.mediaTriggerSetStopped(targetCameraId);
      }
      return;
    }
    default:
      return;
  }
}

function targetCameraFromDestination(defaultCameraId: number, destination: number): number {
  const explicit = Math.round(destination);
  return explicit >= 1 && explicit <= 24 ? explicit : defaultCameraId;
}

async function sendGenericCameraControl(
  sender: AtemCameraControlDirectCommandSender,
  cameraId: number,
  p: DecodedConfigurationPacket,
): Promise<void> {
  const type = toAtemCameraControlType(p.dataType);
  if (type === undefined) return;
  const command = new Commands.CameraControlCommand(cameraId, p.category, p.parameter, {
    type,
    relative: p.operation === CameraControlOperation.Offset,
    boolData: p.values.map((value) => value !== 0),
    numberData: p.values,
    bigintData: [],
    stringData: p.stringValue ?? "",
  });
  await sender.addCommand(command);
}

function toAtemCameraControlType(dataType: number): Commands.CameraControlDataType | undefined {
  switch (dataType) {
    case CameraControlDataType.VoidOrBool:
      return Commands.CameraControlDataType.BOOL;
    case CameraControlDataType.Int8:
      return Commands.CameraControlDataType.SINT8;
    case CameraControlDataType.Int16:
      return Commands.CameraControlDataType.SINT16;
    case CameraControlDataType.Int32:
      return Commands.CameraControlDataType.SINT32;
    case CameraControlDataType.Int64:
      return Commands.CameraControlDataType.SINT64;
    case CameraControlDataType.String:
      return Commands.CameraControlDataType.STRING;
    case CameraControlDataType.Fixed16:
      return Commands.CameraControlDataType.FLOAT;
    default:
      return undefined;
  }
}
