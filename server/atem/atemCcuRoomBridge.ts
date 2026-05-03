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
import { extractCcuIsoUpdate } from "./ccuVideoIsoApply.js";
import { atemWireCommandsTraceExtras } from "./atemWireCommandsTrace.js";
import { readTallyBySourceForCamera, type MixerTallyLeds } from "./mixerTallyFromAtemCommands.js";

/** When false, send every panel_sync even if payload matches last (except trace ts). Default on. */
function atemPanelSyncDedupeEnabled(): boolean {
  const v = process.env.ATEM_CCU_PANEL_SYNC_DEDUPE ?? "1";
  return v !== "0" && String(v).toLowerCase() !== "false";
}

/** Stable fingerprint for dedupe: same as wire JSON but ignore trace `ts` (ATEM echoes often). */
function panelSyncDedupeFingerprint(snapshot: Record<string, unknown>): string {
  const traceKey = ATEM_CCU_TRACE_SNAPSHOT_KEY;
  const rawTrace = snapshot[traceKey];
  if (rawTrace && typeof rawTrace === "object" && !Array.isArray(rawTrace)) {
    const r = rawTrace as Record<string, unknown>;
    if ("ts" in r) {
      const { ts: _ts, ...rest } = r;
      return JSON.stringify({ ...snapshot, [traceKey]: rest });
    }
  }
  return JSON.stringify(snapshot);
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

  /** True when ATEM TCP session is up. */
  get isTcpLinked(): boolean {
    return this.tcpLinked;
  }

  private emitMergedPanelSync(st: AtemCameraControlState | undefined, trace?: Record<string, unknown>): void {
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
    if (atemCcPanelSyncTraceWire() && trace) base[ATEM_CCU_TRACE_SNAPSHOT_KEY] = trace;
    if (atemPanelSyncDedupeEnabled()) {
      const fp = panelSyncDedupeFingerprint(base);
      if (fp === this.lastPanelSyncDedupeFingerprint) return;
      this.lastPanelSyncDedupeFingerprint = fp;
    }
    if (atemCcuDebugEnabled()) {
      try {
        console.log("[atem-ccu] emitPanelSync merged keys:", Object.keys(base).sort().join(", "));
        if (trace) console.log("[atem-ccu] ccu-log", JSON.stringify(trace));
      } catch {
        /* ignore */
      }
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
      const was = this.tcpLinked;
      this.tcpLinked = false;
      builder.reset(this.inputs);
      this.auxBuckets.clear();
      this.ccuIso = undefined;
      this.mixerTallyLeds = undefined;
      this.lastPanelSyncDedupeFingerprint = undefined;
      if (was) this.callbacks.onAtemTcpLinkChange?.(false);
      void (async () => {
        if (this.disposed) return;
        if (this.atem === atem) await this.destroyLiveAtemInstance();
        else await atem.destroy().catch(() => {});
        if (!this.disposed) this.scheduleTcpReconnect();
      })();
    });

    atem.on("receivedCommands", (commands) => {
      const debug = atemCcuDebugEnabled();
      if (debug) {
        const names = commands.map((c) => (c as { constructor?: { name?: string } }).constructor?.name ?? typeof c);
        console.log(`[atem-ccu] receivedCommands count=${commands.length}`, names);
      }
      const wireExtras = atemWireCommandsTraceExtras(commands);
      const hasWire = Object.keys(wireExtras).length > 0;
      const mergeWire = (t: Record<string, unknown>): Record<string, unknown> =>
        hasWire ? { ...t, ...wireExtras } : t;

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
        if (!mixerTallyChanged && (!hasWire || !atemCcPanelSyncTraceWire())) return;
        const st = builder.get(this.cameraId);
        const traceWireOnly = mergeWire({
          ts: new Date().toISOString(),
          cameraId: this.cameraId,
          note: "atem_wire",
          ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
          ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
        });
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
      const deltas = builder.applyCommands(cc);
      if (debug) {
        console.log(
          `[atem-ccu] CameraControlUpdateCommand=${cc.length} deltas=${deltas.length}`,
          deltas.map((d) => ({ cameraId: d.cameraId })),
        );
      }

      let synced = false;
      for (const d of deltas) {
        if (!deltaHasPayload(d)) continue;
        if (d.cameraId !== this.cameraId) continue;
        const st = builder.get(this.cameraId);
        if (!st) continue;
        const tracePayload = mergeWire({
          ...ccuWatchStyleTrace(d as CcuDeltaPayload, st),
          ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
        });
        this.emitMergedPanelSync(st, tracePayload);
        synced = true;
      }

      const targetsFocusedCamera = cc.some((c) => c.source === this.cameraId);
      if (!synced && targetsFocusedCamera) {
        const st = builder.get(this.cameraId);
        if (st) {
          if (debug) console.log("[atem-ccu] emitPanelSync fallback (commands targeted camera, no delta row)");
          const fbTrace = mergeWire({
            ts: new Date().toISOString(),
            cameraId: this.cameraId,
            note: "fallback_no_delta_row",
            lensVideo: lensVideoSummary(st),
            ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
          });
          this.emitMergedPanelSync(st, fbTrace);
          synced = true;
        }
      }

      if (!synced && auxTouched.size > 0) {
        const audioSrc = pickPrimaryCcuSourceForTrace(auxTouched, this.cameraId);
        const st = builder.get(this.cameraId);
        const traceAux = atemCcPanelSyncTraceWire()
          ? mergeWire({
              ts: new Date().toISOString(),
              cameraId: audioSrc,
              note: "audio_tally_ccu",
              ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
              ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(audioSrc)),
            })
          : undefined;
        this.emitMergedPanelSync(st ?? undefined, traceAux);
        synced = true;
      }

      if (!synced && isoTouched) {
        const st = builder.get(this.cameraId);
        const traceIso = atemCcPanelSyncTraceWire()
          ? mergeWire({
              ts: new Date().toISOString(),
              cameraId: this.cameraId,
              note: "iso_ccu",
              iso: this.ccuIso,
              ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
              ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(this.cameraId)),
            })
          : undefined;
        this.emitMergedPanelSync(st ?? undefined, traceIso);
        synced = true;
      }

      if (!synced && cc.length > 0) {
        const now = Date.now();
        if (now - this.lastCameraMismatchLogMs > 8000) {
          this.lastCameraMismatchLogMs = now;
          const deltaIds = [...new Set(deltas.map((d) => d.cameraId))].sort((a, b) => a - b);
          const cmdSources = [...new Set(cc.map((c) => c.source))].sort((a, b) => a - b);
          console.warn(
            `[atem-ccu] CC updates received but none applied for focused camera ${this.cameraId}. ` +
              `Command sources: [${cmdSources.join(", ")}]. Delta camera ids: [${deltaIds.join(", ")}]. ` +
              `Pick the Camera number that matches CC “source” in npm run atem:ccu-watch.`,
          );
        }
      }

      if (!synced && (mixerTallyChanged || (hasWire && atemCcPanelSyncTraceWire()))) {
        const audioSrc = pickPrimaryCcuSourceForTrace(auxTouched, this.cameraId);
        const st = builder.get(this.cameraId);
        const traceWireTail = mergeWire({
          ts: new Date().toISOString(),
          cameraId: audioSrc,
          note: mixerTallyChanged && !hasWire ? "mixer_tally" : "atem_wire",
          ...(st ? { lensVideo: lensVideoSummary(st) } : {}),
          ...atemCcuWatchRowAudioTallyExtras(this.auxBuckets.get(audioSrc)),
        });
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
    this.mixerTallyLeds = undefined;
    this.lastPanelSyncDedupeFingerprint = undefined;
    void a?.destroy();
    if (was) this.callbacks.onAtemTcpLinkChange?.(false);
  }
}
