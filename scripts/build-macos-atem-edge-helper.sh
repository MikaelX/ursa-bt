#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

APP_NAME="ATEM Edge Helper"
EXECUTABLE_NAME="AtemEdgeHelper"
BUNDLE_ID="se.almiro.bm-bluetooth.atem-edge-helper"
SRC_DIR="macos/AtemEdgeHelper"
DIST_DIR="dist"
APP_DIR="${DIST_DIR}/${APP_NAME}.app"
CONTENTS_DIR="${APP_DIR}/Contents"
MACOS_DIR="${CONTENTS_DIR}/MacOS"

if ! command -v swiftc >/dev/null 2>&1; then
	echo "swiftc not found; install Xcode command line tools" >&2
	exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$MACOS_DIR"

arch=$(uname -m)
case "$arch" in
	arm64) swift_target="arm64-apple-macosx13.0" ;;
	x86_64) swift_target="x86_64-apple-macosx13.0" ;;
	*) echo "unsupported macOS architecture: $arch" >&2; exit 1 ;;
esac

echo "Building ${APP_NAME}.app (${swift_target})"
swiftc \
	-O \
	-target "$swift_target" \
	-framework AppKit \
	-framework ServiceManagement \
	-o "${MACOS_DIR}/${EXECUTABLE_NAME}" \
	"${SRC_DIR}/main.swift"

cp "${SRC_DIR}/Info.plist" "${CONTENTS_DIR}/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier ${BUNDLE_ID}" "${CONTENTS_DIR}/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $(date +%Y%m%d%H%M%S)" "${CONTENTS_DIR}/Info.plist"

codesign --force --deep --sign - "$APP_DIR" >/dev/null

echo "Built: ${APP_DIR}"
printf 'Run:   open %q\n' "$APP_DIR"
