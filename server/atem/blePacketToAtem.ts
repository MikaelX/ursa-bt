/**
 * Translates Blackmagic camera configuration packets (same wire format as BLE)
 * into ATEM CCU commands for the configured camera index.
 */
import type { AtemCameraControlDirectCommandSender } from "@atem-connection/camera-control";
import { VideoSharpeningLevel } from "@atem-connection/camera-control";
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
  const rel = p.operation === CameraControlOperation.Offset;
  const [v0 = 0, v1 = 0, v2 = 0, v3 = 0] = p.values;

  switch (p.category) {
    case 0: {
      switch (p.parameter) {
        case 0:
          if (p.dataType === CameraControlDataType.Fixed16) {
            await sender.lensFocus(cameraId, v0, rel);
          }
          return;
        case 1:
          await sender.lensTriggerAutoFocus(cameraId);
          return;
        case 2:
          if (p.dataType === CameraControlDataType.Fixed16) {
            await sender.lensIrisFStop(cameraId, v0);
          }
          return;
        case 3:
          if (p.dataType === CameraControlDataType.Fixed16) {
            await sender.lensIrisNormalised(cameraId, v0);
          }
          return;
        case 5:
          await sender.lensTriggerAutoIris(cameraId);
          return;
        case 6:
          await sender.lensEnableOpticalImageStabilisation(cameraId, v0 !== 0);
          return;
        default:
          return;
      }
    }
    case 1: {
      switch (p.parameter) {
        case 2:
          await sender.videoManualWhiteBalance(cameraId, Math.round(v0), Math.round(v1));
          return;
        case 3:
          await sender.videoTriggerAutoWhiteBalance(cameraId);
          return;
        case 5:
          await sender.videoExposureUs(cameraId, Math.round(v0));
          return;
        case 8:
          await sender.videoSharpeningLevel(cameraId, clampSharpening(v0));
          return;
        case 12:
          return;
        case 13:
          await sender.videoGain(cameraId, Math.round(v0));
          return;
        case 14:
          return;
        case 16:
          await sender.videoNdFilterStop(cameraId, v0);
          return;
        default:
          return;
      }
    }
    case 4: {
      if (p.parameter === 4) {
        await sender.displayColorBars(cameraId, v0 !== 0);
        return;
      }
      if (p.parameter === 6) {
        await sender.outputOverlayEnable(cameraId, v0 !== 0);
        return;
      }
      return;
    }
    case 8: {
      switch (p.parameter) {
        case 0:
          await sender.colorLiftAdjust(cameraId, v0, v1, v2, v3);
          return;
        case 1:
          await sender.colorGammaAdjust(cameraId, v0, v1, v2, v3);
          return;
        case 2:
          await sender.colorGainAdjust(cameraId, v0, v1, v2, v3);
          return;
        case 3:
          await sender.colorOffsetAdjust(cameraId, v0, v1, v2, v3);
          return;
        case 4:
          await sender.colorContrastAdjust(cameraId, v1, v0);
          return;
        case 5:
          await sender.colorLumaMix(cameraId, v0);
          return;
        case 6:
          await sender.colorHueSaturationAdjust(cameraId, v0, v1);
          return;
        case 7:
          await sender.colorResetAllToDefault(cameraId);
          return;
        default:
          return;
      }
    }
    case 10: {
      if (p.parameter === 1 && p.dataType === CameraControlDataType.Int8) {
        if (Math.round(v0) === 2) await sender.mediaTriggerSetRecording(cameraId);
        else if (Math.round(v0) === 0) await sender.mediaTriggerSetStopped(cameraId);
      }
      return;
    }
    default:
      return;
  }
}
