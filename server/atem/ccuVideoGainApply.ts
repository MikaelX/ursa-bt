/**
 * Video **sensor gain dB** (camera-control category 1, parameter 13).
 *
 * `@atem-connection/camera-control` only applies param 13 when the wire type is **SINT8**.
 * ATEM CCdP often uses **SINT16** (or other numeric types) for the same parameter; the builder then skips
 * updating `state.video.gain` while still reporting an "invalid" delta — relay `panel_sync` kept a stale dB.
 *
 * Parameter **1** (GainCamera4_9) is a legacy path the library ignores entirely; we map it when
 * param 13 is absent in the same batch.
 */
import { Commands } from "atem-connection";

const CC_VIDEO = 1;
/** Same as {@link AtemCameraControlVideoParameter.Gain} */
const VP_GAIN = 13;
/** Same as {@link AtemCameraControlVideoParameter.GainCamera4_9} — Sofie state builder no-ops this. */
const VP_GAIN_LEGACY = 1;

function readNumericGainDb(cmd: Commands.CameraControlUpdateCommand): number | undefined {
  const p = cmd.properties;
  switch (p.type) {
    case Commands.CameraControlDataType.SINT8:
    case Commands.CameraControlDataType.SINT16:
    case Commands.CameraControlDataType.SINT32:
      if (p.numberData.length < 1) return undefined;
      return Math.round(Number(p.numberData[0]!));
    case Commands.CameraControlDataType.FLOAT:
      if (p.numberData.length < 1) return undefined;
      return Math.round(Number(p.numberData[0]!));
    default:
      return undefined;
  }
}

/** Latest sensor gain (dB) from CC updates for `source`, if any. Param 13 wins over legacy param 1. */
export function extractCcuGainDbUpdate(
  commands: Commands.CameraControlUpdateCommand[],
  source: number,
): number | undefined {
  let fromGain: number | undefined;
  let fromLegacy: number | undefined;
  for (const cmd of commands) {
    if (cmd.source !== source || cmd.category !== CC_VIDEO) continue;
    const v = readNumericGainDb(cmd);
    if (v === undefined) continue;
    if (cmd.parameter === VP_GAIN) fromGain = v;
    else if (cmd.parameter === VP_GAIN_LEGACY) fromLegacy = v;
  }
  return fromGain ?? fromLegacy;
}
