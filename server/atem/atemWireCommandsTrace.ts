/**
 * Non–Camera-Control ATEM wire commands (e.g. Fairlight) for relay `__atemCcuTrace`,
 * same serialization idea as `[atem-raw]` in `scripts/atem-ccu-watch.ts`.
 */
import { isCameraControlUpdateLike } from "./collectCameraControlUpdates.js";

const DEFAULT_MAX_PER_BATCH = 32;

function jsonSafeForLog(value: unknown, depth = 0): unknown {
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

export type AtemWireCommandTraceEntry = {
  ctor?: string;
  rawName?: string;
  /** Fairlight mixer strip index (0-based), when the wire command carries `index` / `source`. */
  inputIndex?: number;
  /** Fairlight source id (often a bitmask as decimal string). */
  source?: string;
  properties?: unknown;
};

/** ATEM sends time sync very often; omit from relay/UI trace to avoid log and panel_sync noise. */
function isIgnoredHighFrequencyWireCommand(cmd: object): boolean {
  const ctor = (cmd as { constructor?: { name?: string; rawName?: string } }).constructor;
  const name = ctor?.name ?? "";
  const rawName = ctor?.rawName;
  return name === "TimeCommand" || rawName === "Time";
}

function maxWirePerBatch(): number {
  const n = Number(process.env.ATEM_CCU_WIRE_MAX ?? "");
  if (Number.isFinite(n) && n > 0) return Math.min(256, Math.floor(n));
  return DEFAULT_MAX_PER_BATCH;
}

/** Commands that are not CCU (Fairlight, routing, etc.); capped per batch. */
export function atemWireCommandsTraceExtras(commands: unknown[]): Record<string, unknown> {
  const max = maxWirePerBatch();
  const wireCommands: AtemWireCommandTraceEntry[] = [];
  let skipped = 0;
  for (const cmd of commands) {
    if (typeof cmd !== "object" || cmd === null) continue;
    if (isCameraControlUpdateLike(cmd)) continue;
    if (isIgnoredHighFrequencyWireCommand(cmd)) continue;
    if (wireCommands.length >= max) {
      skipped += 1;
      continue;
    }
    const ctor = (cmd as { constructor?: { name?: string; rawName?: string } }).constructor;
    const row: AtemWireCommandTraceEntry = {
      ctor: ctor?.name,
      rawName: ctor?.rawName,
    };
    const c = cmd as Record<string, unknown>;
    if (typeof c.index === "number") row.inputIndex = c.index;
    if (typeof c.source === "bigint") row.source = c.source.toString();
    else if (typeof c.source === "number" && Number.isFinite(c.source)) row.source = String(c.source);
    if ("properties" in c) {
      try {
        row.properties = jsonSafeForLog(c.properties);
      } catch {
        row.properties = "[unreadable]";
      }
    }
    wireCommands.push(row);
  }
  if (wireCommands.length === 0) return {};
  const out: Record<string, unknown> = { wireCommands };
  if (skipped > 0) out.wireOverflow = skipped;
  return out;
}
