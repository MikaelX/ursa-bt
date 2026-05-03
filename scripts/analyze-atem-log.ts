/**
 * Parse `atem.log` from atem-ccu-watch: stdout CCU JSON lines and optional stderr `[atem-raw] {...}` lines.
 *
 *   npx tsx scripts/analyze-atem-log.ts [path-to-log]
 *
 * Prints JSON summary to stdout (counts, unique keys, `[atem-debug] Unknown command` wire IDs).
 */

import * as fs from "node:fs";
import * as readline from "node:readline";

type CcUUnhandled = { categoryId: number; parameterId: number };

type CcuLine = {
  cameraId?: number;
  changes?: string[];
  unhandled?: CcUUnhandled[];
  events?: string[];
  note?: string;
};

type RawLine = { ctor?: string; rawName?: string; kind?: string; category?: number; parameter?: number };

function isCcuSummaryRow(row: CcuLine): boolean {
  return typeof row.cameraId === "number" || Array.isArray(row.changes) || Array.isArray(row.unhandled);
}

async function main(): Promise<void> {
  const path = process.argv[2] ?? "atem.log";
  if (!fs.existsSync(path)) {
    console.error(`File not found: ${path}`);
    process.exit(1);
  }

  const unhandledCounts = new Map<string, number>();
  const changeCounts = new Map<string, number>();
  const rawCtorCounts = new Map<string, number>();
  const rawNameCounts = new Map<string, number>();
  const debugUnknownWireId = new Map<string, number>();

  let ccuLines = 0;
  let rawLines = 0;
  const lineMeta = {
    connectingBanner: 0,
    connectedBanner: 0,
    threadedClass: 0,
    disconnected: 0,
    atemInfo: 0,
    atemDebug: 0,
  };

  let otherUnparsed = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      otherUnparsed++;
      continue;
    }
    if (trimmed.startsWith("Connecting to")) {
      lineMeta.connectingBanner++;
      continue;
    }
    if (trimmed.startsWith("Connected.")) {
      lineMeta.connectedBanner++;
      continue;
    }
    if (trimmed.startsWith("ThreadedClass")) {
      lineMeta.threadedClass++;
      continue;
    }
    if (trimmed === "[disconnected] CCU state reset") {
      lineMeta.disconnected++;
      continue;
    }
    if (trimmed.startsWith("[atem info]")) {
      lineMeta.atemInfo++;
      continue;
    }
    if (trimmed.startsWith("[atem-debug]")) {
      lineMeta.atemDebug++;
      const um = trimmed.match(/Unknown command (\S+)/);
      if (um) {
        const id = um[1]!;
        debugUnknownWireId.set(id, (debugUnknownWireId.get(id) ?? 0) + 1);
      }
      continue;
    }

    if (trimmed.startsWith("[atem-raw]")) {
      const jsonPart = trimmed.slice("[atem-raw]".length).trim();
      try {
        const o = JSON.parse(jsonPart) as RawLine;
        rawLines++;
        if (o.ctor) rawCtorCounts.set(o.ctor, (rawCtorCounts.get(o.ctor) ?? 0) + 1);
        if (o.rawName) rawNameCounts.set(o.rawName, (rawNameCounts.get(o.rawName) ?? 0) + 1);
      } catch {
        otherUnparsed++;
      }
      continue;
    }

    let rec: unknown;
    try {
      rec = JSON.parse(trimmed) as CcuLine;
    } catch {
      otherUnparsed++;
      continue;
    }
    const row = rec as CcuLine;
    if (typeof row !== "object" || row === null || !isCcuSummaryRow(row)) {
      otherUnparsed++;
      continue;
    }
    ccuLines++;
    for (const c of row.changes ?? []) {
      changeCounts.set(c, (changeCounts.get(c) ?? 0) + 1);
    }
    for (const u of row.unhandled ?? []) {
      const key = `${u.categoryId}/${u.parameterId}`;
      unhandledCounts.set(key, (unhandledCounts.get(key) ?? 0) + 1);
    }
  }

  const debugUnknownSorted = Object.fromEntries(
    [...debugUnknownWireId.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
  );

  const out = {
    path,
    ccuLines,
    rawLines,
    lineMeta,
    otherUnparsedLines: otherUnparsed,
    totalLinesApprox:
      ccuLines + rawLines + Object.values(lineMeta).reduce((a, b) => a + b, 0) + otherUnparsed,
    debugUnknownWireIds: debugUnknownSorted,
    unhandledCameraControl: Object.fromEntries(
      [...unhandledCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
    ),
    changeKeys: Object.fromEntries(
      [...changeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
    ),
    rawCommandCtors: Object.fromEntries(
      [...rawCtorCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
    ),
    rawCommandNames: Object.fromEntries(
      [...rawNameCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, v]),
    ),
  };

  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
