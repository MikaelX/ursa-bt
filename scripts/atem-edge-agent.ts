#!/usr/bin/env npx tsx
/**
 * LAN ATEM connector — registers a **named** mixer bridge on the relay; CCU TCP stays on this machine.
 *
 *   CONNECTOR_NAME="Truck A" RELAY_URL=wss://bt.bm.almiro.se/api/relay/socket npm run atem:edge-agent
 *
 * Reconnect with stable id (persist `connectorId` + token from first `atem_connector_ready`):
 *   CONNECTOR_ID=… CONNECTOR_TOKEN=… CONNECTOR_NAME="Truck A" npm run atem:edge-agent
 *
 * Legacy session edge (`atem_edge_register`) still works with SESSION_ID + EDGE_TOKEN if CONNECTOR_NAME is unset.
 *
 * Verbose stderr (`[atem-edge] …`): `ATEM_EDGE_VERBOSE=1` or `true` — logs relay downlink types, connect targets,
 * and forward_cmd hex (truncated).
 *
 * @private
 */

import WebSocket from "ws";
import { BANKS_DEV_PORT } from "../src/banks/devServerPort.js";
import { AtemCcuRoomBridge } from "../server/atem/atemCcuRoomBridge.js";

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
    }
  | { mode: "legacy"; relayUrl: string; sessionId: string; token: string };

function parseCli(): Cli {
  const relayUrl =
    argvFlag("relay") ??
    process.env.RELAY_URL?.trim() ??
    process.env.RELAY_WS_URL?.trim() ??
    `ws://127.0.0.1:${BANKS_DEV_PORT}/api/relay/socket`;

  const connectorName =
    argvFlag("name") ?? process.env.CONNECTOR_NAME?.trim() ?? process.env.ATEM_CONNECTOR_NAME?.trim() ?? "";
  const connectorId = argvFlag("connector-id") ?? process.env.CONNECTOR_ID?.trim() ?? "";
  const connectorToken = argvFlag("connector-token") ?? process.env.CONNECTOR_TOKEN?.trim() ?? "";

  if (connectorName || connectorId) {
    return {
      mode: "connector",
      relayUrl,
      name: connectorName || "ATEM",
      ...(connectorId ? { connectorId } : {}),
      ...(connectorToken ? { token: connectorToken } : {}),
    };
  }

  const sessionId = argvFlag("session") ?? process.env.SESSION_ID?.trim() ?? "";
  const token = argvFlag("token") ?? process.env.EDGE_TOKEN?.trim() ?? "";
  if (!sessionId) throw new Error("Missing CONNECTOR_NAME or legacy SESSION_ID");
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

function main(): void {
  const cli = parseCli();
  console.error(
    `[atem-edge] relay ${cli.relayUrl} (${
      cli.mode === "connector" ? `connector "${cli.name}"` : `session ${cli.sessionId.slice(0, 8)}…`
    })`,
  );

  let bridge: AtemCcuRoomBridge | undefined;
  let lastAtem: AtemCcu | undefined;
  /** Set after `atem_connector_ready` (connector mode). */
  let activeConnectorId =
    cli.mode === "connector" && cli.connectorId ? cli.connectorId : "";

  const sock = new WebSocket(cli.relayUrl);

  const uplink = (type: string, body: Record<string, unknown>): void => {
    if (sock.readyState !== WebSocket.OPEN) return;
    try {
      if (cli.mode === "connector" && activeConnectorId) {
        sock.send(JSON.stringify({ type, connectorId: activeConnectorId, ...body }));
      } else if (cli.mode === "legacy") {
        sock.send(JSON.stringify({ type, sessionId: cli.sessionId, ...body }));
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
        uplink(
          cli.mode === "connector" ? "atem_connector_notify" : "atem_edge_notify",
          { kind: "error" as const, message },
        );
      },
      onHostLog: (message) => {
        uplink(
          cli.mode === "connector" ? "atem_connector_notify" : "atem_edge_notify",
          { kind: "log" as const, message },
        );
      },
    });
  };

  sock.addEventListener("open", () => {
    edgeLog("websocket open → register");
    if (cli.mode === "connector") {
      const reg: Record<string, unknown> = {
        type: "atem_connector_register",
        name: cli.name,
      };
      if (cli.connectorId && cli.token) {
        reg.connectorId = cli.connectorId;
        reg.token = cli.token;
      }
      sock.send(JSON.stringify(reg));
      edgeLog("sent atem_connector_register", { name: cli.name, reconnect: Boolean(cli.connectorId) });
      return;
    }
    sock.send(JSON.stringify({ type: "atem_edge_register", sessionId: cli.sessionId, token: cli.token }));
    edgeLog("sent atem_edge_register", { sessionPrefix: cli.sessionId.slice(0, 8) });
  });

  sock.addEventListener("message", (ev) => {
    let p: {
      type?: string;
      command?: string;
      atemCcu?: AtemCcu;
      hex?: string;
      connectorId?: string;
      token?: string;
      name?: string;
    };
    try {
      p = JSON.parse(String(ev.data)) as typeof p;
    } catch {
      return;
    }
    const t = p.type;
    edgeLog("inbound", { type: t ?? "(parse ok, no type)" });

    if (t === "atem_edge_forward_cmd" && typeof p.hex === "string") {
      const hex = p.hex.replace(/\s+/g, "");
      const preview = hex.length > 96 ? `${hex.slice(0, 96)}…` : hex;
      if (!bridge) {
        edgeLog("forward_cmd ignored (no ATEM bridge yet)", { hexLen: hex.length, preview });
        return;
      }
      edgeLog("forward_cmd → bridge", { hexLen: hex.length, preview });
      void bridge.handleForwardCmdHex(p.hex).catch((err: unknown) => {
        console.error("[atem-edge] forward_cmd", err);
      });
      return;
    }

    if (t === "atem_connector_ready" && typeof p.connectorId === "string") {
      activeConnectorId = p.connectorId;
      console.error(
        `[atem-edge] connector registered id=${p.connectorId} token=${p.token ?? "?"} name=${p.name ?? "?"}`,
      );
      edgeLog("connector ready (uplink id set)", { connectorId: p.connectorId });
      return;
    }

    if (t === "atem_edge_ready") {
      console.error("[atem-edge] registered (legacy session edge)");
      return;
    }

    if (t === "atem_edge_control") {
      const cmd = p.command;
      if (cmd === "connect" && p.atemCcu?.address && Number.isFinite(Number(p.atemCcu.cameraId))) {
        lastAtem = p.atemCcu;
        const tcpPort =
          p.atemCcu.port !== undefined && Number.isFinite(p.atemCcu.port) && p.atemCcu.port > 0
            ? Math.round(p.atemCcu.port)
            : 9910;
        edgeLog("atem_edge_control connect", {
          address: p.atemCcu.address.trim(),
          port: tcpPort,
          cameraId: p.atemCcu.cameraId,
        });
        bridge?.dispose();
        bridge = undefined;
        bridge = createBridge(p.atemCcu);
        void bridge.connect(p.atemCcu.address.trim(), tcpPort);
        return;
      }
      if (cmd === "disconnect") {
        edgeLog("atem_edge_control disconnect");
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
        void bridge.connect(lastAtem.address.trim(), tcpPort);
      }
      return;
    }

    if (t === "session_ended") {
      console.error("[atem-edge] session ended");
      bridge?.dispose();
      bridge = undefined;
      try {
        sock.close();
      } catch {
        /* ignore */
      }
      process.exit(0);
    }
  });

  sock.addEventListener("close", () => {
    bridge?.dispose();
    bridge = undefined;
    process.exit(1);
  });

  sock.addEventListener("error", (e) => {
    console.error("[atem-edge] socket error", e);
  });
}

main();
