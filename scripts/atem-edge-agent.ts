#!/usr/bin/env npx tsx
/**
 * LAN ATEM connector — registers a **named** mixer bridge on the relay; CCU TCP stays on this machine.
 *
 *   CONNECTOR_NAME="Truck A" ATEM_SWITCHER_ADDRESS=10.0.0.13 npm run atem:edge-agent
 *   (defaults to relay wss://bt.bm.almiro.se — set ENVIRONMENT=LOCAL for ws://127.0.0.1:9132)
 *   (`CONNECTION_NAME` is accepted as a typo alias for `CONNECTOR_NAME`.)
 *
 * Reconnect with stable id (persist `connectorId` + token from first `atem_connector_ready`):
 *   CONNECTOR_ID=… CONNECTOR_TOKEN=… CONNECTOR_NAME="Truck A" npm run atem:edge-agent
 *
 * Legacy session edge (`atem_edge_register`) still works with SESSION_ID + EDGE_TOKEN if CONNECTOR_NAME is unset.
 *
 * Verbose relay stderr (`[atem-edge] …`): `ATEM_EDGE_VERBOSE=1` or `true`.
 * Switcher TCP + CCU traffic (`[atem-switcher] …`, `[atem-raw] …`): on by default; `ATEM_EDGE_SWITCHER_LOG=0` to disable.
 *
 * @private
 */

import WebSocket from "ws";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BANKS_DEV_PORT } from "../src/banks/devServerPort.js";
import { AtemCcuRoomBridge } from "../server/atem/atemCcuRoomBridge.js";

const DEFAULT_RELAY_WS = "wss://bt.bm.almiro.se/api/relay/socket";

function defaultRelayUrl(): string {
  if (process.env.ENVIRONMENT?.trim().toUpperCase() === "LOCAL") {
    return `ws://127.0.0.1:${BANKS_DEV_PORT}/api/relay/socket`;
  }
  return DEFAULT_RELAY_WS;
}

function isLocalRelayUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "127.0.0.1" || h === "localhost" || h === "::1";
  } catch {
    return false;
  }
}

function argvFlag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return undefined;
}

type Cli =
  | {
      mode: "connector";
      relayUrl: string;
      name: string;
      connectorId?: string;
      token?: string;
      stateFile?: string;
      defaultAddress?: string;
      defaultPort?: number;
    }
  | { mode: "legacy"; relayUrl: string; sessionId: string; token: string };

function connectorStateFile(name: string): string {
  const fromEnv = process.env.ATEM_EDGE_STATE_FILE?.trim();
  if (fromEnv) return fromEnv;
  const safe = name.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return path.resolve(process.cwd(), `.atem-edge-${safe || "connector"}.json`);
}

function connectorLockFile(name: string): string {
  return connectorStateFile(name).replace(/\.json$/, ".lock");
}

function connectorLockEnabled(): boolean {
  return process.env.ATEM_EDGE_NO_LOCK !== "1";
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One edge agent per connector name on this machine — stops token/replace loops from duplicate processes. */
function acquireConnectorLock(name: string): void {
  if (!connectorLockEnabled()) return;
  const lockPath = connectorLockFile(name);
  if (existsSync(lockPath)) {
    try {
      const firstLine = readFileSync(lockPath, "utf8").trim().split("\n")[0] ?? "";
      const pid = Number(firstLine.split(/\s+/)[0]);
      if (Number.isFinite(pid) && pid !== process.pid && pidAlive(pid)) {
        console.error(
          `[atem-edge] another edge agent for "${name}" is already running (pid ${pid}). Stop it before starting another.`,
        );
        process.exit(1);
      }
    } catch {
      /* stale lock */
    }
  }
  writeFileSync(lockPath, `${process.pid} ${new Date().toISOString()}\n`, "utf8");
  const release = (): void => {
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      /* ignore */
    }
  };
  process.on("exit", release);
  process.on("SIGINT", () => {
    release();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    release();
    process.exit(0);
  });
}

function loadConnectorState(filePath: string): { connectorId: string; token: string } | undefined {
  try {
    if (!existsSync(filePath)) return undefined;
    const raw = JSON.parse(readFileSync(filePath, "utf8")) as { connectorId?: unknown; token?: unknown };
    const connectorId = String(raw.connectorId ?? "").trim();
    const token = String(raw.token ?? "").trim();
    if (!connectorId || !token) return undefined;
    return { connectorId, token };
  } catch {
    return undefined;
  }
}

function saveConnectorState(filePath: string, connectorId: string, token: string): void {
  try {
    writeFileSync(
      filePath,
      `${JSON.stringify({ connectorId, token, savedAt: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch (err) {
    console.error(`[atem-edge] failed to save connector state ${filePath}:`, errorText(err));
  }
}

function parseCli(): Cli {
  const relayUrl =
    argvFlag("relay") ??
    process.env.RELAY_URL?.trim() ??
    process.env.RELAY_WS_URL?.trim() ??
    defaultRelayUrl();

  const connectorName =
    argvFlag("name") ??
    process.env.CONNECTOR_NAME?.trim() ??
    process.env.CONNECTION_NAME?.trim() /* common typo of CONNECTOR_NAME */ ??
    process.env.ATEM_CONNECTOR_NAME?.trim() ??
    "";
  let connectorId = argvFlag("connector-id") ?? process.env.CONNECTOR_ID?.trim() ?? "";
  let connectorToken = argvFlag("connector-token") ?? process.env.CONNECTOR_TOKEN?.trim() ?? "";
  const defaultAddress =
    argvFlag("switcher") ??
    process.env.ATEM_SWITCHER_ADDRESS?.trim() ??
    process.env.ATEM_DEFAULT_ADDRESS?.trim() ??
    "";
  const defaultPortRaw =
    argvFlag("switcher-port") ?? process.env.ATEM_SWITCHER_PORT?.trim() ?? "";
  const defaultPort =
    defaultPortRaw && Number.isFinite(Number(defaultPortRaw)) && Number(defaultPortRaw) > 0
      ? Math.round(Number(defaultPortRaw))
      : undefined;

  if (connectorName || connectorId) {
    const stateFile = connectorStateFile(connectorName || "ATEM");
    if (!connectorId || !connectorToken) {
      const persisted = loadConnectorState(stateFile);
      if (persisted) {
        if (!connectorId) connectorId = persisted.connectorId;
        if (!connectorToken) connectorToken = persisted.token;
      }
    }
    return {
      mode: "connector",
      relayUrl,
      name: connectorName || "ATEM",
      ...(connectorId ? { connectorId } : {}),
      ...(connectorToken ? { token: connectorToken } : {}),
      ...(stateFile ? { stateFile } : {}),
      ...(defaultAddress ? { defaultAddress } : {}),
      ...(defaultPort !== undefined ? { defaultPort } : {}),
    };
  }

  const sessionId = argvFlag("session") ?? process.env.SESSION_ID?.trim() ?? "";
  const token = argvFlag("token") ?? process.env.EDGE_TOKEN?.trim() ?? "";
  if (!sessionId) {
    throw new Error(
      "Set CONNECTOR_NAME (or CONNECTION_NAME), or legacy SESSION_ID + EDGE_TOKEN — see script header.",
    );
  }
  if (!token) throw new Error("Missing legacy EDGE_TOKEN (from hosted message)");
  return { mode: "legacy", relayUrl, sessionId, token };
}

type AtemCcu = { address: string; port?: number; cameraId: number; inputs?: number };

function inputSlots(ac: AtemCcu): number {
  if (ac.inputs !== undefined && Number.isFinite(ac.inputs)) {
    return Math.min(32, Math.max(4, Math.round(ac.inputs)));
  }
  return 16;
}

function edgeVerbose(): boolean {
  const v = process.env.ATEM_EDGE_VERBOSE ?? "";
  return v === "1" || v.toLowerCase() === "true";
}

function edgeLog(...args: unknown[]): void {
  if (!edgeVerbose()) return;
  console.error("[atem-edge]", ...args);
}

/** Switcher TCP + CCU traffic to stderr (helper log window). Default on; `ATEM_EDGE_SWITCHER_LOG=0` to disable. */
function switcherLogEnabled(): boolean {
  const v = process.env.ATEM_EDGE_SWITCHER_LOG ?? "1";
  return v !== "0" && v.toLowerCase() !== "false";
}

function switcherLog(message: string): void {
  if (!switcherLogEnabled()) return;
  const line = message.length > 4000 ? `${message.slice(0, 4000)}…` : message;
  console.error(`[atem-switcher] ${line}`);
}

function trimLogPayload(raw: string, max = 4000): string {
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = err.cause instanceof Error ? ` (cause: ${err.cause.message})` : "";
    return `${err.name}: ${err.message || "(no message)"}${cause}`;
  }
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    const o = err as Record<string, unknown>;
    if (typeof o.message === "string" && o.message.trim()) return o.message.trim();
    const nested = o.error;
    if (nested instanceof Error) return errorText(nested);
    if (typeof nested === "object" && nested !== null) {
      const nestedText = errorText(nested);
      if (nestedText && nestedText !== "{}") return nestedText;
    }
    const code = o.code ?? o.errno;
    if (code !== undefined) return `code=${String(code)}`;
  }
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    /* ignore */
  }
  return String(err);
}

function relayUnreachableHint(relayUrl: string, closeCode?: number): string | undefined {
  if (closeCode !== 1006 && closeCode !== undefined) return undefined;
  if (!isLocalRelayUrl(relayUrl)) return undefined;
  return (
    `No relay at ${relayUrl} — run \`npm run dev:server\`, set ENVIRONMENT=LOCAL, ` +
    `or RELAY_URL=${DEFAULT_RELAY_WS}`
  );
}

function main(): void {
  const cli = parseCli();
  if (cli.mode === "connector") {
    acquireConnectorLock(cli.name);
  }
  console.error(
    `[atem-edge] relay ${cli.relayUrl} (${
      cli.mode === "connector" ? `connector "${cli.name}"` : `session ${cli.sessionId.slice(0, 8)}…`
    })`,
  );
  if (cli.mode === "connector") {
    if (cli.connectorId) {
      console.error(`[atem-edge] connector identity: reuse id=${cli.connectorId}`);
    } else {
      console.error("[atem-edge] connector identity: new (no saved id/token)");
    }
    if (cli.stateFile) {
      console.error(`[atem-edge] connector state file: ${cli.stateFile}`);
    }
    if (cli.defaultAddress) {
      console.error(
        `[atem-edge] default switcher: ${cli.defaultAddress}${cli.defaultPort ? `:${cli.defaultPort}` : ""}`,
      );
    }
    console.error("[atem-edge] waiting for atem_edge_control connect from relay…");
  }

  let bridge: AtemCcuRoomBridge | undefined;
  let lastAtem: AtemCcu | undefined;
  let lastConnectTarget: { address: string; port: number; cameraId: number } | undefined;
  let connectorReady = false;
  /** Set after `atem_connector_ready` (connector mode). */
  let activeConnectorId = cli.mode === "connector" && cli.connectorId ? cli.connectorId : "";
  /** Mutable connector creds for reconnect attempts (may be cleared on auth reject). */
  let reconnectConnectorId = cli.mode === "connector" && cli.connectorId ? cli.connectorId : "";
  let reconnectConnectorToken = cli.mode === "connector" && cli.token ? cli.token : "";
  let reconnectAttempts = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let shuttingDown = false;
  let sock: WebSocket | undefined;

  const clearConnectorIdentity = (reason: string): void => {
    if (cli.mode !== "connector") return;
    reconnectConnectorId = "";
    reconnectConnectorToken = "";
    activeConnectorId = "";
    connectorReady = false;
    if (cli.stateFile && existsSync(cli.stateFile)) {
      try {
        unlinkSync(cli.stateFile);
        console.error(`[atem-edge] ${reason} — cleared ${cli.stateFile}`);
      } catch (err) {
        console.error("[atem-edge] failed to clear connector identity:", errorText(err));
      }
    } else {
      console.error(`[atem-edge] ${reason}`);
    }
  };

  const uplink = (type: string, body: Record<string, unknown>): void => {
    const ws = sock;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      if (cli.mode === "connector" && activeConnectorId) {
        ws.send(JSON.stringify({ type, connectorId: activeConnectorId, ...body }));
      } else if (cli.mode === "legacy") {
        ws.send(JSON.stringify({ type, sessionId: cli.sessionId, ...body }));
      }
    } catch {
      /* ignore */
    }
  };

  const createBridge = (ac: AtemCcu): AtemCcuRoomBridge => {
    const addr = ac.address.trim();
    const cam = Math.round(Number(ac.cameraId));
    return new AtemCcuRoomBridge(cam, inputSlots(ac), {
      emitPanelSync: (snapshot) => {
        uplink(
          cli.mode === "connector" ? "atem_connector_panel_sync" : "atem_edge_panel_sync",
          { snapshot },
        );
      },
      hostSocket: () => undefined,
      onAtemTcpLinkChange: (linked) => {
        const target = lastConnectTarget;
        if (target) {
          switcherLog(
            `TCP ${linked ? "UP" : "DOWN"} ${target.address}:${target.port} (camera ${target.cameraId})`,
          );
        } else {
          switcherLog(`TCP ${linked ? "UP" : "DOWN"}`);
        }
        const payload = {
          connected: linked,
          address: linked ? addr : undefined,
          cameraId: linked ? cam : undefined,
        };
        uplink(
          cli.mode === "connector" ? "atem_connector_link" : "atem_edge_link",
          payload,
        );
      },
      notifyHost: (message) => {
        console.error("[atem-edge] bridge error:", message);
        uplink(
          cli.mode === "connector" ? "atem_connector_notify" : "atem_edge_notify",
          { kind: "error" as const, message },
        );
      },
      onHostLog: (message) => {
        switcherLog(message);
        edgeLog("bridge log:", message);
        uplink(
          cli.mode === "connector" ? "atem_connector_notify" : "atem_edge_notify",
          { kind: "log" as const, message },
        );
      },
    });
  };

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== undefined) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
  };

  const scheduleReconnect = (reason: string): void => {
    if (shuttingDown) return;
    if (cli.mode === "legacy") {
      process.exit(1);
      return;
    }
    if (reconnectTimer !== undefined) return;
    reconnectAttempts += 1;
    const delayMs = Math.min(15_000, 1000 * Math.min(reconnectAttempts, 10));
    console.error(`[atem-edge] relay reconnect in ${Math.round(delayMs / 1000)}s (${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connectRelay();
    }, delayMs);
  };

  const connectRelay = (): void => {
    connectorReady = false;
    clearReconnectTimer();
    const ws = new WebSocket(cli.relayUrl);
    sock = ws;

    ws.addEventListener("open", () => {
      if (sock !== ws) return;
      reconnectAttempts = 0;
      edgeLog("websocket open → register");
      if (cli.mode === "connector") {
        const reg: Record<string, unknown> = {
          type: "atem_connector_register",
          name: cli.name,
        };
        if (reconnectConnectorId && reconnectConnectorToken) {
          reg.connectorId = reconnectConnectorId;
          reg.token = reconnectConnectorToken;
        }
        if (cli.defaultAddress) reg.defaultAddress = cli.defaultAddress;
        if (cli.defaultPort !== undefined) reg.defaultPort = cli.defaultPort;
        ws.send(JSON.stringify(reg));
        edgeLog("sent atem_connector_register", { name: cli.name, reconnect: Boolean(reg.connectorId) });
        return;
      }
      ws.send(JSON.stringify({ type: "atem_edge_register", sessionId: cli.sessionId, token: cli.token }));
      edgeLog("sent atem_edge_register", { sessionPrefix: cli.sessionId.slice(0, 8) });
    });

    ws.addEventListener("message", (ev) => {
      if (sock !== ws) return;
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      edgeLog("inbound raw", trimLogPayload(raw));
      let p: {
        type?: string;
        command?: string;
        sessionId?: string;
        atemCcu?: AtemCcu;
        hex?: string;
        connectorId?: string;
        token?: string;
        name?: string;
      };
      try {
        p = JSON.parse(raw) as typeof p;
      } catch {
        edgeLog("inbound parse failed");
        return;
      }
      const t = p.type;
      edgeLog("inbound parsed", p);
      edgeLog("inbound", { type: t ?? "(parse ok, no type)" });

      if (t === "atem_edge_forward_cmd" && typeof p.hex === "string") {
        const hex = p.hex.replace(/\s+/g, "");
        const preview = hex.length > 96 ? `${hex.slice(0, 96)}…` : hex;
        if (!bridge) {
          switcherLog(`TX ignored (no switcher TCP yet) ${hex.length} bytes ${preview}`);
          edgeLog("forward_cmd ignored (no ATEM bridge yet)", { hexLen: hex.length, preview });
          return;
        }
        switcherLog(`TX → switcher ${hex.length} bytes ${preview}`);
        edgeLog("forward_cmd → bridge", { hexLen: hex.length, preview });
        void bridge.handleForwardCmdHex(p.hex).catch((err: unknown) => {
          switcherLog(`TX failed: ${errorText(err)}`);
          console.error("[atem-edge] forward_cmd", err);
        });
        return;
      }

      if (t === "atem_connector_ready" && typeof p.connectorId === "string") {
        activeConnectorId = p.connectorId;
        reconnectConnectorId = p.connectorId;
        connectorReady = true;
        if (typeof p.token === "string" && p.token.trim()) reconnectConnectorToken = p.token.trim();
        console.error(
          `[atem-edge] connector registered id=${p.connectorId} token=${p.token ?? "?"} name=${p.name ?? "?"}`,
        );
        if (cli.mode === "connector" && cli.stateFile && reconnectConnectorToken) {
          saveConnectorState(cli.stateFile, p.connectorId, reconnectConnectorToken);
          console.error(`[atem-edge] connector identity saved: ${cli.stateFile}`);
        }
        edgeLog("connector ready (uplink id set)", { connectorId: p.connectorId });
        return;
      }

      if (t === "atem_edge_ready") {
        console.error("[atem-edge] registered (legacy session edge)");
        return;
      }

      if (t === "atem_edge_control") {
        const cmd = p.command;
        const fromSession = typeof p.sessionId === "string" && p.sessionId.trim() ? p.sessionId.trim() : undefined;
        if (cmd === "connect" && p.atemCcu?.address && Number.isFinite(Number(p.atemCcu.cameraId))) {
          lastAtem = p.atemCcu;
          const tcpPort =
            p.atemCcu.port !== undefined && Number.isFinite(p.atemCcu.port) && p.atemCcu.port > 0
              ? Math.round(p.atemCcu.port)
              : 9910;
          const targetAddress = p.atemCcu.address.trim();
          const targetCameraId = Math.round(Number(p.atemCcu.cameraId));
          lastConnectTarget = { address: targetAddress, port: tcpPort, cameraId: targetCameraId };
          switcherLog(
            `connect requested ${targetAddress}:${tcpPort} (camera ${targetCameraId})${
              fromSession ? ` from session ${fromSession}` : ""
            }`,
          );
          edgeLog("atem_edge_control connect", {
            address: targetAddress,
            port: tcpPort,
            cameraId: p.atemCcu.cameraId,
          });
          bridge?.dispose();
          bridge = undefined;
          bridge = createBridge(p.atemCcu);
          void bridge.connect(targetAddress, tcpPort);
          return;
        }
        if (cmd === "disconnect") {
          edgeLog("atem_edge_control disconnect");
          if (lastConnectTarget) {
            switcherLog(
              `disconnect requested ${lastConnectTarget.address}:${lastConnectTarget.port} (camera ${lastConnectTarget.cameraId})${
                fromSession ? ` from session ${fromSession}` : ""
              }`,
            );
          } else {
            switcherLog(`disconnect requested${fromSession ? ` from session ${fromSession}` : ""}`);
          }
          bridge?.dispose();
          bridge = undefined;
          return;
        }
        if (cmd === "restart" && lastAtem) {
          edgeLog("atem_edge_control restart");
          bridge?.dispose();
          bridge = undefined;
          bridge = createBridge(lastAtem);
          const tcpPort =
            lastAtem.port !== undefined && Number.isFinite(lastAtem.port) && lastAtem.port > 0
              ? Math.round(lastAtem.port)
              : 9910;
          const targetAddress = lastAtem.address.trim();
          const targetCameraId = Math.round(Number(lastAtem.cameraId));
          lastConnectTarget = { address: targetAddress, port: tcpPort, cameraId: targetCameraId };
          switcherLog(
            `restart requested ${targetAddress}:${tcpPort} (camera ${targetCameraId})${
              fromSession ? ` from session ${fromSession}` : ""
            }`,
          );
          void bridge.connect(targetAddress, tcpPort);
        }
        return;
      }

      if (t === "session_ended") {
        if (cli.mode === "connector") {
          const hadReconnectCreds = Boolean(reconnectConnectorId && reconnectConnectorToken);
          if (hadReconnectCreds) {
            clearConnectorIdentity(
              "connector auth rejected (stale token on relay — another instance or relay restart?)",
            );
            console.error("[atem-edge] retrying connector register with fresh identity");
          } else {
            console.error("[atem-edge] session ended (connector mode) — reconnecting");
          }
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        shuttingDown = true;
        console.error("[atem-edge] session ended");
        bridge?.dispose();
        bridge = undefined;
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        process.exit(0);
      }
    });

    ws.on("close", (code, reason) => {
      if (sock !== ws) return;
      const reasonText = typeof reason === "string" ? reason : Buffer.from(reason).toString("utf8");
      console.error(`[atem-edge] relay socket closed code=${code} reason=${reasonText || "(empty)"}`);
      if (cli.mode === "connector") {
        if (code === 4003) {
          clearConnectorIdentity("bad connector token from relay");
        } else if (code === 4100 || reasonText.toLowerCase().includes("replaced")) {
          clearConnectorIdentity("connector replaced on relay (duplicate edge agent?)");
        }
      }
      const hint = relayUnreachableHint(cli.relayUrl, code);
      if (hint) console.error(`[atem-edge] ${hint}`);
      bridge?.dispose();
      bridge = undefined;
      if (shuttingDown) return;
      scheduleReconnect(`close ${code}`);
    });

    ws.addEventListener("error", (e) => {
      if (sock !== ws) return;
      const detail = errorText(e);
      console.error(`[atem-edge] relay socket error: ${detail}`);
      const hint = relayUnreachableHint(cli.relayUrl);
      if (hint) console.error(`[atem-edge] ${hint}`);
    });

    ws.on("unexpected-response", (_req, res) => {
      if (sock !== ws) return;
      console.error(
        `[atem-edge] relay handshake failed: HTTP ${res.statusCode ?? "?"} ${res.statusMessage ?? ""}`,
      );
    });
  };

  connectRelay();

  process.on("unhandledRejection", (reason) => {
    console.error("[atem-edge] unhandled rejection:", errorText(reason));
  });
  process.on("uncaughtException", (err) => {
    console.error("[atem-edge] uncaught exception:", errorText(err));
  });
}

main();
