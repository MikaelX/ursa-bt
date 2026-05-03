#!/usr/bin/env bash
# Archive signed Release build for App Store Connect / TestFlight.
# Requires Xcode, valid Apple certs, and APPLE_TEAM_ID (or DEVELOPMENT_TEAM).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PROJECT="${IOS_PROJECT:-ios/App/App.xcodeproj}"
SCHEME="${IOS_SCHEME:-App}"
CONFIG="${IOS_CONFIGURATION:-Release}"
ARCHIVE_PATH="${IOS_ARCHIVE_PATH:-$ROOT/ios/App/build/App.xcarchive}"
SKIP_SYNC="${SKIP_IOS_SYNC:-0}"
TEAM="${APPLE_TEAM_ID:-${DEVELOPMENT_TEAM:-}}"

if [[ "$SKIP_SYNC" != "1" ]]; then
  npm run ios:sync
fi

if [[ -z "$TEAM" ]]; then
  echo "Missing APPLE_TEAM_ID (or DEVELOPMENT_TEAM). Automatic signing needs a team on the CLI." >&2
  echo " Example: APPLE_TEAM_ID=XXXXXXXXXX npm run ios:archive" >&2
  echo " Team ID is in Xcode → Signing & Capabilities, or developer.apple.com account." >&2
  exit 1
fi

mkdir -p "$(dirname "$ARCHIVE_PATH")"

if [[ "${IOS_ALLOW_PROVISIONING_UPDATES:-0}" == "1" ]]; then
  xcodebuild -allowProvisioningUpdates \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration "$CONFIG" \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    archive \
    DEVELOPMENT_TEAM="$TEAM" \
    CODE_SIGN_STYLE=Automatic
else
  xcodebuild \
    -project "$PROJECT" \
    -scheme "$SCHEME" \
    -configuration "$CONFIG" \
    -destination 'generic/platform=iOS' \
    -archivePath "$ARCHIVE_PATH" \
    archive \
    DEVELOPMENT_TEAM="$TEAM" \
    CODE_SIGN_STYLE=Automatic
fi

echo "Archive ready: $ARCHIVE_PATH"
