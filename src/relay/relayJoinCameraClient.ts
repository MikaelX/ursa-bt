import type { ConnectionState } from "../blackmagic/bleClient";
import type { CameraClient } from "../ui/cameraClientTypes";
import { getRelaySocketUrl } from "./relayUrl";

type JoinWire =
  | { type: "join"; sessionId: string }
  | { type: "joined"; sessionName: string; deviceId: string }
  | { type: "forward_cmd"; hex: string }
  | { type: "host_power"; on: boolean }
  | { type: "host_pair" }
  | { type: "shared_session_dirty" };

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Join-only: commands go through relay (host executes BLE writes). */
export class RelayJoinedCameraClient implements CameraClient {
  readonly isSupported = typeof WebSocket !== "undefined";
  readonly autoReconnectEnabled = false;

  private sock: WebSocket | null = null;
  private acknowledged = false;

  constructor(
    private readonly params: {
      onRelayStatus: (msg: { raw: number; payloadHex?: string }) => void;
      onRelayIncomingHex: (hex: string) => void;
      onRelayBootstrapSnapshot?: (snapshot: Record<string, unknown>) => void;
      onRelayPanelSync?: (snapshot: Record<string, unknown>) => void;
      onJoinedInfo: (deviceId: string, sessionDisplayName: string) => void;
      onDropped: () => void;
      log: (message: string) => void;
    },
  ) {}

  get isConnected(): boolean {
    return this.sock !== null && this.sock.readyState === WebSocket.OPEN && this.acknowledged;
  }

  async joinSession(sessionId: string): Promise<ConnectionState> {
    this.cleanupQuiet();

    return await new Promise<ConnectionState>((resolveOuter, rejectOuter) => {
      const url = getRelaySocketUrl();
      const socket = new WebSocket(url);
      this.sock = socket;

      let finished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const settle = (fn: () => void): void => {
        if (finished) return;
        finished = true;
        if (timer !== undefined) clearTimeout(timer);
        fn();
      };

      timer = globalThis.setTimeout(() => {
        settle(() => {
          try {
            socket.close();
          } catch {
            /* ignore */
          }
          rejectOuter(new Error("Relay join timed out"));
        });
      }, 15000);

      socket.addEventListener(
        "error",
        () => {
          settle(() => rejectOuter(new Error("Relay WebSocket error")));
        },
        { once: true },
      );

      socket.addEventListener("open", () => {
        socket.send(JSON.stringify({ type: "join", sessionId } satisfies JoinWire));
      });

      socket.addEventListener("message", (ev) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(ev.data)) as unknown;
        } catch {
          return;
        }
        if (!parsed || typeof parsed !== "object") return;
        const p = parsed as { type?: string };

        switch (p.type) {
          case "joined": {
            const j = parsed as Extract<JoinWire, { type: "joined" }>;
            this.acknowledged = true;
            this.params.onJoinedInfo(j.deviceId ?? "", j.sessionName ?? "");
            settle(() =>
              resolveOuter({
                deviceId: j.deviceId ?? "",
                deviceName: j.sessionName || "Relay session",
                connected: true,
              }),
            );
            try {
              socket.send(JSON.stringify({ type: "request_bootstrap" }));
            } catch {
              /* ignore */
            }
            break;
          }
          case "status": {
            const s = parsed as { raw?: number; payloadHex?: string };
            const raw = typeof s.raw === "number" ? s.raw : 0;
            const payloadHex = typeof s.payloadHex === "string" ? s.payloadHex : undefined;
            this.params.onRelayStatus({ raw, payloadHex });
            break;
          }
          case "incoming":
            this.params.onRelayIncomingHex((parsed as { hex: string }).hex ?? "");
            break;
          case "bootstrap_snapshot": {
            const snap = (parsed as { snapshot?: Record<string, unknown> }).snapshot;
            if (snap && typeof snap === "object") this.params.onRelayBootstrapSnapshot?.(snap);
            break;
          }
          case "panel_sync": {
            const snap = (parsed as { snapshot?: Record<string, unknown> }).snapshot;
            if (snap && typeof snap === "object") this.params.onRelayPanelSync?.(snap);
            break;
          }
          case "session_ended": {
            const hadJoined = this.acknowledged;
            if (hadJoined) this.params.log("Host stopped sharing");
            else this.params.log("Relay session not available");
            this.acknowledged = false;
            settle(() => {
              try {
                socket.close();
              } catch {
                /* ignore */
              }
              rejectOuter(
                new Error(
                  hadJoined
                    ? "Session ended"
                    : "Relay session unavailable (host offline, or list out of date — refresh and retry)",
                ),
              );
            });
            break;
          }
          default:
            break;
        }
      });

      socket.addEventListener("close", () => {
        const wasAck = this.acknowledged;
        this.acknowledged = false;
        if (this.sock === socket) this.sock = null;
        if (wasAck) this.params.onDropped();
        if (!finished) {
          settle(() => rejectOuter(new Error("Relay closed")));
        }
      });
    });
  }

  async connect(): Promise<ConnectionState> {
    throw new Error("Use Join to connect over relay.");
  }

  disconnect(): void {
    const was = this.acknowledged;
    this.cleanup();
    this.params.log("Relay disconnected");
    if (was) this.params.onDropped();
  }

  setAutoReconnect(_enabled: boolean): void {}

  async writeCommand(packet: Uint8Array): Promise<void> {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) throw new Error("Relay not connected");
    this.sock.send(JSON.stringify({ type: "forward_cmd", hex: hexEncode(packet) } satisfies JoinWire));
  }

  async triggerPairing(): Promise<void> {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) throw new Error("Relay not connected");
    this.sock.send(JSON.stringify({ type: "host_pair" } satisfies JoinWire));
  }

  async setPower(on: boolean): Promise<void> {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) throw new Error("Relay not connected");
    this.sock.send(JSON.stringify({ type: "host_power", on } satisfies JoinWire));
  }

  /** Tell the BLE host another client wrote banks/load state to `/api/cameras/:id/banks`. */
  notifySharedSessionDirty(): void {
    if (!this.sock || this.sock.readyState !== WebSocket.OPEN) return;
    try {
      this.sock.send(JSON.stringify({ type: "shared_session_dirty" } satisfies JoinWire));
    } catch {
      /* ignore */
    }
  }

  cleanup(): void {
    this.acknowledged = false;
    try {
      this.sock?.close();
    } catch {
      /* ignore */
    }
    this.sock = null;
  }

  cleanupQuiet(): void {
    this.acknowledged = false;
    try {
      this.sock?.close();
    } catch {
      /* ignore */
    }
    this.sock = null;
  }
}
