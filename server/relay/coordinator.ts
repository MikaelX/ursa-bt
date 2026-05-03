import { randomUUID } from "node:crypto";
import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { URL } from "node:url";
import type { WebSocket as WsType } from "ws";
import { WebSocketServer } from "ws";
import { AtemCcuRoomBridge } from "../atem/atemCcuRoomBridge.js";

/**
 * @file coordinator.ts (`server/relay`)
 *
 * bm-bluetooth — WebSocket multiplexing between BLE-host browsers and relay join clients; optional Redis bridges replicas.
 */

const RELAY_PATH = "/api/relay/socket";

const REDIS_PREFIX_SESSION = "bmrelay:s:";
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
  | { type: "hosted"; sessionId: string }
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
  | { type: "atem_ccu_error"; message: string };

type Room = {
  sessionId: string;
  sessionName: string;
  deviceId: string;
  host?: WsType;
  clients: Set<WsType>;
  hostPingInterval?: ReturnType<typeof setInterval>;
  atemBridge?: AtemCcuRoomBridge;
};

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

export class RelayCoordinator {
  private readonly rooms = new Map<string, Room>();
  private readonly wss: WebSocketServer;
  private readonly redisUrl: string | undefined;
  private redis?: RedisPair;
  /** When set, `ensureRedis` skips new attempts until the clock passes this (retry after transient failure / boot race). */
  private redisRetryNotBeforeMs = 0;

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
    await this.ensureRedis();
    if (!this.redis) {
      return [...this.rooms.values()]
        .filter((r) => !!r.host)
        .map((r) => ({
          id: r.sessionId,
          name: r.sessionName,
          deviceId: r.deviceId,
          atemCcuTcp: r.atemBridge ? r.atemBridge.isTcpLinked : undefined,
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
        pub.once("ready", done);
        sub.once("ready", done);
      });
      await sub.psubscribe("bmrelay:in:*");
      await sub.psubscribe("bmrelay:out:*");
      sub.on("pmessage", (_pattern: string, channel: string, msg: string) => {
        const [, dir, ...restSid] = channel.split(":");
        const sessionId = restSid.join(":");
        if (!sessionId) return;
        if (dir === "in") this.deliverToLocalHost(sessionId, msg);
        else if (dir === "out") this.deliverToLocalJoiners(sessionId, msg);
      });
      this.redis = { pub, sub };
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

  private handleSocket(ws: WsType, _req: IncomingMessage): void {
    let roomId: string | undefined;
    let role: "host" | "join" | undefined;

    const teardownJoin = (): void => {
      if (!roomId || role !== "join") return;
      const room = this.rooms.get(roomId);
      if (!room) return;
      room.clients.delete(ws);
      void this.refreshRedisMeta(room).catch(() => {});
      if (!room.host && room.clients.size === 0) {
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
        if (room.atemBridge) {
          room.atemBridge.dispose();
          room.atemBridge = undefined;
        }
        if (room.hostPingInterval) clearInterval(room.hostPingInterval);
        room.host = undefined;
        void this.refreshRedisMeta(room).catch(() => {});
        this.broadcastSessionEnded(room.sessionId);
      }
      if (room && !room.host && room.clients.size === 0) {
        this.rooms.delete(room.sessionId);
        void this.deleteRedisMeta(room.sessionId).catch(() => {});
      }
      roomId = undefined;
      role = undefined;
    };

    ws.on("close", () => {
      teardownJoin();
      teardownHost();
    });

    ws.on("message", async (data, isBinary) => {
      if (isBinary) return;
      const raw = data.toString();
      const parsed = safeJsonParse(raw);
      if (!isRelayWireMessage(parsed)) return;

      switch (parsed.type) {
        case "host_register": {
          const name = String(parsed.sessionName ?? "").trim().slice(0, 120);
          const deviceId = String(parsed.deviceId ?? "").trim().slice(0, 512);
          if (!name || !deviceId) {
            ws.close(4000, "bad host_register");
            return;
          }
          const sessionId = randomUUID();
          const room: Room = {
            sessionId,
            sessionName: name,
            deviceId,
            host: ws,
            clients: new Set(),
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
          ws.send(JSON.stringify({ type: "hosted", sessionId } satisfies RelayWireMessage));

          const acRaw = (parsed as { atemCcu?: unknown }).atemCcu;
          if (acRaw && typeof acRaw === "object" && acRaw !== null) {
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
              ac.inputs !== undefined && ac.inputs !== null
                ? Math.round(Number(ac.inputs))
                : undefined;
            if (!address || !Number.isFinite(cameraId) || cameraId < 1 || cameraId > 24) {
              ws.send(JSON.stringify({ type: "atem_ccu_error", message: "Invalid atemCcu address or cameraId" }));
              break;
            }
            const tcpPort = port !== undefined && Number.isFinite(port) && port > 0 ? port : 9910;
            const inputSlots = Math.min(32, Math.max(4, inputs ?? 16));
            const bridge = new AtemCcuRoomBridge(cameraId, inputSlots, {
              emitPanelSync: (snapshot) => this.emitPanelSyncFromAtem(sessionId, snapshot),
              hostSocket: () => room.host,
              onAtemTcpLinkChange: (linked) => {
                const h = room.host;
                if (h?.readyState === 1) {
                  try {
                    h.send(
                      JSON.stringify({
                        type: "atem_ccu_link",
                        connected: linked,
                        address: linked ? address : undefined,
                        cameraId: linked ? cameraId : undefined,
                      } satisfies RelayWireMessage),
                    );
                  } catch {
                    /* ignore */
                  }
                }
                void this.refreshRedisMeta(room);
              },
            });
            room.atemBridge = bridge;
            void bridge.connect(address, tcpPort);
          }
          break;
        }

        case "join": {
          const sessionId = String(parsed.sessionId ?? "").trim();
          if (!sessionId) {
            ws.close(4001, "missing sessionId");
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
          if (room?.atemBridge && hex.trim()) {
            void room.atemBridge.handleForwardCmdHex(hex).catch((err: unknown) => {
              console.warn("[relay] ATEM forward_cmd failed:", err);
            });
            return;
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
          if (room?.atemBridge && parsed.type !== "shared_session_dirty") {
            return;
          }
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
    if (room.atemBridge) {
      room.atemBridge.dispose();
      room.atemBridge = undefined;
    }
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
