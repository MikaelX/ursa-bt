#!/usr/bin/env bash
# Export .ipa from an existing .xcarchive (for Transporter / altool / CI).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ARCHIVE_PATH="${IOS_ARCHIVE_PATH:-$ROOT/ios/App/build/App.xcarchive}"
EXPORT_PATH="${IOS_EXPORT_PATH:-$ROOT/ios/App/build/export}"
PLIST="${EXPORT_OPTIONS_PLIST:-$ROOT/ios/App/ExportOptions.local.plist}"

if [[ ! -d "$ARCHIVE_PATH" ]]; then
  echo "No archive at $ARCHIVE_PATH — run npm run ios:archive first." >&2
  exit 1
fi

if [[ ! -f "$PLIST" ]]; then
  echo "Missing $PLIST" >&2
  echo "Copy ios/App/ExportOptions.appstore.example.plist → ios/App/ExportOptions.local.plist" >&2
  echo "and set YOUR_10_CHAR_TEAM_ID, then retry (ExportOptions.local.plist is gitignored)." >&2
  exit 1
fi

rm -rf "$EXPORT_PATH"
mkdir -p "$EXPORT_PATH"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE_PATH" \
  -exportPath "$EXPORT_PATH" \
  -exportOptionsPlist "$PLIST"

echo "IPA(s) exported under: $EXPORT_PATH"
