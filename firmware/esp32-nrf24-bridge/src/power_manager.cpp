#include "power_manager.h"

#include "bridge_config.h"
#include "bridge_led.h"
#include "waveshare_lcd_init.h"

#include <esp_wifi.h>

namespace {
constexpr uint8_t kBlPin = 22;
constexpr uint32_t kFreq = 5000;
constexpr uint8_t kResolution = 8;

constexpr uint8_t kBlNormal = 72;       // ~28% — readable, cool
constexpr uint8_t kBlDim    = 24;       // dim after short idle
constexpr uint32_t kDimAfterMs = 15'000;
#if BRIDGE_POWER_SAVE_DISABLED
constexpr uint32_t kOffAfterMs = 0;  // never sleep while disabled
#else
constexpr uint32_t kOffAfterMs = BRIDGE_DISPLAY_OFF_AFTER_MS;
#endif

constexpr uint32_t kCpuActiveMhz = 160;
constexpr uint32_t kCpuSaveMhz = 80;

enum class PerfTier { Active, Save };

uint8_t  g_blLevel = kBlNormal;
uint32_t g_lastActivityMs = 0;
bool g_dimmed = false;
bool g_blOff  = false;
bool g_keepAwake = false;
PerfTier g_perfTier = PerfTier::Save;

bool wantHighPerformance() {
  if (g_blOff) return false;
  if (g_keepAwake) return true;
  return !g_dimmed;
}

void applyPerformanceTier(PerfTier tier) {
  if (tier == g_perfTier) return;
  g_perfTier = tier;

  const uint32_t mhz = (tier == PerfTier::Active) ? kCpuActiveMhz : kCpuSaveMhz;
  setCpuFrequencyMhz(mhz);
  waveshareLcdSetPerformance(tier == PerfTier::Active);
  ledNotifyPerformanceChange();
}

void syncPerformanceTier() { applyPerformanceTier(wantHighPerformance() ? PerfTier::Active : PerfTier::Save); }
}  // namespace

void powerInit() {
  esp_wifi_stop();
  esp_wifi_deinit();

  ledcAttach(kBlPin, kFreq, kResolution);
  powerSetBacklight(kBlNormal);
  g_lastActivityMs = millis();
  syncPerformanceTier();
}

void powerSetBacklight(uint8_t level) {
  g_blLevel = level;
  ledcWrite(kBlPin, level);
}

void powerOnUserActivity() {
  g_lastActivityMs = millis();
  g_blOff   = false;
  g_dimmed  = false;
  if (g_blLevel != kBlNormal) powerSetBacklight(kBlNormal);
  syncPerformanceTier();
}

void powerSetKeepAwake(bool on) {
  if (on == g_keepAwake) return;
  g_keepAwake = on;
  if (on) {
    g_lastActivityMs = millis();
    g_blOff  = false;
    g_dimmed = false;
    powerSetBacklight(kBlNormal);
  }
  syncPerformanceTier();
}

void powerIdleTick() {
#if BRIDGE_POWER_SAVE_DISABLED
  if (g_blOff || g_dimmed || g_blLevel != kBlNormal) {
    g_blOff = false;
    g_dimmed = false;
    powerSetBacklight(kBlNormal);
  }
  syncPerformanceTier();
  return;
#endif

  if (g_keepAwake) {
    if (g_blOff || g_dimmed || g_blLevel != kBlNormal) {
      g_blOff = false;
      g_dimmed = false;
      powerSetBacklight(kBlNormal);
    }
    syncPerformanceTier();
    return;
  }

  if (g_blOff) return;

  const uint32_t idle = millis() - g_lastActivityMs;
  if (!g_dimmed && idle >= kDimAfterMs) {
    g_dimmed = true;
    powerSetBacklight(kBlDim);
    syncPerformanceTier();
    return;
  }

  syncPerformanceTier();
}

bool powerShouldSleep() {
#if BRIDGE_POWER_SAVE_DISABLED
  return false;
#endif
  if (g_keepAwake) return false;
  return (millis() - g_lastActivityMs) >= kOffAfterMs;
}

bool powerIsDimmed() { return g_dimmed; }

bool powerDisplayAsleep() { return g_blOff; }

void powerEnterDisplaySleep() {
  if (g_blOff) return;
  g_blOff  = true;
  g_dimmed = false;
  powerSetBacklight(0);
  syncPerformanceTier();
}

bool powerIsHighPerformance() { return g_perfTier == PerfTier::Active; }
