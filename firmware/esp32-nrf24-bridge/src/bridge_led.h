#pragma once

#include <Arduino.h>

#include "bridge_ui.h"

// Drives the onboard WS2812 RGB LED (GPIO 8 on Waveshare ESP32-C6-LCD-1.47).
// Colors mirror the UI accent palette so the LED at a glance signals state.

void ledInit();
void ledSetLink(LinkState state);
void ledSetTally(TallyState state);
void ledOff();
void ledResume();              // re-assert current state color (use after wake)
void ledTick(uint32_t nowMs);
void ledNotifyPerformanceChange();  // call from main loop for soft pulse/breathe

// Battery state (drives low-battery red-flash overlay on top of any color).
void ledSetBatteryPercent(int8_t percent);  // -1 = unknown / disabled

// Splash boot helper — light LED with a brightness step (0..N steps).
// Used during the boot checklist: each ticked service brightens the LED.
void ledBootStep(uint8_t step, uint8_t totalSteps);
