import { Atem, AtemConnectionStatus, Commands, listVisibleInputs } from "atem-connection";
import type { AtemCameraControlState } from "@atem-connection/camera-control";
import {
  AtemCameraControlDirectCommandSender,
  AtemCameraControlStateBuilder,
} from "@atem-connection/camera-control";
import type { WebSocket as WsType } from "ws";
import {
  ATEM_CCU_TRACE_SNAPSHOT_KEY,
  ccuWatchStyleTrace,
  lensVideoSummary,
  type CcuDeltaPayload,
} from "./ccuWatchStyleTrace.js";
import { collectCameraControlUpdates } from "./collectCameraControlUpdates.js";
import { applyBlePacketToAtem } from "./blePacketToAtem.js";
import { atemCameraControlStateToSnapshotPatch } from "./atemStateToSnapshotPatch.js";
import {
  applyCcuAudioTallyCommands,
  audioTallyBucketTraceSummary,
  ccuAudioTallyToSnapshotPatch,
  type CcuAudioTallyBucket,
} from "./ccuAudioTallyApply.js";
import { extractCcuGainDbUpdate } from "./ccuVideoGainApply.js";
import { extractCcuIsoUpdate } from "./ccuVideoIsoApply.js";
import { atemWireCommandsTraceExtras } from "./atemWireCommandsTrace.js";
import { logRawReceivedCommands, rawReceivedCommandLines } from "./logRawReceivedCommands.js";
import { readTallyBySourceForCamera, type MixerTallyLeds } from "./mixerTallyFromAtemCommands.js";

/** When false, send every panel_sync even if payload matches last. Default on. */
function atemPanelSyncDedupeEnabled(): boolean {
  const v = process.env.ATEM_CCU_PANEL_SYNC_DEDUPE ?? "1";
  return v !== "0" && String(v).toLowerCase() !== "false";
}

/** Dedupe fingerprint: merged panel fields plus trace **without** `ts` so CCU-only deltas still emit when `rest` is unchanged. */
function panelSyncDedupeFingerprint(snapshot: Record<string, unknown>): string {
  const traceKey = ATEM_CCU_TRACE_SNAPSHOT_KEY;
  const rawTrace = snapshot[traceKey];
  const { [traceKey]: _trace, ...rest } = snapshot;
  let traceNoTs: unknown = null;
  if (rawTrace && typeof rawTrace === "object") {
    const { ts: _ts, ...trest } = rawTrace as Record<string, unknown>;
    traceNoTs = trest;
  }
  return JSON.stringify({ rest, trace: traceNoTs });
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function atemCcuDebugEnabled(): boolean {
  const v = process.env.ATEM_CCU_DEBUG ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

/** Log each incoming switcher command batch while TCP is up (default on). Set `ATEM_CCU_LOG_MIXER_RX=0` to disable. */
function atemCcuLogMixerRxEnabled(): boolean {
  const v = process.env.ATEM_CCU_LOG_MIXER_RX ?? "1";
  return v !== "0" && String(v).toLowerCase() !== "false";
}

/** When true, attach `atemRaw: string[]` (`[atem-raw] …` per command) to relay `__atemCcuTrace` for the app debug log. Default on; set `ATEM_CCU_RELAY_RAW_TO_TRACE=0` to disable. */
function atemCcuRelayRawToTraceEnabled(): boolean {
  const v = process.env.ATEM_CCU_RELAY_RAW_TO_TRACE ?? "1";
  return v !== "0" && String(v).toLowerCase() !== "false";
}

/** Max commands serialized into `atemRaw` per batch; `0` = no limit. Default 128. */
function atemCcuRelayRawMaxCommands(): number {
  const n = Number(process.env.ATEM_CCU_RELAY_RAW_MAX ?? "");
  if (n === 0) return Number.POSITIVE_INFINITY;
  if (Number.isFinite(n) && n > 0) return Math.min(512, Math.floor(n));
  return 128;
}

function isIgnoredHighFrequencyRelayRawCommand(cmd: unknown): boolean {
  if (typeof cmd !== "object" || cmd === null) return false;
  const ctor = (cmd as { constructor?: { name?: string; rawName?: string } }).constructor;
  return ctor?.name === "TimeCommand" || ctor?.rawName === "Time";
}

function appendAtemRawToTrace(
  trace: Record<string, unknown>,
  commands: unknown[],
  batchTs: string,
): Record<string, unknown> {
  if (!atemCcuRelayRawToTraceEnabled()) return trace;
  const cap = atemCcuRelayRawMaxCommands();
  const slice = Number.isFinite(cap) && cap < commands.length ? commands.slice(0, cap) : commands;
  const lines = rawReceivedCommandLines(slice, batchTs);
  if (commands.length > slice.length) {
    lines.push(
      `[atem-raw] ${JSON.stringify({
        ts: batchTs,
        note: "relay_raw_truncated",
        totalCommands: commands.length,
        included: slice.length,
      })}`,
    );
  }
  if (lines.length === 0) return trace;
  return { ...trace, atemRaw: lines };
}

/** When false, omit `__atemCcuTrace` from relay panel_sync (smaller payloads). Default on – matches npm run atem:ccu-watch shape for app Debug log. */
function atemCcPanelSyncTraceWire(): boolean {
  const v = process.env.ATEM_CCU_PANEL_SYNC_TRACE ?? "1";
  return v !== "0" && String(v).toLowerCase() !== "false";
}

function deltaHasPayload(d: {
  changes: unknown[];
  events: unknown[];
  unhandledMessages: unknown[];
  invalidMessages: unknown[];
}): boolean {
  return (
    d.changes.length > 0 ||
    d.events.length > 0 ||
    d.unhandledMessages.length > 0 ||
    d.invalidMessages.length > 0
  );
}

/** Same audio/tally keys as `scripts/atem-ccu-watch.ts` stdout row (`Object.assign(row, auxPatch)` after summary). */
function atemCcuWatchRowAudioTallyExtras(aux: CcuAudioTallyBucket | undefined): Record<string, unknown> {
  if (!aux) return {};
  const row: Record<string, unknown> = { ...audioTallyBucketTraceSummary(aux) };
  const patch = ccuAudioTallyToSnapshotPatch(aux);
  if (Object.keys(patch).length > 0) Object.assign(row, patch);
  return row;
}

/** CC `source` for trace lines (Camera Control audio/tally), not the relay session’s focused camera id. */
function pickPrimaryCcuSourceForTrace(auxTouched: Set<number>, focusedCameraId: number): number {
  if (auxTouched.size === 0) return focusedCameraId;
  const sorted = [...auxTouched].sort((a, b) => a - b);
  if (auxTouched.size === 1) return sorted[0]!;
  if (auxTouched.has(focusedCameraId)) return focusedCameraId;
  return sorted[0]!;
}

export type AtemCcuRoomBridgeCallbacks = {
  /** Push CCU-derived panel state to host + joiners (relay `panel_sync`). */
  emitPanelSync: (snapshot: Record<string, unknown>) => void;
  hostSocket: () => WsType | undefined;
  /** ATEM switcher TCP connected or dropped (for UI + Redis session metadata). */
  onAtemTcpLinkChange?: (linked: boolean) => void;
  /** Shown in the host app log as `atem_ccu_error` (e.g. focused camera vs CC source mismatch). */
  notifyHost?: (message: string) => void;
  /** Hub → host browser debug log (`atem_ccu_log` wire), e.g. `[atem-raw]` lines. */
  onHostLog?: (message: string) => void;
};

/**
 * One ATEM TCP connection per relay room; fans out CCU reads as `panel_sync`
 * and executes joiner/host `forward_cmd` writes on the switcher.
 */
export class AtemCcuRoomBridge {
  private readonly cameraId: number;
  private readonly inputs: number;
  private readonly callbacks: AtemCcuRoomBridgeCallbacks;
  private atem: Atem | undefined;
  private sender: AtemCameraControlDirectCommandSender | undefined;
  private builder: AtemCameraControlStateBuilder | undefined;
  private disposed = false;
  private lastCameraMismatchLogMs = 0;
  /** Switcher hostname/IP last passed to {@link connect}. */
  private switcherAddress = "";
  private tcpLinked = false;
  /** Camera CC Audio / Tally (categories not handled by AtemCameraControlStateBuilder). */
  private readonly auxBuckets = new Map<number, CcuAudioTallyBucket>();
  /** Video ISO from CC (param 14); builder does not apply it. */
  private ccuIso: number | undefined;
  /** Video sensor gain dB from CC (param 13 / legacy 1); builder only accepts param 13 as SINT8. */
  private ccuGainDb: number | undefined;
  /** Latest PGM/PVW from {@link Commands.TallyBySourceCommand} for the focused camera input. */
  private mixerTallyLeds: MixerTallyLeds | undefined;

  /** Last panel_sync fingerprint (trace `ts` ignored) to skip redundant emits. */
  private lastPanelSyncDedupeFingerprint: string | undefined;

  private reconnectFailures = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private tcpPort = 9910;
  /** Fixed cadence while switcher TCP is down (was exponential up to 30s). */
  private static readonly TCP_RECONNECT_INTERVAL_MS = 10_000;

  constructor(cameraId: number, inputs: number, callbacks: AtemCcuRoomBridgeCallbacks) {
    this.cameraId = cameraId;
    this.inputs = inputs;
    this.callbacks = callbacks;
  }

  private emitHostLog(message: string): void {
    try {
      this.callbacks.onHostLog?.(message);
    } catch {
      /* ignore */
    }
  }

  /** True when ATEM TCP session is up. */
  get isTcpLinked(): boolean {
    return this.tcpLinked;
  }

  private emitMergedPanelSync(
    st: AtemCameraControlState | undefined,
    trace?: Record<string, unknown>,
    opts?: { bypassDedupe?: boolean },
  ): void {
    const base: Record<string, unknown> = st
      ? { ...atemCameraControlStateToSnapshotPatch(st) }
      : { deviceName: `ATEM CCU (cam ${this.cameraId})` };
    const aux = this.auxBuckets.get(this.cameraId);
    if (aux) Object.assign(base, ccuAudioTallyToSnapshotPatch(aux));
    if (this.mixerTallyLeds !== undefined) {
      const raw = base.tally;
      const merged =
        raw !== null && typeof raw === "object" && !Array.isArray(raw)
          ? { ...(raw as Record<string, unknown>) }
          : {};
      base.tally = {
        ...merged,
        programMe: this.mixerTallyLeds.programMe,
        previewMe: this.mixerTallyLeds.previewMe,
      };
    }
    if (this.ccuIso !== undefined) base.iso = this.ccuIso;
    if (this.ccuGainDb !== undefined) base.gainDb = this.ccuGainDb;
    if (atemCcPanelSyncTraceWire() && trace) base[ATEM_CCU_TRACE_SNAPSHOT_KEY] = trace;
    if (atemPanelSyncDedupeEnabled()) {
      const fp = panelSyncDedupeFingerprint(base);
      if (!opts?.bypassDedupe && fp === this.lastPanelSyncDedupeFingerprint) {
        return;
      }
      this.lastPanelSyncDedupeFingerprint = fp;
    }
    if (atemCcuDebugEnabled()) {
      try {
        console.log("[atem-ccu] emitPanelSync merged keys:", Object.keys(base).sort().join(", "));
        if (trace) console.log("[atem-ccu] ccu-log", JSON.stringify(trace));
      } catch {
        /* ignore */
      }
    } else if (process.env.ATEM_CCU_PANEL_SYNC_EMIT === "1") {
      console.log("[atem-ccu] panel_sync emit keys:", Object.keys(base).sort().join(", "));
    }
    this.callbacks.emitPanelSync(base);
  }

  /**
   * `atem-connection` fires `receivedCommands` before mutating `atem.state`. `TallyBySource` can then
   * disagree with ME1 multiview tally until the batch is applied; align PGM/PVW with {@link listVisibleInputs}.
   */
  private reconcileMixerTallyLedsWithAtemState(atem: Atem): void {
    if (this.disposed || this.atem !== atem) return;
    if (!atem.state || atem.status !== AtemConnectionStatus.CONNECTED) return;
    let meTally: MixerTallyLeds;
    try {
      const id = this.cameraId;
      meTally = {
        programMe: listVisibleInputs("program", atem.state, 0).includes(id),
        previewMe: listVisibleInputs("preview", atem.state, 0).includes(id),
      };
    } catch {
      return;
    }
    const prev = this.mixerTallyLeds;
    if (prev?.programMe === meTally.programMe && prev?.previewMe === meTally.previewMe) return;
    this.mixerTallyLeds = meTally;
    const st = this.builder?.get(this.cameraId);
    const trace = atemCcPanelSyncTraceWire()
      ? {
          ts: new Date().toISOString(),
          cameraId: this.cameraId,
          note: "mixer_tally_me1",
          ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
          ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
        }
      : undefined;
    this.emitMergedPanelSync(st ?? undefined, trace);
  }

  private clearReconnectSchedule(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private scheduleTcpReconnect(): void {
    if (this.disposed) return;
    this.clearReconnectSchedule();
    this.reconnectFailures += 1;
    const attempt = this.reconnectFailures;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      console.warn(
        `[atem-ccu] TCP reconnect attempt ${attempt} → ${this.switcherAddress}:${this.tcpPort} (every ${AtemCcuRoomBridge.TCP_RECONNECT_INTERVAL_MS / 1000}s while down)`,
      );
      void this.connect(this.switcherAddress, this.tcpPort);
    }, AtemCcuRoomBridge.TCP_RECONNECT_INTERVAL_MS);
  }

  private async destroyLiveAtemInstance(): Promise<void> {
    const a = this.atem;
    if (!a) return;
    this.atem = undefined;
    this.sender = undefined;
    this.builder = undefined;
    await a.destroy().catch(() => {});
  }

  async connect(address: string, port: number): Promise<void> {
    if (this.disposed) return;
    this.clearReconnectSchedule();
    this.switcherAddress = address.trim();
    this.tcpPort = port;

    await this.destroyLiveAtemInstance();

    const builder = new AtemCameraControlStateBuilder(this.inputs);
    const atem = new Atem({});
    const sender = new AtemCameraControlDirectCommandSender(atem);

    atem.on("connected", () => {
      this.emitHostLog(
        "ATEM hub: switcher session up — mixer lines appear when TCP batches parse to commands; `[atem-raw]` batches log below when hub RX logging is on.",
      );
    });
    atem.on("debug", (msg: string) => {
      if (!atemCcuLogMixerRxEnabled()) return;
      this.emitHostLog(`[atem-debug] ${msg}`);
    });

    atem.on("error", (msg) => {
      const host = this.callbacks.hostSocket();
      if (host?.readyState === 1) {
        try {
          host.send(JSON.stringify({ type: "atem_ccu_error", message: msg }));
        } catch {
          /* ignore */
        }
      }
    });

    atem.on("disconnected", () => {
      if (this.disposed) return;
      /** False when {@link destroyLiveAtemInstance} already cleared `this.atem` — do not schedule reconnect. */
      const stillCurrent = this.atem === atem;
      const was = this.tcpLinked;
      this.tcpLinked = false;
      builder.reset(this.inputs);
      this.auxBuckets.clear();
      this.ccuIso = undefined;
      this.ccuGainDb = undefined;
      this.mixerTallyLeds = undefined;
      this.lastPanelSyncDedupeFingerprint = undefined;
      if (was) this.callbacks.onAtemTcpLinkChange?.(false);
      void (async () => {
        if (this.disposed) return;
        if (stillCurrent) await this.destroyLiveAtemInstance();
        else await atem.destroy().catch(() => {});
        if (!this.disposed && stillCurrent) this.scheduleTcpReconnect();
      })();
    });

    atem.on("receivedCommands", (commands) => {
      const verbose = atemCcuDebugEnabled();
      const batchTs = new Date().toISOString();
      const logRx = atemCcuLogMixerRxEnabled();
      const relayRawCommands = commands.filter((cmd) => !isIgnoredHighFrequencyRelayRawCommand(cmd));
      if (logRx) logRawReceivedCommands(relayRawCommands, batchTs, (line) => this.emitHostLog(line));
      const wireExtras = atemWireCommandsTraceExtras(commands);
      const hasWire = Object.keys(wireExtras).length > 0;
      const hasRawBatch = atemCcuRelayRawToTraceEnabled() && relayRawCommands.length > 0;
      const mergeWire = (t: Record<string, unknown>): Record<string, unknown> =>
        hasWire ? { ...t, ...wireExtras } : t;
      const withRaw = (t: Record<string, unknown>): Record<string, unknown> =>
        appendAtemRawToTrace(t, relayRawCommands, batchTs);

      /** Runs after `atem-connection` applies this batch to `atem.state` (see {@link reconcileMixerTallyLedsWithAtemState}). */
      setImmediate(() => this.reconcileMixerTallyLedsWithAtemState(atem));

      const tallySnap = readTallyBySourceForCamera(commands, this.cameraId);
      let mixerTallyChanged = false;
      if (tallySnap !== undefined) {
        const prev = this.mixerTallyLeds;
        if (!prev || prev.programMe !== tallySnap.programMe || prev.previewMe !== tallySnap.previewMe) {
          mixerTallyChanged = true;
        }
        this.mixerTallyLeds = tallySnap;
      }

      const cc = collectCameraControlUpdates(commands);
      if (cc.length === 0) {
        if (
          !mixerTallyChanged &&
          (!hasWire || !atemCcPanelSyncTraceWire()) &&
          !(hasRawBatch && atemCcPanelSyncTraceWire())
        )
          return;
        const st = builder.get(this.cameraId);
        const traceWireOnly = withRaw(
          mergeWire({
            ts: batchTs,
            cameraId: this.cameraId,
            note: "atem_wire",
            ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
            ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
          }),
        );
        this.emitMergedPanelSync(st ?? undefined, traceWireOnly);
        return;
      }

      const auxTouched = applyCcuAudioTallyCommands(cc, this.auxBuckets);
      const isoNext = extractCcuIsoUpdate(cc, this.cameraId);
      let isoTouched = false;
      if (isoNext !== undefined) {
        this.ccuIso = isoNext;
        isoTouched = true;
      }
      const gainNext = extractCcuGainDbUpdate(cc, this.cameraId);
      const gainTouched = gainNext !== undefined;
      if (gainTouched) {
        this.ccuGainDb = gainNext;
      }
      const deltas = builder.applyCommands(cc);

      let synced = false;
      for (const d of deltas) {
        if (!deltaHasPayload(d)) continue;
        if (d.cameraId !== this.cameraId) continue;
        const st = builder.get(this.cameraId);
        if (!st) continue;
        const tracePayload = withRaw(
          mergeWire({
            ...ccuWatchStyleTrace(d as CcuDeltaPayload, st),
            ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
          }),
        );
        this.emitMergedPanelSync(st, tracePayload);
        synced = true;
      }

      const targetsFocusedCamera = cc.some((c) => c.source === this.cameraId);
      if (!synced && targetsFocusedCamera) {
        const st = builder.get(this.cameraId);
        if (st) {
          if (verbose) console.log("[atem-ccu] emitPanelSync fallback (commands targeted camera, no delta row)");
          const fbTrace = withRaw(
            mergeWire({
              ts: batchTs,
              cameraId: this.cameraId,
              note: "fallback_no_delta_row",
              lensVideo: lensVideoSummary(st),
              ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
            }),
          );
          this.emitMergedPanelSync(st, fbTrace);
          synced = true;
        }
      }

      if (!synced && auxTouched.size > 0) {
        const audioSrc = pickPrimaryCcuSourceForTrace(auxTouched, this.cameraId);
        const st = builder.get(this.cameraId);
        const traceAux = atemCcPanelSyncTraceWire()
          ? withRaw(
              mergeWire({
                ts: batchTs,
                cameraId: audioSrc,
                note: "audio_tally_ccu",
                ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
                ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(audioSrc)),
              }),
            )
          : undefined;
        this.emitMergedPanelSync(st ?? undefined, traceAux);
        synced = true;
      }

      if (!synced && isoTouched) {
        const st = builder.get(this.cameraId);
        const traceIso = atemCcPanelSyncTraceWire()
          ? withRaw(
              mergeWire({
                ts: batchTs,
                cameraId: this.cameraId,
                note: "iso_ccu",
                iso: this.ccuIso,
                ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
                ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
              }),
            )
          : undefined;
        this.emitMergedPanelSync(st ?? undefined, traceIso);
        synced = true;
      }

      if (!synced && gainTouched) {
        const st = builder.get(this.cameraId);
        const traceGain = atemCcPanelSyncTraceWire()
          ? withRaw(
              mergeWire({
                ts: batchTs,
                cameraId: this.cameraId,
                note: "gain_ccu",
                gainDb: this.ccuGainDb,
                ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
                ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
              }),
            )
          : undefined;
        this.emitMergedPanelSync(st ?? undefined, traceGain);
        synced = true;
      }

      if (!synced && cc.length > 0) {
        const now = Date.now();
        if (now - this.lastCameraMismatchLogMs > 8000) {
          this.lastCameraMismatchLogMs = now;
          const deltaIds = [...new Set(deltas.map((d) => d.cameraId))].sort((a, b) => a - b);
          const cmdSources = [...new Set(cc.map((c) => c.source))].sort((a, b) => a - b);
          const msg =
            `CC updates received but none applied for focused camera ${this.cameraId}. ` +
            `Command sources: [${cmdSources.join(", ")}]. Delta camera ids: [${deltaIds.join(", ")}]. ` +
            `Pick the Camera index that matches CC “source” (see npm run atem:ccu-watch).`;
          console.warn(`[atem-ccu] ${msg}`);
          this.callbacks.notifyHost?.(msg);
        }
      }

      if (!synced && (mixerTallyChanged || (hasWire && atemCcPanelSyncTraceWire()) || (hasRawBatch && atemCcPanelSyncTraceWire()))) {
        const audioSrc = pickPrimaryCcuSourceForTrace(auxTouched, this.cameraId);
        const st = builder.get(this.cameraId);
        const traceWireTail = withRaw(
          mergeWire({
            ts: batchTs,
            cameraId: audioSrc,
            note: mixerTallyChanged && !hasWire ? "mixer_tally" : "atem_wire",
            ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
            ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(audioSrc)),
          }),
        );
        this.emitMergedPanelSync(st ?? undefined, traceWireTail);
      }
    });

    try {
      await atem.connect(address, port);
    } catch (e) {
      await atem.destroy().catch(() => {});
      if (!this.disposed) {
        console.warn("[atem-ccu] TCP connect failed:", e instanceof Error ? e.message : e);
        this.scheduleTcpReconnect();
      }
      return;
    }
    if (this.disposed) {
      await atem.destroy().catch(() => {});
      return;
    }
    this.atem = atem;
    this.sender = sender;
    this.builder = builder;
    this.reconnectFailures = 0;

    const wasLinked = this.tcpLinked;
    this.tcpLinked = true;
    if (!wasLinked) this.callbacks.onAtemTcpLinkChange?.(true);

    const snap = builder.get(this.cameraId);
    if (snap) {
      const initialTrace = {
        ts: new Date().toISOString(),
        cameraId: this.cameraId,
        note: "initial_snapshot",
        lensVideo: lensVideoSummary(snap),
        ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
      };
      this.emitMergedPanelSync(snap, initialTrace);
    }

    /** Late CCdP batches can land after the first builder read; re-emit once so clients are not stuck on an empty builder row. */
    setTimeout(() => {
      if (this.disposed || this.atem !== atem || !this.tcpLinked) return;
      const stLate = builder.get(this.cameraId);
      const lateTrace = atemCcPanelSyncTraceWire()
        ? {
            ts: new Date().toISOString(),
            cameraId: this.cameraId,
            note: "post_connect_refresh",
            ...(stLate ? { lensVideo: lensVideoSummary(stLate) } : {}),
            ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
          }
        : undefined;
      this.emitMergedPanelSync(stLate ?? undefined, lateTrace, { bypassDedupe: true });
    }, 450);

    const host = this.callbacks.hostSocket();
    if (host?.readyState === 1) {
      try {
        host.send(
          JSON.stringify({
            type: "atem_ccu_ready",
            address: this.switcherAddress,
            cameraId: this.cameraId,
          }),
        );
      } catch {
        /* ignore */
      }
    }
  }

  async handleForwardCmdHex(hex: string): Promise<void> {
    const sender = this.sender;
    if (!sender || this.disposed) return;
    const bytes = hexToBytes(hex);
    await applyBlePacketToAtem(sender, this.cameraId, bytes);
  }

  dispose(): void {
    this.clearReconnectSchedule();
    this.reconnectFailures = 0;
    const was = this.tcpLinked;
    this.tcpLinked = false;
    this.disposed = true;
    const a = this.atem;
    this.atem = undefined;
    this.sender = undefined;
    this.builder = undefined;
    this.auxBuckets.clear();
    this.ccuIso = undefined;
    this.ccuGainDb = undefined;
    this.mixerTallyLeds = undefined;
    this.lastPanelSyncDedupeFingerprint = undefined;
    void a?.destroy();
    if (was) this.callbacks.onAtemTcpLinkChange?.(false);
  }
}
