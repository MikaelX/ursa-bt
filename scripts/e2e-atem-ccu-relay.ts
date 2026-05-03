/**
 * End-to-end relay test: ATEM CCU host → `panel_sync` to joiner → optional `forward_cmd` → ATEM.
 *
 * Prereqs:
 *   - Banks + relay server: `npm run dev:server` (default ws below matches PORT 9132).
 *   - ATEM reachable on LAN (Camera Control).
 *
 * Usage:
 *   ATEM_HOST=192.168.1.199 npx tsx scripts/e2e-atem-ccu-relay.ts
 *
 * Options:
 *   --relay-url <ws url>   (default ws://127.0.0.1:9132/api/relay/socket)
 *   --atem <host or ip>
 *   --camera <1-24>
 *   --session <name>
 *   --listen-ms <n>        wait for first matching panel_sync (default 60000)
 *   --skip-forward         do not send joiner forward_cmd (autofocus packet)
 */

import WebSocket from "ws";
import { commands, toHex } from "../src/blackmagic/protocol.js";
import { BANKS_DEV_PORT } from "../src/banks/devServerPort.js";

function msgStr(data: WebSocket.RawData): string {
  return typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString("utf8");
}

function parseCli(): {
  relayUrl: string;
  atemHost: string;
  cameraId: number;
  sessionName: string;
  listenMs: number;
  skipForward: boolean;
} {
  const argv = process.argv.slice(2);
  let relayUrl = process.env.RELAY_WS_URL ?? `ws://127.0.0.1:${BANKS_DEV_PORT}/api/relay/socket`;
  let atemHost = process.env.ATEM_HOST?.trim() ?? "";
  let cameraId = Math.round(Number(process.env.ATEM_CAMERA_ID ?? "1"));
  let sessionName = process.env.E2E_SESSION_NAME?.trim() ?? `e2e-atem-${Date.now()}`;
  let listenMs = Math.round(Number(process.env.E2E_PANEL_SYNC_MS ?? "60000"));
  let skipForward = process.env.E2E_SKIP_FORWARD === "1" || process.env.E2E_SKIP_FORWARD === "true";

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--relay-url" && argv[i + 1]) relayUrl = String(argv[++i]);
    else if (a === "--atem" && argv[i + 1]) atemHost = String(argv[++i]).trim();
    else if (a === "--camera" && argv[i + 1]) cameraId = Math.round(Number(argv[++i]));
    else if (a === "--session" && argv[i + 1]) sessionName = String(argv[++i]).trim();
    else if (a === "--listen-ms" && argv[i + 1]) listenMs = Math.max(1000, Math.round(Number(argv[++i])));
    else if (a === "--skip-forward") skipForward = true;
    else if (!a.startsWith("-") && !atemHost) atemHost = a.trim();
  }

  if (!atemHost) {
    console.error("Missing ATEM host: set ATEM_HOST or pass as first positional / --atem <ip>");
    process.exit(2);
  }
  if (!Number.isFinite(cameraId) || cameraId < 1 || cameraId > 24) {
    console.error("Invalid --camera / ATEM_CAMERA_ID (use 1–24)");
    process.exit(2);
  }

  return { relayUrl, atemHost, cameraId, sessionName, listenMs, skipForward };
}

function jsonParse<T>(s: string): T | undefined {
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

function waitForMessage(
  ws: WebSocket,
  predicate: (p: { type?: string } & Record<string, unknown>) => boolean,
  ms: number,
  errorLabel: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      ws.removeListener("message", onMsg);
      reject(new Error(`${errorLabel} (${ms}ms)`));
    }, ms);
    const onMsg = (data: WebSocket.RawData): void => {
      const p = jsonParse<{ type?: string } & Record<string, unknown>>(msgStr(data));
      if (!p?.type) return;
      try {
        if (predicate(p)) {
          clearTimeout(t);
          ws.removeListener("message", onMsg);
          resolve();
        }
      } catch (err) {
        clearTimeout(t);
        ws.removeListener("message", onMsg);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    };
    ws.on("message", onMsg);
  });
}

async function main(): Promise<void> {
  const { relayUrl, atemHost, cameraId, sessionName, listenMs, skipForward } = parseCli();
  console.error(`[e2e] relay ${relayUrl} | ATEM ${atemHost} camera ${cameraId} | session "${sessionName}"`);

  const host = new WebSocket(relayUrl);
  await new Promise<void>((resolve, reject) => {
    host.once("open", () => resolve());
    host.once("error", reject);
  });

  let sessionId = "";

  const hostedWait = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      host.removeListener("message", onMsg);
      reject(new Error("hosted timeout"));
    }, 15000);
    const onMsg = (data: WebSocket.RawData): void => {
      const p = jsonParse<{ type?: string; sessionId?: string; message?: string }>(msgStr(data));
      if (!p?.type) return;
      if (p.type === "hosted" && typeof p.sessionId === "string") {
        sessionId = p.sessionId;
        clearTimeout(timer);
        host.removeListener("message", onMsg);
        resolve();
        return;
      }
      if (p.type === "atem_ccu_error") {
        clearTimeout(timer);
        host.removeListener("message", onMsg);
        reject(new Error(`atem_ccu_error: ${p.message ?? ""}`));
      }
    };
    host.on("message", onMsg);
  });

  host.send(
    JSON.stringify({
      type: "host_register",
      sessionName,
      deviceId: "e2e-atem-ccu-host",
      atemCcu: { address: atemHost, cameraId },
    }),
  );

  await hostedWait;

  if (!sessionId) throw new Error("missing sessionId after hosted");
  console.error(`[e2e] hosted sessionId=${sessionId}`);

  await waitForMessage(
    host,
    (p) =>
      (p.type === "atem_ccu_link" && p.connected === true) ||
      p.type === "atem_ccu_ready",
    45000,
    "ATEM TCP (atem_ccu_link / atem_ccu_ready)",
  );
  console.error("[e2e] ATEM TCP ready");

  const joiner = new WebSocket(relayUrl);
  await new Promise<void>((resolve, reject) => {
    joiner.once("open", () => resolve());
    joiner.once("error", reject);
  });

  const joinedWait = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      joiner.removeListener("message", onMsg);
      reject(new Error("join timeout"));
    }, 15000);
    const onMsg = (data: WebSocket.RawData): void => {
      const p = jsonParse<{ type?: string }>(msgStr(data));
      if (p?.type === "joined") {
        clearTimeout(timer);
        joiner.removeListener("message", onMsg);
        resolve();
        return;
      }
      if (p?.type === "session_ended") {
        clearTimeout(timer);
        joiner.removeListener("message", onMsg);
        reject(new Error("session_ended before join"));
      }
    };
    joiner.on("message", onMsg);
  });

  joiner.send(JSON.stringify({ type: "join", sessionId }));

  await joinedWait;
  console.error("[e2e] joiner joined");

  const snap = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const t = setTimeout(() => {
      joiner.removeListener("message", onMsg);
      reject(new Error(`No ATEM CCU panel_sync within ${listenMs}ms (wrong camera id on ATEM?)`));
    }, listenMs);
    const onMsg = (data: WebSocket.RawData): void => {
      const p = jsonParse<{ type?: string; snapshot?: Record<string, unknown> }>(msgStr(data));
      if (p?.type !== "panel_sync" || !p.snapshot || typeof p.snapshot !== "object") return;
      const dn = p.snapshot.deviceName;
      if (typeof dn === "string" && dn.includes("ATEM CCU")) {
        clearTimeout(t);
        joiner.removeListener("message", onMsg);
        resolve(p.snapshot);
      }
    };
    joiner.on("message", onMsg);
  });

  console.error(
    `[e2e] joiner received panel_sync: deviceName=${JSON.stringify(snap.deviceName)} lens.focus=${JSON.stringify((snap.lens as { focus?: unknown } | undefined)?.focus)}`,
  );

  if (!skipForward) {
    const packet = commands.autoFocus();
    const hex = toHex(packet).replace(/\s+/g, "");
    console.error(`[e2e] joiner forward_cmd autofocus hex=${hex}`);
    joiner.send(JSON.stringify({ type: "forward_cmd", hex }));
    await new Promise((r) => setTimeout(r, 1500));
    console.error("[e2e] forward_cmd sent (verify autofocus on camera / ATEM if applicable)");
  }

  joiner.close();
  try {
    host.send(JSON.stringify({ type: "host_stop" }));
  } catch {
    /* ignore */
  }
  await new Promise((r) => setTimeout(r, 300));
  host.close();

  console.error("[e2e] OK — end-to-end relay + ATEM CCU listen" + (skipForward ? "" : " + forward_cmd"));
}

main().catch((e) => {
  console.error("[e2e] FAIL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
