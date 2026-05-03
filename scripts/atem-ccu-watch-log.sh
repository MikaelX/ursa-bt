#!/usr/bin/env bash
# Tee watch output to ./atem.log — **sparse** by default: only `[atem-debug] Unknown command` and
# CCU stdout lines that have events / unhandled / invalid (no Time flood, no [atem-raw]).
# Full capture: ATEM_CCU_WATCH_RAW=1 npm run atem:ccu-watch:log -- …
# Usage from repo root:
#   npm run atem:ccu-watch:log -- [host] [--verbose] [--inputs N] ...
#   ATEM_HOST=192.168.1.199 npm run atem:ccu-watch:log
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
EXTRA=(--sparse)
if [[ "${ATEM_CCU_WATCH_RAW:-}" == "1" || "${ATEM_CCU_WATCH_RAW:-}" == "true" ]]; then
  EXTRA=(--raw)
fi
# Prefer local tsx (same as npm run atem:ccu-watch).
TSX="$ROOT/node_modules/.bin/tsx"
if [[ -x "$TSX" ]]; then
  "$TSX" scripts/atem-ccu-watch.ts "$@" "${EXTRA[@]}" 2>&1 | tee atem.log
else
  npx tsx scripts/atem-ccu-watch.ts "$@" "${EXTRA[@]}" 2>&1 | tee atem.log
fi
