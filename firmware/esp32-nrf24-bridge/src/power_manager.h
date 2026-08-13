#pragma once

#include <Arduino.h>

void powerInit();
void powerSetBacklight(uint8_t level);  // 0–255
void powerOnUserActivity();
void powerIdleTick();
bool powerShouldSleep();
bool powerDisplayAsleep();
void powerEnterDisplaySleep();

// External "keep awake" override — e.g. ATEM tally is LIVE/PVW.
// While true: cancels dim/sleep timeouts and forces full backlight.
void powerSetKeepAwake(bool on);
bool powerIsDimmed();

// true while panel is bright/active — UI runs faster draw cadence + 160 MHz CPU.
bool powerIsHighPerformance();
