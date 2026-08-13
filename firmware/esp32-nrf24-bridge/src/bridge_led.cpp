#include "bridge_led.h"

namespace {
constexpr uint8_t kLedPin = 8;
constexpr uint8_t kBrightMax = 64;   // cap brightness — onboard LED is intense
constexpr int8_t  kLowBatteryThreshold = 20;  // % — below this, mix red flash
constexpr uint8_t kLowBatteryFlashAdd  = 80;  // red intensity added during pulse

LinkState  g_link  = LinkState::Disconnected;
TallyState g_tally = TallyState::Off;
uint32_t   g_lastTick = 0;
uint16_t   g_phase = 0;        // 0..1023 — slow breathe phase
bool       g_dirty = true;
bool       g_sleeping = false;
int8_t     g_battery = -1;
uint16_t   g_warnPhase = 0;

struct Rgb { uint8_t r, g, b; };

Rgb colorFor() {
  if (g_tally == TallyState::Program) return {kBrightMax, 0, 0};            // red
  if (g_tally == TallyState::Preview) return {0, kBrightMax, 0};            // green
  switch (g_link) {
    case LinkState::Ready:      return {0, kBrightMax / 2, kBrightMax};      // cyan
    case LinkState::Scanning:   return {kBrightMax, kBrightMax / 5, 0};      // amber (orange)
    case LinkState::Connecting: return {kBrightMax / 3, 0, kBrightMax};      // indigo
    case LinkState::Connected:  return {0, kBrightMax, kBrightMax / 5};      // green-cyan
    case LinkState::Error:      return {kBrightMax, 0, 0};                   // red
    default:                    return {0, 0, kBrightMax / 4};               // dim blue
  }
}

// Triangle wave breathe — modulates channel between 0 and base.
// Channels at 0 stay at 0 (no spurious color leak from negative wrap).
uint8_t breathe(uint8_t base, uint16_t phase) {
  if (base == 0) return 0;
  const uint16_t tri = phase < 512 ? phase : (1023 - phase);  // 0..511
  // scale 0..base via tri/511
  const uint32_t v = (uint32_t)tri * base / 511;
  return (uint8_t)v;
}

// Lowest-level write — applies the board's R/G swap.
void writeRawHw(Rgb c) {
  rgbLedWrite(kLedPin, c.g, c.r, c.b);
}

bool batteryLow() {
  return g_battery >= 0 && g_battery < kLowBatteryThreshold;
}

// Apply low-battery red pulse overlay on top of the requested color and
// send to hardware. Pulse runs at ~1 Hz via g_warnPhase advanced in ledTick.
void writeRaw(Rgb c) {
  if (batteryLow()) {
    // tri wave 0..1023, peaks at 512
    const uint16_t tri = g_warnPhase < 512 ? g_warnPhase : (1023 - g_warnPhase);
    const uint16_t addR = ((uint32_t)tri * kLowBatteryFlashAdd) / 511;
    uint16_t r = (uint16_t)c.r + addR;
    if (r > 255) r = 255;
    c.r = (uint8_t)r;
  }
  writeRawHw(c);
}

bool shouldBreathe() {
  // Breathe on attention-needed states; solid on stable states.
  if (g_tally == TallyState::Program) return false;  // LIVE solid
  if (g_tally == TallyState::Preview) return false;  // PVW solid
  return g_link == LinkState::Scanning ||
         g_link == LinkState::Connecting ||
         g_link == LinkState::Error;
}
}  // namespace

void ledInit() {
  // No pinMode — rgbLedWrite drives the WS2812 via RMT internally.
  writeRaw({0, 0, 0});
  g_dirty = true;
}

void ledSetLink(LinkState s) {
  if (s != g_link) {
    g_link = s;
    g_dirty = true;
    if (!g_sleeping) writeRaw(colorFor());
  }
}

void ledSetTally(TallyState s) {
  if (s != g_tally) {
    g_tally = s;
    g_dirty = true;
    if (!g_sleeping) writeRaw(colorFor());
  }
}

void ledOff() {
  g_sleeping = true;
  writeRaw({0, 0, 0});
}

void ledResume() {
  g_sleeping = false;
  g_dirty = true;
  writeRaw(colorFor());
}

void ledSetBatteryPercent(int8_t p) { g_battery = p; }

void ledBootStep(uint8_t step, uint8_t totalSteps) {
  if (totalSteps == 0) totalSteps = 1;
  // Cyan ramp — same hue as Ready, brightness scales with progress.
  const uint8_t b = (uint8_t)((uint16_t)kBrightMax * step / totalSteps);
  const Rgb c = { 0, (uint8_t)(b / 2), b };
  // Force-write even if sleeping or breathing — boot is a deliberate sequence.
  writeRaw(c);
  g_dirty = true;
}

void ledNotifyPerformanceChange() {
  if (g_sleeping) return;
  g_dirty = true;
  writeRaw(colorFor());
}

void ledTick(uint32_t nowMs) {
  if (g_sleeping) return;
  if (nowMs - g_lastTick < 30) return;  // ~33 fps breathe
  g_lastTick = nowMs;

  // Advance battery-warn phase even when nothing else animates.
  if (batteryLow()) g_warnPhase = (g_warnPhase + 24) & 0x03FF;  // ~1.3 Hz

  if (!shouldBreathe()) {
    // Static state: still re-write each tick if battery overlay is animating.
    if (g_dirty || batteryLow()) { writeRaw(colorFor()); g_dirty = false; }
    return;
  }

  // Scanning ~1 Hz breathe; connecting/error slower.
  const uint16_t step = (g_link == LinkState::Scanning) ? 26 : 12;
  g_phase = (g_phase + step) & 0x03FF;
  const Rgb base = colorFor();
  const Rgb out = {
    breathe(base.r, g_phase),
    breathe(base.g, g_phase),
    breathe(base.b, g_phase),
  };
  writeRaw(out);
  g_dirty = false;
}
