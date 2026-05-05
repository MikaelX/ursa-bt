/**
 * Connect to an ATEM (Mini Extreme ISO, etc.) and print CCU deltas as they arrive:
 * iris, focus, white balance, shutter, gain, color correction, etc.
 *
 * **Camera Control “Audio” (group 2)** is the Blackmagic *camera* audio block (mic fader, phantom,
 * camera-reported input meters per the SDI Camera Control spec). It is not the ATEM Fairlight
 * mixer: changing program faders or mixer settings usually produces **no** Camera Control audio
 * packets. Expect audio CC lines only with a suitable BMD camera on that input, or use
 * `--raw` or `--cc-audio` on stderr to inspect Camera Control traffic.
 *
 * Usage:
 *   npx tsx scripts/atem-ccu-watch.ts [host] [--inputs N] [--verbose] [--cc-audio] [--raw] [--sparse]
 *   ATEM_HOST=192.168.1.199 npx tsx scripts/atem-ccu-watch.ts
 *   npm run atem:ccu-watch:log -- [host] …   # `--sparse` + tee → ./atem.log (unknown + CCU events/unhandled only)
 *
 * `--raw` logs every **deserialized** ATEM command (`[atem-raw]` on stderr) and forwards **all** `[atem-debug]`
 * (including `PAYLOAD PACKETS` when `debugBuffers` is on). Mutually exclusive with `--sparse`.
 *
 * `--sparse` logs only: (1) `[atem-debug]` lines that report **Unknown command** (parser vs firmware gap), and
 * (2) CCU stdout JSON when the delta has non-empty **events**, **unhandled**, or **invalid** (skips changes-only
 * lines). No `[atem-raw]`, no `debugBuffers`, no `[atem info]` unless `--verbose`.
 */

import { Atem, Commands } from "atem-connection";
import { AtemCameraControlStateBuilder } from "@atem-connection/camera-control";
import {
  applyCcuAudioTallyCommands,
  ccuAudioTallyToSnapshotPatch,
  audioTallyBucketTraceSummary,
  type CcuAudioTallyBucket,
} from "../server/atem/ccuAudioTallyApply.js";
import { lensVideoSummary } from "../server/atem/ccuWatchStyleTrace.js";
import { collectCameraControlUpdates } from "../server/atem/collectCameraControlUpdates.js";
import { logRawReceivedCommands } from "../server/atem/logRawReceivedCommands.js";

/** Camera Control category id for Audio (BMD SDI Camera Control spec). */
const CC_AUDIO = 2;

function parseArgs(): {
  host: string;
  inputs: number;
  verbose: boolean;
  ccAudioRaw: boolean;
  rawAll: boolean;
  sparse: boolean;
} {
  const argv = process.argv.slice(2);
  let verbose = false;
  let ccAudioRaw = false;
  let rawAll = false;
  let sparse = false;
  const hostParts: string[] = [];
  let inputs = 16;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--verbose" || a === "-v") verbose = true;
    else if (a === "--cc-audio") ccAudioRaw = true;
    else if (a === "--raw") rawAll = true;
    else if (a === "--sparse") sparse = true;
    else if (a === "--inputs" && argv[i + 1]) {
      inputs = Math.max(1, Number(argv[++i]!));
    } else if (!a.startsWith("-")) hostParts.push(a);
  }
  const host = hostParts[0] ?? process.env.ATEM_HOST ?? "192.168.1.199";
  if (process.env.ATEM_CCU_WATCH_RAW === "1" || process.env.ATEM_CCU_WATCH_RAW === "true") {
    rawAll = true;
  }
  if (process.env.ATEM_CCU_WATCH_SPARSE === "1" || process.env.ATEM_CCU_WATCH_SPARSE === "true") {
    sparse = true;
  }
  if (rawAll) sparse = false;
  return { host, inputs, verbose, ccAudioRaw: ccAudioRaw && !rawAll, rawAll, sparse: sparse && !rawAll };
}

function logRawAudioCcIfRequested(cmds: Commands.CameraControlUpdateCommand[], enabled: boolean): void {
  if (!enabled) return;
  for (const cmd of cmds) {
    if (cmd.category !== CC_AUDIO) continue;
    const p = cmd.properties;
    console.error(
      "[cc-audio-cc]",
      JSON.stringify({
        source: cmd.source,
        parameter: cmd.parameter,
        dataType: p.type,
        numberData: p.numberData,
        boolData: p.boolData,
      }),
    );
  }
}

async function main(): Promise<void> {
  const { host, inputs, verbose, ccAudioRaw, rawAll, sparse } = parseArgs();
  const cameraControlState = new AtemCameraControlStateBuilder(inputs);
  const auxBuckets = new Map<number, CcuAudioTallyBucket>();
  const atem = new Atem({ debugBuffers: rawAll });

  atem.on("error", (msg) => console.error("[atem error]", msg));
  atem.on("info", (msg) => {
    if (verbose) console.error("[atem info]", msg);
  });
  if (rawAll) {
    atem.on("debug", (msg) => console.error("[atem-debug]", msg));
  } else if (sparse) {
    atem.on("debug", (msg) => {
      if (typeof msg === "string" && msg.includes("Unknown command")) {
        console.error("[atem-debug]", msg);
      }
    });
  }

  atem.on("disconnected", () => {
    cameraControlState.reset(inputs);
    auxBuckets.clear();
    console.log("[disconnected] CCU state reset");
  });

  atem.on("receivedCommands", (commands) => {
    const batchTs = new Date().toISOString();
    if (rawAll) logRawReceivedCommands(commands, batchTs, (line) => console.error(line));

    const cameraCommands = collectCameraControlUpdates(commands);
    if (cameraCommands.length === 0) return;

    logRawAudioCcIfRequested(cameraCommands, ccAudioRaw);

    const auxTouched = applyCcuAudioTallyCommands(cameraCommands, auxBuckets);
    const deltas = cameraControlState.applyCommands(cameraCommands);
    const ts = new Date().toISOString();
    const emittedFromDelta = new Set<number>();
    for (const d of deltas) {
      const hasPayload =
        d.changes.length > 0 ||
        d.events.length > 0 ||
        d.unhandledMessages.length > 0 ||
        d.invalidMessages.length > 0;
      if (!hasPayload) continue;

      emittedFromDelta.add(d.cameraId);
      const snap = cameraControlState.get(d.cameraId);
      const auxPatch = auxBuckets.has(d.cameraId)
        ? ccuAudioTallyToSnapshotPatch(auxBuckets.get(d.cameraId)!)
        : {};
      const row: Record<string, unknown> = {
        ts,
        cameraId: d.cameraId,
        changes: d.changes,
        events: d.events,
        unhandled: d.unhandledMessages.length ? d.unhandledMessages : undefined,
        invalid: d.invalidMessages.length ? d.invalidMessages : undefined,
        lensVideo: lensVideoSummary(snap),
        ...audioTallyBucketTraceSummary(auxBuckets.get(d.cameraId)),
      };
      if (Object.keys(auxPatch).length > 0) Object.assign(row, auxPatch);

      const logCcu =
        !sparse ||
        d.events.length > 0 ||
        d.unhandledMessages.length > 0 ||
        d.invalidMessages.length > 0;
      if (logCcu) {
        console.log(JSON.stringify(row));
        if (verbose && snap) {
          const vrow: Record<string, unknown> = { ts, cameraId: d.cameraId, fullState: snap };
          if (Object.keys(auxPatch).length > 0) Object.assign(vrow, auxPatch);
          console.log(JSON.stringify(vrow));
        }
      }
    }

    if (!sparse) {
      for (const camId of auxTouched) {
        if (emittedFromDelta.has(camId)) continue;
        const patch = ccuAudioTallyToSnapshotPatch(auxBuckets.get(camId)!);
        if (Object.keys(patch).length === 0) continue;
        const snap = cameraControlState.get(camId);
        console.log(
          JSON.stringify({
            ts,
            cameraId: camId,
            note: "audio_tally_ccu",
            ...(snap ? { lensVideo: lensVideoSummary(snap) } : {}),
            ...audioTallyBucketTraceSummary(auxBuckets.get(camId)),
            ...patch,
          }),
        );
      }
    }
  });

  console.error(
    `Connecting to ${host}:9910 … (${inputs} CCU slots) — ` +
      (rawAll
        ? "stderr: [atem-raw] + all [atem-debug]; "
        : sparse
          ? "stderr: [atem-debug] Unknown command only; stdout: CCU lines with events/unhandled/invalid only; "
          : "stdout: full CCU deltas; ") +
      "--verbose for [atem info]; --raw full parse; --sparse quiet catalog",
  );
  await atem.connect(host, 9910);
  console.error(
    rawAll
      ? "Connected. Full raw trace.\n"
      : sparse
        ? "Connected. Sparse log: unknown wire IDs + CCU events/unhandled/invalid only.\n"
        : "Connected. Full CCU deltas on stdout.\n",
  );

  await new Promise<void>((resolve) => {
    process.once("SIGINT", () => resolve());
  });
  console.error("\nDisconnecting…");
  await atem.destroy();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
