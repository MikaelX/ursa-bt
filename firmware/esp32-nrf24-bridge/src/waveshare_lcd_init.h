#pragma once

#include <Arduino_GFX_Library.h>

// Waveshare ESP32-C6-LCD-1.47
#define GFX_BL 22

extern Arduino_DataBus *bus;
extern Arduino_GFX *gfx;

void waveshare_lcd_init(void);
void waveshareLcdSetPerformance(bool high);
