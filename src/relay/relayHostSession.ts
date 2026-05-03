import type { CameraStatus } from "../blackmagic/status";
import type { CameraClient } from "../ui/cameraClientTypes";
import { getRelaySocketUrl } from "./relayUrl";

/**
 * @file relayHostSession.ts
 *
 * bm-bluetooth — WebSocket **host** leg of the relay: registers a BLE-capable controller, forwards joiner packets,
 * and pushes `bootstrap_snapshot` / `panel_sync` envelopes derived from camera state plus optional ATEM CCU overlays.
 *
 * **Private** repo.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Wire message shapes (browser → coordinator)
// ─────────────────────────────────────────────────────────────────────────────

export type AtemCcuRelayRegister = {
  address: string;
  port?: number;
  cameraId: number;
  inputs?: number;
};

type WireOut =
  | {
      type: "host_register";
      sessionName: string;
      deviceId: string;
      atemCcu?: AtemCcuRelayRegister;
    }
  | { type: "host_stop" }
  | { type: "host_ping" }
  | { type: "panel_sync"; snapshot: Record<string, unknown> };

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// RelayHostSession
// ─────────────────────────────────────────────────────────────────────────────

/** BLE bridge: relays joiner packets to local BLE master; uploads status + incoming BLE to joiners. */
export class RelayHostSession {
  private ws: WebSocket | null = null;
  sessionId: string | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private atemCcuConfig: AtemCcuRelayRegister | undefined;

  constructor(
    private readonly ble: CameraClient,
    private readonly params: {
      log: (m: string) => void;
      prepareBootstrapSnapshot?: () => Promise<{
        type: "bootstrap_snapshot";
        snapshot: Record<string, unknown>;
      } | null>;
      /** After a joiner's forward_cmd is written to BLE — bytes for host-side state mirror + panel_sync. */
      onForwardedJoinerCommand?: (bytes: Uint8Array) => void;
      /** Another client persisted banks/scenes to shared storage — refresh metadata from API. */
      onSharedSessionDirty?: () => void;
      /** ATEM CCU mode: server pushes `panel_sync` snapshots derived from the switcher. */
      onServerPanelSync?: (snapshot: Record<string, unknown>) => void;
      /** ATEM TCP link up/down (server → host WebSocket). */
      onAtemSwitcherTcp?: (detail: { connected: boolean; address?: string; cameraId?: number }) => void;
      /** Relay WebSocket closed unexpectedly while hosting (e.g. hub restart); not called after intentional {@link stopSharing}. */
      onHostRelaySocketLost?: () => void;
    },
  ) {}

  private _atemSwitcherTcpConnected = false;

  get isActive(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.sessionId !== undefined;
  }

  /** Host session where CCU is owned by the relay server (ATEM TCP). */
  get isAtemCcuHost(): boolean {
    return !!this.atemCcuConfig && this.isActive;
  }

  /** Server reports ATEM switcher TCP connected (Camera Control may still be warming). */
  get atemSwitcherTcpConnected(): boolean {
    return this._atemSwitcherTcpConnected;
  }

  async connect(sessionName: string, deviceId: string, atemCcu?: AtemCcuRelayRegister): Promise<void> {
    this.cleanup();
    this.atemCcuConfig = atemCcu;

    const url = getRelaySocketUrl();

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.ws = socket;
      socket.addEventListener(
        "error",
        () => reject(new Error("Relay WebSocket error")),
        { once: true },
      );
      socket.addEventListener("open", () => {
        const payload: WireOut = atemCcu
          ? { type: "host_register", sessionName, deviceId, atemCcu }
          : { type: "host_register", sessionName, deviceId };
        socket.send(JSON.stringify(payload));
        resolve();
      });
      socket.addEventListener(
        "message",
        (ev) => void this.onMessage(String(ev.data)),
      );
      socket.addEventListener("close", () => {
        if (this.ws !== socket) return;
        this.ws = null;
        const hadHostedSession = this.sessionId !== undefined;
        const hadAtemHost = !!this.atemCcuConfig;
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = undefined;
        this._atemSwitcherTcpConnected = false;
        this.sessionId = undefined;
        this.atemCcuConfig = undefined;
        if (hadAtemHost) this.params.onAtemSwitcherTcp?.({ connected: false });
        if (hadHostedSession && hadAtemHost) this.params.onHostRelaySocketLost?.();
      });
    });

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Relay host registration timed out")), 8000);
      const onHosted = (): void => {
        clearTimeout(t);
        resolve();
      };
      (this as RelayHostSession & { _onHosted?: () => void })._onHosted = onHosted;
    });

    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(JSON.stringify({ type: "host_ping" } satisfies WireOut));
      } catch {
        /* ignore */
      }
    }, 20000);

    this.params.log(
      atemCcu
        ? `Relay sharing (ATEM CCU cam ${atemCcu.cameraId} @ ${atemCcu.address}): ${sessionName}`
        : `Relay sharing: ${sessionName}`,
    );
  }

  /** Host UI → CCU path when {@link isAtemCcuHost} is true (same wire as joiner `forward_cmd`). */
  sendHostForwardCmd(packet: Uint8Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error("Relay host socket is not open");
    this.ws.send(JSON.stringify({ type: "forward_cmd", hex: hexEncode(packet) }));
  }

  pushCameraStatus(status: CameraStatus): void {
    if (!this.isActive) return;
    try {
      this.ws!.send(
        JSON.stringify({
          type: "status",
          raw: status.raw,
          payloadHex: status.payloadHex,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  pushIncoming(bytes: Uint8Array): void {
    if (!this.isActive) return;
    try {
      this.ws!.send(JSON.stringify({ type: "incoming", hex: hexEncode(bytes) }));
    } catch {
      /* ignore */
    }
  }

  pushPanelSync(snapshot: Record<string, unknown>): void {
    if (!this.isActive) return;
    try {
      this.ws!.send(JSON.stringify({ type: "panel_sync", snapshot } satisfies WireOut));
    } catch {
      /* ignore */
    }
  }

  stopSharing(): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: "host_stop" } satisfies WireOut));
      }
    } catch {
      /* ignore */
    }
    this.params.log("Stopped relay sharing");
    this.cleanup();
  }

  cleanup(): void {
    const hadAtem = !!this.atemCcuConfig;
    const wasTcp = this._atemSwitcherTcpConnected;
    this._atemSwitcherTcpConnected = false;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    this.sessionId = undefined;
    this.atemCcuConfig = undefined;
    const s = this.ws;
    this.ws = null;
    try {
      s?.close();
    } catch {
      /* ignore */
    }
    if (hadAtem && wasTcp) this.params.onAtemSwitcherTcp?.({ connected: false });
  }

  private async onMessage(data: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data) as unknown;
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const t = (parsed as { type?: string }).type;

    if (t === "hosted") {
      const sid = (parsed as { sessionId?: string }).sessionId;
      if (typeof sid === "string") this.sessionId = sid;
      const ext = this as RelayHostSession & { _onHosted?: () => void };
      ext._onHosted?.();
      ext._onHosted = undefined;
      return;
    }

    if (t === "atem_ccu_ready") {
      this._atemSwitcherTcpConnected = true;
      const addr = (parsed as { address?: string }).address;
      const cam = (parsed as { cameraId?: number }).cameraId;
      this.params.log(
        addr !== undefined && cam !== undefined
          ? `ATEM CCU relay link ready (${cam} @ ${addr})`
          : "ATEM CCU relay link ready",
      );
      return;
    }

    if (t === "atem_ccu_link") {
      const connected = Boolean((parsed as { connected?: unknown }).connected);
      this._atemSwitcherTcpConnected = connected;
      const address =
        typeof (parsed as { address?: unknown }).address === "string"
          ? (parsed as { address: string }).address
          : undefined;
      const cameraId =
        typeof (parsed as { cameraId?: unknown }).cameraId === "number"
          ? (parsed as { cameraId: number }).cameraId
          : undefined;
      this.params.onAtemSwitcherTcp?.({ connected, address, cameraId });
      if (connected && address !== undefined) {
        this.params.log(`ATEM switcher TCP connected (${cameraId ?? "?"} @ ${address})`);
      } else if (!connected) {
        this.params.log("ATEM switcher TCP disconnected");
      }
      return;
    }

    if (t === "atem_ccu_error") {
      const msg = (parsed as { message?: string }).message ?? "ATEM CCU error";
      this.params.log(`ATEM CCU: ${msg}`);
      return;
    }

    if (t === "panel_sync" && this.atemCcuConfig) {
      const snap = (parsed as { snapshot?: Record<string, unknown> }).snapshot;
      if (snap && typeof snap === "object") {
        this.params.onServerPanelSync?.(snap);
      }
      return;
    }

    if (t === "request_bootstrap") {
      void this.answerBootstrapSnapshot();
      return;
    }

    try {
      if (t === "forward_cmd") {
        if (this.isAtemCcuHost) return;
        const hex = (parsed as { hex?: string }).hex;
        if (typeof hex === "string") {
          const bytes = hexToBytes(hex);
          await this.ble.writeCommand(bytes);
          this.params.onForwardedJoinerCommand?.(bytes);
        }
        return;
      }
      if (t === "host_power") {
        await this.ble.setPower((parsed as { on: boolean }).on);
        return;
      }
      if (t === "host_pair") {
        await this.ble.triggerPairing();
        return;
      }
      if (t === "shared_session_dirty") {
        this.params.onSharedSessionDirty?.();
        return;
      }
    } catch (e) {
      this.params.log(`Relay host action failed: ${(e as Error).message}`);
    }
  }

  private async answerBootstrapSnapshot(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const msg = (await this.params.prepareBootstrapSnapshot?.()) ?? null;
    if (!msg) return;
    try {
      this.ws.send(JSON.stringify(msg));
      this.params.log("Relay bootstrap snapshot sent to guests");
    } catch {
      /* ignore */
    }
  }
}
