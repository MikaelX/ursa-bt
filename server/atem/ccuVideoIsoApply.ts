/**
 * Video **ISO** (Camera Control category {@link AtemCameraControlCategory.Video} parameter 14):
 * `@atem-connection/camera-control` state builder marks it unhandled — we surface it for relay UI.
 */
import { Commands } from "atem-connection";

const CC_VIDEO = 1;
/** Same as {@link AtemCameraControlVideoParameter.ISO} */
const VP_ISO = 14;

/** Latest ISO from CC updates for `source`, if any. */
export function extractCcuIsoUpdate(
  commands: Commands.CameraControlUpdateCommand[],
  source: number,
): number | undefined {
  let latest: number | undefined;
  for (const cmd of commands) {
    if (cmd.source !== source || cmd.category !== CC_VIDEO || cmd.parameter !== VP_ISO) continue;
    const p = cmd.properties;
    if (p.type === Commands.CameraControlDataType.SINT32 && p.numberData.length >= 1) {
      latest = Math.round(p.numberData[0]!);
    }
  }
  return latest;
}
