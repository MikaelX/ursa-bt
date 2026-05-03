# Native (Capacitor) — quick reference

See **`ADR-shell-capacitor.md`** for the architecture decision.

## Builds

| Command | Purpose |
|--------|---------|
| `npm run build` | Default web/Docker bundle (`base: '/'`). Run this before container builds if you previously ran `build:cap` locally—Capacitor uses relative asset URLs. |
| `npm run build:cap` | Bundle with **`base: './'`** + `npx cap sync` for embedding in iOS/Android. |
| `npm run ios:archive` | After **`ios:sync`**, runs **`xcodebuild archive`** (Release, device) — needs **`APPLE_TEAM_ID`**. Output: `ios/App/build/App.xcarchive`. |
| `npm run ios:export` | Exports `.ipa` from that archive using **`ios/App/ExportOptions.local.plist`** (gitignored; copy from **`ExportOptions.appstore.example.plist`**). |
| `npm run android:release` | **`cap sync android`** then **`./gradlew assembleRelease`** — configure release signing in Gradle for store-ready APKs (or use **`bundleRelease`** for Play). |

Set **`CAPACITOR_BUILD=1`** only for the Capacitor asset pipeline (handled by `build:cap`).

### Command-line iOS archive (TestFlight / App Store)

Prerequisites: Xcode, Apple Developer Program membership, **valid signing certificates** (expired certs are ignored by Xcode/`xcodebuild`; renew **Apple Distribution** / provisioning in [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list)).

1. **Team ID** — 10-character id (Xcode → Signing & Capabilities, or Membership page). Pass on every archive:
   ```bash
   APPLE_TEAM_ID=XXXXXXXXXX npm run ios:archive
   ```
   Optional: **`SKIP_IOS_SYNC=1`** if you already synced. **`IOS_ALLOW_PROVISIONING_UPDATES=1`** adds **`-allowProvisioningUpdates`** (fresh machines / CI).

2. **Export options** — Copy the example plist and fill in your team:
   ```bash
   cp ios/App/ExportOptions.appstore.example.plist ios/App/ExportOptions.local.plist
   # edit teamID; keep method app-store for TestFlight/App Store uploads
   npm run ios:export
   ```

3. **Upload** — Use **Transporter**, **`xcrun altool`**, or Xcode Organizer with the exported **`.ipa`** under **`ios/App/build/export/`**.

Shared scheme **`App`** lives at **`ios/App/App.xcodeproj/xcshareddata/xcschemes/`** so **`xcodebuild -scheme App`** works from CI without opening Xcode.

### Command-line Android release

**`npm run android:release`** produces an **unsigned** Release APK unless you add **`signingConfigs`** in **`android/app/build.gradle`** (upload key for Play, or debug for local only). For Google Play, prefer **`./gradlew bundleRelease`** after configuring Play App Signing.

## First-time native projects

From repo root (requires Xcode / Android SDK locally):

```bash
npm install
npm run build:cap
npx cap add ios
npx cap add android
```

Then open **`ios/App/App.xcodeproj`** in Xcode or **`android/`** in Android Studio.

**Android:** Gradle sync needs a supported JDK (typically **17** for current AGP). If you see `Unsupported class file major version`, point Android Studio / `JAVA_HOME` at JDK 17 instead of a newer JVM.

### Run on iOS Simulator

From repo root:

```bash
npm run ios:sync    # vite build + copy/sync web assets into ios/
npm run ios:open    # opens the Xcode project (same as ios/App/App.xcodeproj)
```

In Xcode: choose any **iPhone** simulator as the run destination, select the **App** scheme, press **Run** (⌘R).

**Bluetooth:** Core Bluetooth **does not work in the iOS Simulator**. `@capacitor-community/bluetooth-le` rejects `initialize` with `"BLE unsupported"` there ([plugin README — iOS](https://github.com/capacitor-community/bluetooth-le/blob/main/README.md)). Expect **Connect** (BLE) to fail in Simulator; use **Join** to exercise relay/UI against a hosted session, or test BLE on a **physical iPhone**.

Live reload against dev server: configure `server.url` in `capacitor.config.ts` temporarily (see Capacitor docs); revert before release builds.

## Mobile engineering habits (adapted from RN literature)

Tom Jay’s [Pro Tips — React Native applications](https://medium.com/@thomasjay200/pro-tips-react-native-applications-a6c004f5c3d) is React Native–centric (2022); below is what we **keep** vs **reinterpret** for **Capacitor + WebView + TypeScript**:

| Idea from article | How we apply it here |
|-------------------|----------------------|
| Store binaries are long-lived; users may not upgrade quickly | Shell changes go through **App Store / Play** review. Treat embedded UI (`dist/`) like a shipped artifact: versioned releases, compatibility notes, avoid silent reliance on unreleased native APIs. Optional **remote UI** (e.g. Capacitor Live Updates) is a separate product decision—default is store cadence. |
| Mac + Xcode for iOS; test **both** platforms | Same for Capacitor: iOS builds need a Mac; Android Studio covers Android. Exercise **relay HTTPS**, **BLE**, and **orientation** on real devices, not only desktop Chrome. |
| TypeScript | Already the web stack (`tsc`, Vitest). Native BLE uses **`@capacitor-community/bluetooth-le`** via **`NativeBleCameraClient`** (`src/native/nativeBleCameraClient.ts`). |
| Git hygiene (`node_modules`, CocoaPods) | Root `.gitignore` excludes `node_modules/` and common **`ios/` / `android/`** build outputs (`Pods/`, `.gradle/`, etc.). Do not commit keystores or signing assets. |
| Visible **app version** for support | **Exposure** shows build version (`buildAppVersion()` from `package.json` via Vite `define`). Native shell suffix clarifies Capacitor vs browser. |
| CI/CD early | Prefer branch flow + automated **`npm run build` / `npm test`** (and later **Fastlane** / Play tracks). Same discipline as RN: integrate often, ship predictable binaries. |
| Push notifications — token hygiene, no spam | If we add pushes later: tie tokens to authenticated identity, rotate on refresh, revoke on user/device change (article’s medical-app caution applies to any sensitive operator UI). |
| BLE via native bridge | Matches the article’s emphasis on **native bridges** for BLE; shipping path is **`@capacitor-community/bluetooth-le`** + **`NativeBleCameraClient`**, with **RN + WebView + ble-plx** only if this stack fails bonding/PIN/GATT (see ADR). |

**Take with grain of salt:** “Do not use Expo”, pinned Node 14 / RN 0.67–0.68, Redux+Realm defaults — those target a specific RN stack and era. We do **not** adopt them blindly; state stays in existing TS modules unless a future refactor justifies Redux (or similar).

## Native BLE implementation

- Dependency: **`@capacitor-community/bluetooth-le`** (Capacitor 8).
- Adapter: **`NativeBleCameraClient`** (`src/native/nativeBleCameraClient.ts`) implements **`CameraClient`**: Blackmagic service UUID filter, GATT connect, notifications on incoming + camera status, writes for outgoing control / camera status / optional device-name characteristic.

After `npx cap add ios android`, run **`npm run build:cap`** so the plugin’s native sources sync into Xcode / Gradle. **iOS:** add **`NSBluetoothAlwaysUsageDescription`** (and background central mode when implementing PRD background BLE) per [plugin README](https://github.com/capacitor-community/bluetooth-le/blob/main/README.md). **Android:** follow the plugin docs for scan permissions / **`neverForLocation`** when using `initialize({ androidNeverForLocation: true })`.

## Publishing — Apple App Store (Capacitor = native Xcode project)

Distribution is the **same workflow as any iOS binary**: Xcode **Release** build → **Archive** → **App Store Connect** → TestFlight / review. The React Native guide is still a solid checklist for that path (archive, signing, uploads); skip RN-only steps such as the “Bundle React Native code and images” build phase — our assets are **`npm run build:cap`** → `dist/` → `cap sync`.

- [Publishing to Apple App Store — React Native](https://reactnative.dev/docs/publishing-to-app-store) (Xcode scheme, Archive, Distribute App)

**Screenshots:** Requirements are defined only by Apple’s current device/size matrix — always verify before submission:

- [Screenshot specifications — App Store Connect Help](https://developer.apple.com/help/app-store-connect/reference/app-information/screenshot-specifications)

Capture from **Simulator** or device at **exact** pixel dimensions from that page. Typical priorities for an **iPhone-first** submission (confirm wording on Apple’s site):

| Bucket | Notes |
|--------|--------|
| **iPhone 6.9"** | Largest modern phone class (several accepted portrait sizes, e.g. **1320 × 2868**, **1290 × 2796**, **1260 × 2736** — pick one row from Apple’s table). |
| **iPhone 6.5"** | Still relevant when Apple marks it required **if** you do not supply 6.9" screenshots (**1284 × 2778**, **1242 × 2688**, etc.). |
| **iPad** | Only if the app ships for iPad — then supply **13"** class sizes (**2064 × 2752**, **2048 × 2732**, etc.) per Apple. |

Apple may **scale** from larger screenshots into smaller slots in some cases; prefer uploading **native-resolution** captures for each slot you care about.

**Bundle ID:** Must match **`capacitor.config.ts`** `appId` (`com.almiro.bluetooth.camera`) and the identifier in [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list) / App Store Connect.
