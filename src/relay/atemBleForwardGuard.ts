/**
 * Which decoded BLE configuration packets {@link applyBlePacketToAtem} actually sends to the ATEM.
 * Used by the relay host browser to avoid `forward_cmd` noise for unsupported opcodes.
 */
import { CameraControlDataType, type DecodedConfigurationPacket } from "../blackmagic/protocol.js";

/** True when {@link applyBlePacketToAtem} would invoke the CCU sender (not no-op / unsupported). */
export function bleDecodedHandledByAtemBridge(p: DecodedConfigurationPacket): boolean {
  const [v0 = 0] = p.values;
  switch (p.category) {
    case 0: {
      switch (p.parameter) {
        case 0:
          return p.dataType === CameraControlDataType.Fixed16;
        case 1:
        case 5:
          return true;
        case 2:
        case 3:
          return p.dataType === CameraControlDataType.Fixed16;
        case 6:
          return true;
        default:
          return false;
      }
    }
    case 1: {
      switch (p.parameter) {
        case 2:
        case 3:
        case 5:
        case 8:
        case 13:
        case 16:
          return true;
        case 12:
        case 14:
          return false;
        default:
          return false;
      }
    }
    case 4:
      return p.parameter === 4 || p.parameter === 6;
    case 8:
      return p.parameter >= 0 && p.parameter <= 7;
    case 10:
      return p.parameter === 1 && p.dataType === CameraControlDataType.Int8 && (Math.round(v0) === 2 || Math.round(v0) === 0);
    default:
      return false;
  }
}
