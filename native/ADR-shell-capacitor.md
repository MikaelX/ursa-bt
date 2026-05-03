# ADR: Native shell — Capacitor first, React Native fallback

## Status

Accepted (engineering baseline). **Hardware spike still required** to confirm bonding/PIN/GATT behavior against URSA Broadcast before locking BLE plugin APIs.

## Context

PRD `0001-prd-native-mobile-apps-for-app-store-and-google-play.md` requires:

- **One Vite UI** for browser/desktop **and** embedded WebView in store apps.
- **Native BLE** on iOS/Android for Blackmagic Camera Control GATT (`291D567A-6D75-11E6-8B77-86F30CA893D3` and characteristics used in `src/blackmagic/bleClient.ts`).
- **Bonding / PIN** when encrypted characteristics require it (camera shows 6-digit PIN).
- **Relay** parity with PRD `0002` over HTTPS inside WebView.
- **Background BLE** where honestly supportable.

Browser/desktop continues to use **Web Bluetooth** via existing `BlackmagicBleClient`.

## Decision

1. **Default native shell:** **Capacitor 8**, `webDir: dist`, production bundle built with `CAPACITOR_BUILD=1` so Vite emits **`base: './'`** for asset resolution inside WebView.

2. **BLE integration:** Implement a **narrow Capacitor plugin** (community package first, fork/custom second) exposing scan/connect/write/notifications/disconnect + bonding/passkey callbacks as needed. TypeScript retains **packet encode/decode** in `src/blackmagic/protocol.ts`; native code handles **ATT/GATT transport only**.

3. **Fallback:** If spike proves Capacitor BLE path cannot meet **URSA bonding + encrypted characteristic** reliability, migrate shell to **React Native + `react-native-webview`** + **`react-native-ble-plx`** (or equivalent), still loading the **same `vite build`**.

## Blackmagic BLE surface (from web client)

Aligned with `src/blackmagic/constants.ts` / `BlackmagicBleClient`:

- Primary service: Blackmagic Camera Control.
- Characteristics: outgoing control (write), incoming control (notify), camera status (notify), optional device name (`180A`).
- Encrypted characteristics imply **bonding** and PIN UX—must be mirrored natively.

## Plugin evaluation checklist (spike)

- [ ] Scan/disc filtered by service UUID where OS permits.
- [ ] Connect + discover services/characteristics.
- [ ] Subscribe notifications on status + incoming control.
- [ ] Write outgoing control with correct write-with/without-response behavior if MTU constrained.
- [ ] Trigger pairing / respond to passkey when opening encrypted characteristic.
- [ ] Disconnect + error surfaces to JS for UI.

Candidate starting points (verify license and maintenance at implementation time):

- **`@capacitor-community/bluetooth-le`** — **in use** by `NativeBleCameraClient` (Capacitor 8).
- Capawesome or other Capacitor 8–compatible BLE plugins — fallback evaluation only if the community plugin fails bonding/PIN/GATT tests.

## Consequences

- **Positive:** Minimal duplication of UI/CSS/TS; Docker/static deploy path unchanged (`npm run build` without `CAPACITOR_BUILD`).
- **Positive:** `@capacitor/core` runtime used from TS (`Capacitor.getPlatform()`, `isNativeShell()` helpers).
- **Risk:** BLE plugin maturity vs RN ecosystem—fallback path documented above.
- **Next:** After spike, either lock plugin choice or execute RN fallback ADR addendum.

## External guidance (mapped to this repo)

Independent production articles on **React Native** often apply to any hybrid shell (stores, CI, devices, native bridges). **`native/README.md`** summarizes how [Tom Jay — Pro Tips (RN)](https://medium.com/@thomasjay200/pro-tips-react-native-applications-a6c004f5c3d) maps here—including **what we ignore** (dated RN / Expo / Node version pins).

## Native BLE implementation (`@capacitor-community/bluetooth-le`)

**`NativeBleCameraClient`** (`src/native/nativeBleCameraClient.ts`) drives **`BleClient`** from **`@capacitor-community/bluetooth-le`**: `initialize`, `requestDevice` (Blackmagic service filter), `connect`, `createBond` on Android, `startNotifications` on incoming + camera status characteristics, writes for outgoing control / camera status / optional device-name characteristic. Packet semantics stay in existing TS encode/decode modules consumed by the UI.

UI selects **`NativeBleCameraClient`** when **`Capacitor.isNativePlatform()`**; browser keeps **`BlackmagicBleClient`** (Web Bluetooth).

If URSA-class bonding/PIN/encryption proves unreliable with this plugin, execute the documented **RN + WebView + ble-plx** fallback without changing packet TS.

## Support / versioning

**`package.json` `version`** is baked at Vite build (`__BUILD_APP_VERSION__`) and shown under **Exposure**. When iOS/Android projects exist, align **CFBundleShortVersionString** / **versionCode** with the same release policy.

## Store submission pointers

See **`native/README.md`** → **Publishing — Apple App Store** for Xcode archive flow (including alignment with [React Native’s publishing guide](https://reactnative.dev/docs/publishing-to-app-store) minus RN-specific bundling) and [Apple screenshot specifications](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications).
