import { BlackmagicBleClient } from "../blackmagic/bleClient";
import { CameraState, serializeCameraSnapshotForRelay, type CameraSnapshot } from "../blackmagic/cameraState";
import { commands, toHex, withDestination } from "../blackmagic/protocol";
import {
  decodeCameraStatus,
  decodeCameraStatusFromHex,
  disconnectedPlaceholderStatus,
  formatCameraStatusLogLine,
  type CameraStatus,
} from "../blackmagic/status";
import { buildAppVersion } from "../buildVersion";
import { isNativeShell } from "../native/capacitorEnv";
import { NativeBleCameraClient, readLastNativeBleSnapshot, type NativeBleScanHit } from "../native/nativeBleCameraClient";
import { RelayJoinedCameraClient } from "../relay/relayJoinCameraClient";
import { nullBleCameraClient } from "../relay/nullBleCameraClient";
import { RelayHostSession, type AtemCcuRelayRegister } from "../relay/relayHostSession";
import { bleDecodedHandledByAtemBridge } from "../relay/atemBleForwardGuard";
import { blePacketsFromAtemPanelSyncClean } from "../relay/atemPanelSyncMirrorBle";
import { atemCcuTraceCatalogueLines, atemCcuTraceLogLineCompact } from "../relay/atemCcuDebugCatalogue";
import {
  DEBUG_RELAY_HUB_LOCALHOST_LS,
  getRelaySessionsUrl,
  getRelaySocketUrl,
} from "../relay/relayUrl";
import {
  MASTER_BLACK_RANGE,
  PAINT_CHANNELS,
  PAINT_GROUPS,
  PAINT_RANGE,
  isViewId,
  masterBlackToNormalised,
  normalisedToMasterBlack,
  paintValueToAngle,
  hfaderValueFromClientX,
  positionHFaderHandle,
  positionHorizontalFader,
  positionIrisHandle,
  positionMiniFaderHandle,
  positionVerticalFader,
  readFaderRange,
  renderPanelTemplate,
  setActiveView,
  initBluefyOfferModal,
  showBluefyOfferModal,
  showGenericWebBleHelpModal,
  isIosLikeWebBluetoothBlocked,
  irisTbarDragRangePx,
  stepMasterGainDb,
  updatePanel,
  updateSceneBanks,
  writePaintSegReadout,
  valueToCenteredNorm,
  centeredNormToValue,
  formatNd,
  updateAppHeaderCameraProduct,
  stepNdUrsa,
  isUrsaCameraName,
  type PaintChannel,
  type PaintGroup,
  type ViewId,
} from "./panel";
import {
  applyBankToCamera,
  applyColorBankToCamera,
  BANK_COUNT,
  buildBankFromSnapshot,
  emptyBanksFile,
  GLOBAL_SCENE_COUNT,
  resolvedBodyCameraIdFromBank,
  SCENE_SLOT_COUNT,
  type Bank,
  type BanksFile,
} from "../banks/bank";
import { HttpBanksApi, NullBanksApi, type BanksApi } from "../banks/banksClient";
import type { CameraClient } from "./cameraClientTypes";

export type { CameraClient } from "./cameraClientTypes";

/**
 * @file app.ts
 *
 * bm-bluetooth — Wire the DOM **`[data-*]` panel** (`./panel.ts`) into {@link CameraState}, selectable {@link CameraClient}
 * transports (Chrome Web Bluetooth vs Capacitor vs relay join/host), persisted banks REST I/O, and relay `panel_sync` side channels.
 *
 * **Private** repo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Relay `panel_sync` side-metadata (banks revision, hosted slot hints, CCU traces)
// ─────────────────────────────────────────────────────────────────────────────

/** Side-channel keys in relay `panel_sync` / bootstrap — not part of {@link CameraSnapshot}. */
const RELAY_BANKS_REVISION_KEY = "__relayBanksRevision";
const RELAY_LOADED_SLOT_KEY = "__relayLoadedSlot";
const RELAY_SCENE_FILLED_KEY = "__relaySceneFilledSlots";

/** Must match {@link ATEM_CCU_TRACE_SNAPSHOT_KEY} in `server/atem/ccuWatchStyleTrace.ts`. */
const RELAY_ATEM_CCU_TRACE_KEY = "__atemCcuTrace";

/** Spacing between BLE configuration writes while dragging continuous controls (faders, iris bar, paint knobs). Tunable trade-off: lower = snappier UI, higher = less GATT pressure. */
const BLE_POINTER_DRAG_SEND_INTERVAL_MS = 60;

const RELAY_PANEL_SYNC_SIDE_KEYS = [
  RELAY_BANKS_REVISION_KEY,
  RELAY_LOADED_SLOT_KEY,
  RELAY_SCENE_FILLED_KEY,
  RELAY_ATEM_CCU_TRACE_KEY,
] as const;

function stripRelayPanelSideKeys(snap: Record<string, unknown>): Record<string, unknown> {
  const out = { ...snap };
  for (const k of RELAY_PANEL_SYNC_SIDE_KEYS) delete out[k];
  return out;
}

function isPlainRecord(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

/** Deep-merge partial `panel_sync` payloads so rapid ATEM CCU updates (e.g. gain dB) collapse to the latest nested values. */
function deepMergeRelayPanelClean(
  base: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (isPlainRecord(v) && isPlainRecord(out[k])) {
      out[k] = deepMergeRelayPanelClean(out[k] as Record<string, unknown>, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function cloneRelayPanelCleanForBleMerge(clean: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(clean)) as Record<string, unknown>;
  } catch {
    return { ...clean };
  }
}

function stableRelayValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function changedRelayPanelCleanForBleMirror(
  current: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(incoming)) {
    const prev = current[key];
    if (isPlainRecord(value) && isPlainRecord(prev)) {
      const hasNestedCommandGroup = Object.values(value).some(isPlainRecord);
      if (!hasNestedCommandGroup) {
        if (stableRelayValue(value) !== stableRelayValue(prev)) out[key] = value;
        continue;
      }
      const child = changedRelayPanelCleanForBleMirror(prev, value);
      if (Object.keys(child).length > 0) out[key] = child;
      continue;
    }
    if (stableRelayValue(value) !== stableRelayValue(prev)) out[key] = value;
  }
  return out;
}

/** Which scene pad is active on the host. Filled-slot booleans (`__relaySceneFilledSlots`) are still sent but not merged locally — merges were wiping server-backed bank payloads before HTTP refresh landed. */
function readRelayLoadedSlotFromSnap(snap: Record<string, unknown>): { loadedSlot: number | null | undefined } {
  let loadedSlot: number | null | undefined;
  if (RELAY_LOADED_SLOT_KEY in snap) {
    const v = snap[RELAY_LOADED_SLOT_KEY];
    if (v === null) loadedSlot = null;
    else if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < SCENE_SLOT_COUNT) loadedSlot = v;
  }
  return { loadedSlot };
}

/**
 * IoC knobs for Cypress / offline harnesses (`client`, `state`, `banks`).
 * Defaults pick browser-appropriate transports + {@link HttpBanksApi}.
 */
export interface AppOptions {
  client?: CameraClient;
  state?: CameraState;
  banks?: BanksApi;
}

/** Mount BLE / relay control UX under `root` (expects {@link renderPanelTemplate} markup). */
export function createApp(root: HTMLElement, options: AppOptions = {}): void {
  const state = options.state ?? new CameraState();
  const banksApi: BanksApi = options.banks ?? (typeof fetch === "function" ? new HttpBanksApi() : new NullBanksApi());

  const log = (message: string): void => {
    const logList = root.querySelector<HTMLUListElement>("[data-log]");
    if (!logList) return;
    const item = document.createElement("li");
    item.textContent = `${new Date().toLocaleTimeString()} ${message}`;
    logList.prepend(item);
  };

  const ATEM_PANEL_SYNC_DEBUG_LS = "bm-debug-atem-panel-sync";
  const ATEM_CCU_TRACE_JSON_LS = "bm-debug-atem-ccu-json";

  /** Catalogue + JSON trace extras; default on unless user set `localStorage` to `"0"`. */
  function atemPanelSyncDebugExtrasEnabled(): boolean {
    try {
      return localStorage.getItem(ATEM_PANEL_SYNC_DEBUG_LS) !== "0";
    } catch {
      return true;
    }
  }

  const lastAtemMixerSnapshotSigByTag: Record<string, string> = {};
  let joinRelAtemMixerDebugPrimed = false;

  function syncAtemCompactTraceCheckboxFromStorage(): void {
    const el = root.querySelector<HTMLInputElement>("[data-debug-atem-sync]");
    if (!el) return;
    try {
      el.checked = atemPanelSyncDebugExtrasEnabled();
    } catch {
      el.checked = true;
    }
  }

  /** Turn on compact CCU trace lines + catalogue without opening Debug first (hub ATEM host or join). */
  function enableAtemMixerDebugDefaults(): void {
    try {
      localStorage.setItem(ATEM_PANEL_SYNC_DEBUG_LS, "1");
    } catch {
      /* ignore */
    }
    syncAtemCompactTraceCheckboxFromStorage();
  }

  function primeJoinAtemMixerDebugFromSnap(rec: Record<string, unknown>): void {
    if (joinRelAtemMixerDebugPrimed) return;
    const tr = rec[RELAY_ATEM_CCU_TRACE_KEY];
    const hasTrace = tr !== null && tr !== undefined && typeof tr === "object";
    if (!isLikelyAtemPanelSyncSnapshot(rec) && !hasTrace) return;
    joinRelAtemMixerDebugPrimed = true;
    enableAtemMixerDebugDefaults();
    log("ATEM CCU: debug trace enabled for this join (same as Debug → ATEM CCU compact trace).");
  }

  function atemDebugShortSource(src: string): string {
    if (src === "atem-host") return "h";
    if (src === "relay-join") return "j";
    return src.length <= 12 ? src : `${src.slice(0, 10)}…`;
  }

  function isLikelyAtemPanelSyncSnapshot(rec: Record<string, unknown>): boolean {
    const dn = rec.deviceName;
    return typeof dn === "string" && dn.includes("ATEM CCU");
  }

  function logAtemMixerPanelSyncDebug(raw: Record<string, unknown>, source: string): void {
    try {
      const trace = raw[RELAY_ATEM_CCU_TRACE_KEY];
      const tag = atemDebugShortSource(source);
      const debugExtrasOn = atemPanelSyncDebugExtrasEnabled();
      if (trace !== null && trace !== undefined && typeof trace === "object") {
        const t = trace as Record<string, unknown>;
        log(`[ccu ${tag}] ${atemCcuTraceLogLineCompact(t)}`);

        const rawLines = t.atemRaw;
        if (Array.isArray(rawLines) && rawLines.length > 0) {
          const maxLines = 300;
          const maxChars = 12_000;
          const cap = Math.min(rawLines.length, maxLines);
          for (let i = 0; i < cap; i++) {
            const ln = rawLines[i];
            if (typeof ln !== "string") continue;
            const body = ln.length > maxChars ? `${ln.slice(0, maxChars)}…(+${ln.length - maxChars})` : ln;
            log(`[ccu ${tag}] ${body}`);
          }
          if (rawLines.length > maxLines) {
            log(`[ccu ${tag}] … omitted ${rawLines.length - maxLines} more atemRaw lines`);
          }
        }

        if (!debugExtrasOn) return;
        const lines = atemCcuTraceCatalogueLines(t);
        for (const ln of lines) log(`[ccu ${tag}] ${ln}`);
        if (localStorage.getItem(ATEM_CCU_TRACE_JSON_LS) === "1") {
          const line = JSON.stringify(trace);
          const max = 8000;
          const suffix =
            line.length > max ? `…(+${line.length - max})` : "";
          const body = line.length > max ? line.slice(0, max) : line;
          log(`[ccu ${tag}] json ${body}${suffix}`);
        }
        return;
      }
      if (source === "atem-host" || source === "relay-join") {
        const mixerSig = JSON.stringify({
          gainDb: raw.gainDb,
          iso: raw.iso,
          tally: raw.tally,
        });
        if (mixerSig !== lastAtemMixerSnapshotSigByTag[tag]) {
          lastAtemMixerSnapshotSigByTag[tag] = mixerSig;
          log(`[ccu ${tag}] mixer ${mixerSig}`);
        }
      }
      if (!debugExtrasOn) return;
      if (isLikelyAtemPanelSyncSnapshot(raw)) {
        const sideKeys = new Set<string>(RELAY_PANEL_SYNC_SIDE_KEYS);
        const keys = Object.keys(raw).filter((k) => !sideKeys.has(k));
        log(
          `[ccu ${tag}] no ${RELAY_ATEM_CCU_TRACE_KEY} — ${keys.slice(0, 10).join(", ")}${keys.length > 10 ? "…" : ""}`,
        );
        if (localStorage.getItem(ATEM_CCU_TRACE_JSON_LS) === "1") {
          const line = JSON.stringify(raw);
          const max = 1200;
          const suffix =
            line.length > max ? `…(+${line.length - max})` : "";
          const body = line.length > max ? line.slice(0, max) : line;
          log(`[ccu ${tag}] snap ${body}${suffix}`);
        }
        return;
      }
    } catch (e) {
      console.warn("logAtemMixerPanelSyncDebug failed", e);
    }
  }

  // --- Persisted banks + relay transport bookkeeping ---

  let banks: BanksFile = emptyBanksFile();
  let globalScenes: Array<Bank | null> = Array.from({ length: GLOBAL_SCENE_COUNT }, () => null);
  let storeArmed = false;
  let activeDeviceId: string | undefined;
  let relayHostBridge: RelayHostSession | undefined;
  /** True after Join flow established a relay session with the host proxy. */
  let relayJoinedMode = false;
  /** Host `sessionName` from the last successful Join — overrides stale relay prefs for ATEM CCU room naming. */
  let relayJoinedDisplaySessionName: string | undefined;
  /** BLE GATT linked (device picked and connected locally). */
  let bleLinked = false;

  function updateLastBleReconnectUi(): void {
    const row = root.querySelector<HTMLElement>("[data-last-ble-row]");
    const btn = root.querySelector<HTMLButtonElement>("[data-last-ble-reconnect]");
    if (!row || !btn) return;
    if (!isNativeShell()) {
      row.hidden = true;
      return;
    }
    const last = readLastNativeBleSnapshot();
    const show = Boolean(last && !bleLinked && !relayJoinedMode && !relayHostBridge?.isAtemCcuHost);
    row.hidden = !show;
    if (!last) return;
    const hint = last.nameHint?.trim() || last.logicalId;
    const short = hint.length > 30 ? `${hint.slice(0, 27)}…` : hint;
    btn.textContent = `Last camera: ${short}`;
    btn.title = hint;
    btn.setAttribute("aria-label", `Reconnect to ${hint}`);
  }

  let lastStateSaveTimer: ReturnType<typeof setTimeout> | undefined;

  // The live "working" scene held in memory - always reflects the current panel
  // state (sliders, pots, knobs). Updated on every snapshot change and used to
  // detect divergence from the loaded bank.
  let currentScene: Bank = buildBankFromSnapshot(state.current);
  let loadedBankSnapshot: Bank | null = null;

  function resolveLoadedBankSnapshot(): Bank | null {
    if (banks.loadedSlot !== null) return banks.banks[banks.loadedSlot] ?? null;
    if (banks.globalLoadedSlot !== null) return globalScenes[banks.globalLoadedSlot] ?? null;
    return null;
  }

  function unifiedLoadedSlotForUi(): number | null {
    if (banks.loadedSlot !== null) return banks.loadedSlot;
    if (banks.globalLoadedSlot !== null) return BANK_COUNT + banks.globalLoadedSlot;
    return null;
  }

  function normalizeGlobalBanks(banksIn: Array<Bank | null>): Array<Bank | null> {
    const out = banksIn.slice(0, GLOBAL_SCENE_COUNT);
    while (out.length < GLOBAL_SCENE_COUNT) out.push(null);
    return out;
  }

  const isDirty = (): boolean => {
    if (!loadedBankSnapshot) return false;
    if (banks.loadedSlot === null && banks.globalLoadedSlot === null) return false;
    return JSON.stringify(currentScene) !== JSON.stringify(loadedBankSnapshot);
  };

  const renderBanks = (): void => {
    updateSceneBanks(root, {
      filledSlots: [...banks.banks.map((slot) => slot !== null), ...globalScenes.map((s) => s !== null)],
      loadedSlot: unifiedLoadedSlotForUi(),
      storeArmed,
      dirty: isDirty(),
    });
  };

  function applyRelayLoadedSlotHint(hints: ReturnType<typeof readRelayLoadedSlotFromSnap>): void {
    if (hints.loadedSlot === undefined) return;
    let nextLoadedLocal = banks.loadedSlot;
    let nextLoadedGlobal = banks.globalLoadedSlot;
    const u = hints.loadedSlot;
    if (u === null) {
      nextLoadedLocal = null;
      nextLoadedGlobal = null;
    } else if (u < BANK_COUNT) {
      nextLoadedLocal = u;
      nextLoadedGlobal = null;
    } else {
      nextLoadedLocal = null;
      nextLoadedGlobal = u - BANK_COUNT;
    }
    banks = {
      ...banks,
      loadedSlot: nextLoadedLocal,
      globalLoadedSlot: nextLoadedGlobal,
    };
    loadedBankSnapshot = resolveLoadedBankSnapshot();
    renderBanks();
  }

  const setStoreArmed = (armed: boolean): void => {
    storeArmed = armed;
    renderBanks();
  };

  const loadBanksFor = async (deviceId: string, opts?: { relayJoin?: boolean }): Promise<void> => {
    if (lastStateSaveTimer) {
      clearTimeout(lastStateSaveTimer);
      lastStateSaveTimer = undefined;
    }
    activeDeviceId = deviceId;
    try {
      const [next, globalFile] = await Promise.all([banksApi.load(deviceId), banksApi.loadGlobalScenes()]);
      banks = next;
      if (banks.globalLoadedSlot === undefined) banks = { ...banks, globalLoadedSlot: null };
      if (deviceId === ATEM_CCU_RELAY_DEVICE_ID || Boolean(banks.atemCcuRelay?.address?.trim())) {
        mergeAtemRelayFromServer(banks);
        syncAtemLanConnectUi?.();
      }
      globalScenes = normalizeGlobalBanks(globalFile.banks);
      loadedBankSnapshot = resolveLoadedBankSnapshot();
      prevDirty = false;
      renderBanks();
      if (deviceId !== ATEM_CCU_RELAY_DEVICE_ID) {
        const savedId = resolvedBodyCameraIdFromBank(banks.lastState);
        if (opts?.relayJoin && state.current.cameraNumber !== undefined) {
          setOutgoingDestination(state.current.cameraNumber);
          updatePanel(root, state.current, { localBleGattConnected: bleLinked && !relayJoinedMode });
        } else if (savedId !== undefined) {
          const idStr = String(savedId);
          state.setCameraNumber(savedId);
          setOutgoingDestination(savedId);
          state.applyMetadataWrite({ cameraId: idStr });
          log(`Restored camera id ${savedId} for ${deviceId}`);
          updatePanel(root, state.current, { localBleGattConnected: bleLinked && !relayJoinedMode });
        } else if (state.current.cameraNumber !== undefined) {
          setOutgoingDestination(state.current.cameraNumber);
        }
      }

      const skipHydrateFromStoredScene = opts?.relayJoin ?? false;
      // ATEM CCU hub banks carry a synthetic lastState; pushing it over BLE can await forever when a
      // camera is still connected (client.writeCommand hits rawClient first), leaving ATEM stuck on “Connecting…”.
      if (
        banks.lastState &&
        !skipHydrateFromStoredScene &&
        deviceId !== ATEM_CCU_RELAY_DEVICE_ID
      ) {
        const lastColor = banks.lastState.color;
        state.applyColorWrite({
          lift: { ...lastColor.lift },
          gamma: { ...lastColor.gamma },
          gain: { ...lastColor.gain },
          offset: { ...lastColor.offset },
          contrast: lastColor.contrast ? { ...lastColor.contrast } : undefined,
          lumaMix: lastColor.lumaMix,
          hue: lastColor.hue,
          saturation: lastColor.saturation,
        });
        try {
          await applyColorBankToCamera(client, banks.lastState);
          log("Restored color settings from last session");
        } catch (error) {
          log(`Color restore failed: ${errorMessage(error)}`);
        }
      }

      if (
        bleLinked &&
        !opts?.relayJoin &&
        deviceId !== ATEM_CCU_RELAY_DEVICE_ID &&
        !relayJoinedMode
      ) {
        const n = state.current.cameraNumber;
        if (n !== undefined && Number.isFinite(n)) {
          const idStr = String(Math.trunc(n));
          state.applyMetadataWrite({ cameraId: idStr });
          const pkt = commands.metadataCameraId(idStr);
          await runAction(log, `Camera ${idStr} (BLE — slate + destination)`, () => client.writeCommand(pkt), pkt);
          if (relayHostBridge?.isActive) scheduleRelayHostPanelSync();
        }
      }
    } catch (error) {
      log(`Banks load failed: ${errorMessage(error)}`);
    }
  };

  const scheduleLastStateSave = (): void => {
    if (!activeDeviceId) return;
    if (lastStateSaveTimer) clearTimeout(lastStateSaveTimer);
    lastStateSaveTimer = setTimeout(() => {
      const deviceId = activeDeviceId;
      if (!deviceId) return;
      void banksApi.saveLastState(deviceId, currentScene).catch((error: unknown) => {
        log(`Last-state save failed: ${errorMessage(error)}`);
      });
    }, 1500);
  };

  let banksRevisionCounter = 0;
  let relayHostPanelSyncTimer: ReturnType<typeof setTimeout> | undefined;

  function clearRelayHostPanelSyncDebouncer(): void {
    if (relayHostPanelSyncTimer !== undefined) {
      clearTimeout(relayHostPanelSyncTimer);
      relayHostPanelSyncTimer = undefined;
    }
  }

  /** Coalesced ATEM `panel_sync` slice for BLE mirror; drained by a single promise chain so writes cannot finish out of order. */
  let atemBleMirrorCoalesced: Record<string, unknown> | null = null;
  let atemBleMirrorChain: Promise<void> = Promise.resolve();

  function resetAtemBleMirrorBleQueue(): void {
    atemBleMirrorCoalesced = null;
    atemBleMirrorChain = Promise.resolve();
  }

  function enqueueAtemPanelSyncMirrorBle(clean: Record<string, unknown>): void {
    if (!rawClient.isConnected) return;
    atemBleMirrorCoalesced =
      atemBleMirrorCoalesced === null
        ? cloneRelayPanelCleanForBleMerge(clean)
        : deepMergeRelayPanelClean(atemBleMirrorCoalesced, clean);
    atemBleMirrorChain = atemBleMirrorChain
      .then(async () => {
        const patch = atemBleMirrorCoalesced;
        if (patch === null || Object.keys(patch).length === 0) return;
        atemBleMirrorCoalesced = null;
        const mirror = blePacketsFromAtemPanelSyncClean(patch);
        for (const p of mirror) {
          try {
            await rawClient.writeCommand(withDestination(p, outgoingDestination));
          } catch {
            break;
          }
        }
      })
      .catch(() => undefined);
  }

  function buildRelayPanelSyncEnvelope(): Record<string, unknown> {
    const snap = serializeCameraSnapshotForRelay(state.current);
    snap[RELAY_LOADED_SLOT_KEY] = unifiedLoadedSlotForUi();
    snap[RELAY_SCENE_FILLED_KEY] = [
      ...banks.banks.map((b) => b !== null),
      ...globalScenes.map((b) => b !== null),
    ];
    snap[RELAY_BANKS_REVISION_KEY] = banksRevisionCounter;
    return snap;
  }

  function scheduleRelayHostPanelSync(): void {
    if (!relayHostBridge?.isActive) return;
    if (relayHostPanelSyncTimer !== undefined) clearTimeout(relayHostPanelSyncTimer);
    relayHostPanelSyncTimer = setTimeout(() => {
      relayHostPanelSyncTimer = undefined;
      if (!relayHostBridge?.isActive) return;
      relayHostBridge.pushPanelSync(buildRelayPanelSyncEnvelope());
    }, 220);
  }

  async function reloadSceneBanksFromShared(cameraId: string): Promise<void> {
    try {
      const [next, globalFile] = await Promise.all([banksApi.load(cameraId), banksApi.loadGlobalScenes()]);
      if (cameraId !== activeDeviceId) return;
      banks = next.globalLoadedSlot === undefined ? { ...next, globalLoadedSlot: null } : next;
      globalScenes = normalizeGlobalBanks(globalFile.banks);
      loadedBankSnapshot = resolveLoadedBankSnapshot();
      renderBanks();
      banksRevisionCounter += 1;
      if (relayHostBridge?.isActive) relayHostBridge.pushPanelSync(buildRelayPanelSyncEnvelope());
    } catch (e: unknown) {
      log(`Relay: shared banks refresh failed: ${errorMessage(e)}`);
    }
  }

  function notifyJoinersBanksChanged(): void {
    if (!relayHostBridge?.isActive) return;
    banksRevisionCounter += 1;
    relayHostBridge.pushPanelSync(buildRelayPanelSyncEnvelope());
  }

  const ingestIncomingBle = (data: DataView): void => {
    const packet = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const hex = toHex(packet);
    const preGainDb = state.current.gainDb;
    const { decoded, changedKeys } = state.ingestIncomingPacket(data);

    if (!decoded) {
      const cmdHint = packet.length >= 3 ? ` cmdId=0x${packet[2]!.toString(16)}` : "";
      log(`Incoming (not decoded):${cmdHint} ${hex}`);
      return;
    }

    // Camera → ATEM: mirror BLE configuration deltas to the switcher (same `forward_cmd` path as UI).
    // Gate: mapped state changed, ATEM TCP up, opcode is one the relay server applies to CCU, and
    // skip redundant gain echo (camera confirms the same dB we already have from UI / CCU).
    const redundantGainEcho =
      decoded.category === 1 &&
      decoded.parameter === 13 &&
      preGainDb !== undefined &&
      preGainDb === decoded.values[0];
    if (
      relayHostBridge?.isAtemCcuHost &&
      !relayHostBridge.exclusiveAtemRelayHost &&
      relayHostBridge.atemSwitcherTcpConnected &&
      changedKeys.length > 0 &&
      bleDecodedHandledByAtemBridge(decoded) &&
      !redundantGainEcho
    ) {
      try {
        relayHostBridge.sendHostForwardCmd(packet);
      } catch {
        /* relay socket may have dropped */
      }
    }

    const display = decoded.stringValue
      ? JSON.stringify(decoded.stringValue)
      : `[${decoded.values.join(", ")}]`;
    const stateNote = changedKeys.length === 0 ? " [not mapped to live state]" : "";
    log(`Incoming ${decoded.categoryName} / ${decoded.parameterName}: ${display} (${hex})${stateNote}`);
  };

  const onStatus = (status: CameraStatus): void => {
    state.ingestStatus(status);
    relayHostBridge?.pushCameraStatus(status);
    if (relayHostBridge?.isActive) {
      clearRelayHostPanelSyncDebouncer();
      relayHostBridge.pushPanelSync(buildRelayPanelSyncEnvelope());
    }
    renderStatusFlags(root, status);
    log(formatCameraStatusLogLine(status));
  };

  const onIncoming = (data: DataView): void => {
    relayHostBridge?.pushIncoming(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    ingestIncomingBle(data);
  };

  let outgoingDestination = 255;
  const setOutgoingDestination = (dest: number): void => {
    outgoingDestination = Math.max(0, Math.min(255, Math.round(dest)));
  };

  /** After relay bootstrap / `panel_sync`, align BLE destination byte with host body index. */
  const syncRelayJoinerDestinationFromState = (): void => {
    const n = state.current.cameraNumber;
    if (n !== undefined && Number.isFinite(n)) {
      setOutgoingDestination(Math.trunc(n));
      return;
    }
    const raw = state.current.metadata?.cameraId;
    if (typeof raw === "string") {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        setOutgoingDestination(Math.max(0, Math.min(255, Math.round(parsed))));
      }
    }
  };

  let relayJoinDelegate: RelayJoinedCameraClient | undefined;
  let lastRelayJoinSessionId: string | undefined;
  let relayJoinReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let relayJoinReconnectAttempt = 0;
  /** Last `__relayBanksRevision` merged from bootstrap / panel_sync; avoids reloading banks each tick. */
  let lastRelayBanksRevisionSeen: number | undefined;
  /** Mirrors the Connect "Auto-reconnect" toggle for relay join (and BLE when not joined). */
  let joinAutoReconnect = true;
  const relayJoinDropChain: { handle: () => void } = { handle: () => {} };

  /** Assigned once relay prefs exist — refreshes browser-only ATEM LAN row. */
  let syncAtemLanConnectUi: (() => void) | undefined;

  /** Assigned after `rawClient` — runs native in-app BLE discovery when the Connect relay panel is visible. */
  let scheduleNativeBleDiscovery: (() => void) | undefined;

  const syncRelayHubButtons = (): void => {
    const hosting = !!relayHostBridge?.isActive;
    /** BLE / Join hub only — ATEM mixer has its own row so hosting must not flip this button to Disconnect. */
    const bleHubLive = bleLinked || relayJoinedMode;

    const connectToggle = root.querySelector<HTMLButtonElement>("[data-connect-toggle]");
    if (connectToggle) {
      connectToggle.textContent = bleHubLive ? "Disconnect" : "Connect";
      connectToggle.setAttribute(
        "aria-label",
        bleHubLive ? "Disconnect Bluetooth or leave relay" : "Connect to camera over Bluetooth",
      );
      connectToggle.classList.toggle("connect-primary", !bleHubLive);
      connectToggle.disabled = !bleHubLive && !rawClient.isSupported;
    }

    const shareToggle = root.querySelector<HTMLButtonElement>("[data-relay-share-toggle]");
    if (shareToggle) {
      shareToggle.hidden = relayJoinedMode;
      shareToggle.textContent = hosting ? "Stop sharing" : "Share";
      shareToggle.setAttribute(
        "aria-label",
        hosting ? "Stop sharing for remote operators" : "Share this camera over the relay",
      );
    }

    const joinToggle = root.querySelector<HTMLButtonElement>("[data-relay-join-toggle]");
    if (joinToggle) {
      joinToggle.hidden = bleLinked || !!relayHostBridge?.isAtemCcuHost;
      joinToggle.textContent = relayJoinedMode ? "Leave" : "Join";
      joinToggle.setAttribute(
        "aria-label",
        relayJoinedMode ? "Leave remote relay session" : "Join a remote relay session",
      );
    }

    const inlinePanel = root.querySelector<HTMLElement>("[data-relay-sessions-inline]");
    if (inlinePanel) inlinePanel.hidden = bleLinked || relayJoinedMode || !!relayHostBridge?.isAtemCcuHost;

    const nativeFound = root.querySelector<HTMLElement>("[data-native-ble-found]");
    if (nativeFound) {
      nativeFound.hidden =
        !isNativeShell() || bleLinked || relayJoinedMode || !!relayHostBridge?.isAtemCcuHost;
    }
    scheduleNativeBleDiscovery?.();
    updateLastBleReconnectUi();
    syncAtemLanConnectUi?.();
  };

  interface RelayListedSession {
    id: string;
    name: string;
    deviceId: string;
    /** Server-side ATEM TCP link (sessions hosted as ATEM CCU). */
    atemCcuTcp?: boolean;
  }

  async function fetchRelaySessionsList(): Promise<RelayListedSession[]> {
    const res = await fetch(getRelaySessionsUrl());
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as {
      sessions?: RelayListedSession[];
    };
    return data.sessions ?? [];
  }

  function renderRelaySessionUl(
    ul: HTMLUListElement | null,
    list: RelayListedSession[],
    onPick: (id: string) => void,
  ): void {
    if (!ul) return;
    ul.innerHTML = "";
    for (const row of list) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "relay-session-row";
      const labelBase = row.name ? `${row.name}` : row.id.slice(0, 8);
      let suffix = "";
      if (row.deviceId === ATEM_CCU_RELAY_DEVICE_ID) {
        if (row.atemCcuTcp === true) suffix = " · ATEM ✓";
        else if (row.atemCcuTcp === false) suffix = " · ATEM …";
      }
      b.textContent = `${labelBase}${suffix}`;
      b.title = row.deviceId || "Hosted session";
      b.addEventListener("click", () => onPick(row.id));
      li.appendChild(b);
      ul.appendChild(li);
    }
  }

  function reflectLocalBleLinkLost(message = "Disconnected"): void {
    bleLinked = false;
    state.clearForLocalBleDisconnect();
    renderStatusFlags(root, disconnectedPlaceholderStatus());
    setConnection(root, message, null);
    queueMicrotask(() => refreshControls());
    syncRelayHubButtons();
    log(message);
  }

  const bleTransportHandlers = {
    onStatus,
    onIncomingControl: onIncoming,
    onLog: (message: string) => log(message),
    onDisconnect: () => {
      clearRelayHostPanelSyncDebouncer();
      resetAtemBleMirrorBleQueue();
      relayHostBridge?.cleanup();
      relayHostBridge = undefined;
      reflectLocalBleLinkLost("Disconnected");
    },
    onReconnectScheduled: (delayMs: number, attempt: number) => {
      setConnection(root, `Reconnecting in ${(delayMs / 1000).toFixed(0)}s (try ${attempt})…`);
    },
    onReconnectAttempt: (attempt: number) => {
      setConnection(root, `Reconnecting (try ${attempt})…`);
    },
    onReconnectSucceeded: (info: { deviceId: string; deviceName: string }) => {
      state.setDeviceName(info.deviceName);
      setConnection(root, "", info.deviceName);
      bleLinked = true;
      queueMicrotask(() => refreshControls());
      void (async () => {
        await loadBanksFor(info.deviceId);
        void maybeOfferRelayHosting(info.deviceId);
        syncRelayHubButtons();
        log(`Auto-reconnected: ${info.deviceName}`);
      })();
    },
  };

  const rawClient: CameraClient =
    options.client ??
    (isNativeShell()
      ? new NativeBleCameraClient(bleTransportHandlers)
      : new BlackmagicBleClient(bleTransportHandlers));

  let nativeBleDiscoverGen = 0;
  const nativeBleScanner = rawClient instanceof NativeBleCameraClient ? rawClient : undefined;
  const foundBleDevices = new Map<string, NativeBleScanHit>();

  function isConnectViewActive(): boolean {
    return root.querySelector<HTMLElement>(".panel-app")?.dataset.viewActive === "connect";
  }

  function updateNativeFoundEmptyState(): void {
    const empty = root.querySelector<HTMLElement>("[data-native-ble-found-empty]");
    const section = root.querySelector<HTMLElement>("[data-native-ble-found]");
    if (!empty || !section || section.hidden || !isNativeShell()) {
      if (empty && (!section || section.hidden)) empty.hidden = true;
      return;
    }
    if (foundBleDevices.size > 0) {
      empty.hidden = true;
      return;
    }
    empty.hidden = false;
    const scanning = Boolean(nativeBleScanner?.isScanningBle);
    empty.textContent = scanning
      ? "Scanning for Blackmagic cameras…"
      : "No matching camera yet. Tap Rescan or use Connect for the full system Bluetooth picker.";
  }

  function renderNativeFoundBleList(): void {
    const ul = root.querySelector<HTMLUListElement>("[data-native-ble-found-list]");
    if (!ul) return;
    ul.innerHTML = "";
    const sorted = [...foundBleDevices.values()].sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999));
    for (const row of sorted) {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "relay-session-row";
      b.textContent = row.label;
      b.title = row.deviceId;
      b.dataset.bleDeviceId = row.deviceId;
      b.dataset.bleDeviceLabel = row.label;
      li.appendChild(b);
      ul.appendChild(li);
    }
    updateNativeFoundEmptyState();
  }

  async function reconcileNativeBleDiscoveryAsync(): Promise<void> {
    const gen = ++nativeBleDiscoverGen;
    const nc = nativeBleScanner;
    const panel = root.querySelector<HTMLElement>("[data-relay-sessions-inline]");
    const section = root.querySelector<HTMLElement>("[data-native-ble-found]");
    const shouldRun =
      !!nc &&
      isNativeShell() &&
      !bleLinked &&
      !relayJoinedMode &&
      panel !== null &&
      !panel.hidden &&
      section !== null &&
      !section.hidden &&
      isConnectViewActive();

    if (!shouldRun) {
      await nc?.stopBleScan().catch(() => {});
      if (gen === nativeBleDiscoverGen) {
        foundBleDevices.clear();
        renderNativeFoundBleList();
      }
      return;
    }

    await nc!.stopBleScan().catch(() => {});
    if (gen !== nativeBleDiscoverGen) return;

    foundBleDevices.clear();
    renderNativeFoundBleList();

    try {
      await nc!.startBleScan((hit) => {
        foundBleDevices.set(hit.deviceId, hit);
        renderNativeFoundBleList();
      });
    } catch (e: unknown) {
      log(`BLE scan failed: ${errorMessage(e)}`);
      renderNativeFoundBleList();
    }

    if (gen !== nativeBleDiscoverGen) {
      await nc!.stopBleScan().catch(() => {});
    }
    updateNativeFoundEmptyState();
  }

  scheduleNativeBleDiscovery = () => {
    void reconcileNativeBleDiscoveryAsync().catch((e: unknown) => log(errorMessage(e)));
  };

  joinAutoReconnect = rawClient.autoReconnectEnabled;

  const RELAY_JOIN_RESTORE_LS = "bm-relay-join-restore-v1";

  interface JoinRestorePayload {
    sessionId: string;
    autoReconnect: boolean;
  }

  function readRelayJoinRestore(): JoinRestorePayload | undefined {
    try {
      const raw = localStorage.getItem(RELAY_JOIN_RESTORE_LS);
      if (!raw) return undefined;
      const data = JSON.parse(raw) as JoinRestorePayload;
      if (typeof data.sessionId !== "string" || !data.sessionId) return undefined;
      return {
        sessionId: data.sessionId,
        autoReconnect: Boolean(data.autoReconnect),
      };
    } catch {
      return undefined;
    }
  }

  function writeRelayJoinRestore(payload: JoinRestorePayload): void {
    try {
      localStorage.setItem(RELAY_JOIN_RESTORE_LS, JSON.stringify(payload));
    } catch {
      /* ignore */
    }
  }

  function clearRelayJoinRestore(): void {
    try {
      localStorage.removeItem(RELAY_JOIN_RESTORE_LS);
    } catch {
      /* ignore */
    }
  }

  function touchRelayJoinRestoreAutoReconnect(enabled: boolean): void {
    try {
      const raw = localStorage.getItem(RELAY_JOIN_RESTORE_LS);
      if (!raw) return;
      const data = JSON.parse(raw) as JoinRestorePayload;
      if (typeof data.sessionId !== "string" || !data.sessionId) return;
      data.autoReconnect = enabled;
      localStorage.setItem(RELAY_JOIN_RESTORE_LS, JSON.stringify(data));
    } catch {
      /* ignore */
    }
  }

  function clearRelayJoinReconnectSchedule(): void {
    if (relayJoinReconnectTimer !== undefined) {
      clearTimeout(relayJoinReconnectTimer);
      relayJoinReconnectTimer = undefined;
    }
  }

  const relayJoinTransport = (): RelayJoinedCameraClient => {
    if (relayJoinDelegate) return relayJoinDelegate;
    relayJoinDelegate = new RelayJoinedCameraClient({
      onRelayStatus: (msg) => {
        const status =
          msg.payloadHex && msg.payloadHex.length > 0
            ? decodeCameraStatusFromHex(msg.payloadHex)
            : decodeCameraStatus(msg.raw);
        state.ingestStatus(status);
        renderStatusFlags(root, status);
        log(formatCameraStatusLogLine(status));
      },
      onRelayIncomingHex: (hexStr) => {
        const hex = hexStr.trim();
        if (hex.length < 2) return;
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < bytes.length; i++) {
          bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        ingestIncomingBle(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
      },
      onRelayBootstrapSnapshot: (snap) => {
        const rec = snap as Record<string, unknown>;
        primeJoinAtemMixerDebugFromSnap(rec);
        const hints = readRelayLoadedSlotFromSnap(rec);
        const clean = stripRelayPanelSideKeys(rec);
        const br = rec[RELAY_BANKS_REVISION_KEY];
        if (typeof br === "number") lastRelayBanksRevisionSeen = br;
        if (Object.keys(clean).length > 0) {
          state.hydrateFromRelayExport(clean);
        }
        applyRelayLoadedSlotHint(hints);
        syncRelayJoinerDestinationFromState();
        const st = state.current.status;
        if (st) renderStatusFlags(root, st);
        log("Relay: full panel snapshot applied from host");
      },
      onRelayPanelSync: (snap) => {
        const rec = snap as Record<string, unknown>;
        primeJoinAtemMixerDebugFromSnap(rec);
        logAtemMixerPanelSyncDebug(rec, "relay-join");
        const hints = readRelayLoadedSlotFromSnap(rec);
        const clean = stripRelayPanelSideKeys(rec);
        if (Object.keys(clean).length > 0) {
          state.relayPanelSyncPatch(clean);
        }
        applyRelayLoadedSlotHint(hints);
        syncRelayJoinerDestinationFromState();
        const banksRevRaw = snap[RELAY_BANKS_REVISION_KEY];
        const banksRev = typeof banksRevRaw === "number" ? banksRevRaw : undefined;
        if (banksRev !== undefined && banksRev !== lastRelayBanksRevisionSeen && activeDeviceId) {
          lastRelayBanksRevisionSeen = banksRev;
          void loadBanksFor(activeDeviceId, { relayJoin: true }).catch((e: unknown) => {
            log(`Relay banks refresh failed: ${errorMessage(e)}`);
          });
        }
      },
      onJoinedInfo: (deviceId, sessionName) => {
        const sn = sessionName.trim();
        if (sn) relayJoinedDisplaySessionName = sn;
        log(`Relay joined: ${sessionName} (${deviceId})`);
      },
      onDropped: () => {
        relayJoinedMode = false;
        relayJoinedDisplaySessionName = undefined;
        lastRelayBanksRevisionSeen = undefined;
        joinRelAtemMixerDebugPrimed = false;
        for (const k of Object.keys(lastAtemMixerSnapshotSigByTag)) delete lastAtemMixerSnapshotSigByTag[k];
        state.clearForLocalBleDisconnect();
        renderStatusFlags(root, disconnectedPlaceholderStatus());
        setConnection(root, "Disconnected", null);
        queueMicrotask(() => refreshControls());
        syncRelayHubButtons();
        relayJoinDropChain.handle();
      },
      log,
    });
    return relayJoinDelegate;
  };

  let panelActive = true;

  const client: CameraClient = {
    get isSupported() {
      return rawClient.isSupported || typeof WebSocket !== "undefined";
    },
    get isConnected() {
      if (relayJoinedMode) return !!relayJoinTransport().isConnected;
      if (relayHostBridge?.isAtemCcuHost) return relayHostBridge.isActive;
      return rawClient.isConnected;
    },
    get autoReconnectEnabled() {
      return relayJoinedMode ? joinAutoReconnect : rawClient.autoReconnectEnabled;
    },
    connect: () => rawClient.connect(),
    disconnect: () => {
      clearRelayHostPanelSyncDebouncer();
      resetAtemBleMirrorBleQueue();
      if (relayHostBridge?.isActive) {
        relayHostBridge.stopSharing();
      } else {
        relayHostBridge?.cleanup();
      }
      relayHostBridge = undefined;
      if (relayJoinedMode) {
        relayJoinedMode = false;
        relayJoinedDisplaySessionName = undefined;
        lastRelayBanksRevisionSeen = undefined;
        joinRelAtemMixerDebugPrimed = false;
        for (const k of Object.keys(lastAtemMixerSnapshotSigByTag)) delete lastAtemMixerSnapshotSigByTag[k];
        clearRelayJoinReconnectSchedule();
        lastRelayJoinSessionId = undefined;
        clearRelayJoinRestore();
        relayJoinDelegate?.cleanup();
        rawClient.setAutoReconnect(joinAutoReconnect);
      }
      rawClient.disconnect();
    },
    writeCommand: async (packet: Uint8Array) => {
      const dest = withDestination(packet, outgoingDestination);
      if (relayHostBridge?.isAtemCcuHost) {
        // ATEM-only relay host uses `nullBleCameraClient`; do not mirror to a parallel Web Bluetooth
        // session — same moment as `loadBanksFor` / color restore causes "GATT operation already in progress".
        if (rawClient.isConnected && !relayHostBridge.exclusiveAtemRelayHost) {
          await rawClient.writeCommand(dest);
        }
        try {
          relayHostBridge.sendHostForwardCmd(packet);
        } catch {
          /* host forward can fail if relay socket dropped */
        }
        return;
      }
      return relayJoinedMode
        ? relayJoinTransport().writeCommand(packet)
        : rawClient.writeCommand(dest);
    },
    triggerPairing: () =>
      relayJoinedMode ? relayJoinTransport().triggerPairing() : rawClient.triggerPairing(),
    setPower: (on: boolean) =>
      relayJoinedMode ? relayJoinTransport().setPower(on) : rawClient.setPower(on),
    setAutoReconnect: (enabled: boolean) => {
      joinAutoReconnect = enabled;
      if (!relayJoinedMode) rawClient.setAutoReconnect(enabled);
      touchRelayJoinRestoreAutoReconnect(enabled);
    },
    tryRestoreConnection: rawClient.tryRestoreConnection ? () => rawClient.tryRestoreConnection!() : undefined,
  };

  root.innerHTML = renderPanelTemplate(rawClient.isSupported, {
    hideBrowserBleInstallHints: isNativeShell(),
    showAtemLanConnect: !isNativeShell(),
  });
  const settingsVersionEl = root.querySelector("[data-settings-version]");
  if (settingsVersionEl) {
    settingsVersionEl.textContent = `App version ${buildAppVersion()}${isNativeShell() ? " (native shell)" : ""}`;
  }
  attachClient(root, client);
  initBluefyOfferModal(root);

  const viewController = bindViewNav(root, {
    onViewChange(viewId: ViewId) {
      if (viewId === "connect") {
        void refreshRelaySessionsDisplay({ soft: true });
        syncAtemLanConnectUi?.();
      }
      scheduleNativeBleDiscovery?.();
    },
  });

  async function finalizeRelayJoin(sessionId: string): Promise<void> {
    if (bleLinked) {
      log("Disconnect local Bluetooth session before joining remotely");
      return;
    }
    if (relayHostBridge?.isActive) {
      log("Stop sharing this camera before joining another session.");
      return;
    }

    clearRelayJoinReconnectSchedule();
    lastRelayJoinSessionId = sessionId;

    const backdrop = root.querySelector<HTMLElement>("[data-relay-list-modal]");
    if (backdrop) backdrop.hidden = true;

    relayJoinedMode = false;
    relayJoinedDisplaySessionName = undefined;
    relayJoinTransport().cleanupQuiet();
    lastRelayBanksRevisionSeen = undefined;

    setConnection(root, "Negotiating relay (WebSocket handshake)…", null);
    try {
      const info = await relayJoinTransport().joinSession(sessionId);
      relayJoinedMode = true;
      {
        const dn = info.deviceName?.trim();
        if (dn) relayJoinedDisplaySessionName = dn;
      }
      relayJoinReconnectAttempt = 0;
      writeRelayJoinRestore({ sessionId, autoReconnect: joinAutoReconnect });
      setConnection(root, "Relay", null);
      await loadBanksFor(info.deviceId, { relayJoin: true });
      bleLinked = false;
      refreshControls();
      viewController.onConnected();
      log(`Relay connected: "${info.deviceName}" via ${getRelaySocketUrl()}`);
    } catch (e) {
      relayJoinedMode = false;
      relayJoinedDisplaySessionName = undefined;
      relayJoinTransport().cleanup();
      state.clearDeviceName();
      setConnection(root, "Disconnected", null);
      log(`Relay join failed: ${errorMessage(e)}`);
      refreshControls();
      if (joinAutoReconnect && lastRelayJoinSessionId) scheduleRelayJoinReconnect();
      else {
        clearRelayJoinRestore();
        lastRelayJoinSessionId = undefined;
      }
    }
  }

  function scheduleRelayJoinReconnect(): void {
    if (!joinAutoReconnect || !lastRelayJoinSessionId) return;
    if (relayJoinedMode) return;
    if (relayJoinReconnectTimer !== undefined) return;
    const attempt = relayJoinReconnectAttempt++;
    const delayMs = Math.min(30_000, 800 * Math.pow(2, Math.min(attempt, 5)));
    log(`Relay join: reconnect in ${(delayMs / 1000).toFixed(1)}s (attempt ${attempt + 1})…`);
    relayJoinReconnectTimer = setTimeout(() => {
      relayJoinReconnectTimer = undefined;
      const sid = lastRelayJoinSessionId;
      if (!sid || !joinAutoReconnect || relayJoinedMode) {
        relayJoinReconnectAttempt = 0;
        return;
      }
      void (async () => {
        setConnection(root, "Reconnecting relay…");
        await finalizeRelayJoin(sid);
      })();
    }, delayMs);
  }

  relayJoinDropChain.handle = (): void => {
    if (joinAutoReconnect && lastRelayJoinSessionId) {
      scheduleRelayJoinReconnect();
    } else {
      clearRelayJoinRestore();
      lastRelayJoinSessionId = undefined;
    }
  };

  async function refreshRelaySessionsDisplay(options: { soft?: boolean } = {}): Promise<void> {
    const soft = options.soft ?? false;
    const ulModal = root.querySelector<HTMLUListElement>("[data-relay-session-list]");
    const ulInline = root.querySelector<HTMLUListElement>("[data-relay-session-list-inline]");
    const emptyModal = root.querySelector<HTMLElement>("[data-relay-empty]");
    const emptyInline = root.querySelector<HTMLElement>("[data-relay-inline-empty]");
    const listBackdrop = root.querySelector<HTMLElement>("[data-relay-list-modal]");
    const modalOpen = !!(listBackdrop && !listBackdrop.hidden);
    const inlinePanel = root.querySelector<HTMLElement>("[data-relay-sessions-inline]");
    const inlineVisible = !!(inlinePanel && !inlinePanel.hidden);

    if (!modalOpen && !inlineVisible) return;

    const onPick = (id: string): void => {
      if (ulModal) ulModal.dataset.selectedSession = id;
      void finalizeRelayJoin(id);
    };

    if (modalOpen && ulModal && emptyModal) {
      ulModal.innerHTML = "";
      emptyModal.hidden = false;
      emptyModal.textContent = "Loading hosted sessions…";
    }

    if (inlineVisible && ulInline && emptyInline) {
      const inlineHasRows = Boolean(ulInline.querySelector("li"));
      const showSpinner = !soft || !inlineHasRows;
      if (showSpinner) {
        ulInline.innerHTML = "";
        emptyInline.hidden = false;
        emptyInline.textContent = "Loading hosted sessions…";
      }
    }

    try {
      const list = await fetchRelaySessionsList();

      if (modalOpen) {
        renderRelaySessionUl(ulModal, list, onPick);
        if (emptyModal) {
          if (list.length === 0) {
            emptyModal.hidden = false;
            emptyModal.textContent =
              "No hosted sessions yet. Ask the operator to tap Share on Bluetooth, then refresh.";
          } else emptyModal.hidden = true;
        }
      }

      if (inlineVisible) {
        renderRelaySessionUl(ulInline, list, onPick);
        if (emptyInline) {
          if (list.length === 0) {
            emptyInline.hidden = false;
            emptyInline.textContent =
              "No hosted sessions. When a camera host shares over this server, it will appear here.";
          } else emptyInline.hidden = true;
        }
      }
    } catch (e) {
      const msg = `Sessions list failed: ${errorMessage(e)}`;
      if (modalOpen && emptyModal) {
        emptyModal.hidden = false;
        emptyModal.textContent = msg;
        ulModal && (ulModal.innerHTML = "");
      }
      if (inlineVisible && emptyInline) {
        emptyInline.hidden = false;
        emptyInline.textContent = msg;
        ulInline && (ulInline.innerHTML = "");
      }
      if (!soft) log(msg);
    }
  }

  function refreshControls(): void {
    const live = bleLinked || relayJoinedMode || !!relayHostBridge?.isAtemCcuHost;
    setControlsEnabled(root, panelActive && live);
    root.classList.toggle("panel-inactive", !panelActive);
    const connWrap = root.querySelector(".connection-controls");
    if (connWrap) {
      connWrap.classList.toggle("is-ble-connected", bleLinked || relayJoinedMode);
    }
    const cameraIdCard = root.querySelector<HTMLElement>("[data-connect-camera-id-card]");
    if (cameraIdCard) cameraIdCard.hidden = !bleLinked;
    syncRelayHubButtons();
    if (!bleLinked && !relayJoinedMode && !relayHostBridge?.isAtemCcuHost) {
      void refreshRelaySessionsDisplay({ soft: true });
    }
    const btn = root.querySelector<HTMLButtonElement>("[data-panel-active]");
    if (btn) {
      btn.classList.toggle("active", panelActive);
      btn.setAttribute("aria-pressed", panelActive ? "true" : "false");
    }
  }

  relayJoinTransport(); // Instantiate once early so getters are stable during tests

  refreshControls();

  renderBanks();

  void banksApi
    .loadGlobalScenes()
    .then((g) => {
      globalScenes = normalizeGlobalBanks(g.banks);
      renderBanks();
    })
    .catch(() => {});

  const SESSION_RELAY_LS = "bm-relay-session-prefs-v1";
  const SESSION_RELAY_GLOBAL_LS = "bm-relay-session-prefs-global-v1";
  /** Banks API device id for relay hosting backed by ATEM CCU (no BLE camera). */
  const ATEM_CCU_RELAY_DEVICE_ID = "atem-ccu-host";
  /** `SESSION_RELAY_LS` bucket for last-used mixer camera index per switcher address (normalized). */
  function atemLanPrefsDeviceKey(address: string): string {
    return `atem-lan:${address.trim().toLowerCase()}`;
  }
  /** When set, user chose Connect on the ATEM LAN card and wants retry/rehydrate until Disconnect. */
  const ATEM_LAN_PERSIST_LS = "bm-atem-lan-persist-v1";

  function readAtemLanPersistIntent(): boolean {
    try {
      return localStorage.getItem(ATEM_LAN_PERSIST_LS) === "1";
    } catch {
      return false;
    }
  }

  function writeAtemLanPersistIntent(on: boolean): void {
    try {
      if (on) localStorage.setItem(ATEM_LAN_PERSIST_LS, "1");
      else localStorage.removeItem(ATEM_LAN_PERSIST_LS);
    } catch {
      /* ignore quota / Safari private */
    }
  }

  interface RelayStoredPrefs {
    sessionName?: string;
    share?: boolean;
    atemCcu?: boolean;
    atemAddress?: string;
    atemCameraId?: number;
  }

  function readRelayPrefs(deviceId: string): RelayStoredPrefs | undefined {
    try {
      const raw = localStorage.getItem(SESSION_RELAY_LS);
      if (!raw) return undefined;
      const all = JSON.parse(raw) as Record<string, RelayStoredPrefs>;
      return all[deviceId];
    } catch {
      return undefined;
    }
  }

  function readRelayPrefsGlobal(): RelayStoredPrefs | undefined {
    try {
      const raw = localStorage.getItem(SESSION_RELAY_GLOBAL_LS);
      if (!raw) return undefined;
      return JSON.parse(raw) as RelayStoredPrefs;
    } catch {
      return undefined;
    }
  }

  function writeRelayPrefsGlobal(prefs: RelayStoredPrefs): void {
    try {
      localStorage.setItem(SESSION_RELAY_GLOBAL_LS, JSON.stringify(prefs));
    } catch {
      /* ignore quota / Safari private */
    }
  }

  function writeRelayPrefs(deviceId: string, prefs: RelayStoredPrefs): void {
    try {
      const raw = localStorage.getItem(SESSION_RELAY_LS);
      const all = raw ? ((JSON.parse(raw) as Record<string, RelayStoredPrefs>) ?? {}) : {};
      all[deviceId] = prefs;
      const addrTr = prefs.atemAddress?.trim();
      if (addrTr) {
        const ak = atemLanPrefsDeviceKey(addrTr);
        const prevAk = all[ak] ?? {};
        all[ak] = {
          ...prevAk,
          atemAddress: addrTr,
          ...(prefs.atemCameraId !== undefined ? { atemCameraId: prefs.atemCameraId } : {}),
        };
      }
      localStorage.setItem(SESSION_RELAY_LS, JSON.stringify(all));
      const n = prefs.sessionName?.trim();
      const glob = readRelayPrefsGlobal();
      if (n) {
        writeRelayPrefsGlobal({
          sessionName: n,
          share: Boolean(prefs.share),
          atemCcu: prefs.atemCcu,
          atemAddress: prefs.atemAddress,
          atemCameraId: prefs.atemCameraId,
        });
      } else if (
        prefs.atemAddress !== undefined ||
        prefs.atemCameraId !== undefined ||
        prefs.atemCcu !== undefined
      ) {
        writeRelayPrefsGlobal({
          sessionName: glob?.sessionName ?? "",
          share: prefs.share !== undefined ? Boolean(prefs.share) : (glob?.share ?? true),
          atemCcu: prefs.atemCcu ?? glob?.atemCcu,
          atemAddress: prefs.atemAddress ?? glob?.atemAddress,
          atemCameraId: prefs.atemCameraId ?? glob?.atemCameraId,
        });
      }
    } catch {
      /* ignore quota / Safari private */
    }
  }

  function clampAtemCameraId(raw: number): number {
    return Number.isFinite(raw) ? Math.min(24, Math.max(1, Math.round(raw))) : 1;
  }

  /** BLE body index 1–255 → ATEM CCU source 1–24. */
  function atemCameraIdFromBleBody(cam: number): number {
    return clampAtemCameraId(cam);
  }

  /**
   * While hosting a real camera over BLE, treat its `cameraNumber` as the ATEM mixer / CCU filter id:
   * persist prefs, refresh the LAN row, and re-register the hub bridge when ATEM CCU is live.
   */
  function pushBleBodyCameraIdToAtemMixerFilter(cam: number): void {
    if (!bleLinked || relayJoinedMode) return;
    if (!activeDeviceId || activeDeviceId === ATEM_CCU_RELAY_DEVICE_ID) return;
    const id = atemCameraIdFromBleBody(cam);
    const curModal = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
    writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, {
      sessionName: curModal.sessionName,
      share: curModal.share,
      atemCcu: curModal.atemCcu,
      atemAddress: curModal.atemAddress,
      atemCameraId: id,
    });
    const cp = readRelayPrefs(activeDeviceId) ?? {};
    writeRelayPrefs(activeDeviceId, {
      ...cp,
      atemCameraId: id,
      ...(cp.sessionName === undefined ? { sessionName: curModal.sessionName } : {}),
      ...(cp.share === undefined ? { share: curModal.share } : {}),
      ...(cp.atemCcu === undefined ? { atemCcu: curModal.atemCcu } : {}),
      ...(cp.atemAddress === undefined ? { atemAddress: curModal.atemAddress } : {}),
    });
    const camEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-camera]");
    if (camEl && document.activeElement !== camEl) camEl.value = String(id);
    const addr = curModal.atemAddress.trim();
    if (relayHostBridge?.isAtemCcuHost && relayHostBridge.isActive && addr) {
      try {
        relayHostBridge.attachAtemCcu({ address: addr, cameraId: id });
      } catch (e: unknown) {
        log(`ATEM CCU: re-register camera ${id} failed: ${errorMessage(e)}`);
      }
    }
    syncAtemLanConnectUi?.();
  }

  function relayPrefsForModal(deviceId: string): {
    sessionName: string;
    share: boolean;
    atemCcu: boolean;
    atemAddress: string;
    atemCameraId: number;
  } {
    const per = readRelayPrefs(deviceId);
    const glob = readRelayPrefsGlobal();
    const sessionName = per !== undefined ? (per.sessionName ?? "") : (glob?.sessionName ?? "");
    const share =
      per !== undefined && per.share !== undefined ? per.share : (glob?.share ?? true);
    const atemCcu = Boolean(per?.atemCcu ?? glob?.atemCcu);
    const atemAddress = String(per?.atemAddress ?? glob?.atemAddress ?? "192.168.1.199").trim();
    const addrBucket = readRelayPrefs(atemLanPrefsDeviceKey(atemAddress));
    const fromBleBody =
      bleLinked &&
      activeDeviceId &&
      activeDeviceId !== ATEM_CCU_RELAY_DEVICE_ID &&
      state.current.cameraNumber !== undefined &&
      Number.isFinite(state.current.cameraNumber)
        ? atemCameraIdFromBleBody(state.current.cameraNumber)
        : undefined;
    const rawCam =
      fromBleBody ??
      per?.atemCameraId ??
      glob?.atemCameraId ??
      addrBucket?.atemCameraId ??
      state.current.cameraNumber ??
      1;
    const atemCameraId = clampAtemCameraId(Number(rawCam));
    return { sessionName, share, atemCcu, atemAddress, atemCameraId };
  }

  /** One relay room name for BLE share and ATEM mixer so joiners see a single session. */
  function effectiveAtemRelaySessionName(): string {
    if (relayJoinedMode) {
      const jn = relayJoinedDisplaySessionName?.trim();
      if (jn) return jn;
    }
    if (activeDeviceId && activeDeviceId !== ATEM_CCU_RELAY_DEVICE_ID) {
      const sp = readRelayPrefs(activeDeviceId)?.sessionName?.trim();
      if (sp) return sp;
    }
    const g = readRelayPrefsGlobal()?.sessionName?.trim();
    if (g) return g;
    return relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID).sessionName.trim();
  }

  /**
   * Relay room name for {@link performAtemLanHost} when opening a new host socket.
   * ATEM-only hub (`atem-ccu-host`) must not inherit another camera's session name (e.g. BLE "woho")
   * or you advertise that share name while only debugging the mixer on the Connect tab.
   */
  function relaySessionNameForAtemLanHost(hostDeviceId: string): string {
    if (hostDeviceId === ATEM_CCU_RELAY_DEVICE_ID) {
      return relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID).sessionName.trim() || "ATEM CCU";
    }
    return effectiveAtemRelaySessionName().trim() || "ATEM CCU";
  }

  function atemBanksPersistDeviceId(): string {
    if (bleLinked && activeDeviceId && activeDeviceId !== ATEM_CCU_RELAY_DEVICE_ID) {
      return activeDeviceId;
    }
    return ATEM_CCU_RELAY_DEVICE_ID;
  }

  function mergeAtemRelayFromServer(file: BanksFile): void {
    const r = file.atemCcuRelay;
    if (!r?.address?.trim()) return;
    const cur = readRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID);
    const serverCamOk =
      r.cameraId !== undefined && r.cameraId !== null && Number.isFinite(Number(r.cameraId));
    const mergedCam = serverCamOk
      ? clampAtemCameraId(Math.round(Number(r.cameraId)))
      : clampAtemCameraId(
          cur?.atemCameraId ??
            readRelayPrefs(atemLanPrefsDeviceKey(r.address.trim()))?.atemCameraId ??
            readRelayPrefsGlobal()?.atemCameraId ??
            state.current.cameraNumber ??
            1,
        );
    writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, {
      sessionName: (r.sessionName?.trim() || cur?.sessionName || "ATEM CCU").slice(0, 120),
      share: cur?.share !== false,
      atemCcu: cur?.atemCcu ?? false,
      atemAddress: r.address.trim(),
      atemCameraId: mergedCam,
    });
  }

  let atemLanReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let atemLanReconnectAttempts = 0;
  /** True only while `performAtemLanHost` is awaiting relay + ATEM (avoids bogus “reconnecting” on reload when persist is still set). */
  let atemLanResumeInFlight = false;

  function clearAtemLanReconnectSchedule(): void {
    if (atemLanReconnectTimer !== undefined) {
      clearTimeout(atemLanReconnectTimer);
      atemLanReconnectTimer = undefined;
    }
  }

  /** Clears ATEM LAN timers and tears down any relay host session so Connect / Disconnect always start from a clean connector. */
  function forceResetAtemLanRelayConnector(logLine?: string): void {
    clearAtemLanReconnectSchedule();
    atemLanReconnectAttempts = 0;
    atemLanResumeInFlight = false;
    clearRelayHostPanelSyncDebouncer();
    resetAtemBleMirrorBleQueue();
    for (const k of Object.keys(lastAtemMixerSnapshotSigByTag)) delete lastAtemMixerSnapshotSigByTag[k];
    if (relayHostBridge) {
      if (relayHostBridge.isActive) {
        relayHostBridge.stopSharing();
      } else {
        relayHostBridge.cleanup();
      }
      relayHostBridge = undefined;
    }
    if (logLine) log(logLine);
  }

  syncAtemLanConnectUi = (): void => {
    const card = root.querySelector<HTMLElement>("[data-atem-ccu-lan-card]");
    if (!card) return;
    const ipEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-ip]");
    const camEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-camera]");
    const btn = root.querySelector<HTMLButtonElement>("[data-atem-ccu-lan-connect]");
    const statusEl = root.querySelector<HTMLElement>("[data-atem-ccu-lan-status]");
    const prefs = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
    const wsOk = typeof WebSocket !== "undefined";
    const atemLive = !!relayHostBridge?.isAtemCcuHost;
    const persistHostIntent = readAtemLanPersistIntent() && !atemLive && wsOk;
    const atemLanConnectInProgress = atemLanResumeInFlight && !atemLive && wsOk;

    if (ipEl && ipEl.value.trim() === "") ipEl.value = prefs.atemAddress;
    if (camEl) {
      if (atemLive || persistHostIntent) {
        camEl.value = String(prefs.atemCameraId);
      } else if (camEl.value.trim() === "") {
        camEl.value = String(prefs.atemCameraId);
      }
    }
    const rowBlocked = !wsOk;

    if (btn) {
      btn.disabled = rowBlocked;
      btn.textContent = atemLive || persistHostIntent ? "Disconnect" : "Connect";
      btn.classList.toggle("connect-primary", !atemLive && !persistHostIntent);
    }
    if (ipEl) ipEl.disabled = atemLive;
    if (camEl) camEl.disabled = atemLive;

    if (statusEl) {
      if (atemLive) {
        statusEl.hidden = false;
        const ip = ipEl?.value.trim() ?? prefs.atemAddress;
        const cam = Number.isFinite(Number(camEl?.value))
          ? clampAtemCameraId(Number(camEl!.value))
          : prefs.atemCameraId;
        const tcpOk = relayHostBridge?.atemSwitcherTcpConnected ?? false;
        statusEl.textContent = tcpOk
          ? `Connected to ATEM at ${ip} (camera ${cam}). Tap Disconnect to stop hosting.`
          : `Relay session live — camera-control TCP to ${ip} (camera ${cam}) is down for this session; retrying about every 10s. (ATEM Software Control can still be connected.)`;
      } else if (atemLanConnectInProgress) {
        statusEl.hidden = false;
        const ip = ipEl?.value.trim() ?? prefs.atemAddress;
        const cam = Number.isFinite(Number(camEl?.value))
          ? clampAtemCameraId(Number(camEl!.value))
          : prefs.atemCameraId;
        statusEl.textContent = `Connecting relay to ATEM at ${ip} (camera ${cam})…`;
      } else {
        statusEl.hidden = true;
        statusEl.textContent = "";
      }
    }
  };
  syncAtemLanConnectUi();

  async function startRelayHosting(
    sessionName: string,
    deviceId: string,
    options?: { atemCcu?: AtemCcuRelayRegister },
  ): Promise<void> {
    const prev = relayHostBridge;
    if (prev) {
      if (prev.isActive) {
        prev.stopSharing();
      } else {
        prev.cleanup();
      }
      relayHostBridge = undefined;
    }
    clearRelayHostPanelSyncDebouncer();
    resetAtemBleMirrorBleQueue();
    const persistCameraId = deviceId;
    const atemOnlyHost = options?.atemCcu && deviceId === ATEM_CCU_RELAY_DEVICE_ID;
    const bleClient = atemOnlyHost ? nullBleCameraClient : rawClient;

    relayHostBridge = new RelayHostSession(bleClient, {
      log,
      prepareBootstrapSnapshot: async () => {
        if (!relayHostBridge?.isActive) return null;
        try {
          await banksApi.saveLastState(persistCameraId, currentScene);
        } catch (e: unknown) {
          log(`Relay bootstrap save failed: ${errorMessage(e)}`);
        }
        return {
          type: "bootstrap_snapshot",
          snapshot: (() => {
            const snap = serializeCameraSnapshotForRelay(state.current);
            snap[RELAY_LOADED_SLOT_KEY] = unifiedLoadedSlotForUi();
            snap[RELAY_SCENE_FILLED_KEY] = [
              ...banks.banks.map((b) => b !== null),
              ...globalScenes.map((b) => b !== null),
            ];
            snap[RELAY_BANKS_REVISION_KEY] = banksRevisionCounter;
            return snap;
          })(),
        };
      },
      onForwardedJoinerCommand: (bytes) => {
        if (relayHostBridge?.isAtemCcuHost) return;
        if (state.applyRelayPanelSyncFromCommandBytes(bytes)) scheduleRelayHostPanelSync();
      },
      onSharedSessionDirty: () => {
        void reloadSceneBanksFromShared(persistCameraId);
      },
      onServerPanelSync: (snap) => {
        logAtemMixerPanelSyncDebug(snap, "atem-host");
        const clean = stripRelayPanelSideKeys(snap);
        if (Object.keys(clean).length > 0) {
          const mirrorClean =
            rawClient.isConnected && relayHostBridge !== undefined && !relayHostBridge.exclusiveAtemRelayHost
              ? changedRelayPanelCleanForBleMirror(state.current as unknown as Record<string, unknown>, clean)
              : {};
          state.relayPanelSyncPatch(clean);
          scheduleRelayHostPanelSync();
          if (
            Object.keys(mirrorClean).length > 0 &&
            blePacketsFromAtemPanelSyncClean(mirrorClean).length > 0
          ) {
            enqueueAtemPanelSyncMirrorBle(mirrorClean);
          }
        }
      },
      onAtemSwitcherTcp: (detail) => {
        if (!detail.connected) {
          log(
            "ATEM CCU: camera-control TCP to the switcher dropped for this relay session — hub retries about every 10s. Other apps (e.g. ATEM Software Control) may still be connected.",
          );
        }
        syncAtemLanConnectUi?.();
      },
      onHostRelaySocketLost: () => {
        relayHostBridge = undefined;
        refreshControls();
        syncAtemLanConnectUi?.();
        if (readAtemLanPersistIntent()) scheduleAtemLanFullReconnect("relay socket closed");
      },
    });
    await relayHostBridge.connect(sessionName, deviceId, options?.atemCcu);
    if (options?.atemCcu) {
      enableAtemMixerDebugDefaults();
      log("ATEM CCU: compact debug trace on — watch for [ccu h] lines in this log.");
    }
    relayHostBridge.pushPanelSync(buildRelayPanelSyncEnvelope());
    syncRelayHubButtons();
    void banksApi.saveLastState(deviceId, currentScene).catch((e: unknown) => {
      log(`Relay share warm persist failed: ${errorMessage(e)}`);
    });
  }

  async function performAtemLanHost(ip: string, cameraId: number): Promise<boolean> {
    const trimmed = ip.trim();
    if (!trimmed) {
      log("Enter the ATEM IP or hostname.");
      return false;
    }
    if (typeof WebSocket === "undefined") {
      log("WebSocket is not available in this browser.");
      return false;
    }

    const banksPersist = atemBanksPersistDeviceId();
    const br = relayHostBridge;

    const hostDeviceId =
      bleLinked && activeDeviceId && activeDeviceId !== ATEM_CCU_RELAY_DEVICE_ID
        ? activeDeviceId
        : ATEM_CCU_RELAY_DEVICE_ID;

    if (br?.isActive && !br.isAtemCcuHost && bleLinked) {
      const sessionName = effectiveAtemRelaySessionName().trim() || "ATEM CCU";
      writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, {
        sessionName,
        share: true,
        atemCcu: true,
        atemAddress: trimmed,
        atemCameraId: cameraId,
      });
      if (activeDeviceId && activeDeviceId !== ATEM_CCU_RELAY_DEVICE_ID) {
        const cp = readRelayPrefs(activeDeviceId) ?? {};
        writeRelayPrefs(activeDeviceId, {
          ...cp,
          sessionName,
          share: true,
          atemCcu: true,
          atemAddress: trimmed,
          atemCameraId: cameraId,
        });
      }
      writeAtemLanPersistIntent(true);
      atemLanResumeInFlight = true;
      syncAtemLanConnectUi?.();
      try {
        br.attachAtemCcu({ address: trimmed, cameraId });
        await loadBanksFor(banksPersist);
        void banksApi
          .saveAtemCcuRelay(banksPersist, { address: trimmed, cameraId, sessionName })
          .catch((err: unknown) => log(`ATEM relay prefs save failed: ${errorMessage(err)}`));
        refreshControls();
        log(
          `ATEM CCU: switcher linked on hosted relay "${sessionName}" (local Bluetooth) → ${trimmed} (camera ${cameraId})`,
        );
        const ok = !!relayHostBridge?.isAtemCcuHost;
        if (ok) {
          enableAtemMixerDebugDefaults();
          log("ATEM CCU: compact debug trace on — watch for [ccu h] lines in this log.");
          clearAtemLanReconnectSchedule();
          atemLanReconnectAttempts = 0;
        }
        return ok;
      } catch (e: unknown) {
        log(`ATEM attach failed: ${errorMessage(e)}`);
        return false;
      } finally {
        atemLanResumeInFlight = false;
        syncAtemLanConnectUi?.();
      }
    }

    forceResetAtemLanRelayConnector();

    const sessionName = relaySessionNameForAtemLanHost(hostDeviceId);

    writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, {
      sessionName,
      share: true,
      atemCcu: true,
      atemAddress: trimmed,
      atemCameraId: cameraId,
    });
    if (hostDeviceId !== ATEM_CCU_RELAY_DEVICE_ID) {
      const cp = readRelayPrefs(hostDeviceId) ?? {};
      writeRelayPrefs(hostDeviceId, {
        ...cp,
        sessionName,
        share: true,
        atemCcu: true,
        atemAddress: trimmed,
        atemCameraId: cameraId,
      });
    }
    writeAtemLanPersistIntent(true);

    atemLanResumeInFlight = true;
    syncAtemLanConnectUi?.();
    try {
      await startRelayHosting(sessionName, hostDeviceId, {
        atemCcu: { address: trimmed, cameraId },
      });
      await loadBanksFor(hostDeviceId);
      void banksApi
        .saveAtemCcuRelay(hostDeviceId, { address: trimmed, cameraId, sessionName })
        .catch((err: unknown) => log(`ATEM relay prefs save failed: ${errorMessage(err)}`));
      refreshControls();
      log(`ATEM CCU: relay session "${sessionName}" → ${trimmed} (camera ${cameraId})`);
      const ok = !!relayHostBridge?.isAtemCcuHost;
      if (ok) {
        clearAtemLanReconnectSchedule();
        atemLanReconnectAttempts = 0;
      }
      return ok;
    } catch (e: unknown) {
      log(`ATEM connect failed: ${errorMessage(e)}`);
      relayHostBridge?.cleanup();
      relayHostBridge = undefined;
      refreshControls();
      return false;
    } finally {
      atemLanResumeInFlight = false;
      syncAtemLanConnectUi?.();
    }
  }

  function scheduleAtemLanFullReconnect(reason: string): void {
    if (!readAtemLanPersistIntent()) return;
    if (typeof WebSocket === "undefined") return;
    if (relayJoinedMode || bleLinked) return;
    if (relayHostBridge?.isAtemCcuHost && relayHostBridge.isActive) return;
    clearAtemLanReconnectSchedule();
    const delay = Math.min(30_000, 1000 * Math.pow(2, Math.min(atemLanReconnectAttempts, 8)));
    atemLanReconnectAttempts++;
    atemLanReconnectTimer = setTimeout(() => {
      atemLanReconnectTimer = undefined;
      void (async () => {
        if (!readAtemLanPersistIntent()) return;
        if (relayJoinedMode || bleLinked) return;
        const p = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
        const addr = p.atemAddress.trim();
        const cam = clampAtemCameraId(p.atemCameraId);
        if (!addr) return;
        log(`ATEM CCU: reconnect (${reason}) → ${addr} (camera ${cam})…`);
        syncAtemLanConnectUi?.();
        const ok = await performAtemLanHost(addr, cam);
        if (!ok && readAtemLanPersistIntent()) scheduleAtemLanFullReconnect("retry");
      })();
    }, delay);
  }

  async function tryAtemCcuAutoReconnect(): Promise<void> {
    if (typeof WebSocket === "undefined") return;
    if (!readAtemLanPersistIntent()) return;
    if (relayHostBridge?.isAtemCcuHost && relayHostBridge.isActive) return;
    if (relayJoinedMode || bleLinked) return;
    const prefs = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
    const addr = prefs.atemAddress.trim();
    const cam = clampAtemCameraId(prefs.atemCameraId);
    if (!addr) return;
    atemLanReconnectAttempts = 0;
    log(`ATEM CCU: restore session → ${addr} (camera ${cam})…`);
    const ok = await performAtemLanHost(addr, cam);
    if (!ok && readAtemLanPersistIntent()) scheduleAtemLanFullReconnect("page-load");
  }

  async function connectAtemFromConnectView(): Promise<void> {
    const ipEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-ip]");
    const camEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-camera]");
    const ip = ipEl?.value.trim() ?? "";
    const prefsCam = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID).atemCameraId;
    const camStr = camEl?.value.trim() ?? "";
    const camRaw = Number(camStr);
    const cameraId =
      camStr !== "" && Number.isFinite(camRaw) ? clampAtemCameraId(camRaw) : prefsCam;
    const ok = await performAtemLanHost(ip, cameraId);
    if (!ok && readAtemLanPersistIntent()) scheduleAtemLanFullReconnect("connect");
  }

  function stopAtemRelayHosting(): void {
    writeAtemLanPersistIntent(false);
    const prefs = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
    writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, {
      sessionName: prefs.sessionName,
      share: prefs.share,
      atemCcu: false,
      atemAddress: prefs.atemAddress,
      atemCameraId: prefs.atemCameraId,
    });
    if (
      bleLinked &&
      relayHostBridge?.isActive &&
      relayHostBridge.isAtemCcuHost &&
      !relayHostBridge.exclusiveAtemRelayHost
    ) {
      relayHostBridge.detachAtemCcu();
      if (activeDeviceId && activeDeviceId !== ATEM_CCU_RELAY_DEVICE_ID) {
        const cp = readRelayPrefs(activeDeviceId);
        if (cp) {
          writeRelayPrefs(activeDeviceId, { ...cp, atemCcu: false });
        }
      }
      refreshControls();
      syncAtemLanConnectUi?.();
      log("ATEM CCU: detached from relay session (Bluetooth share continues)");
      return;
    }
    forceResetAtemLanRelayConnector("ATEM CCU: disconnected — connector reset.");
    refreshControls();
    syncAtemLanConnectUi?.();
  }

  bind(root, "[data-atem-ccu-lan-connect]", "click", () => {
    if (relayHostBridge?.isAtemCcuHost || readAtemLanPersistIntent()) {
      stopAtemRelayHosting();
      return;
    }
    void connectAtemFromConnectView();
  });
  bind(root, "[data-atem-ccu-ip]", "keydown", (ev) => {
    const ke = ev as KeyboardEvent;
    if (ke.key === "Enter") {
      ke.preventDefault();
      void connectAtemFromConnectView();
    }
  });

  bind(root, "[data-atem-ccu-ip]", "change", () => {
    if (relayHostBridge?.isAtemCcuHost) return;
    const ipEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-ip]");
    const camEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-camera]");
    const addr = ipEl?.value.trim() ?? "";
    if (!addr) return;
    const p = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
    const addrPrefs = readRelayPrefs(atemLanPrefsDeviceKey(addr));
    const addrChanged = p.atemAddress.trim().toLowerCase() !== addr.toLowerCase();
    const fromBle =
      bleLinked &&
      activeDeviceId &&
      activeDeviceId !== ATEM_CCU_RELAY_DEVICE_ID &&
      state.current.cameraNumber !== undefined &&
      Number.isFinite(state.current.cameraNumber)
        ? atemCameraIdFromBleBody(state.current.cameraNumber)
        : undefined;
    const camHint =
      fromBle ??
      (addrPrefs?.atemCameraId !== undefined
        ? clampAtemCameraId(addrPrefs.atemCameraId)
        : clampAtemCameraId(
            (addrChanged ? state.current.cameraNumber : p.atemCameraId) ?? p.atemCameraId ?? 1,
          ));
    writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, { ...p, atemAddress: addr, atemCameraId: camHint });
    if (camEl && !relayHostBridge?.isAtemCcuHost) {
      camEl.value = String(camHint);
    }
    syncAtemLanConnectUi?.();
  });

  function persistAtemLanCameraFieldFromInput(): void {
    if (relayHostBridge?.isAtemCcuHost) return;
    const camEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-camera]");
    const ipEl = root.querySelector<HTMLInputElement>("[data-atem-ccu-ip]");
    const camStr = camEl?.value.trim() ?? "";
    if (camStr === "") return;
    const raw = Number(camStr);
    if (!Number.isFinite(raw)) return;
    const cam = clampAtemCameraId(raw);
    const p = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
    const addr = (ipEl?.value.trim() || p.atemAddress).trim() || p.atemAddress;
    writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, { ...p, atemAddress: addr, atemCameraId: cam });
    if (camEl && document.activeElement !== camEl) camEl.value = String(cam);
  }

  bind(root, "[data-atem-ccu-camera]", "change", () => {
    persistAtemLanCameraFieldFromInput();
  });

  async function fullyReconnectAtemLanAfterPageReload(): Promise<void> {
    const prefs = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID);
    const addr = prefs.atemAddress.trim();
    const cam = clampAtemCameraId(prefs.atemCameraId);
    if (!addr) return;
    stopAtemRelayHosting();
    writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, {
      sessionName: (prefs.sessionName || "ATEM CCU").trim().slice(0, 120) || "ATEM CCU",
      share: prefs.share !== false,
      atemCcu: true,
      atemAddress: addr,
      atemCameraId: cam,
    });
    writeAtemLanPersistIntent(true);
    syncAtemLanConnectUi?.();
    atemLanReconnectAttempts = 0;
    log(`ATEM CCU: page reload — reconnecting to ${addr} (camera ${cam})…`);
    const ok = await performAtemLanHost(addr, cam);
    if (!ok && readAtemLanPersistIntent()) scheduleAtemLanFullReconnect("page-load");
  }

  void (async function hydrateAtemCcuFromApiThenReconnect(): Promise<void> {
    if (typeof WebSocket === "undefined") return;
    try {
      const bf = await banksApi.load(ATEM_CCU_RELAY_DEVICE_ID);
      mergeAtemRelayFromServer(bf);
      syncAtemLanConnectUi?.();
    } catch {
      /* Banks API down — use localStorage prefs only */
    }
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
    const isReload = nav?.type === "reload";
    if (isReload && readAtemLanPersistIntent()) {
      const addrProbe = relayPrefsForModal(ATEM_CCU_RELAY_DEVICE_ID).atemAddress.trim();
      if (addrProbe) {
        await fullyReconnectAtemLanAfterPageReload();
        return;
      }
    }
    await tryAtemCcuAutoReconnect();
  })();

  async function presentRelayHostShareModal(
    deviceId: string,
    opts?: { presetAtem?: boolean },
  ): Promise<void> {
    const backdrop = root.querySelector<HTMLElement>("[data-relay-host-modal]");
    const nameInput = root.querySelector<HTMLInputElement>("[data-relay-host-name]");
    const shareInput = root.querySelector<HTMLInputElement>("[data-relay-host-share]");
    const atemCc = root.querySelector<HTMLInputElement>("[data-relay-host-atem-ccu]");
    const atemFields = root.querySelector<HTMLElement>("[data-relay-host-atem-fields]");
    const atemAddr = root.querySelector<HTMLInputElement>("[data-relay-host-atem-address]");
    const atemCam = root.querySelector<HTMLInputElement>("[data-relay-host-atem-camera]");
    if (!backdrop || !nameInput || !shareInput) return;

    const prefs = relayPrefsForModal(deviceId);
    nameInput.value = prefs.sessionName;
    shareInput.checked = prefs.share;
    if (atemCc) atemCc.checked = Boolean(opts?.presetAtem || prefs.atemCcu);
    if (atemAddr) atemAddr.value = prefs.atemAddress;
    if (atemCam) atemCam.value = String(prefs.atemCameraId);

    const syncAtemFields = (): void => {
      if (atemFields && atemCc) atemFields.hidden = !atemCc.checked;
    };
    syncAtemFields();

    const onAtemToggle = (): void => {
      syncAtemFields();
    };
    atemCc?.addEventListener("change", onAtemToggle);

    backdrop.hidden = false;

    await new Promise<void>((resolve) => {
      const confirmBtn = root.querySelector<HTMLButtonElement>("[data-relay-host-confirm]");
      const cancelBtn = root.querySelector<HTMLButtonElement>("[data-relay-host-cancel]");
      const close = (): void => {
        atemCc?.removeEventListener("change", onAtemToggle);
        backdrop.hidden = true;
        confirmBtn?.removeEventListener("click", onOk);
        cancelBtn?.removeEventListener("click", onCancel);
        resolve();
      };
      const onOk = (): void => {
        const name = nameInput.value.trim().slice(0, 120);
        const share = shareInput.checked;
        const useAtem = Boolean(atemCc?.checked);
        const addr = atemAddr?.value.trim() ?? "";
        const camRaw = Number(atemCam?.value);
        const camId = Number.isFinite(camRaw) ? clampAtemCameraId(camRaw) : 1;

        if (share && name && useAtem && !addr) {
          log("ATEM CCU: enter the switcher IP or hostname.");
          return;
        }

        const banksDeviceId = deviceId;
        const prefsPayload: RelayStoredPrefs = {
          sessionName: name,
          share,
          atemCcu: useAtem,
          atemAddress: useAtem ? addr : undefined,
          atemCameraId: useAtem ? camId : undefined,
        };
        if (name) writeRelayPrefs(banksDeviceId, prefsPayload);
        else writeRelayPrefs(banksDeviceId, { sessionName: "", share: false });
        if (useAtem && addr && deviceId !== ATEM_CCU_RELAY_DEVICE_ID) {
          writeRelayPrefs(ATEM_CCU_RELAY_DEVICE_ID, {
            sessionName: name,
            share: true,
            atemCcu: true,
            atemAddress: addr,
            atemCameraId: camId,
          });
        }

        close();
        void (async () => {
          if (share && name) {
            try {
              await startRelayHosting(
                name,
                banksDeviceId,
                useAtem ? { atemCcu: { address: addr, cameraId: camId } } : undefined,
              );
              await loadBanksFor(banksDeviceId);
              if (useAtem && addr) {
                void banksApi
                  .saveAtemCcuRelay(banksDeviceId, { address: addr, cameraId: camId, sessionName: name })
                  .catch((err: unknown) => log(`ATEM relay prefs save failed: ${errorMessage(err)}`));
              }
            } catch (e) {
              log(`Relay share failed: ${errorMessage(e)}`);
            }
          }
        })();
      };
      const onCancel = (): void => {
        const prev = readRelayPrefs(deviceId);
        writeRelayPrefs(deviceId, {
          sessionName: prev?.sessionName ?? "",
          share: false,
          atemCcu: prev?.atemCcu,
          atemAddress: prev?.atemAddress,
          atemCameraId: prev?.atemCameraId,
        });
        close();
      };
      confirmBtn?.addEventListener("click", onOk, { once: true });
      cancelBtn?.addEventListener("click", onCancel, { once: true });
    });
  }

  async function maybeOfferRelayHosting(deviceId: string): Promise<void> {
    const prefs = readRelayPrefs(deviceId);
    if (prefs?.share && prefs.sessionName) {
      try {
        await startRelayHosting(prefs.sessionName, deviceId);
        log(`Relay sharing on (${prefs.sessionName})`);
      } catch (e) {
        log(`Relay share failed: ${errorMessage(e)}`);
      }
      return;
    }
    if (prefs !== undefined) return;

    await presentRelayHostShareModal(deviceId);
  }

  bind(root, "[data-relay-join-toggle]", "click", () => {
    if (bleLinked) {
      log("Disconnect Bluetooth before joining remotely");
      return;
    }
    if (relayJoinedMode) {
      client.disconnect();
      log("Left remote session");
      return;
    }
    if (relayHostBridge?.isActive) {
      log("Stop sharing (Bluetooth or ATEM CCU) before joining remotely");
      return;
    }
    const backdrop = root.querySelector<HTMLElement>("[data-relay-list-modal]");
    if (!backdrop) return;
    backdrop.hidden = false;
    void refreshRelaySessionsDisplay({ soft: false });
  });

  bind(root, "[data-relay-refresh-list]", "click", () => void refreshRelaySessionsDisplay({ soft: false }));
  bind(root, "[data-relay-list-close]", "click", () => {
    const backdrop = root.querySelector<HTMLElement>("[data-relay-list-modal]");
    if (backdrop) backdrop.hidden = true;
  });

  bind(root, "[data-relay-share-toggle]", "click", () => {
    if (relayHostBridge?.isActive) {
      const deviceId = activeDeviceId;
      relayHostBridge?.stopSharing();
      relayHostBridge = undefined;
      clearRelayHostPanelSyncDebouncer();
      resetAtemBleMirrorBleQueue();
      if (deviceId) {
        const prefs = readRelayPrefs(deviceId);
        if (prefs?.sessionName) {
          writeRelayPrefs(deviceId, {
            sessionName: prefs.sessionName,
            share: false,
            atemCcu: prefs.atemCcu,
            atemAddress: prefs.atemAddress,
            atemCameraId: prefs.atemCameraId,
          });
        }
      }
      syncRelayHubButtons();
      log("Relay sharing stopped");
      return;
    }
    if (relayJoinedMode) return;
    if (!bleLinked) {
      const backdrop = root.querySelector<HTMLElement>("[data-relay-share-needs-connection]");
      if (backdrop) backdrop.hidden = false;
      return;
    }
    const deviceId = activeDeviceId;
    if (!deviceId) {
      log("Share: connect and wait for camera id before sharing");
      return;
    }
    void presentRelayHostShareModal(deviceId);
  });

  bind(root, "[data-relay-share-needs-ble-ok]", "click", () => {
    const backdrop = root.querySelector<HTMLElement>("[data-relay-share-needs-connection]");
    if (backdrop) backdrop.hidden = true;
  });

  bind(root, "[data-relay-share-atem-setup]", "click", () => {
    const backdrop = root.querySelector<HTMLElement>("[data-relay-share-needs-connection]");
    if (backdrop) backdrop.hidden = true;
    void presentRelayHostShareModal(ATEM_CCU_RELAY_DEVICE_ID, { presetAtem: true });
  });

  globalThis.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    const main = root.querySelector<HTMLElement>(".panel-app");
    if (main?.dataset.viewActive !== "connect") return;
    const panel = root.querySelector<HTMLElement>("[data-relay-sessions-inline]");
    if (!panel || panel.hidden) return;
    void refreshRelaySessionsDisplay({ soft: true });
  }, 14000);

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const main = root.querySelector<HTMLElement>(".panel-app");
    if (main?.dataset.viewActive !== "connect") return;
    const panel = root.querySelector<HTMLElement>("[data-relay-sessions-inline]");
    if (!panel || panel.hidden) return;
    void refreshRelaySessionsDisplay({ soft: true });
  });

  let prevSnapshot: CameraSnapshot | null = null;
  let prevDirty = false;
  state.subscribe((snapshot) => {
    if (bleLinked && !relayJoinedMode) {
      const n = snapshot.cameraNumber;
      if (
        n !== undefined &&
        Number.isFinite(n) &&
        (prevSnapshot === null || n !== prevSnapshot.cameraNumber)
      ) {
        const nt = Math.trunc(n);
        setOutgoingDestination(nt);
        pushBleBodyCameraIdToAtemMixerFilter(nt);
      }
    }
    updatePanel(root, snapshot, { localBleGattConnected: bleLinked && !relayJoinedMode });
    pulseChangedControls(root, prevSnapshot, snapshot);
    prevSnapshot = snapshot;
    currentScene = buildBankFromSnapshot(snapshot);
    const nowDirty = isDirty();
    if (nowDirty !== prevDirty) {
      prevDirty = nowDirty;
      renderBanks();
    }
    scheduleLastStateSave();
    if (relayHostBridge?.isActive) scheduleRelayHostPanelSync();
  });

  bind(root, "[data-native-ble-found-list]", "click", async (ev) => {
    const tgt = ev.target as HTMLElement | null;
    const btn = tgt?.closest?.<HTMLButtonElement>("button[data-ble-device-id]");
    if (!btn?.dataset.bleDeviceId || bleLinked || relayJoinedMode)
      return;
    if (!(rawClient instanceof NativeBleCameraClient)) return;
    const hint = btn.dataset.bleDeviceLabel?.trim();
    try {
      clearRelayJoinReconnectSchedule();
      lastRelayJoinSessionId = undefined;
      clearRelayJoinRestore();
      setConnection(root, "Connecting…", null);
      const info = await rawClient.connectToScannedDevice(btn.dataset.bleDeviceId!, hint || undefined);
      state.setDeviceName(info.deviceName);
      setConnection(root, "", info.deviceName);
      bleLinked = true;
      refreshControls();
      void loadBanksFor(info.deviceId);
      log(`Connected: ${info.deviceName}`);
      void maybeOfferRelayHosting(info.deviceId);
      viewController.onConnected();
    } catch (error) {
      setConnection(root, "Connection failed", null);
      log(errorMessage(error));
    }
  });

  bind(root, "[data-native-ble-rescan]", "click", () => {
    foundBleDevices.clear();
    renderNativeFoundBleList();
    scheduleNativeBleDiscovery?.();
  });

  bind(root, "[data-connect-toggle]", "click", async () => {
    if (bleLinked || relayJoinedMode) {
      client.disconnect();
      log("Disconnect requested");
      return;
    }
    if (!rawClient.isSupported) {
      if (isIosLikeWebBluetoothBlocked()) showBluefyOfferModal(root);
      else showGenericWebBleHelpModal(root);
      return;
    }
    try {
      clearRelayJoinReconnectSchedule();
      lastRelayJoinSessionId = undefined;
      clearRelayJoinRestore();
      setConnection(root, "Connecting...", null);
      const info = await client.connect();
      state.setDeviceName(info.deviceName);
      setConnection(root, "", info.deviceName);
      bleLinked = true;
      refreshControls();
      void loadBanksFor(info.deviceId);
      log(`Connected: ${info.deviceName}`);
      void maybeOfferRelayHosting(info.deviceId);
      viewController.onConnected();
    } catch (error) {
      setConnection(root, "Connection failed", null);
      log(errorMessage(error));
    }
  });

  bind(root, "[data-last-ble-reconnect]", "click", async () => {
    if (bleLinked || relayJoinedMode) return;
    if (!(rawClient instanceof NativeBleCameraClient)) return;
    const snap = readLastNativeBleSnapshot();
    if (!snap?.peripheralId) return;
    try {
      clearRelayJoinReconnectSchedule();
      lastRelayJoinSessionId = undefined;
      clearRelayJoinRestore();
      setConnection(root, "Connecting…", null);
      const info = await rawClient.connectToScannedDevice(snap.peripheralId, snap.nameHint);
      state.setDeviceName(info.deviceName);
      setConnection(root, "", info.deviceName);
      bleLinked = true;
      refreshControls();
      void loadBanksFor(info.deviceId);
      log(`Connected: ${info.deviceName}`);
      void maybeOfferRelayHosting(info.deviceId);
      viewController.onConnected();
    } catch (error) {
      setConnection(root, "Connection failed", null);
      log(errorMessage(error));
    }
  });

  const autoReconnectInput = root.querySelector<HTMLInputElement>("[data-auto-reconnect]");
  if (autoReconnectInput) {
    autoReconnectInput.checked = client.autoReconnectEnabled;
    autoReconnectInput.addEventListener("change", () => {
      client.setAutoReconnect(autoReconnectInput.checked);
      log(`Auto-reconnect ${autoReconnectInput.checked ? "enabled" : "disabled"}`);
    });
  }

  void (async function restoreRelayJoinOnBoot(): Promise<void> {
    if (typeof WebSocket === "undefined") return;

    const data = readRelayJoinRestore();
    if (
      data?.autoReconnect &&
      data.sessionId &&
      !bleLinked &&
      !relayHostBridge?.isActive &&
      !relayJoinedMode
    ) {
      joinAutoReconnect = true;
      lastRelayJoinSessionId = data.sessionId;
      if (autoReconnectInput) autoReconnectInput.checked = true;
      rawClient.setAutoReconnect(true);
      log(`Relay join: restoring session ${data.sessionId.slice(0, 8)}…`);
      try {
        await finalizeRelayJoin(data.sessionId);
      } catch {
        /* finalizeRelayJoin catches internally */
      }
    }

  })();

  bind(root, "[data-power]", "click", async () => {
    const isOn = state.current.status?.powerOn ?? false;
    const next = !isOn;
    await runAction(log, next ? "Power on" : "Power off", () => client.setPower(next));
  });

  bindCommand(root, log, "[data-autofocus]", "Autofocus", () => commands.autoFocus());
  bindCommand(root, log, "[data-auto-aperture]", "Auto iris", () => commands.autoAperture());
  bindCommand(root, log, "[data-still-capture]", "Still capture", () => commands.stillCapture());
  bind(root, "[data-color-reset]", "click", async () => {
    state.resetColor();
    await sendCommand(log, "Color reset", commands.colorReset());
  });
  bindColorBars(root, state, (packet, label) => sendCommand(log, label, packet));
  bindProgramReturnFeed(root, state, (packet, label) => sendCommand(log, label, packet));
  bindCall(root, state, (packet, label) => sendCommand(log, label, packet));

  const advBtn = root.querySelector<HTMLButtonElement>("[data-color-adv]");
  const colorCard = root.querySelector<HTMLElement>("[data-color-card]");
  if (advBtn && colorCard) {
    advBtn.addEventListener("click", () => {
      const open = colorCard.hasAttribute("hidden");
      if (open) {
        colorCard.removeAttribute("hidden");
        advBtn.classList.add("active");
        advBtn.setAttribute("aria-pressed", "true");
        colorCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
        requestAnimationFrame(() =>
          updatePanel(root, state.current, { localBleGattConnected: bleLinked && !relayJoinedMode }),
        );
      } else {
        colorCard.setAttribute("hidden", "");
        advBtn.classList.remove("active");
        advBtn.setAttribute("aria-pressed", "false");
      }
    });
  }

  bindHFader(root, "focus", "Focus", (packet, label) => sendCommand(log, label, packet), (value) => commands.focus(value), () => state.current.lens.focus ?? 0.5);
  bindHFader(
    root,
    "zoom",
    "Zoom",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.zoomNormalised(value),
    () => state.current.lens.zoom ?? 0.5,
  );
  bindFocusActiveToggle(root, log);
  bindMasterBlackKnob(root, state, log, (packet, label) => sendCommand(log, label, packet));
  bindIrisJoystick(root, state, log, (packet, label) => sendCommand(log, label, packet));

  bindPaintKnobs(root, state, log, (packet, label) => sendCommand(log, label, packet));
  bindColorVerticalFaders(root, state, (packet, label) => sendCommand(log, label, packet));

  bindHorizontalFader(root, "contrast-pivot", "Contrast pivot",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.contrast(value, state.current.color.contrast?.adjust ?? 1),
    () => state.current.color.contrast?.pivot ?? 0.5,
    (value) => state.applyColorWrite({ contrast: { pivot: value, adjust: state.current.color.contrast?.adjust ?? 1 } }));
  bindHorizontalFader(root, "contrast-adjust", "Contrast adjust",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.contrast(state.current.color.contrast?.pivot ?? 0.5, value),
    () => state.current.color.contrast?.adjust ?? 1,
    (value) => state.applyColorWrite({ contrast: { pivot: state.current.color.contrast?.pivot ?? 0.5, adjust: value } }));
  bindHorizontalFader(root, "luma-mix", "Luma mix",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.lumaMix(value),
    () => state.current.color.lumaMix ?? 1,
    (value) => state.applyColorWrite({ lumaMix: value }));
  bindHorizontalFader(root, "hue", "Hue",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.colorAdjust(value, state.current.color.saturation ?? 1),
    () => state.current.color.hue ?? 0,
    (value) => state.applyColorWrite({ hue: value }));
  bindHorizontalFader(root, "saturation", "Saturation",
    (packet, label) => sendCommand(log, label, packet),
    (value) => commands.colorAdjust(state.current.color.hue ?? 0, value),
    () => state.current.color.saturation ?? 1,
    (value) => state.applyColorWrite({ saturation: value }));

  bind(root, "[data-color-reset-card]", "click", async () => {
    state.resetColor();
    await sendCommand(log, "Color reset", commands.colorReset());
  });

  bind(root, "[data-auto-exp]", "click", async () => {
    const current = state.current.autoExposureMode ?? 0;
    const nextMode = (current + 1) % 5;
    const modeNames = ["Manual", "Iris", "Shutter", "Iris+Shutter", "Shutter+Iris"];
    const label = nextMode === 0
      ? "Auto Exp off (Manual)"
      : `Auto Exp ${modeNames[nextMode]}`;
    await sendCommand(log, label, commands.autoExposureMode(nextMode));
  });

  bindStepper(root, "gain", async (direction) => {
    const next = stepMasterGainDb(state.current.gainDb ?? 0, direction, state.current.deviceName);
    state.applyGainDbWrite(next);
    await sendCommand(log, `Gain ${next > 0 ? "+" : ""}${next}dB`, commands.gain(next));
  });

  bindStepper(root, "iso", async (direction) => {
    const next = stepIso(state.current.iso ?? 400, direction);
    state.applyIsoWrite(next);
    await sendCommand(log, `ISO ${next}`, commands.iso(next));
  });

  bindStepper(root, "shutter", async (direction) => {
    const currentDegrees = currentShutterDegrees(state.current.shutterAngle);
    const next = stepShutterAngle(currentDegrees, direction);
    await sendCommand(log, `Shutter angle ${next.toFixed(1)}°`, commands.shutterAngle(next));
  });

  bindStepper(root, "wb", async (direction) => {
    const current = state.current.whiteBalance ?? { temperature: 5600, tint: 0 };
    const next = stepWhiteBalance(current.temperature, direction);
    state.setAutoWhiteBalanceActive(false);
    await sendCommand(log, `White balance ${next}K`, commands.whiteBalance(next, current.tint));
  });

  bindStepper(root, "tint", async (direction) => {
    const current = state.current.whiteBalance ?? { temperature: 5600, tint: 0 };
    const next = stepTint(current.tint, direction);
    state.setAutoWhiteBalanceActive(false);
    await sendCommand(log, `Tint ${next > 0 ? "+" : ""}${next}`, commands.whiteBalance(current.temperature, next));
  });

  bindStepper(root, "nd", async (direction) => {
    const next = stepNdUrsa(state.current.ndFilterStops, direction);
    if (isUrsaCameraName(state.current.deviceName)) {
      state.applyNdFilterStopsWrite(next);
      log(`ND ${formatNd(next)} (manual on camera — not sent over Bluetooth)`);
      if (relayHostBridge?.isActive) scheduleRelayHostPanelSync();
      return;
    }
    const mode = state.current.ndFilterDisplayMode ?? 0;
    await sendCommand(log, `ND ${formatNd(next)}`, commands.ndFilterStops(next, mode));
  });

  bind(root, "[data-panel-active]", "click", () => {
    panelActive = !panelActive;
    refreshControls();
    log(`Panel ${panelActive ? "active" : "inactive"} (readouts still live)`);
  });

  bindVideoCard(root, state, log, (packet, label) => sendCommand(log, label, packet));

  const sendPotPacket = (packet: Uint8Array, label: string): Promise<void> => sendCommand(log, label, packet);

  bindMiniFader(root, "audio-left", "Audio L gain", sendPotPacket, (value) => {
    const right = state.current.audio.inputLevels?.right ?? 0.5;
    state.applyAudioWrite({ inputLevels: { left: value, right } });
    return commands.audioInputLevels(value, right);
  }, () => state.current.audio.inputLevels?.left ?? 0.5);

  bindMiniFader(root, "audio-right", "Audio R gain", sendPotPacket, (value) => {
    const left = state.current.audio.inputLevels?.left ?? 0.5;
    state.applyAudioWrite({ inputLevels: { left, right: value } });
    return commands.audioInputLevels(left, value);
  }, () => state.current.audio.inputLevels?.right ?? 0.5);

  bindMiniFader(root, "audio-speaker", "Speaker", sendPotPacket, (value) => {
    state.applyAudioWrite({ speakerLevel: value });
    return commands.speakerLevel(value);
  }, () => state.current.audio.speakerLevel ?? 0.5);

  bindMiniFader(root, "audio-mic", "Mic", sendPotPacket, (value) => {
    state.applyAudioWrite({ micLevel: value });
    return commands.micLevel(value);
  }, () => state.current.audio.micLevel ?? 0.5);

  bindMiniFader(root, "audio-headphone", "Headphone", sendPotPacket, (value) => {
    state.applyAudioWrite({ headphoneLevel: value });
    return commands.headphoneLevel(value);
  }, () => state.current.audio.headphoneLevel ?? 0.5);

  bindMiniFader(root, "audio-program-mix", "HP mix", sendPotPacket, (value) => {
    state.applyAudioWrite({ headphoneProgramMix: value });
    return commands.headphoneProgramMix(value);
  }, () => state.current.audio.headphoneProgramMix ?? 0.5);

  bind(root, "[data-audio-reset]", "click", async () => {
    const DEFAULT_LEVEL = 0.5;
    state.applyAudioWrite({
      inputLevels: { left: DEFAULT_LEVEL, right: DEFAULT_LEVEL },
      micLevel: DEFAULT_LEVEL,
      headphoneLevel: DEFAULT_LEVEL,
      headphoneProgramMix: DEFAULT_LEVEL,
      speakerLevel: DEFAULT_LEVEL,
    });
    await sendCommand(log, "Audio reset: input L/R", commands.audioInputLevels(DEFAULT_LEVEL, DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: mic", commands.micLevel(DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: headphone", commands.headphoneLevel(DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: HP mix", commands.headphoneProgramMix(DEFAULT_LEVEL));
    await sendCommand(log, "Audio reset: speaker", commands.speakerLevel(DEFAULT_LEVEL));
  });

  bind(root, "[data-audio-input-type]", "change", async (event) => {
    const select = event.target as HTMLSelectElement;
    const value = Number(select.value);
    const labels = ["Internal mic", "Line", "Low mic", "High mic"];
    state.applyAudioWrite({ inputType: value });
    await sendCommand(log, `Audio input: ${labels[value] ?? value}`, commands.audioInputType(value));
  });


  root.querySelectorAll<HTMLButtonElement>("[data-camera-led]").forEach((button) => {
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.cameraId ?? "1");
      state.setCameraNumber(id);
      state.applyMetadataWrite({ cameraId: String(id) });
      await sendCommand(log, `Camera ${id} (dest + slate ID)`, commands.metadataCameraId(String(id)));
      if (relayHostBridge?.isActive) scheduleRelayHostPanelSync();
    });
  });

  bind(root, "[data-clear-log]", "click", () => {
    root.querySelector<HTMLUListElement>("[data-log]")?.replaceChildren();
  });

  const atemPanelSyncDebugInput = root.querySelector<HTMLInputElement>("[data-debug-atem-sync]");
  if (atemPanelSyncDebugInput) {
    syncAtemCompactTraceCheckboxFromStorage();
    atemPanelSyncDebugInput.addEventListener("change", () => {
      try {
        if (atemPanelSyncDebugInput.checked) localStorage.setItem(ATEM_PANEL_SYNC_DEBUG_LS, "1");
        else localStorage.setItem(ATEM_PANEL_SYNC_DEBUG_LS, "0");
      } catch {
        /* ignore */
      }
      log(`ATEM CCU compact trace ${atemPanelSyncDebugInput.checked ? "on" : "off"}`);
    });
  }

  const atemCcuJsonDebugInput = root.querySelector<HTMLInputElement>("[data-debug-atem-ccu-json]");
  if (atemCcuJsonDebugInput) {
    try {
      atemCcuJsonDebugInput.checked = localStorage.getItem(ATEM_CCU_TRACE_JSON_LS) === "1";
    } catch {
      atemCcuJsonDebugInput.checked = false;
    }
    atemCcuJsonDebugInput.addEventListener("change", () => {
      try {
        if (atemCcuJsonDebugInput.checked) localStorage.setItem(ATEM_CCU_TRACE_JSON_LS, "1");
        else localStorage.removeItem(ATEM_CCU_TRACE_JSON_LS);
      } catch {
        /* ignore */
      }
      log(`ATEM CCU full JSON ${atemCcuJsonDebugInput.checked ? "on" : "off"}`);
    });
  }

  const relayLocalhostDebugInput = root.querySelector<HTMLInputElement>("[data-debug-relay-localhost]");
  if (relayLocalhostDebugInput) {
    try {
      relayLocalhostDebugInput.checked = localStorage.getItem(DEBUG_RELAY_HUB_LOCALHOST_LS) === "1";
    } catch {
      relayLocalhostDebugInput.checked = false;
    }
    relayLocalhostDebugInput.addEventListener("change", () => {
      try {
        if (relayLocalhostDebugInput.checked) localStorage.setItem(DEBUG_RELAY_HUB_LOCALHOST_LS, "1");
        else localStorage.removeItem(DEBUG_RELAY_HUB_LOCALHOST_LS);
      } catch {
        /* ignore */
      }
      log(
        `Relay hub override (localhost:5173) ${relayLocalhostDebugInput.checked ? "on" : "off"} — next Join/Share uses ${getRelaySocketUrl()}`,
      );
    });
  }

  bind(root, "[data-scene-store]", "click", () => {
    if (!activeDeviceId) {
      log("Connect a camera before storing a scene");
      return;
    }
    setStoreArmed(!storeArmed);
    log(storeArmed ? "STORE armed - tap a bank to save" : "STORE cancelled");
  });

  root.querySelectorAll<HTMLButtonElement>("[data-scene-bank]").forEach((button) => {
    button.addEventListener("click", async () => {
      const slot = Number(button.dataset.bankSlot ?? "0");
      if (Number.isNaN(slot) || slot < 0 || slot >= SCENE_SLOT_COUNT) return;

      const isGlobal = slot >= BANK_COUNT;
      const localSlot = isGlobal ? -1 : slot;
      const globalIdx = isGlobal ? slot - BANK_COUNT : -1;

      if (storeArmed) {
        if (!activeDeviceId) return;
        const bank = buildBankFromSnapshot(state.current);
        try {
          if (isGlobal) {
            const res = await banksApi.saveGlobalScene(activeDeviceId, globalIdx, bank);
            banks = res.camera.globalLoadedSlot === undefined ? { ...res.camera, globalLoadedSlot: null } : res.camera;
            globalScenes = normalizeGlobalBanks(res.globalBanks);
          } else {
            banks = await banksApi.saveBank(activeDeviceId, localSlot, bank);
            if (banks.globalLoadedSlot === undefined) banks = { ...banks, globalLoadedSlot: null };
          }
          setStoreArmed(false);
          loadedBankSnapshot = bank;
          prevDirty = false;
          renderBanks();
          log(
            isGlobal
              ? `Stored current settings to global ${globalIdx + 1}`
              : `Stored current settings to bank ${localSlot + 1}`,
          );
          notifyJoinersBanksChanged();
          if (relayJoinedMode) relayJoinTransport().notifySharedSessionDirty();
        } catch (error) {
          log(`${isGlobal ? "Global scene" : "Bank"} store failed: ${errorMessage(error)}`);
        }
        return;
      }

      const bank = isGlobal ? globalScenes[globalIdx] : banks.banks[localSlot];
      if (!bank) {
        const emptyLabel = isGlobal ? `G${globalIdx + 1}` : `Bank ${localSlot + 1}`;
        log(`${emptyLabel} is empty`);
        return;
      }

      try {
        await applyBankToCamera(client, bank, {
          skipNdBle: isUrsaCameraName(state.current.deviceName),
        });
        if (activeDeviceId) {
          banks = isGlobal
            ? await banksApi.setLoadedScene(activeDeviceId, { globalLoadedSlot: globalIdx })
            : await banksApi.setLoadedScene(activeDeviceId, { slot: localSlot });
          if (banks.globalLoadedSlot === undefined) banks = { ...banks, globalLoadedSlot: null };
        } else {
          banks = isGlobal
            ? { ...banks, loadedSlot: null, globalLoadedSlot: globalIdx }
            : { ...banks, loadedSlot: localSlot, globalLoadedSlot: null };
        }
        loadedBankSnapshot = bank;
        prevDirty = false;
        renderBanks();
        log(isGlobal ? `Loaded global ${globalIdx + 1}` : `Loaded bank ${localSlot + 1}`);
        notifyJoinersBanksChanged();
        if (relayJoinedMode) relayJoinTransport().notifySharedSessionDirty();
      } catch (error) {
        log(`${isGlobal ? "Global scene" : "Bank"} load failed: ${errorMessage(error)}`);
      }
    });
  });

  if (client.tryRestoreConnection) {
    setConnection(root, "Looking for previously paired camera…", null);
    void client
      .tryRestoreConnection()
      .then((info) => {
        if (info) {
          state.setDeviceName(info.deviceName);
          setConnection(root, "", info.deviceName);
          bleLinked = true;
          refreshControls();
          void (async () => {
            await loadBanksFor(info.deviceId);
            void maybeOfferRelayHosting(info.deviceId);
            log(`Restored connection: ${info.deviceName}`);
          })();
        } else {
          setConnection(root, "Disconnected", null);
        }
      })
      .catch((error) => {
        setConnection(root, "Disconnected", null);
        log(`Restore on reload failed: ${errorMessage(error)}`);
      });
  }

  async function sendCommand(
    logger: (message: string) => void,
    label: string,
    packet: Uint8Array,
  ): Promise<void> {
    const ok = await runAction(logger, label, () => client.writeCommand(packet), packet);
    if (ok && relayHostBridge?.isActive) scheduleRelayHostPanelSync();
  }

  bind(root, "[data-record-start]", "click", async () => {
    if (!state.current.recording) {
      state.setRecording(true);
      await sendCommand(log, "Record start", commands.recordStart());
      return;
    }
    const backdrop = root.querySelector<HTMLElement>("[data-record-stop-confirm-modal]");
    if (backdrop) backdrop.hidden = false;
  });

  bind(root, "[data-record-stop]", "click", async () => {
    state.setRecording(false);
    await sendCommand(log, "Record stop", commands.recordStop());
  });

  const closeRecordStopConfirmModal = (): void => {
    const backdrop = root.querySelector<HTMLElement>("[data-record-stop-confirm-modal]");
    if (backdrop) backdrop.hidden = true;
  };

  bind(root, "[data-record-stop-cancel]", "click", closeRecordStopConfirmModal);
  bind(root, "[data-record-stop-confirm]", "click", async () => {
    closeRecordStopConfirmModal();
    state.setRecording(false);
    await sendCommand(log, "Record stop", commands.recordStop());
  });

  bind(root, "[data-record-stop-confirm-modal]", "click", (ev) => {
    if (ev.target === ev.currentTarget) closeRecordStopConfirmModal();
  });

  function bindCommand(
    scope: HTMLElement,
    logger: (message: string) => void,
    selector: string,
    label: string,
    createPacket: () => Uint8Array,
  ): void {
    bind(scope, selector, "click", async () => {
      const packet = createPacket();
      await runAction(logger, label, () => client.writeCommand(packet), packet);
    });
  }

}

// ─────────────────────────────────────────────────────────────────────────────
// Exported panel binding helpers (`createApp` stays above; bindings are testable modules)
// ─────────────────────────────────────────────────────────────────────────────

function bindMasterBlackKnob(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const knob = root.querySelector<HTMLElement>("[data-iris-wheel]");
  if (!knob) return;

  const SENSITIVITY_DEG_PER_FULL_RANGE = 270;
  const minSendIntervalMs = 80;

  let dragging = false;
  let pointerId: number | null = null;
  let startAngle = 0;
  let startNorm = 0.5;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    state.applyColorWrite({ lift: { ...state.current.color.lift, luma: value } });
    void send(commands.masterBlack(value), `Master black ${value >= 0 ? "+" : ""}${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();

    const rect = knob.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const angle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    let delta = angle - startAngle;
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;

    const nextNorm = Math.max(0, Math.min(1, startNorm + delta / SENSITIVITY_DEG_PER_FULL_RANGE));
    const nextValue = normalisedToMasterBlack(nextNorm);
    pendingValue = Math.max(MASTER_BLACK_RANGE.min, Math.min(MASTER_BLACK_RANGE.max, Number(nextValue.toFixed(2))));

    const angleDeg = masterBlackToNormalised(pendingValue) * 270 - 135;
    knob.style.setProperty("--angle", `${angleDeg}deg`);

    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    knob.releasePointerCapture(event.pointerId);
    flush(true);
    log("Master black knob released");
  };

  knob.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    knob.setPointerCapture(event.pointerId);

    const rect = knob.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    startAngle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
    startNorm = masterBlackToNormalised(state.current.color.lift.luma ?? 0);
  });

  knob.addEventListener("pointermove", onPointerMove);
  knob.addEventListener("pointerup", stopDrag);
  knob.addEventListener("pointercancel", stopDrag);
  knob.style.touchAction = "none";
  knob.style.cursor = "grab";
}

const FOCUS_ACTIVE_STORAGE_KEY = "bm-iris-focus-active";

function bindFocusActiveToggle(root: HTMLElement, log: (message: string) => void): void {
  const cell = root.querySelector<HTMLElement>("[data-iris-focus-cell]");
  const toggle = root.querySelector<HTMLButtonElement>("[data-iris-focus-toggle]");
  if (!cell || !toggle) return;

  let active = false;
  try {
    if (typeof localStorage !== "undefined") {
      active = localStorage.getItem(FOCUS_ACTIVE_STORAGE_KEY) === "1";
    }
  } catch {
    /* ignore storage errors */
  }

  const apply = (next: boolean, fromUser: boolean): void => {
    active = next;
    cell.dataset.active = active ? "true" : "false";
    toggle.setAttribute("aria-pressed", active ? "true" : "false");
    toggle.classList.toggle("is-active", active);
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(FOCUS_ACTIVE_STORAGE_KEY, active ? "1" : "0");
      }
    } catch {
      /* ignore storage errors */
    }
    if (fromUser) {
      log(`Focus control ${active ? "activated" : "deactivated"}`);
    }
  };

  apply(active, false);

  toggle.addEventListener("click", () => apply(!active, true));
}

function bindIrisJoystick(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const joystick = root.querySelector<HTMLElement>("[data-iris-joystick]");
  const handle = root.querySelector<HTMLElement>("[data-iris-joystick-handle]");
  if (!joystick || !handle) return;

  const minSendIntervalMs = BLE_POINTER_DRAG_SEND_INTERVAL_MS;
  const verticalRangePx = (): number => irisTbarDragRangePx(joystick, handle);

  let dragging = false;
  let pointerId: number | null = null;
  let startClientY = 0;
  let startIris = 0.5;

  let pendingIris: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingIris === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    lastSent = now;
    const value = pendingIris;
    pendingIris = null;
    void send(commands.iris(value), `Iris joystick ${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();

    const dy = event.clientY - startClientY;
    const vRange = verticalRangePx() || 1;
    const nextIris = Math.max(0, Math.min(1, startIris + dy / vRange));
    pendingIris = Number(nextIris.toFixed(3));

    positionIrisHandle(joystick, handle, pendingIris);
    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    joystick.classList.remove("dragging");
    delete joystick.dataset.dragging;
    joystick.releasePointerCapture(event.pointerId);
    flush(true);
  };

  joystick.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    joystick.setPointerCapture(event.pointerId);
    joystick.classList.add("dragging");
    joystick.dataset.dragging = "true";

    startClientY = event.clientY;
    startIris = state.current.lens.apertureNormalised ?? 0.5;
  });

  joystick.addEventListener("pointermove", onPointerMove);
  joystick.addEventListener("pointerup", stopDrag);
  joystick.addEventListener("pointercancel", stopDrag);

  void log;
}

function bindColorBars(
  root: HTMLElement,
  state: CameraState,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const buttons = root.querySelectorAll<HTMLButtonElement>("[data-color-bars]");
  if (buttons.length === 0) return;

  const HOLD_MS = 1000;

  const isBarsOn = (): boolean => state.current.unitOutputs?.colorBars === true;

  buttons.forEach((button) => {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdPointerId: number | null = null;

    const setArming = (on: boolean): void => {
      button.classList.toggle("arming", on);
    };

    const cancelHold = (): void => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      holdPointerId = null;
      setArming(false);
    };

    const onPointerDown = (event: PointerEvent): void => {
      event.preventDefault();
      if (button.disabled) return;

      if (isBarsOn()) {
        try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        state.applyUnitOutputsWrite({ colorBars: false });
        void send(commands.colorBars(0), "Color bars off");
        return;
      }

      try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      holdPointerId = event.pointerId;
      setArming(true);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        setArming(false);
        holdPointerId = null;
        state.applyUnitOutputsWrite({ colorBars: true });
        void send(commands.colorBars(30), "Color bars on (held 1s)");
      }, HOLD_MS);
    };

    const onPointerEnd = (event: PointerEvent): void => {
      if (holdPointerId !== null && event.pointerId === holdPointerId) {
        cancelHold();
      }
      try { button.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    };

    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("pointerup", onPointerEnd);
    button.addEventListener("pointercancel", onPointerEnd);
    button.addEventListener("pointerleave", (event) => {
      if (holdPointerId !== null && event.pointerId === holdPointerId) {
        cancelHold();
      }
    });
    button.style.touchAction = "none";
  });
}

function bindProgramReturnFeed(
  root: HTMLElement,
  state: CameraState,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const buttons = root.querySelectorAll<HTMLButtonElement>("[data-program-return-feed]");
  if (buttons.length === 0) return;

  const HOLD_MS = 3000;

  const isReturnOn = (): boolean => state.current.unitOutputs?.programReturnFeed === true;

  buttons.forEach((button) => {
    let holdTimer: ReturnType<typeof setTimeout> | null = null;
    let holdPointerId: number | null = null;

    const setArming = (on: boolean): void => {
      button.classList.toggle("arming", on);
    };

    const cancelHold = (): void => {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
      holdPointerId = null;
      setArming(false);
    };

    const onPointerDown = (event: PointerEvent): void => {
      event.preventDefault();
      if (button.disabled) return;

      if (isReturnOn()) {
        try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
        state.applyUnitOutputsWrite({ programReturnFeed: false });
        void send(commands.programReturnFeed(0), "Program return feed off");
        return;
      }

      try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
      holdPointerId = event.pointerId;
      setArming(true);
      holdTimer = setTimeout(() => {
        holdTimer = null;
        setArming(false);
        holdPointerId = null;
        state.applyUnitOutputsWrite({ programReturnFeed: true });
        void send(commands.programReturnFeed(30), "Program return feed on (held 3s)");
      }, HOLD_MS);
    };

    const onPointerEnd = (event: PointerEvent): void => {
      if (holdPointerId !== null && event.pointerId === holdPointerId) {
        cancelHold();
      }
      try { button.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    };

    button.addEventListener("pointerdown", onPointerDown);
    button.addEventListener("pointerup", onPointerEnd);
    button.addEventListener("pointercancel", onPointerEnd);
    button.addEventListener("pointerleave", (event) => {
      if (holdPointerId !== null && event.pointerId === holdPointerId) {
        cancelHold();
      }
    });
    button.style.touchAction = "none";
  });
}

/**
 * CALL: Blackmagic broadcast panels use this to flash the camera's tally LEDs
 * to get the operator's attention. The protocol has no dedicated "call"
 * parameter, so we briefly drive all tally brightness channels to full and
 * restore the previous values on release.
 */
function bindCall(
  root: HTMLElement,
  state: CameraState,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const button = root.querySelector<HTMLButtonElement>("[data-call]");
  if (!button) return;

  const FLASH_MS = 2000;

  let activePointerId: number | null = null;
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let saved: { master: number; front: number; rear: number } | null = null;

  const setActive = (on: boolean): void => {
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  };

  const flashOn = (): void => {
    const t = state.current.tally?.brightness;
    saved = {
      master: t?.master ?? 1,
      front: t?.front ?? 0,
      rear: t?.rear ?? 0,
    };
    setActive(true);
    void send(commands.tallyBrightness(1), "Call (tally on)");
    void send(commands.frontTallyBrightness(1), "Call (front tally on)");
    void send(commands.rearTallyBrightness(1), "Call (rear tally on)");
  };

  const flashOff = (): void => {
    setActive(false);
    if (!saved) return;
    const restore = saved;
    saved = null;
    void send(commands.tallyBrightness(restore.master), "Call release (tally restore)");
    void send(commands.frontTallyBrightness(restore.front), "Call release (front tally restore)");
    void send(commands.rearTallyBrightness(restore.rear), "Call release (rear tally restore)");
  };

  const clearReleaseTimer = (): void => {
    if (releaseTimer !== null) {
      clearTimeout(releaseTimer);
      releaseTimer = null;
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    event.preventDefault();
    if (button.disabled) return;
    if (activePointerId !== null) return;

    activePointerId = event.pointerId;
    try { button.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    clearReleaseTimer();
    flashOn();
    releaseTimer = setTimeout(() => {
      releaseTimer = null;
      if (activePointerId === null) flashOff();
    }, FLASH_MS);
  };

  const onPointerEnd = (event: PointerEvent): void => {
    if (activePointerId === null || event.pointerId !== activePointerId) return;
    activePointerId = null;
    try { button.releasePointerCapture(event.pointerId); } catch { /* ignore */ }
    if (releaseTimer === null) flashOff();
  };

  button.addEventListener("pointerdown", onPointerDown);
  button.addEventListener("pointerup", onPointerEnd);
  button.addEventListener("pointercancel", onPointerEnd);
  button.style.touchAction = "none";
}

/**
 * The Blackmagic protocol exposes auto WB only as one-shot triggers
 * (set / restore), not as a persistent mode the camera reports back.
 * The chassis "W/B" LED follows {@link CameraSnapshot.autoWhiteBalanceActive}
 * so relay joiners stay aligned with the host.
 */
function bindAutoWhiteBalanceToggle(
  root: HTMLElement,
  state: CameraState,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-video-set-auto-wb]"),
  );
  if (buttons.length === 0) return;

  buttons.forEach((button) => {
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", async () => {
      const isActive = button.classList.contains("active");
      if (isActive) {
        state.setAutoWhiteBalanceActive(false);
        await send(commands.restoreAutoWhiteBalance(), "Restore auto WB");
      } else {
        state.setAutoWhiteBalanceActive(true);
        await send(commands.setAutoWhiteBalance(), "Set auto WB");
      }
    });
  });
}

interface ViewController {
  /** Switch to the named view. Persists to localStorage. */
  setView(viewId: ViewId): void;
  /** Currently visible view. */
  getActiveView(): ViewId;
  /** Called when the camera connection succeeds. Auto-advances away from Connect. */
  onConnected(): void;
}

const VIEW_STORAGE_KEY = "bm-active-view";

/**
 * Read the persisted active view, or null if absent/unknown. Some browsers
 * (e.g. private mode) throw on `localStorage` access, so guard everything.
 */
function readPersistedView(): ViewId | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const value = localStorage.getItem(VIEW_STORAGE_KEY);
    return isViewId(value) ? value : null;
  } catch {
    return null;
  }
}

function persistView(viewId: ViewId): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, viewId);
  } catch {
    /* ignore */
  }
}

interface ViewNavOptions {
  onViewChange?: (viewId: ViewId) => void;
}

/**
 * Wire up the bottom-nav tabs and any "shortcut" buttons (e.g. the legacy
 * `[data-video-toggle]` / `[data-audio-toggle]`) to switch views. Returns a
 * controller for use by the rest of the app (e.g. auto-switch on connect).
 */
function bindViewNav(root: HTMLElement, options?: ViewNavOptions): ViewController {
  const initial = readPersistedView() ?? "connect";
  setActiveView(root, initial);

  const switchTo = (viewId: ViewId): void => {
    setActiveView(root, viewId);
    persistView(viewId);
    options?.onViewChange?.(viewId);
  };

  root.querySelectorAll<HTMLButtonElement>("[data-view-switch]").forEach((tab) => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.viewSwitch;
      if (isViewId(target)) switchTo(target);
    });
  });

  // Legacy aliases — map old chassis-footer buttons to view switches so any
  // existing wiring (including tests) continues to work.
  const aliases: Record<string, ViewId> = {
    "[data-video-toggle]": "video",
    "[data-audio-toggle]": "audio",
  };
  for (const [selector, viewId] of Object.entries(aliases)) {
    root.querySelectorAll<HTMLButtonElement>(selector).forEach((button) => {
      button.addEventListener("click", () => switchTo(viewId));
    });
  }

  return {
    setView: switchTo,
    getActiveView: () => {
      const main = root.querySelector<HTMLElement>(".panel-app");
      const value = main?.dataset.viewActive;
      return isViewId(value) ? value : "connect";
    },
    onConnected: () => {
      // If the user is staring at the Connect screen, jump to the most useful
      // operating view. Respect any other view they may have already navigated to.
      const main = root.querySelector<HTMLElement>(".panel-app");
      if (main?.dataset.viewActive === "connect") switchTo("iris");
    },
  };
}

function bindVideoCard(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  bindAutoWhiteBalanceToggle(root, state, send);
  bind(root, "[data-video-restore-auto-wb]", "click", async () => {
    state.setAutoWhiteBalanceActive(false);
    await send(commands.restoreAutoWhiteBalance(), "Restore auto WB");
  });

  const labelDynamic = ["Film", "Video", "Extended Video"];
  bindSegmented(root, "[data-video-dynamic-range]", (value) => {
    void send(commands.dynamicRange(value), `Dynamic range: ${labelDynamic[value] ?? value}`);
  });

  const labelSharp = ["Off", "Low", "Medium", "High"];
  bindSegmented(root, "[data-video-sharpening]", (value) => {
    void send(commands.sharpening(value), `Sharpening: ${labelSharp[value] ?? value}`);
  });

  const lutSelect = root.querySelector<HTMLSelectElement>("[data-video-display-lut]");
  const lutEnabled = root.querySelector<HTMLInputElement>("[data-video-display-lut-enabled]");
  const sendLut = (): void => {
    if (!lutSelect || !lutEnabled) return;
    const sel = Number(lutSelect.value);
    const en = lutEnabled.checked;
    state.applyDisplayLutWrite({ selected: sel, enabled: en });
    void send(commands.displayLut(sel, en), `Display LUT ${["None","Custom","Film→Video","Film→ExtVideo"][sel] ?? sel}${en ? " on" : " off"}`);
  };
  lutSelect?.addEventListener("change", sendLut);
  lutEnabled?.addEventListener("change", sendLut);

  const sendTally = (packet: Uint8Array, label: string): Promise<void> => Promise.resolve(send(packet, label) as void);

  bindMiniFader(root, "tally-master", "Tally master", sendTally, (value) => {
    state.applyTallyBrightnessWrite({ master: value });
    return commands.tallyBrightness(value);
  }, () => state.current.tally?.brightness?.master ?? 1);

  bindMiniFader(root, "tally-front", "Tally front", sendTally, (value) => {
    state.applyTallyBrightnessWrite({ front: value });
    return commands.frontTallyBrightness(value);
  }, () => state.current.tally?.brightness?.front ?? 1);

  bindMiniFader(root, "tally-rear", "Tally rear", sendTally, (value) => {
    state.applyTallyBrightnessWrite({ rear: value });
    return commands.rearTallyBrightness(value);
  }, () => state.current.tally?.brightness?.rear ?? 1);

  const frameRateSelect = root.querySelector<HTMLSelectElement>("[data-video-frame-rate]");
  frameRateSelect?.addEventListener("change", () => {
    const raw = frameRateSelect.value;
    if (!raw) return;
    const fps = Number(raw);
    if (!Number.isFinite(fps) || fps <= 0) return;
    const rf = state.current.recordingFormat;
    const w = rf?.frameWidth ?? 0;
    const h = rf?.frameHeight ?? 0;
    if (!w || !h) {
      log("Project FPS: wait for resolution on FORMAT (Iris tab), then try again.");
      return;
    }
    void send(
      commands.recordingFormat(fps, fps, w, h),
      `Recording format ${w}×${h} @${fps}fps`,
    );
  });

  const offSpeedInput = root.querySelector<HTMLInputElement>("[data-video-off-speed-rate]");
  root.querySelector<HTMLButtonElement>("[data-video-off-speed-apply]")?.addEventListener("click", () => {
    if (!offSpeedInput) return;
    const v = Math.round(Number(offSpeedInput.value));
    if (!Number.isFinite(v) || v < 0) return;
    void send(commands.offSpeedFrameRate(v), `Off-speed frame rate ${v}`);
  });

  void log;
}

function bindSegmented(
  root: HTMLElement,
  groupSelector: string,
  onSelect: (value: number) => void,
): void {
  const group = root.querySelector<HTMLElement>(groupSelector);
  if (!group) return;
  group.querySelectorAll<HTMLButtonElement>(".segmented-option").forEach((opt) => {
    opt.addEventListener("click", () => {
      const value = Number(opt.dataset.value ?? "0");
      group.querySelectorAll<HTMLButtonElement>(".segmented-option").forEach((o) => {
        const active = o === opt;
        o.classList.toggle("active", active);
        o.setAttribute("aria-checked", active ? "true" : "false");
      });
      onSelect(value);
    });
  });
}

function bindPaintKnobs(
  root: HTMLElement,
  state: CameraState,
  log: (message: string) => void,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const groupCommand: Record<PaintGroup, (red: number, green: number, blue: number, luma: number) => Uint8Array> = {
    lift: commands.lift,
    gamma: commands.gamma,
    gain: commands.videoGain,
  };

  const SENSITIVITY_DEG = 270;
  /** Pointer travel (px) for mouse/pen: drag this distance vertically to sweep the full parameter range. */
  const VERTICAL_DRAG_PX_FOR_FULL_SPAN = 180;
  const minSendIntervalMs = BLE_POINTER_DRAG_SEND_INTERVAL_MS;

  root.querySelectorAll<HTMLElement>("[data-paint-cell]").forEach((cell) => {
    const group = cell.dataset.group as PaintGroup | undefined;
    const channel = cell.dataset.channel as PaintChannel | undefined;
    if (!group || !channel) return;

    const knob = cell.querySelector<HTMLElement>("[data-knob]");
    const readout = cell.querySelector<HTMLElement>("[data-paint-value]");
    if (!knob) return;

    const range = PAINT_RANGE[group];
    const span = range.max - range.min;

    let dragging = false;
    let pointerId: number | null = null;
    /** `vertical`: drag up/down (mouse, pen). `angular`: rotate around knob (touch). */
    let dragMode: "vertical" | "angular" = "angular";
    let startAngle = 0;
    let startClientY = 0;
    let startValue = range.default;
    let pendingValue: number | null = null;
    let lastSent = 0;
    let scheduled: number | null = null;

    const sendValue = (value: number): void => {
      const channels = readColorGroup(state, group);
      channels[channel] = value;
      state.applyColorWrite({ [group]: channels } as Partial<CameraSnapshot["color"]>);
      const packet = groupCommand[group](channels.red, channels.green, channels.blue, channels.luma);
      void send(packet, `${groupLabel(group)} ${channel} ${value.toFixed(2)}`);
    };

    const flush = (force: boolean): void => {
      if (pendingValue === null) return;
      const now = performance.now();
      if (!force && now - lastSent < minSendIntervalMs) {
        if (scheduled === null) {
          scheduled = window.setTimeout(() => {
            scheduled = null;
            flush(true);
          }, minSendIntervalMs - (now - lastSent));
        }
        return;
      }
      const value = pendingValue;
      pendingValue = null;
      lastSent = now;
      sendValue(value);
    };

    const updateVisuals = (value: number): void => {
      knob.style.setProperty("--angle", `${paintValueToAngle(group, value)}deg`);
      knob.setAttribute("aria-valuenow", value.toFixed(2));
      if (readout) {
        writePaintSegReadout(readout, value);
      }
    };

    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      event.preventDefault();
      let next: number;
      if (dragMode === "vertical") {
        const deltaY = startClientY - event.clientY;
        next = Math.max(range.min, Math.min(range.max, startValue + (deltaY / VERTICAL_DRAG_PX_FOR_FULL_SPAN) * span));
      } else {
        const rect = knob.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const angle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
        let delta = angle - startAngle;
        if (delta > 180) delta -= 360;
        if (delta < -180) delta += 360;
        next = Math.max(range.min, Math.min(range.max, startValue + (delta / SENSITIVITY_DEG) * span));
      }
      pendingValue = Number(next.toFixed(3));
      updateVisuals(pendingValue);
      flush(false);
    };

    const stopDrag = (event: PointerEvent): void => {
      if (!dragging || pointerId !== event.pointerId) return;
      dragging = false;
      pointerId = null;
      cell.classList.remove("dragging");
      delete cell.dataset.dragging;
      knob.releasePointerCapture(event.pointerId);
      flush(true);
    };

    knob.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      dragging = true;
      pointerId = event.pointerId;
      knob.setPointerCapture(event.pointerId);
      cell.classList.add("dragging");
      cell.dataset.dragging = "true";

      startValue = state.current.color[group][channel];
      const finePointer = event.pointerType === "mouse" || event.pointerType === "pen";
      dragMode = finePointer ? "vertical" : "angular";
      if (dragMode === "vertical") {
        startClientY = event.clientY;
      } else {
        const rect = knob.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        startAngle = (Math.atan2(event.clientY - cy, event.clientX - cx) * 180) / Math.PI;
      }
    });

    knob.addEventListener("pointermove", onPointerMove);
    knob.addEventListener("pointerup", stopDrag);
    knob.addEventListener("pointercancel", stopDrag);
  });

  void log;
}

function bindHFader(
  root: HTMLElement,
  faderAttr: string,
  label: string,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
  buildPacket: (value: number) => Uint8Array,
  readCurrent: () => number,
): void {
  const fader = root.querySelector<HTMLElement>(`[data-h-fader="${faderAttr}"]`);
  const handle = fader?.querySelector<HTMLElement>("[data-h-fader-handle]");
  if (!fader || !handle) return;

  const minSendIntervalMs = BLE_POINTER_DRAG_SEND_INTERVAL_MS;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientX = 0;
  let startValue = 0.5;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    void send(buildPacket(value), `${label} ${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - startClientX;
    const horizontalRange = Math.max(1, fader.getBoundingClientRect().width - handle.offsetWidth);
    const next = Math.max(0, Math.min(1, startValue + dx / horizontalRange));
    pendingValue = Number(next.toFixed(3));

    positionHFaderHandle(fader, handle, pendingValue);
    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };

  fader.addEventListener("pointerdown", (event) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    startClientX = event.clientX;
    const rect = fader.getBoundingClientRect();
    startValue =
      rect.width > 0 ? hfaderValueFromClientX(fader, handle, event.clientX) : Math.max(0, Math.min(1, readCurrent()));
    positionHFaderHandle(fader, handle, startValue);
    pendingValue = startValue;
    flush(true);
  });

  fader.addEventListener("pointermove", onPointerMove);
  fader.addEventListener("pointerup", stopDrag);
  fader.addEventListener("pointercancel", stopDrag);
  fader.style.touchAction = "none";
  fader.style.cursor = "grab";
}

function bindMiniFader(
  root: HTMLElement,
  faderAttr: string,
  label: string,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
  buildPacket: (value: number) => Uint8Array,
  readCurrent: () => number,
): void {
  const fader = root.querySelector<HTMLElement>(`[data-mini-fader="${faderAttr}"]`);
  const handle = fader?.querySelector<HTMLElement>("[data-mini-fader-handle]");
  if (!fader || !handle) return;

  const cell = fader.closest<HTMLElement>(".audio-fader-cell");
  const readout = cell?.querySelector<HTMLElement>("[data-readout]");

  const minSendIntervalMs = BLE_POINTER_DRAG_SEND_INTERVAL_MS;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientY = 0;
  let startValue = 0.5;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    void send(buildPacket(value), `${label} ${value.toFixed(2)}`);
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dy = event.clientY - startClientY;
    const track = fader.querySelector<HTMLElement>(".bm-mfader__track");
    const basis = track && track.clientHeight > 0 ? track : fader;
    const verticalRange = basis.clientHeight - handle.offsetHeight || 1;
    const next = Math.max(0, Math.min(1, startValue - dy / verticalRange));
    pendingValue = Number(next.toFixed(3));

    positionMiniFaderHandle(fader, handle, pendingValue);
    if (readout) readout.textContent = pendingValue.toFixed(2);

    flush(false);
  };

  const stopDrag = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    startClientY = event.clientY;
    startValue = readCurrent();
  });

  fader.addEventListener("pointermove", onPointerMove);
  fader.addEventListener("pointerup", stopDrag);
  fader.addEventListener("pointercancel", stopDrag);
  fader.style.touchAction = "none";
  fader.style.cursor = "grab";

  // Seed the visual position before any snapshot arrives so the thumb sits at
  // its natural rest (0.5 for audio levels, 1.0 for tally brightness) instead
  // of the CSS fallback of 0 which puts every thumb at the very bottom.
  const initial = readCurrent();
  positionMiniFaderHandle(fader, handle, initial);
  if (readout) readout.textContent = initial.toFixed(2);
}


type StepDirection = 1 | -1;

function bindStepper(
  root: HTMLElement,
  id: string,
  handler: (direction: StepDirection) => Promise<void> | void,
): void {
  const upButton = root.querySelector<HTMLButtonElement>(`[data-stepper-up="${id}"]`);
  const downButton = root.querySelector<HTMLButtonElement>(`[data-stepper-down="${id}"]`);

  upButton?.addEventListener("click", () => void handler(1));
  downButton?.addEventListener("click", () => void handler(-1));
}

const ISO_LADDER = [100, 125, 160, 200, 250, 320, 400, 500, 640, 800, 1000, 1250, 1600, 2000, 2500, 3200, 4000, 5000, 6400, 8000, 12800, 25600];

function stepIso(current: number, direction: StepDirection): number {
  const sorted = ISO_LADDER;
  const idx = sorted.findIndex((value) => value >= current);
  const baseIndex = idx === -1 ? sorted.length - 1 : idx;
  const nextIndex = clampNumber(baseIndex + direction, 0, sorted.length - 1);
  return sorted[nextIndex] ?? current;
}

const SHUTTER_LADDER = [11, 15, 22.5, 30, 45, 60, 72, 90, 120, 144, 150, 172.8, 180, 216, 270, 360];

function stepShutterAngle(current: number, direction: StepDirection): number {
  const idx = SHUTTER_LADDER.findIndex((value) => value >= current - 0.1);
  const baseIndex = idx === -1 ? SHUTTER_LADDER.length - 1 : idx;
  const nextIndex = clampNumber(baseIndex + direction, 0, SHUTTER_LADDER.length - 1);
  return SHUTTER_LADDER[nextIndex] ?? current;
}

function stepWhiteBalance(current: number, direction: StepDirection): number {
  const step = 100;
  const next = Math.round((current + step * direction) / step) * step;
  return clampNumber(next, 2500, 10000);
}

function stepTint(current: number, direction: StepDirection): number {
  const step = 5;
  const next = Math.round((current + step * direction) / step) * step;
  return clampNumber(next, -50, 50);
}

function currentShutterDegrees(rawAngle: number | undefined): number {
  if (rawAngle === undefined) return 180;
  return rawAngle / 100;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

const PULSE_TARGETS: Array<{
  selector: string;
  changed: (a: CameraSnapshot, b: CameraSnapshot) => boolean;
}> = [
  { selector: "[data-record]", changed: (a, b) => a.recording !== b.recording },
  { selector: "[data-iris-knob]", changed: (a, b) => a.lens.apertureNormalised !== b.lens.apertureNormalised },
  { selector: '[data-h-fader="focus"]', changed: (a, b) => a.lens.focus !== b.lens.focus },
  { selector: '[data-h-fader="zoom"]', changed: (a, b) => a.lens.zoom !== b.lens.zoom || a.lens.zoomMm !== b.lens.zoomMm },
  { selector: "[data-stepper='wb']", changed: (a, b) => a.whiteBalance?.temperature !== b.whiteBalance?.temperature },
  { selector: "[data-stepper='tint']", changed: (a, b) => a.whiteBalance?.tint !== b.whiteBalance?.tint },
  { selector: "[data-stepper='gain']", changed: (a, b) => a.gainDb !== b.gainDb },
  { selector: "[data-stepper='iso']", changed: (a, b) => a.iso !== b.iso },
  { selector: "[data-stepper='shutter']", changed: (a, b) => a.shutterAngle !== b.shutterAngle },
  {
    selector: "[data-stepper='nd']",
    changed: (a, b) => a.ndFilterStops !== b.ndFilterStops || a.ndFilterDisplayMode !== b.ndFilterDisplayMode,
  },
  { selector: "[data-auto-exp]", changed: (a, b) => a.autoExposureMode !== b.autoExposureMode },
];

function pulseChangedControls(
  root: HTMLElement,
  prev: CameraSnapshot | null,
  next: CameraSnapshot,
): void {
  if (!prev) return;
  for (const target of PULSE_TARGETS) {
    if (!target.changed(prev, next)) continue;
    const el = root.querySelector<HTMLElement>(target.selector);
    if (!el) continue;
    el.classList.remove("pulse");
    void el.offsetWidth;
    el.classList.add("pulse");
    window.setTimeout(() => el.classList.remove("pulse"), 700);
  }
}

function bindColorVerticalFaders(
  root: HTMLElement,
  state: CameraState,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
): void {
  const groupCommand: Record<PaintGroup, (red: number, green: number, blue: number, luma: number) => Uint8Array> = {
    lift: commands.lift,
    gamma: commands.gamma,
    gain: commands.videoGain,
  };

  PAINT_GROUPS.forEach((group) => {
    PAINT_CHANNELS.forEach((channel) => {
      const cell = root.querySelector<HTMLElement>(
        `[data-color-input][data-group="${group}"][data-channel="${channel}"]`,
      );
      const fader = cell?.querySelector<HTMLElement>("[data-vfader]");
      const handle = cell?.querySelector<HTMLElement>("[data-vfader-handle]");
      const readout = cell?.querySelector<HTMLElement>("[data-color-readout]");
      if (!cell || !fader || !handle || !readout) return;

      bindVerticalFader(fader, handle, {
        readCurrent: () => state.current.color[group][channel],
        onChange: (value) => {
          writePaintSegReadout(readout, value);
          fader.setAttribute("aria-valuenow", value.toFixed(2));
        },
        send: (value) => {
          const channels = readColorGroup(state, group);
          channels[channel] = value;
          state.applyColorWrite({ [group]: channels } as Partial<CameraSnapshot["color"]>);
          const packet = groupCommand[group](channels.red, channels.green, channels.blue, channels.luma);
          return send(packet, `${groupLabel(group)} ${channel} ${value.toFixed(2)}`);
        },
      });
    });
  });
}

interface FaderBindingOptions {
  readCurrent: () => number;
  onChange: (value: number) => void;
  send: (value: number) => Promise<void> | void;
}

function bindVerticalFader(
  fader: HTMLElement,
  handle: HTMLElement,
  opts: FaderBindingOptions,
): void {
  const range = readFaderRange(fader);
  const minSendIntervalMs = BLE_POINTER_DRAG_SEND_INTERVAL_MS;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientY = 0;
  let startValue = 0;
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    void opts.send(value);
  };

  positionVerticalFader(fader, handle, opts.readCurrent());

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    fader.dataset.dragging = "true";
    startClientY = event.clientY;
    startValue = opts.readCurrent();
  });

  fader.addEventListener("pointermove", (event) => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dy = event.clientY - startClientY;
    const track = fader.querySelector<HTMLElement>(".bm-mfader__track");
    const basis = track && track.clientHeight > 0 ? track : fader;
    const verticalRange = (basis.clientHeight - handle.offsetHeight) || 1;
    const startNorm = valueToCenteredNorm(startValue, range);
    const nextNorm = Math.max(0, Math.min(1, startNorm - dy / verticalRange));
    const next = centeredNormToValue(nextNorm, range);
    pendingValue = Number(next.toFixed(3));
    positionVerticalFader(fader, handle, pendingValue);
    opts.onChange(pendingValue);
    flush(false);
  });

  const stop = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    delete fader.dataset.dragging;
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };
  fader.addEventListener("pointerup", stop);
  fader.addEventListener("pointercancel", stop);
  fader.style.touchAction = "none";
}

function bindHorizontalFader(
  root: HTMLElement,
  attr: string,
  label: string,
  send: (packet: Uint8Array, label: string) => Promise<void> | void,
  buildPacket: (value: number) => Uint8Array,
  readCurrent: () => number,
  onOptimistic?: (value: number) => void,
): void {
  const fader = root.querySelector<HTMLElement>(`[data-hfader="${attr}"]`);
  const handle = fader?.querySelector<HTMLElement>("[data-hfader-handle]");
  if (!fader || !handle) return;

  const range = readFaderRange(fader);
  const minSendIntervalMs = BLE_POINTER_DRAG_SEND_INTERVAL_MS;

  let dragging = false;
  let pointerId: number | null = null;
  let startClientX = 0;
  let startValue = readCurrent();
  let pendingValue: number | null = null;
  let lastSent = 0;
  let scheduled: number | null = null;

  const flush = (force: boolean): void => {
    if (pendingValue === null) return;
    const now = performance.now();
    if (!force && now - lastSent < minSendIntervalMs) {
      if (scheduled === null) {
        scheduled = window.setTimeout(() => {
          scheduled = null;
          flush(true);
        }, minSendIntervalMs - (now - lastSent));
      }
      return;
    }
    const value = pendingValue;
    pendingValue = null;
    lastSent = now;
    onOptimistic?.(value);
    void send(buildPacket(value), `${label} ${value.toFixed(2)}`);
  };

  positionHorizontalFader(fader, handle, startValue);

  fader.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    dragging = true;
    pointerId = event.pointerId;
    fader.setPointerCapture(event.pointerId);
    fader.classList.add("dragging");
    fader.dataset.dragging = "true";
    startClientX = event.clientX;
    startValue = readCurrent();
  });

  fader.addEventListener("pointermove", (event) => {
    if (!dragging || pointerId !== event.pointerId) return;
    event.preventDefault();
    const dx = event.clientX - startClientX;
    const horizontalRange = (fader.clientWidth - handle.offsetWidth - 16) || 1;
    const startNorm = valueToCenteredNorm(startValue, range);
    const nextNorm = Math.max(0, Math.min(1, startNorm + dx / horizontalRange));
    const next = centeredNormToValue(nextNorm, range);
    pendingValue = Number(next.toFixed(3));
    positionHorizontalFader(fader, handle, pendingValue);
    fader.setAttribute("aria-valuenow", pendingValue.toFixed(2));
    flush(false);
  });

  const stop = (event: PointerEvent): void => {
    if (!dragging || pointerId !== event.pointerId) return;
    dragging = false;
    pointerId = null;
    fader.classList.remove("dragging");
    delete fader.dataset.dragging;
    fader.releasePointerCapture(event.pointerId);
    flush(true);
  };
  fader.addEventListener("pointerup", stop);
  fader.addEventListener("pointercancel", stop);
  fader.style.touchAction = "none";
}

function readColorGroup(
  state: CameraState,
  group: PaintGroup,
): Record<PaintChannel, number> {
  const current = state.current.color[group];
  return { red: current.red, green: current.green, blue: current.blue, luma: current.luma };
}

function groupLabel(group: PaintGroup): string {
  return group.charAt(0).toUpperCase() + group.slice(1);
}

function bind(root: HTMLElement, selector: string, eventName: string, handler: (event: Event) => void): void {
  const elements = root.querySelectorAll<HTMLElement>(selector);
  elements.forEach((element) => element.addEventListener(eventName, handler));
}

async function runAction(
  log: (message: string) => void,
  label: string,
  action: () => Promise<void>,
  packet?: Uint8Array,
): Promise<boolean> {
  const commandLog = packet ? ` (${toHex(packet)})` : "";

  try {
    await action();
    log(`${label}${commandLog}`);
    return true;
  } catch (error) {
    log(`${label} failed: ${errorMessage(error)}`);
    return false;
  }
}

function setConnection(root: HTMLElement, message: string, cameraRawName?: string | null): void {
  const element = root.querySelector<HTMLElement>("[data-connection]");
  if (element) {
    element.textContent = message;
    element.hidden = message.trim().length === 0;
  }
  if (cameraRawName !== undefined) {
    updateAppHeaderCameraProduct(root, cameraRawName ?? undefined);
  }
}

const ALWAYS_ENABLED_SELECTORS = [
  "[data-panel-active]",
  "[data-connect-toggle]",
  "[data-atem-ccu-lan-connect]",
  "[data-last-ble-reconnect]",
  "[data-clear-log]",
  "[data-relay-join-toggle]",
  "[data-relay-share-toggle]",
  "[data-relay-share-needs-ble-ok]",
  "[data-relay-refresh-list]",
  "[data-relay-list-close]",
  "[data-relay-host-confirm]",
  "[data-relay-host-cancel]",
  "[data-record-stop-cancel]",
  "[data-record-stop-confirm]",
];

function setControlsEnabled(root: HTMLElement, enabled: boolean): void {
  root.querySelectorAll<HTMLElement>("[data-control]").forEach((element) => {
    if (ALWAYS_ENABLED_SELECTORS.some((sel) => element.matches(sel))) return;
    if (element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
      element.disabled = !enabled;
    }
  });
  if (!enabled) {
    root.querySelectorAll<HTMLElement>("[data-dragging], .dragging").forEach((element) => {
      element.classList.remove("dragging");
      delete element.dataset.dragging;
    });
  }
}

function renderStatusFlags(root: HTMLElement, status: CameraStatus): void {
  const statusList = root.querySelector<HTMLUListElement>("[data-status]");
  if (!statusList) return;

  const labels = status.labels.length > 0 ? status.labels : ["No flags set"];
  statusList.replaceChildren(
    ...labels.map((label) => {
      const item = document.createElement("li");
      item.textContent = label;
      return item;
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function attachClient(root: HTMLElement, client: CameraClient): void {
  (root as HTMLElement & { cameraClient?: CameraClient }).cameraClient = client;
}
