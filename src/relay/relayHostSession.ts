import type { CameraStatus } from "../blackmagic/status";
import type { CameraClient } from "../ui/cameraClientTypes";
import { getRelaySocketUrl } from "./relayUrl";

type WireOut =
  | { type: "host_register"; sessionName: string; deviceId: string }
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

/** BLE bridge: relays joiner packets to local BLE master; uploads status + incoming BLE to joiners. */
export class RelayHostSession {
  private ws: WebSocket | null = null;
  sessionId: string | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

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
    },
  ) {}

  get isActive(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.sessionId !== undefined;
  }

  async connect(sessionName: string, deviceId: string): Promise<void> {
    this.cleanup();
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
        socket.send(
          JSON.stringify({
            type: "host_register",
            sessionName,
            deviceId,
          } satisfies WireOut),
        );
        resolve();
      });
      socket.addEventListener(
        "message",
        (ev) => void this.onMessage(String(ev.data)),
      );
      socket.addEventListener("close", () => {
        if (this.ws === socket) this.ws = null;
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

    this.params.log(`Relay sharing: ${sessionName}`);
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
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.sessionId = undefined;
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

    if (t === "request_bootstrap") {
      void this.answerBootstrapSnapshot();
      return;
    }

    try {
      if (t === "forward_cmd") {
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
