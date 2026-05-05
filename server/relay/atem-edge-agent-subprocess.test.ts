/**
 * Spawns `scripts/atem-edge-agent.ts` against an in-process relay; prints captured stderr (verbose).
 */
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { commands, toHex } from "../../src/blackmagic/protocol.js";
import { RelayCoordinator } from "./coordinator.js";

const RELAY_PATH = "/api/relay/socket";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EDGE_SCRIPT = join(__dirname, "../../scripts/atem-edge-agent.ts");

function wsUrl(port: number): string {
  return `ws://127.0.0.1:${port}${RELAY_PATH}`;
}

function msgStr(data: WebSocket.RawData): string {
  return typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((r) => setTimeout(r, ms));
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

async function waitForSubstring(
  getText: () => string,
  needle: string,
  ms: number,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (getText().includes(needle)) return;
    await sleep(40);
  }
  throw new Error(`timeout waiting for log substring: ${needle}`);
}

function parseConnectorId(stderr: string): string | undefined {
  const m = stderr.match(/\[atem-edge\] connector registered id=([^\s]+)/);
  return m?.[1];
}

describe("atem-edge-agent subprocess", () => {
  let server: http.Server | undefined;
  let coordinator: RelayCoordinator | undefined;

  afterEach(async () => {
    if (coordinator) await coordinator.destroy().catch(() => {});
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it("prints verbose stderr while relay drives connect + forward_cmd", async () => {
    coordinator = new RelayCoordinator(undefined);
    server = http.createServer();
    coordinator.attachToHttpServer(server);
    await new Promise<void>((resolve, reject) => {
      server!.listen(0, "127.0.0.1", () => resolve());
      server!.on("error", reject);
    });
    const addr = server!.address();
    if (!addr || typeof addr === "string") throw new Error("expected TCP port");
    const relayWs = wsUrl(addr.port);

    let stderr = "";
    const tsxBin = join(process.cwd(), "node_modules", ".bin", "tsx");
    const child = spawn(tsxBin, ["--", EDGE_SCRIPT, "--relay", relayWs, "--name", "vitest-edge-sub"], {
      env: {
        ...process.env,
        ATEM_EDGE_VERBOSE: "1",
        // Ensure connector mode even if shell has stray SESSION_ID
        SESSION_ID: "",
        EDGE_TOKEN: "",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const killEdge = (): void => {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };

    try {
      await waitForSubstring(() => stderr, "[atem-edge] connector registered", 12_000);
      const connectorId = parseConnectorId(stderr);
      expect(connectorId).toMatch(/^[0-9a-f-]{36}$/i);

      const host = new WebSocket(relayWs);
      const joiner = new WebSocket(relayWs);
      await Promise.all([
        new Promise<void>((r) => host.once("open", () => r())),
        new Promise<void>((r) => joiner.once("open", () => r())),
      ]);

      host.send(
        JSON.stringify({
          type: "host_register",
          sessionName: `vitest-edge-${Date.now()}`,
          deviceId: "vitest-edge-device",
        }),
      );
      const hosted = (await nextJson(host, (o) => o.type === "hosted" && typeof o.sessionId === "string", 8000)) as {
        sessionId: string;
      };
      const { sessionId } = hosted;

      host.send(
        JSON.stringify({
          type: "host_atem_ccu_register",
          connectorId,
          atemCcu: { address: "192.0.2.1", cameraId: 1 },
        }),
      );

      await waitForSubstring(() => stderr, "atem_edge_control connect", 8000);

      joiner.send(JSON.stringify({ type: "join", sessionId }));
      await nextJson(joiner, (o) => o.type === "joined", 8000);

      const gainHex = toHex(commands.gain(12));
      joiner.send(JSON.stringify({ type: "forward_cmd", hex: gainHex }));

      await waitForSubstring(() => stderr, "forward_cmd → bridge", 8000);

      // Echo full edge stderr for CI / local inspection
      // vitest shows console.log in test output
      console.log("--- atem-edge-agent stderr (full) ---\n", stderr, "\n--- end ---");

      expect(stderr).toContain("[atem-edge] websocket open");
      expect(stderr).toContain("forward_cmd → bridge");

      host.close();
      joiner.close();
    } finally {
      killEdge();
      await sleep(200);
    }
  }, 45_000);
});
