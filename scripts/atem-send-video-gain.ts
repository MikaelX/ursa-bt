/**
 * Send one Camera Control **video gain** (sensor dB, category 1 / parameter 13) over ATEM UDP
 * and verify path using **transport ack** + optional **CCdP** echo from the switcher.
 *
 * `atem-connection`: `await sendCommand` completes only after the switcher **AckReply**’s the
 * packet (see `BasicAtem.sendUnprioritizedCommands` + `_resolveCommands`). That confirms the
 * **CCmd** reached the mixer at wire level; the camera may still ignore values it does not support.
 *
 * **CCdP** (`CameraControlUpdateCommand`) is the mixer → client camera-control delta; if your
 * source is on-air and reports gain, you should see category **1** / parameter **13** after a set.
 *
 * Wire implementation: **Sofie** `atem-connection` (see package `repository` → *sofie-atem-connection*),
 * UDP **9910**, `CCmd` out / `CCdP` in (`CameraControlCommand` / `CameraControlUpdateCommand`).
 *
 * Usage:
 *   npx tsx scripts/atem-send-video-gain.ts [host] [--camera 7] [--gain 0] [--port 9910]
 *   npx tsx scripts/atem-send-video-gain.ts 192.168.1.199 --listen-ms 8000 --verbose-cc
 */

import { Atem, AtemConnectionStatus, Commands } from "atem-connection";
import { AtemCameraControlDirectCommandSender } from "@atem-connection/camera-control";

const CC_VIDEO = 1;
const CC_GAIN = 13;

function parseArgs(): {
  host: string;
  port: number;
  cameraId: number;
  gainDb: number;
  listenMs: number;
  readyMs: number;
  sendAckMs: number;
  verboseCc: boolean;
} {
  const argv = process.argv.slice(2);
  let cameraId = 7;
  let gainDb = 0;
  let port = 9910;
  let listenMs = 6000;
  let readyMs = 20000;
  let sendAckMs = 15000;
  let verboseCc = false;
  const hostParts: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--camera" && argv[i + 1]) cameraId = Math.round(Number(argv[++i]!));
    else if (a === "--gain" && argv[i + 1]) gainDb = Math.round(Number(argv[++i]!));
    else if (a === "--port" && argv[i + 1]) port = Math.round(Number(argv[++i]!));
    else if (a === "--listen-ms" && argv[i + 1]) listenMs = Math.max(0, Math.round(Number(argv[++i]!)));
    else if (a === "--ready-ms" && argv[i + 1]) readyMs = Math.max(1000, Math.round(Number(argv[++i]!)));
    else if (a === "--send-ack-ms" && argv[i + 1]) sendAckMs = Math.max(2000, Math.round(Number(argv[++i]!)));
    else if (a === "--verbose-cc") verboseCc = true;
    else if (!a.startsWith("-")) hostParts.push(a);
  }
  const host = hostParts[0] ?? process.env.ATEM_HOST ?? "";
  if (!host.trim()) {
    console.error(
      "Usage: npx tsx scripts/atem-send-video-gain.ts <host> [--camera 7] [--gain 0] [--port 9910]\n" +
        "          [--listen-ms 6000] [--ready-ms 20000] [--send-ack-ms 15000] [--verbose-cc]\n" +
        "   or: ATEM_HOST=<host> npx tsx scripts/atem-send-video-gain.ts …",
    );
    process.exit(1);
  }
  if (!Number.isFinite(cameraId) || cameraId < 1 || cameraId > 24) {
    console.error("--camera must be 1..24");
    process.exit(1);
  }
  if (!Number.isFinite(gainDb) || gainDb < -128 || gainDb > 127) {
    console.error("--gain must fit SINT8");
    process.exit(1);
  }
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    console.error("--port invalid");
    process.exit(1);
  }
  return { host: host.trim(), port, cameraId, gainDb, listenMs, readyMs, sendAckMs, verboseCc };
}

function waitConnected(atem: Atem, timeoutMs: number): Promise<void> {
  if (atem.status === AtemConnectionStatus.CONNECTED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => {
      atem.off("connected", onC);
      reject(
        new Error(
          `Timeout ${timeoutMs}ms waiting for 'connected' (InitComplete). status=${atem.status} — check IP/firewall/UDP 9910`,
        ),
      );
    }, timeoutMs);
    const onC = (): void => {
      clearTimeout(to);
      resolve();
    };
    atem.on("connected", onC);
  });
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const to = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(to);
        resolve(v);
      },
      (e) => {
        clearTimeout(to);
        reject(e);
      },
    );
  });
}

function isCcVideoGain(cmd: unknown, source: number): cmd is Commands.CameraControlUpdateCommand {
  return (
    cmd instanceof Commands.CameraControlUpdateCommand &&
    cmd.source === source &&
    cmd.category === CC_VIDEO &&
    cmd.parameter === CC_GAIN
  );
}

async function main(): Promise<void> {
  const { host, port, cameraId, gainDb, listenMs, readyMs, sendAckMs, verboseCc } = parseArgs();
  const atem = new Atem({});
  atem.on("error", (msg) => console.error("[atem error]", msg));

  console.error(`Connecting ${host}:${port} …`);
  await atem.connect(host, port);

  await waitConnected(atem, readyMs);
  const ver = atem.state?.info?.apiVersion;
  console.error(
    `[ready] connected status=${atem.status}${ver !== undefined ? ` apiVersion=${ver}` : ""}`,
  );

  let sawGainEcho = false;
  const onReceived = (commands: readonly unknown[]): void => {
    for (const cmd of commands) {
      if (!(cmd instanceof Commands.CameraControlUpdateCommand)) continue;
      if (cmd.source !== cameraId) continue;
      if (verboseCc) {
        console.error(
          "[ccdp]",
          JSON.stringify({
            source: cmd.source,
            category: cmd.category,
            parameter: cmd.parameter,
            type: cmd.properties.type,
            numberData: cmd.properties.numberData,
          }),
        );
      }
      if (isCcVideoGain(cmd, cameraId)) {
        const v = cmd.properties.numberData[0];
        console.error(`[ccdp] video gain echo source=${cmd.source} gainDb=${v} (raw numberData=${JSON.stringify(cmd.properties.numberData)})`);
        sawGainEcho = true;
      }
    }
  };
  atem.on("receivedCommands", onReceived);

  const sender = new AtemCameraControlDirectCommandSender(atem);
  console.error(`Sending videoGain(cameraId=${cameraId}, gainDb=${gainDb}) …`);
  const t0 = Date.now();
  await withTimeout(sender.videoGain(cameraId, gainDb), sendAckMs, "sendCommand/videoGain (ATEM AckReply)");
  console.error(`[ack] CCmd accepted by switcher in ${Date.now() - t0}ms (transport AckReply → sendCommand settled)`);

  if (listenMs > 0) {
    console.error(`Listening ${listenMs}ms for CCdP video gain (category ${CC_VIDEO} param ${CC_GAIN}) on source ${cameraId}…`);
    await new Promise((r) => setTimeout(r, listenMs));
    if (!sawGainEcho) {
      console.error(
        "[ccdp] no video gain echo — common causes: wrong CCU source vs physical input, no BMD camera on that SDI, `CCdP` not emitted for this parameter, or gain 0 matches current (try --gain 18). Use --verbose-cc to dump all CCdP for this source.",
      );
    }
  }

  atem.off("receivedCommands", onReceived);
  console.error("Disconnecting…");
  await atem.destroy();
  console.error("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
