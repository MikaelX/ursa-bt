import { Commands } from "atem-connection";
import { isCameraControlUpdateLike } from "./collectCameraControlUpdates.js";

export function jsonSafeForLog(value: unknown, depth = 0): unknown {
  if (depth > 14) return "[max-depth]";
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return { __type: "Uint8Array", hex: Buffer.from(value).toString("hex") };
  }
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) {
    return { __type: "Buffer", hex: value.toString("hex") };
  }
  if (Array.isArray(value)) return value.map((x) => jsonSafeForLog(x, depth + 1));
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) {
      try {
        out[k] = jsonSafeForLog(o[k], depth + 1);
      } catch {
        out[k] = "[unreadable]";
      }
    }
    return out;
  }
  return String(value);
}

/**
 * Same serialization as `scripts/atem-ccu-watch.ts` `[atem-raw]` (one line per deserialized command).
 */
export function rawReceivedCommandLines(commands: unknown[], batchTs: string): string[] {
  const lines: string[] = [];
  for (let batchIndex = 0; batchIndex < commands.length; batchIndex++) {
    const cmd = commands[batchIndex];
    if (typeof cmd !== "object" || cmd === null) {
      lines.push(`[atem-raw] ${JSON.stringify({ ts: batchTs, batchIndex, kind: typeof cmd })}`);
      continue;
    }
    const ctor = (cmd as { constructor?: { name?: string; rawName?: string } }).constructor;
    const rawName = ctor?.rawName;
    const base: Record<string, unknown> = {
      ts: batchTs,
      batchIndex,
      ctor: ctor?.name,
      rawName,
    };
    if (isCameraControlUpdateLike(cmd)) {
      const cc = cmd as Commands.CameraControlUpdateCommand;
      base.kind = "CameraControlUpdate";
      base.source = cc.source;
      base.category = cc.category;
      base.parameter = cc.parameter;
      base.properties = jsonSafeForLog(cc.properties);
    } else {
      const c = cmd as Record<string, unknown>;
      if ("properties" in c) base.properties = jsonSafeForLog(c.properties);
    }
    try {
      lines.push(`[atem-raw] ${JSON.stringify(base)}`);
    } catch (e) {
      lines.push(`[atem-raw] ${JSON.stringify({ ts: batchTs, batchIndex, ctor: base.ctor, error: String(e) })}`);
    }
  }
  return lines;
}

/**
 * Same serialization as `scripts/atem-ccu-watch.ts` `[atem-raw]` (one line per deserialized command).
 */
export function logRawReceivedCommands(
  commands: unknown[],
  batchTs: string,
  write: (line: string) => void = (line) => console.log(line),
): void {
  for (const line of rawReceivedCommandLines(commands, batchTs)) write(line);
}
