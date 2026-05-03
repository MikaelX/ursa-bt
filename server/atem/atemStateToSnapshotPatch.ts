/**
 * Maps @atem-connection/camera-control state into partial {@link CameraSnapshot}-shaped JSON
 * for relay `panel_sync` / bootstrap merges.
 */
import type { AtemCameraControlState } from "@atem-connection/camera-control";

export function atemCameraControlStateToSnapshotPatch(state: AtemCameraControlState): Record<string, unknown> {
  const cc = state.colorCorrection;
  const disp = state.display;
  const vid = state.video;
  const wb = vid.whiteBalance;

  // Always emit core lens + video fields so relay `panel_sync` JSON carries them every tick
  // (JSON.stringify drops `undefined`; joiners must merge authoritative values, not only deltas).
  return {
    deviceName: `ATEM CCU (cam ${state.cameraId})`,
    lens: {
      focus: state.lens.focus,
      apertureFstop: state.lens.iris,
    },
    whiteBalance: { temperature: wb[0], tint: wb[1] },
    exposureUs: vid.exposure,
    shutterSpeed: vid.shutterSpeed,
    gainDb: vid.gain,
    ndFilterStops: vid.ndFilterStop > 0 ? vid.ndFilterStop : undefined,
    sharpeningLevel: vid.videoSharpeningLevel,
    color: {
      lift: {
        red: cc.liftAdjust.red,
        green: cc.liftAdjust.green,
        blue: cc.liftAdjust.blue,
        luma: cc.liftAdjust.luma,
      },
      gamma: {
        red: cc.gammaAdjust.red,
        green: cc.gammaAdjust.green,
        blue: cc.gammaAdjust.blue,
        luma: cc.gammaAdjust.luma,
      },
      gain: {
        red: cc.gainAdjust.red,
        green: cc.gainAdjust.green,
        blue: cc.gainAdjust.blue,
        luma: cc.gainAdjust.luma,
      },
      offset: {
        red: cc.offsetAdjust.red,
        green: cc.offsetAdjust.green,
        blue: cc.offsetAdjust.blue,
        luma: cc.offsetAdjust.luma,
      },
      contrast: { pivot: cc.contrastAdjust.pivot, adjust: cc.contrastAdjust.adj },
      lumaMix: cc.lumaMix,
      hue: cc.colorAdjust.hue,
      saturation: cc.colorAdjust.saturation,
    },
    unitOutputs: {
      colorBars: disp.colorBarEnable,
      programReturnFeed: state.output.overlayEnable,
    },
  };
}
