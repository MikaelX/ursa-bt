/**
 * Same CCU debug shape as `scripts/atem-ccu-watch.ts` (JSON lines), for relay `panel_sync` sidecar key `__atemCcuTrace`.
 * Relay `__atemCcuTrace` merges the same audio/tally keys as `scripts/atem-ccu-watch.ts` stdout
 * (`audioTallyBucketTraceSummary`, then `ccuAudioTallyToSnapshotPatch` for `tally`, etc.).
 * Non–CC wire frames (Fairlight, …) appear as `wireCommands` (see `atemWireCommandsTrace.ts`).
 * Hub-only: each batch may include `atemRaw: string[]` (`[atem-raw] …` lines, default on) for the app debug log; set `ATEM_CCU_RELAY_RAW_TO_TRACE=0` on the server to omit.
 */
import type { AtemCameraControlState } from "@atem-connection/camera-control";

export const ATEM_CCU_TRACE_SNAPSHOT_KEY = "__atemCcuTrace";

export type CcuDeltaPayload = {
  cameraId: number;
  changes: string[];
  events: string[];
  unhandledMessages: { categoryId: number; parameterId: number }[];
  invalidMessages: { categoryId: number; parameterId: number }[];
};

export function lensVideoSummary(state: AtemCameraControlState | undefined): Record<string, unknown> | undefined {
  if (!state) return undefined;
  return {
    iris: state.lens.iris,
    focus: state.lens.focus,
    wbKelvin: state.video.whiteBalance[0],
    tint: state.video.whiteBalance[1],
    exposureUs: state.video.exposure,
    shutter: state.video.shutterSpeed,
    gainDb: state.video.gain,
    ndStop: state.video.ndFilterStop,
    /** Primary CC lift/gamma/gain wheels — `changes` may list `colorCorrection.gainAdjust` when this updates. */
    ccGainAdjust: state.colorCorrection.gainAdjust,
  };
}

/** Mirrors `scripts/atem-ccu-watch.ts` console payload (one delta line). */
export function ccuWatchStyleTrace(d: CcuDeltaPayload, snap: AtemCameraControlState | undefined): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    cameraId: d.cameraId,
    changes: d.changes,
    events: d.events,
    ...(d.unhandledMessages.length ? { unhandled: d.unhandledMessages } : {}),
    ...(d.invalidMessages.length ? { invalid: d.invalidMessages } : {}),
    lensVideo: lensVideoSummary(snap),
  };
}
