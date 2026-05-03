#!/usr/bin/env bash
# Build release APK after syncing web assets. Release is unsigned unless you configure signing in android/app/build.gradle.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [[ "${SKIP_ANDROID_SYNC:-0}" != "1" ]]; then
  CAPACITOR_BUILD=1 ENVIRONMENT=production npm run build && npx cap sync android
fi

cd "$ROOT/android"
./gradlew assembleRelease

echo "Output: android/app/build/outputs/apk/release/"
echo "For Play uploads use: ./gradlew bundleRelease → outputs/bundle/release/"
