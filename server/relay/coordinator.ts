import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import type { WebSocket as WsType } from "ws";
import { WebSocketServer } from "ws";
import { decodeConfigurationPacket } from "../../src/blackmagic/protocol.js";
import { bleDecodedHandledByAtemBridge } from "../../src/relay/atemBleForwardGuard.js";
import { AtemCcuRoomBridge } from "../atem/atemCcuRoomBridge.js";

/**
 * @file coordinator.ts (`server/relay`)
 *
 * bm-bluetooth — WebSocket multiplexing between BLE-host browsers and relay join clients; optional Redis bridges replicas.
 */

const RELAY_PATH = "/api/relay/socket";

const REDIS_PREFIX_SESSION = "bmrelay:s:";
const REDIS_PREFIX_CONNECTOR = "bmrelay:c:";
const REDIS_TTL_SEC = 120;

/** JSON sent over WebSocket (host <-> server <-> joiners). */
export type RelayWireMessage =
  | {
      type: "host_register";
      sessionName: string;
      deviceId: string;
      /** Server opens ATEM TCP and serves CCU as relay transport (no BLE on host). */
      atemCcu?: { address: string; port?: number; cameraId: number; inputs?: number };
    }
  | { type: "join"; sessionId: string }
  | { type: "host_stop" }
  | { type: "host_ping" }
  | { type: "forward_cmd"; hex: string }
  | { type: "status"; raw: number; payloadHex?: string }
  | { type: "incoming"; hex: string }
  | { type: "joined"; sessionName: string; deviceId: string }
  | { type: "hosted"; sessionId: string; edgeToken?: string; atemPlaneSessionId?: string }
  | { type: "session_ended" }
  | { type: "host_power"; on: boolean }
  | { type: "host_pair" }
  /** Join-only: host should refresh banks/session data from shared API (`/banks`). */
  | { type: "shared_session_dirty" }
  | { type: "request_bootstrap" }
  | { type: "bootstrap_snapshot"; snapshot: Record<string, unknown> }
  | { type: "panel_sync"; snapshot: Record<string, unknown> }
  | { type: "atem_ccu_ready"; address?: string; cameraId?: number }
  | { type: "atem_ccu_link"; connected: boolean; address?: string; cameraId?: number }
  | { type: "atem_ccu_error"; message: string }
  | { type: "atem_ccu_log"; message: string }
  | {
      type: "host_atem_ccu_register";
      /** Route CCU to a named LAN connector ({@link RelayCoordinator.listAtemConnectors}). */
      connectorId?: string;
      atemCcu: { address: string; port?: number; cameraId: number; inputs?: number };
    }
  | { type: "host_atem_ccu_stop" }
  | {
      type: "joiner_atem_ccu_register";
      connectorId?: string;
      atemCcu: { address: string; port?: number; cameraId: number; inputs?: number };
    }
  | { type: "joiner_atem_ccu_stop" }
  | { type: "atem_edge_register"; sessionId: string; token: string }
  | { type: "atem_edge_ready"; sessionId: string }
  | { type: "atem_edge_panel_sync"; sessionId: string; snapshot: Record<string, unknown> }
  | { type: "atem_edge_link"; sessionId: string; connected: boolean; address?: string; cameraId?: number }
  | {
      type: "atem_edge_notify";
      sessionId: string;
      kind: "error" | "log";
      message: string;
    }
  | { type: "atem_edge_forward_cmd"; hex: string }
  | {
      type: "atem_edge_control";
      sessionId: string;
      /** When set, send commands to this ATEM connector instead of the session/plane edge socket. */
      connectorId?: string;
      command: "connect" | "disconnect" | "restart";
      atemCcu?: { address: string; port?: number; cameraId: number; inputs?: number };
    }
  | {
      type: "atem_connector_register";
      name: string;
      connectorId?: string;
      token?: string;
    }
  | { type: "atem_connector_ready"; connectorId: string; token: string; name: string }
  | { type: "atem_connector_panel_sync"; connectorId: string; snapshot: Record<string, unknown> }
  | {
      type: "atem_connector_link";
      connectorId: string;
      connected: boolean;
      address?: string;
      cameraId?: number;
    }
  | { type: "atem_connector_notify"; connectorId: string; kind: "error" | "log"; message: string }
  /** Hub → LAN edge (session context included for logs/routing clarity). */
  | {
      type: "atem_edge_control";
      sessionId?: string;
      command: "connect";
      atemCcu: { address: string; port?: number; cameraId: number; inputs?: number };
    }
  | { type: "atem_edge_control"; sessionId?: string; command: "disconnect" | "restart" };

type Room = {
  sessionId: string;
  sessionName: string;
  deviceId: string;
  /** Reserved relay room for LAN ATEM edge (`RELAY_ATEM_PLANE_*`); never listed in Join UI. */
  hiddenAtemPlane?: boolean;
  host?: WsType;
  clients: Set<WsType>;
  hostPingInterval?: ReturnType<typeof setInterval>;
  atemBridge?: AtemCcuRoomBridge;
  /** Join socket that started hub ATEM for this room — dispose bridge when it disconnects. */
  atemJoinerSocket?: WsType;
  /** Hub ATEM started via {@link RelayCoordinator.attachJoinerAtemHttp} (banks API), not the join WebSocket. */
  atemHttpAttached?: boolean;
  /** Local-truck ATEM process attached over WS — TCP runs on edge, not this coordinator. */
  atemEdgeSocket?: WsType;
  /** Single-use token from {@link randomBytes}; host shares with edge agent to attach. */
  edgeToken?: string;
  /** TCP link state when ATEM is on edge (no in-process {@link AtemCcuRoomBridge}). */
  edgeTcpLinked?: boolean;
};

/** LAN process that holds ATEM camera-control TCP and speaks {@link RelayWireMessage} on the relay socket. */
type AtemConnector = {
  id: string;
  name: string;
  token: string;
  socket?: WsType;
  tcpLinked?: boolean;
  target?: { address: string; cameraId: number; port?: number };
};

function connectorNameKey(name: string): string {
  return name.trim().toLowerCase();
}

type RedisPair = {
  pub: import("ioredis").default;
  sub: import("ioredis").default;
};

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

function isRelayWireMessage(v: unknown): v is RelayWireMessage {
  if (!v || typeof v !== "object") return false;
  const t = (v as { type?: unknown }).type;
  return typeof t === "string";
}

function relayHexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2 !== 0) throw new Error("Invalid hex length");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Joiner `forward_cmd` bytes that the hub applies via ATEM CCU (not the host BLE leg). */
function joinerForwardCmdPreferAtemBridge(hex: string): boolean {
  const trimmed = hex.trim();
  if (!trimmed) return false;
  try {
    const bytes = relayHexToBytes(trimmed);
    const decoded = decodeConfigurationPacket(bytes);
    return !!(decoded && bleDecodedHandledByAtemBridge(decoded));
  } catch {
    return false;
  }
}

export class RelayCoordinator {
  private readonly rooms = new Map<string, Room>();
  private readonly wss: WebSocketServer;
  private readonly redisUrl: string | undefined;
  private redis?: RedisPair;
  /** Per relay session id: number of ATEM attach intents for the global plane edge (host/joiner stops decrement). */
  private readonly atemPlaneInterest = new Map<string, number>();
  /** Named LAN ATEM bridges (register via `atem_connector_register`). */
  private readonly atemConnectors = new Map<string, AtemConnector>();
  /** Operator session id → connector id for CCU fan-out and `forward_cmd`. */
  private readonly sessionAtemConnector = new Map<string, string>();
  /** Redis presence heartbeat timers for connector keys (`bmrelay:c:*`). */
  private readonly connectorPresenceTimers = new Map<string, ReturnType<typeof setInterval>>();
  /** When set, `ensureRedis` skips new attempts until the clock passes this (retry after transient failure / boot race). */
  private redisRetryNotBeforeMs = 0;

  /** When false (set `RELAY_ATEM_HUB_BRIDGE=0` on cloud), coordinator does not open ATEM TCP — use `atem_edge_*` messages from a LAN agent. */
  private hubAtemBridgeAllowed(): boolean {
    const v = process.env.RELAY_ATEM_HUB_BRIDGE;
    return v !== "0" && String(v ?? "").toLowerCase() !== "false";
  }

  /** Static ATEM control-plane room (edge WS + token); optional alternative to per-session {@link Room.edgeToken}. */
  private getAtemPlaneConfig(): { sessionId: string; edgeToken: string } | undefined {
    const sessionId = process.env.RELAY_ATEM_PLANE_SESSION_ID?.trim();
    const edgeToken = process.env.RELAY_ATEM_PLANE_EDGE_TOKEN?.trim();
    if (!sessionId || !edgeToken) return undefined;
    return { sessionId, edgeToken };
  }

  private ensureAtemPlaneRoom(): void {
    const cfg = this.getAtemPlaneConfig();
    if (!cfg) return;
    if (this.rooms.has(cfg.sessionId)) return;
    this.rooms.set(cfg.sessionId, {
      sessionId: cfg.sessionId,
      sessionName: "__atem_plane__",
      deviceId: "atem-plane",
      clients: new Set(),
      edgeToken: cfg.edgeToken,
      hiddenAtemPlane: true,
    });
  }

  private getAtemPlaneRoom(): Room | undefined {
    const cfg = this.getAtemPlaneConfig();
    return cfg ? this.rooms.get(cfg.sessionId) : undefined;
  }

  /** LAN ATEM TCP attaches to the plane room when env is set; otherwise to the operator session room. */
  private edgeRoomForAtemOperator(operatorRoom: Room): Room {
    const pr = this.getAtemPlaneRoom();
    return pr && this.getAtemPlaneConfig() ? pr : operatorRoom;
  }

  private isAtemPlaneSessionId(sessionId: string): boolean {
    const cfg = this.getAtemPlaneConfig();
    return !!cfg && cfg.sessionId === sessionId;
  }

  private bumpAtemPlaneInterest(sessionId: string): void {
    this.atemPlaneInterest.set(sessionId, (this.atemPlaneInterest.get(sessionId) ?? 0) + 1);
  }

  private dropAtemPlaneInterest(sessionId: string): void {
    const n = (this.atemPlaneInterest.get(sessionId) ?? 0) - 1;
    if (n <= 0) this.atemPlaneInterest.delete(sessionId);
    else this.atemPlaneInterest.set(sessionId, n);
    this.disconnectAtemPlaneEdgeIfIdle();
  }

  private totalAtemPlaneInterest(): number {
    let t = 0;
    for (const n of this.atemPlaneInterest.values()) t += n;
    return t;
  }

  /** Fan out JSON lines from the LAN ATEM edge (plane room) to every subscribed operator session. */
  private emitAtemPlaneToSubscribers(payloadJson: string): void {
    for (const sid of this.atemPlaneInterest.keys()) {
      const room = this.rooms.get(sid);
      const h = room?.host;
      if (h?.readyState === 1) {
        try {
          h.send(payloadJson);
        } catch {
          /* ignore */
        }
      }
      this.routeToJoiners(sid, payloadJson);
    }
  }

  private disconnectAtemPlaneEdgeIfIdle(): void {
    if (this.totalAtemPlaneInterest() > 0) return;
    const pr = this.getAtemPlaneRoom();
    const e = pr?.atemEdgeSocket;
    if (!e || e.readyState !== 1) return;
    try {
      e.send(JSON.stringify({ type: "atem_edge_control", command: "disconnect" } satisfies RelayWireMessage));
    } catch {
      /* ignore */
    }
  }

  private findAtemEdgeRoom(ws: WsType): string | undefined {
    for (const [sid, r] of this.rooms) {
      if (r.atemEdgeSocket === ws) return sid;
    }
    return undefined;
  }

  private findConnectorSocket(ws: WsType): string | undefined {
    for (const [id, c] of this.atemConnectors) {
      if (c.socket === ws) return id;
    }
    return undefined;
  }

  private sessionsUsingConnector(connectorId: string): number {
    let n = 0;
    for (const cid of this.sessionAtemConnector.values()) {
      if (cid === connectorId) n += 1;
    }
    return n;
  }

  /** Drop TCP on the connector when no operator session is bound. */
  private maybeDisconnectConnector(connectorId: string): void {
    if (this.sessionsUsingConnector(connectorId) > 0) return;
    const c = this.atemConnectors.get(connectorId);
    const sock = c?.socket;
    if (!sock || sock.readyState !== 1) return;
    try {
      sock.send(JSON.stringify({ type: "atem_edge_control", command: "disconnect" } satisfies RelayWireMessage));
    } catch {
      /* ignore */
    }
  }

  private emitPanelSyncToConnectorSubscribers(
    connectorId: string,
    snapshot: Record<string, unknown>,
  ): void {
    for (const [sessionId, cid] of this.sessionAtemConnector.entries()) {
      if (cid !== connectorId) continue;
      this.emitPanelSyncFromAtem(sessionId, snapshot);
    }
  }

  private emitJsonToConnectorSubscribers(connectorId: string, payloadJson: string): void {
    for (const [sessionId, cid] of this.sessionAtemConnector.entries()) {
      if (cid !== connectorId) continue;
      const room = this.rooms.get(sessionId);
      const h = room?.host;
      if (h?.readyState === 1) {
        try {
          h.send(payloadJson);
        } catch {
          /* ignore */
        }
      }
      this.routeToJoiners(sessionId, payloadJson);
    }
  }

  /** HTTP: connectors registered by LAN agents (named ATEM TCP bridges). */
  async listAtemConnectors(): Promise<
    {
      id: string;
      name: string;
      online: boolean;
      tcpLinked?: boolean;
      target?: { address: string; cameraId: number; port?: number };
    }[]
  > {
    const outById = new Map<
      string,
      {
        id: string;
        name: string;
        online: boolean;
        tcpLinked?: boolean;
        target?: { address: string; cameraId: number; port?: number };
      }
    >();

    for (const c of this.atemConnectors.values()) {
      outById.set(c.id, {
        id: c.id,
        name: c.name,
        online: c.socket?.readyState === 1,
        tcpLinked: c.tcpLinked,
        target: c.target,
      });
    }

    await this.ensureRedis();
    if (this.redis) {
      const keys = await this.redis.pub.keys(`${REDIS_PREFIX_CONNECTOR}*`);
      for (const key of keys) {
        const id = key.slice(REDIS_PREFIX_CONNECTOR.length);
        if (!id) continue;
        const h = await this.redis.pub.hgetall(key);
        const name = (h.name ?? "").trim();
        if (!name) continue;
        const recOnline = h.online === "1";
        let recTcpLinked: boolean | undefined;
        if (h.tcpLinked === "1") recTcpLinked = true;
        else if (h.tcpLinked === "0") recTcpLinked = false;
        const recAddress = (h.targetAddress ?? "").trim();
        const recCameraId = Number(h.targetCameraId ?? "");
        const recPort = Number(h.targetPort ?? "");
        const recTarget =
          recAddress && Number.isFinite(recCameraId)
            ? {
                address: recAddress,
                cameraId: Math.round(recCameraId),
                ...(Number.isFinite(recPort) ? { port: Math.round(recPort) } : {}),
              }
            : undefined;
        const prev = outById.get(id);
        if (!prev) {
          outById.set(id, {
            id,
            name,
            online: recOnline,
            ...(recTcpLinked !== undefined ? { tcpLinked: recTcpLinked } : {}),
            ...(recTarget ? { target: recTarget } : {}),
          });
          continue;
        }
        outById.set(id, {
          ...prev,
          name: prev.name || name,
          online: prev.online || recOnline,
          ...(prev.tcpLinked !== undefined
            ? { tcpLinked: prev.tcpLinked }
            : recTcpLinked !== undefined
              ? { tcpLinked: recTcpLinked }
              : {}),
          ...(prev.target ? { target: prev.target } : recTarget ? { target: recTarget } : {}),
        });
      }
    }

    return [...outById.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private routeForwardCmdToAtemEdge(room: Room, hex: string): void {
    const e = room.atemEdgeSocket;
    if (!e || e.readyState !== 1 || !hex.trim()) return;
    try {
      e.send(JSON.stringify({ type: "atem_edge_forward_cmd", hex } satisfies RelayWireMessage));
    } catch {
      /* ignore */
    }
  }

  private routeForwardCmdToConnector(connectorId: string, hex: string): void {
    const c = this.atemConnectors.get(connectorId);
    const sock = c?.socket;
    if (!sock || sock.readyState !== 1 || !hex.trim()) return;
    try {
      sock.send(JSON.stringify({ type: "atem_edge_forward_cmd", hex } satisfies RelayWireMessage));
    } catch {
      /* ignore */
    }
  }

  constructor(redisUrl?: string) {
    this.redisUrl = redisUrl?.trim() || undefined;
    this.wss = new WebSocketServer({ noServer: true });
    this.wss.on("connection", (socket: WsType, req: IncomingMessage) => {
      void (async () => {
        await this.waitForRedisIfConfigured(15_000);
        this.handleSocket(socket, req);
      })();
    });
  }

  attachToHttpServer(server: HttpServer): void {
    server.on("upgrade", (req, socket, head) => {
      const path = urlPath(req.url);
      if (path !== RELAY_PATH) return;
      this.wss.handleUpgrade(req, socket as Duplex, head, (ws) => {
        this.wss.emit("connection", ws, req);
      });
    });
  }

  /** Public session list for Join modal. */
  async listSessions(): Promise<
    { id: string; name: string; deviceId: string; atemCcuTcp?: boolean }[]
  > {
    this.ensureAtemPlaneRoom();
    await this.ensureRedis();
    if (!this.redis) {
      return [...this.rooms.values()]
        .filter((r) => !!r.host && !r.hiddenAtemPlane)
        .map((r) => ({
          id: r.sessionId,
          name: r.sessionName,
          deviceId: r.deviceId,
          atemCcuTcp:
            r.atemBridge !== undefined
              ? r.atemBridge.isTcpLinked
              : r.edgeTcpLinked !== undefined
                ? r.edgeTcpLinked
                : undefined,
        }));
    }
    const keys = await this.redis.pub.keys(`${REDIS_PREFIX_SESSION}*`);
    const out: { id: string; name: string; deviceId: string; atemCcuTcp?: boolean }[] = [];
    for (const key of keys) {
      const sid = key.slice(REDIS_PREFIX_SESSION.length);
      const h = await this.redis.pub.hgetall(key);
      if (!h.name || h.hasHost !== "1") continue;
      let atemCcuTcp: boolean | undefined;
      if (h.atemTcp === "1") atemCcuTcp = true;
      else if (h.atemTcp === "0") atemCcuTcp = false;
      out.push({
        id: sid,
        name: h.name,
        deviceId: h.deviceId ?? "",
        atemCcuTcp,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async destroy(): Promise<void> {
    for (const timer of this.connectorPresenceTimers.values()) clearInterval(timer);
    this.connectorPresenceTimers.clear();
    await this.closeRedis();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /** When `REDIS_URL` is set, give Redis time to accept connections (swarm boot / transient DNS) before handling relay WS. */
  private async waitForRedisIfConfigured(maxMs: number): Promise<void> {
    if (!this.redisUrl || this.redis) return;
    const deadline = Date.now() + maxMs;
    while (!this.redis && Date.now() < deadline) {
      await this.ensureRedis();
      if (this.redis) return;
      const waitMs = Math.max(80, Math.min(750, this.redisRetryNotBeforeMs - Date.now()));
      await new Promise<void>((r) => setTimeout(r, waitMs));
    }
  }

  private async ensureRedis(): Promise<void> {
    if (!this.redisUrl || this.redis) return;
    const now = Date.now();
    if (now < this.redisRetryNotBeforeMs) return;
    let pub: import("ioredis").default | undefined;
    let sub: import("ioredis").default | undefined;
    try {
      const Redis = (await import("ioredis")).default;
      pub = new Redis(this.redisUrl);
      sub = new Redis(this.redisUrl);
      const pubClient = pub;
      const subClient = sub;
      await new Promise<void>((resolve, reject) => {
        let left = 2;
        const to = setTimeout(() => reject(new Error("Redis connect timeout")), 12_000);
        const done = (): void => {
          left -= 1;
          if (left === 0) {
            clearTimeout(to);
            resolve();
          }
        };
        pubClient.once("ready", done);
        subClient.once("ready", done);
      });
      await subClient.psubscribe("bmrelay:in:*");
      await subClient.psubscribe("bmrelay:out:*");
      subClient.on("pmessage", (_pattern: string, channel: string, msg: string) => {
        const [, dir, ...restSid] = channel.split(":");
        const sessionId = restSid.join(":");
        if (!sessionId) return;
        if (dir === "in") this.deliverToLocalHost(sessionId, msg);
        else if (dir === "out") this.deliverToLocalJoiners(sessionId, msg);
      });
      this.redis = { pub: pubClient, sub: subClient };
      this.redisRetryNotBeforeMs = 0;
      console.log("[relay] Redis pub/sub enabled");
    } catch (e) {
      try {
        sub?.disconnect();
      } catch {
        /* ignore */
      }
      try {
        pub?.disconnect();
      } catch {
        /* ignore */
      }
      console.warn("[relay] Redis connection failed (will retry):", (e as Error).message);
      this.redis = undefined;
      // Swarm / boot race: app replica may start before Redis accepts connections; do not stay "Redis-less" forever.
      this.redisRetryNotBeforeMs = Date.now() + 4000;
    }
  }

  private async closeRedis(): Promise<void> {
    const r = this.redis;
    if (!r) return;
    await r.sub.quit();
    await r.pub.quit();
    this.redis = undefined;
  }

  private startConnectorPresence(connectorId: string): void {
    this.stopConnectorPresence(connectorId);
    const timer = setInterval(() => {
      const conn = this.atemConnectors.get(connectorId);
      if (!conn || !conn.socket || conn.socket.readyState !== 1) {
        this.stopConnectorPresence(connectorId);
        return;
      }
      void this.refreshConnectorRedisMeta(connectorId);
    }, 15_000);
    this.connectorPresenceTimers.set(connectorId, timer);
  }

  private stopConnectorPresence(connectorId: string): void {
    const t = this.connectorPresenceTimers.get(connectorId);
    if (t !== undefined) clearInterval(t);
    this.connectorPresenceTimers.delete(connectorId);
  }

  private async refreshConnectorRedisMeta(connectorId: string): Promise<void> {
    await this.ensureRedis();
    if (!this.redis) return;
    const conn = this.atemConnectors.get(connectorId);
    if (!conn) return;
    const key = `${REDIS_PREFIX_CONNECTOR}${connectorId}`;
    const online = conn.socket?.readyState === 1 ? "1" : "0";
    const multi = this.redis.pub.multi();
    multi.hset(key, "name", conn.name, "online", online);
    if (conn.tcpLinked === true) multi.hset(key, "tcpLinked", "1");
    else if (conn.tcpLinked === false) multi.hset(key, "tcpLinked", "0");
    else multi.hdel(key, "tcpLinked");
    if (conn.target) {
      multi.hset(key, "targetAddress", conn.target.address, "targetCameraId", String(conn.target.cameraId));
      if (conn.target.port !== undefined) multi.hset(key, "targetPort", String(conn.target.port));
      else multi.hdel(key, "targetPort");
    } else {
      multi.hdel(key, "targetAddress", "targetCameraId", "targetPort");
    }
    await multi.expire(key, REDIS_TTL_SEC).exec();
  }

  private async deleteConnectorRedisMeta(connectorId: string): Promise<void> {
    await this.ensureRedis();
    if (!this.redis) return;
    await this.redis.pub.del(`${REDIS_PREFIX_CONNECTOR}${connectorId}`);
  }

  private disposeAtemBridge(room: Room): void {
    if (room.atemBridge) {
      room.atemBridge.dispose();
      room.atemBridge = undefined;
    }
  }

  private parseAtemCcuRaw(acRaw: unknown): {
    address: string;
    port?: number;
    cameraId: number;
    inputs?: number;
  } | null {
    if (!acRaw || typeof acRaw !== "object" || acRaw === null) return null;
    const ac = acRaw as {
      address?: unknown;
      port?: unknown;
      cameraId?: unknown;
      inputs?: unknown;
    };
    const address = String(ac.address ?? "").trim();
    const cameraId = Math.round(Number(ac.cameraId));
    const port =
      ac.port !== undefined && ac.port !== null ? Math.round(Number(ac.port)) : undefined;
    const inputs =
      ac.inputs !== undefined && ac.inputs !== null ? Math.round(Number(ac.inputs)) : undefined;
    if (!address || !Number.isFinite(cameraId) || cameraId < 1 || cameraId > 24) return null;
    return { address, port, cameraId, inputs };
  }

  private startAtemBridgeFromPayload(
    sessionId: string,
    room: Room,
    ac: { address: string; port?: number; cameraId: number; inputs?: number },
  ): void {
    const { address, port, cameraId, inputs } = ac;
    const tcpPort = port !== undefined && Number.isFinite(port) && port > 0 ? port : 9910;
    const inputSlots = Math.min(32, Math.max(4, inputs ?? 16));
    const bridge = new AtemCcuRoomBridge(cameraId, inputSlots, {
      emitPanelSync: (snapshot) => this.emitPanelSyncFromAtem(sessionId, snapshot),
      hostSocket: () => room.host,
      onAtemTcpLinkChange: (linked) => {
        const linkMsg = JSON.stringify({
          type: "atem_ccu_link",
          connected: linked,
          address: linked ? address : undefined,
          cameraId: linked ? cameraId : undefined,
        } satisfies RelayWireMessage);
        const h = room.host;
        if (h?.readyState === 1) {
          try {
            h.send(linkMsg);
          } catch {
            /* ignore */
          }
        }
        this.routeToJoiners(sessionId, linkMsg);
        void this.refreshRedisMeta(room);
      },
      notifyHost: (message) => {
        const h = room.host;
        if (h?.readyState !== 1) return;
        try {
          h.send(JSON.stringify({ type: "atem_ccu_error", message } satisfies RelayWireMessage));
        } catch {
          /* ignore */
        }
      },
      onHostLog: (message) => {
        const line = JSON.stringify({ type: "atem_ccu_log", message } satisfies RelayWireMessage);
        const h = room.host;
        if (h?.readyState === 1) {
          try {
            h.send(line);
          } catch {
            /* ignore */
          }
        }
        this.routeToJoiners(sessionId, line);
      },
    });
    room.atemBridge = bridge;
    void bridge.connect(address, tcpPort);
  }

  private handleSocket(ws: WsType, _req: IncomingMessage): void {
    this.ensureAtemPlaneRoom();
    let roomId: string | undefined;
    let role: "host" | "join" | undefined;
    let edgeRoomId: string | undefined;
    let edgeRole: "atem_edge" | undefined;
    /** WS acts as a named ATEM connector after {@link RelayWireMessage} `atem_connector_register`. */
    let atemConnectorRoleId: string | undefined;

    const teardownConnector = (): void => {
      if (!atemConnectorRoleId) return;
      const cid = atemConnectorRoleId;
      const c = this.atemConnectors.get(cid);
      let released = false;
      if (c?.socket === ws) {
        c.socket = undefined;
        c.tcpLinked = undefined;
        released = true;
      }
      if (released) {
        this.stopConnectorPresence(cid);
        void this.deleteConnectorRedisMeta(cid).catch(() => {});
      }
      atemConnectorRoleId = undefined;
      if (this.sessionsUsingConnector(cid) > 0) {
        const linkMsg = JSON.stringify({ type: "atem_ccu_link", connected: false } satisfies RelayWireMessage);
        this.emitJsonToConnectorSubscribers(cid, linkMsg);
      }
    };
    const teardownEdge = (): void => {
      if (!edgeRoomId || edgeRole !== "atem_edge") return;
      const room = this.rooms.get(edgeRoomId);
      if (room?.atemEdgeSocket === ws) {
        room.atemEdgeSocket = undefined;
        room.edgeTcpLinked = undefined;
        void this.refreshRedisMeta(room).catch(() => {});
      }
      edgeRoomId = undefined;
      edgeRole = undefined;
    };
    const teardownJoin = (): void => {
      if (!roomId || role !== "join") return;
      const room = this.rooms.get(roomId);
      if (!room) return;
      if (room.atemJoinerSocket === ws) {
        this.disposeAtemBridge(room);
        room.atemJoinerSocket = undefined;
      }
      room.clients.delete(ws);
      void this.refreshRedisMeta(room).catch(() => {});
      if (!room.host && room.clients.size === 0 && !room.hiddenAtemPlane) {
        this.rooms.delete(roomId);
        void this.deleteRedisMeta(roomId).catch(() => {});
      }
      roomId = undefined;
      role = undefined;
    };

    const teardownHost = (): void => {
      if (!roomId || role !== "host") return;
      const room = this.rooms.get(roomId);
      if (room?.host === ws) {
        this.dropAtemPlaneInterest(room.sessionId);
        const prevConn = this.sessionAtemConnector.get(room.sessionId);
        if (prevConn !== undefined) {
          this.sessionAtemConnector.delete(room.sessionId);
          this.maybeDisconnectConnector(prevConn);
        }
        this.disposeAtemBridge(room);
        if (room.hostPingInterval) clearInterval(room.hostPingInterval);
        room.host = undefined;
        void this.refreshRedisMeta(room).catch(() => {});
        this.broadcastSessionEnded(room.sessionId);
      }
      if (room && !room.host && room.clients.size === 0 && !room.hiddenAtemPlane) {
        this.rooms.delete(room.sessionId);
        void this.deleteRedisMeta(room.sessionId).catch(() => {});
      }
      roomId = undefined;
      role = undefined;
    };

    ws.on("close", () => {
      teardownJoin();
      teardownHost();
      teardownConnector();
      teardownEdge();
    });

    ws.on("message", async (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      const parsed = safeJsonParse(raw);
      if (!isRelayWireMessage(parsed)) return;

      const connectorUplinkId = this.findConnectorSocket(ws);
      if (connectorUplinkId) {
        const p = parsed as { type?: string };
        switch (p.type) {
          case "atem_connector_panel_sync": {
            const snap = (parsed as { snapshot?: unknown }).snapshot;
            if (snap && typeof snap === "object") {
              this.emitPanelSyncToConnectorSubscribers(
                connectorUplinkId,
                snap as Record<string, unknown>,
              );
            }
            break;
          }
          case "atem_connector_link": {
            const conn = this.atemConnectors.get(connectorUplinkId);
            if (conn) {
              conn.tcpLinked = Boolean((parsed as { connected?: unknown }).connected);
              void this.refreshConnectorRedisMeta(connectorUplinkId).catch(() => {});
            }
            const addr =
              typeof (parsed as { address?: unknown }).address === "string"
                ? (parsed as { address: string }).address
                : undefined;
            const camRaw = (parsed as { cameraId?: unknown }).cameraId;
            const cameraId =
              typeof camRaw === "number" && Number.isFinite(camRaw)
                ? camRaw
                : typeof camRaw === "string" && Number.isFinite(Number(camRaw))
                  ? Number(camRaw)
                  : undefined;
            const linkMsg = JSON.stringify({
              type: "atem_ccu_link",
              connected: Boolean((parsed as { connected?: unknown }).connected),
              address: (parsed as { connected?: unknown }).connected ? addr : undefined,
              cameraId: (parsed as { connected?: unknown }).connected ? cameraId : undefined,
            } satisfies RelayWireMessage);
            this.emitJsonToConnectorSubscribers(connectorUplinkId, linkMsg);
            break;
          }
          case "atem_connector_notify": {
            const kind = (parsed as { kind?: unknown }).kind;
            const message = String((parsed as { message?: unknown }).message ?? "");
            if (kind === "error") {
              const errLine = JSON.stringify({ type: "atem_ccu_error", message } satisfies RelayWireMessage);
              this.emitJsonToConnectorSubscribers(connectorUplinkId, errLine);
            } else if (message) {
              const line = JSON.stringify({ type: "atem_ccu_log", message } satisfies RelayWireMessage);
              this.emitJsonToConnectorSubscribers(connectorUplinkId, line);
            }
            break;
          }
          default:
            break;
        }
        return;
      }

      const edgeSid = this.findAtemEdgeRoom(ws);
      if (edgeSid) {
        const p = parsed as { type?: string; sessionId?: string };
        const sid = typeof p.sessionId === "string" ? p.sessionId.trim() : "";
        if (sid !== edgeSid) return;
        switch (p.type) {
          case "atem_edge_panel_sync": {
            const snap = (parsed as { snapshot?: unknown }).snapshot;
            if (snap && typeof snap === "object") {
              const shot = snap as Record<string, unknown>;
              if (this.isAtemPlaneSessionId(edgeSid)) {
                for (const subSid of this.atemPlaneInterest.keys()) {
                  this.emitPanelSyncFromAtem(subSid, shot);
                }
              } else {
                this.emitPanelSyncFromAtem(edgeSid, shot);
              }
            }
            break;
          }
          case "atem_edge_link": {
            const er = this.rooms.get(edgeSid);
            if (!er) break;
            er.edgeTcpLinked = Boolean((parsed as { connected?: unknown }).connected);
            void this.refreshRedisMeta(er).catch(() => {});
            const addr =
              typeof (parsed as { address?: unknown }).address === "string"
                ? (parsed as { address: string }).address
                : undefined;
            const camRaw = (parsed as { cameraId?: unknown }).cameraId;
            const cameraId =
              typeof camRaw === "number" && Number.isFinite(camRaw)
                ? camRaw
                : typeof camRaw === "string" && Number.isFinite(Number(camRaw))
                  ? Number(camRaw)
                  : undefined;
            const linkMsg = JSON.stringify({
              type: "atem_ccu_link",
              connected: Boolean((parsed as { connected?: unknown }).connected),
              address: (parsed as { connected?: unknown }).connected ? addr : undefined,
              cameraId: (parsed as { connected?: unknown }).connected ? cameraId : undefined,
            } satisfies RelayWireMessage);
            if (this.isAtemPlaneSessionId(edgeSid)) {
              this.emitAtemPlaneToSubscribers(linkMsg);
              break;
            }
            const h = er.host;
            if (h?.readyState === 1) {
              try {
                h.send(linkMsg);
              } catch {
                /* ignore */
              }
            }
            this.routeToJoiners(edgeSid, linkMsg);
            break;
          }
          case "atem_edge_notify": {
            const er = this.rooms.get(edgeSid);
            const kind = (parsed as { kind?: unknown }).kind;
            const message = String((parsed as { message?: unknown }).message ?? "");
            if (this.isAtemPlaneSessionId(edgeSid)) {
              if (kind === "error") {
                const errLine = JSON.stringify({ type: "atem_ccu_error", message } satisfies RelayWireMessage);
                this.emitAtemPlaneToSubscribers(errLine);
              } else if (message) {
                const line = JSON.stringify({ type: "atem_ccu_log", message } satisfies RelayWireMessage);
                this.emitAtemPlaneToSubscribers(line);
              }
              break;
            }
            const h = er?.host;
            if (kind === "error") {
              if (h?.readyState === 1) {
                try {
                  h.send(JSON.stringify({ type: "atem_ccu_error", message } satisfies RelayWireMessage));
                } catch {
                  /* ignore */
                }
              }
            } else if (message) {
              const line = JSON.stringify({ type: "atem_ccu_log", message } satisfies RelayWireMessage);
              if (h?.readyState === 1) {
                try {
                  h.send(line);
                } catch {
                  /* ignore */
                }
              }
              this.routeToJoiners(edgeSid, line);
            }
            break;
          }
          default:
            break;
        }
        return;
      }

      switch (parsed.type) {
        case "atem_connector_register": {
          const name = String((parsed as { name?: unknown }).name ?? "").trim().slice(0, 80);
          if (!name) {
            try {
              ws.close(4000, "atem_connector_register name");
            } catch {
              /* ignore */
            }
            return;
          }
          const existingId = String((parsed as { connectorId?: unknown }).connectorId ?? "").trim();
          const existingTok = String((parsed as { token?: unknown }).token ?? "").trim();
          let conn: AtemConnector;
          if (existingId && existingTok) {
            const c = this.atemConnectors.get(existingId);
            if (!c || c.token !== existingTok) {
              try {
                ws.send(JSON.stringify({ type: "session_ended" } satisfies RelayWireMessage));
                ws.close(4003, "bad connector token");
              } catch {
                /* ignore */
              }
              return;
            }
            conn = c;
            if (conn.socket && conn.socket !== ws && conn.socket.readyState === 1) {
              try {
                conn.socket.close(4100, "connector replaced");
              } catch {
                /* ignore */
              }
            }
          } else {
            // Name-based identity fallback: if the LAN agent starts without persisted id/token,
            // reclaim an existing connector with the same name instead of creating duplicates.
            const sameName = [...this.atemConnectors.values()].filter(
              (c) => connectorNameKey(c.name) === connectorNameKey(name),
            );
            const existingOnline = sameName.find((c) => c.socket && c.socket.readyState === 1);
            const existingOffline = sameName.find((c) => !c.socket || c.socket.readyState !== 1);
            conn =
              existingOnline ??
              existingOffline ?? {
                id: randomUUID(),
                name,
                token: randomBytes(24).toString("base64url"),
              };
            this.atemConnectors.set(conn.id, conn);

            // Collapse stale duplicate entries of the same name.
            for (const c of sameName) {
              if (c.id === conn.id) continue;
              for (const [sid, cid] of this.sessionAtemConnector.entries()) {
                if (cid === c.id) this.sessionAtemConnector.set(sid, conn.id);
              }
              this.atemConnectors.delete(c.id);
            }

            if (conn.socket && conn.socket !== ws && conn.socket.readyState === 1) {
              try {
                conn.socket.close(4100, "connector replaced by same-name register");
              } catch {
                /* ignore */
              }
            }
          }
          conn.name = name;
          conn.socket = ws;
          atemConnectorRoleId = conn.id;
          this.startConnectorPresence(conn.id);
          void this.refreshConnectorRedisMeta(conn.id).catch(() => {});
          ws.send(
            JSON.stringify({
              type: "atem_connector_ready",
              connectorId: conn.id,
              token: conn.token,
              name: conn.name,
            } satisfies RelayWireMessage),
          );
          break;
        }

        case "host_register": {
          const name = String(parsed.sessionName ?? "").trim().slice(0, 120);
          const deviceId = String(parsed.deviceId ?? "").trim().slice(0, 512);
          if (!name || !deviceId) {
            ws.close(4000, "bad host_register");
            return;
          }
          const sessionId = randomUUID();
          const edgeToken = randomBytes(24).toString("base64url");
          const room: Room = {
            sessionId,
            sessionName: name,
            deviceId,
            host: ws,
            clients: new Set(),
            edgeToken,
          };
          this.rooms.set(sessionId, room);
          role = "host";
          roomId = sessionId;
          room.hostPingInterval = setInterval(() => {
            if (ws.readyState !== 1) {
              if (room.hostPingInterval) clearInterval(room.hostPingInterval);
              return;
            }
            void this.refreshRedisMeta(room);
          }, 20000);
          void this.refreshRedisMeta(room);
          const planeCfg = this.getAtemPlaneConfig();
          ws.send(
            JSON.stringify({
              type: "hosted",
              sessionId,
              edgeToken,
              ...(planeCfg ? { atemPlaneSessionId: planeCfg.sessionId } : {}),
            } satisfies RelayWireMessage),
          );

          const acParsed = this.parseAtemCcuRaw((parsed as { atemCcu?: unknown }).atemCcu);
          if (acParsed && this.hubAtemBridgeAllowed()) {
            this.disposeAtemBridge(room);
            this.startAtemBridgeFromPayload(sessionId, room, acParsed);
          } else if ((parsed as { atemCcu?: unknown }).atemCcu && !this.hubAtemBridgeAllowed()) {
            ws.send(
              JSON.stringify({
                type: "atem_ccu_error",
                message:
                  "Hub ATEM TCP disabled (RELAY_ATEM_HUB_BRIDGE=0). Run the LAN edge agent with this session's edge token.",
              } satisfies RelayWireMessage),
            );
          } else if ((parsed as { atemCcu?: unknown }).atemCcu) {
            ws.send(JSON.stringify({ type: "atem_ccu_error", message: "Invalid atemCcu address or cameraId" }));
          }
          break;
        }

        case "host_atem_ccu_register": {
          const hostRoomId = [...this.rooms.entries()].find(([, rr]) => rr.host === ws)?.[0];
          if (!hostRoomId) return;
          const hostRoom = this.rooms.get(hostRoomId);
          if (!hostRoom || hostRoom.host !== ws) return;
          const acParsed = this.parseAtemCcuRaw((parsed as { atemCcu?: unknown }).atemCcu);
          if (!acParsed) {
            ws.send(JSON.stringify({ type: "atem_ccu_error", message: "Invalid atemCcu address or cameraId" }));
            return;
          }
          const connectorIdOpt = String((parsed as { connectorId?: unknown }).connectorId ?? "").trim();
          if (connectorIdOpt) {
            const conn = this.atemConnectors.get(connectorIdOpt);
            if (!conn?.socket || conn.socket.readyState !== 1) {
              ws.send(
                JSON.stringify({
                  type: "atem_ccu_error",
                  message: "That ATEM connector is offline. Start the LAN agent or refresh the list.",
                } satisfies RelayWireMessage),
              );
              return;
            }
            conn.target = {
              address: acParsed.address,
              cameraId: acParsed.cameraId,
              ...(acParsed.port !== undefined && Number.isFinite(acParsed.port) ? { port: acParsed.port } : {}),
            };
            void this.refreshConnectorRedisMeta(connectorIdOpt).catch(() => {});
            this.sessionAtemConnector.set(hostRoomId, connectorIdOpt);
            try {
              conn.socket.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: hostRoomId,
                  command: "connect",
                  atemCcu: acParsed,
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
            return;
          }
          this.ensureAtemPlaneRoom();
          const edgeRoom = this.edgeRoomForAtemOperator(hostRoom);
          if (edgeRoom.atemEdgeSocket && edgeRoom.atemEdgeSocket.readyState === 1) {
            try {
              edgeRoom.atemEdgeSocket.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: hostRoomId,
                  command: "connect",
                  atemCcu: acParsed,
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
            if (this.getAtemPlaneConfig() && edgeRoom.hiddenAtemPlane) {
              this.bumpAtemPlaneInterest(hostRoomId);
            }
            return;
          }
          if (!this.hubAtemBridgeAllowed()) {
            const planeHint = this.getAtemPlaneConfig()
              ? `RELAY_ATEM_PLANE_SESSION_ID / RELAY_ATEM_PLANE_EDGE_TOKEN on relay + LAN agent, or set RELAY_ATEM_HUB_BRIDGE=1.`
              : `npm run atem:edge-agent with this session's edge token from hosted, or set RELAY_ATEM_HUB_BRIDGE=1.`;
            ws.send(
              JSON.stringify({
                type: "atem_ccu_error",
                message: `No ATEM edge connected; run ${planeHint}`,
              } satisfies RelayWireMessage),
            );
            return;
          }
          this.disposeAtemBridge(hostRoom);
          hostRoom.atemJoinerSocket = undefined;
          this.startAtemBridgeFromPayload(hostRoomId, hostRoom, acParsed);
          break;
        }

        case "atem_edge_control": {
          const hostRoomId = [...this.rooms.entries()].find(([, rr]) => rr.host === ws)?.[0];
          if (!hostRoomId) return;
          const hostRoom = this.rooms.get(hostRoomId);
          if (!hostRoom || hostRoom.host !== ws) return;
          const cmd = (parsed as { command?: unknown }).command;
          if (cmd !== "connect" && cmd !== "disconnect" && cmd !== "restart") return;
          const connectorCtl = String((parsed as { connectorId?: unknown }).connectorId ?? "").trim();
          if (connectorCtl) {
            const conn = this.atemConnectors.get(connectorCtl);
            if (!conn?.socket || conn.socket.readyState !== 1) return;
            if (cmd === "connect") {
              const ac = this.parseAtemCcuRaw((parsed as { atemCcu?: unknown }).atemCcu);
              if (!ac) return;
              conn.target = {
                address: ac.address,
                cameraId: ac.cameraId,
                ...(ac.port !== undefined && Number.isFinite(ac.port) ? { port: ac.port } : {}),
              };
              void this.refreshConnectorRedisMeta(connectorCtl).catch(() => {});
              this.sessionAtemConnector.set(hostRoomId, connectorCtl);
              try {
                conn.socket.send(
                  JSON.stringify({
                    type: "atem_edge_control",
                    sessionId: hostRoomId,
                    command: "connect",
                    atemCcu: ac,
                  } satisfies RelayWireMessage),
                );
              } catch {
                /* ignore */
              }
            } else {
              try {
                conn.socket.send(
                  JSON.stringify({
                    type: "atem_edge_control",
                    sessionId: hostRoomId,
                    command: cmd,
                  } satisfies RelayWireMessage),
                );
              } catch {
                /* ignore */
              }
            }
            break;
          }
          this.ensureAtemPlaneRoom();
          const edgeRoom = this.edgeRoomForAtemOperator(hostRoom);
          if (!edgeRoom.atemEdgeSocket || edgeRoom.atemEdgeSocket.readyState !== 1) return;
          const edgeWs = edgeRoom.atemEdgeSocket;
          if (cmd === "connect") {
            const ac = this.parseAtemCcuRaw((parsed as { atemCcu?: unknown }).atemCcu);
            if (!ac) return;
            try {
              edgeWs.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: hostRoomId,
                  command: "connect",
                  atemCcu: ac,
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
            if (this.getAtemPlaneConfig() && edgeRoom.hiddenAtemPlane) {
              this.bumpAtemPlaneInterest(hostRoomId);
            }
          } else {
            try {
              edgeWs.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: hostRoomId,
                  command: cmd,
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
          }
          break;
        }

        case "atem_edge_register": {
          this.ensureAtemPlaneRoom();
          const regSid = String((parsed as { sessionId?: unknown }).sessionId ?? "").trim();
          const tok = String((parsed as { token?: unknown }).token ?? "").trim();
          const cfg = this.getAtemPlaneConfig();
          let regRoom =
            cfg && regSid === cfg.sessionId && tok === cfg.edgeToken ? this.getAtemPlaneRoom() : this.rooms.get(regSid);
          if (!regRoom?.edgeToken || regRoom.edgeToken !== tok) {
            try {
              ws.send(JSON.stringify({ type: "session_ended" } satisfies RelayWireMessage));
              ws.close(4003, "bad atem_edge_register");
            } catch {
              /* ignore */
            }
            return;
          }
          if (regRoom.atemEdgeSocket && regRoom.atemEdgeSocket !== ws && regRoom.atemEdgeSocket.readyState === 1) {
            try {
              ws.close(4009, "edge already connected");
            } catch {
              /* ignore */
            }
            return;
          }
          this.disposeAtemBridge(regRoom);
          regRoom.atemJoinerSocket = undefined;
          regRoom.atemHttpAttached = undefined;
          regRoom.atemEdgeSocket = ws;
          edgeRoomId = regRoom.sessionId;
          edgeRole = "atem_edge";
          ws.send(JSON.stringify({ type: "atem_edge_ready", sessionId: regRoom.sessionId } satisfies RelayWireMessage));
          void this.refreshRedisMeta(regRoom).catch(() => {});
          break;
        }

        case "joiner_atem_ccu_register": {
          const joinSid = this.findJoinerSession(ws);
          if (!joinSid) return;
          const joinRoom = this.rooms.get(joinSid);
          if (!joinRoom || !joinRoom.clients.has(ws)) return;
          const acParsed = this.parseAtemCcuRaw((parsed as { atemCcu?: unknown }).atemCcu);
          if (!acParsed) {
            ws.send(JSON.stringify({ type: "atem_ccu_error", message: "Invalid atemCcu address or cameraId" }));
            return;
          }
          const connectorIdJoin = String((parsed as { connectorId?: unknown }).connectorId ?? "").trim();
          if (connectorIdJoin) {
            const conn = this.atemConnectors.get(connectorIdJoin);
            if (!conn?.socket || conn.socket.readyState !== 1) {
              ws.send(
                JSON.stringify({
                  type: "atem_ccu_error",
                  message: "That ATEM connector is offline. Start the LAN agent or refresh the list.",
                } satisfies RelayWireMessage),
              );
              return;
            }
            conn.target = {
              address: acParsed.address,
              cameraId: acParsed.cameraId,
              ...(acParsed.port !== undefined && Number.isFinite(acParsed.port) ? { port: acParsed.port } : {}),
            };
            void this.refreshConnectorRedisMeta(connectorIdJoin).catch(() => {});
            this.sessionAtemConnector.set(joinSid, connectorIdJoin);
            try {
              conn.socket.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: joinSid,
                  command: "connect",
                  atemCcu: acParsed,
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
            return;
          }
          this.ensureAtemPlaneRoom();
          const edgeRoom = this.edgeRoomForAtemOperator(joinRoom);
          if (edgeRoom.atemEdgeSocket && edgeRoom.atemEdgeSocket.readyState === 1) {
            try {
              edgeRoom.atemEdgeSocket.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: joinSid,
                  command: "connect",
                  atemCcu: acParsed,
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
            if (this.getAtemPlaneConfig() && edgeRoom.hiddenAtemPlane) {
              this.bumpAtemPlaneInterest(joinSid);
            }
            return;
          }
          if (!this.hubAtemBridgeAllowed()) {
            const planeHint = this.getAtemPlaneConfig()
              ? `RELAY_ATEM_PLANE_SESSION_ID / RELAY_ATEM_PLANE_EDGE_TOKEN on relay + LAN agent, or set RELAY_ATEM_HUB_BRIDGE=1.`
              : `npm run atem:edge-agent with this session's edge token from hosted, or set RELAY_ATEM_HUB_BRIDGE=1.`;
            ws.send(
              JSON.stringify({
                type: "atem_ccu_error",
                message: `No ATEM edge connected; run ${planeHint}`,
              } satisfies RelayWireMessage),
            );
            return;
          }
          this.disposeAtemBridge(joinRoom);
          joinRoom.atemJoinerSocket = ws;
          this.startAtemBridgeFromPayload(joinSid, joinRoom, acParsed);
          break;
        }

        case "joiner_atem_ccu_stop": {
          const stopJoinSid = this.findJoinerSession(ws);
          if (!stopJoinSid) return;
          const stopJoinRoom = this.rooms.get(stopJoinSid);
          if (!stopJoinRoom || stopJoinRoom.atemJoinerSocket !== ws) return;

          const prevConnJoin = this.sessionAtemConnector.get(stopJoinSid);
          if (prevConnJoin !== undefined) {
            this.sessionAtemConnector.delete(stopJoinSid);
            this.maybeDisconnectConnector(prevConnJoin);
            stopJoinRoom.atemJoinerSocket = undefined;
            void this.refreshRedisMeta(stopJoinRoom).catch(() => {});
            if (ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({ type: "atem_ccu_link", connected: false } satisfies RelayWireMessage));
              } catch {
                /* ignore */
              }
            }
            return;
          }

          if (this.getAtemPlaneConfig()) {
            this.dropAtemPlaneInterest(stopJoinSid);
            stopJoinRoom.atemJoinerSocket = undefined;
            void this.refreshRedisMeta(this.getAtemPlaneRoom() ?? stopJoinRoom).catch(() => {});
            if (ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({ type: "atem_ccu_link", connected: false } satisfies RelayWireMessage));
              } catch {
                /* ignore */
              }
            }
            return;
          }

          if (stopJoinRoom.atemEdgeSocket && stopJoinRoom.atemEdgeSocket.readyState === 1) {
            try {
              stopJoinRoom.atemEdgeSocket.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: stopJoinSid,
                  command: "disconnect",
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
            stopJoinRoom.atemJoinerSocket = undefined;
            void this.refreshRedisMeta(stopJoinRoom);
            return;
          }
          this.disposeAtemBridge(stopJoinRoom);
          stopJoinRoom.atemJoinerSocket = undefined;
          void this.refreshRedisMeta(stopJoinRoom);
          if (ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({ type: "atem_ccu_link", connected: false } satisfies RelayWireMessage));
            } catch {
              /* ignore */
            }
          }
          break;
        }

        case "host_atem_ccu_stop": {
          const stopRoomId = [...this.rooms.entries()].find(([, rr]) => rr.host === ws)?.[0];
          if (!stopRoomId) return;
          const stopRoom = this.rooms.get(stopRoomId);
          if (!stopRoom || stopRoom.host !== ws) return;

          const prevConnHost = this.sessionAtemConnector.get(stopRoomId);
          if (prevConnHost !== undefined) {
            this.sessionAtemConnector.delete(stopRoomId);
            this.maybeDisconnectConnector(prevConnHost);
            void this.refreshRedisMeta(stopRoom).catch(() => {});
            if (ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({ type: "atem_ccu_link", connected: false } satisfies RelayWireMessage));
              } catch {
                /* ignore */
              }
            }
            return;
          }

          if (this.getAtemPlaneConfig()) {
            this.dropAtemPlaneInterest(stopRoomId);
            void this.refreshRedisMeta(this.getAtemPlaneRoom() ?? stopRoom).catch(() => {});
            if (ws.readyState === 1) {
              try {
                ws.send(JSON.stringify({ type: "atem_ccu_link", connected: false } satisfies RelayWireMessage));
              } catch {
                /* ignore */
              }
            }
            return;
          }

          if (stopRoom.atemEdgeSocket && stopRoom.atemEdgeSocket.readyState === 1) {
            try {
              stopRoom.atemEdgeSocket.send(
                JSON.stringify({
                  type: "atem_edge_control",
                  sessionId: stopRoomId,
                  command: "disconnect",
                } satisfies RelayWireMessage),
              );
            } catch {
              /* ignore */
            }
            void this.refreshRedisMeta(stopRoom);
            return;
          }
          this.disposeAtemBridge(stopRoom);
          void this.refreshRedisMeta(stopRoom);
          if (ws.readyState === 1) {
            try {
              ws.send(JSON.stringify({ type: "atem_ccu_link", connected: false } satisfies RelayWireMessage));
            } catch {
              /* ignore */
            }
          }
          break;
        }

        case "join": {
          const sessionId = String(parsed.sessionId ?? "").trim();
          if (!sessionId) {
            ws.close(4001, "missing sessionId");
            return;
          }
          const planeCfg = this.getAtemPlaneConfig();
          if (planeCfg && sessionId === planeCfg.sessionId) {
            try {
              ws.send(JSON.stringify({ type: "session_ended" } satisfies RelayWireMessage));
              ws.close(4004, "reserved session");
            } catch {
              /* ignore */
            }
            return;
          }
          let metaName = "";
          let metaDeviceId = "";
          let hasHost = false;
          const room = this.rooms.get(sessionId);
          if (room) {
            metaName = room.sessionName;
            metaDeviceId = room.deviceId;
            hasHost = !!room.host && room.host.readyState === 1;
          }
          if (!hasHost && this.redis) {
            const h = await this.redis.pub.hgetall(`${REDIS_PREFIX_SESSION}${sessionId}`);
            if (h.hasHost === "1") {
              hasHost = true;
              metaName = h.name ?? "";
              metaDeviceId = h.deviceId ?? "";
            }
          }
          if (!hasHost) {
            console.warn(
              `[relay] join rejected: no active host for session ${sessionId} (redis: ${this.redis ? "ok" : this.redisUrl ? "down/disabled" : "off"})`,
            );
            ws.send(JSON.stringify({ type: "session_ended" } satisfies RelayWireMessage));
            ws.close(4004, "session unavailable");
            return;
          }
          const r = room ?? this.ensureVirtualRoom(sessionId, metaName, metaDeviceId);
          r.clients.add(ws);
          role = "join";
          roomId = sessionId;
          ws.send(
            JSON.stringify({
              type: "joined",
              sessionName: metaName || r.sessionName,
              deviceId: metaDeviceId || r.deviceId,
            } satisfies RelayWireMessage),
          );
          break;
        }

        case "request_bootstrap": {
          const joinSessionId = this.findJoinerSession(ws);
          if (!joinSessionId) return;
          this.routeToHost(joinSessionId, raw);
          break;
        }

        case "host_ping": {
          const id = [...this.rooms.entries()].find(([, rr]) => rr.host === ws)?.[0];
          const r = id ? this.rooms.get(id) : undefined;
          if (r) void this.refreshRedisMeta(r);
          break;
        }

        case "host_stop": {
          const id = [...this.rooms.entries()].find(([, rr]) => rr.host === ws)?.[0];
          if (id) this.closeRoomAsHost(id);
          break;
        }

        case "forward_cmd": {
          const id = this.findSessionForSocket(ws);
          if (!id) return;
          const room = this.rooms.get(id);
          const hex =
            typeof (parsed as { hex?: unknown }).hex === "string"
              ? ((parsed as { hex: string }).hex as string)
              : "";
          const planeRoom = this.getAtemPlaneRoom();
          if (
            this.getAtemPlaneConfig() &&
            planeRoom?.atemEdgeSocket &&
            planeRoom.atemEdgeSocket.readyState === 1 &&
            (this.atemPlaneInterest.get(id) ?? 0) > 0 &&
            hex.trim() &&
            room
          ) {
            const isHost = room.host === ws;
            const isJoiner = room.clients.has(ws);
            if (isHost || (isJoiner && joinerForwardCmdPreferAtemBridge(hex))) {
              this.routeForwardCmdToAtemEdge(planeRoom, hex);
              return;
            }
          }
          const boundConnectorId = this.sessionAtemConnector.get(id);
          if (boundConnectorId && hex.trim() && room) {
            const cn = this.atemConnectors.get(boundConnectorId);
            if (cn?.socket?.readyState === 1) {
              const isHost = room.host === ws;
              const isJoiner = room.clients.has(ws);
              if (isHost || (isJoiner && joinerForwardCmdPreferAtemBridge(hex))) {
                this.routeForwardCmdToConnector(boundConnectorId, hex);
                return;
              }
            }
          }
          if (room?.atemEdgeSocket && room.atemEdgeSocket.readyState === 1 && hex.trim()) {
            const isHost = room.host === ws;
            const isJoiner = room.clients.has(ws);
            if (isHost || (isJoiner && joinerForwardCmdPreferAtemBridge(hex))) {
              this.routeForwardCmdToAtemEdge(room, hex);
              return;
            }
          }
          if (room?.atemBridge && hex.trim()) {
            const fromJoiner = room.clients.has(ws);
            if (!fromJoiner || joinerForwardCmdPreferAtemBridge(hex)) {
              void room.atemBridge.handleForwardCmdHex(hex).catch((err: unknown) => {
                console.warn("[relay] ATEM forward_cmd failed:", err);
              });
              return;
            }
          }
          if (room?.host === ws) return;
          this.routeToHost(id, raw);
          break;
        }

        case "host_power":
        case "host_pair":
        case "shared_session_dirty": {
          const id = this.findSessionForSocket(ws);
          if (!id) return;
          const room = this.rooms.get(id);
          if (room?.host === ws) return;
          this.routeToHost(id, raw);
          break;
        }

        case "status":
        case "incoming":
        case "bootstrap_snapshot":
        case "panel_sync": {
          const id = [...this.rooms.entries()].find(([, rr]) => rr.host === ws)?.[0];
          if (!id) return;
          this.routeToJoiners(id, raw);
          break;
        }

        default:
          break;
      }
    });
  }

  private ensureVirtualRoom(sessionId: string, sessionName: string, deviceId: string): Room {
    let r = this.rooms.get(sessionId);
    if (r) return r;
    r = { sessionId, sessionName, deviceId, clients: new Set() };
    this.rooms.set(sessionId, r);
    return r;
  }

  private findSessionForSocket(ws: WsType): string | undefined {
    for (const [sid, r] of this.rooms) {
      if (r.host === ws || r.clients.has(ws)) return sid;
    }
    return undefined;
  }

  private findJoinerSession(ws: WsType): string | undefined {
    for (const [sid, r] of this.rooms) {
      if (r.clients.has(ws)) return sid;
    }
    return undefined;
  }

  /** Push ATEM-derived CCU state to the hosting browser and all joiners. */
  emitPanelSyncFromAtem(sessionId: string, snapshot: Record<string, unknown>): void {
    const line = JSON.stringify({ type: "panel_sync", snapshot } satisfies RelayWireMessage);
    const room = this.rooms.get(sessionId);
    const h = room?.host;
    if (h && h.readyState === 1) {
      try {
        h.send(line);
      } catch {
        /* ignore */
      }
    }
    this.routeToJoiners(sessionId, line);
  }

  private closeRoomAsHost(sessionId: string): void {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    this.disposeAtemBridge(room);
    if (room.hostPingInterval) clearInterval(room.hostPingInterval);
    if (room.host) {
      try {
        room.host.close();
      } catch {
        /* ignore */
      }
    }
    room.host = undefined;
    for (const c of [...room.clients]) {
      try {
        c.send(JSON.stringify({ type: "session_ended" } satisfies RelayWireMessage));
        c.close();
      } catch {
        /* ignore */
      }
    }
    room.clients.clear();
    this.rooms.delete(sessionId);
    void this.deleteRedisMeta(sessionId);
  }

  private broadcastSessionEnded(sessionId: string): void {
    const line = JSON.stringify({ type: "session_ended" } satisfies RelayWireMessage);
    const r0 = this.rooms.get(sessionId);
    if (r0?.atemEdgeSocket?.readyState === 1) {
      try {
        r0.atemEdgeSocket.send(line);
      } catch {
        /* ignore */
      }
      try {
        r0.atemEdgeSocket.close();
      } catch {
        /* ignore */
      }
      r0.atemEdgeSocket = undefined;
      r0.edgeTcpLinked = undefined;
    }
    this.routeToJoiners(sessionId, line);
    const r = this.rooms.get(sessionId);
    if (!r) return;
    for (const c of [...r.clients]) {
      try {
        c.close();
      } catch {
        /* ignore */
      }
    }
    r.clients.clear();
    if (!r.host) {
      this.rooms.delete(sessionId);
      void this.deleteRedisMeta(sessionId);
    }
  }

  private routeToHost(sessionId: string, payload: string): void {
    const room = this.rooms.get(sessionId);
    if (room?.host && room.host.readyState === 1) {
      room.host.send(payload);
      return;
    }
    if (this.redis) {
      void this.redis.pub.publish(`bmrelay:in:${sessionId}`, payload);
    }
  }

  private deliverToLocalHost(sessionId: string, payload: string): void {
    const room = this.rooms.get(sessionId);
    const h = room?.host;
    if (h && h.readyState === 1) {
      h.send(payload);
    }
  }

  private routeToJoiners(sessionId: string, payload: string): void {
    if (this.redis) {
      void this.redis.pub.publish(`bmrelay:out:${sessionId}`, payload);
      return;
    }
    const room = this.rooms.get(sessionId);
    if (!room) return;
    for (const c of room.clients) {
      if (c.readyState === 1) c.send(payload);
    }
  }

  private deliverToLocalJoiners(sessionId: string, payload: string): void {
    const room = this.rooms.get(sessionId);
    if (!room) return;
    for (const c of room.clients) {
      if (c.readyState === 1) c.send(payload);
    }
  }

  private async refreshRedisMeta(room: Room): Promise<void> {
    await this.ensureRedis();
    if (!this.redis) return;
    const key = `${REDIS_PREFIX_SESSION}${room.sessionId}`;
    const hasHost = room.host && room.host.readyState === 1 ? "1" : "0";
    const multi = this.redis.pub.multi();
    multi.hset(key, "name", room.sessionName, "deviceId", room.deviceId, "hasHost", hasHost);
    if (room.atemBridge !== undefined) {
      multi.hset(key, "atemTcp", room.atemBridge.isTcpLinked ? "1" : "0");
    } else if (room.atemEdgeSocket !== undefined) {
      if (room.edgeTcpLinked === true) multi.hset(key, "atemTcp", "1");
      else if (room.edgeTcpLinked === false) multi.hset(key, "atemTcp", "0");
      else multi.hdel(key, "atemTcp");
    } else {
      multi.hdel(key, "atemTcp");
    }
    await multi.expire(key, REDIS_TTL_SEC).exec();
  }

  private async deleteRedisMeta(sessionId: string): Promise<void> {
    if (!this.redis) return;
    await this.redis.pub.del(`${REDIS_PREFIX_SESSION}${sessionId}`);
  }
}

function urlPath(urlish: string | undefined): string {
  try {
    return new URL(urlish ?? "", "http://localhost").pathname;
  } catch {
    return "";
  }
}
