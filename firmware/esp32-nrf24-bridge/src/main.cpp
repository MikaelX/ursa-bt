#include <Arduino.h>

#include "ble_camera_scanner.h"
#include "bridge_config.h"
#include "bridge_led.h"
#include "bridge_nrf24.h"
#include "bridge_ui.h"
#include "input_buttons.h"
#include "power_manager.h"
#include "waveshare_lcd_init.h"

namespace {
int g_selected = 0;
int g_scroll = 0;
uint32_t g_scanStartedMs = 0;
bool g_connecting = false;
bool g_cameraBleHold = false;  // true while GATT session needs the radio
bool g_uiDirty = true;
uint32_t g_bleOffAfterMs = 0;

bool cameraBleRequired() { return g_cameraBleHold || g_connecting; }

void markDirty() { g_uiDirty = true; }

// Run UI + LED ticks at production cadence during boot demo (not 250 ms polling).
void demoRunMs(uint32_t ms) {
  powerOnUserActivity();
  const uint32_t end = millis() + ms;
  while ((int32_t)(end - millis()) > 0) {
    const uint32_t now = millis();
    bridgeUiTick(now);
    if (bridgeUiAnimationsDirty()) bridgeUiDraw();
    ledTick(now);
    delay(10);
  }
}

// Centralized state setters that mirror UI + LED.
void setLink(LinkState s, const char *detail) {
  bridgeUiSetLink(s, detail);
  ledSetLink(s);
  g_cameraBleHold = (s == LinkState::Connecting || s == LinkState::Connected);
  if (g_cameraBleHold) g_bleOffAfterMs = 0;
}
void setTally(TallyState s) {
  bridgeUiSetTally(s);
  ledSetTally(s);
}
void setBattery(int8_t percent) {
  bridgeUiSetBattery(percent);
  ledSetBatteryPercent(percent);
}

void refreshListUi() {
  const int n = bleScannerCount();
  if (g_selected >= n && n > 0) g_selected = n - 1;
  if (g_selected < 0) g_selected = 0;

  if (g_selected < g_scroll) g_scroll = g_selected;
  if (g_selected >= g_scroll + UI_LIST_VISIBLE) g_scroll = g_selected - UI_LIST_VISIBLE + 1;

  const char *names[UI_LIST_MAX];
  char buffers[UI_LIST_MAX][32];
  for (int i = 0; i < n; i++) {
    CameraDevice d;
    if (bleScannerGet(i, d)) {
      strncpy(buffers[i], d.name, sizeof(buffers[i]) - 1);
      names[i] = buffers[i];
    }
  }
  bridgeUiSetList(names, n, g_selected, g_scroll);
  g_uiDirty = true;
}

void drawIfDirty() {
  if (!g_uiDirty) return;
  bridgeUiDraw();
  g_uiDirty = false;
}

void startScan() {
  powerOnUserActivity();
  bleScannerEnsureReady();
  bleScannerStart();
  g_scanStartedMs = millis();
  g_bleOffAfterMs = 0;
  g_selected = 0;
  g_scroll = 0;
  setLink(LinkState::Scanning, "SCAN");
#if BTN_USE_BOOT_FALLBACK
  bridgeUiSetFooter("BOOT=STOP");
#else
  bridgeUiSetFooter("SEL=STOP");
#endif
  refreshListUi();
}

void finishScan() {
  if (!bleScannerIsActive()) return;
  bleScannerLoop();
  setLink(LinkState::Ready, "READY");
#if BTN_USE_BOOT_FALLBACK
  bridgeUiSetFooter(bleScannerCount() > 0 ? "BOOT=LINK" : "BOOT=SCAN");
#else
  bridgeUiSetFooter(bleScannerCount() > 0 ? "SEL=LINK" : "SEL=SCAN");
#endif
  g_bleOffAfterMs = millis() + 15'000;  // turn radio off 15 s after scan
  refreshListUi();
}

void onSelectCamera() {
  CameraDevice d;
  if (!bleScannerGet(g_selected, d)) return;
  g_connecting = true;
  powerOnUserActivity();
  bridgeUiSetActiveCamera(d.name);
  setLink(LinkState::Connecting, "LINK");
  bridgeUiSetFooter("PLEASE WAIT");
  markDirty();
  drawIfDirty();
  Serial.printf("[ui] connect requested: %s\n", d.address);
  // TODO: GATT connect
  g_connecting = false;
  setLink(LinkState::Connected, "LINKED");
  setTally(TallyState::Off);
  bridgeUiSetFooter("HOLD SEL=EXIT");
  markDirty();
}

void handleButtons(BtnEvent ev) {
  if (ev == BtnEvent::None) return;
  Serial.printf("[btn] event %d\n", static_cast<int>(ev));
  const bool wasAsleep = powerDisplayAsleep();
  powerOnUserActivity();
  g_bleOffAfterMs = 0;
  if (wasAsleep) {
    bridgeUiSetSleep(false);
    ledResume();
    markDirty();
    return;  // swallow this event — only wake
  }

  if (g_connecting) return;

  if (ev == BtnEvent::LongSelect) {
    startScan();
    return;
  }

  if (ev == BtnEvent::Select) {
    if (bleScannerIsActive()) {
      finishScan();
      return;
    }
    if (bleScannerCount() == 0) {
      startScan();
      return;
    }
    onSelectCamera();
    return;
  }

  const int n = bleScannerCount();
  if (n == 0) return;

  if (ev == BtnEvent::Up && g_selected > 0) {
    g_selected--;
    refreshListUi();
  } else if (ev == BtnEvent::Down && g_selected < n - 1) {
    g_selected++;
    refreshListUi();
  }
}

void idlePower() {
  powerIdleTick();

  if (g_bleOffAfterMs > 0 && !cameraBleRequired() && !bleScannerIsActive() &&
      millis() >= g_bleOffAfterMs) {
    bleScannerShutdown();
    g_bleOffAfterMs = 0;
  }

  if (powerShouldSleep() && !bleScannerIsActive() && !g_connecting && !powerDisplayAsleep()) {
    bridgeUiSetSleep(true);
    bridgeUiDraw();
    powerEnterDisplaySleep();
    ledOff();
  }
}

// Call this whenever ATEM tally state changes. Unused until ATEM wiring lands.
[[maybe_unused]] void onTallyChanged(TallyState newState) {
  setTally(newState);
  const bool live = newState != TallyState::Off;
  powerSetKeepAwake(live);
  if (live && powerDisplayAsleep()) {
    bridgeUiSetSleep(false);
    ledResume();
  }
  markDirty();
}
}  // namespace

void setup() {
  Serial.begin(115200);
  delay(800);
  Serial.println("\n[boot] 1 serial up");
  Serial.flush();

  powerInit();
  Serial.println("[boot] 2 power ok");
  Serial.flush();

  waveshare_lcd_init();
  Serial.println("[boot] 3 lcd ok");
  Serial.flush();

  bridgeUiInit(gfx);
  buttonsInit();
  ledInit();
  Serial.println("[boot] 4 ui/buttons ok");
  Serial.flush();

  const bool nrfOk = nrf24Init();
  if (nrfOk) {
    Serial.printf("[nrf] ready (CE=%d CSN=%d SCK=%d MOSI=%d MISO=%d)\n", NRF_CE_PIN,
                  NRF_CSN_PIN, NRF_SCK_PIN, NRF_MOSI_PIN, NRF_MISO_PIN);
  } else {
    Serial.println("[nrf] NOT READY — see probe above");
  }
  nrf24ReleaseBusForLcd();
  waveshareLcdSetPerformance(true);  // restore panel SPI after NRF probe

  Nrf24Info nrfInfo;
  nrf24GetInfo(&nrfInfo);
  bridgeUiSetNrfInfo(nrfInfo.ok, nrfInfo.channel, nrfInfo.bitrate);
  setBattery(85);

  powerOnUserActivity();
  bridgeUiPlaySplashSequence("v0.3", nrfOk);
#if BRIDGE_DEBUG_NRF_SPLASH
  bridgeUiShowNrfDebugScreen(nrfOk, BRIDGE_DEBUG_NRF_VERBOSE ? 8000 : 2500);
#endif

#if !BRIDGE_SKIP_UI_DEMO
  setBattery(85);
  bridgeUiSetActiveCamera("CAM-01 Main");

  // 2. HOME / READY (empty)
  setLink(LinkState::Ready, "READY");
  bridgeUiSetFooter("SEL=SCAN");
  bridgeUiSetList(nullptr, 0, 0, 0);
  bridgeUiDraw();
  demoRunMs(5000);

  // 3. SCANNING (empty list -> skeleton + radar)
  setLink(LinkState::Scanning, "SCAN");
  bridgeUiSetFooter("SEL=STOP");
  demoRunMs(5000);

  // 4. LIST (3 cameras)
  {
    const char *demo[3] = {"CAM-01 Main", "CAM-02 Wide", "CAM-03 Aux"};
    bridgeUiSetList(demo, 3, 0, 0);
    bridgeUiSetRssi(0, -52);
    bridgeUiSetRssi(1, -68);
    bridgeUiSetRssi(2, -80);
  }
  setLink(LinkState::Ready, "READY");
  bridgeUiSetFooter("SEL=LINK");
  bridgeUiDraw();
  demoRunMs(5000);

  // 5. LINKING
  setLink(LinkState::Connecting, "LINK");
  bridgeUiSetFooter("PLEASE WAIT");
  demoRunMs(5000);

  // 6. LINKED + tally PROGRAM (LIVE)
  setLink(LinkState::Connected, "LINKED");
  setTally(TallyState::Program);
  bridgeUiSetFooter("HOLD SEL=EXIT");
  bridgeUiDraw();
  demoRunMs(5000);

  // 6b. LINKED + tally PREVIEW (PVW)
  setTally(TallyState::Preview);
  bridgeUiDraw();
  demoRunMs(5000);
  setTally(TallyState::Off);

  // 7. ERROR (also drop battery to demo low-battery red-mix on LED)
  setBattery(15);
  setLink(LinkState::Error, "ERROR");
  bridgeUiSetFooter("SEL=RETRY");
  bridgeUiDraw();
  demoRunMs(5000);
  setBattery(85);

  // 8. SLEEP
  bridgeUiSetSleep(true);
  bridgeUiDraw();
  demoRunMs(5000);
  bridgeUiSetSleep(false);

  // 9. NRF SETTINGS
  bridgeUiSetNrfScreen(true);
  setLink(LinkState::Ready, "NRF24");
  bridgeUiSetFooter("RADIO SETTINGS");
  bridgeUiDraw();
  demoRunMs(5000);
  bridgeUiSetNrfScreen(false);

  // Settle into normal startup state
  bridgeUiSetActiveCamera("");
  bridgeUiSetList(nullptr, 0, 0, 0);
  setLink(LinkState::Ready, "READY");
#if BTN_USE_BOOT_FALLBACK
  bridgeUiSetFooter("BOOT=SCAN");
#else
  bridgeUiSetFooter("SEL=SCAN");
#endif
  refreshListUi();
  drawIfDirty();
#else
  // NRF settings detail (demo screen)
  bridgeUiSetNrfScreen(true);
  setLink(LinkState::Ready, "NRF24");
  bridgeUiSetFooter("RADIO SETTINGS");
  bridgeUiDraw();
  demoRunMs(5000);
  bridgeUiSetNrfScreen(false);

  bridgeUiSetActiveCamera("");
  bridgeUiSetList(nullptr, 0, 0, 0);
  setLink(LinkState::Ready, "READY");
#if BTN_USE_BOOT_FALLBACK
  bridgeUiSetFooter("BOOT=SCAN");
#else
  bridgeUiSetFooter("SEL=SCAN");
#endif
  bridgeUiDraw();
#endif

  Serial.println("\n=== BM Bridge panel (power-save) ===");
  if (nrfOk) Serial.println("[nrf] status: CONNECTED");
  else Serial.println("[nrf] status: NO LINK");
}

void loop() {
#if BRIDGE_DEBUG_NRF_VERBOSE
  static uint32_t lastNrfLogMs = 0;
  if (millis() - lastNrfLogMs >= 5000) {
    lastNrfLogMs = millis();
    Serial.printf("[nrf] heartbeat ok=%d\n", nrf24Ok() ? 1 : 0);
  }
#endif
  if (bleScannerIsActive() && (millis() - g_scanStartedMs) > 3200) {
    finishScan();
  }

  handleButtons(buttonsPoll());

  bridgeUiTick(millis());
  if (bridgeUiAnimationsDirty()) markDirty();

  ledTick(millis());

  drawIfDirty();
  idlePower();
}
