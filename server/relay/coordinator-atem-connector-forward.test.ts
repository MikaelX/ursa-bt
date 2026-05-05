/**
 * Relay ↔ named ATEM connector (LAN edge) wire protocol: no real switcher TCP.
 */
import http from "node:http";
import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { commands, toHex } from "../../src/blackmagic/protocol.js";
import { RelayCoordinator } from "./coordinator.js";

const RELAY_PATH = "/api/relay/socket";

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}${RELAY_PATH}`;
}

function msgStr(data: WebSocket.RawData): string {
  return typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
}

async function nextJson(
  ws: WebSocket,
  pred: (o: Record<string, unknown>) => boolean,
  ms: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup();
      reject(new Error("timeout waiting for relay message"));
    }, ms);
    const onMsg = (data: WebSocket.RawData): void => {
      let o: Record<string, unknown>;
      try {
        o = JSON.parse(msgStr(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (pred(o)) {
        cleanup();
        resolve(o);
      }
    };
    const cleanup = (): void => {
      clearTimeout(t);
      ws.off("message", onMsg);
    };
    ws.on("message", onMsg);
  });
}

describe("RelayCoordinator named ATEM connector", () => {
  let server: http.Server | undefined;
  let coordinator: RelayCoordinator | undefined;

  afterEach(async () => {
    if (coordinator) await coordinator.destroy().catch(() => {});
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it("routes host_atem_ccu_register to connector and forward_cmd as atem_edge_forward_cmd", async () => {
    coordinator = new RelayCoordinator(undefined);
    server = http.createServer();
    coordinator.attachToHttpServer(server);
    await new Promise<void>((resolve, reject) => {
      server.listen(0, "127.0.0.1", () => resolve());
      server.on("error", reject);
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP port");

    const url = wsUrl(addr.port);
    const connector = new WebSocket(url);
    const host = new WebSocket(url);
    const joiner = new WebSocket(url);

    await Promise.all([
      new Promise<void>((r, j) => connector.once("open", () => r())),
      new Promise<void>((r, j) => host.once("open", () => r())),
      new Promise<void>((r, j) => joiner.once("open", () => r())),
    ]);

    connector.send(JSON.stringify({ type: "atem_connector_register", name: "vitest-connector" }));
    const ready = (await nextJson(
      connector,
      (o) => o.type === "atem_connector_ready" && typeof o.connectorId === "string",
      5000,
    )) as { type: string; connectorId: string; token: string };
    const { connectorId } = ready;

    host.send(
      JSON.stringify({
        type: "host_register",
        sessionName: `vitest-${Date.now()}`,
        deviceId: "vitest-device",
      }),
    );
    const hosted = (await nextJson(host, (o) => o.type === "hosted" && typeof o.sessionId === "string", 5000)) as {
      sessionId: string;
    };
    const { sessionId } = hosted;

    const connectPromise = nextJson(
      connector,
      (o) => o.type === "atem_edge_control" && o.command === "connect" && o.atemCcu,
      5000,
    );

    host.send(
      JSON.stringify({
        type: "host_atem_ccu_register",
        connectorId,
        atemCcu: { address: "192.0.2.1", cameraId: 1 },
      }),
    );

    const edgeCtl = await connectPromise;
    expect(edgeCtl).toMatchObject({
      type: "atem_edge_control",
      command: "connect",
      atemCcu: { address: "192.0.2.1", cameraId: 1 },
    });

    joiner.send(JSON.stringify({ type: "join", sessionId }));

    await nextJson(joiner, (o) => o.type === "joined", 5000);

    const gainHex = toHex(commands.gain(12));
    const fwdPromise = nextJson(
      connector,
      (o) => o.type === "atem_edge_forward_cmd" && typeof o.hex === "string",
      5000,
    );

    joiner.send(JSON.stringify({ type: "forward_cmd", hex: gainHex }));

    const fwd = await fwdPromise;
    expect(fwd.type).toBe("atem_edge_forward_cmd");
    expect(String((fwd as { hex?: string }).hex).toLowerCase()).toBe(gainHex.toLowerCase());

    for (const ws of [connector, host, joiner]) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }, 15_000);
});

describe("ATEM TCP integration (optional)", () => {
  it.skipIf(!process.env.ATEM_INTEGRATION_HOST?.trim())(
    "connects to real ATEM when ATEM_INTEGRATION_HOST is set",
    async () => {
      const host = process.env.ATEM_INTEGRATION_HOST!.trim();

      const { Atem } = await import("atem-connection");
      const atem = new Atem({});
      try {
        await atem.connect(host, 9910);
        expect(atem.status).toBeDefined();
      } finally {
        await atem.destroy?.().catch(() => {});
      }
    },
    25_000,
  );
});
